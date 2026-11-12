import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Curated runtime set copied from the KayKit packs into public/rpg/. */
export const ASSETS = {
  knight: './rpg/characters/Knight.glb',
  skeletonMinion: './rpg/characters/Skeleton_Minion.glb',
  skeletonWarrior: './rpg/characters/Skeleton_Warrior.glb',
  rigGeneral: './rpg/anims/Rig_Medium_General.glb',
  rigMovement: './rpg/anims/Rig_Medium_MovementBasic.glb',
  sword: './rpg/weapons/sword_A.gltf',
  shield: './rpg/weapons/shield_A.gltf',
  skeletonBlade: './rpg/weapons/Skeleton_Blade.gltf',
  skeletonAxe: './rpg/weapons/Skeleton_Axe.gltf',
  skeletonShield: './rpg/weapons/Skeleton_Shield_Large_A.gltf',
} as const;

export const FOREST = {
  trees: [
    'Tree_1_A_Color1',
    'Tree_2_A_Color1',
    'Tree_3_A_Color1',
    'Tree_4_A_Color1',
    'Tree_Bare_1_A_Color1',
  ],
  bushes: ['Bush_1_A_Color1', 'Bush_2_B_Color1', 'Bush_3_C_Color1', 'Bush_4_A_Color1'],
  rocks: ['Rock_1_A_Color1', 'Rock_2_B_Color1', 'Rock_3_C_Color1'],
  grass: ['Grass_1_A_Color1', 'Grass_2_B_Color1'],
} as const;

export const DUNGEON = {
  floor: 'floor_tile_large',
  floorSmall: 'floor_tile_large',
  wall: 'wall',
  doorway: 'wall_doorway',
  corner: 'wall_corner',
  pillar: 'pillar',
  torch: 'torch_lit',
  crates: 'crates_stacked',
} as const;

const forestUrl = (name: string): string => `./rpg/forest/${name}.gltf`;
const dungeonUrl = (name: string): string => `./rpg/dungeon/${name}.gltf`;

THREE.Cache.enabled = true;
const loader = new GLTFLoader();

export function loadModel(url: string): Promise<GLTF> {
  return loader.loadAsync(url);
}

export const loadForest = (name: string): Promise<GLTF> => loadModel(forestUrl(name));
export const loadDungeon = (name: string): Promise<GLTF> => loadModel(dungeonUrl(name));

/**
 * GLTFLoader runs node names through PropertyBinding.sanitizeNodeName, which
 * strips reserved characters: the authored "handslot.r" arrives as "handslotr".
 * Every socket lookup goes through this so the spelling never matters.
 */
export function normalizeNodeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function findBone(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const wanted = normalizeNodeName(name);
  let found: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!found && normalizeNodeName(child.name) === wanted) found = child;
  });
  return found;
}

export function enableShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const matrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();

/**
 * One InstancedMesh per source mesh, so a repeated prop costs a single draw call
 * regardless of how many copies are placed.
 */
export function buildInstances(gltf: GLTF, placements: Placement[]): THREE.Group {
  const group = new THREE.Group();
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const parts: {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    matrix: THREE.Matrix4;
  }[] = [];

  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone() });
    }
  });

  for (const part of parts) {
    const instanced = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
    instanced.castShadow = true;
    instanced.receiveShadow = true;

    placements.forEach((placement, index) => {
      position.set(placement.x, placement.y, placement.z);
      quaternion.setFromAxisAngle(UP, placement.yaw);
      scale.setScalar(placement.scale);
      matrix.compose(position, quaternion, scale).multiply(part.matrix);
      instanced.setMatrixAt(index, matrix);
    });

    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    group.add(instanced);
  }

  return group;
}

/** A single placed copy (ruin modules, unique props). */
export function placeModel(
  gltf: GLTF,
  x: number,
  y: number,
  z: number,
  yaw = 0,
  uniformScale = 1,
): THREE.Object3D {
  const object = gltf.scene.clone(true);
  object.position.set(x, y, z);
  object.rotation.y = yaw;
  object.scale.setScalar(uniformScale);
  enableShadows(object);
  return object;
}

export async function loadClipSet(): Promise<Map<string, THREE.AnimationClip>> {
  const [general, movement] = await Promise.all([
    loadModel(ASSETS.rigGeneral),
    loadModel(ASSETS.rigMovement),
  ]);

  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of [...general.animations, ...movement.animations]) clips.set(clip.name, clip);
  return clips;
}
