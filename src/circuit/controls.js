// 电路仿真画布：元件调色板、工具栏、保存/打开
import { invoke } from '@tauri-apps/api/core';
import { C, status, basename, callCloseCircuit, callOpenCircuitFile } from './ui.js';
import {
  ELEMENTS, createComponent, normalizeRot,
  snapGrid, simulate,
} from './model.js';
import { defaultCircuit, deserializeCircuit, serializeCircuit } from './format.js';
import { closeFigure, fmtTime, showFigure } from '../figure.js';
import { componentById } from './geom.js';
import { pausePower, togglePower, cycleSpeed, hideElementMenu, updateModelSettings } from './power.js';
import { render } from './render.js';
import { cancelPending, removeComponentFromNets } from './interact.js';

/* ---------------- 调色板 ---------------- */

export function buildPalette() {
  const list = document.querySelector('#circ-palette-list');
  const input = document.querySelector('#circ-search');
  if (!list || !input) return;

  const collapsedGroups = new Set(
    Object.values(ELEMENTS).map((def) => def.group || '其他'),
  );
  const renderList = (query) => {
    const key = query.trim().toLowerCase();
    const items = Object.entries(ELEMENTS).filter(([type, def]) => {
      if (!key) return true;
      const hay = `${def.cn} ${def.en} ${def.group} ${type}`.toLowerCase();
      return hay.includes(key);
    });
    if (!items.length) {
      list.innerHTML = '<div class="comp-empty">没有匹配的元件</div>';
      return;
    }
    const groups = new Map();
    items.forEach(([type, def]) => {
      const g = def.group || '其他';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([type, def]);
    });
    list.innerHTML = [...groups].map(([group, rows]) => {
      const collapsed = !key && collapsedGroups.has(group);
      return `
        <section class="comp-group-section">
          <button class="comp-group" type="button" aria-expanded="${!collapsed}">
            <span class="comp-group-arrow">${collapsed ? '▸' : '▾'}</span>
            <span>${group}</span>
            <span class="comp-group-count">${rows.length}</span>
          </button>
          <div class="comp-group-items${collapsed ? ' hidden' : ''}">
            ${rows.map(([type, def]) => `
              <div class="comp-item" data-type="${type}">
                <span class="palette-bar" style="background:${def.color}"></span>
                <span class="comp-name">${def.cn}</span>
                <span class="comp-en">${def.en}</span>
              </div>`).join('')}
          </div>
        </section>`;
    }).join('');
    list.querySelectorAll('.comp-group').forEach((button) => {
      button.addEventListener('click', () => {
        const group = button.querySelector('span:nth-child(2)').textContent;
        if (collapsedGroups.has(group)) collapsedGroups.delete(group);
        else collapsedGroups.add(group);
        renderList(input.value);
      });
    });
    list.querySelectorAll('.comp-item').forEach((item) => {
      item.addEventListener('click', () => addElement(item.dataset.type));
    });
  };

  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const first = list.querySelector('.comp-item');
    if (first) addElement(first.dataset.type);
  });
  renderList('');
}

export function addElement(type) {
  if (!C.model) return;
  pausePower();
  const n = C.model.components.length;
  // 新元件默认落在格点上：横向 144、纵向 132（都是 12 的倍数），引脚随之对齐网格
  const c = createComponent(
    type,
    snapGrid(66 + (n % 4) * 144),
    snapGrid(66 + Math.floor(n / 4) * 132),
  );
  C.model.components.push(c);
  C.sel = { kind: 'el', id: c.id };
  render();
  status(`已添加 ${ELEMENTS[type].cn}`);
}

/* ---------------- 工具栏 ---------------- */

