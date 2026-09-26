// Core UV unwrapping of one disk-topology face group ("グループ展開アルゴリズム").
//
//  1. the single boundary loop is laid on a circle, angle proportional to 3D arc length, the vertex
//     nearest the "up" point at the top; radii are then warped by the geodesic distance to the centre vertex
//  2. the centre vertex (deepest vertex = farthest from the outline) sits at the circle centre
//  3. interior vertices are placed by a wave-front march from the outline toward the centre: each vertex
//     lies on the straight segment(s) from its already-placed neighbours to the centre, at a position
//     proportional to the 3D edge length over the neighbour's remaining geodesic distance
//     ("線上パス点配置"); several estimates are averaged
//  4. relaxation: every vertex is moved to the mean of the rigid third-point predictions of its incident
//     triangles ("三角形配置アルゴリズム" + averaging over shared vertices)
//  5. flipped faces are repaired locally (Tutte re-embedding of the flipped neighbourhood with a fixed rim),
//     with a global convex Tutte embedding as the guaranteed fallback
//  6. scale refinement shrinks the largest faces toward the small-face scale while keeping the outline valid
import { v2 } from '../vec.js';
import { MinHeap } from './heap.js';

/**
 * Third point C of triangle (A,B,C) on the LEFT of A->B given target edge lengths.
 * l12 = |AB| target, l23 = |BC|, l31 = |CA|. Lengths are rescaled to the actual |AB|.
 */
export function thirdPoint(A, B, l12, l23, l31) {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  let l = Math.hypot(dx, dy);
  if (l < 1e-12 || l12 <= 0) return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const k = l / l12;
  let b = l23 * k, c = l31 * k;
  // triangle inequality repair
  if (l * 1.001 > b + c) { const pad = (l - b - c) / 2 + Math.min(0.1 * l, l / 10); b += pad; c += pad; }
  if (b >= l + c) b = l + c - Math.min(l, c) * 0.1;
  if (c >= l + b) c = l + b - Math.min(l, b) * 0.1;
  const along = (c * c + l * l - b * b) / (2 * l);
  const h = Math.sqrt(Math.max(0, c * c - along * along));
  const ux = dx / l, uy = dy / l;
  return [A[0] + along * ux - h * uy, A[1] + along * uy + h * ux];
}

/** Per-face target scale (uv perimeter / 3D perimeter), computed once per relaxation pass. */
function faceScales(wm, faceList) {
  const s = new Map();
  for (const fi of faceList) s.set(fi, wm.faceScale(fi));
  return s;
}

/**
 * Relaxation pass(es): each vertex becomes the mean of {current, predictions of incident faces}.
 * @param {Set<number>} [fixed] vertices that must not move
 * @param {Map<number,number>} [targetScale] per-face scale to use for predictions (default: current)
 */
export function relax(wm, faceList, topo, iterations = 1, { fixed = null, targetScale = null, onlyVertices = null } = {}) {
  const V = wm.vertices, U = wm.uv, F = wm.faces;
  const verts = onlyVertices ? Array.from(onlyVertices) : Array.from(topo.vertexFaces.keys());
  for (let it = 0; it < iterations; it++) {
    const scales = targetScale || faceScales(wm, faceList);
    for (const v of verts) {
      if (fixed && fixed.has(v)) continue;
      const cur = U[v];
      if (!cur) continue;
      let sx = cur[0], sy = cur[1], n = 1;
      for (const fi of topo.facesOnVertex(v)) {
        const f = F[fi];
        const iv = f.indexOf(v);
        const a = f[(iv + 1) % 3], b = f[(iv + 2) % 3]; // (v, a, b) is CCW -> v is left of a->b
        const A = U[a], B = U[b];
        if (!A || !B) continue;
        const sc = scales.get(fi) || 1;
        const lab = wm.edgeLength(a, b) * sc, lbv = wm.edgeLength(b, v) * sc, lva = wm.edgeLength(v, a) * sc;
        const p = thirdPoint(A, B, lab, lbv, lva);
        if (!isFinite(p[0]) || !isFinite(p[1])) continue;
        sx += p[0]; sy += p[1]; n++;
      }
      cur[0] = sx / n; cur[1] = sy / n;
    }
  }
}

/**
 * Tutte (barycentric) embedding: interior vertices at the average of their neighbours, boundary fixed.
 * Solved with conjugate gradients on the (SPD) graph Laplacian.
 */
