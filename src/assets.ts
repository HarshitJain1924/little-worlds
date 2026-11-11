import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type AssetKind = 'nature' | 'town';

export interface Model {
  name: string;
  /** Template object; clone it for single placements. */
  root: THREE.Object3D;
  /** Mesh subtrees with their transform baked relative to the model root. */
  parts: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[];
  /** Local-space size of the whole model. */
  size: THREE.Vector3;
  /** Y offset that moves the model's lowest point to the placement height. */
  baseOffset: number;
}

export interface ModelDef {
  name: string;
  url: string;
  kind: AssetKind;
}

// Only models that are actually placed are listed: the island's underside is
// part of the terrain mesh, so the kit's cliff blocks stay in the source pack
// for later building work instead of shipping unused.
const NATURE_NAMES = [
  'tree_oak',
  'tree_pineTallA_detailed',
  'tree_pineRoundA',
  'tree_palm',
  'tree_simple',
  'tree_small',
  'tree_thin',
  'grass',
  'grass_large',
  'plant_bush',
  'plant_bushLarge',
  'plant_flatShort',
  'flower_redA',
  'flower_purpleA',
  'flower_yellowA',
  'mushroom_red',
  'mushroom_tan',
  'rock_largeA',
  'rock_tallA',
  'rock_smallFlatA',
  'stone_largeA',
  'log',
  'stump_round',
  'lily_large',
  'campfire_stones',
  'tent_smallOpen',
  'path_stone',
  'sign',
  'canoe',
] as const;

const TOWN_NAMES = [
  'wall-block',
  'wall-door',
  'wall-window-small',
  'roof-gable',
  'roof-gable-end',
  'roof-gable-top',
  'chimney',
  'planks',
  'lantern',
] as const;

/** Assets actually shipped in public/. */
export const MODEL_DEFS: ModelDef[] = [
  ...NATURE_NAMES.map((name) => ({
    name,
    url: `./models/nature/${name}.glb`,
    kind: 'nature' as const,
  })),
  ...TOWN_NAMES.map((name) => ({
    name,
    url: `./models/town/${name}.glb`,
    kind: 'town' as const,
  })),
];

/**
 * Nature Kit ships every material with metallicFactor = 1, which renders almost
 * black without an environment map. Fantasy Town already exports 0. Flat shading
 * matches how both kits were authored.
 */
function tameMaterials(root: THREE.Object3D, kind: AssetKind): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (kind === 'nature') {
        material.metalness = 0;
        material.roughness = 0.88;
      }
      material.flatShading = true;
      material.needsUpdate = true;
    }
  });
}

function bakeModel(name: string, gltf: GLTF): Model {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const parts: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    parts.push({ mesh: child, matrix: child.matrixWorld.clone() });
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());

  return { name, root, parts, size, baseOffset: -box.min.y };
}

export class ModelLibrary {
  private models = new Map<string, Model>();

  get(name: string): Model {
    const model = this.models.get(name);
    if (!model) throw new Error(`Model "${name}" was not loaded`);
    return model;
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  async loadAll(onProgress: (fraction: number) => void): Promise<void> {
    // Fantasy Town models share one texture atlas; cache it so it is fetched once
    // instead of once per model.
    THREE.Cache.enabled = true;
    const loader = new GLTFLoader();
    let done = 0;

    await Promise.all(
      MODEL_DEFS.map(async (def) => {
        const gltf = await loader.loadAsync(def.url);
        tameMaterials(gltf.scene, def.kind);
        this.models.set(def.name, bakeModel(def.name, gltf));
        done += 1;
        onProgress(done / MODEL_DEFS.length);
      }),
    );
  }
}

/** A single placement: position, rotation about Y and uniform scale. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  scale?: number;
}

const scratch = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

export function placementMatrix(p: Placement, target = new THREE.Matrix4()): THREE.Matrix4 {
  scratchPos.set(p.x, p.y, p.z);
  scratchQuat.setFromAxisAngle(up, p.yaw ?? 0);
  const s = p.scale ?? 1;
  scratchScale.set(s, s, s);
  return target.compose(scratchPos, scratchQuat, scratchScale);
}

/**
 * Builds instanced meshes for a repeated model. Instances are stored in a fixed
 * order so a preset can lower `count` to thin out the scatter without rebuilding.
 */
export function instanceModel(
  model: Model,
  placements: Placement[],
  options: { castShadow?: boolean; receiveShadow?: boolean } = {},
): THREE.Group {
  const group = new THREE.Group();
  const matrices = placements.map((p) =>
    placementMatrix({ ...p, y: p.y + model.baseOffset }),
  );

  for (const part of model.parts) {
    const instanced = new THREE.InstancedMesh(part.mesh.geometry, part.mesh.material, placements.length);
    instanced.castShadow = options.castShadow ?? true;
    instanced.receiveShadow = options.receiveShadow ?? true;

    for (let i = 0; i < matrices.length; i += 1) {
      scratch.multiplyMatrices(matrices[i], part.matrix);
      instanced.setMatrixAt(i, scratch);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    group.add(instanced);
  }

  group.userData.instanceCount = placements.length;
  return group;
}

/** Deep clone for one-off placements (the hut, camp props). */
export function cloneModel(model: Model, placement: Placement): THREE.Object3D {
  const object = model.root.clone(true);
  object.position.set(placement.x, placement.y + model.baseOffset, placement.z);
  object.rotation.y = placement.yaw ?? 0;
  const s = placement.scale ?? 1;
  object.scale.setScalar(s);
  return object;
}
