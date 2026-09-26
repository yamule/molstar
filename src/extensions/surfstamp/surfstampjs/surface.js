// Molecular surface (solvent-excluded surface) generation in the spirit of EDTSurf (Xu & Zhang 2009)
// and SurfStamp's EDTSurfJ:
//   1. voxelise the solvent-accessible solid (atoms inflated by the probe radius) on a regular lattice
//   2. Euclidean distance transform of the solid; the SES is the iso-surface  EDT(p) = probeRadius
//   3. extract the iso-surface with "surface nets" (one vertex per straddling cell, one quad per crossing edge)
//   4. project every vertex onto the exact SES (distance `probe` from the nearest SAS point)
//   5. light Laplacian smoothing, sliver removal, non-manifold cleanup and outward orientation.
//
// Output: SurfaceMesh {vertices:[x,y,z][], faces:[i,j,k][]} in the PDB's Angstrom frame,
// faces counter-clockwise seen from outside (normal = (v1-v0)x(v2-v0) points away from the atoms).
import { SurfaceMesh, MeshTopology, edgeKey } from './mesh.js';
import { PointGrid } from './spatial.js';
import { v3 } from './vec.js';
import { runSync, runAsync } from './progress.js';

export const VDW_RADII = { H: 1.2, S: 1.78, C: 1.88, O: 1.48, N: 1.63, P: 1.87 };
export const VDW_DEFAULT = 1.8;

export function vdwRadius(element) {
  const e = (element || '').toUpperCase();
  return VDW_RADII[e] != null ? VDW_RADII[e] : VDW_DEFAULT;
}

// 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
function edt1d(f, n, d, vbuf, zbuf) {
  let k = 0;
  vbuf[0] = 0; zbuf[0] = -Infinity; zbuf[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const vk = vbuf[k];
      s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
      if (s <= zbuf[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++;
    vbuf[k] = q; zbuf[k] = s; zbuf[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zbuf[k + 1] < q) k++;
    const vk = vbuf[k];
    d[q] = (q - vk) * (q - vk) + f[vk];
  }
}

/** Squared distance (in voxel units) from each solid voxel to the nearest non-solid voxel. Non-solid -> 0. */
function distanceTransform(mask, nx, ny, nz) {
  const N = nx * ny * nz;
  const INF = 1e20;
  const d = new Float64Array(N);
  for (let i = 0; i < N; i++) d[i] = mask[i] ? INF : 0;
  const maxn = Math.max(nx, ny, nz);
  const f = new Float64Array(maxn), out = new Float64Array(maxn);
  const vbuf = new Int32Array(maxn), zbuf = new Float64Array(maxn + 1);
  // x pass
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const base = (z * ny + y) * nx;
    for (let x = 0; x < nx; x++) f[x] = d[base + x];
    edt1d(f, nx, out, vbuf, zbuf);
    for (let x = 0; x < nx; x++) d[base + x] = out[x];
  }
  // y pass
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = d[(z * ny + y) * nx + x];
    edt1d(f, ny, out, vbuf, zbuf);
    for (let y = 0; y < ny; y++) d[(z * ny + y) * nx + x] = out[y];
  }
  // z pass
  const nxy = nx * ny;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) f[z] = d[z * nxy + y * nx + x];
    edt1d(f, nz, out, vbuf, zbuf);
    for (let z = 0; z < nz; z++) d[z * nxy + y * nx + x] = out[z];
  }
  return d;
}

/** Unit-sphere point cloud (same construction as SurfStamp's generatePointCloud). */
export function spherePointCloud(breaknum) {
  const pts = [];
  const half = Math.floor(breaknum / 2);
  const ystep = Math.PI / half;
  for (let y = 0; y <= half; y++) {
    if (y === 0) { pts.push([0, -1, 0]); continue; }
    if (y === half) { pts.push([0, 1, 0]); continue; }
    const yy = Math.sin(-Math.PI / 2 + y * ystep);
    const rradi = Math.sqrt(Math.max(0, 1 - yy * yy));
    const rbreak = Math.max(3, Math.floor(2 * Math.PI * rradi / ystep));
    const rstep = 2 * Math.PI / rbreak;
    for (let r = 0; r < rbreak; r++) {
      const rr = r * rstep + (y % 2 === 0 ? rstep / 2 : 0);
      pts.push([Math.cos(rr) * rradi, yy, Math.sin(rr) * rradi]);
    }
  }
  return pts;
}

