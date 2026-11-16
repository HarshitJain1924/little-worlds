import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CameraObstacle } from './collision';
import type { Placement } from './models';
import { DUNGEON, FOREST, buildInstances, loadDungeon, loadForest, loadTown, placeModel } from './models';
import {
  BUILDINGS,
  GATE,
  TOWN,
  TOWN_MODULES,
  buildingPlacements,
  heightAt,
  isInsideBuilding,
  pathDistance,
  pavingFactor,
  dirtFactor,
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

const GRASS_BASE = new THREE.Color(0x8cc45c);
const GRASS_LIGHT = new THREE.Color(0xb6de83);
const GRASS_DARK = new THREE.Color(0x668f42);
const DIRT = new THREE.Color(0xb69a6a);
const COBBLE = new THREE.Color(0xa8a89c);
const COURT = new THREE.Color(0x9a9a8e);

function groundColour(x: number, z: number, out: THREE.Color): THREE.Color {
  const variation = 0.5 + 0.5 * Math.sin(x * 0.42 + z * 0.31);
  const patches = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + Math.sin(x * 0.05) * 2.1);

  out.copy(GRASS_BASE).lerp(GRASS_LIGHT, variation * 0.35 + patches * 0.2);
  out.lerp(GRASS_DARK, (1 - patches) * 0.35);

  // The forest route reads as trodden dirt before the stones start.
  out.lerp(DIRT, dirtFactor(x, z) * 0.8);

  // Plaza, streets and the gate court are pale cobbles under the tiles.
  out.lerp(COBBLE, pavingFactor(x, z) * 0.85);

  const gate = Math.min(1, Math.max(0, 1 - Math.hypot(x - TOWN.gate.x, z - TOWN.gate.z) / 9));
  out.lerp(COURT, gate * 0.35);

  const rim = Math.min(1, Math.max(0, (Math.hypot(x, z) - (TOWN.radius - 4)) / 14));
  out.lerp(GRASS_DARK, rim * 0.55);

  return out;
}

