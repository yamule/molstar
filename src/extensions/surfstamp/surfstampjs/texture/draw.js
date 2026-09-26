// Texture painting: island backgrounds, group outlines and labels placed in the largest inscribed rectangles.
// All coordinates here are image pixels (y down).
import { Raster } from './raster.js';
import { layoutText, inkBounds, transformContours } from './font.js';

const REF_SIZE = 14;

/**
 * Measure text with a font. CanvasFont exposes measureText(); outline fonts are laid out with layoutText().
 * @returns {{ink: {minX:number, minY:number, maxX:number, maxY:number}, layout: object|null}}
 */
function measure(font, text, size) {
  if (typeof font.measureText === 'function') return { ink: font.measureText(text, size).ink, layout: null };
  const layout = layoutText(font, text, size);
  return { ink: inkBounds(layout), layout };
}

/** Blend a coverage bitmap ({data (alpha per pixel), width, height}) onto the raster at integer offset (ox, oy). */
function blitAlpha(raster, bm, ox, oy, color) {
  for (let j = 0; j < bm.height; j++) {
    const py = oy + j;
    if (py < 0 || py >= raster.height) continue;
    for (let i = 0; i < bm.width; i++) {
      const a = bm.data[j * bm.width + i];
      if (!a) continue;
      const px = ox + i;
      if (px < 0 || px >= raster.width) continue;
      raster.blendPixel(px, py, color[0], color[1], color[2], a / 255);
    }
  }
}

/** Paint text so that the top-left corner of its ink box lands at (x, y). `m` is the result of measure(). */
function paintText(raster, font, text, size, m, x, y, color) {
  if (typeof font.rasterizeText === 'function') {
    const bm = font.rasterizeText(text, size, m.ink);
    blitAlpha(raster, bm, Math.round(x + bm.offsetX), Math.round(y + bm.offsetY), color);
  } else {
    const cs = transformContours(m.layout.contours, x - m.ink.minX, y - m.ink.minY);
    raster.fillPath(cs, color, { rule: 'nonzero' });
  }
}

/** Deterministic PRNG (mulberry32) so that results are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Rasterised island mask with a summed-area table for O(1) rectangle containment tests. */
class IslandMask {
  constructor(loops, rule = 'evenodd') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of loops) for (let i = 0; i < c.length; i += 2) {
      if (c[i] < minX) minX = c[i]; if (c[i] > maxX) maxX = c[i];
      if (c[i + 1] < minY) minY = c[i + 1]; if (c[i + 1] > maxY) maxY = c[i + 1];
    }
    this.ox = Math.floor(minX) - 1; this.oy = Math.floor(minY) - 1;
    this.w = Math.max(1, Math.ceil(maxX) - this.ox + 2); this.h = Math.max(1, Math.ceil(maxY) - this.oy + 2);
    const r = new Raster(this.w, this.h);
    r.clear(0, 0, 0, 0);
    r.fillPath(loops.map(c => { const o = c.slice(); for (let i = 0; i < o.length; i += 2) { o[i] -= this.ox; o[i + 1] -= this.oy; } return o; }), [255, 255, 255], { rule, antialias: false });
    // summed area table of "inside" pixels
    const W = this.w + 1;
    this.sat = new Int32Array(W * (this.h + 1));
    this.count = 0;
    for (let y = 0; y < this.h; y++) {
      let row = 0;
      for (let x = 0; x < this.w; x++) {
        const inside = r.data[(y * this.w + x) * 4] > 127 ? 1 : 0;
        row += inside; this.count += inside;
        this.sat[(y + 1) * W + x + 1] = this.sat[y * W + x + 1] + row;
      }
    }
    this.W = W;
    this.bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  /** true if the pixel rectangle [x0,x1) x [y0,y1) (image coords) is completely inside */
  contains(x0, y0, x1, y1) {
    const ax = Math.floor(x0) - this.ox, ay = Math.floor(y0) - this.oy, bx = Math.ceil(x1) - this.ox, by = Math.ceil(y1) - this.oy;
    if (ax < 0 || ay < 0 || bx > this.w || by > this.h || bx <= ax || by <= ay) return false;
    const W = this.W;
    const s = this.sat[by * W + bx] - this.sat[ay * W + bx] - this.sat[by * W + ax] + this.sat[ay * W + ax];
    return s === (bx - ax) * (by - ay);
  }
}