/**
 * Generate the molecular surface.
 * @param {Array<{pos:[number,number,number], element?:string, radius?:number}>|{atoms:Array}} input atoms or PDBData
 * @param {object} opts
 * @param {number} [opts.resolution=0.5] lattice spacing in Angstrom (0.1 - 1.0)
 * @param {number} [opts.probeRadius=1.4]
 * @param {boolean} [opts.removeInside=false] fill enclosed cavities
 * @param {number} [opts.smoothIterations=1]
 * @param {number} [opts.smoothLambda=0.5]
 * @param {boolean} [opts.project=true] project vertices onto the exact SES
 * @param {(msg:string)=>void} [opts.log]
 * @returns {SurfaceMesh}
 */
export function generateSurface(input, opts = {}) {
  return runSync(generateSurfaceGen(input, opts));
}

/**
 * Asynchronous variant of generateSurface(): `opts.onProgress(message)` is awaited between the stages.
 */
export async function generateSurfaceAsync(input, opts = {}) {
  return runAsync(generateSurfaceGen(input, opts), opts.onProgress);
}

/** Generator implementation of the surface pipeline; yields a progress message between stages. */
export function* generateSurfaceGen(input, opts = {}) {
  const resolution = opts.resolution ?? 0.5;
  const probe = opts.probeRadius ?? 1.4;
  const removeInside = !!opts.removeInside;
  const log = opts.log || (() => {});
  const rawAtoms = Array.isArray(input) ? input : input.atoms;
  const atoms = rawAtoms.map(a => ({
    pos: a.pos ? a.pos : [a.x, a.y, a.z],
    r: a.radius != null ? a.radius : vdwRadius(a.element),
  }));
  if (!atoms.length) throw new Error('generateSurface: no atoms');
  const maxR = Math.max(...atoms.map(a => a.r));
  const margin = 0.3;
  const pad = maxR + probe + margin;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const a of atoms) for (let k = 0; k < 3; k++) { if (a.pos[k] < min[k]) min[k] = a.pos[k]; if (a.pos[k] > max[k]) max[k] = a.pos[k]; }
  for (let k = 0; k < 3; k++) { min[k] -= pad; max[k] += pad; }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const n = [0, 0, 0], offset = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    n[k] = Math.floor(size[k] / resolution) + 2;
    const extra = (n[k] - 1) * resolution - size[k];
    offset[k] = min[k] - extra / 2;
  }
  const [nx, ny, nz] = n;
  const nxy = nx * ny;
  const N = nx * ny * nz;
  log(`surface: grid ${nx}x${ny}x${nz} (${(N / 1e6).toFixed(1)}M points), ${atoms.length} atoms`);

  // ---- 1. solvent accessible solid ------------------------------------------------------------
  const mask = new Uint8Array(N);
  for (const a of atoms) {
    const R = a.r + probe;
    const R2 = R * R;
    const c = [(a.pos[0] - offset[0]) / resolution, (a.pos[1] - offset[1]) / resolution, (a.pos[2] - offset[2]) / resolution];
    const step = Math.ceil(R / resolution);
    const x0 = Math.max(0, Math.floor(c[0]) - step), x1 = Math.min(nx - 1, Math.floor(c[0]) + step + 1);
    const y0 = Math.max(0, Math.floor(c[1]) - step), y1 = Math.min(ny - 1, Math.floor(c[1]) + step + 1);
    const z0 = Math.max(0, Math.floor(c[2]) - step), z1 = Math.min(nz - 1, Math.floor(c[2]) + step + 1);
    for (let z = z0; z <= z1; z++) {
      const dz = (z - c[2]) * resolution;
      for (let y = y0; y <= y1; y++) {
        const dy = (y - c[1]) * resolution;
        const dyz = dy * dy + dz * dz;
        if (dyz >= R2) continue;
        const base = z * nxy + y * nx;
        for (let x = x0; x <= x1; x++) {
          const dx = (x - c[0]) * resolution;
          if (dx * dx + dyz < R2) mask[base + x] = 1;
        }
      }
    }
  }

  yield `surface: voxelized ${atoms.length} atoms`;
  // ---- 1b. optional cavity removal: flood fill the outside from the grid boundary ---------------
  if (removeInside) {
    const outside = new Uint8Array(N);
    const queue = new Int32Array(N);
    let qh = 0, qt = 0;
    const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; queue[qt++] = i; } };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) push(z * nxy + y * nx + x);
    }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / nxy) | 0;
      if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1);
      if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx);
      if (z > 0) push(i - nxy); if (z < nz - 1) push(i + nxy);
    }
    let filled = 0;
    for (let i = 0; i < N; i++) if (!mask[i] && !outside[i]) { mask[i] = 1; filled++; }
    log(`surface: filled ${filled} cavity voxels`);
  }

  yield 'surface: distance transform';
  // ---- 2. distance transform -> scalar field (positive inside the SES) ---------------------------
  const d2 = distanceTransform(mask, nx, ny, nz);
  const field = new Float32Array(N);
  for (let i = 0; i < N; i++) field[i] = mask[i] ? Math.sqrt(d2[i]) * resolution - probe : -probe;

  yield 'surface: extracting isosurface';
  // ---- 3. surface nets --------------------------------------------------------------------------
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cxy = cx * cy;
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const vertices = [];
  const cornerOff = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1]; // bit0:x bit1:y bit2:z
  const cornerXYZ = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const cubeEdges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let z = 0; z < cz; z++) for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const p = z * nxy + y * nx + x;
    let signs = 0;
    for (let c = 0; c < 8; c++) if (field[p + cornerOff[c]] > 0) signs |= 1 << c;
    if (signs === 0 || signs === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of cubeEdges) {
      const ia = (signs >> a) & 1, ib = (signs >> b) & 1;
      if (ia === ib) continue;
      const fa = field[p + cornerOff[a]], fb = field[p + cornerOff[b]];
      let t = fa / (fa - fb);
      if (!(t >= 0 && t <= 1)) t = 0.5;
      const A = cornerXYZ[a], B = cornerXYZ[b];
      sx += A[0] + (B[0] - A[0]) * t; sy += A[1] + (B[1] - A[1]) * t; sz += A[2] + (B[2] - A[2]) * t;
      cnt++;
    }
    cellVertex[z * cxy + y * cx + x] = vertices.length;
    vertices.push([offset[0] + (x + sx / cnt) * resolution, offset[1] + (y + sy / cnt) * resolution, offset[2] + (z + sz / cnt) * resolution]);
  }
  const faces = [];
  const addQuad = (c0, c1, c2, c3, outwardAxisDir) => {
    // c* are cell indices in cyclic order around the edge; orient so that the normal is along outwardAxisDir
    const q = [cellVertex[c0], cellVertex[c1], cellVertex[c2], cellVertex[c3]];
    if (q.some(v => v < 0)) return;
    const a = vertices[q[0]], b = vertices[q[1]], c = vertices[q[2]];
    const nrm = v3.triNormal(a, b, c);
    if (v3.dot(nrm, outwardAxisDir) < 0) q.reverse();
    // split along the shorter diagonal
    const d02 = v3.dist2(vertices[q[0]], vertices[q[2]]), d13 = v3.dist2(vertices[q[1]], vertices[q[3]]);
    if (d02 <= d13) { faces.push([q[0], q[1], q[2]]); faces.push([q[0], q[2], q[3]]); }
    else { faces.push([q[0], q[1], q[3]]); faces.push([q[1], q[2], q[3]]); }
  };
  for (let z = 1; z < cz; z++) for (let y = 1; y < cy; y++) for (let x = 1; x < cx; x++) {
    const p = z * nxy + y * nx + x;
    const inP = field[p] > 0;
    // edge along x: (x,y,z)-(x+1,y,z); cells around it vary in y-1..y, z-1..z
    if ((field[p + 1] > 0) !== inP) {
      const dir = inP ? [1, 0, 0] : [-1, 0, 0];
      const c = (yy, zz) => zz * cxy + yy * cx + x;
      addQuad(c(y - 1, z - 1), c(y, z - 1), c(y, z), c(y - 1, z), dir);
    }
    if ((field[p + nx] > 0) !== inP) {
      const dir = inP ? [0, 1, 0] : [0, -1, 0];
      const c = (xx, zz) => zz * cxy + y * cx + xx;
      addQuad(c(x - 1, z - 1), c(x, z - 1), c(x, z), c(x - 1, z), dir);
    }
    if ((field[p + nxy] > 0) !== inP) {
      const dir = inP ? [0, 0, 1] : [0, 0, -1];
      const c = (xx, yy) => z * cxy + yy * cx + xx;
      addQuad(c(x - 1, y - 1), c(x, y - 1), c(x, y), c(x - 1, y), dir);
    }
  }
  const mesh = new SurfaceMesh(vertices, faces);
  mesh.compact();
  log(`surface: raw mesh ${mesh.vertices.length} vertices, ${mesh.faces.length} faces`);
  if (opts.debugStage) opts.debugStage('raw', mesh);

  yield `surface: cleaning ${mesh.faces.length} faces`;
  // ---- 3b. non-manifold cleanup ----------------------------------------------------------------
  splitNonManifoldEdges(mesh);
  splitNonManifoldVertices(mesh);
  if (opts.debugStage) opts.debugStage('nonmanifold', mesh);

  yield 'surface: projecting to the solvent excluded surface';
  // ---- 4. exact SES projection -------------------------------------------------------------------
  if (opts.project !== false) {
    const before = mesh.vertices.map(v => v.slice());
    const fixed = projectToSES(mesh, atoms, probe, resolution, maxR, log);
    const topo = new MeshTopology(mesh);
    for (const comp of topo.connectedComponents()) {
      const vs = new Set();
      for (const fi of comp) for (const vi of mesh.faces[fi]) vs.add(vi);
      let bad = 0;
      for (const vi of vs) if (!fixed[vi]) bad++;
      if (bad > 0.5 * vs.size) {
        for (const vi of vs) mesh.vertices[vi] = before[vi];
        log(`surface: component with ${comp.length} faces reverted to voxel positions (projection unstable)`);
      }
    }
  }

  yield 'surface: smoothing';
  // ---- 5. smoothing and cleanup ----------------------------------------------------------------
  const smoothIt = opts.smoothIterations ?? 1;
  if (smoothIt > 0) mesh.smooth(smoothIt, opts.smoothLambda ?? 0.5);
  if (opts.debugStage) opts.debugStage('smoothed', mesh);
  if (opts.removeAcute !== false) removeAcute(mesh, 0.975);
  if (opts.debugStage) opts.debugStage('acute', mesh);
  mesh.mergeVertices(0);
  mesh.compact();
  splitNonManifoldEdges(mesh);
  splitNonManifoldVertices(mesh);
  if (opts.debugStage) opts.debugStage('merged', mesh);
  orientOutward(mesh, atoms);
  log(`surface: final mesh ${mesh.vertices.length} vertices, ${mesh.faces.length} faces`);
  return mesh;
}

