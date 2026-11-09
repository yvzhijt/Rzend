// 主界面：代码编辑器（CodeMirror 6）与文件操作
import { invoke } from '@tauri-apps/api/core';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { cpp, cppLanguage } from '@codemirror/lang-cpp';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { state, $, $$, print } from './common.js';
import {
  bindEditorOps, renderTree, updateStatus, focusInput,
} from './services.js';
import {
  applyImageCrop, applyImageResize, applyImageOperation,
  applyImageFilter, resetImageEdits, saveEditedImageAs, setImageDimensionInputs,
} from './image-tools.js';
import { confirmUnsavedChanges } from './dialogs.js';
import { ytLanguage } from './yt-language.js';
import { cCompletionSource } from './c-completions.js';

/* ---------------- CodeMirror 6 ---------------- */

let editorView = null;
let dirtyTimer = 0;

// C / C++：语法高亮 + 输入补全提示
const CPP_EXTENSIONS = [
  cpp(),
  cppLanguage.data.of({ autocomplete: cCompletionSource }),
];

const LANGUAGE_LABELS = {
  py: 'Python', pyw: 'Python', pyt: 'Python',
  c: 'C', h: 'C',
  cc: 'C++', cpp: 'C++', cxx: 'C++', hh: 'C++', hpp: 'C++', hxx: 'C++',
  yt: 'YTB',
};

function extensionOf(path) {
  return String(path).split('.').pop()?.toLowerCase() || '';
}

function languageForPath(path) {
  const ext = extensionOf(path);
  if (ext === 'py' || ext === 'pyw' || ext === 'pyt') return python();
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(ext)) return CPP_EXTENSIONS;
  if (ext === 'yt') return ytLanguage;
  return [];
}

function languageLabel(path) {
  return LANGUAGE_LABELS[extensionOf(path)] || 'Plain Text';
}

// CodeMirror 内部统一使用 \n；保存时按原文件的换行符还原
function detectEol(text) {
  const firstLf = text.indexOf('\n');
  return firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    fontSize: 'var(--editor-font-size, 14px)',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '10px 0', whiteSpace: 'pre' },
  '.cm-gutters': {
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
    borderRight: '1px solid var(--glass-line)',
    color: '#9aa4b2',
    backdropFilter: 'blur(8px)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(11, 107, 203, 0.1)', color: 'var(--text-dim)' },
  '.cm-activeLine': { backgroundColor: 'var(--accent-bg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#cfe4fb !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionMatch': { backgroundColor: '#d8ecff' },
  '.cm-searchMatch': { backgroundColor: '#fff1b8' },
  '.cm-panels': {
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    backdropFilter: 'blur(18px) saturate(160%)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    backdropFilter: 'blur(20px) saturate(170%)',
    boxShadow:
      'inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 16px 40px -12px rgba(15, 23, 42, 0.28)',
  },
  '.cm-tooltip-autocomplete': { overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--ui)',
    fontSize: '12.5px',
    maxHeight: '18em',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 8px', lineHeight: '1.45' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: '#fff',
  },
  '.cm-tooltip-autocomplete .cm-completionDetail': {
    marginLeft: '10px',
    color: 'var(--text-muted)',
    fontStyle: 'normal',
    fontSize: '11px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': {
    color: 'rgba(255, 255, 255, 0.72)',
  },
});

function setDirty(dirty) {
  state.dirty = dirty;
  const modified = $('#editor-modified');
  if (modified) modified.classList.toggle('hidden', !dirty);
}

function scheduleDirtyCheck() {
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = 0;
    if (!editorView || !state.originalDoc) return;
    setDirty(!editorView.state.doc.eq(state.originalDoc));
  }, 120);
}

function onEditorUpdate(update) {
  if (!update.docChanged) return;
  // 修改标记先立即出现；撤销回原内容后由防抖检查自动消除
  setDirty(true);
  scheduleDirtyCheck();
}

function createEditorState(doc, langExt) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      langExt || [],
      editorTheme,
      EditorView.updateListener.of(onEditorUpdate),
    ],
  });
}

// 重新创建 EditorState，而不是 dispatch 替换文档：
// 这样能清空撤销历史，避免 Ctrl+Z 把上一个文件的内容撤回到当前文件。
function setEditorDocument(text, langExt) {
  if (!editorView) return;
  editorView.setState(createEditorState(text, langExt));
}

function isPreviewableImage(path) {
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path);
}

export function hasUnsavedChanges() {
  return state.activeFileKind === 'text' && !!state.activeFile && state.dirty;
}

let discardPrompt = null;

function ensureDiscardable() {
  if (!hasUnsavedChanges()) return Promise.resolve(true);
  if (discardPrompt) return discardPrompt;
  discardPrompt = (async () => {
    const name = state.activeFile?.split(/[/\\]/).pop();
    const choice = await confirmUnsavedChanges(name);
    if (choice === 'cancel') return false;
    if (choice === 'save') return await saveFile();
    return true;
  })().finally(() => {
    discardPrompt = null;
  });
  return discardPrompt;
}

/* ---------------- 编辑器初始化 ---------------- */

