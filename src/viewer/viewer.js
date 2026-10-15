import * as pdfjs from '../lib/pdf.mjs';
import { api, loadSettings, saveSettings, onSettingsChanged, allThemes, findTheme, isDark, isOriginal, mix } from '../shared/themes.js';
import { findImageRects, protectedRects, paintThemed } from './recolor.js';
import { exportThemedPdf, themedFileName } from './export.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.mjs', import.meta.url).href;

const CSS_UNITS = 96 / 72;
const MAX_CANVAS_PIXELS = 16_000_000;
const KEEP_RENDERED = 8;
const MIN_SCALE = 0.25, MAX_SCALE = 5;
const $ = (id) => document.getElementById(id);
const main = $('viewer');
const pagesEl = $('pages');

const state = {
  settings: null,
  theme: null,
  pdf: null,
  pages: [],
  visible: new Set(),
  scale: 1,
  zoom: 'auto',
  current: 1,
  url: null,
  name: 'document.pdf',
  search: { query: '', matches: [], index: -1, reveal: false },
};

/* ---------- Theme & chrome ---------- */

function applyChrome() {
  const t = state.theme;
  const plain = isOriginal(t);
  const dark = !plain && isDark(t);
  const s = document.documentElement.style;
  const surface = dark ? mix(t.bg, t.fg, 0.07) : plain ? '#ffffff' : mix(t.bg, '#ffffff', 0.45);
  const vars = {
    '--page': t.bg,
    '--ink': plain ? '#1d1d1f' : t.fg,
    '--app': plain ? '#e9e9ec' : dark ? mix(t.bg, '#000000', 0.35) : mix(t.bg, '#000000', 0.07),
    '--surface': surface,
    '--chrome': surface + 'd9',
    '--line': dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)',
    '--muted': (plain ? '#1d1d1f' : t.fg) + '99',
    '--hover': dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
    '--accent': dark ? mix(t.fg, '#d9a35b', 0.7) : '#9a6a2f',
    '--accent-ink': dark ? '#1a1408' : '#ffffff',
  };
  for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
  s.colorScheme = dark ? 'dark' : 'light';
  $('themeName').textContent = t.name;
}

function setTheme(id) {
  state.theme = findTheme(state.settings, id);
  state.settings.themeId = id;
  saveSettings({ themeId: id });
  refreshTheme();
}

function refreshTheme() {
  applyChrome();
  renderSwatches();
  repaintAll();
}

let repaintFrame = 0;
function repaintAll() {
  cancelAnimationFrame(repaintFrame);
  repaintFrame = requestAnimationFrame(() => {
    const rendered = state.pages.filter((p) => p.source);
    rendered.sort((a, b) => Math.abs(a.num - state.current) - Math.abs(b.num - state.current));
    for (const p of rendered) paintPage(p);
  });
}

function paintPage(p) {
  if (isOriginal(state.theme)) return p.ctx.putImageData(p.source, 0, 0);
  const rects = protectedRects(p.userRects, p.view, state.settings).map((r) => {
    const [x0, y0, x1, y1] = p.viewport.convertToViewportRectangle(r).map((v) => v * p.ratio);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  });
  paintThemed(p.ctx, p.source, state.theme, rects, state.settings.imageBrightness);
}

function swatch(theme, { active, removable, onPick, onRemove }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch' + (active ? ' active' : '');
  b.title = theme.name;
  b.innerHTML = `<span class="chip">Aa</span><span class="label"></span>`;
  b.querySelector('.chip').style.cssText = `background:${theme.bg};color:${theme.fg}`;
  b.querySelector('.label').textContent = theme.name;
  b.addEventListener('click', () => onPick(theme));
  if (removable) {
    const x = document.createElement('span');
    x.className = 'remove';
    x.textContent = '×';
    x.title = 'Delete theme';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(theme); });
    b.append(x);
  }
  return b;
}