export function tutteSolve(wm, topo, fixed, { iterations = 2000, tol = 1e-7 } = {}) {
  const verts = Array.from(topo.vertexFaces.keys()).filter(v => !fixed.has(v));
  if (!verts.length) return;
  const idx = new Map(verts.map((v, i) => [v, i]));
  const n = verts.length;
  const nb = verts.map(v => topo.vertexNeighbors(v));
  const deg = nb.map(l => l.length);
  const U = wm.uv;
  for (let dim = 0; dim < 2; dim++) {
    // A x = b with A = I - D^-1 W (interior), b = D^-1 * sum of fixed neighbours. Use symmetric form D - W.
    const b = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const w of nb[i]) if (fixed.has(w)) s += U[w][dim];
      b[i] = s;
      x[i] = U[verts[i]] ? U[verts[i]][dim] : 0;
    }
    const Ax = (vec, out) => {
      for (let i = 0; i < n; i++) {
        let s = deg[i] * vec[i];
        for (const w of nb[i]) { const j = idx.get(w); if (j != null) s -= vec[j]; }
        out[i] = s;
      }
    };
    const r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    Ax(x, Ap);
    let rr = 0;
    for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; p[i] = r[i]; rr += r[i] * r[i]; }
    const bnorm = Math.sqrt(b.reduce((s, v) => s + v * v, 0)) || 1;
    for (let it = 0; it < iterations && Math.sqrt(rr) > tol * bnorm; it++) {
      Ax(p, Ap);
      let pAp = 0;
      for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
      if (pAp <= 0) break;
      const alpha = rr / pAp;
      let rr2 = 0;
      for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rr2 += r[i] * r[i]; }
      const beta = rr2 / rr;
      rr = rr2;
      for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    }
    for (let i = 0; i < n; i++) { if (!U[verts[i]]) U[verts[i]] = [0, 0]; U[verts[i]][dim] = x[i]; }
  }
}

export function flippedFaces(wm, faceList) {
  const out = [];
  for (const fi of faceList) if (wm.isFlipped(fi)) out.push(fi);
  return out;
}

/** k rings of faces around `seed` faces (by shared vertex), restricted to topo's subset. */
export function growRings(wm, topo, seed, rings) {
  const set = new Set(seed);
  let frontier = Array.from(seed);
  for (let r = 0; r < rings; r++) {
    const next = [];
    for (const fi of frontier) for (const v of wm.faces[fi]) for (const g of topo.facesOnVertex(v)) if (!set.has(g)) { set.add(g); next.push(g); }
    frontier = next;
    if (!frontier.length) break;
  }
  return set;
}

function snapshotUV(wm, verts) { const m = new Map(); for (const v of verts) if (wm.uv[v]) m.set(v, wm.uv[v].slice()); return m; }
function restoreUV(wm, snap) { for (const [v, p] of snap) { wm.uv[v][0] = p[0]; wm.uv[v][1] = p[1]; } }

/**
 * Try to repair flipped faces locally: re-embed the flipped neighbourhood with Tutte while its rim stays fixed.
 * Returns remaining flipped faces.
 */
export function repairFlips(wm, faceList, topo, outlineVerts, { maxRounds = 6 } = {}) {
  let flipped = flippedFaces(wm, faceList);
  const faceSet = new Set(faceList);
  for (let round = 0; round < maxRounds && flipped.length; round++) {
    const rings = [2, 3, 5, 8, 12, 17, 25, 40][Math.min(round, 7)];
    const region = growRings(wm, topo, flipped, rings);
    const regionVerts = new Set();
    for (const fi of region) for (const v of wm.faces[fi]) regionVerts.add(v);
    // rim = vertices of the region touching faces outside the region, plus outline vertices
    const fixed = new Set();
    for (const v of regionVerts) {
      if (outlineVerts.has(v)) { fixed.add(v); continue; }
      for (const g of topo.facesOnVertex(v)) if (faceSet.has(g) && !region.has(g)) { fixed.add(v); break; }
    }
    const before = snapshotUV(wm, regionVerts);
    const sub = wm.topo(Array.from(region));
    tutteSolve(wm, sub, fixed);
    const regionList = Array.from(region);
    let nowFlipped = flippedFaces(wm, regionList);
    if (nowFlipped.length === 0) {
      // gentle relaxation inside the region, keeping the rim fixed; accept only if no flips reappear
      const snap = snapshotUV(wm, regionVerts);
      relax(wm, regionList, sub, 3, { fixed });
      if (flippedFaces(wm, regionList).length) restoreUV(wm, snap);
    } else if (nowFlipped.length >= flipped.length) {
      restoreUV(wm, before);
    }
    flipped = flippedFaces(wm, faceList);
  }
  return flipped;
}

