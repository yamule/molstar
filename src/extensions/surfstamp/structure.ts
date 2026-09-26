/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * SurfStamp extension: convert a mol* Structure into the SurfStampJS PDBData model.
 */

import { Structure, StructureElement, StructureProperties as SP, Unit } from '../../mol-model/structure';
import { PDBData, PDBAtom, PDBResidue } from './surfstampjs/index.js';

export interface StructureToPDBOptions {
    /** drop water molecules */
    ignoreWater: boolean
    /** drop HETATM records (ligands, ions, ...) */
    ignoreHetatm: boolean
    /** drop hydrogen (and deuterium) atoms */
    ignoreHydrogens: boolean
}

/**
 * SurfStampJS atom (see lib/pdb.js). `serialIndex` is added by this adapter: the structure-wide
 * serial element index, used as the picking/coloring group of the surface vertices.
 */
export interface SurfStampAtom {
    serial: number, name: string, altLoc: string, resName: string, chain: string, resSeq: number, iCode: string,
    x: number, y: number, z: number, occupancy: number, bfactor: number, element: string, hetatm: boolean, model: number,
    residue: SurfStampResidue,
    serialIndex: number,
    pos: number[],
}

export interface SurfStampResidue {
    chain: string, resName: string, resSeq: number, iCode: string, model: number,
    atoms: SurfStampAtom[], index: number,
    chainBreakBefore: boolean, chainBreakAfter: boolean, missingAtoms: boolean, terminal: boolean,
    isAminoAcid(): boolean, isNucleotide(): boolean, isWater(): boolean,
    label(opts?: { oneLetter?: boolean, chainName?: boolean }): string,
}

export interface SurfStampPDBData {
    atoms: SurfStampAtom[]
    residues: SurfStampResidue[]
    chains: Map<string, SurfStampResidue[]>
    name: string
    index(): void
}

/**
 * Build SurfStampJS PDBData from a structure. Chains are named by auth_asym_id; units created by a
 * non-identity symmetry operator get the operator name appended so that assembly copies stay distinct.
 * Alternate locations other than the first one encountered are dropped.
 */
export function structureToPDBData(structure: Structure, opts: StructureToPDBOptions): SurfStampPDBData {
    const pdb: SurfStampPDBData = new (PDBData as any)();
    pdb.name = structure.models[0]?.entryId ?? 'structure';
    const l = StructureElement.Location.create(structure);
    const resMap = new Map<string, SurfStampResidue>();
    const { getSerialIndex } = structure.serialMapping;

    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit)) continue;
        l.unit = unit;
        const op = unit.conformation.operator;
        const opSuffix = op.isIdentity ? '' : `-${op.name}`;
        const { elements } = unit;
        const c = unit.conformation;

        for (let i = 0, il = elements.length; i < il; i++) {
            const e = elements[i];
            l.element = e;

            const element = (SP.atom.type_symbol(l) as string).toUpperCase();
            if (opts.ignoreHydrogens && (element === 'H' || element === 'D')) continue;
            const isWater = SP.entity.type(l) === 'water';
            if (opts.ignoreWater && isWater) continue;
            const hetatm = SP.residue.group_PDB(l) === 'HETATM';
            if (opts.ignoreHetatm && hetatm) continue;

            const chain = SP.chain.auth_asym_id(l) + opSuffix;
            const resName = SP.atom.auth_comp_id(l);
            const resSeq = SP.residue.auth_seq_id(l);
            const iCode = SP.residue.pdbx_PDB_ins_code(l) || '';
            const key = `1|${chain}|${resSeq}|${iCode}|${resName}`;
            let res = resMap.get(key);
            if (!res) {
                res = new (PDBResidue as any)(chain, resName, resSeq, iCode, 1) as SurfStampResidue;
                resMap.set(key, res);
                pdb.residues.push(res);
            }

            const name = SP.atom.auth_atom_id(l);
            const altLoc = SP.atom.label_alt_id(l) || '';
            if (altLoc && res.atoms.some(a => a.name === name)) continue; // keep the first alternate location only

            const a = new (PDBAtom as any)() as SurfStampAtom;
            a.serial = pdb.atoms.length + 1;
            a.name = name;
            a.altLoc = altLoc;
            a.resName = resName;
            a.chain = chain;
            a.resSeq = resSeq;
            a.iCode = iCode;
            a.x = c.x(e);
            a.y = c.y(e);
            a.z = c.z(e);
            a.occupancy = SP.atom.occupancy(l);
            a.bfactor = SP.atom.B_iso_or_equiv(l);
            a.element = element;
            a.hetatm = hetatm;
            a.residue = res;
            a.model = 1;
            a.serialIndex = getSerialIndex(unit, e);
            res.atoms.push(a);
            pdb.atoms.push(a);
        }
    }
    pdb.index();
    return pdb;
}
