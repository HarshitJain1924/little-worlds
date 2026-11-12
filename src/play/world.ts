import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Placement } from './models';
import { DUNGEON, FOREST, buildInstances, loadDungeon, loadForest, placeModel } from './models';

/** Compact arena: enough room to fight, small enough to read as one place. */
export const ARENA = {
  radius: 34,
  spawn: { x: 0, z: 14 },
  ruin: { x: 0, z: -18 },
  seed: 20261111,
} as const;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Walkable height field. Shared by the ground mesh, every prop placement and the
 * player's ground query, so nothing ever floats or sinks.
 */
export function heightAt(x: number, z: number): number {
  const rolling =
    Math.sin(x * 0.075 + 0.6) * Math.cos(z * 0.062 - 0.3) * 0.8 +
    Math.sin((x + z) * 0.045 + 1.7) * 0.4 +
    Math.cos(x * 0.13 - z * 0.11) * 0.18;

  // The spawn clearing and the ruin platform are levelled so combat and the
  // modular 4-unit dungeon tiles sit flat.
  const spawnFlat = smoothstep(3, 12, Math.hypot(x - ARENA.spawn.x, z - ARENA.spawn.z));
  const ruinFlat = smoothstep(4.5, 10, Math.hypot(x - ARENA.ruin.x, z - ARENA.ruin.z));
  const flat = Math.min(spawnFlat, ruinFlat);

  // Ground lifts toward the treeline so the boundary reads as terrain, not a wall.
  const rim = smoothstep(ARENA.radius - 3, ARENA.radius + 12, Math.hypot(x, z));

  return rolling * flat + rim * 2.4;
}

