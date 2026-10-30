use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::yt::{EvalOutput, EvalResult};
use crate::{AppState, DirEntry, PyState, WorkspaceVar};

// 临时文件序号，避免并发运行时互相覆盖
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 锁毒化恢复：panic 已被 catch_unwind 捕获时，锁内数据仍然可用
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 把阻塞任务放到线程池执行，统一处理任务失败（panic 等）
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))
}

// ---------------- 路径工具 ----------------

pub fn resolve_path(cwd: &Path, p: &str) -> PathBuf {
    let p = p.trim().trim_matches('"');
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn find_mpy() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            candidates.push(d.join("tool").join("mpy.exe"));
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd);
        while let Some(d) = dir {
            candidates.push(d.join("tool").join("mpy.exe"));
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "找不到 tool/mpy.exe 解释器".to_string())
}

// ---------------- 文件浏览 ----------------

fn scan_directory_sync(path: &str) -> Vec<DirEntry> {
    let dir_path = PathBuf::from(path);
    let mut entries = Vec::new();

    if let Ok(read_dir) = fs::read_dir(&dir_path) {
        let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        items.sort_by(|a, b| {
            let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
            b_is_dir
                .cmp(&a_is_dir)
                .then_with(|| a.file_name().cmp(&b.file_name()))
        });

        for entry in items {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let entry_path = entry.path().to_string_lossy().to_string();
            let children = if is_dir {
                scan_directory_shallow(&entry.path())
            } else {
                None
            };

            entries.push(DirEntry {
                name,
                path: entry_path,
                is_dir,
                children,
            });
        }
    }

    entries
}

#[tauri::command]
pub fn scan_directory(path: String) -> Vec<DirEntry> {
    scan_directory_sync(&path)
}

fn scan_directory_shallow(path: &PathBuf) -> Option<Vec<DirEntry>> {
    if let Ok(read_dir) = fs::read_dir(path) {
        let mut entries = Vec::new();
        for entry in read_dir.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(DirEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
                children: None,
            });
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
        Some(entries)
    } else {
        None
    }
}

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

#[tauri::command]
pub fn write_file_content(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("保存文件失败: {}", e))
}

#[tauri::command]
pub async fn open_folder_dialog(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    match path {
        Some(p) => Ok(p.to_string()),
        None => Err("未选择文件夹".to_string()),
    }
}

/// 另存为对话框：返回用户选择的完整路径，取消时返回空字符串
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
    ext: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = ext.unwrap_or_else(|| "ckt".to_string());
    let mut builder = app.dialog().file().add_filter("电路仿真文件", &[ext.as_str()]);
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    Ok(builder
        .blocking_save_file()
        .map(|p| p.to_string())
        .unwrap_or_default())
}

#[tauri::command]
pub fn get_initial_dir(state: tauri::State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}

// ---------------- shell 命令 ----------------

#[tauri::command]
pub fn shell_pwd(state: tauri::State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}

#[tauri::command]
pub fn shell_cd(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    let target = {
        let cur = lock(&cwd);
        resolve_path(&cur, &path)
    };
    if !target.exists() {
        return Err(format!("路径不存在: {}", target.display()));
    }
    if !target.is_dir() {
        return Err(format!("不是文件夹: {}", target.display()));
    }
    let canonical = target.canonicalize().unwrap_or(target);
    // 入库前剥掉 Windows canonicalize 产生的 \\?\ 前缀，保证 pwd 与存储一致
    let s = canonical.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s);
    *lock(&cwd) = PathBuf::from(&s);
    Ok(s)
}

#[tauri::command]
pub fn shell_ls(state: tauri::State<'_, AppState>) -> Vec<DirEntry> {
    let cur = lock(&state.inner().cwd).clone();
    scan_directory_sync(&cur.to_string_lossy())
}

