import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CameraObstacle } from './collision';
import type { MergeEntry, Placement } from './models';
import { DUNGEON, FOREST, buildMerged, loadDungeon, loadForest, loadTown } from './models';
import {
  BUILDINGS,
  GATE,
  TOWN,
  TOWN_MODULES,
  buildingFootprint,
  buildingPlacements,
  dirtFactor,
  heightAt,
  isInsideBuilding,
  nearestPath,
  pathDistance,
  pavingFactor,
  propPlacements,
  roadPlacements,
  townBlockers,
  townObstacles,
  type Blocker,
  type TownPlacement,
} from './town';

export { heightAt };
export type { Blocker };

/**
 * Playable bounds and the safe spawn, kept as one object because the enemy
 * controller leashes to the same radius the terrain is authored against.
 */
export const ARENA = {
  radius: TOWN.radius,
  spawn: TOWN.spawn,
  gate: TOWN.gate,
  seed: TOWN.seed,
} as const;

export interface World {
  group: THREE.Group;
  heightAt: typeof heightAt;
  blockers: Blocker[];
  /** Convex proxies for camera collision and target line of sight. */
  obstacles: CameraObstacle[];
  /** Instanced vegetation, so quality settings can drop its shadow casters. */
  foliage: THREE.Group;
  dispose: () => void;
}

// A darker, warmer palette than the first pass: olive meadow instead of neon
// lawn, trodden brown streets, warm flagstones and cool gate court stone.
const GRASS_BASE = new THREE.Color(0x74964a);
const GRASS_LIGHT = new THREE.Color(0x9db766);
const GRASS_DRY = new THREE.Color(0x8d9450);
const GRASS_DARK = new THREE.Color(0x4d6933);
const DIRT = new THREE.Color(0x9a8058);
const DIRT_DARK = new THREE.Color(0x746040);
const COBBLE = new THREE.Color(0xa7a08e);
const COURT = new THREE.Color(0x92948a);

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const BUILDING_FOOTPRINTS = BUILDINGS.map((building) => buildingFootprint(building));

/**
 * Worn earth at the foot of every wall. Buildings that sit on bare grass read as
 * dropped-in models; a soft apron of trodden ground ties them to the street.
 */
function buildingApron(x: number, z: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const footprint of BUILDING_FOOTPRINTS) {
    const dx = Math.max(footprint.minX - x, 0, x - footprint.maxX);
    const dz = Math.max(footprint.minZ - z, 0, z - footprint.maxZ);
    distance = Math.min(distance, Math.hypot(dx, dz));
  }
  return 1 - smoothstep(0.15, 2.4, distance);
}

function groundColour(x: number, z: number, out: THREE.Color): THREE.Color {
  const broad = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + Math.sin(x * 0.05) * 2.1);
  const fine = 0.5 + 0.5 * Math.sin(x * 0.42 + z * 0.31);
  const dry = 0.5 + 0.5 * Math.sin(x * 0.06 + z * 0.09 + 1.7);

  out.copy(GRASS_BASE);
  out.lerp(GRASS_LIGHT, broad * 0.26 + fine * 0.16);
  out.lerp(GRASS_DARK, (1 - broad) * 0.4);
  out.lerp(GRASS_DRY, dry * 0.3);

  // Worn earth under the eaves and trodden edges along every lane.
  out.lerp(DIRT_DARK, buildingApron(x, z) * 0.4);
  const near = nearestPath(x, z);
  const half = near.path.width * 0.5;
  if (near.distance > half) {
    const edge = 1 - smoothstep(half + 0.15, half + 1.2, near.distance);
    out.lerp(DIRT_DARK, edge * (near.path.kind === 'dirt' ? 0.38 : 0.2));
  }

  // The forest route reads as trodden dirt before the stones start.
  out.lerp(DIRT, dirtFactor(x, z) * 0.86);

  // Plaza, lanes and the gate court are pale flagstones under the tiles.
  out.lerp(COBBLE, pavingFactor(x, z) * 0.8);

  const gate = Math.min(1, Math.max(0, 1 - Math.hypot(x - TOWN.gate.x, z - TOWN.gate.z) / 9));
  out.lerp(COURT, gate * 0.32);

  const rim = Math.min(1, Math.max(0, (Math.hypot(x, z) - (TOWN.radius - 4)) / 14));
  out.lerp(GRASS_DARK, rim * 0.55);

  // Two wheel ruts down the approach street, painted after the dirt so the road
  // reads as used rather than as a flat brown band.
  if (z > 8 && z < 31 && Math.abs(x) < 3) {
    const rut = 1 - smoothstep(0.08, 0.45, Math.abs(Math.abs(x) - 1.15));
    out.lerp(DIRT_DARK, rut * 0.32);
  }

  return out;
}