/** Project every vertex to the point at distance `probe` from the nearest solvent-accessible-surface point. */
function projectToSES(mesh, atoms, probe, resolution, maxR, log) {
  const centers = atoms.map(a => a.pos);
  const grid = new PointGrid(centers, maxR + probe);
  const cloud = spherePointCloud(Math.max(40, Math.floor(2 * Math.PI * (maxR + probe) / resolution + 10)));
  const exposedCache = new Map();
  const isExposed = (p, self) => {
    const near = grid.within(p, maxR + probe);
    for (const j of near) {
      if (j === self) continue;
      const b = atoms[j];
      const R = b.r + probe;
      if (v3.dist2(p, b.pos) < R * R) return false;
    }
    return true;
  };
  const exposedPoints = (ai) => {
    let e = exposedCache.get(ai);
    if (e) return e;
    const a = atoms[ai];
    const R = a.r + probe;
    e = [];
    for (const u of cloud) {
      const p = [a.pos[0] + u[0] * R, a.pos[1] + u[1] * R, a.pos[2] + u[2] * R];
      if (isExposed(p, ai)) e.push(p);
    }
    exposedCache.set(ai, e);
    return e;
  };
  const fixed = new Uint8Array(mesh.vertices.length);
  let moved = 0;
  for (let vi = 0; vi < mesh.vertices.length; vi++) {
    const v = mesh.vertices[vi];
    const ni = grid.nearest(v);
    if (ni < 0) continue;
    const na = atoms[ni];
    const ndist = v3.dist(v, na.pos);
    if (ndist === 0) continue;
    const Rn = na.r + probe;
    const d = [na.pos[0] + (v[0] - na.pos[0]) * Rn / ndist, na.pos[1] + (v[1] - na.pos[1]) * Rn / ndist, na.pos[2] + (v[2] - na.pos[2]) * Rn / ndist];
    const cand = grid.within(d, maxR + probe + ndist);
    let best = null, bestD = Infinity;
    for (const ai of cand) {
      const a = atoms[ai];
      const R = a.r + probe;
      const dist = v3.dist(v, a.pos);
      if (dist === 0) continue;
      const p = [a.pos[0] + (v[0] - a.pos[0]) * R / dist, a.pos[1] + (v[1] - a.pos[1]) * R / dist, a.pos[2] + (v[2] - a.pos[2]) * R / dist];
      const radial = Math.abs(dist - R);
      if (radial >= bestD) continue;
      if (isExposed(p, ai)) { bestD = radial; best = p; continue; }
      for (const q of exposedPoints(ai)) {
        const ddx = Math.abs(v[0] - q[0]); if (ddx >= bestD) continue;
        const ddy = Math.abs(v[1] - q[1]); if (ddy >= bestD) continue;
        const ddz = Math.abs(v[2] - q[2]); if (ddz >= bestD) continue;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (dd < bestD) { bestD = dd; best = q; }
      }
    }
    if (!best || bestD === 0) continue;
    const nn = [best[0] + (v[0] - best[0]) * probe / bestD, best[1] + (v[1] - best[1]) * probe / bestD, best[2] + (v[2] - best[2]) * probe / bestD];
    fixed[vi] = v3.dist(v, nn) <= resolution ? 1 : 0;
    mesh.vertices[vi] = nn;
    moved++;
  }
  log(`surface: projected ${moved} vertices onto the SES`);
  return fixed;
}