#[tauri::command]
pub fn shell_mkdir(state: tauri::State<'_, AppState>, name: String) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    let target = {
        let cur = lock(&cwd);
        resolve_path(&cur, &name)
    };
    fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败: {}", e))?;
    Ok(format!("已创建: {}", target.display()))
}

#[tauri::command]
pub fn shell_rm(state: tauri::State<'_, AppState>, name: String) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    let target = {
        let cur = lock(&cwd);
        resolve_path(&cur, &name)
    };
    if !target.exists() {
        return Err(format!("路径不存在: {}", target.display()));
    }
    let canonical = target.canonicalize().unwrap_or(target.clone());
    // 拒绝删除磁盘根目录
    if canonical.parent().is_none() {
        return Err("不能删除磁盘根目录".to_string());
    }
    // 拒绝删除当前目录及其祖先目录（如 del .. / del ..\..）
    let cur = lock(&cwd).clone();
    let cwd_canon = cur.canonicalize().unwrap_or(cur);
    if cwd_canon.starts_with(&canonical) {
        return Err("不能删除当前所在目录或其上级目录".to_string());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("删除文件夹失败: {}", e))?;
        Ok(format!("已删除文件夹: {}", target.display()))
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))?;
        Ok(format!("已删除: {}", target.display()))
    }
}

// ---------------- .yt 求值 ----------------

/// 捕获解释器 panic（索引越界等），统一转为错误输出而不是让进程崩溃
fn eval_block_guarded(
    env: &mut crate::yt::Env,
    code: &str,
) -> (Vec<EvalOutput>, Option<crate::yt::PlotData>) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| env.eval_block(code))) {
        Ok(r) => r,
        Err(_) => (
            vec![EvalOutput {
                text: "解释器内部错误，本次求值已终止".to_string(),
                is_error: true,
            }],
            None,
        ),
    }
}

#[tauri::command]
pub async fn yt_eval(state: tauri::State<'_, AppState>, code: String) -> Result<EvalResult, String> {
    let yt = state.inner().yt.clone();
    blocking(move || {
        let mut env = lock(&yt);
        let (outputs, plot) = eval_block_guarded(&mut env, &code);
        EvalResult {
            outputs,
            plot,
            vars: env.workspace_vars(),
        }
    })
    .await
}

#[tauri::command]
pub fn yt_reset(state: tauri::State<'_, AppState>) -> Vec<WorkspaceVar> {
    let mut env = lock(&state.inner().yt);
    env.reset();
    env.workspace_vars()
}

#[tauri::command]
pub fn get_workspace(state: tauri::State<'_, AppState>) -> Vec<WorkspaceVar> {
    lock(&state.inner().yt).workspace_vars()
}

#[tauri::command]
pub async fn run_yt_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<EvalResult, String> {
    let cwd = state.inner().cwd.clone();
    let yt = state.inner().yt.clone();
    blocking(move || {
        let full = {
            let cur = lock(&cwd);
            resolve_path(&cur, &path)
        };
        let mut env = lock(&yt);
        match fs::read_to_string(&full) {
            Ok(code) => {
                let (outputs, plot) = eval_block_guarded(&mut env, &code);
                EvalResult {
                    outputs,
                    plot,
                    vars: env.workspace_vars(),
                }
            }
            Err(e) => EvalResult {
                outputs: vec![EvalOutput {
                    text: format!("无法读取文件 {}: {}", full.display(), e),
                    is_error: true,
                }],
                plot: None,
                vars: env.workspace_vars(),
            },
        }
    })
    .await
}

// ---------------- .pyt / MicroPython ----------------

/// 转成 Python 单引号字符串字面量
fn py_str_lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

