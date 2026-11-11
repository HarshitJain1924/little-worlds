import * as THREE from 'three';
import { SITES, WORLD } from './config';
import { ModelLibrary, cloneModel, instanceModel } from './assets';
import type { Placement } from './assets';
import { terrainHeightAt } from './terrain';

/** Deterministic RNG so the island looks the same on every load. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(WORLD.seed);

type DensityKind = 'grass' | 'flowers' | 'trees';

interface ScatterOptions {
  count: number;
  minRadius: number;
  maxRadius: number;
  spacing: number;
  avoid?: { x: number; z: number; radius: number }[];
  scale?: [number, number];
}

const avoidDefault = [
  { x: SITES.pond.x, z: SITES.pond.z, radius: SITES.pond.radius + 0.5 },
  { x: SITES.hut.x, z: SITES.hut.z, radius: SITES.hut.clearing * 0.8 },
  { x: SITES.camp.x, z: SITES.camp.z, radius: SITES.camp.clearing * 0.82 },
];

function scatterPoints(options: ScatterOptions): Placement[] {
  const { count, minRadius, maxRadius, spacing } = options;
  const avoid = options.avoid ?? avoidDefault;
  const [minScale, maxScale] = options.scale ?? [0.85, 1.15];
  const points: Placement[] = [];
  let attempts = 0;

  while (points.length < count && attempts < count * 80) {
    attempts += 1;
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * (maxRadius - minRadius) + minRadius;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (Math.hypot(x, z) > WORLD.radius - 0.8) continue;
    if (avoid.some((zone) => Math.hypot(x - zone.x, z - zone.z) < zone.radius)) continue;
    if (points.some((point) => Math.hypot(x - point.x, z - point.z) < spacing)) continue;

    points.push({
      x,
      y: terrainHeightAt(x, z),
      z,
      yaw: rng() * Math.PI * 2,
      scale: minScale + rng() * (maxScale - minScale),
    });
  }

  return points;
}

/** A batch of instanced models whose instance count can be lowered at runtime. */
interface Layer {
  group: THREE.Group;
  max: number;
  kind: DensityKind;
}

function addLayer(
  root: THREE.Group,
  models: ModelLibrary,
  name: string,
  placements: Placement[],
  kind: DensityKind,
): Layer {
  const group = instanceModel(models.get(name), placements, {
    castShadow: kind !== 'grass',
    receiveShadow: true,
  });
  group.name = `layer:${name}`;
  root.add(group);
  return { group, max: placements.length, kind };
}

/** Three-bay cottage: the island's focal point. */
function buildHut(models: ModelLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hut';
  group.position.set(SITES.hut.x, terrainHeightAt(SITES.hut.x, SITES.hut.z), SITES.hut.z);
  group.rotation.y = SITES.hut.yaw;

  const add = (name: string, x: number, y: number, z: number, yaw = 0) => {
    group.add(cloneModel(models.get(name), { x, y, z, yaw }));
  };

  // Wall bays run along local X; the front face is +Z.
  add('wall-block', -1, 0, 0);
  add('wall-block', 0, 0, 0);
  add('wall-block', 1, 0, 0);

  // Door panel is 0.53 deep on its +X face: rotate to face +Z, sink it into the wall.
  add('wall-door', 0, 0, 0.25, -Math.PI / 2);
  // Window panels are 0.1 thick overlays, sat just proud of a wall face.
  add('wall-window-small', -1, 0, 0.06, -Math.PI / 2);
  add('wall-window-small', 1.06, 0, 0);

  // Roof: 0.55 end + 1.1 + 1.1 + 0.55 end = 3.3 over a 3.0 building.
  add('roof-gable-end', -1.1, 1, 0, Math.PI);
  add('roof-gable', -1.1, 1, 0);
  add('roof-gable', 0, 1, 0);
  add('roof-gable-end', 1.1, 1, 0);

  add('chimney', 0.95, 1, -0.18);

  add('planks', -1, 0.02, 1);
  add('planks', 0, 0.02, 1);
  add('planks', 1, 0.02, 1);

  add('lantern', 1.85, 0, 1.15);
  add('stump_round', -1.95, 0, 1.35, 0.6);
  add('log', -2.6, 0, 0.55, 0.9);
  add('sign', -0.9, 0, 1.8, 0.25);

  return group;
}

function buildCamp(models: ModelLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'camp';

  const add = (name: string, x: number, z: number, yaw: number) => {
    group.add(cloneModel(models.get(name), { x, y: terrainHeightAt(x, z), z, yaw }));
  };

  add('tent_smallOpen', SITES.camp.x - 1.0, SITES.camp.z - 0.4, -0.55);
  add('campfire_stones', SITES.camp.x + 0.5, SITES.camp.z + 0.5, 0.4);
  add('log', SITES.camp.x - 0.2, SITES.camp.z - 1.6, 0.15);
  add('stump_round', SITES.camp.x + 1.5, SITES.camp.z - 0.9, 1.1);

  return group;
}

function buildPondDecor(models: ModelLibrary, waterLevel: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pond-decor';

  const lilies: Placement[] = [
    { x: SITES.pond.x - 0.9, y: waterLevel + 0.02, z: SITES.pond.z + 0.7, yaw: 0.4, scale: 1.1 },
    { x: SITES.pond.x + 0.6, y: waterLevel + 0.02, z: SITES.pond.z - 0.8, yaw: 1.9, scale: 0.9 },
    { x: SITES.pond.x + 1.2, y: waterLevel + 0.02, z: SITES.pond.z + 1.1, yaw: 3.1, scale: 1.0 },
    { x: SITES.pond.x - 1.4, y: waterLevel + 0.02, z: SITES.pond.z - 1.0, yaw: 5.2, scale: 0.85 },
  ];
  group.add(instanceModel(models.get('lily_large'), lilies, { castShadow: false }));

  const canoeX = SITES.pond.x + SITES.pond.radius * 0.88;
  const canoeZ = SITES.pond.z + SITES.pond.radius * 0.44;
  group.add(
    cloneModel(models.get('canoe'), {
      x: canoeX,
      y: terrainHeightAt(canoeX, canoeZ) + 0.16,
      z: canoeZ,
      yaw: -0.9,
    }),
  );

  return group;
}

