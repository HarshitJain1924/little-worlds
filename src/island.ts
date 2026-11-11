import * as THREE from 'three';
import { SITES, WORLD } from './config';
import { ModelLibrary, cloneModel, instanceModel } from './assets';
import type { Placement } from './assets';
import { edgeRadius, pondRadius, terrainHeightAt } from './terrain';

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
const TAU = Math.PI * 2;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Low-frequency field: 0 is a thicket, 1 is open ground. Scatter is thinned
 * where it is high, which is what breaks the carpet into patches.
 */
function opennessAt(x: number, z: number): number {
  const a = Math.sin(x * 0.33 + Math.cos(z * 0.28) * 1.7);
  const b = Math.cos(z * 0.25 - x * 0.17 + 0.7);
  return 0.5 + 0.5 * a * b;
}

type DensityKind = 'grass' | 'flowers' | 'trees';

interface ScatterOptions {
  count: number;
  minRadius: number;
  maxRadius: number;
  spacing: number;
  /** How many patches the points gather into. */
  clumps: number;
  clumpRadius: [number, number];
  /** How strictly open ground wins: 0 scatters anywhere, 1 only in clearings. */
  openness?: number;
  /** Share of points that sit alone between patches. */
  strays?: number;
  scale?: [number, number];
  avoid?: { x: number; z: number; radius: number }[];
}

const avoidDefault = [
  { x: SITES.pond.x, z: SITES.pond.z, radius: SITES.pond.radius + 0.55 },
  { x: SITES.hut.x, z: SITES.hut.z, radius: SITES.hut.clearing * 0.8 },
  { x: SITES.camp.x, z: SITES.camp.z, radius: SITES.camp.clearing * 0.82 },
];

/**
 * Patches first, then points inside them, with a share of lone strays. A
 * rejection pass keeps patches apart and open ground empty, so the result reads
 * as thickets and clearings instead of an even carpet.
 */
