// Cluster mapping for large groups ("クラスターマッピングアルゴリズム").
//
// Faces are merged into clusters of ~clusterSize faces; every cluster becomes a fan of big pseudo-faces around its
// centroid whose corners are the cluster-junction vertices. The small reduced mesh is unwrapped with the ordinary
// disk algorithm (recursively if still large). The unwrapped big faces then define the outline of every cluster:
// boundary vertices are placed along the unwrapped cluster edges by arc length and interior vertices are embedded
// inside that outline, after which the whole group is relaxed. The pseudo faces are discarded.
import { WorkMesh } from './workmesh.js';
import { MeshTopology, edgeKey } from '../mesh.js';
import { unwrapDisk, relax, tutteSolve, flippedFaces, repairFlips, refineScales, normalizeScale, findOverlaps, convexTutteEmbedding } from './core.js';
import { SurfaceMesh } from '../mesh.js';
import { v3 } from '../vec.js';
import { makeDisk } from './disk.js';

/** Partition faceList into clusters by geodesic Voronoi from farthest-point sampled seed vertices. */
export function makeClusters(wm, faceList, topo, count) {
  const verts = Array.from(topo.vertexFaces.keys());
  if (count <= 1 || verts.length < 4) return [faceList.slice()];
  // farthest point sampling of seeds
  const seeds = [verts[0]];
  let { dist } = wm.dijkstra(seeds, topo);
  for (let k = 1; k < count; k++) {
    let far = -1, fd = -1;
    for (const [v, d] of dist) if (d > fd) { fd = d; far = v; }
    if (far < 0 || fd <= 0) break;
    seeds.push(far);
    const d2 = wm.dijkstra([far], topo).dist;
    for (const [v, d] of d2) if (d < dist.get(v)) dist.set(v, d);
  }
  const { src } = wm.dijkstra(seeds, topo);
  const seedIndex = new Map(seeds.map((s, i) => [s, i]));
  const clusters = seeds.map(() => []);
  const faceCluster = new Map();
  for (const fi of faceList) {
    const f = wm.faces[fi];
    const votes = f.map(v => seedIndex.get(src.get(v)));
    let c = votes[0];
    if (votes[1] === votes[2]) c = votes[1];
    if (c == null) c = votes.find(x => x != null) ?? 0;
    faceCluster.set(fi, c);
    clusters[c].push(fi);
  }
  // split clusters that are not connected
  const out = [];
  for (const cl of clusters) {
    if (!cl.length) continue;
    for (const comp of wm.topo(cl).connectedComponents()) out.push(comp);
  }
  return out;
}

/**
 * Unwrap a large disk-topology group through cluster reduction.
 * Returns the same shape as unwrapDisk.
 */