function buildPath(models: ModelLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'path';

  const from = { x: SITES.hut.x - 1.3, z: SITES.hut.z + 1.1 };
  const to = { x: SITES.camp.x + 2.4, z: SITES.camp.z + 1.6 };
  const steps = 7;

  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const x = from.x + (to.x - from.x) * t + Math.sin(t * 5.2) * 1.15;
    const z = from.z + (to.z - from.z) * t + Math.cos(t * 3.4) * 0.85;
    if (Math.hypot(x - SITES.pond.x, z - SITES.pond.z) < SITES.pond.radius + 0.6) continue;

    group.add(
      cloneModel(models.get('path_stone'), {
        x,
        y: terrainHeightAt(x, z) + 0.012,
        z,
        yaw: rng() * Math.PI * 2,
        scale: 0.7 + rng() * 0.25,
      }),
    );
  }

  return group;
}

export interface IslandView {
  root: THREE.Group;
  applyDensity: (limits: { grass: number; flowers: number; trees: number }) => void;
}

export function buildIsland(models: ModelLibrary): IslandView {
  const root = new THREE.Group();
  root.name = 'island';
  const layers: Layer[] = [];

  const grassMix: [string, number][] = [
    ['grass', 0.6],
    ['grass_large', 0.4],
  ];
  for (const [name, share] of grassMix) {
    layers.push(
      addLayer(
        root,
        models,
        name,
        scatterPoints({
          count: Math.round(300 * share),
          minRadius: 1.0,
          maxRadius: WORLD.radius - 0.6,
          spacing: 0.4,
          scale: [0.6, 0.95],
        }),
        'grass',
      ),
    );
  }

  const flowerMix: [string, number][] = [
    ['flower_redA', 0.3],
    ['flower_purpleA', 0.3],
    ['flower_yellowA', 0.24],
    ['plant_flatShort', 0.16],
  ];
  for (const [name, share] of flowerMix) {
    layers.push(
      addLayer(
        root,
        models,
        name,
        scatterPoints({
          count: Math.round(42 * share),
          minRadius: 1.8,
          maxRadius: WORLD.radius - 1.2,
          spacing: 0.62,
          scale: [0.85, 1.2],
        }),
        'flowers',
      ),
    );
  }

  const treeMix: [string, number][] = [
    ['tree_oak', 0.16],
    ['tree_pineTallA_detailed', 0.14],
    ['tree_pineRoundA', 0.12],
    ['tree_palm', 0.1],
    ['tree_simple', 0.16],
    ['tree_small', 0.18],
    ['tree_thin', 0.14],
  ];
  for (const [name, share] of treeMix) {
    layers.push(
      addLayer(
        root,
        models,
        name,
        scatterPoints({
          count: Math.round(20 * share),
          minRadius: 1.9,
          maxRadius: WORLD.radius - 1.3,
          spacing: 1.35,
          scale: [1.0, 1.35],
        }),
        'trees',
      ),
    );
  }

  layers.push(
    addLayer(
      root,
      models,
      'plant_bush',
      scatterPoints({
        count: 12,
        minRadius: 1.4,
        maxRadius: WORLD.radius - 1.0,
        spacing: 0.95,
        scale: [0.9, 1.25],
      }),
      'flowers',
    ),
  );

  layers.push(
    addLayer(
      root,
      models,
      'plant_bushLarge',
      scatterPoints({
        count: 7,
        minRadius: 1.7,
        maxRadius: WORLD.radius - 1.4,
        spacing: 1.3,
        scale: [0.9, 1.15],
      }),
      'trees',
    ),
  );

  layers.push(
    addLayer(
      root,
      models,
      'mushroom_red',
      scatterPoints({
        count: 9,
        minRadius: 2.1,
        maxRadius: WORLD.radius - 1.5,
        spacing: 1.0,
        scale: [0.8, 1.3],
      }),
      'flowers',
    ),
  );

  for (const [name, count] of [
    ['rock_largeA', 5],
    ['rock_tallA', 3],
    ['rock_smallFlatA', 7],
    ['stone_largeA', 4],
  ] as [string, number][]) {
    layers.push(
      addLayer(
        root,
        models,
        name,
        scatterPoints({
          count,
          minRadius: WORLD.radius - 2.6,
          maxRadius: WORLD.radius - 0.7,
          spacing: 0.95,
          scale: [0.8, 1.15],
        }),
        'trees',
      ),
    );
  }

  root.add(buildHut(models));
  root.add(buildCamp(models));
  root.add(buildPondDecor(models, SITES.pond.waterLevel));
  root.add(buildPath(models));

  const totals: Record<DensityKind, number> = { grass: 0, flowers: 0, trees: 0 };
  for (const built of layers) totals[built.kind] += built.max;

  const applyDensity = (limits: { grass: number; flowers: number; trees: number }) => {
    for (const built of layers) {
      const ratio = Math.min(1, limits[built.kind] / Math.max(1, totals[built.kind]));
      const count = Math.max(0, Math.min(built.max, Math.round(built.max * ratio)));
      for (const child of built.group.children) {
        if (child instanceof THREE.InstancedMesh) child.count = count;
      }
    }
  };

  return { root, applyDensity };
}
