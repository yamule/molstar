// Simple triangle-mesh container and topology helpers.
//
// SurfaceMesh is intentionally minimal (as required by the spec):
//   vertices : Array<[x,y,z]>
//   faces    : Array<[i0,i1,i2]>  - counter-clockwise seen from outside (normal = (v1-v0)x(v2-v0) points outward)
// Everything else (adjacency, normals, areas) is derived on demand via MeshTopology.
import { v3 } from './vec.js';

export class SurfaceMesh {
  constructor(vertices = [], faces = []) {
    this.vertices = vertices;
    this.faces = faces;
  }

  clone() {
    return new SurfaceMesh(this.vertices.map(v => v.slice()), this.faces.map(f => f.slice()));
  }

  faceNormal(fi) {
    const f = this.faces[fi];
    return v3.triNormal(this.vertices[f[0]], this.vertices[f[1]], this.vertices[f[2]]);
  }

  faceArea(fi) {
    const f = this.faces[fi];
    return v3.triArea(this.vertices[f[0]], this.vertices[f[1]], this.vertices[f[2]]);
  }

  faceCenter(fi) {
    const f = this.faces[fi];
    const a = this.vertices[f[0]], b = this.vertices[f[1]], c = this.vertices[f[2]];
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  }

  /** Merge vertices closer than `eps` (exact-duplicate merge when eps=0). Returns mapping old->new. */
  mergeVertices(eps = 1e-6) {
    const map = new Map();
    const remap = new Int32Array(this.vertices.length);
    const nv = [];
    const inv = eps > 0 ? 1 / eps : 1e9;
    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      const key = Math.round(v[0] * inv) + ',' + Math.round(v[1] * inv) + ',' + Math.round(v[2] * inv);
      let j = map.get(key);
      if (j == null) { j = nv.length; map.set(key, j); nv.push(v); }
      remap[i] = j;
    }
    const nf = [];
    for (const f of this.faces) {
      const a = remap[f[0]], b = remap[f[1]], c = remap[f[2]];
      if (a === b || b === c || a === c) continue;
      nf.push([a, b, c]);
    }
    this.vertices = nv;
    this.faces = nf;
    return remap;
  }

  /** Remove degenerate faces and unreferenced vertices (in place). */
  compact() {
    const used = new Uint8Array(this.vertices.length);
    const nf = [];
    for (const f of this.faces) {
      if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
      used[f[0]] = used[f[1]] = used[f[2]] = 1;
      nf.push(f);
    }
    const remap = new Int32Array(this.vertices.length).fill(-1);
    const nv = [];
    for (let i = 0; i < this.vertices.length; i++) if (used[i]) { remap[i] = nv.length; nv.push(this.vertices[i]); }
    this.vertices = nv;
    this.faces = nf.map(f => [remap[f[0]], remap[f[1]], remap[f[2]]]);
    return remap;
  }

  /** Extract a sub-mesh with only the given face indices; returns {mesh, faceMap(new->old), vertexMap(new->old)}. */
  subMesh(faceIndices) {
    const vmap = new Map();
    const nv = [], nf = [], vertexMap = [];
    for (const fi of faceIndices) {
      const f = this.faces[fi];
      const g = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        let j = vmap.get(f[k]);
        if (j == null) { j = nv.length; vmap.set(f[k], j); nv.push(this.vertices[f[k]]); vertexMap.push(f[k]); }
        g[k] = j;
      }
      nf.push(g);
    }
    return { mesh: new SurfaceMesh(nv, nf), faceMap: Array.from(faceIndices), vertexMap };
  }

  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of this.vertices) for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
    return { min, max };
  }

  /** Per-vertex normals (area-weighted average of face normals). */
  vertexNormals() {
    const n = this.vertices.map(() => [0, 0, 0]);
    for (const f of this.faces) {
      const a = this.vertices[f[0]], b = this.vertices[f[1]], c = this.vertices[f[2]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) { const o = n[f[k]]; o[0] += nx; o[1] += ny; o[2] += nz; }
    }
    return n.map(v => v3.norm(v));
  }

  /** Laplacian smoothing (simple, uniform weights). */
  smooth(iterations = 1, lambda = 0.5) {
    const topo = new MeshTopology(this);
    for (let it = 0; it < iterations; it++) {
      const nv = this.vertices.map((v, i) => {
        const nb = topo.vertexNeighbors(i);
        if (!nb.length) return v;
        const m = [0, 0, 0];
        for (const j of nb) { const w = this.vertices[j]; m[0] += w[0]; m[1] += w[1]; m[2] += w[2]; }
        const k = nb.length;
        return [v[0] + lambda * (m[0] / k - v[0]), v[1] + lambda * (m[1] / k - v[1]), v[2] + lambda * (m[2] / k - v[2])];
      });
      this.vertices = nv;
    }
  }
}

function edgeKey(a, b) { return a < b ? a * 4294967296 + b : b * 4294967296 + a; }
export { edgeKey };

