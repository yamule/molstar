// Group-level driver: splits a decoration's faces into unwrappable disk groups ("グループ分割アルゴリズム"),
// repairs topology (seams for handles / closed surfaces / pockets / fingers), unwraps every group with the core
// algorithm, separates failing faces into new groups, and finally packs the islands of the decoration.
import { WorkMesh } from './workmesh.js';
import { unwrapDisk, normalizeScale, growRings } from './core.js';
import { unwrapLarge } from './cluster.js';
import { makeDisk } from './disk.js';
import { v3 } from '../vec.js';
import { packBoxes } from './pack.js';

const DEG = Math.PI / 180;

/** Fibonacci sphere directions. */
function sphereDirections(n = 60) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

function componentsOf(wm, faceList) { return wm.topo(faceList).connectedComponents(); }

function largestComponent(wm, faceList) {
  if (!faceList.length) return [];
  const comps = componentsOf(wm, faceList);
  comps.sort((a, b) => b.length - a.length);
  return comps[0];
}

/**
 * Split a connected face group by (smoothed) normal direction so that each part can be seen from one side.
 * Follows SurfStamp's smartSeparation2: cone 60deg, no split if one cluster covers 75%, two clusters > n/4.5
 * facing > ~106deg apart, BFS growth of the rest. Returns array of face lists (1..3).
 */
export function separateByNormals(wm, faceList, { cone = 60 * DEG, keepRatio = 0.75, minRatio = 1 / 4.5, apart = 106 * DEG } = {}) {
  const n = faceList.length;
  if (n < 12) return [faceList];
  const topo = wm.topo(faceList);
  const idx = new Map(faceList.map((fi, i) => [fi, i]));
  let norms = faceList.map(fi => wm.faceNormal(fi));
  const nbrs = faceList.map(fi => topo.edgeNeighbors(fi).map(g => idx.get(g)));
  for (let round = 0; round < 2; round++) {
    const next = norms.map((nm, i) => {
      let x = nm[0], y = nm[1], z = nm[2];
      for (const j of nbrs[i]) { x += norms[j][0]; y += norms[j][1]; z += norms[j][2]; }
      return v3.norm([x, y, z]);
    });
    norms = next;
  }
  const dirs = sphereDirections(60);
  const cosCone = Math.cos(cone);
  const clusters = dirs.map(d => {
    const cand = [];
    for (let i = 0; i < n; i++) if (v3.dot(norms[i], d) > cosCone) cand.push(faceList[i]);
    return cand.length ? largestComponent(wm, cand) : [];
  });
  let maxSize = 0;
  for (const c of clusters) maxSize = Math.max(maxSize, c.length);
  if (maxSize > keepRatio * n || maxSize === 0) return [faceList];
  const cosApart = Math.cos(apart);
  let best = null, bestTotal = 0;
  for (let i = 0; i < dirs.length; i++) {
    if (clusters[i].length <= n * minRatio) continue;
    for (let j = i + 1; j < dirs.length; j++) {
      if (clusters[j].length <= n * minRatio) continue;
      if (v3.dot(dirs[i], dirs[j]) >= cosApart) continue;
      const tot = clusters[i].length + clusters[j].length;
      if (tot > bestTotal) { bestTotal = tot; best = [i, j]; }
    }
  }
  if (!best) return [faceList];
  const setA = new Set(clusters[best[0]]), setB = new Set(clusters[best[1]]);
  let r0 = largestComponent(wm, clusters[best[0]].filter(f => !setB.has(f)));
  let r1 = largestComponent(wm, clusters[best[1]].filter(f => !setA.has(f)));
  const assigned = new Map();
  for (const f of r0) assigned.set(f, 0);
  for (const f of r1) assigned.set(f, 1);
  const groups = [r0.slice(), r1.slice()];
  let frontier = [r0.slice(), r1.slice()];
  for (let guard = 0; guard < n; guard++) {
    let grew = false;
    for (let g = 0; g < 2; g++) {
      const next = [];
      for (const fi of frontier[g]) for (const nb of topo.edgeNeighbors(fi)) {
        if (assigned.has(nb)) continue;
        assigned.set(nb, g); groups[g].push(nb); next.push(nb); grew = true;
      }
      frontier[g] = next;
    }
    if (!grew) break;
  }
  const rest = faceList.filter(f => !assigned.has(f));
  const out = groups.filter(g => g.length);
  if (rest.length) out.push(rest);
  return out;
}