function createGround(): THREE.Mesh {
  const size = (TOWN.radius + 40) * 2;
  // The town is flat, so a 96² grid is enough for the rolling outskirts; the old
  // 128² plane spent 32k triangles on ground that never moves.
  const geometry = new THREE.PlaneGeometry(size, size, 96, 96);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colours = new Float32Array(positions.count * 3);
  const colour = new THREE.Color();

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    positions.setY(i, heightAt(x, z));
    groundColour(x, z, colour);
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }

  positions.needsUpdate = true;
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

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

/**
 * Nothing may grow on a street, in a doorway, inside a house, on the sealed
 * court or inside the windmill. The margin keeps canopies out of roofs and stops
 * the treeline from pushing into the lanes.
 */
function clearOfTown(x: number, z: number, margin: number): boolean {
  if (isInsideBuilding(x, z, margin)) return false;
  if (Math.hypot(x - TOWN.plaza.x, z - TOWN.plaza.z) < TOWN.plaza.radius + margin) return false;
  if (pathDistance(x, z) < margin + 1.8) return false;
  if (Math.hypot(x - TOWN.gate.x, z - TOWN.gate.z) < 8 + margin) return false;
  if (Math.hypot(x - TOWN.spawn.x, z - TOWN.spawn.z) < 5 + margin) return false;
  if (Math.hypot(x - TOWN.windmill.x, z - TOWN.windmill.z) < 4.5 + margin) return false;
  return true;
}

interface ScatterOptions {
  count: number;
  minRadius: number;
  maxRadius: number;
  minScale: number;
  maxScale: number;
  margin: number;
  lift?: number;
}

function scatter(
  models: GLTF[],
  random: () => number,
  options: ScatterOptions,
): Placement[][] {
  const perModel: Placement[][] = models.map(() => []);

  for (let i = 0; i < options.count; i += 1) {
    let x = 0;
    let z = 0;
    let placed = false;

    // Rejection sampling keeps the treeline irregular without ever landing a
    // trunk in a street; a handful of attempts is enough at these densities.
    for (let attempt = 0; attempt < 8 && !placed; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const radius = options.minRadius + random() * (options.maxRadius - options.minRadius);
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      placed = clearOfTown(x, z, options.margin);
    }
    if (!placed) continue;

    const index = Math.floor(random() * models.length) % models.length;
    perModel[index].push({
      x,
      y: heightAt(x, z) - (options.lift ?? 0.05),
      z,
      yaw: random() * Math.PI * 2,
      scale: options.minScale + random() * (options.maxScale - options.minScale),
    });
  }

  return perModel;
}

/** Group town placements by module, ready to bake into merged geometry. */
function townEntries(
  list: TownPlacement[],
  models: Map<string, GLTF>,
): MergeEntry[] {
  const grouped = new Map<string, Placement[]>();
  for (const { module, ...placement } of list) {
    const bucket = grouped.get(module);
    if (bucket) bucket.push(placement);
    else grouped.set(module, [placement]);
  }

  const entries: MergeEntry[] = [];
  for (const [module, placements] of grouped) {
    const gltf = models.get(module);
    if (!gltf) throw new Error(`missing town module ${module}`);
    entries.push({ gltf, placements });
  }
  return entries;
}