function renderSwatches() {
  const saved = new Set(state.settings.customThemes.map((t) => t.id));
  $('swatches').replaceChildren(...allThemes(state.settings).map((t) => swatch(t, {
    active: t.id === state.theme.id,
    removable: saved.has(t.id),
    onPick: (theme) => setTheme(theme.id),
    onRemove: (theme) => {
      const customThemes = state.settings.customThemes.filter((x) => x.id !== theme.id);
      state.settings.customThemes = customThemes;
      saveSettings({ customThemes });
      if (state.theme.id === theme.id) setTheme('dark');
      else renderSwatches();
    },
  })));
  const { bg, fg } = state.settings.custom;
  $('customBg').value = bg;
  $('customFg').value = fg;
  $('customPreview').style.cssText = `background:${bg};color:${fg}`;
}

function syncImageControls() {
  const s = state.settings;
  $('keepImages').checked = !s.recolorImages;
  $('scannedAsText').checked = s.scannedAsText;
  $('imageBrightness').value = Math.round(s.imageBrightness * 100);
  $('imageBrightnessValue').textContent = `${Math.round(s.imageBrightness * 100)}%`;
  $('imageBrightness').disabled = s.recolorImages;
}

function updateImageSetting(patch) {
  Object.assign(state.settings, patch);
  saveSettings(patch);
  syncImageControls();
  repaintAll();
}

let customSaveTimer = 0;
function editCustom() {
  const custom = { bg: $('customBg').value, fg: $('customFg').value };
  state.settings.custom = custom;
  state.settings.themeId = 'custom';
  state.theme = findTheme(state.settings, 'custom');
  $('customPreview').style.cssText = `background:${custom.bg};color:${custom.fg}`;
  applyChrome();
  repaintAll();
  clearTimeout(customSaveTimer);
  customSaveTimer = setTimeout(() => {
    saveSettings({ custom, themeId: 'custom' });
    renderSwatches();
  }, 250);
}

function saveCustom() {
  const name = $('customName').value.trim() || `Custom ${state.settings.customThemes.length + 1}`;
  const theme = { id: `saved-${Date.now().toString(36)}`, name, bg: $('customBg').value, fg: $('customFg').value };
  state.settings.customThemes = [...state.settings.customThemes, theme];
  saveSettings({ customThemes: state.settings.customThemes });
  $('customName').value = '';
  setTheme(theme.id);
  toast(`Saved “${name}”`);
}

function onExternalSettings(patch) {
  const before = state.settings;
  state.settings = { ...before, ...patch };
  const next = findTheme(state.settings);
  const themeChanged = next.id !== state.theme.id || next.bg !== state.theme.bg || next.fg !== state.theme.fg;
  const imagesChanged = ['recolorImages', 'imageBrightness', 'scannedAsText'].some((k) => k in patch && patch[k] !== before[k]);
  if (themeChanged) state.theme = next;
  if (themeChanged || 'customThemes' in patch) { applyChrome(); renderSwatches(); }
  if (imagesChanged) syncImageControls();
  if (themeChanged || imagesChanged) repaintAll();
}

/* ---------- Document loading ---------- */

function fileParam() {
  const q = location.search;
  if (!q.startsWith('?file=')) return null;
  const raw = q.slice(6);
  return /^[a-z]+%3A/i.test(raw) ? decodeURIComponent(raw) : raw;
}

function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

async function open(params, { url = null, name }) {
  closeDocument();
  state.url = url;
  state.name = name;
  $('docTitle').textContent = name;
  document.title = name;
  $('empty').hidden = true;
  setLoader(0);

  const task = pdfjs.getDocument({
    ...params,
    isEvalSupported: false,
    cMapUrl: new URL('../lib/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../lib/standard_fonts/', import.meta.url).href,
  });
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) task.destroy();
    else update(pw);
  };
  task.onProgress = ({ loaded, total }) => setLoader(total ? loaded / total : null);

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    setLoader(false);
    if (err?.name !== 'PasswordException' && !/destroyed/i.test(err?.message ?? '')) showEmpty(`Couldn't open this PDF. ${err?.message ?? ''}`);
    else showEmpty();
    return;
  }
  state.pdf = pdf;
  setLoader(false);
  $('viewOriginal').disabled = !url;

  pdf.getMetadata().then(({ info }) => {
    const title = info?.Title?.trim();
    if (title && title.length > 2 && pdf === state.pdf) {
      $('docTitle').textContent = title;
      document.title = title;
    }
  }).catch(() => {});

  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  state.pages = Array.from({ length: pdf.numPages }, (_, i) => createPage(i + 1, vp.width, vp.height));
  state.pages[0].pdfPage = first;
  $('pageCount').textContent = pdf.numPages;

  const saved = readPosition();
  state.zoom = saved?.zoom ?? 'auto';
  state.scale = resolveScale(state.zoom);
  layoutPages();
  updateZoomLabel();
  if (saved?.page > 1) scrollToPage(saved.page);
  updateCurrentPage();
  main.focus({ preventScroll: true });
  loadPageSizes(pdf);
  loadOutline(pdf);
}