/// 生成一行引导代码，用全局队列覆盖 input()，按顺序返回用户填写的值。
/// 之所以不走 stdin 管道：mpy.exe 在非控制台 stdin 下 input() 直接抛
/// KeyboardInterrupt（EOF），无法交互。
fn inject_input_header(inputs: &[String]) -> String {
    let items = inputs
        .iter()
        .map(|s| py_str_lit(s))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "__rzend_q=[{}];__rzend_k=0;exec(\"def input(p=''):\\n global __rzend_k\\n n=__rzend_q[__rzend_k] if __rzend_k<len(__rzend_q) else ''\\n __rzend_k+=1\\n print(p+n)\\n return n\")\n",
        items
    )
}

#[tauri::command]
pub async fn run_pyt_file(
    state: tauri::State<'_, AppState>,
    path: String,
    inputs: Option<Vec<String>>,
) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let full = {
            let cur = lock(&cwd);
            resolve_path(&cur, &path)
        };
        if !full.exists() {
            return Err(format!("文件不存在: {}", full.display()));
        }
        let mpy = find_mpy()?;

        // 有输入值（含空数组）时，把引导代码注入脚本副本后运行
        let mut target = full.clone();
        let mut temp: Option<PathBuf> = None;
        if let Some(values) = inputs {
            let code = fs::read_to_string(&full).map_err(|e| format!("读取文件失败: {}", e))?;
            let mut content = inject_input_header(&values);
            content.push_str(&code);
            let stem = full
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "script".to_string());
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let file = std::env::temp_dir().join(format!(
                "rzend_{}_{}_{}.py",
                stem,
                std::process::id(),
                seq
            ));
            fs::write(&file, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
            target = file.clone();
            temp = Some(file);
        }

        let mut cmd = Command::new(mpy);
        cmd.arg(&target);
        // 以脚本所在目录为工作目录，脚本内的相对路径才能正确解析
        if let Some(dir) = full.parent() {
            cmd.current_dir(dir);
        }
        let output = cmd.output();
        if let Some(f) = temp {
            let _ = fs::remove_file(f);
        }
        let output = output.map_err(|e| format!("运行 mpy.exe 失败: {}", e))?;
        let mut text = String::new();
        text.push_str(&String::from_utf8_lossy(&output.stdout));
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            text.push_str(&stderr);
        }
        if text.is_empty() {
            text.push_str("(无输出)");
        }
        Ok(text)
    })
    .await?
}

// ---------------- Python 交互（会话重放式 REPL） ----------------
// MicroPython 的 -i 在管道输入下不输出求值结果，因此每次输入都重放整个会话，
// 只返回新增的输出，从而保持变量状态并获得实时反馈。

fn is_statement(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return true;
    }
    const KEYWORDS: [&str; 25] = [
        "import", "from", "def", "class", "for", "while", "if", "elif", "else", "try",
        "except", "finally", "with", "return", "yield", "pass", "break", "continue",
        "global", "nonlocal", "del", "assert", "print", "input", "exec",
    ];
    let first = t.split(|c: char| c.is_whitespace() || c == '(' || c == ':').next().unwrap_or("");
    if KEYWORDS.contains(&first) {
        return true;
    }
    // 顶层赋值（排除 == != <= >= += 等）
    let bytes: Vec<char> = t.chars().collect();
    for i in 0..bytes.len() {
        if bytes[i] == '=' {
            let prev = if i > 0 { bytes[i - 1] } else { ' ' };
            let next = if i + 1 < bytes.len() { bytes[i + 1] } else { ' ' };
            if next == '=' || prev == '=' || prev == '!' || prev == '<' || prev == '>' || prev == '+' || prev == '-' || prev == '*' || prev == '/' {
                continue;
            }
            return true;
        }
    }
    false
}

fn wrap_line(line: &str) -> String {
    if is_statement(line) {
        line.to_string()
    } else {
        format!("print(repr({}))", line)
    }
}

