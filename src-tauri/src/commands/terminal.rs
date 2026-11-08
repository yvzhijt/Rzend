//! 内嵌终端（ConPTY + xterm.js）
//!
//! 通过 portable-pty 启动 powershell.exe（默认，Windows PowerShell 5.1）
//! 或 pwsh.exe（PowerShell 7），把输出经 Channel 流式推给前端（base64 编码），
//! 输入与窗口尺寸通过 pty_write / pty_resize 下发。
//! cwd 双向同步：
//! - 终端 → 应用：两种 shell 的提示符里都嵌了 OSC 7（file:/// 当前目录），
//!   前端解析后经 shell_cd 同步文件树与共享 cwd；
//! - 应用 → 终端：doCd 等操作后由前端调 pty_sync_cwd 注入一行切目录命令
//!   （cmd 为 cd /d，PowerShell 为 Set-Location）。

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    PowerShell,
    Pwsh,
}

impl ShellKind {
    pub fn from_str(s: Option<&str>) -> Result<Self, String> {
        match s.unwrap_or("powershell").to_ascii_lowercase().as_str() {
            "cmd" => Err("cmd.exe 已移除，仅支持 powershell（默认）/ pwsh".to_string()),
            "ps" | "powershell" | "powershell.exe" => Ok(ShellKind::PowerShell),
            "pwsh" | "pwsh.exe" => Ok(ShellKind::Pwsh),
            other => Err(format!("未知终端类型: {other}（可选 ps / pwsh）")),
        }
    }

    fn name(&self) -> &'static str {
        match self {
            ShellKind::PowerShell => "powershell",
            ShellKind::Pwsh => "pwsh",
        }
    }
}

pub struct TerminalState {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell: ShellKind,
}

pub type TerminalSlot = std::sync::Arc<std::sync::Mutex<Option<TerminalState>>>;

pub fn new_slot() -> TerminalSlot {
    std::sync::Arc::new(std::sync::Mutex::new(None))
}

fn lock_slot(slot: &TerminalSlot) -> std::sync::MutexGuard<'_, Option<TerminalState>> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

fn lock_cwd(cwd: &std::sync::Arc<std::sync::Mutex<std::path::PathBuf>>) -> std::path::PathBuf {
    cwd.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// PowerShell 启动脚本（UTF-8 输出/输入编码 + 带 OSC 7 的 prompt）。
/// 通过 -EncodedCommand（base64 UTF-16LE）传入，完全避开转义地狱。
const PS_STARTUP_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
function prompt {
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  $path = $loc.ProviderPath
  $e = [char]27
  "$e]7;file:///$path$e\PS $path> "
}
"#;

fn ps_encoded_command() -> String {
    let wide: Vec<u8> = PS_STARTUP_SCRIPT
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(wide)
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, crate::AppState>,
    channel: tauri::ipc::Channel<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<String, String> {
    let kind = ShellKind::from_str(shell.as_deref())?;
    let slot = state.terminal.clone();
    let cwd = lock_cwd(&state.inner().cwd);

    let mut guard = lock_slot(&slot);
    if let Some(existing) = guard.as_ref() {
        // 已有会话：返回当前 shell 类型，前端据此决定复用还是杀掉重建
        return Ok(format!("running:{}", existing.shell.name()));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("无法创建伪终端: {e}"))?;

    let cmd = {
        let program = match kind {
            ShellKind::PowerShell => "powershell.exe",
            ShellKind::Pwsh => "pwsh.exe",
        };
        let mut c = CommandBuilder::new(program);
        // 程序不存在时 PortablePty 会直接返回错误，提示用户安装即可
        c.cwd(cwd);
        c.arg("-NoLogo");
        c.arg("-NoProfile");
        c.arg("-NoExit");
        c.arg("-EncodedCommand");
        c.arg(ps_encoded_command());
        c
    };

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| match kind {
            ShellKind::PowerShell => format!("无法启动 powershell.exe: {e}"),
            ShellKind::Pwsh => format!("无法启动 pwsh.exe（请安装 PowerShell 7）: {e}"),
        })?;
    drop(pair.slave);

    // 用 killer 句柄代替 child：child 交给等待线程持有并阻塞 wait()
    let killer = child.clone_killer();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("无法读取终端输出: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("无法写入终端输入: {e}"))?;

    *guard = Some(TerminalState {
        master: pair.master,
        writer,
        killer,
        shell: kind,
    });
    drop(guard);

    // 退出等待用的 Channel 副本（Channel 会被读线程移走）
    let watch_channel = channel.clone();

    // 读线程：ConPTY 输出 → base64 → Channel（"d:<payload>"）
    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = format!("d:{}", engine.encode(&buf[..n]));
                    if channel.send(payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 退出等待线程：持有 child 并阻塞在 wait()（零轮询），进程退出后通知前端
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        let _ = watch_channel.send("exit".to_string());
    });

    Ok(format!("spawned:{}", kind.name()))
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, crate::AppState>, data: String) -> Result<(), String> {
    let mut guard = lock_slot(&state.terminal);
    let term = guard
        .as_mut()
        .ok_or_else(|| "终端未启动".to_string())?;
    term.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入终端失败: {e}"))?;
    term.writer.flush().map_err(|e| format!("写入终端失败: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, crate::AppState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = lock_slot(&state.terminal);
    let term = guard
        .as_ref()
        .ok_or_else(|| "终端未启动".to_string())?;
    term.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

/// 应用 → 终端：注入一行切换目录命令，使终端跟随应用 cwd。
/// 调用前前端会确认终端输入行为空，避免污染用户正在输入的内容。
#[tauri::command]
pub fn pty_sync_cwd(state: tauri::State<'_, crate::AppState>, path: String) -> Result<(), String> {
    // 去掉引号与控制字符，避免注入额外命令
    let safe: String = path
        .chars()
        .filter(|c| !matches!(c, '"' | '\r' | '\n' | '\0'))
        .collect();
    if safe.trim().is_empty() {
        return Err("路径无效".to_string());
    }
    let mut guard = lock_slot(&state.terminal);
    let term = guard
        .as_mut()
        .ok_or_else(|| "终端未启动".to_string())?;
    // 只写 \r（Enter 键），不要附带 \n，否则 PowerShell 会多出 “>>” 续行提示
    let line = format!("Set-Location -LiteralPath \"{safe}\"\r");
    term.writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("写入终端失败: {e}"))?;
    term.writer.flush().map_err(|e| format!("写入终端失败: {e}"))
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    kill_existing(&state.terminal);
    Ok(())
}

/// 关闭并回收终端进程（无则忽略）
pub fn kill_existing(slot: &TerminalSlot) {
    if let Some(mut term) = lock_slot(slot).take() {
        let _ = term.killer.kill();
    }
}
