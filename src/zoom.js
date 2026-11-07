// 画布视口：滚轮缩放（0.5×–2×）+ 坐标换算。
// 通过 viewBox 实现缩放，鼠标坐标经 toWorld 反算到世界坐标，
// 保持接线/拖拽/命中逻辑全部使用世界坐标，无需改动几何计算。

export function createViewport() {
  const view = { x: 0, y: 0, w: 0, h: 0 };
  let svg = null;
  const BG_ID = 'circ-grid-bg';

  function apply() {
    if (!svg) return;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const bg = svg.querySelector(`#${BG_ID}`);
    if (bg) {
      bg.setAttribute('x', view.x);
      bg.setAttribute('y', view.y);
      bg.setAttribute('width', view.w);
      bg.setAttribute('height', view.h);
    }
  }

  function size() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 960, h: r.height || 640 };
  }

  // 屏幕坐标 → 世界坐标
  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    const vw = r.width || 1;
    const vh = r.height || 1;
    return {
      x: view.x + (e.clientX - r.left) / vw * view.w,
      y: view.y + (e.clientY - r.top) / vh * view.h,
    };
  }

  // 适配窗口：以 1:1（scale=1）铺满视口
  function init() {
    const s = size();
    view.x = 0;
    view.y = 0;
    view.w = s.w;
    view.h = s.h;
    apply();
  }

  // 以光标为锚点缩放，限制 scale 在 [0.5, 2]
  function zoomAt(clientX, clientY, factor) {
    const r = svg.getBoundingClientRect();
    const vw = r.width || 1;
    const vh = r.height || 1;
    const wx = view.x + (clientX - r.left) / vw * view.w;
    const wy = view.y + (clientY - r.top) / vh * view.h;
    let nw = view.w / factor;
    let nh = view.h / factor;
    const scale = vw / nw; // 水平 scale = 视口像素 / 世界宽度
    if (scale < 0.5) { nw = vw / 0.5; nh = vh / 0.5; }
    else if (scale > 2) { nw = vw / 2; nh = vh / 2; }
    view.w = nw;
    view.h = nh;
    view.x = wx - (clientX - r.left) / vw * view.w;
    view.y = wy - (clientY - r.top) / vh * view.h;
    apply();
  }

  // 窗口尺寸变化：保持当前缩放比例（可见世界区域随窗口大小变化，但不畸变）
  function onResize() {
    const s = size();
    if (view.w <= 0) { init(); return; }
    const scale = s.w / view.w;
    view.w = s.w / scale;
    view.h = s.h / scale;
    apply();
  }

  function setSvg(el) { svg = el; }

  return { view, setSvg, apply, toWorld, init, zoomAt, onResize };
}
