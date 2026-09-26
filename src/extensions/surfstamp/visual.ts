/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * SurfStamp extension: molecular surface with residue labels painted as a texture (SurfStampJS port).
 */

import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { ComplexMeshParams, ComplexMeshVisual, ComplexVisual } from '../../mol-repr/structure/complex-visual';
import { VisualContext } from '../../mol-repr/visual';
import { Structure, StructureElement } from '../../mol-model/structure';
import { Theme } from '../../mol-theme/theme';
import { ColorTheme } from '../../mol-theme/color';
import { Mesh } from '../../mol-geo/geometry/mesh/mesh';
import { ElementIterator, getSerialElementLoci, eachSerialElement } from '../../mol-repr/structure/visual/util/element';
import { VisualUpdateState } from '../../mol-repr/util';
import { ValueCell } from '../../mol-util';
import { Color } from '../../mol-util/color';
import { structureToPDBData, SurfStampAtom } from './structure';
import * as SurfStampJS from './lib/index.js';

export const SurfStampColorSchemes = [
    ['clustalx', 'Residue type (ClustalX-like)'],
    ['hydropathy', 'Hydropathy'],
    ['isoelectric', 'Isoelectric point'],
    ['atom', 'Atom (CPK)'],
    ['bfactor', 'B-factor'],
    ['occupancy', 'Occupancy'],
    ['chain', 'Chain gradient'],
    ['theme', 'Labels only (Mol* color theme as background)'],
] as const;
export type SurfStampColorScheme = (typeof SurfStampColorSchemes)[number][0]

export const SurfStampLabelModes = [
    ['residue', 'Residue (3-letter)'],
    ['residue_oneletter', 'Residue (1-letter)'],
    ['atom', 'Atom'],
    ['chain', 'Chain'],
] as const;
export type SurfStampLabelMode = (typeof SurfStampLabelModes)[number][0]

