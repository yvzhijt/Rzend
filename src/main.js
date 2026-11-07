import { invoke } from '@tauri-apps/api/core';
import { showFigure } from './figure.js';
import { MAIN_DOCKS, bindPanelDrag, restorePanelOrder } from './panels.js';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import {
  toggleTerminal,
  setOnTerminalCwd,
  setOnTerminalNotice,
  setTerminalCwdChip,
  syncTerminalCwd,
  injectLine,
} from './terminal.js';

const state = {
  cwd: '',
  entries: [],
  expanded: new Set(),
  treeLoading: new Set(),
  treeErrors: new Map(),
  treeError: '',
  activeFile: null,
  activeFileKind: 'text',
  fileOpenSeq: 0,
  imageTransformSeq: 0,
  imageOperations: [],
  imageWidth: 0,
  imageHeight: 0,
  imageBusy: false,
  imageBusySeq: 0,
  content: '',
  original: '',
  history: [],
  historyIdx: -1,
  plotSeq: 0,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------------- 代码编辑器（CodeMirror 6） ---------------- */

let editorView = null;
const languageCompartment = new Compartment();

// 按扩展名映射语法高亮语言；不认识的扩展名留空（纯文本）
function languageForPath(path) {
  const ext = String(path).split('.').pop()?.toLowerCase() || '';
  if (ext === 'py' || ext === 'pyw') return python();
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(ext)) return cpp();
  return [];
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.5' },
  '.cm-content': { padding: '8px 0', whiteSpace: 'pre' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    borderRight: '1px solid var(--border-light)',
    color: '#a0a0a0',
  },
  '.cm-activeLineGutter': { backgroundColor: '#f0f0f0' },
  '.cm-activeLine': { backgroundColor: '#f6f6f6' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#b6d7f2 !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
});

function setEditorDocument(text, langExt) {
  if (!editorView) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: text },
    effects: languageCompartment.reconfigure(langExt || []),
  });
}

/* ---------------- 初始化 ---------------- */

async function init() {
  bindRibbon();
  bindFileTree();
  bindEditor();
  bindCommandLine();
  bindTerminalPanel();
  bindSplitters();
  restorePanelOrder(MAIN_DOCKS);
  bindPanelDrag(MAIN_DOCKS);

  document.addEventListener('rzend:plot', (e) => showPlot(e.detail));

  // 终端 → 应用：cwd 变化时静默同步共享 cwd 与文件树（不注入回终端）
  setOnTerminalCwd((cwd) => {
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    invoke('shell_cd', { path: cwd })
      .then((target) => {
        setTerminalCwdChip(target);
        if (state.cwd && norm(state.cwd) === norm(target)) return;
        state.cwd = target;
        state.expanded.clear();
        state.treeErrors.clear();
        refreshTree();
        print(`终端 → ${target}\n`, 'cmd-info');
      })
      .catch(() => setTerminalCwdChip(cwd));
  });
  setOnTerminalNotice((msg) => print(`${msg}\n`, 'cmd-info'));

  state.cwd = await invoke('get_initial_dir').catch(() => '.');
  setTerminalCwdChip(state.cwd);
  await refreshTree();
  updateStatus();
  focusInput();
}

function bindRibbon() {
  $('#ribbon-open-folder')?.addEventListener('click', openFolderDialog);
  $('#ribbon-save')?.addEventListener('click', saveFile);
  $('#ribbon-run')?.addEventListener('click', runActiveFile);
  $('#ribbon-toggle-folder')?.addEventListener('click', () => toggleDockPanel('#folder-panel'));
  $('#ribbon-toggle-workspace')?.addEventListener('click', () => toggleDockPanel('#workspace-panel'));
  $('#ribbon-circuit')?.addEventListener('click', () => {
    invoke('open_circuit_window', { path: null }).catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
  });
}

function toggleDockPanel(selector) {
  const panel = $(selector);
  if (!panel) return;
  panel.classList.toggle('hidden');
  const isHidden = panel.classList.contains('hidden');
  [panel.previousElementSibling, panel.nextElementSibling]
    .filter((element) => element?.matches('.splitter'))
    .forEach((splitter) => splitter.classList.toggle('hidden', isHidden));
}