function closeDocument() {
  for (const p of state.pages) releasePage(p);
  observer.disconnect();
  pagesEl.replaceChildren();
  state.pages = [];
  state.visible.clear();
  state.search = { query: state.search.query, matches: [], index: -1, reveal: false };
  updateSearchCount();
  state.pdf?.destroy();
  state.pdf = null;
  $('outline').replaceChildren();
}

function showEmpty(error = '') {
  $('empty').hidden = false;
  $('emptyError').textContent = error;
  $('docTitle').textContent = 'Lumen PDF';
}

async function openFile(file) {
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  history.replaceState(null, '', location.pathname);
  open({ data }, { name: file.name });
}

function setLoader(progress) {
  const el = $('loader');
  el.hidden = progress === false;
  el.classList.toggle('indeterminate', progress === null);
  if (typeof progress === 'number') $('loaderFill').style.width = `${Math.max(8, progress * 100)}%`;
}

function askPassword(incorrect) {
  const dialog = $('passwordDialog');
  $('passwordHint').textContent = incorrect ? 'That password was incorrect. Try again.' : 'Enter the password to open this PDF.';
  $('passwordInput').value = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? $('passwordInput').value : null), { once: true });
  });
}

async function loadPageSizes(pdf) {
  let changed = false;
  for (let i = 1; i < state.pages.length; i++) {
    if (pdf !== state.pdf) return;
    const p = state.pages[i];
    p.pdfPage ??= await pdf.getPage(p.num);
    const vp = p.pdfPage.getViewport({ scale: 1 });
    if (vp.width !== p.w || vp.height !== p.h) {
      p.w = vp.width;
      p.h = vp.height;
      changed = true;
    }
    if (changed && (i % 40 === 0 || i === state.pages.length - 1)) {
      const anchor = captureAnchor();
      layoutPages();
      restoreAnchor(anchor);
      changed = false;
    }
  }
}

/* ---------- Layout & rendering ---------- */

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const num = Number(e.target.dataset.page);
    if (e.isIntersecting) state.visible.add(num);
    else state.visible.delete(num);
  }
  scheduleRender();
}, { root: main, rootMargin: '60% 0px' });

function createPage(num, w, h) {
  const div = document.createElement('div');
  div.className = 'page pending';
  div.dataset.page = num;
  pagesEl.append(div);
  observer.observe(div);
  return { num, w, h, div, top: 0, cw: 0, ch: 0, pdfPage: null, canvas: null, ctx: null, source: null, renderedScale: null, task: null };
}

function layoutPages() {
  const k = state.scale * CSS_UNITS;
  for (const p of state.pages) {
    p.cw = Math.floor(p.w * k);
    p.ch = Math.floor(p.h * k);
    p.div.style.width = `${p.cw}px`;
    p.div.style.height = `${p.ch}px`;
    p.div.style.setProperty('--scale-factor', k);
  }
  for (const p of state.pages) p.top = p.div.offsetTop;
}

function resolveScale(zoom) {
  if (typeof zoom === 'number') return clampScale(zoom);
  const p = state.pages[state.current - 1] ?? state.pages[0];
  if (!p) return 1;
  const width = (main.clientWidth - 40) / (p.w * CSS_UNITS);
  const height = (main.clientHeight - 36) / (p.h * CSS_UNITS);
  if (zoom === 'page-width') return clampScale(width);
  if (zoom === 'page-fit') return clampScale(Math.min(width, height));
  return clampScale(p.w > p.h ? Math.min(width, height) : Math.min(1.25, width));
}

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

function setZoom(zoom, point) {
  if (!state.pages.length) return;
  const scale = resolveScale(zoom);
  state.zoom = zoom;
  updateZoomLabel();
  if (Math.abs(scale - state.scale) < 1e-4) return;
  const anchor = captureAnchor(point);
  state.scale = scale;
  for (const p of state.pages) p.task?.cancel();
  layoutPages();
  restoreAnchor(anchor);
  scheduleRender(140);
  savePosition();
}