const ImageSizeOptions: [number, string][] = [[512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']];

export const SurfStampMeshParams = {
    ...ComplexMeshParams,
    resolution: PD.Numeric(0.5, { min: 0.25, max: 2, step: 0.05 }, { description: 'Grid spacing (Å) of the molecular surface computation' }),
    probeRadius: PD.Numeric(1.4, { min: 0, max: 5, step: 0.1 }, { description: 'Solvent probe radius (Å)' }),
    removeInside: PD.Boolean(false, { description: 'Fill internal cavities' }),
    ignoreWater: PD.Boolean(true, { description: 'Exclude water molecules' }),
    ignoreHetatm: PD.Boolean(false, { description: 'Exclude HETATM records (ligands, ions)' }),
    ignoreHydrogens: PD.Boolean(true, { description: 'Exclude hydrogen atoms' }),
    labelMode: PD.Select<SurfStampLabelMode>('residue', SurfStampLabelModes as unknown as [SurfStampLabelMode, string][], { description: 'What each labelled patch represents' }),
    colorScheme: PD.Select<SurfStampColorScheme>('clustalx', SurfStampColorSchemes as unknown as [SurfStampColorScheme, string][], { description: 'Background colours of the patches' }),
    colorMissing: PD.Boolean(true, { description: 'Gray out chain breaks, termini and residues with missing backbone atoms' }),
    imageSize: PD.Select(2048, ImageSizeOptions, { description: 'Texture size in pixels' }),
    fontFamily: PD.Text('sans-serif', { description: 'CSS font family used for the labels' }),
    bold: PD.Boolean(true, { description: 'Bold labels' }),
    outlineWidth: PD.Numeric(3, { min: 0, max: 10, step: 0.5 }, { description: 'Width of the patch boundaries (px at 2048)' }),
    textNum: PD.Numeric(2, { min: 1, max: 10, step: 1 }, { description: 'Maximum number of labels per patch' }),
    tile: PD.Boolean(false, { description: 'Tile the labels over each patch' }),
    tileFontSize: PD.Numeric(16, { min: 4, max: 64, step: 1 }, { description: 'Font size (px at 2048) in tile mode' }),
};
export type SurfStampMeshParams = typeof SurfStampMeshParams
export type SurfStampMeshProps = PD.Values<SurfStampMeshParams>

/** parameters whose change requires the surface/texture to be recomputed */
const GeometryParamKeys: (keyof SurfStampMeshProps)[] = [
    'resolution', 'probeRadius', 'removeInside', 'ignoreWater', 'ignoreHetatm', 'ignoreHydrogens', 'labelMode', 'colorScheme',
    'colorMissing', 'imageSize', 'fontFamily', 'bold', 'outlineWidth', 'textNum', 'tile', 'tileFontSize'
];

const SchemePresetIds: { [k in SurfStampColorScheme]: number } = {
    clustalx: 0, hydropathy: 1, isoelectric: 2, atom: 3, bfactor: 4, occupancy: 5, chain: 7, theme: 0,
};

type Decoration = {
    faces: number[], text: string, textColor: number[], backgroundColor: number[], outlineColor: number[],
    noBackground?: boolean, residue?: any, atom?: SurfStampAtom
}

/** Textured object as returned by SurfStampJS.createTexturedObject */
type TexturedObject = {
    vertices: number[][], faces: number[][], uv: number[][], faceUV: number[][],
    texture: { data: Uint8ClampedArray, width: number, height: number }, imageSize: number, labels: any[]
}

function luminance(c: number[]) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/** In 'theme' mode the patches are transparent: pick the label colour from the mol* theme colour of the residue. */
function applyThemeColors(decorations: Decoration[], structure: Structure, theme: Theme) {
    const l = StructureElement.Location.create(structure);
    const { unitIndices, elementIndices } = structure.serialMapping;
    for (const d of decorations) {
        d.noBackground = true;
        const atom: SurfStampAtom | undefined = d.atom ?? d.residue?.atoms?.[0];
        let bg = [128, 128, 128];
        if (atom) {
            l.unit = structure.units[unitIndices[atom.serialIndex]];
            l.element = elementIndices[atom.serialIndex];
            const c = theme.color.color(l, false);
            bg = Color.toRgb(c) as unknown as number[];
        }
        const dark = luminance(bg) < 128;
        d.textColor = dark ? [255, 255, 255] : [0, 0, 0];
        d.outlineColor = dark ? [230, 230, 230] : [0, 0, 0];
    }
}

/**
 * Build the mol* Mesh from the textured object. Vertices shared by faces with different texture coordinates are
 * split so that each mesh vertex carries one uv pair; the group of a vertex is the serial element index of the atom
 * owning its first face.
 */
function buildMesh(result: TexturedObject, surface: any, faceSerial: Int32Array, mesh?: Mesh): Mesh {
    const { vertices, faces, uv, faceUV, texture } = result;
    const normals: number[][] = surface.vertexNormals();
    const uvCount = uv.length;
    const keyMap = new Map<number, number>();
    const pos: number[] = [], nrm: number[] = [], tex: number[] = [], grp: number[] = [];
    const idx = new Uint32Array(faces.length * 3);
    for (let fi = 0, fl = faces.length; fi < fl; fi++) {
        const f = faces[fi], t = faceUV[fi];
        const g = faceSerial[fi] >= 0 ? faceSerial[fi] : 0;
        for (let k = 0; k < 3; k++) {
            const key = f[k] * uvCount + t[k];
            let vi = keyMap.get(key);
            if (vi === undefined) {
                vi = pos.length / 3;
                keyMap.set(key, vi);
                const v = vertices[f[k]], n = normals[f[k]], q = uv[t[k]];
                pos.push(v[0], v[1], v[2]);
                nrm.push(n[0], n[1], n[2]);
                tex.push(q[0], q[1]);
                grp.push(g);
            }
            idx[fi * 3 + k] = vi;
        }
    }
    const m = Mesh.create(new Float32Array(pos), idx, new Float32Array(nrm), new Float32Array(grp), pos.length / 3, faces.length, mesh);
    ValueCell.updateIfChanged(m.varyingGroup, true);
    const image = new Uint8Array(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength);
    // SurfStampJS uv has v = 1 - y/size (image row 0 at the top) -> upload flipped
    Mesh.setColorTexture(m, new Float32Array(tex), { array: image, width: texture.width, height: texture.height, flipY: true });
    return m;
}

async function createSurfStampMesh(ctx: VisualContext, structure: Structure, theme: Theme, props: SurfStampMeshProps, mesh?: Mesh): Promise<Mesh> {
    const { runtime } = ctx;
    const report = async (message: string) => { await runtime.update({ message: `SurfStamp: ${message}` }); };

    // typed loosely: the SurfStampJS functions declare the PDBData class in their JSDoc
    const pdb: any = structureToPDBData(structure, props);
    if (!pdb.atoms.length) {
        const empty = Mesh.createEmpty(mesh);
        Mesh.clearColorTexture(empty);
        return empty;
    }

    await report(`generating molecular surface (${pdb.atoms.length} atoms)`);
    const surface = await SurfStampJS.generateSurfaceAsync(pdb, { resolution: props.resolution, probeRadius: props.probeRadius, removeInside: props.removeInside, onProgress: report });

    await report('assigning surface patches to residues');
    const mode = props.labelMode === 'residue_oneletter' ? 'residue' : props.labelMode;
    const decorations: Decoration[] = SurfStampJS.buildResidueDecorations(pdb, surface, {
        mode, scheme: SchemePresetIds[props.colorScheme], oneLetter: props.labelMode === 'residue_oneletter',
        colorMissing: props.colorMissing && props.colorScheme !== 'theme', force: true,
    });
    const themeMode = props.colorScheme === 'theme';
    if (themeMode) applyThemeColors(decorations, structure, theme);

    // picking group per face: the serial element index of the nearest atom
    const { faceAtom, atoms } = SurfStampJS.mapFacesToStructure(surface, pdb, { mode: mode === 'atom' ? 'atom' : 'residue' });
    const faceSerial = new Int32Array(faceAtom.length);
    for (let i = 0; i < faceAtom.length; i++) faceSerial[i] = faceAtom[i] >= 0 ? (atoms[faceAtom[i]] as SurfStampAtom).serialIndex : -1;

    await report(`unwrapping ${decorations.length} groups`);
    const result: TexturedObject = await SurfStampJS.createTexturedObjectAsync(surface, decorations, {
        imageSize: props.imageSize, font: props.fontFamily, bold: props.bold, outlineWidth: props.outlineWidth,
        textNum: props.textNum, tile: props.tile, tileFontSize: props.tileFontSize,
        transparentBackground: themeMode, quiet: true, onProgress: report,
    });

    await report('building mesh');
    return buildMesh(result, surface, faceSerial, mesh);
}

export function SurfStampMeshVisual(materialId: number): ComplexVisual<SurfStampMeshParams> {
    return ComplexMeshVisual<SurfStampMeshParams>({
        defaultProps: PD.getDefaultValues(SurfStampMeshParams),
        createGeometry: createSurfStampMesh,
        createLocationIterator: ElementIterator.fromStructure,
        getLoci: getSerialElementLoci,
        eachLocation: eachSerialElement,
        setUpdateState: (state: VisualUpdateState, newProps: SurfStampMeshProps, currentProps: SurfStampMeshProps, newTheme: Theme, currentTheme: Theme) => {
            for (const k of GeometryParamKeys) {
                if (newProps[k] !== currentProps[k]) state.createGeometry = true;
            }
            if (newProps.colorScheme === 'theme' && !ColorTheme.areEqual(newTheme.color, currentTheme.color)) state.createGeometry = true;
        },
    }, materialId);
}
