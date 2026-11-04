import { invoke } from '@tauri-apps/api/core';
import { initCircuit, openCircuit, openCircuitFile } from './circuit/editor.js';
import { showFigure } from './figure.js';

const state = {
  cwd: '',
  entries: [],
  expanded: new Set(),
  treeLoading: new Set(),
  treeErrors: new Map(),
  treeError: '',
  activeFile: null,
  content: '',
  original: '',
  pyMode: false,
  pyPending: false,
  history: [],
  historyIdx: -1,
  plotSeq: 0,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------------- 初始化 ---------------- */

async function init() {
  bindRibbon();
  bindFileTree();
  bindEditor();
  bindCommandLine();
  bindSplitters();
  initCircuit({ getCwd: () => state.cwd, refresh: refreshTree });

  document.addEventListener('rzend:plot', (e) => showPlot(e.detail));

  state.cwd = await invoke('get_initial_dir').catch(() => '.');
  await refreshTree();
  updateStatus();
  focusInput();
}

function bindRibbon() {
  $('#ribbon-open-folder')?.addEventListener('click', openFolderDialog);
  $('#ribbon-save')?.addEventListener('click', saveFile);
  $('#ribbon-run')?.addEventListener('click', runActiveFile);
  $('#ribbon-toggle-folder')?.addEventListener('click', () => togglePanel('#folder-panel', '#split-left'));
  $('#ribbon-toggle-workspace')?.addEventListener('click', () => togglePanel('#workspace-panel', '#split-right'));
  $('#ribbon-circuit')?.addEventListener('click', openCircuit);
}

function togglePanel(sel, splitterSel) {
  $(sel)?.classList.toggle('hidden');
  if (splitterSel) $(splitterSel)?.classList.toggle('hidden');
}

/* ---------------- 可拖动分隔条 ---------------- */

function bindSplitters() {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const drag = (el, vertical, onMove) => {
    el?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add(vertical ? 'dragging-y' : 'dragging-x');
      const move = (ev) => onMove(ev);
      const up = () => {
        document.body.classList.remove('dragging-x', 'dragging-y');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };

  drag($('#split-left'), false, (e) => {
    $('#folder-panel').style.width = `${clamp(e.clientX, 150, 480)}px`;
  });
  drag($('#split-right'), false, (e) => {
    $('#workspace-panel').style.width = `${clamp(window.innerWidth - e.clientX, 180, 560)}px`;
  });
  drag($('#split-editor'), true, (e) => {
    const rect = $('#center-area').getBoundingClientRect();
    $('#editor-panel').style.height = `${clamp(e.clientY - rect.top, 100, rect.height - 160)}px`;
  });
}

/* ---------------- 文件树 ---------------- */

async function refreshTree() {
  try {
    state.entries = await invoke('shell_ls');
    state.treeError = '';
    state.treeErrors.clear();
  } catch (e) {
    state.entries = [];
    state.treeError = String(e);
    print(`读取目录失败: ${e}\n`, 'cmd-err');
  }
  renderTree();
  $('#current-folder-path').textContent = state.cwd || '—';
  updateStatus();
}

function renderTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '';
  if (state.treeError) {
    tree.innerHTML = `<div class="placeholder-content">${esc(state.treeError)}</div>`;
    return;
  }
  if (!state.entries.length) {
    tree.innerHTML = '<div class="placeholder-content">空文件夹</div>';
    return;
  }
  state.entries.forEach((e) => renderNode(tree, e, 0));
}

function renderNode(container, entry, depth) {
  const row = document.createElement('div');
  row.className = 'tree-item';
  row.style.paddingLeft = `${depth * 14 + 8}px`;
  if (entry.path === state.activeFile) row.classList.add('selected');

  const arrow = document.createElement('span');
  arrow.className = 'tree-arrow';
  arrow.textContent = entry.is_dir ? (state.expanded.has(entry.path) ? '▾' : '▸') : '';
  row.appendChild(arrow);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = entry.is_dir ? (state.expanded.has(entry.path) ? '📂' : '📁') : fileIcon(entry.name);
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  row.appendChild(name);

  row.addEventListener('click', () => {
    if (entry.is_dir) {
      if (state.expanded.has(entry.path)) {
        state.expanded.delete(entry.path);
      } else {
        state.treeErrors.delete(entry.path);
        state.expanded.add(entry.path);
      }
      renderTree();
    } else {
      openFile(entry.path);
    }
  });

  container.appendChild(row);

  if (entry.is_dir && state.expanded.has(entry.path)) {
    if (entry.children === null) {
      if (state.treeLoading.has(entry.path)) {
        renderTreeMessage(container, '正在读取…', depth + 1);
      } else if (state.treeErrors.has(entry.path)) {
        renderTreeMessage(container, '读取失败，收起后重新展开可重试', depth + 1);
      } else {
        queueMicrotask(() => loadTreeDirectory(entry));
      }
    } else if (!entry.children.length) {
      renderTreeMessage(container, '空文件夹', depth + 1);
    } else {
      entry.children.forEach((child) => renderNode(container, child, depth + 1));
    }
  }
}

function renderTreeMessage(container, text, depth) {
  const row = document.createElement('div');
  row.className = 'tree-message';
  row.style.paddingLeft = `${depth * 14 + 8}px`;
  row.textContent = text;
  container.appendChild(row);
}

async function loadTreeDirectory(entry) {
  if (state.treeLoading.has(entry.path) || !state.expanded.has(entry.path)) return;
  state.treeLoading.add(entry.path);
  renderTree();
  try {
    const children = await invoke('scan_directory', { path: entry.path });
    const currentEntry = findTreeEntry(state.entries, entry.path);
    if (currentEntry) {
      currentEntry.children = children;
      state.treeErrors.delete(entry.path);
    }
  } catch (e) {
    state.treeErrors.set(entry.path, String(e));
    print(`读取文件夹失败: ${e}\n`, 'cmd-err');
  } finally {
    state.treeLoading.delete(entry.path);
    renderTree();
  }
}

function findTreeEntry(entries, path) {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const found = entry.children && findTreeEntry(entry.children, path);
    if (found) return found;
  }
  return null;
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = { yt: '🔷', pyt: '🐍', py: '🐍', txt: '📄', md: '📝', json: '📋' };
  return map[ext] || '📄';
}