/**
 * Detect overlapping (non-adjacent) faces in uv space. Returns array of face indices involved.
 */
export function findOverlaps(wm, faceList, { maxPairs = 200000 } = {}) {
  const U = wm.uv, F = wm.faces;
  const b = wm.uvBounds(faceList);
  if (!isFinite(b.width) || b.width <= 0 || b.height <= 0) return [];
  const n = faceList.length;
  const cellsPerAxis = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n))));
  const cw = b.width / cellsPerAxis + 1e-9, ch = b.height / cellsPerAxis + 1e-9;
  const grid = new Map();
  const tri = new Map();
  for (const fi of faceList) {
    const f = F[fi];
    const t = [U[f[0]], U[f[1]], U[f[2]]];
    if (!t[0] || !t[1] || !t[2]) continue;
    tri.set(fi, t);
    const x0 = Math.floor((Math.min(t[0][0], t[1][0], t[2][0]) - b.minX) / cw), x1 = Math.floor((Math.max(t[0][0], t[1][0], t[2][0]) - b.minX) / cw);
    const y0 = Math.floor((Math.min(t[0][1], t[1][1], t[2][1]) - b.minY) / ch), y1 = Math.floor((Math.max(t[0][1], t[1][1], t[2][1]) - b.minY) / ch);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x * 65536 + y;
      let l = grid.get(k); if (!l) { l = []; grid.set(k, l); } l.push(fi);
    }
  }
  const bad = new Set();
  const tested = new Set();
  let pairs = 0;
  for (const [, l] of grid) {
    if (l.length < 2) continue;
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const a = l[i], c = l[j];
      const key = a < c ? a * 4294967296 + c : c * 4294967296 + a;
      if (tested.has(key)) continue;
      tested.add(key);
      if (++pairs > maxPairs) return Array.from(bad);
      const fa = F[a], fc = F[c];
      if (fa.includes(fc[0]) || fa.includes(fc[1]) || fa.includes(fc[2])) continue; // adjacent
      if (trianglesOverlapStrict(tri.get(a), tri.get(c))) { bad.add(a); bad.add(c); }
    }
  }
  return Array.from(bad);
}

function trianglesOverlapStrict(t1, t2) {
  // separating axis test with a relative tolerance so touching triangles don't count
  const tris = [t1, t2];
  let scale = 0;
  for (const t of tris) for (const p of t) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * (scale + 1);
  for (let t = 0; t < 2; t++) {
    const tri = tris[t];
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const nx = -(b[1] - a[1]), ny = b[0] - a[0];
      const nl = Math.hypot(nx, ny) || 1;
      let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
      for (const p of t1) { const v = (p[0] * nx + p[1] * ny) / nl; if (v < min1) min1 = v; if (v > max1) max1 = v; }
      for (const p of t2) { const v = (p[0] * nx + p[1] * ny) / nl; if (v < min2) min2 = v; if (v > max2) max2 = v; }
      if (max1 - min2 <= eps || max2 - min1 <= eps) return false;
    }
  }
  return true;
}

