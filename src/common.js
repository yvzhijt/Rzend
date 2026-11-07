// 主界面：全局状态与共享辅助函数（所有模块的公共基础层）
export const state = {
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

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

export function print(text, cls = 'cmd-result') {
  const out = $('#cmd-output');
  if (!out) return;
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  out.appendChild(span);
  const scroll = $('#cmd-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

export function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
