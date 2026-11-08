// Shell 模块：命令行 UI + 命令分发 + 命令历史 + 进程运行器
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { state, $, print } from './common.js';
import {
  doCd, refreshTree, closeEditor, toggleTerminal, focusInput as focus,
} from './services.js';
import { renderWorkspace, renderResult, saveWorkspace, showPlot } from './yt-runner.js';
import { createFileFromCommand, runFile } from './yt-runner.js';

/* ================ 命令行 UI ================ */

export function focusInput() {
  $('#cmd-input')?.focus();
}

export function bindCommandLine() {
  const input = $('#cmd-input');
  input?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    const text = input.value.trim();
    input.value = '';
    if (!text) return;
    pushHistory(text);
    await execLine(text);
  });

  $('#btn-clear-cmd')?.addEventListener('click', () => {
    const out = $('#cmd-output');
    if (out) out.innerHTML = '';
    focus();
  });
  $('#cmd-scroll')?.addEventListener('click', () => {
    if (window.getSelection()?.isCollapsed !== false) focus();
  });
}

/* ================ 命令分发 ================ */

export async function execLine(raw) {
  const line = raw.trim();
  print(`${state.cwd}> ${raw}\n`, 'cmd-echo');
  if (!line) return;

  const [head, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();
  const cmd = head.toLowerCase();

  try {
    if (cmd === 'help' || cmd === '?') return printHelp();
    if (cmd === 'cls' || cmd === 'clc') {
      const out = $('#cmd-output');
      if (out) out.innerHTML = '';
      return;
    }
    if (cmd === 'pwd') return print(`${state.cwd}\n`, 'cmd-result');
    if (cmd === 'ls' || cmd === 'dir') {
      if (!state.entries.length) return print('（空）\n', 'cmd-info');
      let out = '';
      state.entries.forEach((e) => {
        out += `${e.is_dir ? '  <DIR>  ' : '         '}${e.name}\n`;
      });
      out += `  共 ${state.entries.length} 项\n`;
      return print(out, 'cmd-result');
    }
    if (cmd === 'cd') {
      if (!arg) return print(`${state.cwd}\n`, 'cmd-result');
      return doCd(arg);
    }
    if (cmd === 'ni') return await createFileFromCommand(arg);
    if (cmd === 'mkdir' || cmd === 'md') {
      if (!arg) return print('用法: mkdir <文件夹名>\n', 'cmd-err');
      const msg = await invoke('shell_mkdir', { name: arg });
      await refreshTree();
      return print(`${msg}\n`, 'cmd-info');
    }
    if (cmd === 'del' || cmd === 'rm') {
      if (!arg) return print('用法: del <文件或文件夹>\n', 'cmd-err');
      const msg = await invoke('shell_rm', { name: arg });
      if (state.activeFile) {
        const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const isAbs = /^([a-z]:[\\/]|\\\\)/i.test(arg);
        const full = isAbs ? arg : `${state.cwd}/${arg}`;
        if (norm(state.activeFile) === norm(full)) closeEditor(true);
      }
      await refreshTree();
      return print(`${msg}\n`, 'cmd-info');
    }
    if (cmd === 'circuit' || cmd === 'cir') {
      invoke('open_circuit_window', { path: arg || null })
        .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
      return;
    }
    if (cmd === 'sig') {
      invoke('open_signal_window', { path: arg || null })
        .catch((e) => print(`打开信号系统窗口失败: ${e}\n`, 'cmd-err'));
      return;
    }
    if (cmd === 'cmd') {
      const want = arg ? arg.toLowerCase() : null;
      if (want && want !== 'ps' && want !== 'powershell' && want !== 'pwsh') {
        return print('用法: cmd [ps|pwsh]（ps = Windows PowerShell 5.1，pwsh = PowerShell 7）\n', 'cmd-err');
      }
      toggleTerminal(true, want);
      return;
    }
    if (cmd === 'run' || cmd === 'yt') {
      const file = arg || state.activeFile;
      if (!file) return print('用法: run <文件.yt>\n', 'cmd-err');
      return runFile(file);
    }
    if (cmd === 'clear' || cmd === 'reset') {
      const vars = await invoke('yt_reset');
      renderWorkspace(vars);
      return print('工作区已清空\n', 'cmd-info');
    }
    if (cmd === 'who' || cmd === 'whos') {
      const vars = await invoke('get_workspace');
      if (!vars.length) return print('工作区为空\n', 'cmd-info');
      let out = '';
      vars.forEach((v) => {
        out += `  ${v.name.padEnd(10)} ${v.size.padEnd(8)} ${v.var_type}\n`;
      });
      return print(out, 'cmd-result');
    }
    if (cmd === 'savews') return await saveWorkspace();
    if (cmd === 'exit' || cmd === 'quit') {
      return print('（桌面应用，可直接关闭窗口）\n', 'cmd-info');
    }
    // 直接输入文件名运行
    if (/\.yt$/i.test(line)) return runFile(line);
    if (/\.ckt$/i.test(line)) {
      invoke('open_circuit_window', { path: line })
        .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
      return;
    }
    if (/\.sig$/i.test(line)) {
      invoke('open_signal_window', { path: line })
        .catch((e) => print(`打开信号系统窗口失败: ${e}\n`, 'cmd-err'));
      return;
    }
    // 其余一律交给 .yt 解释器
    const result = await invoke('yt_eval', { code: line });
    renderResult(result);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

export function pushHistory(line) {
  if (!line.trim()) return;
  if (state.history.length > 500) state.history.shift();
  state.history.push(line);
  state.historyIdx = state.history.length;
}

export function navigateHistory(dir) {
  if (!state.history.length) return;
  state.historyIdx = Math.max(0, Math.min(state.history.length, state.historyIdx + dir));
  const input = $('#cmd-input');
  if (!input) return;
  input.value = state.history[state.historyIdx] ?? '';
  input.selectionStart = input.selectionEnd = input.value.length;
}

function printHelp() {
  print(
    '── shell ─────────────────────────────────\n' +
    '  ni <文件名>    在当前目录新建文件，例如 ni a.yt / ni w.java\n' +
    '  cd <目录>      切换目录（文件树与终端同步）\n' +
    '  ls / dir       列出当前目录\n' +
    '  mkdir <名称>   新建文件夹\n' +
    '  del / rm <名>  删除文件或文件夹\n' +
    '  pwd            当前路径\n' +
    '  cls / clc      清屏\n' +
    '  cmd [ps|pwsh] 唤出/聚焦终端（Windows PowerShell 5.1；pwsh = PowerShell 7）\n' +
    '  run [文件.yt]  仅运行 .yt 文件（默认当前文件）\n' +
    '  circuit [文件.ckt] 打开电路仿真画布\n' +
    '  clear          清空工作区变量\n' +
    '  who            列出工作区变量\n' +
    '  savews         保存工作区到文件\n' +
    '── .yt 语言 ──────────────────────────────\n' +
    '  s=4 / s1=1.4              定义变量\n' +
    '  a=[1,2;3,4]  或 [1 2;3 4] 定义矩阵\n' +
    '  a*b  a+b  a-b             矩阵运算（结果存入 ans）\n' +
    '  a=readtu("a.png")         读取 PNG/JPEG 灰度图为 0–255 矩阵\n' +
    '  savetu(a,"out.png")       将矩阵保存为灰度图片\n' +
    "  a'                        转置\n" +
    '  H(a)  行列式    N(a) 逆矩阵    R(a) 秩\n' +
    '  GS(a) 行最简阶梯形矩阵    T(a) 特征值与特征向量（可含复数）\n' +
    '  y->x  声明函数，y=sin(x)-x 定义映射\n' +
    '  plot(y) / plot(y,f)       绘图；plot(y;0,100) 自定义 x 范围\n' +
    '  seek(y=0) / seek(y=0,-5,5) 求多项式根（最高 10 次）；超越方程搜索实根\n' +
    '  jf(y,0,1)                 数值积分；asin/acos/atan 与 asinh/acosh/atanh\n' +
    '  i/j 未定义时为虚数单位；二、三次多项式用公式，高次多项式数值求根\n' +
    '  复值函数绘图显示实部和虚部；三角函数使用弧度\n' +
    '  e=2.71828   pi=3.14159265 只读常量\n\n',
    'cmd-info',
  );
}

/* ================ 进程运行器（子进程 stdout/stderr 流式输出） ================ */

const activeRunnerKeys = new Map();
let runnerEventUnlisten = null;
let runnerEventInitialized = false;

export async function bindShellEvents() {
  if (runnerEventInitialized) return;
  runnerEventInitialized = true;
  runnerEventUnlisten = await listen('shell-output', (event) => {
    const payload = event.payload || {};
    const { key, text, line_break, cmd } = payload;
    if (!key) return;
    if (text == null) {
      stopShell(key);
      return;
    }
    appendCmdOutput(key, text, line_break, cmd);
  });
}

export async function runShell(text, cwd) {
  try {
    const key = await invoke('shell_spawn', { command: text, cwd });
    activeRunnerKeys.set(key, text);
  } catch (e) {
    print(`${e}\n`, 'cmd-err');
  }
}

export function stopShell(key) {
  activeRunnerKeys.delete(key);
  print('\n', 'cmd-echo');
}

function appendCmdOutput(key, text, lineBreak, cmd) {
  if (cmd === 'stdout_start') {
    const startedCmd = activeRunnerKeys.get(key);
    print(`${startedCmd || ''}\n`, 'cmd-echo');
    return;
  }
  const isErrorMark = cmd === 'stderr_start';
  const segmentClassName = isErrorMark ? 'cmd-stderr' : 'cmd-stdout';
  const safeText = String(text ?? '');
  if (safeText) {
    const span = document.createElement('span');
    span.className = segmentClassName;
    span.textContent = safeText;
    const out = $('#cmd-output');
    if (out) out.appendChild(span);
  }
  if (lineBreak) {
    const hasStdinBlock = cmd === 'stdout_data';
    if (hasStdinBlock) {
      const wrapperSpan = document.createElement('span');
      wrapperSpan.className = 'cmd-stdin-block';
      wrapperSpan.textContent = '等待手动输入...';
      const out = $('#cmd-output');
      if (out) out.appendChild(wrapperSpan);
    } else {
      print('\n');
    }
  }
  const scroll = $('#cmd-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

export function unbindShellEvents() {
  if (runnerEventUnlisten) {
    runnerEventUnlisten();
    runnerEventUnlisten = null;
  }
  runnerEventInitialized = false;
}