export function bindToolbar() {
  document.querySelector('#circ-run')?.addEventListener('click', runCircuit);
  document.querySelector('#circ-power')?.addEventListener('click', togglePower);
  document.querySelector('#circ-speed')?.addEventListener('click', cycleSpeed);
  document.querySelector('#circ-clear')?.addEventListener('click', () => {
    if (!C.model) return;
    pausePower();
    C.model.components = [];
    C.model.nets = [];
    C.sel = null;
    cancelPending();
    C.readings = new Map();
    render();
    status('已清空');
  });
  document.querySelector('#circ-save')?.addEventListener('click', () => saveCircuit(false));
  document.querySelector('#circ-save-as')?.addEventListener('click', () => saveCircuit(true));
  document.querySelector('#circ-open')?.addEventListener('click', openCircuitDialog);
  document.querySelector('#circ-close')?.addEventListener('click', () => {
    callCloseCircuit();
  });
  document.querySelector('#scope-close')?.addEventListener('click', () => {
    document.querySelector('#scope-window')?.classList.add('hidden');
  });
  document.querySelector('#circ-duration')?.addEventListener('change', updateModelSettings);
  document.querySelector('#circ-dt')?.addEventListener('change', updateModelSettings);
  const contextMenu = document.querySelector('#circ-context-menu');
  contextMenu?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const target = componentById(C.contextTarget);
    hideElementMenu();
    if (!target || !action) return;
    if (action === 'edit') {
      C.sel = { kind: 'el', id: target.id };
      render();
      document.querySelector('#circ-props-body input')?.focus();
    } else if (action === 'rotate') {
      pausePower();
      target.rot = normalizeRot((target.rot || 0) + 90);
      C.sel = { kind: 'el', id: target.id };
      render();
      status(`${ELEMENTS[target.type].cn} 旋转至 ${target.rot}°`);
    } else if (action === 'delete') {
      pausePower();
      C.model.components = C.model.components.filter((c) => c.id !== target.id);
      removeComponentFromNets(target.id);
      C.readings.delete(target.id);
      C.sel = null;
      render();
      status(`已删除 ${ELEMENTS[target.type].cn}`);
    }
    C.contextTarget = null;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu?.contains(event.target)) hideElementMenu();
  });
}

export function runCircuit() {
  if (!C.model) return;
  pausePower(); // 切回批量瞬态模式：先断电
  updateModelSettings();
  try {
    const t0 = performance.now();
    const res = simulate(C.model);
    const ms = Math.round(performance.now() - t0);
    C.readings = res.readings;
    render();
    if (res.probes.length) {
      showFigure({
        title: '示波器',
        subtitle: `0 – ${fmtTime(res.duration)} · ${res.dt} s/步`,
        series: res.probes,
      });
      status(`电路仿真完成 ${ms} ms，${res.probes.length} 路探针`);
    } else {
      status(`电路仿真完成 ${ms} ms（未放置示波器探针，仅更新表读数）`);
    }
  } catch (e) {
    status(String(e.message || e), true);
  }
}

/* ---------------- 保存 / 打开 ---------------- */

export async function saveCircuit(asNew = false) {
  if (!C.model) return;
  try {
    let path = asNew ? '' : C.path;
    if (!path) {
      path = await pickCircuitPath();
      if (!path) {
        status('已取消保存');
        return;
      }
    }
    await invoke('write_file_content', {
      path, content: JSON.stringify(serializeCircuit(C.model), null, 2),
    });
    C.path = path;
    status(`已保存 ${basename(path)}`);
    C.opts.refresh?.();
  } catch (e) {
    status(`保存失败: ${e}`, true);
  }
}

// 另存为：系统保存对话框选路径与文件名，并统一补齐 .ckt 后缀
async function pickCircuitPath() {
  const cwd = String(C.opts.getCwd?.() || '.').replace(/\\/g, '/');
  const suggested = C.path ? basename(C.path) : 'circuit.ckt';
  const chosen = await invoke('save_file_dialog', { defaultName: suggested, ext: 'ckt' });
  let p = String(chosen || '').trim().replace(/\\/g, '/');
  if (!p) return '';
  if (!/\.ckt$/i.test(p)) {
    // 已有其他扩展名就替换掉，没有就补上，保证始终是 .ckt
    p = /\.[a-z0-9]{1,5}$/i.test(p) ? p.replace(/\.[^./]+$/, '.ckt') : `${p}.ckt`;
  }
  // 对话框只返回文件名时，落到当前工作目录
  if (!/[:/]/.test(p)) p = `${cwd}/${p}`;
  return p;
}

// 通过系统文件选择器打开任意路径的 .ckt（不依赖终端 cwd）
export async function openCircuitDialog() {
  try {
    const path = await invoke('open_file_dialog', { ext: 'ckt' });
    if (!path) {
      status('已取消打开');
      return;
    }
    callOpenCircuitFile(path);
  } catch (e) {
    status(`打开失败: ${e}`, true);
  }
}