/** Distance from the spawn-to-ruin trail, used to keep the route clear. */
function pathDistance(x: number, z: number): number {
  const from = ARENA.spawn;
  const to = ARENA.ruin;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const t = Math.min(1, Math.max(0, ((x - from.x) * dx + (z - from.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (from.x + dx * t), z - (from.z + dz * t));
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

export interface Blocker {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface World {
  group: THREE.Group;
  heightAt: typeof heightAt;
  blockers: Blocker[];
  dispose: () => void;
}

const GRASS_BASE = new THREE.Color(0x8cc45c);
const GRASS_LIGHT = new THREE.Color(0xb6de83);
const GRASS_DARK = new THREE.Color(0x668f42);
const DIRT = new THREE.Color(0xb69a6a);
const STONE = new THREE.Color(0xa8a89c);

function groundColour(x: number, z: number, out: THREE.Color): THREE.Color {
  const variation = 0.5 + 0.5 * Math.sin(x * 0.42 + z * 0.31);
  const patches = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + Math.sin(x * 0.05) * 2.1);

  out.copy(GRASS_BASE).lerp(GRASS_LIGHT, variation * 0.35 + patches * 0.2);
  out.lerp(GRASS_DARK, (1 - patches) * 0.35);

  const trampled = smoothstep(4.4, 0.6, pathDistance(x, z));
  out.lerp(DIRT, trampled * 0.55);

  const ruin = smoothstep(9, 3, Math.hypot(x - ARENA.ruin.x, z - ARENA.ruin.z));
  out.lerp(STONE, ruin * 0.5);

  const rim = smoothstep(ARENA.radius - 2, ARENA.radius + 10, Math.hypot(x, z));
  out.lerp(GRASS_DARK, rim * 0.5);

  return out;
}

function createGround(): THREE.Mesh {
  const size = (ARENA.radius + 18) * 2;
  const geometry = new THREE.PlaneGeometry(size, size, 108, 108);
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

interface ScatterOptions {
  count: number;
  minRadius: number;
  maxRadius: number;
  minScale: number;
  maxScale: number;
  keepOffPath?: boolean;
  lift?: number;
}

/** Random placements per source model, avoiding the spawn clearing, the ruin and the trail. */
function scatter(models: GLTF[], random: () => number, options: ScatterOptions): Placement[][] {
  const perModel: Placement[][] = models.map(() => []);

  for (let i = 0; i < options.count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = options.minRadius + random() * (options.maxRadius - options.minRadius);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (Math.hypot(x - ARENA.spawn.x, z - ARENA.spawn.z) < 6) continue;
    if (Math.hypot(x - ARENA.ruin.x, z - ARENA.ruin.z) < 8.5) continue;
    if (options.keepOffPath !== false && pathDistance(x, z) < 4) continue;

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

export async function buildWorld(onProgress: (fraction: number, label: string) => void): Promise<World> {
  const group = new THREE.Group();
  group.name = 'world';
  const blockers: Blocker[] = [];

  onProgress(0.05, 'shaping the ground…');
  const ground = createGround();
  group.add(ground);

  const random = mulberry32(ARENA.seed);

  const forestNames = [...FOREST.trees, ...FOREST.bushes, ...FOREST.rocks, ...FOREST.grass];
  onProgress(0.12, 'growing the forest…');
  const forestModels = await Promise.all(forestNames.map((name) => loadForest(name)));

  const trees = forestModels.slice(0, FOREST.trees.length);
  const bushes = forestModels.slice(FOREST.trees.length, FOREST.trees.length + FOREST.bushes.length);
  const rocks = forestModels.slice(
    FOREST.trees.length + FOREST.bushes.length,
    FOREST.trees.length + FOREST.bushes.length + FOREST.rocks.length,
  );
  const grass = forestModels.slice(FOREST.trees.length + FOREST.bushes.length + FOREST.rocks.length);

  const treePlacements = scatter(trees, random, {
    count: 62,
    minRadius: 11,
    maxRadius: 46,
    minScale: 0.9,
    maxScale: 1.5,
  });

  trees.forEach((model, index) => {
    const placements = treePlacements[index];
    if (placements.length) group.add(buildInstances(model, placements));
  });

  const bushPlacements = scatter(bushes, random, {
    count: 48,
    minRadius: 9,
    maxRadius: 40,
    minScale: 0.8,
    maxScale: 1.5,
  });
  bushes.forEach((model, index) => {
    const placements = bushPlacements[index];
    if (placements.length) group.add(buildInstances(model, placements));
  });

  const rockPlacements = scatter(rocks, random, {
    count: 30,
    minRadius: 8,
    maxRadius: 38,
    minScale: 0.9,
    maxScale: 2.2,
  });
  rocks.forEach((model, index) => {
    const placements = rockPlacements[index];
    if (placements.length) group.add(buildInstances(model, placements));
  });

  const grassPlacements = scatter(grass, random, {
    count: 240,
    minRadius: 5,
    maxRadius: 40,
    minScale: 0.7,
    maxScale: 1.3,
    lift: 0.02,
  });
  grass.forEach((model, index) => {
    const placements = grassPlacements[index];
    if (placements.length) group.add(buildInstances(model, placements));
  });

  // ---- ruin ------------------------------------------------------------
  onProgress(0.55, 'raising the ruin…');
  const ruinNames = [
    DUNGEON.floor,
    DUNGEON.wall,
    DUNGEON.doorway,
    DUNGEON.pillar,
    DUNGEON.torch,
    DUNGEON.crates,
  ];
  const [floorGltf, wallGltf, doorwayGltf, pillarGltf, torchGltf, cratesGltf] = await Promise.all(
    ruinNames.map((name) => loadDungeon(name)),
  );

  const ruinY = heightAt(ARENA.ruin.x, ARENA.ruin.z);

  // 2 x 2 tiles of 4 units: an 8 x 8 platform that lines up with the walls.
  for (const dx of [-2, 2]) {
    for (const dz of [-2, 2]) {
      group.add(
        placeModel(floorGltf, ARENA.ruin.x + dx, ruinY + 0.08, ARENA.ruin.z + dz, 0, 1),
      );
    }
  }

  const wallY = ruinY + 2;
  const walls: [number, number, number][] = [
    [ARENA.ruin.x, ARENA.ruin.z - 4, 0],
    [ARENA.ruin.x - 4, ARENA.ruin.z, Math.PI / 2],
    [ARENA.ruin.x + 4, ARENA.ruin.z, Math.PI / 2],
  ];

  for (const [x, z, yaw] of walls) {
    group.add(placeModel(wallGltf, x, wallY, z, yaw, 1));
    // Half-depth box that matches the module footprint (4 wide, 1 deep).
    const halfWidth = 2;
    const halfDepth = 0.55;
    const along = Math.abs(Math.sin(yaw)) > 0.5;
    blockers.push({
      minX: x - (along ? halfDepth : halfWidth),
      maxX: x + (along ? halfDepth : halfWidth),
      minZ: z - (along ? halfWidth : halfDepth),
      maxZ: z + (along ? halfWidth : halfDepth),
    });
  }

  group.add(placeModel(doorwayGltf, ARENA.ruin.x, wallY, ARENA.ruin.z + 4, 0, 1));

  for (const dx of [-3.1, 3.1]) {
    const x = ARENA.ruin.x + dx;
    const z = ARENA.ruin.z + 4.6;
    group.add(placeModel(pillarGltf, x, ruinY, z, 0, 1));
    group.add(placeModel(torchGltf, x, ruinY + 2.55, z, 0, 1));
    blockers.push({ minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6 });

    const light = new THREE.PointLight(0xffb268, 8, 13, 2);
    light.position.set(x, ruinY + 3.1, z);
    group.add(light);
  }

  group.add(placeModel(cratesGltf, ARENA.ruin.x + 2.4, ruinY + 0.1, ARENA.ruin.z - 2.6, 0.4, 1));

  onProgress(0.95, 'lighting the glade…');

  return {
    group,
    heightAt,
    blockers,
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
