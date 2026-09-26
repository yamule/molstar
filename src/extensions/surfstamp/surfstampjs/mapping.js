// Assign surface faces to residues / atoms by the nearest atom to the face centre.
import { PointGrid } from './spatial.js';
import { v3 } from './vec.js';

/**
 * @param {import('./mesh.js').SurfaceMesh} mesh
 * @param {import('./pdb.js').PDBData} pdb
 * @param {{mode?:'residue'|'atom', maxDistance?:number, backboneOnly?:boolean, caOnly?:boolean}} opts
 * @returns {{groups: Map<any, number[]>, faceAtom: Int32Array, atoms: any[], maxDist:number}} key = PDBResidue or PDBAtom; faceAtom indexes `atoms`
 */
export function mapFacesToStructure(mesh, pdb, opts = {}) {
  const mode = opts.mode || 'residue';
  let atoms = pdb.atoms;
  if (opts.caOnly) atoms = atoms.filter(a => a.name === 'CA' && a.element !== 'CA');
  else if (opts.backboneOnly) atoms = atoms.filter(a => a.isBackbone());
  if (!atoms.length) atoms = pdb.atoms;
  const grid = new PointGrid(atoms.map(a => a.pos), 4.0);
  const groups = new Map();
  const faceAtom = new Int32Array(mesh.faces.length).fill(-1);
  let maxDist = 0;
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const c = mesh.faceCenter(fi);
    const ai = grid.nearest(c);
    if (ai < 0) continue;
    faceAtom[fi] = ai;
    const d = v3.dist(c, atoms[ai].pos);
    if (d > maxDist) maxDist = d;
    const key = mode === 'atom' ? atoms[ai] : atoms[ai].residue;
    let l = groups.get(key);
    if (!l) { l = []; groups.set(key, l); }
    l.push(fi);
  }
  if (opts.maxDistance && maxDist > opts.maxDistance) {
    throw new Error(`face-to-atom distance ${maxDist.toFixed(2)} exceeds ${opts.maxDistance}: the surface does not match the structure (use force to ignore)`);
  }
  return { groups, faceAtom, atoms, maxDist };
}

/**
 * Absorb single boundary triangles that share >= 2 edges with a group (remove jagged boundaries).
 * Mutates the group lists in place.
 */
export function removeJaggy(mesh, groups) {
  const faceGroup = new Map();
  for (const [key, list] of groups) for (const fi of list) faceGroup.set(fi, key);
  const edgeMap = new Map();
  const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    for (let k = 0; k < 3; k++) {
      const key = ek(f[k], f[(k + 1) % 3]);
      let l = edgeMap.get(key); if (!l) { l = []; edgeMap.set(key, l); } l.push(fi);
    }
  }
  let changed = true, rounds = 0;
  while (changed && rounds++ < 5) {
    changed = false;
    for (let fi = 0; fi < mesh.faces.length; fi++) {
      const f = mesh.faces[fi];
      const own = faceGroup.get(fi);
      const count = new Map();
      for (let k = 0; k < 3; k++) {
        for (const g of edgeMap.get(ek(f[k], f[(k + 1) % 3]))) {
          if (g === fi) continue;
          const key = faceGroup.get(g);
          if (key === own) continue;
          count.set(key, (count.get(key) || 0) + 1);
        }
      }
      for (const [key, c] of count) {
        if (c >= 2) {
          const oldList = groups.get(own);
          if (oldList) { const i = oldList.indexOf(fi); if (i >= 0) oldList.splice(i, 1); }
          groups.get(key).push(fi);
          faceGroup.set(fi, key);
          changed = true;
          break;
        }
      }
    }
  }
  for (const [key, list] of groups) if (!list.length) groups.delete(key);
}