function bindFileTree() {
  $('#btn-refresh')?.addEventListener('click', refreshTree);
  $('#btn-folder-up')?.addEventListener('click', () => doCd('..'));
}

async function openFolderDialog() {
  try {
    const picked = await invoke('open_folder_dialog');
    await doCd(picked, true);
  } catch (e) {
    if (e !== '未选择文件夹') print(`打开文件夹失败: ${e}\n`, 'cmd-err');
  }
}

/* ---------------- 编辑器 ---------------- */

function bindEditor() {
  const ta = $('#code-textarea');
  ta?.addEventListener('input', () => {
    state.content = ta.value;
    updateLineNumbers();
    const mod = state.content !== state.original;
    $('#editor-modified').classList.toggle('hidden', !mod);
  });
  ta?.addEventListener('scroll', () => {
    const ln = $('#line-numbers');
    if (ln) ln.scrollTop = ta.scrollTop;
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 4;
      ta.dispatchEvent(new Event('input'));
    }
  });

  $('#btn-save-file')?.addEventListener('click', saveFile);
  $('#btn-run-file')?.addEventListener('click', runActiveFile);
  $('#btn-close-file')?.addEventListener('click', closeEditor);
}

async function openFile(path) {
  if (/\.ckt$/i.test(path)) {
    await openCircuitFile(path);
    return;
  }
  try {
    const text = await invoke('read_file_content', { path });
    state.activeFile = path;
    state.content = text;
    state.original = text;
    const ta = $('#code-textarea');
    ta.value = text;
    $('#editor-filename').textContent = path.split(/[/\\]/).pop();
    $('#editor-modified').classList.add('hidden');
    $('#editor-panel').classList.remove('hidden');
    updateLineNumbers();
    renderTree();
    updateStatus();
    ta.focus();
  } catch (e) {
    print(`无法打开文件: ${e}\n`, 'cmd-err');
  }
}

function closeEditor() {
  $('#editor-panel').classList.add('hidden');
  state.activeFile = null;
  state.content = '';
  state.original = '';
  renderTree();
  updateStatus();
  focusInput();
}

let lastLineCount = -1;

function updateLineNumbers() {
  const ta = $('#code-textarea');
  const ln = $('#line-numbers');
  if (!ta || !ln) return;
  const n = ta.value.split('\n').length;
  if (n === lastLineCount) return; // 行数不变时跳过重建，避免每次按键全量刷新
  lastLineCount = n;
  ln.innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
}

