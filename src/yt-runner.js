// yt-runner：工作区管理 + .yt 文件运行 + 文件操作
import { invoke } from '@tauri-apps/api/core';
import { state, $, print, esc } from './common.js';
import { showFigure } from './figure.js';
import { renderTree, openFile, saveFile, toggleTerminal, injectLine, focusInput, hasUnsavedChanges } from './services.js';

/* ================ 工作区渲染 ================ */

export function renderWorkspace(vars) {
  const box = $('#workspace-vars');
  if (!box) return;
  if (!vars.length) {
    box.innerHTML = '<div class="placeholder-content">无变量</div>';
    return;
  }
  box.innerHTML = vars
    .map((v) => `
      <div class="var-row" title="${esc(v.value)}">
        <span class="var-name">${esc(v.name)}</span>
        <span class="var-value">${esc(v.value)}</span>
        <span class="var-type type-${esc(v.var_type)}">${esc(v.var_type)}</span>
        <span class="var-size">${esc(v.size)}</span>
      </div>`)
    .join('');
}

export function renderResult(result) {
  (result.outputs || []).forEach((o) => print(`${o.text}\n`, o.is_error ? 'cmd-err' : 'cmd-result'));
  renderWorkspace(result.vars || []);
  if (result.plot) showPlot(result.plot);
}

export function showPlot(plot) {
  state.plotSeq += 1;
  showFigure({
    title: `Figure ${state.plotSeq}`,
    series: plot.series || [],
  });
}

export async function saveWorkspace() {
  try {
    const path = await invoke('save_file_dialog', {
      defaultName: 'workspace.json',
      ext: 'json',
    });
    if (!path) return;
    const msg = await invoke('save_workspace', { path });
    print(`${msg}\n`, 'cmd-info');
  } catch (e) {
    print(`保存工作区失败: ${e}\n`, 'cmd-err');
  }
}

/* ================ 文件操作 ================ */

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

export async function createFileFromCommand(rawName) {
  const name = validateNewFileName(rawName);
  const path = await invoke('create_file', { name });
  await renderTree();
  await openFile(path);
  print(`已新建: ${name}\n`, 'cmd-info');
}

export async function runFile(path) {
  if (!/\.yt$/i.test(path)) {
    print('run 只支持 .yt 文件；其他文件请用内嵌终端运行\n', 'cmd-err');
    return;
  }
  try {
    const result = await invoke('run_yt_file', { path });
    renderResult(result);
  } catch (e) {
    print(`${String(e)}\n`, 'cmd-err');
  }
}

/* ================ 运行 ================ */

// PowerShell 里安全地引用路径
function shellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// C: gcc file.c -o file.exe; 编译成功后再运行（C++ 用 g++）
function buildCompileRunCommand(path) {
  const compiler = /\.c$/i.test(path) ? 'gcc' : 'g++';
  const exe = path.replace(/\.[^.\\/]+$/, '') + '.exe';
  return `${compiler} ${shellQuote(path)} -o ${shellQuote(exe)}; if ($LASTEXITCODE -eq 0) { & ${shellQuote(exe)} }`;
}

export async function runActiveFile() {
  if (!state.activeFile) {
    print('没有可运行的文件，请先选择 .yt 文件\n', 'cmd-err');
    return;
  }
  if (state.activeFileKind === 'text' && hasUnsavedChanges()) {
    const saved = await saveFile();
    if (!saved) {
      print('保存失败，已取消运行\n', 'cmd-err');
      return;
    }
  }

  const path = state.activeFile;
  if (state.activeFileKind === 'image') {
    print('图片文件不能运行\n', 'cmd-info');
    return;
  }
  if (/\.yt$/i.test(path)) {
    await runFile(path);
    return;
  }

  const name = path.split(/[/\\]/).pop();
  await toggleTerminal(true);

  if (/\.py$/i.test(path)) {
    const ok = injectLine(`python ${shellQuote(path)}`);
    print(ok ? `已在终端中运行: ${name}\n` : `终端正忙，请手动运行: python ${shellQuote(name)}\n`, 'cmd-info');
    return;
  }
  if (/\.(c|cc|cpp|cxx)$/i.test(path)) {
    const ok = injectLine(buildCompileRunCommand(path));
    print(ok
      ? `正在编译并运行: ${name}\n`
      : `终端正忙，请手动编译运行: ${buildCompileRunCommand(path)}\n`, 'cmd-info');
    return;
  }
  print(`该文件类型（${name}）暂不支持一键运行，请在终端中执行\n`, 'cmd-info');
}

export function bindRunButton() {
  $('#btn-run-file')?.addEventListener('click', runActiveFile);
}