function updateZoomLabel() {
  $('zoomLabel').textContent = `${Math.round(state.scale * 100)}%`;
}

function pageAt(y) {
  const pages = state.pages;
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return pages[lo];
}

function captureAnchor(point = { x: main.clientWidth / 2, y: 0 }) {
  if (!state.pages.length) return null;
  const y = main.scrollTop + point.y;
  const p = pageAt(y);
  return {
    p, point,
    fy: (y - p.top) / p.ch,
    fx: (main.scrollLeft + point.x - p.div.offsetLeft) / p.cw,
  };
}

function restoreAnchor(a) {
  if (!a) return;
  main.scrollTop = a.p.top + a.fy * a.p.ch - a.point.y;
  main.scrollLeft = a.p.div.offsetLeft + a.fx * a.p.cw - a.point.x;
}

function scrollToPage(num, fy = 0) {
  const p = state.pages[Math.min(Math.max(num, 1), state.pages.length) - 1];
  if (!p) return;
  main.scrollTop = fy ? p.top + fy * p.ch - 40 : p.top - 12;
  updateCurrentPage();
}

let renderTimer = 0;
function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(pump, delay);
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let p;
    while ((p = nextToRender())) {
      try {
        await renderPage(p);
      } catch (err) {
        console.error(`Page ${p.num} failed to render`, err);
        p.renderedScale = state.scale;
      }
    }
  } finally {
    pumping = false;
  }
  evict();
}

function nextToRender() {
  const stale = (p) => p.renderedScale !== state.scale;
  const nums = [...state.visible].sort((a, b) => Math.abs(a - state.current) - Math.abs(b - state.current));
  for (const n of nums) if (stale(state.pages[n - 1])) return state.pages[n - 1];
  const ahead = state.pages[Math.max(0, ...nums)];
  return ahead && stale(ahead) ? ahead : null;
}

async function renderPage(p) {
  const pdf = state.pdf;
  const page = (p.pdfPage ??= await pdf.getPage(p.num));
  if (pdf !== state.pdf) return;
  const scale = state.scale;
  const viewport = page.getViewport({ scale: scale * CSS_UNITS });
  let ratio = window.devicePixelRatio || 1;
  if (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_PIXELS) {
    ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!p.canvas) p.div.classList.add('pending');

  const task = page.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
  p.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    p.task = null;
  }
  if (pdf !== state.pdf) return;

  const opList = task._internalRenderTask?.operatorList ?? (await page.getOperatorList());
  Object.assign(p, {
    userRects: findImageRects(opList, pdfjs.OPS),
    source: ctx.getImageData(0, 0, canvas.width, canvas.height),
    viewport, ratio, view: page.view, ctx,
  });
  paintPage(p);

  if (p.canvas) {
    p.canvas.replaceWith(canvas);
    p.canvas.width = p.canvas.height = 0;
  } else {
    p.div.prepend(canvas);
  }
  p.canvas = canvas;
  p.renderedScale = scale;
  p.div.classList.remove('pending');

  await renderTextLayer(p, page, viewport);
  renderLinks(p, page);
}

async function renderTextLayer(p, page, viewport) {
  p.textContent ??= await page.getTextContent();
  const div = document.createElement('div');
  div.className = 'textLayer';
  const layer = new pdfjs.TextLayer({ textContentSource: p.textContent, container: div, viewport });
  await layer.render();
  const end = document.createElement('div');
  end.className = 'endOfContent';
  div.append(end);
  div.addEventListener('mousedown', () => div.classList.add('selecting'));
  p.textLayer?.div.remove();
  p.textLayer = { div, layer };
  p.marked = null;
  p.div.append(div);
  applyHighlights(p);
}

