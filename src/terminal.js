/* 内嵌终端（ConPTY + xterm.js）
 *
 * - 输入 cmd 唤出；Ctrl+` 切换显隐；✕ 按钮隐藏（保留会话）
 * - 输入 exit（或进程意外结束）：自动收起终端并回收会话，下次 cmd 重新创建
 * - shell：Windows PowerShell 5.1（默认）/ PowerShell 7（cmd pwsh 切换）
 * - cwd 双向同步：
 *   终端 → 应用：提示符里嵌了 OSC 7（file:/// 当前目录），这里解析后回调给 main.js
 *   应用 → 终端：doCd 等操作后由 main.js 调 syncTerminalCwd() 注入 Set-Location 行
 * - 输出经 Tauri Channel 以 base64 分块推过来（"d:<base64>"），退出时发 "exit"
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke, Channel } from '@tauri-apps/api/core';
import { $ } from './common.js';

const SHELL_STORAGE_KEY = 'rzend.terminal.shell';
// 'powershell' = Windows PowerShell 5.1，'pwsh' = PowerShell 7
let currentShell = null;

let term = null;
let fitAddon = null;
let started = false;      // 已成功 spawn 过
let dead = false;         // 进程已退出，下次唤出时重建
let spawnPromise = null;
let closing = false;    // 正在主动销毁会话（此期间的 exit 不提示）
let resizeObserver = null;
let lastCols = 0;
let lastRows = 0;
let resizeRaf = 0;

// 终端里"当前输入行"的内容（转义序列已剔除），用于判断能否安全注入命令
let inputBuffer = '';
let escapeDepth = 0;

let onTerminalCwd = null;   // (cwd: string) => void   终端 cwd 变化（OSC 7）
let onTerminalNotice = null; // (msg: string) => void   给 命令行 区的提示

export function setOnTerminalCwd(fn) { onTerminalCwd = fn; }
export function setOnTerminalNotice(fn) { onTerminalNotice = fn; }

function shellLabel(s) {
  return s === 'pwsh' ? 'PowerShell 7' : 'PowerShell 5.1';
}
/** 把用户输入归一化成 shell id；无效返回 null */
function normalizeShell(shell) {
  if (!shell) return null;
  const s = String(shell).toLowerCase().trim();
  if (s === 'ps' || s === 'powershell' || s === 'powershell.exe') return 'powershell';
  if (s === 'pwsh' || s === 'pwsh.exe') return 'pwsh';
  return null;
}
function lastShell() {
  try {
    return localStorage.getItem(SHELL_STORAGE_KEY) === 'pwsh' ? 'pwsh' : 'powershell';
  } catch {
    return 'powershell';
  }
}
function setCurrentShell(s) {
  currentShell = s || 'powershell';
  try { localStorage.setItem(SHELL_STORAGE_KEY, currentShell); } catch { /* 忽略 */ }
  const el = $('#terminal-shell');
  if (el) el.textContent = shellLabel(currentShell);
}

function notify(msg) {
  if (onTerminalNotice) onTerminalNotice(msg);
}

export function isTerminalOpen() {
  const panel = $('#terminal-panel');
  return !!panel && !panel.classList.contains('hidden');
}

/** 更新标题栏里的 cwd 小标签 */
export function setTerminalCwdChip(path) {
  const chip = $('#terminal-cwd');
  if (chip) chip.textContent = path || '';
}

/** 切换显隐；show=true 时确保已 spawn 并聚焦；shell 指定 shell 类型（与已有会话不同则重建） */
export async function toggleTerminal(forceShow, shell) {
  const panel = $('#terminal-panel');
  if (!panel) return;
  const show = forceShow ?? panel.classList.contains('hidden');
  if (show) {
    const want = normalizeShell(shell);
    panel.classList.remove('hidden');
    try {
      await ensureSpawned(want);
    } catch (e) {
      panel.classList.add('hidden');
      notify(`终端启动失败: ${e?.message ?? e}`);
      return;
    }
    fitNow();
    term?.focus();
  } else {
    panel.classList.add('hidden');
  }
}

export function hideTerminal() {
  $('#terminal-panel')?.classList.add('hidden');
}

/** 应用 → 终端：注入一行命令（会话未启动时静默跳过；输入非空时提示不注入） */
export function injectLine(line) {
  if (!started || dead) return false;
  if (inputBuffer.trim() !== '') {
    notify('终端正在输入，未注入命令（提交或 Ctrl+C 后重试）');
    return false;
  }
  invoke('pty_write', { data: `${line}\r\n` })
    .catch((e) => notify(`注入终端失败: ${e}`));
  return true;
}

/** 应用 → 终端：让终端 cd 到应用当前目录 */
export function syncTerminalCwd(path) {
  if (!started || dead || !isTerminalOpen()) return;
  if (inputBuffer.trim() !== '') {
    notify('终端正在输入，未同步目录');
    return;
  }
  invoke('pty_sync_cwd', { path })
    .catch((e) => notify(`终端跟随目录失败: ${e}`));
}