function createGround(): THREE.Mesh {
  const size = (TOWN.radius + 40) * 2;
  const geometry = new THREE.PlaneGeometry(size, size, 128, 128);
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
 * Nothing may grow on a street, in a doorway, inside a house or on the sealed
 * court. Checked with a margin so canopies never poke through a roof.
 */
function clearOfTown(x: number, z: number, margin: number): boolean {
  if (isInsideBuilding(x, z, margin)) return false;
  if (Math.hypot(x, z) < TOWN.plaza.radius + margin) return false;
  if (pathDistance(x, z) < margin + 1.8) return false;
  if (Math.hypot(x - TOWN.gate.x, z - TOWN.gate.z) < 7 + margin) return false;
  if (Math.hypot(x - TOWN.spawn.x, z - TOWN.spawn.z) < 7 + margin) return false;
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

/** One InstancedMesh per model mesh, so a whole wall family is one draw call. */
function groupPlacements(list: TownPlacement[]): Map<string, Placement[]> {
  const grouped = new Map<string, Placement[]>();
  for (const { module, ...placement } of list) {
    const bucket = grouped.get(module);
    if (bucket) bucket.push(placement);
    else grouped.set(module, [placement]);
  }
  return grouped;
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
  const wallPlacements: TownPlacement[] = [];
  for (const building of BUILDINGS) wallPlacements.push(...buildingPlacements(building));
  for (const [module, placements] of groupPlacements(wallPlacements)) {
    const gltf = townModels.get(module);
    if (!gltf) throw new Error(`missing town module ${module}`);
    group.add(buildInstances(gltf, placements));
  }

  onProgress(0.44, 'paving the streets…');
  const paving = groupPlacements(roadPlacements());
  for (const [module, placements] of paving) {
    const gltf = townModels.get(module);
    if (!gltf) throw new Error(`missing town module ${module}`);
    group.add(buildInstances(gltf, placements, { castShadow: false }));
  }

  onProgress(0.52, 'setting out the market…');
  const props = groupPlacements(propPlacements());
  for (const [module, placements] of props) {
    const gltf = townModels.get(module);
    if (!gltf) throw new Error(`missing town module ${module}`);
    group.add(buildInstances(gltf, placements));
  }

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
    count: 96,
    minRadius: 21,
    maxRadius: 56,
    minScale: 1,
    maxScale: 1.9,
    margin: 2.4,
  });

  trees.forEach((model, index) => {
    const placements = treePlacements[index];
    if (placements.length) foliage.add(buildInstances(model, placements));
  });

  const bushPlacements = scatter(bushes, random, {
    count: 54,
    minRadius: 20,
    maxRadius: 48,
    minScale: 0.85,
    maxScale: 1.6,
    margin: 1.8,
  });
  bushes.forEach((model, index) => {
    const placements = bushPlacements[index];
    if (placements.length) foliage.add(buildInstances(model, placements));
  });

  const rockPlacements = scatter(rocks, random, {
    count: 26,
    minRadius: 18,
    maxRadius: 46,
    minScale: 0.9,
    maxScale: 2.2,
    margin: 2,
  });
  rocks.forEach((model, index) => {
    const placements = rockPlacements[index];
    if (placements.length) group.add(buildInstances(model, placements));
  });

  const grassPlacements = scatter(grass, random, {
    count: 240,
    minRadius: 9,
    maxRadius: 46,
    minScale: 0.7,
    maxScale: 1.3,
    margin: 0.8,
    lift: 0.02,
  });
  grass.forEach((model, index) => {
    const placements = grassPlacements[index];
    if (placements.length) foliage.add(buildInstances(model, placements));
  });

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

  // Flagged court in front of the arch, on the plateau.
  for (const dx of [-2, 2]) {
    for (const dz of [1.6, 3.6]) {
      group.add(placeModel(floorGltf, GATE.x + dx, gateY + 0.08, GATE.z + dz, 0, 1));
    }
  }

  const archY = gateY + 0.13;
  group.add(placeModel(doorwayGltf, GATE.x, archY, GATE.z - 0.5, 0, 1));
  // The plug: a solid wall inside the arch. The dungeon can open this later.
  group.add(placeModel(wallGltf, GATE.x, archY, GATE.z - 1.55, 0, 1));
  // Wings butt directly against the 4 m arch, so there is no gap to see through.
  group.add(placeModel(wallGltf, GATE.x - 4, archY, GATE.z - 0.5, 0, 1));
  group.add(placeModel(wallGltf, GATE.x + 4, archY, GATE.z - 0.5, 0, 1));

  for (const pillar of GATE.pillars) {
    group.add(placeModel(pillarGltf, pillar.x, gateY, pillar.z, 0, 1));
    group.add(placeModel(torchGltf, pillar.x, gateY + 2.4, pillar.z, 0, 1));

    const light = new THREE.PointLight(0xffb268, 8, 13, 2);
    light.position.set(pillar.x, gateY + 2.9, pillar.z);
    group.add(light);
  }

  group.add(placeModel(cratesGltf, GATE.x + 2.6, gateY + 0.1, GATE.z + 2.2, 0.4, 1));

  // Boulders bed the arch into the hillside instead of leaving it free-standing.
  const boulderGltf = await loadTown('rock-large');
  group.add(
    buildInstances(boulderGltf, [
      { x: GATE.x - 6.8, y: heightAt(GATE.x - 6.8, GATE.z + 2.4) - 0.1, z: GATE.z + 2.4, yaw: 0.4, scale: 3 },
      { x: GATE.x + 6.9, y: heightAt(GATE.x + 6.9, GATE.z + 2.1) - 0.1, z: GATE.z + 2.1, yaw: 1.3, scale: 3.2 },
      { x: GATE.x - 7.6, y: heightAt(GATE.x - 7.6, GATE.z - 1.4) - 0.1, z: GATE.z - 1.4, yaw: 2.2, scale: 3.6 },
      { x: GATE.x + 7.4, y: heightAt(GATE.x + 7.4, GATE.z - 1.6) - 0.1, z: GATE.z - 1.6, yaw: 0.9, scale: 3.4 },
    ]),
  );

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