/** Greedy largest inscribed rectangle search (deterministic seed + random seeds). Returns {x,y,w,h} or null. */
function largestBox(mask, random, rnd) {
  const bb = mask.bbox;
  const stepx = Math.max(1, bb.w / 500), stepy = Math.max(1, bb.h / 500);
  let x = bb.x, y = bb.y, x2 = bb.x + bb.w, y2 = bb.y + bb.h;
  let failed = false;
  if (!random) {
    for (;;) {
      x += stepx; x2 -= stepx; y += stepy; y2 -= stepy;
      if (x2 <= x || y2 <= y) { failed = true; break; }
      if (mask.contains(x, y, x2, y2)) break;
    }
  } else failed = true;
  if (failed) {
    let ok = false;
    for (let t = 0; t < 1000; t++) {
      const rx = bb.x + rnd() * bb.w, ry = bb.y + rnd() * bb.h;
      if (mask.contains(rx, ry, rx + 1, ry + 1)) { x = rx; y = ry; x2 = rx + 1; y2 = ry + 1; ok = true; break; }
    }
    if (!ok) return null;
  }
  const flags = [1, 1, 1, 1];
  while (flags.some(f => f)) {
    if (flags[0]) { const nx = x - stepx; if (mask.contains(nx, y, x2, y2)) x = nx; else flags[0] = 0; }
    if (flags[1]) { const ny = y - stepy; if (mask.contains(x, ny, x2, y2)) y = ny; else flags[1] = 0; }
    if (flags[2]) { const nx = x2 + stepx; if (mask.contains(x, y, nx, y2)) x2 = nx; else flags[2] = 0; }
    if (flags[3]) { const ny = y2 + stepy; if (mask.contains(x, y, x2, ny)) y2 = ny; else flags[3] = 0; }
  }
  if (y2 - y > x2 - x) { // text is horizontal: cut tall boxes to squares
    const diff = (y2 - y) - (x2 - x);
    if (random) { const r = rnd(); if (r < 0.3) y2 -= diff; else if (r < 0.6) y += diff; else { y += diff / 2; y2 -= diff / 2; } }
    else { y += diff / 2; y2 -= diff / 2; }
  }
  return { x, y, w: x2 - x, h: y2 - y };
}

function rectScore(r) { return Math.min(r.w, 2 * r.h); }

function rectDist(a, b) {
  const ax1 = a.x + a.w, ay1 = a.y + a.h, bx1 = b.x + b.w, by1 = b.y + b.h;
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(ax1, bx1));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(ay1, by1));
  return Math.hypot(dx, dy);
}

