import { hexToRgb, isDark } from '../shared/themes.js';

/*
 * The colour model is chosen so it can be reproduced exactly with standard PDF
 * blend modes (see export.js), making the downloaded file match the screen.
 *
 *   dark theme:  x = hue-preserving inverse of c  →  out = bg + (fg - bg) * x
 *   light theme: x = c                            →  out = fg + (bg - fg) * x
 */
export function themeParams(theme) {
  const dark = isDark(theme);
  const bg = hexToRgb(theme.bg).map((v) => v / 255);
  const fg = hexToRgb(theme.fg).map((v) => v / 255);
  const base = dark ? bg : fg;
  const top = dark ? fg : bg;
  const k = base.map((b, i) => Math.max(0, top[i] - b));
  return { dark, base, k };
}

function buildLut({ base, k }) {
  const lut = new Uint8Array(768);
  for (let c = 0; c < 3; c++) {
    for (let x = 0; x < 256; x++) lut[c * 256 + x] = Math.round((base[c] + k[c] * (x / 255)) * 255);
  }
  return lut;
}

export function recolor(src, dst, theme) {
  const params = themeParams(theme);
  const lut = buildLut(params);
  const n = src.length;
  for (let i = 0; i < n; i += 4) {
    let r = src[i], g = src[i + 1], b = src[i + 2];
    if (params.dark) {
      if (r === g && g === b) {
        r = g = b = 255 - r;
      } else {
        // PDF "Hue" blend of the original over its inverse: keep hue, flip luminosity.
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        const target = 255 - l;
        const d = target - l;
        let rr = r + d, gg = g + d, bb = b + d;
        const lo = Math.min(rr, gg, bb), hi = Math.max(rr, gg, bb);
        if (lo < 0) {
          const s = target / (target - lo);
          rr = target + (rr - target) * s; gg = target + (gg - target) * s; bb = target + (bb - target) * s;
        }
        if (hi > 255) {
          const s = (255 - target) / (hi - target);
          rr = target + (rr - target) * s; gg = target + (gg - target) * s; bb = target + (bb - target) * s;
        }
        r = rr | 0; g = gg | 0; b = bb | 0;
      }
    }
    dst[i] = lut[r];
    dst[i + 1] = lut[256 + g];
    dst[i + 2] = lut[512 + b];
    dst[i + 3] = 255;
  }
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function unitSquareBounds(m) {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Bounding boxes (PDF user space) of every raster image painted on the page. */
export function findImageRects(opList, OPS) {
  const { fnArray: fns, argsArray: args } = opList;
  const rects = [];
  const stack = [];
  let ctm = IDENTITY;
  let annotationDepth = 0;
  const add = (m) => annotationDepth === 0 && rects.push(unitSquareBounds(m));

  for (let i = 0; i < fns.length; i++) {
    const a = args[i];
    switch (fns[i]) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: ctm = stack.pop() ?? ctm; break;
      case OPS.transform: ctm = multiply(ctm, a); break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (a[0]) ctm = multiply(ctm, a[0]);
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        if (a[0]?.matrix) ctm = multiply(ctm, a[0].matrix);
        break;
      case OPS.paintFormXObjectEnd:
      case OPS.endGroup:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.beginAnnotation: annotationDepth++; break;
      case OPS.endAnnotation: annotationDepth--; break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        add(ctm);
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, sx, sy, pos] = a;
        for (let j = 0; j < pos.length; j += 2) add(multiply(ctm, [sx, 0, 0, sy, pos[j], pos[j + 1]]));
        break;
      }
      case OPS.paintInlineImageXObjectGroup:
        for (const entry of a[1]) add(multiply(ctm, entry.transform));
        break;
    }
  }
  return rects.filter(([x0, y0, x1, y1]) => x1 - x0 > 1 && y1 - y0 > 1);
}

/** Drops images that are effectively the whole page (scans) so their text gets themed too. */
export function protectedRects(rects, view, { recolorImages, scannedAsText }) {
  if (recolorImages) return [];
  if (!scannedAsText) return rects;
  const pageArea = (view[2] - view[0]) * (view[3] - view[1]);
  return rects.filter(([x0, y0, x1, y1]) => {
    const w = Math.min(x1, view[2]) - Math.max(x0, view[0]);
    const h = Math.min(y1, view[3]) - Math.max(y0, view[1]);
    return w <= 0 || h <= 0 || (w * h) / pageArea < 0.8;
  });
}

/** Splits `outer` minus the union of `holes` into non-overlapping rectangles. */
export function subtractRects(outer, holes) {
  if (!holes.length) return [outer];
  const clampX = (v) => Math.min(Math.max(v, outer[0]), outer[2]);
  const clampY = (v) => Math.min(Math.max(v, outer[1]), outer[3]);
  const xs = [...new Set([outer[0], outer[2], ...holes.flatMap((h) => [clampX(h[0]), clampX(h[2])])])].sort((a, b) => a - b);
  const ys = [...new Set([outer[1], outer[3], ...holes.flatMap((h) => [clampY(h[1]), clampY(h[3])])])].sort((a, b) => a - b);
  const out = [];
  for (let j = 0; j < ys.length - 1; j++) {
    let run = null;
    for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      const covered = holes.some((h) => cx > h[0] && cx < h[2] && cy > h[1] && cy < h[3]);
      if (covered) { run = null; continue; }
      if (run) run[2] = xs[i + 1];
      else out.push((run = [xs[i], ys[j], xs[i + 1], ys[j + 1]]));
    }
  }
  return out;
}

/**
 * Themes a rendered page in place. `rects` are device-pixel boxes of images to keep.
 * `source` is the untouched render so the page can be re-themed without re-rendering.
 */
export function paintThemed(ctx, source, theme, rects, imageBrightness) {
  const { width, height } = source;
  const out = new ImageData(width, height);
  recolor(source.data, out.data, theme);

  const src = source.data, dst = out.data;
  for (const [x0, y0, x1, y1] of rects) {
    const left = Math.max(0, Math.floor(x0)), right = Math.min(width, Math.ceil(x1));
    const top = Math.max(0, Math.floor(y0)), bottom = Math.min(height, Math.ceil(y1));
    if (right <= left) continue;
    for (let y = top; y < bottom; y++) {
      const start = (y * width + left) * 4;
      dst.set(src.subarray(start, start + (right - left) * 4), start);
    }
  }
  ctx.putImageData(out, 0, 0);

  if (rects.length && imageBrightness < 1) {
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${1 - imageBrightness})`;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of rects) ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill('nonzero');
    ctx.restore();
  }
}