async function ensureSpawned(shell) {
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    const want = shell ?? null;
    if (dead) await destroyTerm();
    // 会话存在但 shell 不同：杀掉重建（用户明确要求换 shell）
    if (term && want && currentShell && want !== currentShell) {
      await destroyTerm();
      notify(want === 'pwsh' ? '已切换到 PowerShell 7（pwsh）' : '已切换到 Windows PowerShell 5.1');
    }
    if (!term) {
      try {
        await createTerm(want ?? lastShell());
      } catch (e) {
        await destroyTerm();   // 创建失败要清掉半成品，否则下次唤出只能 fit 不能 spawn
        notify(`终端启动失败: ${e?.message ?? e}`);
        throw e;
      }
    } else {
      fitNow();
    }
  })().finally(() => { spawnPromise = null; });
  return spawnPromise;
}

async function createTerm(shellArg) {
  const requestedShell = normalizeShell(shellArg) ?? lastShell();
  const container = $('#terminal-container');
  if (!container) throw new Error('缺少 #terminal-container');

  term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 15.6,
    lineHeight: 1.2,
    cursorBlink: true,
    theme: { background: '#0c0c0c', foreground: '#e6e6e6', cursor: '#f2f2f2', selectionBackground: '#3a5a7a' },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const channel = new Channel();
  channel.onmessage = handlePtyMessage;
  term.onData(onTermData);
  term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) {
      setTerminalCwdChip(cwd);
      try { onTerminalCwd?.(cwd); } catch { /* 回调异常不影响终端 */ }
    }
    return true; // 已处理，不再作为普通输出渲染
  });

  term.open(container);
  fitAddon.fit();
  lastCols = term.cols;
  lastRows = term.rows;

  const result = await invoke('pty_spawn', { channel, cols: term.cols, rows: term.rows, shell: requestedShell })
    .catch((e) => { throw new Error(String(e)); });
  // result: "spawned:<shell>" / "running:<shell>"（后端已有会话时返回当前 shell）
  const spawnedShell = (typeof result === 'string' && result.includes(':'))
    ? result.split(':')[1]
    : requestedShell;
  setCurrentShell(spawnedShell);
  started = true;
  dead = false;
  inputBuffer = '';
  escapeDepth = 0;

  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(container);
}

async function destroyTerm() {
  closing = true;
  try {
    resizeObserver?.disconnect();
    resizeObserver = null;
    try { await invoke('pty_kill'); } catch { /* 进程可能已退出 */ }
    term?.dispose();
    term = null;
    fitAddon = null;
    started = false;
    dead = false;
    currentShell = null;
  } finally {
    closing = false;
  }
}

/** PTY 进程退出（用户输入 exit 或 shell 意外结束）：收起终端并回收会话 */
function handlePtyExit() {
  if (closing || !started) return; // 主动销毁/切换 shell 时的正常 EOF，不提示
  dead = true;
  inputBuffer = '';
  $('#terminal-panel')?.classList.add('hidden');
  notify('终端进程已退出，输入 cmd 重新打开');
  destroyTerm().catch(() => { /* 回收失败不影响界面 */ });
}

function handlePtyMessage(msg) {
  if (msg === 'exit') {
    handlePtyExit();
    return;
  }
  if (typeof msg === 'string' && msg.startsWith('d:')) {
    term?.write(base64ToBytes(msg.slice(2)));
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function onTermData(data) {
  if (!started || dead) return;
  invoke('pty_write', { data }).catch((e) => notify(`终端输入失败: ${e}`));
  // 跟踪当前输入行：\r/\n 提交，DEL 退格，Ctrl+C/Ctrl+U 清空，跳过转义序列
  for (const ch of data) {
    if (escapeDepth > 0) {
      if (/[a-zA-Z~]/.test(ch)) escapeDepth = 0;
      continue;
    }
    if (ch === '\x1b') { escapeDepth = 1; continue; }
    if (ch === '\r' || ch === '\n') { inputBuffer = ''; continue; }
    if (ch === '\x7f') { inputBuffer = inputBuffer.slice(0, -1); continue; }
    if (ch === '\x03' || ch === '\x15') { inputBuffer = ''; continue; }
    if (ch >= ' ') inputBuffer += ch;
  }
}

function scheduleResize() {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    fitNow();
  });
}

function fitNow() {
  if (!term || !fitAddon) return;
  try {
    fitAddon.fit();
  } catch {
    return; // 容器尺寸为 0 时 fit 会抛错，忽略
  }
  if (term.cols !== lastCols || term.rows !== lastRows) {
    lastCols = term.cols;
    lastRows = term.rows;
    invoke('pty_resize', { cols: term.cols, rows: term.rows }).catch(() => {});
  }
}

/** 解析 OSC 7：`file:///C:\path` 或 `file://host/...`、UNC `file:///\\server\share` */
export function parseOsc7(data) {
  if (!data) return null;
  let rest = String(data).trim().replace(/^file:\/\//i, '');
  if (!rest) return null;
  if (rest.startsWith('/')) {
    rest = rest.slice(1);            // /C:/… → C:/…，/\\server\… → \\server\…
  } else {
    const slash = rest.indexOf('/'); // host/path 形式，剥掉 host
    if (slash >= 0) rest = rest.slice(slash + 1);
  }
  return rest || null;
}