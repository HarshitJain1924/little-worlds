# Little Worlds — M0 visual prototype

A cozy floating-island scene in the browser: one island, a small cottage, a pond,
scattered vegetation and a 3/4 orbit camera. This is the M0 milestone — a visual
prototype only. There is no gameplay, no creatures, no saving and no backend.

Built with **Vite 8 + TypeScript 7 + three.js 0.187**, using `WebGLRenderer`.

## Requirements

- Node.js 20.19+ or 22.12+ (developed on 24.18)
- npm

## Commands

```bash
npm install
npm run dev        # development server
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

`npm run build` runs `tsc --noEmit` first; a type error fails the build.

## Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Rotate | drag, or arrow keys / WASD | one-finger drag |
| Zoom | wheel, or `+` / `-` | pinch |
| Reset view | `R` | — |
| Quality | Low / Medium / High buttons | same buttons |

The camera is an elevated 3/4 orbit at a fixed target; it does not follow a
character. Its distance is scaled automatically so the island fits narrow
(portrait) viewports.

## Graphics presets

Chosen automatically on first load (coarse pointer + `deviceMemory` +
`hardwareConcurrency`), then remembered in `localStorage` under
`little-worlds.quality`.

| | Low | Medium | High |
| --- | --- | --- | --- |
| Render scale | 1.0× | ≤1.5× | ≤2.0× |
| Antialiasing | off | on | on |
| Shadows | off | 1024 map | 2048 map |
| Grass / flowers / trees | 90 / 20 / 12 | 190 / 34 / 16 | 300 / 42 / 20 |
| Clouds | 6 + deck | 10 + deck | 14 + deck |
| Fog | heavier | medium | light |

Antialiasing is fixed when the WebGL context is created, so it is decided from the
starting preset; everything else changes at runtime without a reload.

## Structure

```
index.html          canvas + HUD shell
src/main.ts         boot, renderer, quality switching, frame loop
src/config.ts       palette, world layout, camera and quality presets
src/assets.ts       GLB loading, material fixes, instancing and cloning
src/terrain.ts      island surface + tapered underside, height function, colours
src/environment.ts  sky dome, cloud deck, sun/hemisphere lighting, pond water
src/island.ts       hut assembly, camp, pond decor, paths and scatter
src/camera.ts       orbit rig (damping, pinch, keyboard)
src/ui.ts           stats readout, preset buttons, loading screen
public/models/      the 38 shipped GLB models (+ the Fantasy Town atlas)
```

### Asset notes

- **Nature Kit ships `metallicFactor: 1` on every material.** Without an
  environment map those surfaces render almost black, so `assets.ts` forces
  `metalness: 0` on load. Fantasy Town already exports 0.
- Both kits use flat shading; materials are switched to `flatShading` to match how
  the models were authored.
- **Fantasy Town models load a shared external atlas** at `Textures/colormap.png`,
  resolved relative to the GLB. Keep the folder layout intact.
- Scatter and repeated props are `InstancedMesh` batches; their instance count is
  lowered per preset instead of rebuilding the scene.

### Units

Everything is in Kenney kit units (one unit ≈ one metre). The island is ~16 units
across, the cottage one storey tall. No per-asset scaling hacks are applied.

## Known limitations

- Frame-rate numbers from a headless/software-rendered browser are **not**
  representative; real-device performance has not been measured yet.
- The pond is a shader disc, not a physics surface; nothing interacts with it yet.
- No audio, no save system, no gameplay systems — those are later milestones.

## Licence

Code: not yet licensed. Assets: CC0, see [CREDITS.md](CREDITS.md).
