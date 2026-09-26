// SurfStampJS core, ported from SurfStamp (https://github.com/yamule/SurfStamp-public, Apache-2.0).
// This directory is licensed under the Apache License 2.0, see ./LICENSE.
// SurfStampJS public API (browser build used by the mol* SurfStamp extension).
//
//   const mesh = generateSurface(pdb)                         // SurfaceMesh {vertices, faces}
//   const decos = buildResidueDecorations(pdb, mesh)          // [{faces, text, textColor, backgroundColor, ...}]
//   const result = createTexturedObject(mesh, decos, opts)    // unwrap + texture (sync)
//   const result = await createTexturedObjectAsync(mesh, decos, { ...opts, onProgress })
import { MeshTopology } from './mesh.js';
import { unwrapDecoration } from './unwrap/group.js';
import { packBoxes } from './unwrap/pack.js';
import { drawTextureAtlas } from './texture/draw.js';
import { loadFont } from './texture/font.js';
import { runSync, runAsync } from './progress.js';

export { SurfaceMesh, MeshTopology } from './mesh.js';
export { generateSurface, generateSurfaceAsync, generateSurfaceGen, vdwRadius } from './surface.js';
export { PDBData, PDBAtom, PDBResidue, AMINO3TO1, NUCLEOTIDES, WATER } from './pdb.js';
export { mapFacesToStructure, removeJaggy } from './mapping.js';
export { ColorScheme } from './colors.js';
export { buildResidueDecorations } from './decorate.js';
export { parseOBJ, meshToOBJ, texturedOBJText } from './obj.js';
export { loadFont, CanvasFont, TrueTypeFont, BitmapFont } from './texture/font.js';
export { Raster } from './texture/raster.js';
export { unwrapDecoration } from './unwrap/group.js';
export { runSync, runAsync } from './progress.js';

/**
 * Unwrap every decoration's faces, pack the islands into one square texture, paint it and build the textured object.
 *
 * @param {import('./mesh.js').SurfaceMesh} mesh  surface (vertices + CCW faces)
 * @param {Array<{faces:number[], text?:string, textColor?:number[], backgroundColor?:number[], outlineColor?:number[],
 *                font?:string, bold?:boolean, noText?:boolean, noBackground?:boolean, noOutline?:boolean, sortKey?:any}>} decorations
 * @param {object} [opts]
 * @param {number} [opts.imageSize=2048]
 * @param {string|object} [opts.font] CSS font family (CanvasFont), a font object, or a .ttf ArrayBuffer
 * @param {object} [opts.fontObject] ready font object (overrides opts.font)
 * @param {boolean} [opts.bold=true]
 * @param {number} [opts.outlineWidth=3]
 * @param {number} [opts.textNum=2]
 * @param {number} [opts.textDist=-2]
 * @param {number|null} [opts.fontSizeMin=null] minimum label size in px (null = automatic: 20% of the median fitting size)
 * @param {boolean} [opts.tile=false]
 * @param {number} [opts.tileFontSize=16]
 * @param {boolean} [opts.maxfill=false]
 * @param {number[]} [opts.background] image background colour [r,g,b] (default white)
 * @param {boolean} [opts.transparentBackground=false] start from a transparent image (labels only; premultiplied alpha)
 * @param {[number,number,number]} [opts.upPoint] 3D point placed at the top of every island (label orientation)
 * @param {boolean} [opts.separate=true] split groups by normal direction
 * @param {number} [opts.refineCycles=5]
 * @param {number} [opts.largeThreshold=10000] groups with more faces use cluster mapping
 * @param {boolean} [opts.forceLarge=false] always use cluster mapping
 * @param {number} [opts.areaMaxRatio] split groups larger than this fraction of the decoration's area
 * @param {number} [opts.maxGroupFaces] split groups with more faces than this
 * @param {boolean} [opts.verbose=false] log per-decoration details
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{vertices, faces, uv:number[][], faceUV:number[][], texture:import('./texture/raster.js').Raster, imageSize:number, labels:Array, decorations:Array, fontName:string}}
 */
export function createTexturedObject(mesh, decorations, opts = {}) {
  return runSync(createTexturedObjectGen(mesh, decorations, opts));
}

/**
 * Asynchronous variant of createTexturedObject(): `opts.onProgress(message)` is awaited regularly
 * (every 25 decorations during unwrapping and between the stages).
 */
export async function createTexturedObjectAsync(mesh, decorations, opts = {}) {
  return runAsync(createTexturedObjectGen(mesh, decorations, opts), opts.onProgress);
}