/**
 * Cut off "mountains" / fingers: regions whose boundary ring is much shorter than their geodesic radius implies.
 * Returns {groups: [faceList...], processed: Set<vertex>} or null.
 */
export function findMountains(wm, faceList, processed, threshold = 0.5) {
  const topo = wm.topo(faceList);
  const loops = topo.boundaryLoops();
  if (!loops.length) return null;
  let outline = loops[0], ll = -1;
  for (const lp of loops) { const l = wm.loopLength(lp); if (l > ll) { ll = l; outline = lp; } }
  const outlineSet = new Set(outline);
  const fromOutline = wm.dijkstra(outline, topo);
  const tops = [];
  for (const [v, d] of fromOutline.dist) {
    if (outlineSet.has(v) || processed.has(v)) continue;
    let isTop = true;
    for (const w of topo.vertexNeighbors(v)) { const dw = fromOutline.dist.get(w); if (dw != null && dw >= d) { isTop = false; break; } }
    if (isTop) tops.push([v, d]);
  }
  if (!tops.length) return null;
  tops.sort((a, b) => b[1] - a[1]);
  const groups = [];
  const removed = new Set();
  for (const [top] of tops) {
    if (removed.size && [...topo.facesOnVertex(top)].some(f => removed.has(f))) continue;
    const path = wm.shortestPath(top, fromOutline.src.get(top), topo);
    if (!path || path.length < 3) { processed.add(top); continue; }
    const pathDist = [0];
    for (let i = 1; i < path.length; i++) pathDist.push(pathDist[i - 1] + wm.edgeLength(path[i - 1], path[i]));
    const fromTop = wm.dijkstra([top], topo);
    const faceDist = faceList.map(fi => { let m = -1; for (const v of wm.faces[fi]) { const d = fromTop.dist.get(v); if (d == null) return [fi, Infinity]; if (d > m) m = d; } return [fi, m]; })
      .filter(x => isFinite(x[1])).sort((a, b) => a[1] - b[1]);
    let flagIndex = -1;
    let k = 0;
    const absorbed = [];
    for (let ii = 1; ii < path.length; ii++) {
      while (k < faceDist.length && faceDist[k][1] <= pathDist[ii]) absorbed.push(faceDist[k++][0]);
      if (absorbed.length < 3) continue;
      const rings = wm.topo(absorbed).boundaryLoops();
      if (!rings.length) continue;
      let target = rings[0];
      if (rings.length > 1) {
        const ps = new Set(path);
        let bl = -1;
        for (const r of rings) { if (!r.some(v => ps.has(v))) continue; const l = wm.loopLength(r); if (l > bl) { bl = l; target = r; } }
      }
      const perimR = wm.loopLength(target) / (2 * Math.PI);
      let geoR = 0, c = 0;
      for (const v of target) { const d = fromTop.dist.get(v); if (d != null) { geoR += d; c++; } }
      geoR = c ? geoR / c : 0;
      if (geoR * threshold > perimR) flagIndex = ii;
    }
    if (flagIndex > 0) {
      const maxd = pathDist[flagIndex];
      const cluster = faceDist.filter(x => x[1] <= maxd).map(x => x[0]);
      if (cluster.length >= 3 && cluster.length < faceList.length - 2) {
        for (const f of cluster) removed.add(f);
        groups.push(cluster);
      } else { processed.add(top); }
    } else {
      processed.add(top);
      for (const w of topo.vertexNeighbors(top)) processed.add(w);
    }
  }
  if (!groups.length) return null;
  // make disjoint and keep the remainder connected
  const remainder = faceList.filter(f => !removed.has(f));
  const comps = componentsOf(wm, remainder).sort((a, b) => b.length - a.length);
  if (comps.length > 1 && groups.length) for (let i = 1; i < comps.length; i++) groups[0].push(...comps[i]);
  return { groups, processed };
}

/**
 * Find a connected patch of faces whose uv scale is far below the median (ratio > `threshold`), grown by one ring.
 * Returns null when the group's scale is uniform enough.
 */