async function saveFile() {
  if (!state.activeFile) {
    print('没有打开的文件\n', 'cmd-err');
    return;
  }
  try {
    await invoke('write_file_content', { path: state.activeFile, content: state.content });
    state.original = state.content;
    $('#editor-modified').classList.add('hidden');
    print(`已保存: ${state.activeFile.split(/[/\\]/).pop()}\n`, 'cmd-info');
  } catch (e) {
    print(`保存失败: ${e}\n`, 'cmd-err');
  }
}

/* ---------------- 命令行新建文件 ---------------- */

const ILLEGAL_FILE_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function validateNewFileName(raw) {
  let name = String(raw || '').trim();
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1);
  }
  if (!name) throw new Error('用法: ni <文件名>，例如 ni a.py');
  if (name === '.' || name === '..') throw new Error('不能用 . 或 .. 作为文件名');
  if (name.length > 255) throw new Error('文件名过长（最多 255 个字符）');
  if (ILLEGAL_FILE_NAME_CHARS.test(name)) throw new Error('文件名不能包含路径分隔符或 Windows 不允许的字符');
  if (/[. ]$/.test(name)) throw new Error('文件名不能以空格或句点结尾');
  if (RESERVED_FILE_NAME.test(name)) throw new Error(`「${name}」是系统保留名，请换一个`);
  return name;
}

async function createFileFromCommand(rawName) {
  const name = validateNewFileName(rawName);
  const path = await invoke('create_file', { name });
  await refreshTree();
  await openFile(path);
  print(`已新建: ${name}\n`, 'cmd-info');
}

/* ---------------- 命令行 ---------------- */

function bindCommandLine() {
  const input = $('#cmd-input');
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const line = input.value;
      input.value = '';
      if (e.ctrlKey) return;
      // 空行回车：像标准终端一样补一条新的提示符行
      if (!line.trim()) {
        if (state.pyMode) {
          // Python 块收集模式下，空行用于结束代码块，必须真正发送给解释器
          await execLine('');
        } else {
          echo('>>', '');
        }
        focusInput();
        return;
      }
      pushHistory(line);
      await execLine(line);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateHistory(1);
    }
  });
  $('#btn-clear-cmd')?.addEventListener('click', () => {
    $('#cmd-output').innerHTML = '';
    focusInput();
  });
  $('#cmd-scroll')?.addEventListener('click', () => {
    if (window.getSelection()?.isCollapsed !== false) focusInput();
  });
}

function focusInput() {
  $('#cmd-input')?.focus();
}

function pushHistory(line) {
  if (!line.trim()) return;
  state.history.push(line);
  state.historyIdx = state.history.length;
}

function navigateHistory(dir) {
  if (!state.history.length) return;
  state.historyIdx = Math.max(0, Math.min(state.history.length, state.historyIdx + dir));
  const input = $('#cmd-input');
  input.value = state.history[state.historyIdx] ?? '';
  input.selectionStart = input.selectionEnd = input.value.length;
}