export function bindEditor() {
  editorView = new EditorView({
    parent: $('#editor-host'),
    state: createEditorState('', []),
  });

  // 注册编辑器操作到 services 层，消除循环依赖
  bindEditorOps({
    openFile,
    closeEditor,
    saveFile,
    setEditorDocument,
    hasUnsavedChanges,
  });

  // 编辑器工具栏按钮
  $('#btn-save-file')?.addEventListener('click', saveFile);
  $('#btn-close-file')?.addEventListener('click', () => closeEditor());

  // 图片工具按钮（静态导入，不再动态 import）
  $('#image-crop-apply')?.addEventListener('click', applyImageCrop);
  $('#image-resize-apply')?.addEventListener('click', applyImageResize);
  $('#image-rotate-left')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_left' }));
  $('#image-rotate-right')?.addEventListener('click', () => applyImageOperation({ kind: 'rotate_right' }));
  $('#image-filter-apply')?.addEventListener('click', applyImageFilter);
  $('#image-reset')?.addEventListener('click', resetImageEdits);
  $('#image-save-as')?.addEventListener('click', saveEditedImageAs);
}

/* ---------------- 文件打开 / 关闭 / 保存 ---------------- */

export async function openFile(path) {
  // 独立仿真窗口不替换主编辑器，因此不需要触发未保存确认
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

  if (!(await ensureDiscardable())) return;

  const request = ++state.fileOpenSeq;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  $$('#image-tools button, #image-tools select, #image-tools input')
    .forEach((control) => { control.disabled = false; });

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
      state.eol = '\n';
      state.originalDoc = null;
      setDirty(false);
      setEditorDocument('', []);
      setImageDimensionInputs(preview.width, preview.height);

      const filename = $('#editor-filename');
      if (filename) {
        filename.textContent = path.split(/[/\\]/).pop();
        filename.title = path;
      }
      $('#editor-lang')?.classList.add('hidden');
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
      $('#split-editor')?.classList.remove('hidden');
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
    state.eol = detectEol(text);
    setEditorDocument(text, languageForPath(path));
    state.originalDoc = editorView.state.doc;
    setDirty(false);

    const host = $('#editor-host');
    if (host) host.classList.remove('hidden');
    $('#image-preview').classList.add('hidden');
    $('#preview-image').removeAttribute('src');
    const runBtn = $('#btn-run-file');
    if (runBtn) runBtn.classList.toggle('hidden', !/\.(yt|py|c|cc|cpp|cxx)$/i.test(path));
    const saveBtn = $('#btn-save-file');
    if (saveBtn) saveBtn.classList.remove('hidden');
    const filename = $('#editor-filename');
    if (filename) {
      filename.textContent = path.split(/[/\\]/).pop();
      filename.title = path;
    }
    const lang = $('#editor-lang');
    if (lang) {
      lang.textContent = languageLabel(path);
      lang.classList.remove('hidden');
    }
    const modified = $('#editor-modified');
    if (modified) modified.classList.add('hidden');
    const editorPanel = $('#editor-panel');
    if (editorPanel) editorPanel.classList.remove('hidden');
    $('#split-editor')?.classList.remove('hidden');
    renderTree();
    updateStatus();
    editorView?.focus();
  } catch (e) {
    print(`无法打开文件: ${e}\n`, 'cmd-err');
  }
}

export async function closeEditor(force = false) {
  if (!force && !(await ensureDiscardable())) return false;

  if (dirtyTimer) {
    clearTimeout(dirtyTimer);
    dirtyTimer = 0;
  }
  state.fileOpenSeq += 1;
  state.imageTransformSeq += 1;
  state.imageBusySeq += 1;
  state.imageBusy = false;
  state.activeFile = null;
  state.activeFileKind = 'text';
  state.imageOperations = [];
  state.content = '';
  state.original = '';
  state.eol = '\n';
  state.originalDoc = null;
  setDirty(false);

  const editorPanel = $('#editor-panel');
  if (editorPanel) editorPanel.classList.add('hidden');
  $('#split-editor')?.classList.add('hidden');
  $('#image-preview')?.classList.add('hidden');
  $('#editor-host')?.classList.remove('hidden');
  const filename = $('#editor-filename');
  if (filename) {
    filename.textContent = '';
    filename.removeAttribute('title');
  }
  const lang = $('#editor-lang');
  if (lang) {
    lang.textContent = '';
    lang.classList.add('hidden');
  }
  setEditorDocument('', []);
  $('#preview-image')?.removeAttribute('src');
  $('#btn-save-file')?.classList.remove('hidden');
  $('#btn-run-file')?.classList.remove('hidden');
  renderTree();
  updateStatus();
  focusInput();
  return true;
}

export async function saveFile() {
  if (!state.activeFile) {
    print('没有打开的文件\n', 'cmd-err');
    return false;
  }
  if (state.activeFileKind !== 'text') {
    print('当前文件不能作为文本保存\n', 'cmd-err');
    return false;
  }

  const path = state.activeFile;
  const content = editorView ? editorView.state.doc.toString() : state.content;
  const eol = state.eol === '\r\n' ? '\r\n' : '\n';
  const output = eol === '\n' ? content : content.replace(/\n/g, '\r\n');

  try {
    await invoke('write_file_content', { path, content: output });
    if (state.activeFile === path) {
      state.content = content;
      state.original = content;
      state.originalDoc = editorView?.state.doc ?? null;
      setDirty(false);
    }
    print(`已保存: ${path.split(/[/\\]/).pop()}\n`, 'cmd-info');
    return true;
  } catch (e) {
    print(`保存失败: ${e}\n`, 'cmd-err');
    return false;
  }
}