fn run_python_source(src: &str) -> Result<String, String> {
    let mpy = find_mpy()?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!(
        "rzend_py_session_{}_{}.py",
        std::process::id(),
        seq
    ));
    fs::write(&tmp, src).map_err(|e| format!("写入临时脚本失败: {}", e))?;
    let output = Command::new(mpy).arg(&tmp).output();
    let _ = fs::remove_file(&tmp);
    let output = output.map_err(|e| format!("启动 mpy.exe 失败: {}", e))?;

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    if !err.trim().is_empty() {
        text.push_str(&err);
    }
    // 把临时文件路径替换成会话描述，避免暴露内部细节
    let tmp_name = tmp.to_string_lossy().replace('\\', "/");
    text = text.replace(&tmp_name, "<会话>");
    text = text.replace(&tmp.to_string_lossy().to_string(), "<会话>");
    Ok(text.replace("\r\n", "\n"))
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    let mut n = 0;
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y {
            break;
        }
        n += x.len_utf8();
    }
    n
}

#[tauri::command]
pub fn py_start(state: tauri::State<'_, AppState>) -> Result<String, String> {
    find_mpy()?;
    let mut st = lock(&state.inner().py);
    *st = PyState::default();
    st.gen += 1;
    Ok("MicroPython 交互模式：逐行执行，多行语句以空行结束\n".to_string())
}

/// 需要在锁外运行进程时携带的上下文
struct PyRun {
    all: Vec<String>,
    gen: u64,
    prev: String,
    clear_pending: bool,
}

#[tauri::command]
pub async fn py_send(
    state: tauri::State<'_, AppState>,
    line: String,
) -> Result<crate::PyReply, String> {
    let py = state.inner().py.clone();
    blocking(move || {
        // 第一阶段：锁内整理状态，确定是否需要运行进程
        let run: PyRun = {
            let mut st = lock(&py);

            // 多行块收集中
            if !st.pending.is_empty() {
                if line.trim().is_empty() {
                    let mut all = st.lines.clone();
                    all.extend(st.pending.iter().cloned());
                    PyRun {
                        all,
                        gen: st.gen,
                        prev: st.last_output.clone(),
                        clear_pending: true,
                    }
                } else {
                    st.pending.push(line);
                    return Ok(crate::PyReply {
                        output: String::new(),
                        pending: true,
                    });
                }
            } else {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return Ok(crate::PyReply {
                        output: String::new(),
                        pending: false,
                    });
                }
                // 语句块开始（以冒号结尾）
                if trimmed.ends_with(':') {
                    st.pending.push(line);
                    return Ok(crate::PyReply {
                        output: String::new(),
                        pending: true,
                    });
                }
                let mut all = st.lines.clone();
                all.push(wrap_line(&line));
                PyRun {
                    all,
                    gen: st.gen,
                    prev: st.last_output.clone(),
                    clear_pending: false,
                }
            }
        };

        // 第二阶段：锁外等待进程，避免死循环脚本卡死 py_stop
        let src = run.all.join("\n") + "\n";
        let out = run_python_source(&src)?;

        // 第三阶段：重新拿锁提交结果
        let mut st = lock(&py);
        if st.gen != run.gen {
            // 进程运行期间会话已被 py_stop/py_start 重置，丢弃结果避免复活旧会话
            return Ok(crate::PyReply {
                output: out,
                pending: false,
            });
        }
        if run.clear_pending {
            st.pending.clear();
        }
        let start = common_prefix_len(&run.prev, &out);
        if out.contains("Traceback") {
            // 出错的行不并入历史，否则后续每次重放都会再次报错
            return Ok(crate::PyReply {
                output: out[start..].to_string(),
                pending: false,
            });
        }
        st.lines = run.all;
        st.last_output = out.clone();
        Ok(crate::PyReply {
            output: out[start..].to_string(),
            pending: false,
        })
    })
    .await?
}

#[tauri::command]
pub fn py_stop(state: tauri::State<'_, AppState>) -> String {
    let mut st = lock(&state.inner().py);
    *st = PyState::default();
    st.gen += 1;
    "已退出 Python 交互模式".to_string()
}
