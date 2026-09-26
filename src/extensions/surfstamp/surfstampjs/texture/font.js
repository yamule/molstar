// Minimal TrueType (glyf-based .ttf / .ttc) parser and glyph outline extractor.
// Pure JS, no external dependencies. Supports cmap formats 0, 4, 6, 12, simple and composite glyphs.
// Browser build: fonts are either a TrueTypeFont built from an ArrayBuffer, a CanvasFont backed by the
// Canvas 2D API (default in browsers), or the built-in 5x7 bitmap font as a last resort.
import { flattenQuad } from './raster.js';

class Reader {
  constructor(buf) { this.buf = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8(o) { return this.dv.getUint8(o); }
  u16(o) { return this.dv.getUint16(o); }
  i16(o) { return this.dv.getInt16(o); }
  u32(o) { return this.dv.getUint32(o); }
  i32(o) { return this.dv.getInt32(o); }
  tag(o) { return String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3)); }
}

export class TrueTypeFont {
  /**
   * @param {Buffer|Uint8Array} data
   * @param {number} fontIndex index within a .ttc collection
   */
  constructor(data, fontIndex = 0) {
    const r = new Reader(data);
    this.r = r;
    let off = 0;
    if (r.tag(0) === 'ttcf') {
      const num = r.u32(8);
      if (fontIndex >= num) throw new Error('font index out of range');
      off = r.u32(12 + 4 * fontIndex);
    }
    const tag = r.tag(off);
    if (tag === 'OTTO') throw new Error('CFF-based OpenType fonts are not supported; use a .ttf with glyf outlines');
    const numTables = r.u16(off + 4);
    this.tables = {};
    for (let i = 0; i < numTables; i++) {
      const p = off + 12 + i * 16;
      this.tables[r.tag(p)] = { offset: r.u32(p + 8), length: r.u32(p + 12) };
    }
    for (const t of ['head', 'loca', 'glyf', 'cmap', 'hhea', 'hmtx', 'maxp']) {
      if (!this.tables[t]) throw new Error('font missing table ' + t);
    }
    const head = this.tables.head.offset;
    this.unitsPerEm = r.u16(head + 18);
    this.indexToLocFormat = r.i16(head + 50);
    const hhea = this.tables.hhea.offset;
    this.ascender = r.i16(hhea + 4);
    this.descender = r.i16(hhea + 6);
    this.numHMetrics = r.u16(hhea + 34);
    this.numGlyphs = r.u16(this.tables.maxp.offset + 4);
    this._parseCmap();
    this._glyphCache = new Map();
    this.name = this._readName();
  }

  _readName() {
    const t = this.tables.name;
    if (!t) return '';
    const r = this.r, base = t.offset;
    const count = r.u16(base + 2), strOff = r.u16(base + 4);
    let best = '';
    for (let i = 0; i < count; i++) {
      const p = base + 6 + i * 12;
      const platform = r.u16(p), nameId = r.u16(p + 6), len = r.u16(p + 8), off = r.u16(p + 10);
      if (nameId !== 4) continue; // full name
      const s = base + strOff + off;
      let str = '';
      if (platform === 3 || platform === 0) { for (let k = 0; k + 1 < len; k += 2) str += String.fromCharCode(r.u16(s + k)); }
      else { for (let k = 0; k < len; k++) str += String.fromCharCode(r.u8(s + k)); }
      if (!best || platform === 3) best = str;
    }
    return best;
  }