/* ---------------- 可拖动分隔条 ---------------- */

function bindSplitters() {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const bindResize = (splitter, axis, onMove) => {
    if (!splitter) return;
    let pointerId = null;

    const finish = (event) => {
      if (pointerId == null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
      pointerId = null;
      document.body.classList.remove(`dragging-${axis}`);
      splitter.classList.remove('resizing');
    };

    splitter.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      pointerId = event.pointerId;
      splitter.setPointerCapture(pointerId);
      document.body.classList.add(`dragging-${axis}`);
      splitter.classList.add('resizing');
    });
    splitter.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      onMove(event);
    });
    splitter.addEventListener('pointerup', finish);
    splitter.addEventListener('pointercancel', finish);
    splitter.addEventListener('lostpointercapture', finish);
  };

  const mainArea = $('#main-area');
  bindResize($('#split-left'), 'x', (event) => {
    const splitter = event.currentTarget;
    const panel = splitter.previousElementSibling;
    if (!panel?.matches('#folder-panel, #workspace-panel')) return;
    const rect = mainArea.getBoundingClientRect();
    const otherWidth = Array.from(mainArea.querySelectorAll('#folder-panel, #workspace-panel'))
      .filter((item) => item !== panel && !item.classList.contains('hidden'))
      .reduce((width, item) => width + item.getBoundingClientRect().width, 0);
    const max = Math.min(480, rect.width - otherWidth - 330);
    panel.style.width = `${clamp(event.clientX - rect.left, 170, Math.max(170, max))}px`;
  });
  bindResize($('#split-right'), 'x', (event) => {
    const splitter = event.currentTarget;
    const panel = splitter.nextElementSibling;
    if (!panel?.matches('#folder-panel, #workspace-panel')) return;
    const rect = mainArea.getBoundingClientRect();
    const otherWidth = Array.from(mainArea.querySelectorAll('#folder-panel, #workspace-panel'))
      .filter((item) => item !== panel && !item.classList.contains('hidden'))
      .reduce((width, item) => width + item.getBoundingClientRect().width, 0);
    const max = Math.min(560, rect.width - otherWidth - 330);
    panel.style.width = `${clamp(rect.right - event.clientX, 190, Math.max(190, max))}px`;
  });
  bindResize($('#split-editor'), 'y', (event) => {
    const splitter = event.currentTarget;
    const before = splitter.previousElementSibling;
    const after = splitter.nextElementSibling;
    if (!before || !after) return;
    const rect = $('#center-area').getBoundingClientRect();
    const minBefore = before.id === 'editor-panel' ? 110 : 90;
    const minAfter = after.id === 'editor-panel' ? 110 : 90;
    const max = rect.height - minAfter - splitter.offsetHeight;
    before.style.flex = `0 0 ${clamp(event.clientY - rect.top, minBefore, Math.max(minBefore, max))}px`;
    after.style.flex = '1 1 0';
  });
  bindResize($('#split-terminal'), 'y', (event) => {
    const splitter = event.currentTarget;
    const before = splitter.previousElementSibling;
    const after = splitter.nextElementSibling;
    if (before?.id !== 'command-window' || after?.id !== 'terminal-panel') return;
    // 锚定命令行窗口自身的上边界（上方可能有编辑器占位）
    const rect = $('#center-area').getBoundingClientRect();
    const beforeRect = before.getBoundingClientRect();
    const topOffset = beforeRect.top - rect.top;
    const minBefore = 90;
    const minAfter = 100;
    const max = rect.height - topOffset - minAfter - splitter.offsetHeight;
    before.style.flex = `0 0 ${clamp(event.clientY - beforeRect.top, minBefore, Math.max(minBefore, max))}px`;
    after.style.flex = '1 1 0';
  });

  // 双击分隔条恢复默认尺寸；面板显隐由工具栏按钮控制
  $('#split-left')?.addEventListener('dblclick', (event) => {
    const panel = event.currentTarget.previousElementSibling;
    if (panel?.matches('#folder-panel, #workspace-panel')) panel.style.width = '';
  });
  $('#split-right')?.addEventListener('dblclick', (event) => {
    const panel = event.currentTarget.nextElementSibling;
    if (panel?.matches('#folder-panel, #workspace-panel')) panel.style.width = '';
  });
  $('#split-editor')?.addEventListener('dblclick', (event) => {
    const splitter = event.currentTarget;
    if (splitter.previousElementSibling && splitter.nextElementSibling) {
      splitter.previousElementSibling.style.flex = '';
      splitter.nextElementSibling.style.flex = '';
    }
  });
  $('#split-terminal')?.addEventListener('dblclick', (event) => {
    const splitter = event.currentTarget;
    // 双击恢复：命令行窗口回到 flex:1，终端回到 CSS 默认 280px
    if (splitter.previousElementSibling?.id === 'command-window') splitter.previousElementSibling.style.flex = '';
    if (splitter.nextElementSibling?.id === 'terminal-panel') splitter.nextElementSibling.style.flex = '';
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

function isPreviewableImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path);
}

