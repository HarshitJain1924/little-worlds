import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Curated runtime set copied from the KayKit packs into public/rpg/. */
export const ASSETS = {
  knight: './rpg/characters/Knight.glb',
  barbarian: './rpg/characters/Barbarian.glb',
  rogue: './rpg/characters/Rogue.glb',
  mage: './rpg/characters/Mage.glb',
  ranger: './rpg/characters/Ranger.glb',
  skeletonMinion: './rpg/characters/Skeleton_Minion.glb',
  skeletonWarrior: './rpg/characters/Skeleton_Warrior.glb',
  rigGeneral: './rpg/anims/Rig_Medium_General.glb',
  rigMovement: './rpg/anims/Rig_Medium_MovementBasic.glb',
  rigCombat: './rpg/anims/Rig_Medium_CombatMelee.glb',
  rigMovementAdvanced: './rpg/anims/Rig_Medium_MovementAdvanced.glb',
  rigRanged: './rpg/anims/Rig_Medium_CombatRanged.glb',
  sword: './rpg/weapons/sword_A.gltf',
  shield: './rpg/weapons/shield_A.gltf',
  axeTwoHanded: './rpg/weapons/axe_2handed.gltf',
  shieldBarbarian: './rpg/weapons/shield_round_barbarian.gltf',
  dagger: './rpg/weapons/dagger.gltf',
  staff: './rpg/weapons/staff.gltf',
  bow: './rpg/weapons/bow_withString.gltf',
  arrow: './rpg/weapons/arrow_bow.gltf',
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
const townUrl = (name: string): string => `./rpg/town/${name}.glb`;

THREE.Cache.enabled = true;
const loader = new GLTFLoader();

export function loadModel(url: string): Promise<GLTF> {
  return loader.loadAsync(url);
}

export const loadForest = (name: string): Promise<GLTF> => loadModel(forestUrl(name));
export const loadDungeon = (name: string): Promise<GLTF> => loadModel(dungeonUrl(name));
export const loadTown = (name: string): Promise<GLTF> => loadModel(townUrl(name));

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
  /** Extra stretch along the model's local Z, used for roof spans. */
  stretchZ?: number;
}

export interface InstanceOptions {
  /** Paving and other ground decals should not pay for a shadow pass. */
  castShadow?: boolean;
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
export function buildInstances(
  gltf: GLTF,
  placements: Placement[],
  options: InstanceOptions = {},
): THREE.Group {
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
    instanced.castShadow = options.castShadow ?? true;
    instanced.receiveShadow = true;

    placements.forEach((placement, index) => {
      position.set(placement.x, placement.y, placement.z);
      quaternion.setFromAxisAngle(UP, placement.yaw);
      scale.set(placement.scale, placement.scale, placement.scale * (placement.stretchZ ?? 1));
      matrix.compose(position, quaternion, scale).multiply(part.matrix);
      instanced.setMatrixAt(index, matrix);
    });

    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    group.add(instanced);
  }

  return group;
}

export interface MergeEntry {
  gltf: GLTF;
  placements: Placement[];
}

export interface MergeOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  name?: string;
}

interface SourcePart {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  key: string;
  material: THREE.Material;
}

/**
 * Materials are only merged when they render identically. Every Fantasy Town
 * module shares the same `colormap` material, so the whole town collapses into
 * one mesh per shadow policy; models from other packs (the dungeon torches) keep
 * their own material and therefore their own draw.
 */
function materialKey(material: THREE.Material): string {
  const standard = material as THREE.MeshStandardMaterial;
  return [
    material.name,
    material.type,
    standard.map ? 'map' : 'flat',
    standard.emissiveMap ? 'emissiveMap' : '',
    standard.emissive ? standard.emissive.getHexString() : '',
    material.transparent ? 'transparent' : 'opaque',
  ].join('|');
}

function sourceParts(gltf: GLTF): SourcePart[] {
  gltf.scene.updateMatrixWorld(true);
  const parts: SourcePart[] = [];
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!material) return;
    parts.push({
      geometry: mesh.geometry,
      matrix: mesh.matrixWorld.clone(),
      key: materialKey(material),
      material,
    });
  });
  return parts;
}