async function renderLinks(p, page) {
  if (p.links) return;
  p.links = document.createElement('div');
  p.links.className = 'links';
  p.div.append(p.links);
  const annotations = await page.getAnnotations({ intent: 'display' });
  const vp = page.getViewport({ scale: 1 });
  for (const a of annotations) {
    if (a.subtype !== 'Link' || !(a.url || a.dest)) continue;
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
    const el = document.createElement('a');
    Object.assign(el.style, {
      left: `${(Math.min(x0, x1) / vp.width) * 100}%`,
      top: `${(Math.min(y0, y1) / vp.height) * 100}%`,
      width: `${(Math.abs(x1 - x0) / vp.width) * 100}%`,
      height: `${(Math.abs(y1 - y0) / vp.height) * 100}%`,
    });
    if (a.url) {
      el.href = a.url;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.title = a.url;
    } else {
      el.href = '#';
      el.addEventListener('click', (e) => { e.preventDefault(); goToDest(a.dest); });
    }
    p.links.append(el);
  }
}

window.addEventListener('mouseup', () => {
  for (const el of document.querySelectorAll('.textLayer.selecting')) el.classList.remove('selecting');
});

function releasePage(p) {
  p.task?.cancel();
  if (p.canvas) {
    p.canvas.remove();
    p.canvas.width = p.canvas.height = 0;
  }
  p.textLayer?.div.remove();
  Object.assign(p, { canvas: null, ctx: null, source: null, textLayer: null, marked: null, renderedScale: null });
}

function evict() {
  const rendered = state.pages.filter((p) => p.canvas && !state.visible.has(p.num));
  const excess = state.pages.filter((p) => p.canvas).length - KEEP_RENDERED;
  if (excess <= 0) return;
  rendered.sort((a, b) => Math.abs(b.num - state.current) - Math.abs(a.num - state.current));
  rendered.slice(0, excess).forEach(releasePage);
}

/* ---------- Navigation ---------- */

let scrollFrame = 0;
main.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateCurrentPage();
  });
}, { passive: true });

function updateCurrentPage() {
  if (!state.pages.length) return;
  const p = pageAt(main.scrollTop + main.clientHeight * 0.35);
  if (p.num !== state.current) {
    state.current = p.num;
    savePosition();
  }
  if (document.activeElement !== $('pageInput')) $('pageInput').value = state.current;
  const max = main.scrollHeight - main.clientHeight;
  $('readProgress').style.width = `${max > 0 ? (main.scrollTop / max) * 100 : 100}%`;
  $('prevPage').disabled = state.current <= 1;
  $('nextPage').disabled = state.current >= state.pages.length;
}

async function goToDest(dest) {
  const pdf = state.pdf;
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const index = typeof ref === 'object' && ref !== null ? await pdf.getPageIndex(ref) : Number(ref);
    const p = state.pages[index];
    if (!p) return;
    let fy = 0;
    if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') {
      const page = (p.pdfPage ??= await pdf.getPage(p.num));
      const vp = page.getViewport({ scale: 1 });
      fy = Math.max(0, vp.convertToViewportPoint(explicit[2] ?? 0, explicit[3])[1] / vp.height);
    }
    scrollToPage(p.num, fy);
  } catch (err) {
    console.warn('Could not follow link', err);
  }
}

const positionKey = () => `lumen:pos:${state.url ?? state.name}`;
let positionTimer = 0;
function savePosition() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    try {
      localStorage.setItem(positionKey(), JSON.stringify({ page: state.current, zoom: state.zoom }));
    } catch {}
  }, 400);
}

function readPosition() {
  try {
    return JSON.parse(localStorage.getItem(positionKey()));
  } catch {
    return null;
  }
}

/* ---------- Outline ---------- */

async function loadOutline(pdf) {
  const outline = await pdf.getOutline().catch(() => null);
  if (pdf !== state.pdf) return;
  const nav = $('outline');
  if (!outline?.length) {
    nav.innerHTML = '<div class="empty-note muted">This document has no outline.</div>';
    return;
  }
  const build = (items) => {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = item.title;
      if (item.bold) b.style.fontWeight = '600';
      if (item.italic) b.style.fontStyle = 'italic';
      b.addEventListener('click', () => {
        if (item.dest) goToDest(item.dest);
        else if (item.url) window.open(item.url, '_blank', 'noopener');
        if (window.innerWidth < 860) document.body.classList.remove('sidebar-open');
      });
      li.append(b);
      if (item.items?.length) li.append(build(item.items));
      ul.append(li);
    }
    return ul;
  };
  nav.replaceChildren(build(outline));
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
  if (typeof state.zoom === 'string') setTimeout(() => setZoom(state.zoom), 240);
}