  _parseCmap() {
    const r = this.r, base = this.tables.cmap.offset;
    const n = r.u16(base + 2);
    let bestOff = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const p = base + 4 + i * 8;
      const platform = r.u16(p), encoding = r.u16(p + 2), off = r.u32(p + 4);
      const fmt = r.u16(base + off);
      let score = 0;
      if (platform === 3 && encoding === 10 && fmt === 12) score = 5;
      else if (platform === 0 && fmt === 12) score = 4;
      else if (platform === 3 && encoding === 1 && fmt === 4) score = 3;
      else if (platform === 0 && fmt === 4) score = 2;
      else if (fmt === 4 || fmt === 0 || fmt === 6 || fmt === 12) score = 1;
      if (score > bestScore) { bestScore = score; bestOff = base + off; }
    }
    if (bestOff < 0) throw new Error('no usable cmap subtable');
    const fmt = r.u16(bestOff);
    this.cmap = new Map();
    if (fmt === 0) {
      for (let c = 0; c < 256; c++) this.cmap.set(c, r.u8(bestOff + 6 + c));
    } else if (fmt === 4) {
      const segX2 = r.u16(bestOff + 6);
      const ends = bestOff + 14, starts = ends + segX2 + 2, deltas = starts + segX2, rangeOffs = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = r.u16(ends + s * 2), start = r.u16(starts + s * 2);
        const delta = r.i16(deltas + s * 2), ro = r.u16(rangeOffs + s * 2);
        if (start > end) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const gp = rangeOffs + s * 2 + ro + (c - start) * 2;
            if (gp + 1 >= this.r.buf.length) continue;
            g = r.u16(gp);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) this.cmap.set(c, g);
        }
      }
    } else if (fmt === 6) {
      const first = r.u16(bestOff + 6), count = r.u16(bestOff + 8);
      for (let i = 0; i < count; i++) this.cmap.set(first + i, r.u16(bestOff + 10 + i * 2));
    } else if (fmt === 12) {
      const ngroups = r.u32(bestOff + 12);
      for (let i = 0; i < ngroups; i++) {
        const p = bestOff + 16 + i * 12;
        const sc = r.u32(p), ec = r.u32(p + 4), sg = r.u32(p + 8);
        for (let c = sc; c <= ec && c - sc < 65536; c++) this.cmap.set(c, sg + (c - sc));
      }
    }
  }

  glyphIndex(codepoint) { return this.cmap.get(codepoint) || 0; }

  advanceWidth(gid) {
    const r = this.r, base = this.tables.hmtx.offset;
    const i = Math.min(gid, this.numHMetrics - 1);
    return r.u16(base + i * 4);
  }

  _glyphOffset(gid) {
    const r = this.r, loca = this.tables.loca.offset;
    if (gid >= this.numGlyphs) return null;
    let start, end;
    if (this.indexToLocFormat === 0) { start = r.u16(loca + gid * 2) * 2; end = r.u16(loca + gid * 2 + 2) * 2; }
    else { start = r.u32(loca + gid * 4); end = r.u32(loca + gid * 4 + 4); }
    if (end <= start) return null;
    return this.tables.glyf.offset + start;
  }

  /**
   * Returns glyph outline in font units: {contours: [[{x,y,on}...], ...], xMin,yMin,xMax,yMax}
   * Points keep on/off-curve flags (quadratic). Y up.
   */
  glyphOutline(gid, depth = 0) {
    if (this._glyphCache.has(gid)) return this._glyphCache.get(gid);
    const res = this._parseGlyph(gid, depth);
    this._glyphCache.set(gid, res);
    return res;
  }

  _parseGlyph(gid, depth) {
    const off = this._glyphOffset(gid);
    const empty = { contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    if (off == null) return empty;
    const r = this.r;
    const nc = r.i16(off);
    const xMin = r.i16(off + 2), yMin = r.i16(off + 4), xMax = r.i16(off + 6), yMax = r.i16(off + 8);
    if (nc >= 0) {
      let p = off + 10;
      const endPts = [];
      for (let i = 0; i < nc; i++) { endPts.push(r.u16(p)); p += 2; }
      const nPts = nc ? endPts[nc - 1] + 1 : 0;
      const il = r.u16(p); p += 2 + il;
      const flags = new Uint8Array(nPts);
      for (let i = 0; i < nPts;) {
        const f = r.u8(p++);
        flags[i++] = f;
        if (f & 8) { let rep = r.u8(p++); while (rep-- > 0 && i < nPts) flags[i++] = f; }
      }
      const xs = new Int16Array(nPts), ys = new Int16Array(nPts);
      let v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 2) { const d = r.u8(p++); v += (f & 16) ? d : -d; }
        else if (!(f & 16)) { v += r.i16(p); p += 2; }
        xs[i] = v;
      }
      v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 4) { const d = r.u8(p++); v += (f & 32) ? d : -d; }
        else if (!(f & 32)) { v += r.i16(p); p += 2; }
        ys[i] = v;
      }
      const contours = [];
      let s = 0;
      for (let c = 0; c < nc; c++) {
        const e = endPts[c];
        const pts = [];
        for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
        if (pts.length) contours.push(pts);
        s = e + 1;
      }
      return { contours, xMin, yMin, xMax, yMax };
    }
    // composite glyph
    if (depth > 8) return empty;
    let p = off + 10;
    const contours = [];
    for (;;) {
      const flags = r.u16(p), glyphIndex = r.u16(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = r.i16(p); dy = r.i16(p + 2); p += 4; }
      else { dx = (r.u8(p) << 24) >> 24; dy = (r.u8(p + 1) << 24) >> 24; p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o) => r.i16(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; }
      else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      const sub = this.glyphOutline(glyphIndex, depth + 1);
      // ARGS_ARE_XY_VALUES assumed (flag 2); point matching is rare and not supported (treated as 0 offset)
      const ox = (flags & 2) ? dx : 0, oy = (flags & 2) ? dy : 0;
      for (const cont of sub.contours) {
        contours.push(cont.map(pt => ({ x: a * pt.x + c * pt.y + ox, y: b * pt.x + d * pt.y + oy, on: pt.on })));
      }
      if (!(flags & 0x20)) break;
    }
    return { contours, xMin, yMin, xMax, yMax };
  }

  /**
   * Flattened glyph contours (flat [x,y,...] arrays) in font units, Y up.
   */
  glyphContoursFlat(gid, tolFontUnits = 4) {
    const g = this.glyphOutline(gid);
    const out = [];
    for (const pts of g.contours) {
      const n = pts.length;
      if (n < 2) continue;
      // find first on-curve point (or synthesize one)
      let startIdx = pts.findIndex(p => p.on);
      let startX, startY;
      if (startIdx < 0) { startIdx = 0; startX = (pts[0].x + pts[1 % n].x) / 2; startY = (pts[0].y + pts[1 % n].y) / 2; }
      else { startX = pts[startIdx].x; startY = pts[startIdx].y; }
      const flat = [startX, startY];
      let cx = startX, cy = startY;
      let prevOff = null;
      for (let k = 1; k <= n; k++) {
        const p = pts[(startIdx + k) % n];
        const isLast = k === n;
        const px = isLast ? startX : p.x, py = isLast ? startY : p.y, on = isLast ? true : p.on;
        if (on) {
          if (prevOff) { flattenQuad(cx, cy, prevOff.x, prevOff.y, px, py, flat, tolFontUnits); prevOff = null; }
          else flat.push(px, py);
          cx = px; cy = py;
        } else {
          if (prevOff) {
            const mx = (prevOff.x + px) / 2, my = (prevOff.y + py) / 2;
            flattenQuad(cx, cy, prevOff.x, prevOff.y, mx, my, flat, tolFontUnits);
            cx = mx; cy = my;
          }
          prevOff = { x: px, y: py };
        }
      }
      if (prevOff) flattenQuad(cx, cy, prevOff.x, prevOff.y, startX, startY, flat, tolFontUnits);
      out.push(flat);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Built-in fallback: 5x7 bitmap font for printable ASCII (0x20-0x7E), public-domain style glyph data.
// Each glyph: 5 columns, each a 7-bit column bitmap (bit0 = top row).
const BITMAP57 = {
  ' ': [0, 0, 0, 0, 0], '!': [0, 0, 0x5f, 0, 0], '"': [0, 7, 0, 7, 0], '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
  '$': [0x24, 0x2a, 0x7f, 0x2a, 0x12], '%': [0x23, 0x13, 8, 0x64, 0x62], '&': [0x36, 0x49, 0x55, 0x22, 0x50],
  "'": [0, 5, 3, 0, 0], '(': [0, 0x1c, 0x22, 0x41, 0], ')': [0, 0x41, 0x22, 0x1c, 0], '*': [0x14, 8, 0x3e, 8, 0x14],
  '+': [8, 8, 0x3e, 8, 8], ',': [0, 0x50, 0x30, 0, 0], '-': [8, 8, 8, 8, 8], '.': [0, 0x60, 0x60, 0, 0],
  '/': [0x20, 0x10, 8, 4, 2], '0': [0x3e, 0x51, 0x49, 0x45, 0x3e], '1': [0, 0x42, 0x7f, 0x40, 0],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4b, 0x31], '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39], '6': [0x3c, 0x4a, 0x49, 0x49, 0x30], '7': [1, 0x71, 9, 5, 3],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [6, 0x49, 0x49, 0x29, 0x1e], ':': [0, 0x36, 0x36, 0, 0],
  ';': [0, 0x56, 0x36, 0, 0], '<': [8, 0x14, 0x22, 0x41, 0], '=': [0x14, 0x14, 0x14, 0x14, 0x14],
  '>': [0, 0x41, 0x22, 0x14, 8], '?': [2, 1, 0x51, 9, 6], '@': [0x32, 0x49, 0x79, 0x41, 0x3e],
  'A': [0x7e, 0x11, 0x11, 0x11, 0x7e], 'B': [0x7f, 0x49, 0x49, 0x49, 0x36], 'C': [0x3e, 0x41, 0x41, 0x41, 0x22],
  'D': [0x7f, 0x41, 0x41, 0x22, 0x1c], 'E': [0x7f, 0x49, 0x49, 0x49, 0x41], 'F': [0x7f, 9, 9, 9, 1],
  'G': [0x3e, 0x41, 0x49, 0x49, 0x7a], 'H': [0x7f, 8, 8, 8, 0x7f], 'I': [0, 0x41, 0x7f, 0x41, 0],
  'J': [0x20, 0x40, 0x41, 0x3f, 1], 'K': [0x7f, 8, 0x14, 0x22, 0x41], 'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
  'M': [0x7f, 2, 0xc, 2, 0x7f], 'N': [0x7f, 4, 8, 0x10, 0x7f], 'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
  'P': [0x7f, 9, 9, 9, 6], 'Q': [0x3e, 0x41, 0x51, 0x21, 0x5e], 'R': [0x7f, 9, 0x19, 0x29, 0x46],
  'S': [0x46, 0x49, 0x49, 0x49, 0x31], 'T': [1, 1, 0x7f, 1, 1], 'U': [0x3f, 0x40, 0x40, 0x40, 0x3f],
  'V': [0x1f, 0x20, 0x40, 0x20, 0x1f], 'W': [0x3f, 0x40, 0x38, 0x40, 0x3f], 'X': [0x63, 0x14, 8, 0x14, 0x63],
  'Y': [7, 8, 0x70, 8, 7], 'Z': [0x61, 0x51, 0x49, 0x45, 0x43], '[': [0, 0x7f, 0x41, 0x41, 0],
  '\\': [2, 4, 8, 0x10, 0x20], ']': [0, 0x41, 0x41, 0x7f, 0], '^': [4, 2, 1, 2, 4], '_': [0x40, 0x40, 0x40, 0x40, 0x40],
  '`': [0, 1, 2, 4, 0], 'a': [0x20, 0x54, 0x54, 0x54, 0x78], 'b': [0x7f, 0x48, 0x44, 0x44, 0x38],
  'c': [0x38, 0x44, 0x44, 0x44, 0x20], 'd': [0x38, 0x44, 0x44, 0x48, 0x7f], 'e': [0x38, 0x54, 0x54, 0x54, 0x18],
  'f': [8, 0x7e, 9, 1, 2], 'g': [0xc, 0x52, 0x52, 0x52, 0x3e], 'h': [0x7f, 8, 4, 4, 0x78],
  'i': [0, 0x44, 0x7d, 0x40, 0], 'j': [0x20, 0x40, 0x44, 0x3d, 0], 'k': [0x7f, 0x10, 0x28, 0x44, 0],
  'l': [0, 0x41, 0x7f, 0x40, 0], 'm': [0x7c, 4, 0x18, 4, 0x78], 'n': [0x7c, 8, 4, 4, 0x78],
  'o': [0x38, 0x44, 0x44, 0x44, 0x38], 'p': [0x7c, 0x14, 0x14, 0x14, 8], 'q': [8, 0x14, 0x14, 0x18, 0x7c],
  'r': [0x7c, 8, 4, 4, 8], 's': [0x48, 0x54, 0x54, 0x54, 0x20], 't': [4, 0x3f, 0x44, 0x40, 0x20],
  'u': [0x3c, 0x40, 0x40, 0x20, 0x7c], 'v': [0x1c, 0x20, 0x40, 0x20, 0x1c], 'w': [0x3c, 0x40, 0x30, 0x40, 0x3c],
  'x': [0x44, 0x28, 0x10, 0x28, 0x44], 'y': [0xc, 0x50, 0x50, 0x50, 0x3c], 'z': [0x44, 0x64, 0x54, 0x4c, 0x44],
  '{': [0, 8, 0x36, 0x41, 0], '|': [0, 0, 0x7f, 0, 0], '}': [0, 0x41, 0x36, 8, 0], '~': [0x10, 8, 8, 0x10, 8],
};

/** Fallback font exposing the same interface subset as TrueTypeFont (glyphIndex/advanceWidth/glyphContoursFlat). */
export class BitmapFont {
  constructor() {
    this.unitsPerEm = 1000;
    this.ascender = 1000; // 7 rows * (1000/7) -> we scale so the 7 rows fill 0..1000
    this.descender = 0;
    this.name = 'builtin-5x7';
    this.cell = 1000 / 7;
    this.chars = Object.keys(BITMAP57);
  }
  glyphIndex(cp) { const ch = String.fromCodePoint(cp); const i = this.chars.indexOf(ch); return i < 0 ? this.chars.indexOf('?') + 1 : i + 1; }
  advanceWidth(gid) { return this.cell * 6; }
  glyphContoursFlat(gid) {
    const cols = BITMAP57[this.chars[gid - 1]] || BITMAP57['?'];
    const out = [];
    const c = this.cell;
    for (let x = 0; x < 5; x++) {
      const bits = cols[x];
      // merge vertical runs into rectangles
      let y = 0;
      while (y < 7) {
        if (!(bits & (1 << y))) { y++; continue; }
        let y2 = y;
        while (y2 < 7 && (bits & (1 << y2))) y2++;
        // rows y..y2-1 ; top row y -> font y = (7 - y) * c (Y up)
        const top = (7 - y) * c, bottom = (7 - y2) * c;
        out.push([x * c, bottom, (x + 1) * c, bottom, (x + 1) * c, top, x * c, top]);
        y = y2;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    return c;
  }
  throw new Error('no canvas available');
}

/**
 * Font backed by the Canvas 2D API (browser). Text is measured with measureText() and rasterised with fillText().
 * Besides the outline interface (glyphIndex/advanceWidth/glyphContoursFlat, delegated to a bitmap fallback), it exposes
 * measureText()/rasterizeText(), which the texture painter prefers when present.
 */
export class CanvasFont {
  /**
   * @param {string} family CSS font family, e.g. 'sans-serif', 'monospace', 'Arial'
   * @param {boolean} bold
   */
  constructor(family = 'sans-serif', bold = true) {
    this.family = family || 'sans-serif';
    this.bold = bold;
    this.name = `${this.family}${bold ? ' Bold' : ''}`;
    // nominal metrics; only used if someone calls layoutText() on this font
    this.unitsPerEm = 1000; this.ascender = 800; this.descender = -200;
    this.canvas = createCanvas(256, 64);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('2D canvas context unavailable');
    this.fallback = new BitmapFont();
  }
  fontString(size) { return `${this.bold ? 'bold ' : ''}${size}px ${this.family}`; }
  glyphIndex(cp) { return this.fallback.glyphIndex(cp); }
  advanceWidth(gid) { return this.fallback.advanceWidth(gid); }
  glyphContoursFlat(gid) { return this.fallback.glyphContoursFlat(gid); }

  /**
   * Measure a string at `size` px. Returns {width, ascent, descent, height, ink}; `ink` is the tight ink box
   * relative to the pen origin (baseline start), y down (same frame as layoutText()).
   */
  measureText(text, size) {
    const ctx = this.ctx;
    ctx.font = this.fontString(size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const m = ctx.measureText(text);
    const left = m.actualBoundingBoxLeft != null ? m.actualBoundingBoxLeft : 0;
    const right = m.actualBoundingBoxRight != null ? m.actualBoundingBoxRight : m.width;
    const asc = m.actualBoundingBoxAscent != null ? m.actualBoundingBoxAscent : size * 0.8;
    const desc = m.actualBoundingBoxDescent != null ? m.actualBoundingBoxDescent : size * 0.2;
    return { width: m.width, ascent: asc, descent: desc, height: asc + desc, ink: { minX: -left, minY: -asc, maxX: right, maxY: desc } };
  }

  /**
   * Rasterise a string into a coverage bitmap that covers its ink box (1 px padding).
   * @returns {{data: Uint8ClampedArray, width: number, height: number, offsetX: number, offsetY: number}}
   *          data holds one alpha value per pixel; blit the bitmap at (inkLeft + offsetX, inkTop + offsetY).
   */
  rasterizeText(text, size, ink) {
    const w = Math.max(1, Math.ceil(ink.maxX - ink.minX) + 2), h = Math.max(1, Math.ceil(ink.maxY - ink.minY) + 2);
    const canvas = this.canvas, ctx = this.ctx;
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.font = this.fontString(size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, 1 - ink.minX, 1 - ink.minY);
    const img = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0, n = w * h; i < n; i++) alpha[i] = img[i * 4 + 3];
    return { data: alpha, width: w, height: h, offsetX: -1, offsetY: -1 };
  }
}

/**
 * Resolve a font for the browser build. `name` is a CSS font family (or a TrueTypeFont / CanvasFont instance,
 * or an ArrayBuffer/Uint8Array holding a .ttf, which is parsed). Falls back to the built-in bitmap font when no
 * canvas is available.
 */
export function loadFont(name, bold = true, { quiet = false } = {}) {
  if (name && typeof name === 'object') {
    if (typeof name.glyphContoursFlat === 'function' || typeof name.rasterizeText === 'function') return name;
    if (name instanceof ArrayBuffer) return new TrueTypeFont(new Uint8Array(name));
    if (name instanceof Uint8Array) return new TrueTypeFont(name);
  }
  try {
    return new CanvasFont(typeof name === 'string' && name ? name : 'sans-serif', bold);
  } catch (e) {
    if (!quiet) console.error('[surfstamp] no canvas available; using built-in bitmap font', e);
    return new BitmapFont();
  }
}

/**
 * Lay out a string. Returns {contours, width, height, ascent, descent} where contours are flat [x,y,...]
 * arrays in pixel units with origin at the text baseline start, Y DOWN (image convention).
 * @param {TrueTypeFont|BitmapFont} font
 * @param {string} text
 * @param {number} size pixel size (em height)
 */
export function layoutText(font, text, size) {
  const scale = size / font.unitsPerEm;
  const contours = [];
  let pen = 0;
  const tol = Math.max(0.5, font.unitsPerEm / size * 0.3); // in font units so that pixel error ~0.3
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const gid = font.glyphIndex(cp);
    const gcs = font.glyphContoursFlat(gid, tol);
    for (const c of gcs) {
      const f = new Array(c.length);
      for (let i = 0; i < c.length; i += 2) { f[i] = (c[i] + pen) * scale; f[i + 1] = -c[i + 1] * scale; }
      contours.push(f);
    }
    pen += font.advanceWidth(gid);
  }
  const ascent = font.ascender * scale, descent = -font.descender * scale;
  return { contours, width: pen * scale, ascent, descent, height: ascent + descent };
}

/** Measure the tight ink bounding box of laid-out text (in the layout's coordinate frame). */
export function inkBounds(layout) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of layout.contours) for (let i = 0; i < c.length; i += 2) {
    if (c[i] < minX) minX = c[i]; if (c[i] > maxX) maxX = c[i];
    if (c[i + 1] < minY) minY = c[i + 1]; if (c[i + 1] > maxY) maxY = c[i + 1];
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Transform contours: rotate by angle (radians, counter-clockwise in image coords means visually clockwise) and translate. */
export function transformContours(contours, tx, ty, angle = 0, sx = 1, sy = 1) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return contours.map(cont => {
    const o = new Array(cont.length);
    for (let i = 0; i < cont.length; i += 2) {
      const x = cont[i] * sx, y = cont[i + 1] * sy;
      o[i] = x * c - y * s + tx;
      o[i + 1] = x * s + y * c + ty;
    }
    return o;
  });
}
