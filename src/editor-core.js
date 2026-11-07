// 主界面：代码编辑器（CodeMirror 6）与文件操作
import { invoke } from '@tauri-apps/api/core';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { state, $, $$, print } from './common.js';
import {
  bindEditorOps, renderTree, updateStatus, focusInput,
} from './services.js';
import {
  applyImageCrop, applyImageResize, applyImageOperation,
  applyImageFilter, resetImageEdits, saveEditedImageAs,
} from './image-tools.js';

/* ---------------- CodeMirror 6 ---------------- */

let editorView = null;
const languageCompartment = new Compartment();

function languageForPath(path) {
  const ext = String(path).split('.').pop()?.toLowerCase() || '';
  if (ext === 'py' || ext === 'pyw') return python();
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(ext)) return cpp();
  return [];
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '15.6px', lineHeight: '1.5' },
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

function isPreviewableImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path);
}

/* ---------------- 编辑器初始化 ---------------- */

export function bindEditor() {
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
            const modified = $('#editor-modified');
            if (modified) modified.classList.toggle('hidden', state.content === state.original);
          }
        }),
      ],
    }),
  });

  // 注册编辑器操作到 services 层，消除循环依赖
  bindEditorOps({ openFile, closeEditor, saveFile, setEditorDocument });

  // 编辑器工具栏按钮
  $('#btn-save-file')?.addEventListener('click', saveFile);
  $('#btn-close-file')?.addEventListener('click', closeEditor);

  // 图片工具按钮（静态导入，不再动态 import）
  $('#image-crop-apply')?.addEventListener('click', applyImageCrop);
  $('#image-resize-apply')?.addEventListener('click', applyImageResize);
  $('#image-rotate-left')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_left' }));
  $('#image-rotate-right')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_right' }));
  $('#image-filter-apply')?.addEventListener('click', applyImageFilter);
  $('#image-reset')?.addEventListener('click', resetImageEdits);
  $('#image-save-as')?.addEventListener('click', saveEditedImageAs);
}

/* ---------------- 图片尺寸输入 ---------------- */

export function setImageDimensionInputs(width, height) {
  const inputs = {
    '#image-crop-x': '0', '#image-crop-y': '0',
    '#image-crop-width': String(width), '#image-crop-height': String(height),
    '#image-resize-width': String(width), '#image-resize-height': String(height),
  };
  Object.entries(inputs).forEach(([sel, val]) => {
    const el = $(sel);
    if (el) el.value = val;
  });
}

/* ---------------- 文件打开 / 关闭 / 保存 ---------------- */

export async function openFile(path) {
  const request = ++state.fileOpenSeq;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  $$('#image-tools button, #image-tools select, #image-tools input')
    .forEach((control) => { control.disabled = false; });
  if (/\.ckt$/i.test(path)) {
    invoke('open_circuit_window', { path })
      .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
    return;
  }
  if (/\.sig$/i.test(path)) {
    invoke('open_signal_window', { path })
      .catch((e) => print(`打开信号系统窗口失败: ${e}\n`, 'cmd-err'));
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
      const filename = $('#editor-filename');
      if (filename) filename.textContent = path.split(/[/\\]/).pop();
      const modified = $('#editor-modified');
      if (modified) modified.classList.add('hidden');
      const host = $('#editor-host');
      if (host) host.classList.add('hidden');
      const runBtn = $('#btn-run-file');
      if (runBtn) runBtn.classList.add('hidden');
      const saveBtn = $('#btn-save-file');
      if (saveBtn) saveBtn.classList.add('hidden');
      const previewContainer = $('#image-preview');
      const image = $('#preview-image');
      image.src = preview.data_url;
      image.alt = path.split(/[/\\]/).pop();
      const info = $('#preview-image-info');
      if (info) info.textContent = `${preview.width} × ${preview.height}`;
      image.onerror = () => {
        const errInfo = $('#preview-image-info');
        if (errInfo) errInfo.textContent = '图片预览加载失败';
      };
      previewContainer.classList.remove('hidden');
      const editorPanel = $('#editor-panel');
      if (editorPanel) editorPanel.classList.remove('hidden');
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
    const host = $('#editor-host');
    if (host) host.classList.remove('hidden');
    $('#image-preview').classList.add('hidden');
    $('#preview-image').removeAttribute('src');
    const runBtn = $('#btn-run-file');
    if (runBtn) runBtn.classList.remove('hidden');
    const saveBtn = $('#btn-save-file');
    if (saveBtn) saveBtn.classList.remove('hidden');
    const filename = $('#editor-filename');
    if (filename) filename.textContent = path.split(/[/\\]/).pop();
    const modified = $('#editor-modified');
    if (modified) modified.classList.add('hidden');
    const editorPanel = $('#editor-panel');
    if (editorPanel) editorPanel.classList.remove('hidden');
    renderTree();
    updateStatus();
    editorView?.focus();
  } catch (e) {
    print(`无法打开文件: ${e}\n`, 'cmd-err');
  }
}

export function closeEditor() {
  state.fileOpenSeq += 1;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  const editorPanel = $('#editor-panel');
  if (editorPanel) editorPanel.classList.add('hidden');
  state.activeFile = null;
  state.activeFileKind = 'text';
  state.imageOperations = [];
  state.content = '';
  state.original = '';
  const filename = $('#editor-filename');
  if (filename) filename.textContent = '';
  setEditorDocument('', []);
  $('#preview-image').removeAttribute('src');
  renderTree();
  updateStatus();
  focusInput();
}

export async function saveFile() {
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
    const modified = $('#editor-modified');
    if (modified) modified.classList.add('hidden');
    print(`已保存: ${state.activeFile.split(/[/\\]/).pop()}\n`, 'cmd-info');
  } catch (e) {
    print(`保存失败: ${e}\n`, 'cmd-err');
  }
}