function bindEditor() {
  editorView = new EditorView({
    parent: $('#editor-host'),
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        languageCompartment.of([]),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            state.content = update.state.doc.toString();
            $('#editor-modified').classList.toggle('hidden', state.content === state.original);
          }
        }),
      ],
    }),
  });

  $('#btn-save-file')?.addEventListener('click', saveFile);
  $('#btn-run-file')?.addEventListener('click', runActiveFile);
  $('#btn-close-file')?.addEventListener('click', closeEditor);
  $('#image-crop-apply')?.addEventListener('click', applyImageCrop);
  $('#image-resize-apply')?.addEventListener('click', applyImageResize);
  $('#image-rotate-left')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_left' }));
  $('#image-rotate-right')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_right' }));
  $('#image-filter-apply')?.addEventListener('click', applyImageFilter);
  $('#image-reset')?.addEventListener('click', resetImageEdits);
  $('#image-save-as')?.addEventListener('click', saveEditedImageAs);
}

async function openFile(path) {
  const request = ++state.fileOpenSeq;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  $$('#image-tools button, #image-tools select, #image-tools input')
    .forEach((control) => { control.disabled = false; });
  if (/\.ckt$/i.test(path)) {
    // .ckt 在独立的电路仿真窗口中打开
    invoke('open_circuit_window', { path })
      .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
    return;
  }
  try {
    if (isPreviewableImage(path)) {
      const preview = await invoke('read_image_preview', { path });
      if (request !== state.fileOpenSeq) return;
      state.activeFile = path;
      state.activeFileKind = 'image';
      state.imageOperations = [];
      state.imageWidth = preview.width;
      state.imageHeight = preview.height;
      state.content = '';
      state.original = '';
      setImageDimensionInputs(preview.width, preview.height);
      $('#editor-filename').textContent = path.split(/[/\\]/).pop();
      $('#editor-modified').classList.add('hidden');
      $('#editor-host').classList.add('hidden');
      $('#btn-run-file').classList.add('hidden');
      $('#btn-save-file').classList.add('hidden');
      const previewContainer = $('#image-preview');
      const image = $('#preview-image');
      image.src = preview.data_url;
      image.alt = path.split(/[/\\]/).pop();
      $('#preview-image-info').textContent = `${preview.width} × ${preview.height}`;
      image.onerror = () => {
        $('#preview-image-info').textContent = '图片预览加载失败';
      };
      previewContainer.classList.remove('hidden');
      $('#editor-panel').classList.remove('hidden');
      renderTree();
      updateStatus();
      return;
    }

    const text = await invoke('read_file_content', { path });
    if (request !== state.fileOpenSeq) return;
    state.activeFile = path;
    state.activeFileKind = 'text';
    state.imageOperations = [];
    state.content = text;
    state.original = text;
    setEditorDocument(text, languageForPath(path));
    $('#editor-host')?.classList.remove('hidden');
    $('#image-preview').classList.add('hidden');
    $('#preview-image').removeAttribute('src');
    $('#btn-run-file').classList.remove('hidden');
    $('#btn-save-file').classList.remove('hidden');
    $('#editor-filename').textContent = path.split(/[/\\]/).pop();
    $('#editor-modified').classList.add('hidden');
    $('#editor-panel').classList.remove('hidden');
    renderTree();
    updateStatus();
    editorView?.focus();
  } catch (e) {
    print(`无法打开文件: ${e}\n`, 'cmd-err');
  }
}