/** Collapse sliver triangles whose longest edge exceeds `thr` * (sum of the other two). */
export function removeAcute(mesh, thr = 0.975) {
  const V = mesh.vertices;
  const faces = mesh.faces;
  const topo = new MeshTopology(mesh);
  const dead = new Uint8Array(faces.length);
  const targets = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const d0 = v3.dist(V[f[0]], V[f[1]]), d1 = v3.dist(V[f[1]], V[f[2]]), d2 = v3.dist(V[f[2]], V[f[0]]);
    if (d0 > (d1 + d2) * thr) targets.push([fi, 2]);
    else if (d1 > (d2 + d0) * thr) targets.push([fi, 0]);
    else if (d2 > (d0 + d1) * thr) targets.push([fi, 1]);
  }
  for (const [fi, apex] of targets) {
    if (dead[fi]) continue;
    const f = faces[fi];
    const vi = f[apex], vi1 = f[(apex + 1) % 3], vi2 = f[(apex + 2) % 3];
    const vf = topo.facesOnVertex(vi).filter(g => !dead[g]);
    if (vf.length > 3) {
      // cannot collapse: move the apex to the centroid of its neighbours
      const nb = topo.vertexNeighbors(vi);
      if (nb.length) V[vi] = v3.mean(nb.map(j => V[j]));
      continue;
    }
    const s1 = topo.facesOnEdge(vi1, vi).filter(g => g !== fi && !dead[g]);
    const s2 = topo.facesOnEdge(vi2, vi).filter(g => g !== fi && !dead[g]);
    if (s1.length !== 1 || s2.length !== 1) continue;
    const far = (g) => faces[g].find(x => x !== vi && x !== vi1 && x !== vi2);
    const n1 = far(s1[0]), n2 = far(s2[0]);
    if (n1 == null || n2 == null || n1 !== n2) continue;
    dead[s1[0]] = 1; dead[s2[0]] = 1;
    f[apex] = n1;
  }
  mesh.faces = faces.filter((_, i) => !dead[i]);
}