/* ---------- Search ---------- */

function buildIndex(textContent) {
  let text = '';
  const starts = [];
  for (const item of textContent.items) {
    if (item.str === undefined) continue;
    starts.push(text.length);
    text += item.str;
    if (item.hasEOL) text += ' ';
  }
  return { text: text.toLowerCase(), starts };
}

async function runSearch(query) {
  query = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const pdf = state.pdf;
  state.search = { query, matches: [], index: -1, reveal: false };
  if (!query || !pdf) return refreshHighlights();
  $('searchCount').textContent = '…';
  for (const p of state.pages) {
    if (!p.index) {
      p.textContent ??= await (p.pdfPage ??= await pdf.getPage(p.num)).getTextContent();
      p.index = buildIndex(p.textContent);
    }
    if (pdf !== state.pdf || state.search.query !== query) return;
    const text = p.index.text.replace(/\s+/g, ' ');
    const sameLength = text.length === p.index.text.length;
    const hay = sameLength ? text : p.index.text;
    for (let at = hay.indexOf(query); at !== -1; at = hay.indexOf(query, at + query.length)) {
      state.search.matches.push({ page: p.num, start: at, end: at + query.length });
    }
  }
  const firstAhead = state.search.matches.findIndex((m) => m.page >= state.current);
  goToMatch(firstAhead === -1 ? 0 : firstAhead);
}

function goToMatch(i) {
  const { matches } = state.search;
  if (!matches.length) {
    state.search.index = -1;
    refreshHighlights();
    return;
  }
  state.search.index = (i + matches.length) % matches.length;
  state.search.reveal = true;
  refreshHighlights();
  const m = matches[state.search.index];
  const p = state.pages[m.page - 1];
  if (!p.textLayer) scrollToPage(m.page);
}

function refreshHighlights() {
  updateSearchCount();
  for (const p of state.pages) if (p.textLayer) applyHighlights(p);
}

function updateSearchCount() {
  const { query, matches, index } = state.search;
  $('searchCount').textContent = !query ? '' : matches.length ? `${index + 1} / ${matches.length}` : 'No results';
}