function scatterPoints(options: ScatterOptions): Placement[] {
  const { count, minRadius, maxRadius, spacing } = options;
  const avoid = options.avoid ?? avoidDefault;
  const [minScale, maxScale] = options.scale ?? [0.85, 1.15];
  const opennessBias = options.openness ?? 0.6;
  const strayShare = options.strays ?? 0.14;
  const [clumpMin, clumpMax] = options.clumpRadius;
  const points: Placement[] = [];

  const clumps: { x: number; z: number; radius: number }[] = [];
  for (let i = 0; i < options.clumps; i += 1) {
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const angle = rng() * TAU;
      const radius = minRadius + Math.sqrt(rng()) * Math.max(0.5, maxRadius - minRadius - 1.2);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (Math.hypot(x, z) > edgeRadius(angle) - 1.1) continue;
      if (avoid.some((zone) => Math.hypot(x - zone.x, z - zone.z) < zone.radius + 0.3)) continue;
      if (clumps.some((other) => Math.hypot(x - other.x, z - other.z) < 2.3)) continue;
      clumps.push({ x, z, radius: clumpMin + rng() * (clumpMax - clumpMin) });
      break;
    }
  }

  let attempts = 0;
  while (points.length < count && attempts < count * 200) {
    attempts += 1;

    let x: number;
    let z: number;
    if (clumps.length === 0 || rng() < strayShare) {
      const angle = rng() * TAU;
      const radius = minRadius + Math.sqrt(rng()) * Math.max(0.5, maxRadius - minRadius);
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
    } else {
      const clump = clumps[Math.floor(rng() * clumps.length)];
      const angle = rng() * TAU;
      const radius = Math.sqrt(rng()) * clump.radius;
      x = clump.x + Math.cos(angle) * radius;
      z = clump.z + Math.sin(angle) * radius;
    }

    if (Math.hypot(x, z) > edgeRadius(Math.atan2(z, x)) - 0.9) continue;
    if (avoid.some((zone) => Math.hypot(x - zone.x, z - zone.z) < zone.radius)) continue;
    if (points.some((point) => Math.hypot(x - point.x, z - point.z) < spacing)) continue;

    // Open ground stays open, which is what leaves readable negative space.
    const chance = 1 - opennessBias + opennessBias * smoothstep(0.12, 0.68, opennessAt(x, z));
    if (rng() > chance) continue;

    points.push({
      x,
      y: terrainHeightAt(x, z),
      z,
      yaw: rng() * TAU,
      scale: minScale + rng() * (maxScale - minScale),
    });
  }

  // Shuffle so a quality preset that trims the tail thins every patch evenly
  // instead of deleting whole clumps.
  for (let i = points.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = points[i];
    points[i] = points[j];
    points[j] = swap;
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

  const add = (name: string, x: number, z: number, yaw: number, scale = 1) => {
    group.add(cloneModel(models.get(name), { x, y: terrainHeightAt(x, z), z, yaw, scale }));
  };

  add('tent_smallOpen', SITES.camp.x - 1.0, SITES.camp.z - 0.4, -0.55);
  add('campfire_stones', SITES.camp.x + 0.5, SITES.camp.z + 0.5, 0.4);
  add('log', SITES.camp.x - 0.2, SITES.camp.z - 1.6, 0.15);
  add('stump_round', SITES.camp.x + 1.5, SITES.camp.z - 0.9, 1.1);
  // A second log on the far side makes the fire a place to sit, not a prop.
  add('log', SITES.camp.x + 0.9, SITES.camp.z - 0.7, 1.35, 0.9);

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

  // The canoe is beached on the bank where the path arrives.
  const angle = 0.75;
  const canoeX = SITES.pond.x + Math.cos(angle) * pondRadius(angle) * 1.06;
  const canoeZ = SITES.pond.z + Math.sin(angle) * pondRadius(angle) * 1.06;
  group.add(
    cloneModel(models.get('canoe'), {
      x: canoeX,
      y: terrainHeightAt(canoeX, canoeZ) + 0.1,
      z: canoeZ,
      yaw: -angle + 1.2,
    }),
  );

  return group;
}

/**
 * Reeds and flat rocks along the waterline. They hug the shoreline angle by
 * angle, so the pond edge reads as a planted bank rather than a cut circle.
 */
function buildPondShore(models: ModelLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pond-shore';

  const reeds: Placement[] = [];
  const reedGroups = [
    [0.15, 0.45, 0.75],
    [2.05, 2.3],
    [3.75, 4.05, 4.35],
    [5.35, 5.6],
  ];
  for (const cluster of reedGroups) {
    const base = cluster[0];
    for (const angle of cluster) {
      const r = pondRadius(angle) * (1.0 + rng() * 0.09);
      const jitter = (rng() - 0.5) * 0.35;
      const x = SITES.pond.x + Math.cos(angle + jitter * 0.1) * r;
      const z = SITES.pond.z + Math.sin(base + jitter * 0.1) * r;
      reeds.push({
        x,
        y: terrainHeightAt(x, z),
        z,
        yaw: rng() * TAU,
        scale: 0.5 + rng() * 0.3,
      });
    }
  }
  group.add(instanceModel(models.get('grass_large'), reeds, { castShadow: false, receiveShadow: true }));

  const rocks: Placement[] = [];
  for (const angle of [0.95, 1.75, 2.85, 4.0, 5.05]) {
    const r = pondRadius(angle) * (1.02 + rng() * 0.05);
    const x = SITES.pond.x + Math.cos(angle) * r;
    const z = SITES.pond.z + Math.sin(angle) * r;
    rocks.push({
      x,
      y: terrainHeightAt(x, z),
      z,
      yaw: rng() * TAU,
      scale: 0.55 + rng() * 0.4,
    });
  }
  group.add(instanceModel(models.get('rock_smallFlatA'), rocks, { receiveShadow: true }));

  return group;
}

/**
 * Stepping stones from the cottage door to the campfire and to the pond bank:
 * the two places the island's story happens.
 */
