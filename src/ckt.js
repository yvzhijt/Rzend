/* 电路仿真独立窗口入口（不共享主界面 cwd 与文件系统上下文） */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { initCircuit, openCircuit, openCircuitFile, getModel } from './circuit/editor.js';
import { initSignalGraph, switchToSignal, switchToCircuit, isSignalVisible, setSignalModel } from './circuit/signal.js';
import { CIRC_DOCKS, bindPanelDrag, restorePanelOrder } from './panels.js';

async function init() {
  restorePanelOrder(CIRC_DOCKS);
  bindPanelDrag(CIRC_DOCKS);
  // 电路窗口不使用终端 cwd：getCwd 返回空，文件一律走系统对话框
  initCircuit({ getCwd: () => '', refresh: () => {} });
  initSignalGraph();

  // 窗口可能是通过文件双击打开的：取出启动时挂起的文件路径
  let pending = null;
  try {
    pending = await invoke('take_circuit_pending');
  } catch (e) {
    console.error('take_circuit_pending failed', e);
  }
  if (pending) {
    await openCircuitFile(pending);
  } else {
    openCircuit();
  }
  // 将电路模型的 signalGraph 注入信号流图
  injectSignalGraph();

  // 窗口已存在时再次双击 .ckt：通过事件增量打开
  await listen('rzend:open-ckt', (e) => {
    if (typeof e.payload === 'string' && e.payload) {
      openCircuitFile(e.payload).then(() => injectSignalGraph());
    }
  });
}

function injectSignalGraph() {
  const model = getModel();
  if (model?.signalGraph) {
    setSignalModel(model.signalGraph);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => console.error(e));
});