function applyHighlights(p) {
  const { textDivs: divs, textContentItemsStr: strs } = p.textLayer.layer;
  for (const i of p.marked ?? []) if (divs[i]) divs[i].textContent = strs[i];
  p.marked = [];
  const current = state.search.matches[state.search.index];
  const matches = state.search.matches.filter((m) => m.page === p.num);
  if (!matches.length || !p.index) return;

  const { starts } = p.index;
  const segments = new Map();
  for (const m of matches) {
    let i = starts.findLastIndex((s) => s <= m.start);
    for (; i >= 0 && i < starts.length && starts[i] < m.end; i++) {
      const from = Math.max(0, m.start - starts[i]);
      const to = Math.min(strs[i].length, m.end - starts[i]);
      if (to <= from) continue;
      if (!segments.has(i)) segments.set(i, []);
      segments.get(i).push([from, to, m === current]);
    }
  }
  let currentEl = null;
  for (const [i, segs] of segments) {
    const div = divs[i];
    if (!div) continue;
    const str = strs[i];
    const parts = [];
    let pos = 0;
    for (const [from, to, isCurrent] of segs) {
      if (from > pos) parts.push(str.slice(pos, from));
      const mark = document.createElement('mark');
      mark.textContent = str.slice(from, to);
      if (isCurrent) mark.className = 'current';
      currentEl ??= isCurrent ? mark : null;
      parts.push(mark);
      pos = to;
    }
    if (pos < str.length) parts.push(str.slice(pos));
    div.replaceChildren(...parts);
    p.marked.push(i);
  }
  if (currentEl && state.search.reveal) {
    state.search.reveal = false;
    currentEl.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

function openSearch() {
  $('searchbar').hidden = false;
  $('searchInput').focus();
  $('searchInput').select();
}

function closeSearch() {
  $('searchbar').hidden = true;
  state.search = { query: '', matches: [], index: -1, reveal: false };
  refreshHighlights();
  main.focus({ preventScroll: true });
}

/* ---------- Export ---------- */

function saveBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const exportState = { themeId: null, running: false, cancelled: false };

function openExport() {
  if (!state.pdf) return toast('Open a PDF first');
  const themes = allThemes(state.settings).filter((t) => !isOriginal(t));
  exportState.themeId = themes.some((t) => t.id === state.theme.id) ? state.theme.id : 'dark';
  const draw = () => $('exportSwatches').replaceChildren(...themes.map((t) => swatch(t, {
    active: t.id === exportState.themeId,
    onPick: (theme) => { exportState.themeId = theme.id; draw(); },
  })));
  draw();
  $('exportProgress').hidden = true;
  $('exportNote').textContent = '';
  setExportBusy(false);
  syncExportFormat();
  $('exportDialog').showModal();
}

function syncExportFormat() {
  const format = new FormData($('exportDialog').querySelector('form')).get('format');
  $('exportQuality').hidden = format !== 'image';
  $('exportNote').textContent = format === 'vector'
    ? 'Text stays sharp and searchable; images keep their natural colours.'
    : 'Every page is captured exactly as you see it on screen.';
}

function setExportBusy(busy) {
  exportState.running = busy;
  $('exportStart').disabled = busy;
  $('exportStart').textContent = busy ? 'Preparing…' : 'Download';
}

async function runExport() {
  const form = new FormData($('exportDialog').querySelector('form'));
  const theme = findTheme(state.settings, exportState.themeId);
  exportState.cancelled = false;
  setExportBusy(true);
  $('exportProgress').hidden = false;
  $('exportFill').style.width = '0%';
  try {
    const { bytes, format } = await exportThemedPdf({
      pdf: state.pdf,
      pdfjs,
      theme,
      format: form.get('format'),
      options: { ...state.settings, quality: form.get('quality') },
      onProgress: (f) => {
        if (exportState.cancelled) throw new DOMException('Export cancelled', 'AbortError');
        $('exportFill').style.width = `${Math.round(f * 100)}%`;
      },
    });
    saveBytes(bytes, themedFileName(state.name, theme));
    $('exportDialog').close();
    toast(format !== form.get('format') ? 'This PDF is locked for editing, so an exact image copy was saved instead.' : 'Your themed PDF is ready');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error(err);
      $('exportNote').textContent = `Export failed: ${err?.message ?? err}`;
    }
  } finally {
    setExportBusy(false);
  }
}

/* ---------- Popovers, toasts ---------- */

let openPopover = null;
function togglePopover(el, anchor) {
  const wasOpen = openPopover === el;
  closePopover();
  if (wasOpen) return;
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const ideal = el.id === 'zoomMenu' ? r.left + r.width / 2 - width / 2 : r.right - width;
  el.style.left = `${Math.min(Math.max(10, ideal), window.innerWidth - width - 10)}px`;
  el.style.top = `${r.bottom + 8}px`;
  openPopover = el;
}

function closePopover() {
  if (openPopover) openPopover.hidden = true;
  openPopover = null;
}

document.addEventListener('pointerdown', (e) => {
  if (openPopover && !openPopover.contains(e.target) && !e.target.closest('[aria-haspopup]')) closePopover();
});

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- Wiring ---------- */

function bindUI() {
  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('prevPage').addEventListener('click', () => scrollToPage(state.current - 1));
  $('nextPage').addEventListener('click', () => scrollToPage(state.current + 1));
  $('pageInput').addEventListener('change', (e) => scrollToPage(parseInt(e.target.value, 10) || state.current));
  $('pageInput').addEventListener('focus', (e) => e.target.select());
  $('pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); main.focus({ preventScroll: true }); } });

  $('zoomIn').addEventListener('click', () => setZoom(clampScale(stepZoom(1))));
  $('zoomOut').addEventListener('click', () => setZoom(clampScale(stepZoom(-1))));
  $('zoomLabel').addEventListener('click', (e) => togglePopover($('zoomMenu'), e.currentTarget));
  $('zoomMenu').addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (!z) return;
    setZoom(Number.isNaN(Number(z)) ? z : Number(z));
    closePopover();
  });

  $('themeToggle').addEventListener('click', (e) => togglePopover($('themePanel'), e.currentTarget));
  $('moreToggle').addEventListener('click', (e) => togglePopover($('moreMenu'), e.currentTarget));
  $('customBg').addEventListener('input', editCustom);
  $('customFg').addEventListener('input', editCustom);
  $('customSave').addEventListener('click', saveCustom);
  $('customName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCustom(); });
  $('keepImages').addEventListener('change', (e) => updateImageSetting({ recolorImages: !e.target.checked }));
  $('scannedAsText').addEventListener('change', (e) => updateImageSetting({ scannedAsText: e.target.checked }));
  $('imageBrightness').addEventListener('input', (e) => updateImageSetting({ imageBrightness: e.target.value / 100 }));

  $('searchToggle').addEventListener('click', () => ($('searchbar').hidden ? openSearch() : closeSearch()));
  $('searchClose').addEventListener('click', closeSearch);
  $('searchNext').addEventListener('click', () => goToMatch(state.search.index + 1));
  $('searchPrev').addEventListener('click', () => goToMatch(state.search.index - 1));
  let searchTimer = 0;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeSearch();
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (q !== state.search.query) runSearch(e.target.value);
    else goToMatch(state.search.index + (e.shiftKey ? -1 : 1));
  });

  $('downloadBtn').addEventListener('click', openExport);
  $('exportFormat').addEventListener('change', syncExportFormat);
  $('exportDialog').querySelector('form').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'default') {
      e.preventDefault();
      if (!exportState.running) runExport();
    } else {
      exportState.cancelled = true;
    }
  });
  $('exportDialog').addEventListener('cancel', () => { exportState.cancelled = true; });

  const pick = () => $('fileInput').click();
  $('emptyOpen').addEventListener('click', pick);
  $('openFile').addEventListener('click', () => { closePopover(); pick(); });
  $('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
  $('downloadOriginal').addEventListener('click', async () => {
    closePopover();
    if (state.pdf) saveBytes(await state.pdf.getData(), state.name.endsWith('.pdf') ? state.name : `${state.name}.pdf`);
  });
  $('viewOriginal').addEventListener('click', async () => {
    closePopover();
    if (!state.url) return;
    await api.runtime.sendMessage({ type: 'bypass', url: state.url }).catch(() => {});
    location.href = state.url;
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (file) openFile(file);
  });

  main.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = main.getBoundingClientRect();
    setZoom(clampScale(state.scale * Math.exp(-e.deltaY * 0.0045)), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, { passive: false });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (typeof state.zoom === 'string') setZoom(state.zoom);
      else { layoutPages(); updateCurrentPage(); }
    }, 150);
  });

  window.addEventListener('keydown', onKey);
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function stepZoom(dir) {
  const s = state.scale;
  return dir > 0 ? ZOOM_STEPS.find((z) => z > s + 0.01) ?? MAX_SCALE : [...ZOOM_STEPS].reverse().find((z) => z < s - 0.01) ?? MIN_SCALE;
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.matches?.('input, textarea, select');
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); return openSearch(); }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); return setZoom(stepZoom(1)); }
  if (mod && e.key === '-') { e.preventDefault(); return setZoom(stepZoom(-1)); }
  if (mod && e.key === '0') { e.preventDefault(); return setZoom('auto'); }
  if (e.key === 'Escape') {
    if (openPopover) return closePopover();
    if (!$('searchbar').hidden) return closeSearch();
  }
  if (typing || mod || e.altKey || document.querySelector('dialog[open]')) return;
  switch (e.key) {
    case 't':
    case 'T': {
      const themes = allThemes(state.settings);
      const i = themes.findIndex((t) => t.id === state.theme.id);
      setTheme(themes[(i + (e.shiftKey ? -1 : 1) + themes.length) % themes.length].id);
      toast(state.theme.name);
      break;
    }
    case 'd': openExport(); break;
    case 'o': toggleSidebar(); break;
    case 'ArrowLeft': if (main.scrollWidth <= main.clientWidth) scrollToPage(state.current - 1); break;
    case 'ArrowRight': if (main.scrollWidth <= main.clientWidth) scrollToPage(state.current + 1); break;
    default: return;
  }
  e.preventDefault();
}

async function init() {
  state.settings = await loadSettings();
  state.theme = findTheme(state.settings);
  applyChrome();
  renderSwatches();
  syncImageControls();
  onSettingsChanged(onExternalSettings);
  bindUI();

  const url = fileParam();
  if (!url) return showEmpty();
  open({ url, withCredentials: true }, { url, name: nameFromUrl(url) });
}

init();