function print(text, cls = 'cmd-result') {
  const out = $('#cmd-output');
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  out.appendChild(span);
  const scroll = $('#cmd-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function echo(prompt, line) {
  print(`${prompt} ${line}\n`, 'cmd-echo');
}

async function execLine(raw) {
  const line = raw.trim();
  const prompt = state.pyMode ? (state.pyPending ? '...' : '>>>') : '>>';
  echo(prompt, raw);

  // Python 交互模式：所有输入交给 MicroPython
  if (state.pyMode) {
    if (!state.pyPending && (line === 'exit' || line === 'quit' || line === 'exit()')) {
      const msg = await invoke('py_stop').catch((e) => String(e));
      setPyMode(false);
      print(`${msg}\n`, 'cmd-info');
      return;
    }
    try {
      const reply = await invoke('py_send', { line: raw });
      appendPythonOutput(reply.output);
      state.pyPending = !!reply.pending;
      updatePrompt();
    } catch (e) {
      print(`${e}\n`, 'cmd-err');
    }
    return;
  }

  const [head, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();
  const cmd = head.toLowerCase();

  try {
    if (cmd === 'help' || cmd === '?') {
      return printHelp();
    }
    if (cmd === 'cls' || cmd === 'clc') {
      $('#cmd-output').innerHTML = '';
      return;
    }
    if (cmd === 'pwd') {
      return print(`${state.cwd}\n`, 'cmd-result');
    }
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
    if (cmd === 'ni') {
      return await createFileFromCommand(arg);
    }
    if (cmd === 'mkdir' || cmd === 'md') {
      if (!arg) return print('用法: mkdir <文件夹名>\n', 'cmd-err');
      const msg = await invoke('shell_mkdir', { name: arg });
      await refreshTree();
      return print(`${msg}\n`, 'cmd-info');
    }
    if (cmd === 'del' || cmd === 'rm') {
      if (!arg) return print('用法: del <文件或文件夹>\n', 'cmd-err');
      const msg = await invoke('shell_rm', { name: arg });
      // arg 多为相对文件名，需与 cwd 拼成全路径后再和活动文件比较
      if (state.activeFile) {
        const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const isAbs = /^([a-z]:[\\/]|\\\\)/i.test(arg);
        const full = isAbs ? arg : `${state.cwd}/${arg}`;
        if (norm(state.activeFile) === norm(full)) closeEditor();
      }
      await refreshTree();
      return print(`${msg}\n`, 'cmd-info');
    }
    if (cmd === 'circuit' || cmd === 'cir') {
      if (arg) return openCircuitFile(arg);
      return openCircuit();
    }
    if (cmd === 'py') {
      if (arg) return runPytFile(arg);
      return startPython();
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
    if (cmd === 'exit' || cmd === 'quit') {
      return print('（桌面应用，可直接关闭窗口）\n', 'cmd-info');
    }

    // 直接输入文件名运行
    if (/\.yt$/i.test(line)) return runFile(line);
    if (/\.pyt$/i.test(line) || /\.py$/i.test(line)) return runPytFile(line);
    if (/\.ckt$/i.test(line)) return openCircuitFile(line);

    // 其余一律交给 .yt 解释器
    const result = await invoke('yt_eval', { code: line });
    renderResult(result);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

function printHelp() {
  print(
    '── shell ─────────────────────────────────\n' +
    '  ni <文件名>    在当前目录新建文件，例如 ni a.py / ni w.java\n' +
    '  cd <目录>      切换目录（文件树同步）\n' +
    '  ls / dir       列出当前目录\n' +
    '  mkdir <名称>   新建文件夹\n' +
    '  del / rm <名>  删除文件或文件夹\n' +
    '  pwd            当前路径\n' +
    '  cls / clc      清屏\n' +
    '  py             进入 MicroPython 交互模式 (exit 退出)\n' +
    '  py <文件.pyt>  运行 Python 文件\n' +
    '  run [文件.yt]  仅运行 .yt 文件（默认当前文件）\n' +
    '  circuit [文件.ckt] 打开电路仿真画布\n' +
    '  clear          清空工作区变量\n' +
    '  who            列出工作区变量\n' +
    '── .yt 语言 ──────────────────────────────\n' +
    '  s=4 / s1=1.4              定义变量\n' +
    '  a=[1,2;3,4]  或 [1 2;3 4] 定义矩阵\n' +
    '  a*b  a+b  a-b             矩阵运算（结果存入 ans）\n' +
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
    'cmd-info'
  );
}

async function doCd(path, silent = false) {
  try {
    const target = await invoke('shell_cd', { path });
    state.cwd = target;
    state.expanded.clear();
    if (!silent) print(`→ ${target}\n`, 'cmd-info');
    await refreshTree();
  } catch (e) {
    print(`${e}\n`, 'cmd-err');
  }
}

/* ---------------- 运行文件 ---------------- */

async function runActiveFile() {
  if (!state.activeFile) {
    print('没有可运行的文件，请先在文件树中选择 .yt 文件\n', 'cmd-err');
    return;
  }
  if (!/\.yt$/i.test(state.activeFile)) {
    print('运行按钮仅执行 .yt 文件；.pyt 等文件可使用对应命令运行\n', 'cmd-err');
    return;
  }
  if (state.content !== state.original) await saveFile();
  await runFile(state.activeFile);
}

async function runFile(path) {
  if (!/\.yt$/i.test(path)) {
    print('run 只支持 .yt 文件；运行 Python 文件请使用 py <文件.pyt>\n', 'cmd-err');
    return;
  }
  try {
    const result = await invoke('run_yt_file', { path });
    renderResult(result);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

async function runPytFile(path) {
  let inputs = null;
  try {
    const code = await invoke('read_file_content', { path });
    // 脚本里有 input() 时先收集输入值，运行前注入脚本副本
    if (/\binput\s*\(/.test(code)) {
      const values = await askScriptInput();
      if (values === null) {
        print('已取消运行\n', 'cmd-info');
        return;
      }
      inputs = values;   // 空数组也要注入：否则 input() 无标准输入会抛 KeyboardInterrupt
    }
  } catch {
    // 读不到内容就照常运行，由后端返回具体错误
  }
  try {
    const out = await invoke('run_pyt_file', { path, inputs });
    appendPythonOutput(out);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

function askScriptInput() {
  return new Promise((resolve) => {
    const modal = $('#stdin-modal');
    const box = $('#stdin-input');
    if (!modal || !box) {
      resolve([]);
      return;
    }
    box.value = '';
    $('#stdin-error').textContent = '';
    modal.classList.remove('hidden');
    box.focus();
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      resolve(val);
      focusInput();
    };
    // 每行一个输入值；末尾换行不算一个空值
    const readValues = () => {
      const lines = box.value.replace(/\r\n/g, '\n').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    $('#stdin-ok').onclick = () => finish(readValues());
    $('#stdin-cancel').onclick = () => finish(null);
    modal.onclick = (e) => {
      if (e.target === modal) finish(null);
    };
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(readValues());
      }
      e.stopPropagation();
    };
  });
}

async function startPython() {
  try {
    const banner = await invoke('py_start');
    setPyMode(true);
    print('── 已进入 MicroPython 交互模式（输入 exit 退出）──\n', 'cmd-info');
    appendPythonOutput(banner);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

function setPyMode(on) {
  state.pyMode = on;
  state.pyPending = false;
  updatePrompt();
  updateStatus();
}

function updatePrompt() {
  const prompt = $('#cmd-prompt');
  if (!prompt) return;
  prompt.textContent = state.pyMode ? (state.pyPending ? '...' : '>>>') : '>>';
  prompt.classList.toggle('py-mode', state.pyMode);
}

function appendPythonOutput(text) {
  const clean = String(text)
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '>>>' && l.trim() !== '...')
    .join('\n')
    .replace(/^(>>>|\.\.\.) /gm, '');
  if (!clean.trim()) return;
  print(clean.endsWith('\n') ? clean : `${clean}\n`, 'cmd-result');
}

function renderResult(result) {
  (result.outputs || []).forEach((o) => print(`${o.text}\n`, o.is_error ? 'cmd-err' : 'cmd-result'));
  renderWorkspace(result.vars || []);
  if (result.plot) showPlot(result.plot);
}

/* ---------------- 工作区面板 ---------------- */

function renderWorkspace(vars) {
  const box = $('#workspace-vars');
  if (!vars.length) {
    box.innerHTML = '<div class="placeholder-content">无变量</div>';
    return;
  }
  box.innerHTML = vars
    .map(
      (v) => `
      <div class="var-row" title="${esc(v.value)}">
        <span class="var-name">${esc(v.name)}</span>
        <span class="var-value">${esc(v.value)}</span>
        <span class="var-type type-${esc(v.var_type)}">${esc(v.var_type)}</span>
        <span class="var-size">${esc(v.size)}</span>
      </div>`
    )
    .join('');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

/* ---------------- 绘图弹窗 ---------------- */

function showPlot(plot) {
  state.plotSeq += 1;
  showFigure({
    title: `Figure ${state.plotSeq}`,
    series: plot.series || [],
  });
}

/* ---------------- 状态栏 ---------------- */

function updateStatus() {
  const name = (state.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  $('#status-folder').textContent = name || state.cwd;
  $('#status-indicator').textContent = state.pyMode ? 'Python 交互' : state.activeFile ? `编辑: ${state.activeFile.split(/[/\\]/).pop()}` : '就绪';
}

/* ---------------- 键盘快捷键 ---------------- */

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) {
    if (e.key === 'F5') { e.preventDefault(); runActiveFile(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); saveFile(); }
  else if (k === 'o') { e.preventDefault(); openFolderDialog(); }
  else if (k === 'n') {
    e.preventDefault();
    const input = $('#cmd-input');
    input.value = 'ni ';
    focusInput();
  }
  else if (k === 'w') { e.preventDefault(); closeEditor(); }
});

window.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => console.error(e));
});