function findSqueezedPatch(wm, faces, threshold) {
  if (faces.length < 50) return null;
  const scales = faces.map(fi => [fi, wm.faceScale(fi)]);
  const sorted = scales.map(x => x[1]).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p05 = sorted[Math.floor(sorted.length * 0.05)];
  if (!(median > 0) || median / p05 <= threshold) return null;
  const small = scales.filter(x => x[1] * threshold < median).map(x => x[0]);
  if (small.length < 5) return null;
  const comps = componentsOf(wm, small).sort((a, b) => b.length - a.length);
  if (comps[0].length < 5) return null;
  const topo = wm.topo(faces);
  return Array.from(growRings(wm, topo, comps[0], 1));
}

/** Split a group in two by a geodesic Voronoi from two opposite outline vertices (fallback progress step). */
function bisect(wm, g) {
  const topo = wm.topo(g);
  const loops = topo.boundaryLoops();
  let seeds;
  if (loops.length && loops[0].length >= 2) { const lp = loops[0]; seeds = [lp[0], lp[Math.floor(lp.length / 2)]]; }
  else { const vs = Array.from(wm.vertexSetOf(g)); seeds = [vs[0], vs[vs.length - 1]]; }
  const { src } = wm.dijkstra(seeds, topo);
  const a = [], b = [];
  for (const fi of g) {
    let ca = 0;
    for (const v of wm.faces[fi]) if (src.get(v) === seeds[0]) ca++;
    (ca >= 2 ? a : b).push(fi);
  }
  if (!a.length || !b.length) { const h = Math.floor(g.length / 2); return [g.slice(0, h), g.slice(h)]; }
  return [a, b];
}

/**
 * Unwrap all faces of one decoration (residue). Returns {wm, islands:[{faces, bounds}]} where uv are in
 * "3 units per Angstrom" space with the islands packed side by side.
 * @param {import('../mesh.js').SurfaceMesh} base
 * @param {number[]} faceIndices
 * @param {object} opts {upPoint, separate:boolean, largeThreshold, refineCycles, log}
 */
