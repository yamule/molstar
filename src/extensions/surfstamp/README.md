# SurfStamp extension

Adds the **SurfStamp** structure representation: a molecular surface whose patches are labelled with the
residue (or atom / chain) names, painted into a texture that is mapped onto the surface. It is a JavaScript
port of [SurfStamp](https://github.com/yamule/SurfStamp-public) (yamule, Apache-2.0).

Use *Add Representation → SurfStamp* on a structure component (or `plugin.builders.structure.representation.addRepresentation(cell, { type: 'surfstamp' })`).

## Layout

- `lib/` – SurfStampJS core (plain JavaScript, no dependencies; Apache-2.0, see `lib/LICENSE`):
  surface generation (`surface.js`), face→residue assignment (`mapping.js`, `decorate.js`), UV unwrapping
  (`unwrap/`), texture painting (`texture/`). `index.js` is the entry point. The browser build replaces the
  TrueType loader with `CanvasFont` (Canvas 2D API) and runs the long pipelines as generators so that progress
  can be reported.
- `structure.ts` – converts a mol* `Structure` into the SurfStampJS atom/residue model (auth names; symmetry
  copies get the operator name appended to the chain id).
- `visual.ts` – `ComplexMeshVisual` that runs the pipeline and builds a `Mesh` with texture coordinates.
- `representation.ts`, `index.ts` – representation provider and the `PluginBehavior` registering it.

## Rendering

`Mesh` gained optional texture support (`Mesh.setColorTexture`): `aTexCoord` attribute, `tColorTexture` sampler
and the `dColorTexture` define in `mol-gl/renderable/mesh.ts` and the mesh shaders. The texel is blended over the
theme colour with its (premultiplied) alpha, so the *Labels only* colour scheme draws labels and outlines on top of
the regular mol* colouring while the other schemes replace it.
