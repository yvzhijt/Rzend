// 主界面：图片编辑工具（裁剪、缩放、旋转、滤镜）
import { invoke } from '@tauri-apps/api/core';
import { state, $, $$, print } from './common.js';
import { setImageDimensionInputs } from './editor-core.js';
import { refreshTree } from './services.js';

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
    const info = $('#preview-image-info');
    if (info) info.textContent = `${result.width} × ${result.height}`;
    setImageDimensionInputs(result.width, result.height);
  }
  return result;
}

export async function applyImageOperation(operation) {
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

export async function applyImageCrop() {
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

export async function applyImageResize() {
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

export async function applyImageFilter() {
  const kind = $('#image-filter').value;
  if (!kind) {
    print('请先选择滤镜\n', 'cmd-err');
    return;
  }
  await applyImageOperation({ kind });
  $('#image-filter').value = '';
}

export async function resetImageEdits() {
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
    const info = $('#preview-image-info');
    if (info) info.textContent = `${preview.width} × ${preview.height}`;
    setImageDimensionInputs(preview.width, preview.height);
    print('已重置图片编辑\n', 'cmd-info');
  } catch (error) {
    print(`重置图片失败: ${error}\n`, 'cmd-err');
  } finally {
    if (busyToken === state.imageBusySeq) state.imageBusy = false;
  }
}

export async function saveEditedImageAs() {
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