/** Generator implementation of createTexturedObject(); yields progress messages. */
export function* createTexturedObjectGen(mesh, decorations, opts = {}) {
  const imageSize = opts.imageSize || 2048;
  const log = opts.log || (() => {});
  const t0 = Date.now();
  // ---- unwrap each decoration ---------------------------------------------------------------------
  const unwrapped = [];
  let di = 0;
  for (const d of decorations) {
    if (!d.faces || !d.faces.length) { unwrapped.push(null); di++; continue; }
    let maxGroupArea = 0;
    if (opts.areaMaxRatio > 0) maxGroupArea = opts.areaMaxRatio * d.faces.reduce((s, fi) => s + mesh.faceArea(fi), 0);
    const r = unwrapDecoration(mesh, d.faces, {
      upPoint: opts.upPoint, separate: opts.separate, refineCycles: opts.refineCycles, log: opts.verbose ? log : null,
      largeThreshold: opts.largeThreshold, forceLarge: opts.forceLarge, maxGroupArea, maxGroupFaces: opts.maxGroupFaces,
    });
    unwrapped.push({ wm: r.wm, islands: r.islands });
    di++;
    if (di % 25 === 0) {
      log(`unwrap: ${di}/${decorations.length} decorations (${Date.now() - t0} ms)`);
      yield `unwrap: ${di}/${decorations.length} groups`;
    }
  }
  log(`unwrap: done ${decorations.length} decorations in ${Date.now() - t0} ms`);
  yield 'packing islands';
  // ---- atlas packing: every island of every decoration is packed globally ------------------------
  const margin = 3; // in unwrap units (3 units per Angstrom) -> ~3 px after rescale
  const islandList = [];
  unwrapped.forEach((u, i) => { if (u) for (const isl of u.islands) islandList.push({ deco: i, isl }); });
  const placed = packBoxes(islandList.map(e => ({ width: e.isl.width, height: e.isl.height })), { margin });
  let W = 0, H = 0;
  placed.forEach((p, k) => { W = Math.max(W, p.x + islandList[k].isl.width + 2 * margin); H = Math.max(H, p.y + islandList[k].isl.height + 2 * margin); });
  const scale = (imageSize - 10) / Math.max(W, H, 1e-9);
  const islandOffset = new Map(); // isl -> [dx, dy] in unwrap units
  placed.forEach((p, k) => { const e = islandList[k]; islandOffset.set(e.isl, [p.x + margin - e.isl.minX, p.y + margin - e.isl.minY]); });
  // ---- assemble uv list and per-decoration drawing data --------------------------------------------
  const uv = [[0, 0]]; // index 0: dummy for unmapped faces
  const faceUV = mesh.faces.map(() => [0, 0, 0]);
  const faceDeco = new Int32Array(mesh.faces.length).fill(-1);
  decorations.forEach((d, i) => { if (d.faces) for (const fi of d.faces) faceDeco[fi] = i; });
  const baseTopo = new MeshTopology(mesh);
  const font = opts.fontObject || loadFont(opts.font, opts.bold !== false, { quiet: !!opts.quiet });
  const decos = [];
  for (let i = 0; i < decorations.length; i++) {
    const u = unwrapped[i];
    const d = decorations[i];
    if (!u) continue;
    const { wm, islands } = u;
    const uvIndex = new Map();
    let scaleAcc = 0, scaleN = 0;
    const dIslands = [];
    const segs = [];
    for (const isl of islands) {
      const off = islandOffset.get(isl);
      const toPixel = (q) => [(q[0] + off[0]) * scale + 5, imageSize - ((q[1] + off[1]) * scale + 5)];
      const pixelOf = (v) => {
        let e = uvIndex.get(v);
        if (!e) { const px = toPixel(wm.uv[v]); e = { idx: uv.length, px }; uv.push([px[0] / imageSize, 1 - px[1] / imageSize]); uvIndex.set(v, e); }
        return e;
      };
      const loops = wm.topo(isl.faces).boundaryLoops().map(lp => { const c = []; for (const v of lp) { const px = pixelOf(v).px; c.push(px[0], px[1]); } return c; });
      let area3D = 0;
      for (const fi of isl.faces) {
        const f = wm.faces[fi];
        const bf = wm.faceBase[fi];
        if (bf >= 0) faceUV[bf] = [pixelOf(f[0]).idx, pixelOf(f[1]).idx, pixelOf(f[2]).idx];
        const a3 = wm.faceArea(fi);
        area3D += a3;
        const P = [pixelOf(f[0]).px, pixelOf(f[1]).px, pixelOf(f[2]).px];
        const aPx = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0])) / 2;
        if (a3 > 0 && aPx > 0) { scaleAcc += Math.sqrt(aPx / a3); scaleN++; }
        // outline segments: edges whose base edge separates different decorations
        for (let k = 0; k < 3; k++) {
          const a = f[k], b = f[(k + 1) % 3];
          const ba = wm.vertexBase[a], bb = wm.vertexBase[b];
          if (ba < 0 || bb < 0) continue;
          const fl = baseTopo.facesOnEdge(ba, bb);
          let boundary = fl.length < 2;
          for (const g of fl) if (faceDeco[g] !== i) boundary = true;
          if (boundary) { const pa = pixelOf(a).px, pb = pixelOf(b).px; segs.push([pa[0], pa[1], pb[0], pb[1]]); }
        }
      }
      dIslands.push({ loops, area3D });
    }
    decos.push({
      text: d.text || '', textColor: d.textColor || [0, 0, 0], backgroundColor: d.backgroundColor || [180, 180, 180],
      outlineColor: d.outlineColor || [0, 0, 0], noBackground: !!d.noBackground, noText: !!d.noText, noOutline: !!d.noOutline,
      islands: dIslands, outlineSegments: segs, scaleFactor: scaleN ? scaleAcc / scaleN : 14.5407,
      minLabelArea3D: d.minLabelArea3D,
    });
  }
  log(`texture: drawing ${imageSize}x${imageSize} (${uv.length} uv)`);
  yield `drawing ${imageSize}x${imageSize} texture`;
  const t1 = Date.now();
  const { raster, labels, fontThreshold } = drawTextureAtlas({
    size: imageSize, decos, font,
    opts: {
      outlineWidth: opts.outlineWidth, textNum: opts.textNum, textDist: opts.textDist, fontSizeMin: opts.fontSizeMin, maxfill: opts.maxfill,
      tile: opts.tile, tileFontSize: opts.tileFontSize, background: opts.background, transparentBackground: opts.transparentBackground,
    },
  });
  log(`texture: ${labels.length} labels drawn (font threshold ${fontThreshold.toFixed(1)} px) in ${Date.now() - t1} ms`);
  return { vertices: mesh.vertices, faces: mesh.faces, uv, faceUV, texture: raster, imageSize, labels, decorations, fontName: font.name };
}
