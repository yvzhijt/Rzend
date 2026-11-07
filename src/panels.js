/* 面板拖拽重排（VS Code 风）：主窗口与电路仿真窗口共用 */

export const MAIN_DOCKS = [
  { container: '#main-area', items: ['#folder-panel', '#workspace-panel'], axis: 'x', storage: 'rzend.dock.main' },
  { container: '#center-area', items: ['#editor-panel', '#bottom-stack'], axis: 'y', storage: 'rzend.dock.center' },
];

export const CIRC_DOCKS = [
  { container: '#circ-body', items: ['#circ-palette', '#circ-props'], axis: 'x', storage: 'rzend.dock.circ' },
];

const DRAG_THRESHOLD = 6;
let activeDrag = null;
let listenersBound = false;

export function bindPanelDrag(groups) {
  bindGlobalDragListeners();

  groups.forEach(({ container: containerSel, items, axis, storage }) => {
    const container = document.querySelector(containerSel);
    if (!container) return;
    const panels = items.map((selector) => container.querySelector(selector)).filter(Boolean);

    panels.forEach((panel) => {
      const handle = panel.querySelector('.panel-header, .cmd-header, #editor-toolbar');
      if (!handle) return;
      handle.classList.add('drag-handle');

      handle.addEventListener('pointerdown', (event) => {
        if (activeDrag || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
          return;
        }
        if (event.target.closest('button, input, textarea, select, a')) return;

        event.preventDefault();
        activeDrag = {
          panel,
          container,
          panels,
          axis,
          storage,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          started: false,
        };
      });
    });
  });
}

function bindGlobalDragListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('pointermove', moveActivePanel, { passive: false });
  document.addEventListener('pointerup', finishActivePanel);
  document.addEventListener('pointercancel', finishActivePanel);
  window.addEventListener('blur', finishActivePanel);
}

function moveActivePanel(event) {
  const drag = activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;

  if (!drag.started) {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.started = true;
    drag.panel.classList.add('dragging-panel');
    document.body.classList.add('dragging-move');
  }
  event.preventDefault();

  const axis = drag.axis;
  // 隐藏面板（尺寸为 0）无法成为交换目标，否则永远拖不动
  const visibleSize = (panel) => {
    const rect = panel.getBoundingClientRect();
    return axis === 'x' ? rect.width : rect.height;
  };
  const midOf = (panel) => {
    const rect = panel.getBoundingClientRect();
    return axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  };
  // 取离拖拽面板最近的可见面板作为交换目标
  let target = null;
  let bestDistance = Infinity;
  const dragMid = midOf(drag.panel);
  for (const candidate of drag.panels) {
    if (candidate === drag.panel || !candidate.isConnected || visibleSize(candidate) <= 1) continue;
    const distance = Math.abs(midOf(candidate) - dragMid);
    if (distance < bestDistance) {
      bestDistance = distance;
      target = candidate;
    }
  }
  if (!target) return;
  const panelRect = drag.panel.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const panelMid = axis === 'x'
    ? panelRect.left + panelRect.width / 2
    : panelRect.top + panelRect.height / 2;
  const targetMid = axis === 'x'
    ? targetRect.left + targetRect.width / 2
    : targetRect.top + targetRect.height / 2;
  const pointer = axis === 'x' ? event.clientX : event.clientY;
  const movingForward = panelMid < targetMid;
  const targetStart = axis === 'x' ? targetRect.left : targetRect.top;
  const targetEnd = axis === 'x' ? targetRect.right : targetRect.bottom;
  const entryThreshold = Math.min(12, (targetEnd - targetStart) * 0.04);
  const crossedTarget = movingForward
    ? pointer > targetStart + entryThreshold
    : pointer < targetEnd - entryThreshold;

  target.classList.toggle('dock-drop-target', crossedTarget);
  if (crossedTarget) {
    swapPanelSlots(drag.container, drag.panel, target);
    applyDockClasses(drag.panels);
  }
}

function finishActivePanel(event) {
  const drag = activeDrag;
  if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;

  drag.panel.classList.remove('dragging-panel');
  drag.panels.forEach((panel) => panel.classList.remove('dock-drop-target'));
  document.body.classList.remove('dragging-move');
  if (drag.started) {
    applyDockClasses(drag.panels);
    savePanelOrder(drag.storage, drag.panels);
  }
  activeDrag = null;
}

function swapPanelSlots(container, first, second) {
  if (first.parentElement !== container || second.parentElement !== container) return;
  const marker = document.createComment('panel-swap');
  container.replaceChild(marker, first);
  container.replaceChild(first, second);
  container.replaceChild(second, marker);
}

function orderedPanels(panels) {
  return panels
    .filter((panel) => panel.isConnected)
    .sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

export function applyDockClasses(panels) {
  const ordered = orderedPanels(panels);
  ordered.forEach((panel) => panel.classList.remove('dock-left', 'dock-right'));
  if (ordered.length === 0) return;
  ordered[0].classList.add('dock-left');
  ordered[ordered.length - 1].classList.add('dock-right');
}

export function savePanelOrder(storage, panels) {
  try {
    localStorage.setItem(storage, JSON.stringify(orderedPanels(panels).map((panel) => panel.id)));
  } catch (error) {
    console.warn(`无法保存面板顺序 ${storage}`, error);
  }
}

export function restorePanelOrder(groups) {
  groups.forEach(({ container: containerSel, items, storage }) => {
    const container = document.querySelector(containerSel);
    if (!container) return;
    const panels = items.map((selector) => container.querySelector(selector)).filter(Boolean);

    try {
      const raw = localStorage.getItem(storage);
      if (raw) {
        const savedIds = JSON.parse(raw);
        if (!Array.isArray(savedIds)) throw new TypeError('面板顺序格式无效');
        const savedOrder = savedIds
          .filter((id, index) => typeof id === 'string' && savedIds.indexOf(id) === index)
          .map((id) => panels.find((panel) => panel.id === id))
          .filter(Boolean);
        const order = [...savedOrder, ...panels.filter((panel) => !savedOrder.includes(panel))];
        const slots = panels
          .map((panel) => Array.prototype.indexOf.call(container.children, panel))
          .sort((a, b) => a - b);
        const children = Array.from(container.children);
        slots.forEach((slot, index) => {
          children[slot] = order[index];
        });
        children.forEach((child) => container.appendChild(child));
      }
    } catch (error) {
      console.warn(`无法恢复面板顺序 ${storage}`, error);
    }

    applyDockClasses(panels);
  });
}
