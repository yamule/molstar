// Working mesh used during UV unwrapping of one decoration (residue) group.
// It holds a private copy of the vertices/faces so that seams (vertex clones) and hole-filling
// dummy faces never touch the input SurfaceMesh. UV coordinates are stored per local vertex,
// which is sufficient because every vertex that needs two UVs is cloned first.
import { MeshTopology, edgeKey } from '../mesh.js';
import { MinHeap } from './heap.js';
import { v3, v2 } from '../vec.js';

export class WorkMesh {
  /**
   * @param {import('../mesh.js').SurfaceMesh} base
   * @param {number[]} faceIndices faces of the base mesh that belong to this group
   */
  constructor(base, faceIndices) {
    this.base = base;
    this.vertices = []; // [x,y,z]
    this.vertexBase = []; // base vertex index (or -1 for dummy vertices)
    this.faces = []; // [a,b,c] (local)
    this.faceBase = []; // base face index (or -1 for dummy faces)
    this.uv = []; // per local vertex: [x,y] or null
    const vmap = new Map();
    for (const fi of faceIndices) {
      const f = base.faces[fi];
      const g = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        let j = vmap.get(f[k]);
        if (j == null) { j = this.vertices.length; vmap.set(f[k], j); this.vertices.push(base.vertices[f[k]]); this.vertexBase.push(f[k]); this.uv.push(null); }
        g[k] = j;
      }
      this.faces.push(g);
      this.faceBase.push(fi);
    }
    this.alive = new Uint8Array(this.faces.length).fill(1);
  }

  get faceCount() { return this.faces.length; }

  liveFaces() { const out = []; for (let i = 0; i < this.faces.length; i++) if (this.alive[i]) out.push(i); return out; }

  cloneVertex(v) {
    const j = this.vertices.length;
    this.vertices.push(this.vertices[v]);
    this.vertexBase.push(this.vertexBase[v]);
    this.uv.push(this.uv[v] ? this.uv[v].slice() : null);
    return j;
  }

  addDummyVertex(pos) {
    const j = this.vertices.length;
    this.vertices.push(pos);
    this.vertexBase.push(-1);
    this.uv.push(null);
    return j;
  }

  addDummyFace(a, b, c) {
    const fi = this.faces.length;
    this.faces.push([a, b, c]);
    this.faceBase.push(-1);
    const na = new Uint8Array(fi + 1); na.set(this.alive); na[fi] = 1; this.alive = na;
    return fi;
  }

  removeFaces(list) { for (const fi of list) this.alive[fi] = 0; }

  isDummy(fi) { return this.faceBase[fi] < 0; }

  topo(faceList) { return new MeshTopology(this, faceList); }

  faceNormal(fi) { const f = this.faces[fi]; return v3.triNormal(this.vertices[f[0]], this.vertices[f[1]], this.vertices[f[2]]); }
  faceArea(fi) { const f = this.faces[fi]; return v3.triArea(this.vertices[f[0]], this.vertices[f[1]], this.vertices[f[2]]); }
  faceCenter(fi) { const f = this.faces[fi]; return v3.mean([this.vertices[f[0]], this.vertices[f[1]], this.vertices[f[2]]]); }
  edgeLength(a, b) { return v3.dist(this.vertices[a], this.vertices[b]); }

  /** 2D signed area (in uv) of a face; positive = correct orientation (counter-clockwise, y up). */
  faceUVSignedArea(fi) {
    const f = this.faces[fi];
    const a = this.uv[f[0]], b = this.uv[f[1]], c = this.uv[f[2]];
    if (!a || !b || !c) return NaN;
    return v2.orient(a, b, c) / 2;
  }
  isFlipped(fi) { const s = this.faceUVSignedArea(fi); return !(s >= 0); }

  faceUVArea(fi) { return Math.abs(this.faceUVSignedArea(fi)); }

  /** ratio of UV perimeter to 3D perimeter */
  faceScale(fi) {
    const f = this.faces[fi];
    const V = this.vertices, U = this.uv;
    const p3 = v3.dist(V[f[0]], V[f[1]]) + v3.dist(V[f[1]], V[f[2]]) + v3.dist(V[f[2]], V[f[0]]);
    if (p3 === 0 || !U[f[0]] || !U[f[1]] || !U[f[2]]) return 1;
    const p2 = v2.dist(U[f[0]], U[f[1]]) + v2.dist(U[f[1]], U[f[2]]) + v2.dist(U[f[2]], U[f[0]]);
    return p2 / p3;
  }

  vertexSetOf(faceList) { const s = new Set(); for (const fi of faceList) for (const v of this.faces[fi]) s.add(v); return s; }

  /**
   * Multi-source Dijkstra over the vertex graph of `faceList` (3D edge lengths).
   * @returns {{dist:Map<number,number>, prev:Map<number,number>, src:Map<number,number>}}
   */
  dijkstra(sources, topo, { target = -1 } = {}) {
    const dist = new Map(), prev = new Map(), src = new Map();
    const heap = new MinHeap();
    for (const s of sources) { dist.set(s, 0); prev.set(s, -1); src.set(s, s); heap.push(0, s); }
    const done = new Set();
    while (heap.size) {
      const { key: d, val: u } = heap.pop();
      if (done.has(u)) continue;
      done.add(u);
      if (u === target) break;
      const pu = this.vertices[u];
      for (const w of topo.vertexNeighbors(u)) {
        if (done.has(w)) continue;
        const nd = d + v3.dist(pu, this.vertices[w]);
        const cur = dist.get(w);
        if (cur == null || nd < cur) { dist.set(w, nd); prev.set(w, u); src.set(w, src.get(u)); heap.push(nd, w); }
      }
    }
    return { dist, prev, src };
  }

  shortestPath(a, b, topo) {
    const { prev } = this.dijkstra([a], topo, { target: b });
    if (!prev.has(b)) return null;
    const path = [];
    for (let v = b; v !== -1; v = prev.get(v)) path.push(v);
    return path.reverse();
  }

  /** Approximate longest geodesic path (diameter) within faceList: farthest-point sweeps. */
  longestPath(faceList, topo, sweeps = 3) {
    const vs = Array.from(this.vertexSetOf(faceList));
    if (vs.length < 2) return vs;
    let start = vs[0];
    let best = { a: start, b: start, d: -1 };
    for (let s = 0; s < sweeps; s++) {
      const { dist } = this.dijkstra([start], topo);
      let far = start, fd = -1;
      for (const [v, d] of dist) if (d > fd) { fd = d; far = v; }
      if (fd > best.d) best = { a: start, b: far, d: fd };
      start = far;
    }
    return this.shortestPath(best.a, best.b, topo) || [best.a];
  }

  pathLength(path) { let l = 0; for (let i = 1; i < path.length; i++) l += this.edgeLength(path[i - 1], path[i]); return l; }
  loopLength(loop) { return this.pathLength(loop) + (loop.length > 1 ? this.edgeLength(loop[loop.length - 1], loop[0]) : 0); }

  /**
   * Split vertices whose incident faces (within faceList) form more than one edge-connected fan.
   * Faces of extra fans get a cloned vertex. Returns number of splits.
   */
  splitNonManifoldVertices(faceList) {
    const topo = this.topo(faceList);
    let count = 0;
    const nv = this.vertices.length;
    for (let vi = 0; vi < nv; vi++) {
      const fl = topo.facesOnVertex(vi);
      if (fl.length < 2) continue;
      const byOther = new Map();
      for (const fi of fl) for (const x of this.faces[fi]) if (x !== vi) {
        let l = byOther.get(x); if (!l) { l = []; byOther.set(x, l); } l.push(fi);
      }
      const comp = new Map();
      let ncomp = 0;
      for (const s of fl) {
        if (comp.has(s)) continue;
        const stack = [s]; comp.set(s, ncomp);
        while (stack.length) {
          const fi = stack.pop();
          for (const x of this.faces[fi]) if (x !== vi) for (const g of byOther.get(x)) if (!comp.has(g)) { comp.set(g, ncomp); stack.push(g); }
        }
        ncomp++;
      }
      if (ncomp <= 1) continue;
      const newIdx = [vi];
      for (let c = 1; c < ncomp; c++) newIdx.push(this.cloneVertex(vi));
      for (const fi of fl) {
        const c = comp.get(fi);
        if (c === 0) continue;
        const f = this.faces[fi];
        for (let m = 0; m < 3; m++) if (f[m] === vi) f[m] = newIdx[c];
      }
      count++;
    }
    return count;
  }

  /**
   * Give `faceList` private vertices: any vertex also used by a live face outside faceList is cloned for faceList.
   */
  privatize(faceList, allLive = null) {
    const inSet = new Set(faceList);
    const live = allLive || this.liveFaces();
    const outsideUse = new Set();
    for (const fi of live) if (!inSet.has(fi)) for (const v of this.faces[fi]) outsideUse.add(v);
    const remap = new Map();
    for (const fi of faceList) {
      const f = this.faces[fi];
      for (let m = 0; m < 3; m++) {
        const v = f[m];
        if (!outsideUse.has(v)) continue;
        let nv = remap.get(v);
        if (nv == null) { nv = this.cloneVertex(v); remap.set(v, nv); }
        f[m] = nv;
      }
    }
    return remap.size;
  }

  /**
   * Cut the mesh along a vertex path (open: interior vertices cloned; loop: all vertices cloned).
   * Faces on the left of the path direction keep the original vertices.
   */
  cutPath(path, faceList, { loop = false } = {}) {
    if (path.length < 2) return 0;
    const topo = this.topo(faceList);
    const n = path.length;
    const barrier = new Set();
    for (let i = 0; i < n - 1; i++) barrier.add(edgeKey(path[i], path[i + 1]));
    if (loop) barrier.add(edgeKey(path[n - 1], path[0]));
    let cuts = 0;
    const start = loop ? 0 : 1, end = loop ? n : n - 1;
    for (let i = start; i < end; i++) {
      const v = path[i];
      const p = path[(i - 1 + n) % n], nx = path[(i + 1) % n];
      const fl = topo.facesOnVertex(v);
      if (fl.length < 2) continue;
      // fan connectivity excluding barrier edges
      const byOther = new Map();
      for (const fi of fl) for (const x of this.faces[fi]) if (x !== v && !barrier.has(edgeKey(v, x))) {
        let l = byOther.get(x); if (!l) { l = []; byOther.set(x, l); } l.push(fi);
      }
      const comp = new Map();
      let ncomp = 0;
      for (const s of fl) {
        if (comp.has(s)) continue;
        const stack = [s]; comp.set(s, ncomp);
        while (stack.length) {
          const fi = stack.pop();
          for (const x of this.faces[fi]) if (x !== v) { const l = byOther.get(x); if (l) for (const g of l) if (!comp.has(g)) { comp.set(g, ncomp); stack.push(g); } }
        }
        ncomp++;
      }
      if (ncomp < 2) continue;
      // left side: the component containing the face with directed edge v->nx (or p->v)
      let leftComp = -1;
      for (const fi of fl) {
        const f = this.faces[fi];
        const iv = f.indexOf(v);
        if (f[(iv + 1) % 3] === nx || f[(iv + 2) % 3] === p) { leftComp = comp.get(fi); break; }
      }
      if (leftComp < 0) leftComp = 0;
      // clone for every other component
      const clones = new Map();
      for (const fi of fl) {
        const c = comp.get(fi);
        if (c === leftComp) continue;
        let nv = clones.get(c);
        if (nv == null) { nv = this.cloneVertex(v); clones.set(c, nv); }
        const f = this.faces[fi];
        for (let m = 0; m < 3; m++) if (f[m] === v) f[m] = nv;
      }
      cuts++;
    }
    return cuts;
  }

  /**
   * Boundary loops of faceList as ordered vertex lists following face winding.
   * Vertices with more than two boundary edges are split first.
   */
  boundaryLoops(faceList) {
    this.splitNonManifoldVertices(faceList);
    return this.topo(faceList).boundaryLoops();
  }

  /**
   * Fill every boundary loop except the longest one with a fan of dummy faces.
   * Returns the created dummy face indices.
   */
  fillHoles(faceList) {
    const loops = this.boundaryLoops(faceList);
    if (loops.length <= 1) return [];
    let longest = 0, ll = -1;
    loops.forEach((lp, i) => { const l = this.loopLength(lp); if (l > ll) { ll = l; longest = i; } });
    const created = [];
    loops.forEach((lp, i) => {
      if (i === longest || lp.length < 3) return;
      const c = this.addDummyVertex(v3.mean(lp.map(v => this.vertices[v])));
      for (let k = 0; k < lp.length; k++) {
        const a = lp[k], b = lp[(k + 1) % lp.length];
        // boundary edge a->b is directed as in its face; the fan face must traverse it b->a
        created.push(this.addDummyFace(b, a, c));
      }
    });
    return created;
  }

  /** Euler characteristic and boundary loop count of faceList. */
  euler(faceList) {
    const topo = this.topo(faceList);
    const V = topo.vertexFaces.size, E = topo.edgeFaces.size, F = faceList.length;
    return { chi: V - E + F, loops: topo.boundaryLoops().length, V, E, F };
  }

  /**
   * Find a non-separating loop (handle generator) using a tree-cotree decomposition.
   * Returns a vertex loop (no repeated end) or null.
   */
  findHandleLoop(faceList) {
    const topo = this.topo(faceList);
    const verts = Array.from(topo.vertexFaces.keys());
    if (!verts.length) return null;
    // primal spanning tree (BFS from an arbitrary vertex), weighted by nothing: BFS keeps cycles short
    const parent = new Map(), depth = new Map(), pdist = new Map();
    const root = verts[0];
    parent.set(root, -1); depth.set(root, 0); pdist.set(root, 0);
    const q = [root];
    const treeEdges = new Set();
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const w of topo.vertexNeighbors(u)) {
        if (parent.has(w)) continue;
        parent.set(w, u); depth.set(w, depth.get(u) + 1); pdist.set(w, pdist.get(u) + this.edgeLength(u, w));
        treeEdges.add(edgeKey(u, w));
        q.push(w);
      }
    }
    // dual spanning forest over interior edges not in the primal tree
    const dualParent = new Map();
    const cotree = new Set();
    for (const fstart of faceList) {
      if (dualParent.has(fstart)) continue;
      dualParent.set(fstart, -1);
      const fq = [fstart];
      for (let h = 0; h < fq.length; h++) {
        const fi = fq[h];
        const f = this.faces[fi];
        for (let k = 0; k < 3; k++) {
          const a = f[k], b = f[(k + 1) % 3];
          const ek = edgeKey(a, b);
          if (treeEdges.has(ek)) continue;
          const fl = topo.facesOnEdge(a, b);
          if (fl.length !== 2) continue;
          const g = fl[0] === fi ? fl[1] : fl[0];
          if (dualParent.has(g)) continue;
          dualParent.set(g, fi);
          cotree.add(ek);
          fq.push(g);
        }
      }
    }
    // remaining interior edges generate cycles
    let best = null, bestLen = Infinity;
    for (const [ek, fl] of topo.edgeFaces) {
      if (fl.length !== 2 || treeEdges.has(ek) || cotree.has(ek)) continue;
      const a = Math.floor(ek / 4294967296), b = ek % 4294967296;
      // tree path a -> lca -> b
      let x = a, y = b;
      const pa = [], pb = [];
      while (x !== y) {
        if (depth.get(x) >= depth.get(y)) { pa.push(x); x = parent.get(x); }
        else { pb.push(y); y = parent.get(y); }
      }
      const loop = pa.concat([x], pb.reverse());
      const len = this.loopLength(loop);
      if (len < bestLen) { bestLen = len; best = loop; }
    }
    return best;
  }

  /** Bounding box of uv over a face list. */
  uvBounds(faceList) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const fi of faceList) for (const v of this.faces[fi]) {
      const u = this.uv[v]; if (!u) continue;
      if (u[0] < minX) minX = u[0]; if (u[0] > maxX) maxX = u[0];
      if (u[1] < minY) minY = u[1]; if (u[1] > maxY) maxY = u[1];
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  translateUV(faceList, dx, dy) {
    const done = new Set();
    for (const fi of faceList) for (const v of this.faces[fi]) {
      if (done.has(v) || !this.uv[v]) continue;
      done.add(v);
      this.uv[v][0] += dx; this.uv[v][1] += dy;
    }
  }

  scaleUV(faceList, s) {
    const done = new Set();
    for (const fi of faceList) for (const v of this.faces[fi]) {
      if (done.has(v) || !this.uv[v]) continue;
      done.add(v);
      this.uv[v][0] *= s; this.uv[v][1] *= s;
    }
  }
}