export function unwrapLarge(wm, faceList, opts = {}) {
  const clusterSize = opts.clusterSize || 30;
  const topo = wm.topo(faceList);
  const loops = topo.boundaryLoops();
  if (loops.length !== 1) return { ok: false, flipped: faceList.slice(), overlaps: [], reason: `expected 1 boundary loop, got ${loops.length}` };
  const outer = loops[0];
  const outerSet = new Set(outer);
  const clusters = makeClusters(wm, faceList, topo, Math.floor(faceList.length / clusterSize) + 1);
  const faceCluster = new Map();
  clusters.forEach((cl, ci) => { for (const fi of cl) faceCluster.set(fi, ci); });
  // vertex -> set of clusters
  const vClusters = new Map();
  for (const fi of faceList) { const c = faceCluster.get(fi); for (const v of wm.faces[fi]) { let s = vClusters.get(v); if (!s) { s = new Set(); vClusters.set(v, s); } s.add(c); } }
  // per cluster: boundary loop(s) (ordered), kept vertices along them
  const clusterInfo = [];
  const kept = new Set();
  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    const ct = wm.topo(cl);
    const rings = ct.boundaryLoops();
    if (!rings.length) { clusterInfo.push(null); continue; }
    let ring = rings[0], bl = -1;
    for (const r of rings) { const l = wm.loopLength(r); if (l > bl) { bl = l; ring = r; } }
    const isJunction = (v) => vClusters.get(v).size >= 3 || (vClusters.get(v).size === 2 && outerSet.has(v));
    let keptIdx = ring.map((v, i) => (isJunction(v) ? i : -1)).filter(i => i >= 0);
    // ensure at least 3 kept vertices, and subdivide long runs (esp. along the outer boundary) so that the outline keeps its shape
    const n = ring.length;
    const extra = new Set(keptIdx);
    if (keptIdx.length < 3) {
      for (let k = 0; k < 3; k++) extra.add(Math.floor((k * n) / 3));
    }
    keptIdx = Array.from(extra).sort((a, b) => a - b);
    const withRuns = new Set(keptIdx);
    for (let k = 0; k < keptIdx.length; k++) {
      const a = keptIdx[k], b = keptIdx[(k + 1) % keptIdx.length];
      const run = (b - a + n) % n || n;
      if (run < 2) continue;
      // subdivision must be identical for the neighbouring cluster that shares this run (reversed direction):
      // compute offsets in a canonical direction (from the smaller vertex id) and mirror if needed
      let outerCount = 0;
      for (let s = 1; s < run; s++) if (outerSet.has(ring[(a + s) % n])) outerCount++;
      let pieces = 2;
      if (outerCount > 0) pieces = Math.max(2, Math.min(6, Math.floor(outerCount / 2) + 1));
      else if (run > 12) pieces = 3;
      const canonical = ring[a] <= ring[b];
      for (let p = 1; p < pieces; p++) {
        let off = Math.floor((run * p) / pieces);
        if (!canonical) off = run - off;
        withRuns.add((a + off) % n);
      }
    }
    keptIdx = Array.from(withRuns).sort((a, b) => a - b);
    for (const i of keptIdx) kept.add(ring[i]);
    clusterInfo.push({ ring, keptIdx });
  }
  // reduced mesh: kept vertices + one centre per cluster, fan triangles
  const rv = []; const rvBase = new Map(); // kept vertex -> reduced index
  const keptList = Array.from(kept);
  keptList.forEach((v, i) => { rv.push(wm.vertices[v]); rvBase.set(v, i); });
  const rf = [];
  const fanOf = []; // reduced face -> cluster
  const centerIndex = [];
  clusterInfo.forEach((info, ci) => {
    if (!info) { centerIndex.push(-1); return; }
    const { ring, keptIdx } = info;
    const pts = keptIdx.map(i => ring[i]);
    const c = rv.length; rv.push(v3.mean(pts.map(v => wm.vertices[v]))); centerIndex.push(c);
    for (let k = 0; k < pts.length; k++) {
      const a = rvBase.get(pts[k]), b = rvBase.get(pts[(k + 1) % pts.length]);
      if (a === b) continue;
      rf.push([a, b, c]); fanOf.push(ci);
    }
  });
  const reducedBase = new SurfaceMesh(rv, rf);
  const rwm = new WorkMesh(reducedBase, rf.map((_, i) => i));
  // the reduced mesh may not be a clean disk (enclosed clusters, pinched rings): repair it like any group
  const rlist = makeDisk(rwm, rwm.liveFaces(), null);
  let rres;
  if (rlist.length > (opts.largeThreshold || 10000)) rres = unwrapLarge(rwm, rlist, opts);
  else rres = unwrapDisk(rwm, rlist, { upPoint: opts.upPoint, refineCycles: 2 });
  if (!rres.ok && rres.flipped.length > rlist.length * 0.2) {
    return { ok: false, flipped: faceList.slice(), overlaps: [], reason: 'reduced mesh unwrap failed' };
  }
  // reduced uv per kept vertex (average over clones)
  const keptUV = new Map();
  for (let i = 0; i < rwm.vertices.length; i++) {
    const base = rwm.vertexBase[i];
    if (base < 0 || base >= keptList.length || !rwm.uv[i]) continue;
    const v = keptList[base];
    const acc = keptUV.get(v);
    if (acc) { acc[0] += rwm.uv[i][0]; acc[1] += rwm.uv[i][1]; acc[2]++; } else keptUV.set(v, [rwm.uv[i][0], rwm.uv[i][1], 1]);
  }
  for (const v of keptList) { const a = keptUV.get(v); if (a) wm.uv[v] = [a[0] / a[2], a[1] / a[2]]; }
  // cluster boundary vertices: along the unwrapped edges by arc length
  const fixed = new Set();
  for (const v of keptList) if (wm.uv[v]) fixed.add(v);
  for (const info of clusterInfo) {
    if (!info) continue;
    const { ring, keptIdx } = info;
    const n = ring.length;
    for (let k = 0; k < keptIdx.length; k++) {
      const a = keptIdx[k], b = keptIdx[(k + 1) % keptIdx.length];
      const A = wm.uv[ring[a]], B = wm.uv[ring[b]];
      if (!A || !B) continue;
      const run = (b - a + n) % n || n;
      let total = 0;
      for (let s = 0; s < run; s++) total += wm.edgeLength(ring[(a + s) % n], ring[(a + s + 1) % n]);
      let acc = 0;
      for (let s = 1; s < run; s++) {
        acc += wm.edgeLength(ring[(a + s - 1) % n], ring[(a + s) % n]);
        const v = ring[(a + s) % n];
        if (fixed.has(v)) continue;
        const t = total > 0 ? acc / total : s / run;
        const p = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
        if (wm.uv[v] && wm.uv[v].__n) { wm.uv[v][0] = (wm.uv[v][0] * wm.uv[v].__n + p[0]) / (wm.uv[v].__n + 1); wm.uv[v][1] = (wm.uv[v][1] * wm.uv[v].__n + p[1]) / (wm.uv[v].__n + 1); wm.uv[v].__n++; }
        else { wm.uv[v] = p; wm.uv[v].__n = 1; }
      }
    }
  }
  for (const v of topo.vertexFaces.keys()) if (wm.uv[v] && wm.uv[v].__n) { delete wm.uv[v].__n; fixed.add(v); }
  // interior vertices of each cluster: barycentric embedding inside the fixed cluster outline
  for (const v of topo.vertexFaces.keys()) if (!fixed.has(v)) wm.uv[v] = null;
  // barycentric embedding with the junction vertices (and the outer boundary) pinned; the arc-length positions of
  // the other cluster-boundary vertices only serve as the initial guess for the relaxation
  {
    const pins = new Set(outer);
    for (const v of keptList) if (wm.uv[v]) pins.add(v);
    tutteSolve(wm, topo, pins);
  }
  const dbg = opts.debug || null;
  dbg && dbg(`after tutte: flipped ${flippedFaces(wm, faceList).length}/${faceList.length}, reduced ok=${rres.ok} flipped=${rres.flipped.length}/${rlist.length}`);
  // relaxation of everything (outer boundary free but guarded), then repair
  const outlineSet = new Set(outer);
  relax(wm, faceList, topo, 3);
  dbg && dbg(`after relax: flipped ${flippedFaces(wm, faceList).length}`);
  let flipped = repairFlips(wm, faceList, topo, outlineSet, { maxRounds: 4 });
  dbg && dbg(`after repair: flipped ${flipped.length}`);
  if (flipped.length) {
    // last resort: convex circle + Tutte (no flips for a disk), then guarded relaxation
    let top = 0, best = -Infinity;
    for (let i = 0; i < outer.length; i++) { const p = wm.vertices[outer[i]]; const sc = opts.upPoint ? -v3.dist(p, opts.upPoint) : p[1]; if (sc > best) { best = sc; top = i; } }
    convexTutteEmbedding(wm, faceList, topo, outer, top);
    flipped = flippedFaces(wm, faceList);
    for (let k = 0; k < 4 && !flipped.length; k++) {
      const snap = new Map(); for (const v of topo.vertexFaces.keys()) snap.set(v, wm.uv[v].slice());
      relax(wm, faceList, topo, 2, { fixed: outlineSet });
      if (flippedFaces(wm, faceList).length) { for (const [v, p] of snap) { wm.uv[v][0] = p[0]; wm.uv[v][1] = p[1]; } break; }
    }
    dbg && dbg(`after convex fallback: flipped ${flipped.length}`);
  }
  if (!flipped.length) {
    refineScales(wm, faceList, topo, opts.refineCycles ?? 3);
    flipped = flippedFaces(wm, faceList);
    if (flipped.length) flipped = repairFlips(wm, faceList, topo, outlineSet, { maxRounds: 3 });
  }
  normalizeScale(wm, faceList);
  const overlaps = flipped.length ? [] : findOverlaps(wm, faceList);
  return { ok: flipped.length === 0 && overlaps.length === 0, flipped, overlaps, outline: outer, clusters: clusters.length };
}
