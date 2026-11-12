# Little Worlds

Two scenes in one Vite project:

| Entry point | URL | What it is |
| --- | --- | --- |
| **Island demo** | `/index.html` | The original M0 visual prototype: a floating island diorama with an orbit camera. No gameplay. |
| **RPG prototype** | `/play.html` | A third-person action-RPG arena: KayKit knight and skeletons, camera-relative movement, target lock-on and animation-driven combat. |

Both are built with **Vite 8 + TypeScript 7 + three.js 0.187** using `WebGLRenderer`.

## Requirements

- **Node.js 23.6+ or 24.x** (developed on 24.18). `npm test` runs the TypeScript
  files directly, relying on Node's built-in type stripping, and uses
  `module.registerHooks` from `node:module` to resolve the app's extensionless
  imports — both need a recent runtime. On Node 22 this test script will not run.
- npm

## Commands

```bash
npm install
npm run dev        # development server (both entry points)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
npm run test       # focused unit tests (node:test)
npm run typecheck  # tsc --noEmit only
```

`npm run build` runs `tsc --noEmit` first; a type error fails the build.

---

# RPG prototype (`/play.html`)

A walled glade with a ruin, three skeleton enemies, and a knight with a sword and
shield. Damage is driven by the real KayKit animation clips: the hit lands at the
authored strike frame, not on the button press.

## Controls

### Desktop

| Action | Control |
| --- | --- |
| Capture / release mouse | click the canvas / `Esc` |
| Look | mouse (pointer lock); click-drag if capture is unavailable |
| Move | `W` `A` `S` `D` (camera-relative) |
| Run / jump | `Shift` / `Space` |
| Light attack | `J` or left click |
| Heavy attack | `K` |
| Block (hold) | `F` or right mouse button |
| Dodge | `C` (or `L`) |
| Lock on / release | `Tab` |
| Next target | `Q` |
| Zoom | mouse wheel |
| Mute combat audio | `M` |
| Restart after death | `R` |

Movement is camera-relative. While locked on, the knight keeps facing the target,
so `A`/`D` strafe and `S` retreats.

### Touch

- Left half of the screen is a virtual stick; right half looks around; pinch zooms.
- `⚔` light attack · `⚡` heavy attack · `↯` dodge · `🛡` block (hold) · `◎` target lock.

The stick, camera and combat buttons are independent pointers, so all three work
at once. Guard is released on `pointerup`, `pointercancel` and focus loss.

## Quality settings

Three presets: **low**, **medium**, **high**. Desktop defaults to medium, touch
devices to low.

| | Low | Medium | High |
| --- | --- | --- | --- |
| Pixel ratio cap | 1.0× | 1.35× | 2.0× |
| Shadow map | 512, basic | 1024, PCF | 2048, PCF soft |
| Foliage casts shadows | no | yes | yes |
| Fog | 45–95 | 60–130 | 70–150 |

Choose one with the URL (`/play.html?quality=low`) or via the stored preference in
`localStorage` under `littleworlds.quality`. The drawing buffer is not preserved;
screenshots re-render and read the frame in the same task.

## Architecture notes

- **Camera** — pointer-lock yaw/pitch with damped follow, wheel zoom, recentering
  behind travel, and a boom traced against convex proxies so walls and trunks pull
  the camera in immediately and release it smoothly.
- **Collision** — `src/play/collision.ts` holds closed-form segment/box and
  segment/cylinder tests over a small registered proxy list. The camera, target
  line-of-sight, attack reach and player/enemy wall resolution all share it; the
  scene is never raycast.
- **Targeting** — `src/play/targeting.ts` scores registered enemies on distance,
  camera angle, facing and visibility, refreshed on an interval rather than every
  frame. `Tab` locks, `Q` cycles, and a lock drops when the target dies, leaves
  range or stays out of sight.
- **Animation** — clips come from `public/rpg/anims/`; each attack damages during
  its authored strike window (`hitStart`/`hitEnd` in `src/play/player.ts`), and
  dodge clips replay their captured root travel.
- **Combat feedback** — landed blows spawn a pooled additive ring, a short
  hit-stop (45 ms on light, 75 ms on heavy), camera shake and a procedural
  WebAudio impact; a swing that hits nothing only plays the whoosh. Enemies that
  commit to an attack show a filling ground ring until the blow lands.
- **Debug harness** — `window.__play` is attached only in development or when the
  page is opened with `?debug`. It is absent from a normal production build.

## RPG limitations

- Enemies push out of walls but do not path around them; they can get stuck behind
  the ruin.
- The KayKit Character Animations pack has no roll clip. Its `Dodge_*` clips are
  short evasive steps (0.25–0.65 m of authored travel), which is what the dodge
  plays.
- Performance figures measured on a laptop through ANGLE are not a GPU benchmark.

---

# Island demo (`/index.html`)

A cozy floating-island scene: one island, a small cottage, a pond, scattered
vegetation and a 3/4 orbit camera. Visual prototype only — no gameplay, no
creatures, no saving, no backend.

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

## Graphics presets (island)

Chosen automatically on first load (coarse pointer + `deviceMemory` +
`hardwareConcurrency`), then remembered in `localStorage` under
`little-worlds.quality` (distinct from the RPG's `littleworlds.quality`).

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
index.html            island canvas + HUD shell
play.html             RPG canvas + HUD shell
src/main.ts           island: boot, renderer, quality switching, frame loop
src/config.ts         island: palette, world layout, camera and quality presets
src/assets.ts         island: GLB loading, material fixes, instancing and cloning
src/terrain.ts        island: surface + tapered underside, height function, colours
src/environment.ts    island: sky dome, cloud deck, lighting, pond water
src/island.ts         island: hut assembly, camp, pond decor, paths and scatter
src/camera.ts         island: orbit rig (damping, pinch, keyboard)
src/ui.ts             island: stats readout, preset buttons, loading screen
src/play/             RPG: camera, input, player, enemies, world, targeting,
                      collision, quality, HUD, character rigs and models
tests/                node:test unit tests + the TypeScript resolve hook
public/models/        the 38 island GLB models (+ the Fantasy Town atlas)
public/rpg/           curated KayKit characters, animations, weapons, props
```

### Asset notes

- **Nature Kit ships `metallicFactor: 1` on every material.** Without an
  environment map those surfaces render almost black, so `assets.ts` forces
  `metalness: 0` on load. Fantasy Town already exports 0.
- Both island kits use flat shading; materials are switched to `flatShading` to
  match how the models were authored.
- **Fantasy Town models load a shared external atlas** at `Textures/colormap.png`,
  resolved relative to the GLB. Keep the folder layout intact.
- Scatter and repeated props are `InstancedMesh` batches; their instance count is
  lowered per preset instead of rebuilding the scene.
- Every KayKit character shares the 23-bone `Rig_Medium` skeleton, so one clip set
  animates the knight and both skeleton types.

### Units

Everything is in Kenney/KayKit kit units (one unit ≈ one metre). The island is ~16
units across; the RPG arena is 34 units in radius. No per-asset scaling hacks are
applied.

## Island limitations

- Frame-rate numbers from a headless/software-rendered browser are **not**
  representative; real-device performance has not been measured yet.
- The pond is a shader disc, not a physics surface; nothing interacts with it yet.
- No audio, no save system, no gameplay systems.

## Licence

Code: not yet licensed. Assets: CC0, see [CREDITS.md](CREDITS.md).
