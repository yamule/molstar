/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * SurfStamp extension: structure representation provider.
 */

import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { Structure } from '../../mol-model/structure';
import { Representation, RepresentationContext, RepresentationParamsGetter } from '../../mol-repr/representation';
import { ComplexRepresentation, StructureRepresentation, StructureRepresentationProvider, StructureRepresentationStateBuilder } from '../../mol-repr/structure/representation';
import { ThemeRegistryContext } from '../../mol-theme/theme';
import { SurfStampMeshParams, SurfStampMeshVisual } from './visual';

const SurfStampVisuals = {
    'surfstamp-mesh': (ctx: RepresentationContext, getParams: RepresentationParamsGetter<Structure, SurfStampMeshParams>) => ComplexRepresentation('SurfStamp surface', ctx, getParams, SurfStampMeshVisual),
};

export const SurfStampParams = {
    ...SurfStampMeshParams,
    visuals: PD.MultiSelect(['surfstamp-mesh'], PD.objectToOptions(SurfStampVisuals)),
};
export type SurfStampParams = typeof SurfStampParams
export function getSurfStampParams(ctx: ThemeRegistryContext, structure: Structure) {
    return SurfStampParams;
}

export type SurfStampRepresentation = StructureRepresentation<SurfStampParams>
export function SurfStampRepresentation(ctx: RepresentationContext, getParams: RepresentationParamsGetter<Structure, SurfStampParams>): SurfStampRepresentation {
    return Representation.createMulti('SurfStamp', ctx, getParams, StructureRepresentationStateBuilder, SurfStampVisuals as unknown as Representation.Def<Structure, SurfStampParams>);
}

export const SurfStampRepresentationProvider = StructureRepresentationProvider({
    name: 'surfstamp',
    label: 'SurfStamp',
    description: 'Molecular surface with residue labels painted as a texture (SurfStamp).',
    factory: SurfStampRepresentation,
    getParams: getSurfStampParams,
    defaultValues: PD.getDefaultValues(SurfStampParams),
    defaultColorTheme: { name: 'chain-id' },
    defaultSizeTheme: { name: 'physical' },
    isApplicable: (structure: Structure) => structure.elementCount > 0
});