function forestEntries(models: GLTF[], placements: Placement[][]): MergeEntry[] {
  return models.map((gltf, index) => ({ gltf, placements: placements[index] ?? [] }));
}

export async function buildWorld(onProgress: (fraction: number, label: string) => void): Promise<World> {
  const group = new THREE.Group();
  group.name = 'world';
  const foliage = new THREE.Group();
  foliage.name = 'foliage';
  group.add(foliage);

  onProgress(0.04, 'shaping the ground…');
  group.add(createGround());

  const random = mulberry32(TOWN.seed);

  // ---- town kit ---------------------------------------------------------
  onProgress(0.1, 'hauling timber and stone…');
  const townModels = new Map<string, GLTF>();
  await Promise.all(
    TOWN_MODULES.map(async (name) => {
      townModels.set(name, await loadTown(name));
    }),
  );

  onProgress(0.3, 'raising the houses…');
  const solids: TownPlacement[] = [];
  for (const building of BUILDINGS) solids.push(...buildingPlacements(building));
  solids.push(...propPlacements());

  // Boulders bed the arch into the hillside instead of leaving it free-standing.
  for (const [x, z, yaw, scale] of [
    [GATE.x - 6.8, GATE.z + 2.4, 0.4, 3],
    [GATE.x + 6.9, GATE.z + 2.1, 1.3, 3.2],
    [GATE.x - 7.6, GATE.z - 1.4, 2.2, 3.6],
    [GATE.x + 7.4, GATE.z - 1.6, 0.9, 3.4],
  ] as const) {
    solids.push({ module: 'rock-large', x, y: heightAt(x, z) - 0.1, z, yaw, scale });
  }

  // The whole town — walls, roofs, awnings, props, boulders — is static, so it
  // bakes into one shadow-casting mesh instead of one InstancedMesh per module.
  group.add(buildMerged(townEntries(solids, townModels), { name: 'town', castShadow: true }));

  onProgress(0.44, 'paving the streets…');
  group.add(
    buildMerged(townEntries(roadPlacements(), townModels), {
      name: 'paving',
      castShadow: false,
    }),
  );

  // ---- forest -----------------------------------------------------------
  const forestNames = [...FOREST.trees, ...FOREST.bushes, ...FOREST.rocks, ...FOREST.grass];
  onProgress(0.58, 'growing the forest…');
  const forestModels = await Promise.all(forestNames.map((name) => loadForest(name)));

  const trees = forestModels.slice(0, FOREST.trees.length);
  const bushes = forestModels.slice(FOREST.trees.length, FOREST.trees.length + FOREST.bushes.length);
  const rocks = forestModels.slice(
    FOREST.trees.length + FOREST.bushes.length,
    FOREST.trees.length + FOREST.bushes.length + FOREST.rocks.length,
  );
  const grass = forestModels.slice(FOREST.trees.length + FOREST.bushes.length + FOREST.rocks.length);

  const treePlacements = scatter(trees, random, {
    // Fewer, larger trees: the same treeline at roughly half the vertices, and
    // only the trees pay for shadows.
    count: 48,
    minRadius: 23.5,
    maxRadius: 56,
    minScale: 1.2,
    maxScale: 2.1,
    margin: 2.4,
  });

  const forestTrees = buildMerged(forestEntries(trees, treePlacements), {
    name: 'forest-trees',
    castShadow: true,
  });
  foliage.add(forestTrees);

  const bushPlacements = scatter(bushes, random, {
    count: 30,
    minRadius: 16,
    maxRadius: 48,
    minScale: 1,
    maxScale: 1.9,
    margin: 1.6,
  });
  const rockPlacements = scatter(rocks, random, {
    count: 18,
    minRadius: 16,
    maxRadius: 46,
    minScale: 1,
    maxScale: 2.4,
    margin: 1.8,
  });
  const grassPlacements = scatter(grass, random, {
    count: 90,
    minRadius: 9,
    maxRadius: 46,
    minScale: 0.7,
    maxScale: 1.3,
    margin: 0.8,
    lift: 0.02,
  });

  // Bushes, rocks and tufts share the forest atlas; one merged, non-shadow-casting
  // mesh keeps the understory out of the shadow pass entirely.
  group.add(
    buildMerged(
      [...forestEntries(bushes, bushPlacements), ...forestEntries(rocks, rockPlacements), ...forestEntries(grass, grassPlacements)],
      { name: 'understory', castShadow: false },
    ),
  );

  // ---- sealed gate ------------------------------------------------------
  onProgress(0.9, 'sealing the old stair…');
  const gateY = heightAt(GATE.x, GATE.z);
  const [floorGltf, wallGltf, doorwayGltf, pillarGltf, torchGltf, cratesGltf] = await Promise.all([
    loadDungeon(DUNGEON.floor),
    loadDungeon(DUNGEON.wall),
    loadDungeon(DUNGEON.doorway),
    loadDungeon(DUNGEON.pillar),
    loadDungeon(DUNGEON.torch),
    loadDungeon(DUNGEON.crates),
  ]);

  const gateStone: MergeEntry[] = [
    {
      gltf: floorGltf,
      placements: [-2, 2].flatMap((dx) =>
        [1.6, 3.6, 5.6].map((dz) => ({ x: GATE.x + dx, y: gateY + 0.08, z: GATE.z + dz, yaw: 0, scale: 1 })),
      ),
    },
    {
      gltf: wallGltf,
      placements: [
        // The plug: a solid wall inside the arch. The dungeon can open this later.
        { x: GATE.x, y: gateY + 0.13, z: GATE.z - 1.55, yaw: 0, scale: 1 },
        // Wings butt directly against the 4 m arch, so there is no gap to see through.
        { x: GATE.x - 4, y: gateY + 0.13, z: GATE.z - 0.5, yaw: 0, scale: 1 },
        { x: GATE.x + 4, y: gateY + 0.13, z: GATE.z - 0.5, yaw: 0, scale: 1 },
      ],
    },
    {
      gltf: doorwayGltf,
      placements: [{ x: GATE.x, y: gateY + 0.13, z: GATE.z - 0.5, yaw: 0, scale: 1 }],
    },
    {
      gltf: pillarGltf,
      placements: GATE.pillars.map((pillar) => ({ x: pillar.x, y: gateY, z: pillar.z, yaw: 0, scale: 1 })),
    },
    {
      gltf: cratesGltf,
      placements: [{ x: GATE.x + 2.6, y: gateY + 0.1, z: GATE.z + 2.2, yaw: 0.4, scale: 1 }],
    },
  ];
  group.add(buildMerged(gateStone, { name: 'gate-stone', castShadow: true }));
  group.add(
    buildMerged(
      [
        {
          gltf: torchGltf,
          placements: GATE.pillars.map((pillar) => ({
            x: pillar.x,
            y: gateY + 2.4,
            z: pillar.z,
            yaw: 0,
            scale: 1,
          })),
        },
      ],
      { name: 'gate-torches', castShadow: false },
    ),
  );

  for (const pillar of GATE.pillars) {
    const light = new THREE.PointLight(0xffb268, 8, 13, 2);
    light.position.set(pillar.x, gateY + 2.9, pillar.z);
    group.add(light);
  }

  // ---- collision --------------------------------------------------------
  const blockers = townBlockers();
  const obstacles = townObstacles();

  for (const placements of treePlacements) {
    // Trunk-only proxies: enough for the camera to refuse to enter a tree,
    // without pretending the canopy is solid.
    for (const placement of placements) {
      obstacles.push({
        kind: 'cylinder',
        x: placement.x,
        z: placement.z,
        radius: 0.42 * placement.scale,
        bottom: placement.y,
        top: placement.y + 5.6 * placement.scale,
      });
    }
  }

  onProgress(1, 'lighting the square…');

  return {
    group,
    heightAt,
    blockers,
    obstacles,
    foliage,
    dispose: () => {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      });
    },
  };
}