/** Median of numbers (trimmed 5% each side when > 20 entries). */
export function trimmedMedian(values) {
  const s = values.filter(x => isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 1;
  let lo = 0, hi = s.length;
  if (s.length > 20) { const t = Math.floor(s.length * 0.05); lo = t; hi = s.length - t; }
  return s[Math.floor((lo + hi) / 2)];
}

/** Scale all uv of faceList so that the median face scale becomes 1 (uv unit = Angstrom). */
export function normalizeScale(wm, faceList) {
  const m = trimmedMedian(faceList.map(fi => wm.faceScale(fi)));
  if (m > 0 && isFinite(m)) wm.scaleUV(faceList, 1 / m);
}

/** Shrink the uv of a face set toward their common centroid by `ratio`. */
function shrinkFaces(wm, faces, ratio) {
  const vs = new Set();
  for (const fi of faces) for (const v of wm.faces[fi]) if (wm.uv[v]) vs.add(v);
  if (!vs.size) return;
  let cx = 0, cy = 0;
  for (const v of vs) { cx += wm.uv[v][0]; cy += wm.uv[v][1]; }
  cx /= vs.size; cy /= vs.size;
  for (const v of vs) { const u = wm.uv[v]; u[0] = cx + (u[0] - cx) * ratio; u[1] = cy + (u[1] - cy) * ratio; }
}

/**
 * Scale refinement: reduce the disparity between large and small faces (keeps letters from being distorted).
 * Every cycle is rolled back if it introduces flipped faces.
 */
export function refineScales(wm, faceList, topo, cycles = 5) {
  if (faceList.length < 5) return;
  const verts = Array.from(topo.vertexFaces.keys());
  for (let c = 0; c < cycles; c++) {
    const before = snapshotUV(wm, verts);
    const flippedBefore = flippedFaces(wm, faceList).length;
    // A) largest 60% shrunk toward the 90th-percentile (small) scale
    let scaled = faceList.map(fi => [fi, wm.faceScale(fi)]).sort((a, b) => b[1] - a[1]);
    const s90 = scaled[Math.min(scaled.length - 1, Math.floor(scaled.length * 0.9))][1];
    for (let i = 0; i < Math.floor(scaled.length * 0.6); i++) {
      const [fi, s] = scaled[i];
      if (s <= 0) continue;
      shrinkFaces(wm, [fi], Math.max(0.05, s90 / s));
    }
    relax(wm, faceList, topo, 2);
    // B) largest 10% with neighbourhoods
    scaled = faceList.map(fi => [fi, wm.faceScale(fi)]).sort((a, b) => b[1] - a[1]);
    const used = new Set();
    const rings = Math.min(10, Math.max(1, Math.floor(faceList.length / 10)));
    for (let i = 0; i < Math.floor(scaled.length * 0.1); i++) {
      const [fi, s] = scaled[i];
      if (used.has(fi) || s <= 0) continue;
      const nbh = growRings(wm, topo, [fi], Math.min(rings, 3));
      for (const g of nbh) used.add(g);
      shrinkFaces(wm, nbh, Math.max(0.8, s90 / s));
    }
    relax(wm, faceList, topo, 2);
    normalizeScale(wm, faceList);
    if (flippedFaces(wm, faceList).length > flippedBefore) { restoreUV(wm, before); normalizeScale(wm, faceList); break; }
  }
  relax(wm, faceList, topo, 2);
}

/**
 * Unwrap a disk-topology face group. The group must have exactly one boundary loop.
 * @param {object} opts
 * @param {[number,number,number]} [opts.upPoint] 3D point that should end up at the top of the island
 * @param {number} [opts.relaxIterations=8]
 * @returns {{ok:boolean, flipped:number[], overlaps:number[], outline:number[], center:number}}
 */
export function unwrapDisk(wm, faceList, opts = {}) {
  const topo = wm.topo(faceList);
  const loops = topo.boundaryLoops();
  if (loops.length !== 1) return { ok: false, flipped: faceList.slice(), overlaps: [], reason: `expected 1 boundary loop, got ${loops.length}` };
  const outline = loops[0];
  const n = outline.length;
  const V = wm.vertices;
  // arc lengths
  const seg = new Float64Array(n);
  let L = 0;
  for (let i = 0; i < n; i++) { seg[i] = wm.edgeLength(outline[i], outline[(i + 1) % n]); L += seg[i]; }
  if (L <= 0) return { ok: false, flipped: faceList.slice(), overlaps: [], reason: 'degenerate outline' };
  // top vertex: nearest to upPoint, or max 3D y
  let top = 0, best = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = V[outline[i]];
    const score = opts.upPoint ? -Math.hypot(p[0] - opts.upPoint[0], p[1] - opts.upPoint[1], p[2] - opts.upPoint[2]) : p[1];
    if (score > best) { best = score; top = i; }
  }
  const radius = L / (2 * Math.PI);
  const outlineSet = new Set(outline);
  // centre vertex: farthest from the outline
  const fromOutline = wm.dijkstra(outline, topo);
  let center = outline[0], cd = -1;
  for (const [v, d] of fromOutline.dist) if (d > cd) { cd = d; center = v; }
  const toCenter = wm.dijkstra([center], topo);
  // outline on the circle (counter-clockwise, top at +90deg), radius warped by geodesic distance to the centre
  let maxDc = 0;
  for (const v of outline) maxDc = Math.max(maxDc, toCenter.dist.get(v) || 0);
  let s = 0;
  const radii = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = (top + k) % n;
    const ang = Math.PI / 2 + (2 * Math.PI * s) / L;
    const dc = toCenter.dist.get(outline[i]);
    radii[i] = maxDc > 0 && dc != null ? radius * Math.max(0.2, dc / maxDc) : radius;
    wm.uv[outline[i]] = [radii[i] * Math.cos(ang), radii[i] * Math.sin(ang)];
    s += seg[i];
  }
  // smooth the outline polygon (symmetric moving average)
  const window = Math.max(2, Math.floor(n / 50)), passes = Math.min(Math.floor(n / 50) + 1, 5);
  for (let p = 0; p < passes; p++) {
    const src = outline.map(v => wm.uv[v].slice());
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, c = 0;
      for (let j = -(window - 1); j <= window - 1; j++) { const q = src[(i + j + n) % n]; sx += q[0]; sy += q[1]; c++; }
      wm.uv[outline[i]][0] = sx / c; wm.uv[outline[i]][1] = sy / c;
    }
  }
  const circleUV = new Map(); // pure convex circle positions, for the guaranteed fallback
  s = 0;
  for (let k = 0; k < n; k++) {
    const i = (top + k) % n;
    const ang = Math.PI / 2 + (2 * Math.PI * s) / L;
    circleUV.set(outline[i], [radius * Math.cos(ang), radius * Math.sin(ang)]);
    s += seg[i];
  }
  // interior: wave-front from the outline toward the centre
  const interior = [];
  for (const [v, d] of fromOutline.dist) if (!outlineSet.has(v)) interior.push([v, d]);
  interior.sort((a, b) => a[1] - b[1]);
  for (const v of interior) wm.uv[v[0]] = null;
  for (const [v] of interior) {
    let sx = 0, sy = 0, c = 0;
    for (const u of topo.vertexNeighbors(v)) {
      const U = wm.uv[u];
      if (!U) continue;
      const du = toCenter.dist.get(u);
      const m = wm.edgeLength(u, v);
      const t = du > 0 ? Math.min(1, m / du) : 1;
      sx += U[0] * (1 - t); sy += U[1] * (1 - t); c++;
    }
    if (c === 0) { const pu = fromOutline.prev.get(v); const U = pu != null && wm.uv[pu] ? wm.uv[pu] : [0, 0]; sx = U[0] * 0.5; sy = U[1] * 0.5; c = 1; }
    wm.uv[v] = [sx / c, sy / c];
  }
  if (!outlineSet.has(center)) wm.uv[center] = [0, 0];
  // relaxation
  const iters = opts.relaxIterations ?? 8;
  relax(wm, faceList, topo, iters, { fixed: outlineSet });
  relax(wm, faceList, topo, 2);
  let flipped = repairFlips(wm, faceList, topo, outlineSet);
  let usedFallback = false;
  if (flipped.length) {
    // guaranteed fallback: convex circle + Tutte
    for (const [v, p] of circleUV) wm.uv[v] = p.slice();
    tutteSolve(wm, topo, outlineSet);
    usedFallback = true;
    flipped = flippedFaces(wm, faceList);
    if (!flipped.length) {
      // improve shapes while never accepting flips
      for (let k = 0; k < 4; k++) {
        const snap = snapshotUV(wm, Array.from(topo.vertexFaces.keys()));
        relax(wm, faceList, topo, 2, { fixed: outlineSet });
        if (flippedFaces(wm, faceList).length) { restoreUV(wm, snap); break; }
      }
    }
  }
  if (!flipped.length) {
    refineScales(wm, faceList, topo, opts.refineCycles ?? 5);
    flipped = flippedFaces(wm, faceList);
    if (flipped.length) flipped = repairFlips(wm, faceList, topo, outlineSet, { maxRounds: 3 });
  }
  normalizeScale(wm, faceList);
  const overlaps = flipped.length ? [] : findOverlaps(wm, faceList);
  return { ok: flipped.length === 0 && overlaps.length === 0, flipped, overlaps, outline, center, usedFallback };
}

/**
 * Guaranteed embedding: the outline goes on a circle (arc-length parametrised, top vertex kept) and the interior is
 * solved by Tutte's barycentric mapping. Returns the outline vertex set.
 */
export function convexTutteEmbedding(wm, faceList, topo, outline, topIndex = 0) {
  const n = outline.length;
  let L = 0;
  const seg = new Float64Array(n);
  for (let i = 0; i < n; i++) { seg[i] = wm.edgeLength(outline[i], outline[(i + 1) % n]); L += seg[i]; }
  const radius = L / (2 * Math.PI);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const i = (topIndex + k) % n;
    const ang = Math.PI / 2 + (2 * Math.PI * s) / L;
    wm.uv[outline[i]] = [radius * Math.cos(ang), radius * Math.sin(ang)];
    s += seg[i];
  }
  const outlineSet = new Set(outline);
  tutteSolve(wm, topo, outlineSet);
  return outlineSet;
}
