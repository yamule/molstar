// Pure-JS RGBA raster canvas with anti-aliased polygon filling.
// Paths are arrays of contours; each contour is a flat array [x0,y0,x1,y1,...] in pixel coordinates
// (pixel (i,j) covers [i,i+1) x [j,j+1)). Y grows downward (image convention).

const SUBSAMPLES = 4; // vertical subsamples per pixel row; horizontal coverage is exact.

export class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this._cov = new Float32Array(width + 2);
    this._xs = []; // reusable crossing buffer
  }

  clear(r, g, b, a = 255) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
  }

  getPixel(x, y) {
    const o = (y * this.width + x) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }

  setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = a;
  }

  blendPixel(x, y, r, g, b, alpha) {
    if (alpha <= 0) return;
    const o = (y * this.width + x) * 4;
    const d = this.data;
    if (alpha >= 1) { d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; return; }
    const ia = 1 - alpha;
    d[o] = d[o] * ia + r * alpha;
    d[o + 1] = d[o + 1] * ia + g * alpha;
    d[o + 2] = d[o + 2] * ia + b * alpha;
    d[o + 3] = Math.min(255, d[o + 3] * ia + 255 * alpha);
  }

  /**
   * Fill a path.
   * @param {number[][]} contours
   * @param {number[]} color [r,g,b] (0-255)
   * @param {{rule?:'nonzero'|'evenodd', alpha?:number, antialias?:boolean}} opts
   */
  fillPath(contours, color, opts = {}) {
    const rule = opts.rule || 'nonzero';
    const galpha = opts.alpha == null ? 1 : opts.alpha;
    const aa = opts.antialias !== false;
    const S = aa ? SUBSAMPLES : 1;
    // Build edge list
    const edges = []; // {x0,y0,x1,y1,dir}
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const c of contours) {
      const n = c.length >> 1;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = c[2 * i], y0 = c[2 * i + 1], x1 = c[2 * j], y1 = c[2 * j + 1];
        if (y0 === y1) continue;
        if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) continue;
        if (y0 < y1) edges.push({ x0, y0, x1, y1, dir: 1 });
        else edges.push({ x0: x1, y0: y1, x1: x0, y1: y0, dir: -1 });
        if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0;
        if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
        if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0;
        if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
      }
    }
    if (edges.length === 0) return;
    const W = this.width, H = this.height;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(H - 1, Math.ceil(maxY));
    const xStartPx = Math.max(0, Math.floor(minX));
    const xEndPx = Math.min(W - 1, Math.ceil(maxX));
    if (yStart > yEnd || xStartPx > xEndPx) return;
    edges.sort((a, b) => a.y0 - b.y0);
    const cov = this._cov;
    const [r, g, b] = color;
    let edgeIdx = 0;
    const active = [];
    const xs = this._xs;
    for (let py = yStart; py <= yEnd; py++) {
      cov.fill(0, xStartPx, xEndPx + 2);
      let any = false;
      for (let s = 0; s < S; s++) {
        const sy = py + (s + 0.5) / S;
        // add newly active edges
        while (edgeIdx < edges.length && edges[edgeIdx].y0 <= sy) { active.push(edges[edgeIdx]); edgeIdx++; }
        // compute crossings
        xs.length = 0;
        for (let k = active.length - 1; k >= 0; k--) {
          const e = active[k];
          if (e.y1 <= sy) { active[k] = active[active.length - 1]; active.pop(); continue; }
          if (e.y0 > sy) continue;
          const t = (sy - e.y0) / (e.y1 - e.y0);
          xs.push({ x: e.x0 + (e.x1 - e.x0) * t, d: e.dir });
        }
        if (xs.length < 2) continue;
        xs.sort((a, c) => a.x - c.x);
        let wind = 0;
        for (let k = 0; k < xs.length - 1; k++) {
          wind += rule === 'nonzero' ? xs[k].d : 1;
          const inside = rule === 'nonzero' ? wind !== 0 : (wind & 1) === 1;
          if (!inside) continue;
          let xa = xs[k].x, xb = xs[k + 1].x;
          if (xb <= xa) continue;
          if (xa < 0) xa = 0; if (xb > W) xb = W;
          if (xb <= xa) continue;
          any = true;
          if (!aa) { xa = Math.round(xa); xb = Math.round(xb); if (xb <= xa) continue; }
          const ia = Math.floor(xa), ib = Math.floor(xb);
          if (ia === ib) { cov[ia] += xb - xa; }
          else {
            cov[ia] += ia + 1 - xa;
            for (let x = ia + 1; x < ib; x++) cov[x] += 1;
            if (ib < W) cov[ib] += xb - ib;
          }
        }
      }
      if (!any) { if (edgeIdx >= edges.length && active.length === 0) break; continue; }
      const rowOff = py * W;
      for (let x = xStartPx; x <= xEndPx; x++) {
        const c = cov[x];
        if (c <= 0) continue;
        let alpha = (c / S) * galpha;
        if (alpha > 1) alpha = 1;
        this.blendPixel(x, py, r, g, b, alpha);
      }
      void rowOff;
    }
  }

  /**
   * Stroke a polyline with given width (round joins/caps), rendered as a union of polygons.
   */
  strokePolyline(points, width, color, opts = {}) {
    const closed = !!opts.closed;
    const contours = strokeToContours(points, width, closed);
    if (contours.length) this.fillPath(contours, color, { rule: 'nonzero', alpha: opts.alpha, antialias: opts.antialias });
  }

  strokeLine(x0, y0, x1, y1, width, color, opts = {}) {
    this.strokePolyline([x0, y0, x1, y1], width, color, opts);
  }

  fillCircle(cx, cy, radius, color, opts = {}) {
    this.fillPath([circleContour(cx, cy, radius)], color, opts);
  }

  /** Nearest-neighbour downscale by integer factor (box filter). */
  downsample(factor) {
    const w = Math.floor(this.width / factor), h = Math.floor(this.height / factor);
    const out = new Raster(w, h);
    const src = this.data, dst = out.data;
    const n = factor * factor;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < factor; dy++) {
          let o = ((y * factor + dy) * this.width + x * factor) * 4;
          for (let dx = 0; dx < factor; dx++, o += 4) { r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; }
        }
        const oo = (y * w + x) * 4;
        dst[oo] = r / n; dst[oo + 1] = g / n; dst[oo + 2] = b / n; dst[oo + 3] = a / n;
      }
    }
    return out;
  }
}