export function unwrapDecoration(base, faceIndices, opts = {}) {
  const log = opts.log || null;
  const wm = new WorkMesh(base, faceIndices);
  const all = wm.liveFaces();
  let parts = [];
  for (const comp of componentsOf(wm, all)) {
    if (opts.separate === false) parts.push(comp);
    else parts.push(...separateByNormals(wm, comp));
  }
  // give every part private vertices so that islands are independent
  for (const p of parts) wm.privatize(p);
  const queue = parts.map(p => p.slice());
  const done = []; // arrays of (non-dummy) faces with valid uv
  const processed = new Set(); // vertices judged not to be mountains
  let iterations = 0;
  while (queue.length) {
    if (++iterations > 2000) { log && log('  giving up: too many iterations'); break; }
    let g = queue.shift().filter(fi => wm.alive[fi]);
    if (!g.length) continue;
    const comps = componentsOf(wm, g);
    if (comps.length > 1) { g = comps[0]; for (let i = 1; i < comps.length; i++) { wm.privatize(comps[i]); queue.push(comps[i]); } }
    wm.privatize(g);
    // optional size limits: bisect groups that are too large (area or face count)
    if (g.length > 1 && ((opts.maxGroupArea > 0 && g.reduce((s, fi) => s + wm.faceArea(fi), 0) > opts.maxGroupArea) || (opts.maxGroupFaces > 0 && g.length > opts.maxGroupFaces))) {
      for (const half of bisect(wm, g)) if (half.length) { wm.privatize(half); queue.push(half); }
      continue;
    }
    g = makeDisk(wm, g, log);
    const dummies = g.filter(fi => wm.isDummy(fi));
    // fingers / mountains
    if (g.length <= (opts.largeThreshold ?? 10000) && g.length > 12) {
      const mres = findMountains(wm, g.filter(fi => !wm.isDummy(fi)), processed);
      if (mres && mres.groups.length) {
        wm.removeFaces(dummies);
        const cut = new Set();
        for (const grp of mres.groups) {
          const gg = grp.filter(fi => !cut.has(fi) && !wm.isDummy(fi));
          for (const f of gg) cut.add(f);
          if (!gg.length) continue;
          wm.privatize(gg);
          // slit the finger along its longest path so that it opens up
          const t = wm.topo(gg);
          const path = wm.longestPath(gg, t);
          if (path.length >= 3) wm.cutPath(path, gg, { loop: false });
          queue.push(gg);
        }
        const rest = g.filter(fi => !cut.has(fi) && !wm.isDummy(fi));
        if (rest.length) queue.push(rest);
        log && log(`  mountain cut: ${mres.groups.length} group(s)`);
        continue;
      }
    }
    const largeThreshold = opts.largeThreshold ?? 10000;
    const res = ((g.length > largeThreshold || opts.forceLarge) && g.length > 90)
      ? unwrapLarge(wm, g, { upPoint: opts.upPoint, refineCycles: opts.refineCycles, largeThreshold })
      : unwrapDisk(wm, g, { upPoint: opts.upPoint, refineCycles: opts.refineCycles });
    if (log && res.clusters) log(`  cluster unwrap: ${g.length} faces in ${res.clusters} clusters -> ${res.ok ? 'ok' : 'failed'}`);
    if (res.ok) {
      wm.removeFaces(dummies);
      const real = g.filter(fi => !wm.isDummy(fi));
      // faces squeezed far below the group's typical scale distort the letters: separate them (with the ring of
      // large neighbours around them) into a new group and unwrap the remainder again
      const squeezed = findSqueezedPatch(wm, real, opts.scaleSeparation ?? 4);
      if (squeezed && squeezed.length && squeezed.length < real.length - 2) {
        const sq = new Set(squeezed);
        const rest = real.filter(fi => !sq.has(fi));
        wm.privatize(squeezed); queue.push(squeezed);
        wm.privatize(rest); queue.push(rest);
        log && log(`  scale separation: ${squeezed.length} faces separated from ${real.length}`);
        continue;
      }
      if (real.length) done.push(real);
      continue;
    }
    // failure: separate flipped / overlapping faces (and one ring) into new groups
    const topo = wm.topo(g);
    const badSeed = res.flipped.concat(res.overlaps);
    const bad = growRings(wm, topo, badSeed, 1);
    const mapped = g.filter(fi => !bad.has(fi) && !wm.isDummy(fi));
    const failed = g.filter(fi => bad.has(fi) && !wm.isDummy(fi));
    wm.removeFaces(dummies);
    log && log(`  unwrap failed (${res.reason || 'flips/overlaps'}): ${failed.length} faces separated from ${g.length}`);
    if (!mapped.length || !failed.length) {
      const real = g.filter(fi => !wm.isDummy(fi));
      if (real.length === 1) { // a single face always unwraps rigidly
        const f = wm.faces[real[0]];
        const a = wm.vertices[f[0]], b = wm.vertices[f[1]], c = wm.vertices[f[2]];
        const lab = v3.dist(a, b), lbc = v3.dist(b, c), lca = v3.dist(c, a);
        wm.uv[f[0]] = [0, 0]; wm.uv[f[1]] = [lab, 0];
        const along = (lca * lca + lab * lab - lbc * lbc) / (2 * lab || 1);
        wm.uv[f[2]] = [along, Math.sqrt(Math.max(0, lca * lca - along * along))];
        done.push(real);
      } else if (real.length) {
        for (const half of bisect(wm, real)) if (half.length) { wm.privatize(half); queue.push(half); }
      }
      continue;
    }
    const mcomps = componentsOf(wm, mapped).sort((a, b) => b.length - a.length);
    done.push(mcomps[0]);
    for (let i = 1; i < mcomps.length; i++) { wm.privatize(mcomps[i]); queue.push(mcomps[i]); }
    for (const comp of componentsOf(wm, failed)) { wm.privatize(comp); queue.push(comp); }
  }
  // scale normalisation per island and packing (3 uv units per Angstrom, margin 1)
  const islands = [];
  for (const faces of done) {
    normalizeScale(wm, faces);
    wm.scaleUV(faces, 3);
    const b = wm.uvBounds(faces);
    islands.push({ faces, width: b.width, height: b.height, minX: b.minX, minY: b.minY });
  }
  const placed = packBoxes(islands.map(i => ({ width: i.width, height: i.height })), { margin: 1 });
  islands.forEach((isl, i) => {
    const p = placed[i];
    wm.translateUV(isl.faces, p.x + 1 - isl.minX, p.y + 1 - isl.minY);
    const b = wm.uvBounds(isl.faces);
    Object.assign(isl, { minX: b.minX, minY: b.minY, width: b.width, height: b.height });
  });
  return { wm, islands };
}