/**
 * Resolve edges shared by more than two faces. The faces around such an edge are paired (adjacent in
 * angular order, opposite traversal direction) and the end vertices are then split per fan so that each
 * pair ends up on its own sheet. Returns the number of non-manifold edges handled.
 */
export function splitNonManifoldEdges(mesh) {
  const topo = new MeshTopology(mesh);
  const V = mesh.vertices, F = mesh.faces;
  const pairs = new Map(); // edgeKey -> array of [fi, fj]
  for (const [key, fl] of topo.edgeFaces) {
    if (fl.length <= 2) continue;
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    const axis = v3.norm(v3.sub(V[b], V[a]));
    let ref = null;
    const items = fl.map(fi => {
      const f = F[fi];
      const c = f.find(x => x !== a && x !== b);
      const w = v3.sub(V[c], V[a]);
      let perp = v3.sub(w, v3.scale(axis, v3.dot(w, axis)));
      if (v3.len(perp) < 1e-12) perp = [1, 0, 0];
      if (!ref) ref = v3.norm(perp);
      const ang = Math.atan2(v3.dot(v3.cross(ref, perp), axis), v3.dot(ref, perp));
      const ia = f.indexOf(a);
      const fwd = f[(ia + 1) % 3] === b;
      return { fi, ang, fwd };
    });
    items.sort((p, q) => p.ang - q.ang);
    let start = 0;
    if (items.length % 2 === 0 && items[0].fwd === items[1].fwd) start = 1;
    const pl = [];
    for (let k = 0; k + 1 < items.length; k += 2) pl.push([items[(start + k) % items.length].fi, items[(start + k + 1) % items.length].fi]);
    if (items.length % 2 === 1) pl.push([items[(start + items.length - 1) % items.length].fi]);
    pairs.set(key, pl);
  }
  if (pairs.size) splitNonManifoldVertices(mesh, pairs);
  return pairs.size;
}