/** Chain edge segments [x0,y0,x1,y1] into polylines by exact endpoint matching. */
export function chainSegments(segs) {
  const key = (x, y) => `${x.toFixed(3)},${y.toFixed(3)}`;
  const adj = new Map();
  segs.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) { let l = adj.get(k); if (!l) { l = []; adj.set(k, l); } l.push(i); }
  });
  const used = new Uint8Array(segs.length);
  const out = [];
  const other = (s, k) => (key(s[0], s[1]) === k ? [s[2], s[3]] : [s[0], s[1]]);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const line = [s[0], s[1], s[2], s[3]];
    // extend forward
    for (const dir of [1, -1]) {
      for (;;) {
        const ex = dir === 1 ? line[line.length - 2] : line[0], ey = dir === 1 ? line[line.length - 1] : line[1];
        const k = key(ex, ey);
        const cand = (adj.get(k) || []).filter(j => !used[j]);
        if (cand.length !== 1) break;
        const j = cand[0]; used[j] = 1;
        const p = other(segs[j], k);
        if (dir === 1) line.push(p[0], p[1]); else line.unshift(p[0], p[1]);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Paint the texture.
 * @param {object} p
 * @param {number} p.size image size (square)
 * @param {Array} p.decos each: {text, textColor, backgroundColor, outlineColor, noBackground, noText, noOutline,
 *        islands: [{loops:number[][] (pixel coords), area3D:number, areaPx:number}], outlineSegments: [[x0,y0,x1,y1]...],
 *        scaleFactor:number (px per Angstrom)}
 * @param {object} p.font TrueTypeFont/BitmapFont/CanvasFont
 * @param {object} [p.opts] {outlineWidth=3, textNum=2, textDist=-2, fontSizeMin (px; null=auto), maxfill, tile, tileFontSize,
 *        background:[r,g,b], transparentBackground (start from a fully transparent image), log}
 * @returns {{raster:Raster, labels:Array}}
 */
export function drawTextureAtlas(p) {
  const size = p.size;
  const opts = p.opts || {};
  const outlineWidth = opts.outlineWidth ?? 3;
  const textNum = opts.textNum ?? 2;
  const textDist = opts.textDist ?? -2;
  const rule = opts.maxfill ? 'nonzero' : 'evenodd';
  const raster = new Raster(size, size);
  const bg = opts.background || [255, 255, 255];
  if (opts.transparentBackground) raster.clear(0, 0, 0, 0);
  else raster.clear(bg[0], bg[1], bg[2], 255);
  const rnd = rng(12345);
  const font = p.font;
  // pass 1: backgrounds
  for (const d of p.decos) {
    if (d.noBackground) continue;
    const loops = d.islands.flatMap(i => i.loops);
    if (!loops.length) continue;
    for (const c of loops) raster.strokePolyline(c, 4, d.backgroundColor, { closed: true });
    raster.fillPath(loops, d.backgroundColor, { rule });
  }
  // pass 2: label rectangles and automatic font size
  const ref = new Map(); // text -> layout at REF_SIZE
  const refLayout = (text) => { let l = ref.get(text); if (!l) { l = measure(font, text, REF_SIZE); ref.set(text, l); } return l; };
  const islandRects = [];
  const fittedSizes = [];
  for (const d of p.decos) {
    if (d.noText || !d.text) continue;
    const lay = refLayout(d.text);
    const gw = lay.ink.maxX - lay.ink.minX, gh = lay.ink.maxY - lay.ink.minY;
    if (gw <= 0 || gh <= 0) continue;
    const rects = [];
    for (const isl of d.islands) {
      if (!isl.loops.length) continue;
      if (opts.minLabelArea3D && isl.area3D < opts.minLabelArea3D) continue;
      const mask = new IslandMask(isl.loops, rule);
      if (mask.count < 4) continue;
      let best = largestBox(mask, false, rnd);
      for (let t = 0; t < 11; t++) { const r = largestBox(mask, true, rnd); if (r && (!best || rectScore(r) > rectScore(best))) best = r; }
      if (!best) continue;
      const subs = [];
      for (let t = 0; t < 15; t++) { const r = largestBox(mask, true, rnd); if (r) subs.push(r); }
      rects.push({ main: best, subs });
      fittedSizes.push(REF_SIZE / Math.max(gw / best.w, gh / best.h));
    }
    islandRects.push({ d, rects, gw, gh, lay });
  }
  let threshold = opts.fontSizeMin;
  if (threshold == null) {
    const s = fittedSizes.slice().sort((a, b) => a - b);
    threshold = s.length > 5 ? s[Math.floor(s.length * 0.5)] * 0.2 : 0;
  }
  const labels = [];
  // pass 3: text then outline per decoration
  for (const d of p.decos) {
    const ir = islandRects.find(x => x.d === d);
    if (ir && !opts.tile) {
      const { rects, gw, gh, lay } = ir;
      const sizeThreshold = opts.fontSizeMin == null && rects.length ? Math.max(...rects.map(r => r.main.w * r.main.h)) / 25 : -1;
      for (const r of rects) {
        if (r.main.w * r.main.h < sizeThreshold) continue;
        let cand = r.subs.filter(s => s.w * s.h >= 0.2 * r.main.w * r.main.h);
        cand.unshift(r.main);
        const used = [];
        while (cand.length && used.length < textNum) {
          let rr = cand[0];
          if (used.length) { let bestD = -1; for (const c of cand) { const md = Math.min(...used.map(u => rectDist(u, c))); if (md > bestD) { bestD = md; rr = c; } } }
          cand = cand.filter(c => c !== rr);
          const scale = Math.max(gw / rr.w, gh / rr.h);
          const fs = REF_SIZE / scale;
          if (fs <= threshold || fs < 1) continue;
          const fsize = Math.max(1, Math.floor(fs));
          const m = measure(font, d.text, fsize);
          const ink = m.ink;
          const w = ink.maxX - ink.minX, h = ink.maxY - ink.minY;
          const box = { x: rr.x + rr.w / 2 - w / 2, y: rr.y + rr.h / 2 - h / 2, w, h };
          if (used.length) {
            const ldis = Math.min(used[0].w, used[0].h);
            const minGap = textDist < 0 ? ldis * -textDist : ldis * (size / 2048) * textDist;
            if (used.some(u => rectDist(u, box) < minGap)) continue;
          }
          paintText(raster, font, d.text, fsize, m, box.x, box.y, d.textColor);
          used.push(box);
          labels.push({ text: d.text, box, fontSize: fsize });
        }
      }
    } else if (ir && opts.tile) {
      // brick-pattern tiling of the label, clipped to the island shape
      const fsize = Math.floor((opts.tileFontSize ?? 16) * (size / 2048)) + 1;
      const m = measure(font, d.text, fsize);
      const ink = m.ink;
      const wid = ink.maxX - ink.minX, hei = ink.maxY - ink.minY;
      if (wid > 0 && hei > 0) for (const isl of d.islands) {
        if (!isl.loops.length) continue;
        const mask = new IslandMask(isl.loops, rule);
        const bb = mask.bbox;
        const tmp = new Raster(mask.w, mask.h);
        tmp.clear(0, 0, 0, 0);
        let line = 0;
        for (let yo = fsize; yo < bb.h + fsize / 2; yo += Math.max(1, Math.floor(fsize * 1.2))) {
          for (let xo = line % 2 === 0 ? -wid / 2 : 0; xo < bb.w; xo += wid + fsize / 2) {
            paintText(tmp, font, d.text, fsize, m, bb.x + xo - mask.ox, bb.y + yo - mask.oy + ink.minY, [255, 255, 255]);
          }
          line++;
        }
        const W = mask.W;
        for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) {
          const a = tmp.data[(y * mask.w + x) * 4 + 3];
          if (!a) continue;
          const inside = mask.sat[(y + 1) * W + x + 1] - mask.sat[y * W + x + 1] - mask.sat[(y + 1) * W + x] + mask.sat[y * W + x];
          if (!inside) continue;
          const px = x + mask.ox, py = y + mask.oy;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          raster.blendPixel(px, py, d.textColor[0], d.textColor[1], d.textColor[2], a / 255);
        }
      }
    }
    if (!d.noOutline && d.outlineSegments && d.outlineSegments.length) {
      const width = Math.max(2, outlineWidth * (d.scaleFactor || 14.5407) / 14.5407);
      for (const line of chainSegments(d.outlineSegments)) raster.strokePolyline(line, width, d.outlineColor);
    }
  }
  return { raster, labels, fontThreshold: threshold };
}