function setImageDimensionInputs(width, height) {
  $('#image-crop-x').value = '0';
  $('#image-crop-y').value = '0';
  $('#image-crop-width').value = String(width);
  $('#image-crop-height').value = String(height);
  $('#image-resize-width').value = String(width);
  $('#image-resize-height').value = String(height);
}

async function renderEditedImage(outputPath = null, path = state.activeFile, operations = state.imageOperations.slice()) {
  const request = ++state.imageTransformSeq;
  const result = await invoke('transform_image', {
    path,
    operations,
    outputPath,
  });
  if (!outputPath && request === state.imageTransformSeq && path === state.activeFile) {
    $('#preview-image').src = result.data_url;
    state.imageWidth = result.width;
    state.imageHeight = result.height;
    $('#preview-image-info').textContent = `${result.width} × ${result.height}`;
    setImageDimensionInputs(result.width, result.height);
  }
  return result;
}

async function applyImageOperation(operation) {
  if (state.activeFileKind !== 'image' || state.imageBusy) return;
  const path = state.activeFile;
  const operationIndex = state.imageOperations.length;
  const busyToken = ++state.imageBusySeq;
  state.imageBusy = true;
  const controls = $$('#image-tools button, #image-tools select, #image-tools input');
  controls.forEach((control) => { control.disabled = true; });
  state.imageOperations.push(operation);
  try {
    await renderEditedImage();
    if (path === state.activeFile && state.imageOperations[operationIndex] === operation) {
      print('图片操作已应用\n', 'cmd-info');
    }
  } catch (error) {
    if (path === state.activeFile && state.imageOperations[operationIndex] === operation) {
      state.imageOperations.splice(operationIndex, 1);
      print(`图片操作失败: ${error}\n`, 'cmd-err');
    }
  } finally {
    if (busyToken === state.imageBusySeq) {
      state.imageBusy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }
}

function readImageDimension(selector, label) {
  const value = Number($(selector).value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正整数`);
  return value;
}

async function applyImageCrop() {
  try {
    const x = Number($('#image-crop-x').value);
    const y = Number($('#image-crop-y').value);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
      throw new Error('裁剪位置必须是非负整数');
    }
    await applyImageOperation({
      kind: 'crop',
      x,
      y,
      width: readImageDimension('#image-crop-width', '裁剪宽度'),
      height: readImageDimension('#image-crop-height', '裁剪高度'),
    });
  } catch (error) {
    print(`图片操作失败: ${error.message || error}\n`, 'cmd-err');
  }
}

async function applyImageResize() {
  try {
    await applyImageOperation({
      kind: 'resize',
      width: readImageDimension('#image-resize-width', '缩放宽度'),
      height: readImageDimension('#image-resize-height', '缩放高度'),
    });
  } catch (error) {
    print(`图片操作失败: ${error.message || error}\n`, 'cmd-err');
  }
}

async function applyImageFilter() {
  const kind = $('#image-filter').value;
  if (!kind) {
    print('请先选择滤镜\n', 'cmd-err');
    return;
  }
  await applyImageOperation({ kind });
  $('#image-filter').value = '';
}

async function resetImageEdits() {
  if (state.activeFileKind !== 'image' || state.imageBusy) return;
  const path = state.activeFile;
  const request = ++state.imageTransformSeq;
  const busyToken = ++state.imageBusySeq;
  state.imageBusy = true;
  try {
    const preview = await invoke('read_image_preview', { path });
    if (request !== state.imageTransformSeq || path !== state.activeFile) return;
    state.imageOperations = [];
    $('#preview-image').src = preview.data_url;
    state.imageWidth = preview.width;
    state.imageHeight = preview.height;
    $('#preview-image-info').textContent = `${preview.width} × ${preview.height}`;
    setImageDimensionInputs(preview.width, preview.height);
    print('已重置图片编辑\n', 'cmd-info');
  } catch (error) {
    print(`重置图片失败: ${error}\n`, 'cmd-err');
  } finally {
    if (busyToken === state.imageBusySeq) state.imageBusy = false;
  }
}

async function saveEditedImageAs() {
  if (state.activeFileKind !== 'image' || state.imageBusy) return;
  const sourcePath = state.activeFile;
  const operations = state.imageOperations.slice();
  const filename = sourcePath.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
  let busyToken = null;
  try {
    const outputPath = await invoke('save_file_dialog', {
      defaultName: `${filename}_edited.png`,
      ext: 'png',
    });
    if (!outputPath) return;
    busyToken = ++state.imageBusySeq;
    state.imageBusy = true;
    await renderEditedImage(outputPath, sourcePath, operations);
    print(`图片已另存为: ${outputPath.split(/[/\\]/).pop()}\n`, 'cmd-info');
    await refreshTree();
  } catch (error) {
    print(`保存图片失败: ${error}\n`, 'cmd-err');
  } finally {
    if (busyToken === state.imageBusySeq) state.imageBusy = false;
  }
}

function closeEditor() {
  state.fileOpenSeq += 1;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  $('#editor-panel').classList.add('hidden');
  state.activeFile = null;
  state.activeFileKind = 'text';
  state.imageOperations = [];
  state.content = '';
  state.original = '';
  $('#editor-filename').textContent = '';
  setEditorDocument('', []);
  $('#preview-image').removeAttribute('src');
  renderTree();
  updateStatus();
  focusInput();
}

async function saveFile() {
  if (!state.activeFile) {
    print('没有打开的文件\n', 'cmd-err');
    return;
  }
  if (state.activeFileKind !== 'text') {
    print('当前文件不能作为文本保存\n', 'cmd-err');
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
        echo('>>', '');
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

function bindTerminalPanel() {
  $('#btn-terminal-close')?.addEventListener('click', () => toggleTerminal(false));
}

function focusInput() {
  $('#cmd-input')?.focus();
}

function pushHistory(line) {
  if (!line.trim()) return;
  if (state.history.length > 500) state.history.shift();
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
  echo('>>', raw);
  if (!line) return;

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
      invoke('open_circuit_window', { path: arg || null })
        .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
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
    'cmd-info'
  );
}

async function doCd(path, silent = false) {
  try {
    const target = await invoke('shell_cd', { path });
    state.cwd = target;
    state.expanded.clear();
    if (!silent) print(`→ ${target}\n`, 'cmd-info');
    setTerminalCwdChip(target);
    syncTerminalCwd(target);
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
    // 非 .yt 文件：唤出内嵌终端，在真实环境中运行
    if (state.activeFileKind === 'image') {
      print('图片文件不能运行\n', 'cmd-info');
      return;
    }
    const name = state.activeFile.split(/[/\\]/).pop();
    await toggleTerminal(true);
    if (/\.py$/i.test(state.activeFile)) {
      const ok = injectLine(`python "${state.activeFile}"`);
      print(ok ? `已在终端中运行: ${name}\n` : `终端正忙，请手动运行: python "${name}"\n`, 'cmd-info');
    } else {
      print(`非 .yt 文件（${name}），请在终端中运行\n`, 'cmd-info');
    }
    return;
  }
  if (state.content !== state.original) await saveFile();
  await runFile(state.activeFile);
}

async function runFile(path) {
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
  $('#status-indicator').textContent = state.activeFile ? `编辑: ${state.activeFile.split(/[/\\]/).pop()}` : '就绪';
}

/* ---------------- 键盘快捷键 ---------------- */

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === '`') { e.preventDefault(); toggleTerminal(); }
  else if (k === 's') { e.preventDefault(); saveFile(); }
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