// 主界面：轻量对话框（未保存更改确认）
import { $ } from './common.js';

let pendingResolve = null;
let pendingPromise = null;

function finish(choice) {
  const dialog = $('#unsaved-dialog');
  if (dialog?.open) dialog.close();
  const resolve = pendingResolve;
  pendingResolve = null;
  pendingPromise = null;
  resolve?.(choice);
}

function bindOnce() {
  const dialog = $('#unsaved-dialog');
  if (!dialog || dialog.dataset.bound === '1') return;
  dialog.dataset.bound = '1';

  // Esc 等同“取消”，点击遮罩也一样
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish('cancel');
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) finish('cancel');
  });

  $('#unsaved-cancel')?.addEventListener('click', () => finish('cancel'));
  $('#unsaved-discard')?.addEventListener('click', () => finish('discard'));
  $('#unsaved-save')?.addEventListener('click', () => finish('save'));
}

/**
 * 询问是否保存当前文件。
 * @param {string} [fileName] 显示在提示里的文件名
 * @returns {Promise<'save'|'discard'|'cancel'>}
 */
export function confirmUnsavedChanges(fileName) {
  const dialog = $('#unsaved-dialog');
  if (!dialog) {
    // 极端兜底：没有对话框元素时退回原生确认框
    return Promise.resolve(window.confirm('当前文件有未保存的更改，是否保存？') ? 'save' : 'discard');
  }

  bindOnce();
  if (pendingPromise) return pendingPromise;

  const message = $('#unsaved-message');
  if (message) {
    const name = fileName ? `「${fileName}」` : '当前文件';
    message.textContent = `${name}有未保存的更改。关闭后这些更改将丢失。`;
  }

  pendingPromise = new Promise((resolve) => {
    pendingResolve = resolve;
  });
  if (!dialog.open) dialog.showModal();
  return pendingPromise;
}