/** Derived adjacency information for a SurfaceMesh (or a subset of its faces). */
export class MeshTopology {
  /**
   * @param {SurfaceMesh} mesh
   * @param {Iterable<number>|null} faceSubset restrict to these face indices (default: all)
   */
  constructor(mesh, faceSubset = null) {
    this.mesh = mesh;
    const faces = mesh.faces;
    this.faceList = faceSubset ? Array.from(faceSubset) : faces.map((_, i) => i);
    this.faceSet = faceSubset ? new Set(this.faceList) : null;
    // vertex -> faces
    this.vertexFaces = new Map();
    // edge -> faces
    this.edgeFaces = new Map();
    for (const fi of this.faceList) {
      const f = faces[fi];
      for (let k = 0; k < 3; k++) {
        const a = f[k], b = f[(k + 1) % 3];
        let vf = this.vertexFaces.get(a);
        if (!vf) { vf = []; this.vertexFaces.set(a, vf); }
        vf.push(fi);
        const ek = edgeKey(a, b);
        let ef = this.edgeFaces.get(ek);
        if (!ef) { ef = []; this.edgeFaces.set(ek, ef); }
        ef.push(fi);
      }
    }
    this._neighborsCache = new Map();
  }

  hasFace(fi) { return this.faceSet ? this.faceSet.has(fi) : (fi >= 0 && fi < this.mesh.faces.length); }

  facesOnVertex(v) { return this.vertexFaces.get(v) || []; }

  facesOnEdge(a, b) { return this.edgeFaces.get(edgeKey(a, b)) || []; }

  /** Faces sharing an edge with fi. */
  edgeNeighbors(fi) {
    const f = this.mesh.faces[fi];
    const out = [];
    for (let k = 0; k < 3; k++) {
      for (const g of this.facesOnEdge(f[k], f[(k + 1) % 3])) if (g !== fi) out.push(g);
    }
    return out;
  }

  /** Faces sharing at least one vertex with fi. */
  vertexNeighbors_faces(fi) {
    const f = this.mesh.faces[fi];
    const s = new Set();
    for (let k = 0; k < 3; k++) for (const g of this.facesOnVertex(f[k])) if (g !== fi) s.add(g);
    return Array.from(s);
  }

  /** Vertices connected to v by an edge (within the face subset). */
  vertexNeighbors(v) {
    let c = this._neighborsCache.get(v);
    if (c) return c;
    const s = new Set();
    for (const fi of this.facesOnVertex(v)) {
      const f = this.mesh.faces[fi];
      for (let k = 0; k < 3; k++) if (f[k] !== v) s.add(f[k]);
    }
    c = Array.from(s);
    this._neighborsCache.set(v, c);
    return c;
  }

  /** Boundary edges: edges with exactly one face in the subset. Returns array of [a,b] oriented as in the face. */
  boundaryEdges() {
    const out = [];
    const faces = this.mesh.faces;
    for (const fi of this.faceList) {
      const f = faces[fi];
      for (let k = 0; k < 3; k++) {
        const a = f[k], b = f[(k + 1) % 3];
        if (this.facesOnEdge(a, b).length === 1) out.push([a, b, fi]);
      }
    }
    return out;
  }

  /**
   * Boundary loops as ordered vertex lists (each loop follows face orientation).
   * Non-manifold junctions are split greedily.
   */
  boundaryLoops() {
    const edges = this.boundaryEdges();
    const next = new Map(); // a -> list of b
    for (const [a, b] of edges) {
      let l = next.get(a);
      if (!l) { l = []; next.set(a, l); }
      l.push(b);
    }
    const loops = [];
    const usedEdge = new Set();
    for (const [a0, b0] of edges) {
      const k0 = a0 + ':' + b0;
      if (usedEdge.has(k0)) continue;
      const loop = [a0];
      usedEdge.add(k0);
      let cur = b0;
      let guard = 0;
      while (cur !== a0 && guard++ < edges.length + 1) {
        loop.push(cur);
        const cands = (next.get(cur) || []).filter(b => !usedEdge.has(cur + ':' + b));
        if (!cands.length) break;
        const nb = cands[0];
        usedEdge.add(cur + ':' + nb);
        cur = nb;
      }
      loops.push(loop);
    }
    return loops;
  }

  /** Connected components (by shared edges) of the face subset. Returns array of face-index arrays. */
  connectedComponents(byVertex = false) {
    const seen = new Set();
    const comps = [];
    for (const start of this.faceList) {
      if (seen.has(start)) continue;
      const comp = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const fi = stack.pop();
        comp.push(fi);
        const nb = byVertex ? this.vertexNeighbors_faces(fi) : this.edgeNeighbors(fi);
        for (const g of nb) if (!seen.has(g)) { seen.add(g); stack.push(g); }
      }
      comps.push(comp);
    }
    return comps;
  }
}
