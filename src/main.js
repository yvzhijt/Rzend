// 主界面入口：串联所有模块
import { invoke } from '@tauri-apps/api/core';
import { state, $, $$, print } from './common.js';
import { MAIN_DOCKS, bindPanelDrag, restorePanelOrder } from './panels.js';
import {
  bindFileTree, openFolderDialog, refreshTree, updateStatus,
  doCd, bindTerminalSync, bindTerminalOps, bindFocusInput, bindWorkspaceOps,
} from './services.js';
import { bindEditor, saveFile, closeEditor } from './editor-core.js';
import { bindCommandLine, focusInput } from './shell.js';
import { bindShellEvents } from './shell.js';
import { renderWorkspace, showPlot, bindRunButton } from './yt-runner.js';
import {
  toggleTerminal, injectLine, setOnTerminalCwd, setOnTerminalNotice,
  setTerminalCwdChip, syncTerminalCwd,
} from './terminal.js';

/* ---------------- Ribbon ---------------- */

function bindRibbon() {
  bindMenus();

  $('#mi-open-folder')?.addEventListener('click', openFolderDialog);
  $('#mi-save')?.addEventListener('click', saveFile);
  $('#mi-refresh')?.addEventListener('click', refreshTree);
  $('#mi-folder-up')?.addEventListener('click', () => doCd('..'));
  $('#mi-toggle-folder')?.addEventListener('click', () => toggleDockPanel('#folder-panel'));
  $('#mi-toggle-workspace')?.addEventListener('click', () => toggleDockPanel('#workspace-panel'));

  $('#mi-clear-cmd')?.addEventListener('click', () => {
    const out = $('#cmd-output');
    if (out) out.innerHTML = '';
    focusInput();
  });
  $('#mi-clear-ws')?.addEventListener('click', async () => {
    try {
      const vars = await invoke('yt_reset');
      renderWorkspace(vars);
      print('工作区已清空\n', 'cmd-info');
    } catch (e) {
      print(`清空工作区失败: ${e}\n`, 'cmd-err');
    }
  });
  $('#mi-terminal')?.addEventListener('click', () => toggleTerminal());

  $('#mi-circuit')?.addEventListener('click', () => {
    invoke('open_circuit_window', { path: null })
      .catch((e) => print(`打开电路仿真窗口失败: ${e}\n`, 'cmd-err'));
  });
  $('#mi-signal')?.addEventListener('click', () => {
    invoke('open_signal_window', { path: null })
      .catch((e) => print(`打开信号系统窗口失败: ${e}\n`, 'cmd-err'));
  });
}

function bindMenus() {
  const menus = $$('.menu');
  const closeAll = () => menus.forEach((menu) => menu.classList.remove('open'));
  const syncChecks = () => {
    $('#mi-toggle-folder')?.classList.toggle('checked', !$('#folder-panel')?.classList.contains('hidden'));
    $('#mi-toggle-workspace')?.classList.toggle('checked', !$('#workspace-panel')?.classList.contains('hidden'));
  };

  menus.forEach((menu) => {
    menu.querySelector('.menu-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      closeAll();
      if (willOpen) {
        menu.classList.add('open');
        syncChecks();
      }
    });
    menu.addEventListener('mouseenter', () => {
      if (menus.some((item) => item.classList.contains('open'))) {
        closeAll();
        menu.classList.add('open');
        syncChecks();
      }
    });
  });

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
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
}

/* ---------------- 终端面板按钮 ---------------- */

function bindTerminalPanel() {
  $('#btn-terminal-close')?.addEventListener('click', () => toggleTerminal(false));
  $('#btn-cmd-switch')?.addEventListener('click', () => toggleTerminal(false));
  $('#btn-terminal-switch')?.addEventListener('click', () => toggleTerminal(true));
}

/* ---------------- 初始化 ---------------- */

async function init() {
  // 注册跨模块操作（消除循环依赖的关键）
  bindTerminalSync(syncTerminalCwd, setTerminalCwdChip);
  bindTerminalOps({ toggleTerminal, injectLine });
  bindFocusInput(focusInput);
  bindWorkspaceOps({ renderWorkspace, showPlot });

  bindRibbon();
  bindFileTree();
  bindEditor();
  bindRunButton();
  bindCommandLine();
  bindTerminalPanel();
  bindSplitters();
  bindShellEvents();
  restorePanelOrder(MAIN_DOCKS);
  bindPanelDrag(MAIN_DOCKS);

  // 终端 → 应用：cwd 变化时同步
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
    if (input) input.value = 'ni ';
    focusInput();
  }
  else if (k === 'w') { e.preventDefault(); closeEditor(); }
});

window.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => console.error(e));
});