export function circleContour(cx, cy, r, segments) {
  const n = segments || Math.max(8, Math.min(64, Math.ceil(r * 2)));
  const c = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c[2 * i] = cx + r * Math.cos(a);
    c[2 * i + 1] = cy + r * Math.sin(a);
  }
  return c;
}

function signedArea(c) {
  let a = 0;
  const n = c.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += c[2 * i] * c[2 * j + 1] - c[2 * j] * c[2 * i + 1];
  }
  return a / 2;
}

function ensureCCW(c) {
  if (signedArea(c) < 0) {
    const n = c.length >> 1;
    const r = new Array(c.length);
    for (let i = 0; i < n; i++) { r[2 * i] = c[2 * (n - 1 - i)]; r[2 * i + 1] = c[2 * (n - 1 - i) + 1]; }
    return r;
  }
  return c;
}

/** Convert a polyline into consistently-oriented contours whose nonzero union is the stroke. */
export function strokeToContours(points, width, closed = false) {
  const hw = width / 2;
  const n = points.length >> 1;
  const contours = [];
  if (n === 0 || hw <= 0) return contours;
  if (n === 1) { contours.push(circleContour(points[0], points[1], hw)); return contours; }
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const x0 = points[2 * i], y0 = points[2 * i + 1], x1 = points[2 * j], y1 = points[2 * j + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len * hw, ny = dx / len * hw;
    contours.push(ensureCCW([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]));
  }
  // round joins and caps
  const joinStart = closed ? 0 : 0;
  const joinEnd = closed ? n : n;
  if (hw > 0.6) {
    for (let i = joinStart; i < joinEnd; i++) contours.push(ensureCCW(circleContour(points[2 * i], points[2 * i + 1], hw)));
  }
  return contours;
}

/** Flatten a quadratic bezier into line points appended to out (excluding start point). */
export function flattenQuad(x0, y0, cx, cy, x1, y1, out, tol = 0.25) {
  const d = Math.hypot(x0 - 2 * cx + x1, y0 - 2 * cy + y1);
  let n = Math.ceil(Math.sqrt(d / tol / 2));
  if (n < 1) n = 1; if (n > 32) n = 32;
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    out.push(mt * mt * x0 + 2 * mt * t * cx + t * t * x1, mt * mt * y0 + 2 * mt * t * cy + t * t * y1);
  }
}

/** Flatten a cubic bezier into line points appended to out (excluding start point). */
export function flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, out, tol = 0.25) {
  const d = Math.hypot(x0 - 2 * c1x + c2x, y0 - 2 * c1y + c2y) + Math.hypot(c1x - 2 * c2x + x1, c1y - 2 * c2y + y1);
  let n = Math.ceil(Math.sqrt(d / tol));
  if (n < 1) n = 1; if (n > 48) n = 48;
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    out.push(
      mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x1,
      mt * mt * mt * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y1,
    );
  }
}