function buildPath(models: ModelLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'path';

  const door = { x: SITES.hut.x - 0.95, z: SITES.hut.z + 0.15 };
  const pondAngle = 1.05;
  const legs = [
    {
      to: { x: SITES.camp.x + 1.6, z: SITES.camp.z + 1.5 },
      steps: 5,
      bend: 0.85,
    },
    {
      to: {
        x: SITES.pond.x + Math.cos(pondAngle) * (pondRadius(pondAngle) + 0.85),
        z: SITES.pond.z + Math.sin(pondAngle) * (pondRadius(pondAngle) + 0.85),
      },
      steps: 4,
      bend: -0.7,
    },
  ];

  for (const leg of legs) {
    const dx = leg.to.x - door.x;
    const dz = leg.to.z - door.z;
    const length = Math.hypot(dx, dz);
    const nx = -dz / length;
    const nz = dx / length;

    for (let i = 0; i < leg.steps; i += 1) {
      const t = (i + 0.5) / leg.steps;
      const sway = Math.sin(t * Math.PI) * leg.bend;
      const x = door.x + dx * t + nx * sway;
      const z = door.z + dz * t + nz * sway;

      if (Math.hypot(x - SITES.pond.x, z - SITES.pond.z) < SITES.pond.radius + 0.45) continue;
      if (Math.hypot(x, z) > edgeRadius(Math.atan2(z, x)) - 1.2) continue;

      group.add(
        cloneModel(models.get('path_stone'), {
          x,
          y: terrainHeightAt(x, z) + 0.012,
          z,
          yaw: rng() * TAU,
          scale: 0.72 + rng() * 0.24,
        }),
      );
    }
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
          count: Math.round(260 * share),
          minRadius: 0.9,
          maxRadius: WORLD.radius - 0.6,
          spacing: 0.3,
          clumps: 10,
          clumpRadius: [0.85, 1.9],
          openness: 0.5,
          strays: 0.18,
          scale: [0.55, 0.9],
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
          count: Math.round(46 * share),
          minRadius: 1.7,
          maxRadius: WORLD.radius - 1.2,
          spacing: 0.5,
          clumps: 6,
          clumpRadius: [0.55, 1.25],
          openness: 0.85,
          strays: 0.1,
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
          count: Math.round(22 * share),
          minRadius: 1.9,
          maxRadius: WORLD.radius - 1.3,
          spacing: 1.3,
          clumps: 4,
          clumpRadius: [1.4, 2.8],
          openness: 0.55,
          strays: 0.2,
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
        spacing: 0.9,
        clumps: 5,
        clumpRadius: [0.5, 1.1],
        openness: 0.75,
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
        spacing: 1.2,
        clumps: 3,
        clumpRadius: [0.6, 1.3],
        openness: 0.6,
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
        minRadius: 2.0,
        maxRadius: WORLD.radius - 1.5,
        spacing: 0.85,
        clumps: 4,
        clumpRadius: [0.35, 0.9],
        // Mushrooms keep to the shade, not the clearings.
        openness: 0.15,
        scale: [0.8, 1.3],
      }),
      'flowers',
    ),
  );

  for (const [name, count] of [
    ['rock_largeA', 5],
    ['rock_tallA', 3],
    ['rock_smallFlatA', 6],
    ['stone_largeA', 4],
  ] as [string, number][]) {
    layers.push(
      addLayer(
        root,
        models,
        name,
        scatterPoints({
          count,
          minRadius: WORLD.radius - 2.8,
          maxRadius: WORLD.radius - 0.7,
          spacing: 0.9,
          clumps: 4,
          clumpRadius: [0.5, 1.4],
          openness: 0.5,
          scale: [0.8, 1.15],
        }),
        'trees',
      ),
    );
  }

  root.add(buildHut(models));
  root.add(buildCamp(models));
  root.add(buildPondDecor(models, SITES.pond.waterLevel));
  root.add(buildPondShore(models));
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