/**
 * Duplicate vertices whose incident faces form more than one edge-connected fan.
 * `edgePairs` (optional) restricts connectivity across non-manifold edges to the given face pairs.
 */
export function splitNonManifoldVertices(mesh, edgePairs = null) {
  const topo = new MeshTopology(mesh);
  const V = mesh.vertices, F = mesh.faces;
  let count = 0;
  const nv = V.length;
  for (let vi = 0; vi < nv; vi++) {
    const fl = topo.facesOnVertex(vi);
    if (fl.length < 2) continue;
    // adjacency among faces through edges (vi, x)
    const adj = new Map(fl.map(fi => [fi, []]));
    const byOther = new Map();
    for (const fi of fl) for (const x of F[fi]) if (x !== vi) {
      let l = byOther.get(x);
      if (!l) { l = []; byOther.set(x, l); }
      l.push(fi);
    }
    for (const [x, l] of byOther) {
      const pl = edgePairs ? edgePairs.get(edgeKey(vi, x)) : null;
      if (pl) {
        for (const pr of pl) if (pr.length === 2) { adj.get(pr[0]).push(pr[1]); adj.get(pr[1]).push(pr[0]); }
      } else if (l.length <= 2) {
        if (l.length === 2) { adj.get(l[0]).push(l[1]); adj.get(l[1]).push(l[0]); }
      } else {
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { adj.get(l[i]).push(l[j]); adj.get(l[j]).push(l[i]); }
      }
    }
    const comp = new Map();
    let ncomp = 0;
    for (const s of fl) {
      if (comp.has(s)) continue;
      const stack = [s]; comp.set(s, ncomp);
      while (stack.length) {
        const fi = stack.pop();
        for (const g of adj.get(fi)) if (!comp.has(g)) { comp.set(g, ncomp); stack.push(g); }
      }
      ncomp++;
    }
    if (ncomp <= 1) continue;
    const newIdx = [vi];
    for (let c = 1; c < ncomp; c++) { newIdx.push(V.length); V.push(V[vi].slice()); }
    for (const fi of fl) {
      const c = comp.get(fi);
      if (c === 0) continue;
      const f = F[fi];
      for (let m = 0; m < 3; m++) if (f[m] === vi) f[m] = newIdx[c];
    }
    count++;
  }
  return count;
}

/** Per edge-connected component, flip faces so that normals point away from the nearest atom. */
export function orientOutward(mesh, atoms) {
  const centers = atoms.map(a => a.pos);
  const grid = new PointGrid(centers, 4.0);
  const topo = new MeshTopology(mesh);
  for (const comp of topo.connectedComponents()) {
    let rev = 0, tot = 0;
    const sample = comp.length > 500 ? Array.from({ length: 500 }, () => comp[Math.floor(Math.random() * comp.length)]) : comp;
    for (const fi of sample) {
      const c = mesh.faceCenter(fi);
      const n = mesh.faceNormal(fi);
      const ai = grid.nearest(c);
      if (ai < 0) continue;
      const a = centers[ai];
      const d0 = v3.dist2(c, a), d1 = v3.dist2([c[0] + 0.01 * n[0], c[1] + 0.01 * n[1], c[2] + 0.01 * n[2]], a);
      if (d1 < d0) rev++;
      tot++;
    }
    if (rev > tot / 2) for (const fi of comp) { const f = mesh.faces[fi]; const t = f[1]; f[1] = f[2]; f[2] = t; }
  }
}