function placementMatrix(placement: Placement, target: THREE.Matrix4): THREE.Matrix4 {
  position.set(placement.x, placement.y, placement.z);
  quaternion.setFromAxisAngle(UP, placement.yaw);
  scale.set(placement.scale, placement.scale, placement.scale * (placement.stretchZ ?? 1));
  return target.compose(position, quaternion, scale);
}

/**
 * Bake every placement of every entry into one static mesh per material.
 *
 * Instancing keeps repeated modules cheap, but one InstancedMesh per module (and
 * one per multi-primitive module) still costs a draw in the shadow pass and keeps
 * the whole town in every frame. The town is static, so merging it trades a few
 * hundred thousand bytes of geometry for a 2–3 draw town and a single shadow
 * draw. Instanced bounding spheres that covered the whole map also disappear.
 */
export function buildMerged(entries: MergeEntry[], options: MergeOptions = {}): THREE.Group {
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();

  for (const entry of entries) {
    if (!entry.placements.length) continue;
    for (const part of sourceParts(entry.gltf)) {
      let bucket = buckets.get(part.key);
      if (!bucket) {
        bucket = { material: part.material, geometries: [] };
        buckets.set(part.key, bucket);
      }

      for (const placement of entry.placements) {
        // Cloning to non-indexed gives every buffer the same attribute layout,
        // which is what mergeGeometries needs; skinning/tangent attributes are
        // dropped because the kit is not normal-mapped.
        const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
        for (const attribute of Object.keys(geometry.attributes)) {
          if (attribute !== 'position' && attribute !== 'normal' && attribute !== 'uv') {
            geometry.deleteAttribute(attribute);
          }
        }

        const count = geometry.getAttribute('position').count;
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        if (!geometry.getAttribute('uv')) {
          geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }

        geometry.applyMatrix4(placementMatrix(placement, new THREE.Matrix4()).multiply(part.matrix));
        bucket.geometries.push(geometry);
      }
    }
  }

  const group = new THREE.Group();
  group.name = options.name ?? 'merged';

  for (const bucket of buckets.values()) {
    const merged = mergeGeometries(bucket.geometries, false);
    for (const geometry of bucket.geometries) geometry.dispose();
    if (!merged) continue;

    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    group.add(mesh);
  }

  return group;
}

/** A single placed copy (ruin modules, unique props). */export function placeModel(
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

/**
 * Authored horizontal root travel of a Dodge_* clip, sampled in metres in the
 * character's local space (+x left, +z forward). The pack's dodges are short
 * evasive steps rather than rolls, and that travel is what makes them read as a
 * step instead of a lean, so it is lifted out and replayed by the player.
 */
export interface DodgeMotion {
  times: number[];
  x: number[];
  z: number[];
}

export const DODGE_MOTION = new Map<string, DodgeMotion>();

/**
 * Every file that contributes clips. All of them target the same 23-bone
 * `Rig_Medium` skeleton with identical joint names, so a clip from any file
 * binds to any character built on that rig.
 */
export const CLIP_SOURCES = [
  ASSETS.rigGeneral,
  ASSETS.rigMovement,
  ASSETS.rigCombat,
  ASSETS.rigMovementAdvanced,
  ASSETS.rigRanged,
] as const;

export async function loadClipSet(): Promise<Map<string, THREE.AnimationClip>> {
  const sources = await Promise.all(CLIP_SOURCES.map((url) => loadModel(url)));

  const clips = new Map<string, THREE.AnimationClip>();
  for (const source of sources) {
    for (const clip of source.animations) {
      // Dodge_* clips author horizontal displacement on the `root` bone. Capture
      // it as a curve, then strip XZ so the collider in Player is the only thing
      // moving the character (no double movement, no snap-back on exit).
      if (clip.name.startsWith('Dodge_')) {
        for (const track of clip.tracks) {
          if (track.name === 'root.position') {
            const times: number[] = [];
            const x: number[] = [];
            const z: number[] = [];
            for (let i = 0; i < track.times.length; i += 1) {
              times.push(track.times[i]);
              x.push(track.values[i * 3]);
              z.push(track.values[i * 3 + 2]);
            }
            DODGE_MOTION.set(clip.name, { times, x, z });

            for (let i = 0; i < track.values.length; i += 3) {
              track.values[i] = 0;
              track.values[i + 2] = 0;
            }
          }
        }
      }
      clips.set(clip.name, clip);
    }
  }
  return clips;
}
