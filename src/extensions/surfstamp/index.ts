/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * SurfStamp extension: adds the "SurfStamp" structure representation (molecular surface with residue
 * labels painted as a texture; a JavaScript port of SurfStamp by yamule, Apache-2.0).
 */

import { PluginBehavior } from '../../mol-plugin/behavior/behavior';
import { SurfStampRepresentationProvider } from './representation';

export { SurfStampRepresentationProvider } from './representation';
export { SurfStampMeshParams, SurfStampMeshVisual } from './visual';

export const SurfStamp = PluginBehavior.create<{ }>({
    name: 'surfstamp',
    category: 'representation',
    display: {
        name: 'SurfStamp',
        description: 'Molecular surface with residue labels painted as a texture.'
    },
    ctor: class extends PluginBehavior.Handler<{ }> {
        register(): void {
            this.ctx.representation.structure.registry.add(SurfStampRepresentationProvider);
        }

        update() {
            return false;
        }

        unregister() {
            this.ctx.representation.structure.registry.remove(SurfStampRepresentationProvider);
        }
    },
    params: () => ({ })
});
