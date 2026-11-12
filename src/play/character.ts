import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { enableShadows, findBone } from './models';

/**
 * Weapon sockets. KayKit authors each weapon with its grip at the node origin,
 * so the offsets here only correct orientation, never position.
 */
export interface Socket {
  bone: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

export const SOCKETS = {
  sword: { bone: 'handslot.r', rotation: [0, 0, 0], scale: 1 } as Socket,
  shield: { bone: 'handslot.l', rotation: [0, 0, 0], scale: 1 } as Socket,
  blade: { bone: 'handslot.r', rotation: [0, 0, 0], scale: 1 } as Socket,
  axe: { bone: 'handslot.r', rotation: [0, 0, 0], scale: 1 } as Socket,
  largeShield: { bone: 'handslot.l', rotation: [0, 0, 0], scale: 1 } as Socket,
} as const;

export function attachWeapon(character: THREE.Object3D, weapon: THREE.Object3D, socket: Socket): boolean {
  const bone = findBone(character, socket.bone);
  if (!bone) return false;

  const [px, py, pz] = socket.position ?? [0, 0, 0];
  const [rx, ry, rz] = socket.rotation ?? [0, 0, 0];
  weapon.position.set(px, py, pz);
  weapon.rotation.set(rx, ry, rz);
  weapon.scale.setScalar(socket.scale ?? 1);
  enableShadows(weapon);
  bone.add(weapon);
  return true;
}

export interface PlayOptions {
  fade?: number;
  timeScale?: number;
  once?: boolean;
  clamp?: boolean;
}

/**
 * Bone-local euler deltas for the placeholder swing, keyed by normalised time.
 * The packs ship no attack clip, so this arm animation is generated in code and
 * is deliberately labelled a placeholder rather than passed off as animation.
 */
type Channel = [time: number, x: number, y: number, z: number][];

const SWING_CHANNELS: Record<string, Channel> = {
  'upperarm.r': [
    [0, 0, 0, 0],
    [0.3, -1.15, 0.2, -0.55],
    [0.52, 0.55, -0.15, 1.45],
    [0.72, 0.35, -0.1, 1.05],
    [1, 0, 0, 0],
  ],
  'lowerarm.r': [
    [0, 0, 0, 0],
    [0.3, -1.05, 0, 0],
    [0.52, -0.15, 0, 0],
    [1, 0, 0, 0],
  ],
  'hand.r': [
    [0, 0, 0, 0],
    [0.3, 0, 0, -0.35],
    [0.52, 0, 0, 0.45],
    [1, 0, 0, 0],
  ],
  hips: [
    [0, 0, 0, 0],
    [0.3, 0, 0.28, 0],
    [0.55, 0, -0.34, 0],
    [1, 0, 0, 0],
  ],
  spine: [
    [0, 0, 0, 0],
    [0.3, -0.08, 0.3, 0],
    [0.55, 0.12, -0.4, 0],
    [1, 0, 0, 0],
  ],
  chest: [
    [0, 0, 0, 0],
    [0.3, -0.06, 0.22, 0],
    [0.55, 0.1, -0.3, 0],
    [1, 0, 0, 0],
  ],
};

const SWING_BONES = Object.keys(SWING_CHANNELS);

function sampleChannel(channel: Channel, t: number): [number, number, number] {
  for (let i = 1; i < channel.length; i += 1) {
    const [time, x, y, z] = channel[i];
    if (t <= time) {
      const [prevTime, px, py, pz] = channel[i - 1];
      const span = time - prevTime || 1;
      const k = Math.min(1, Math.max(0, (t - prevTime) / span));
      return [px + (x - px) * k, py + (y - py) * k, pz + (z - pz) * k];
    }
  }
  return [0, 0, 0];
}

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly names = new Map<THREE.AnimationAction, string>();
  private readonly swingBones = new Map<string, THREE.Object3D>();
  private readonly euler = new THREE.Euler();
  private readonly delta = new THREE.Quaternion();

  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private swingPhase: number | null = null;

  /** Fired when a loop-once action reaches its end. */
  onFinished: ((name: string) => void) | null = null;

  constructor(
    root: THREE.Object3D,
    private readonly clips: Map<string, THREE.AnimationClip>,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (event) => {
      const name = this.names.get((event as unknown as { action: THREE.AnimationAction }).action);
      if (name) this.onFinished?.(name);
    });

    for (const name of SWING_BONES) {
      const bone = findBone(root, name);
      if (bone) this.swingBones.set(name, bone);
    }
  }

  get playing(): string {
    return this.currentName;
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  play(name: string, options: PlayOptions = {}): void {
    const clip = this.clips.get(name);
    if (!clip) return;

    const once = options.once ?? false;

    if (!once && this.currentName === name) {
      if (this.current && options.timeScale !== undefined) this.current.timeScale = options.timeScale;
      return;
    }

    const action = this.action(name);
    const fade = options.fade ?? 0.2;

    action.reset();
    action.setEffectiveTimeScale(options.timeScale ?? 1);
    action.setEffectiveWeight(1);
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = options.clamp ?? once;
    action.play();

    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, true);

    this.current = action;
    this.currentName = name;
  }

  /** Drive the placeholder swing pose; null clears it. */
  setSwingPhase(phase: number | null): void {
    this.swingPhase = phase;
  }

  update(delta: number): void {
    this.mixer.update(delta);
    if (this.swingPhase !== null) this.applySwing(this.swingPhase);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
  }

  private action(name: string): THREE.AnimationAction {
    const cached = this.actions.get(name);
    if (cached) return cached;

    const clip = this.clips.get(name);
    if (!clip) throw new Error(`Clip "${name}" missing`);

    const action = this.mixer.clipAction(clip);
    this.actions.set(name, action);
    this.names.set(action, name);
    return action;
  }

  /**
   * Applied after the mixer, so the swing multiplies onto whatever pose the
   * blend produced and then disappears cleanly when the phase is cleared.
   */
  private applySwing(phase: number): void {
    for (const [name, channel] of Object.entries(SWING_CHANNELS)) {
      const bone = this.swingBones.get(name);
      if (!bone) continue;

      const [x, y, z] = sampleChannel(channel, phase);
      if (x === 0 && y === 0 && z === 0) continue;

      this.euler.set(x, y, z);
      this.delta.setFromEuler(this.euler);
      bone.quaternion.multiply(this.delta);
    }
  }
}

export interface WeaponSpec {
  model: THREE.Object3D;
  socket: Socket;
}

/** One independently animated, fully equipped character. */
export class CharacterRig {
  readonly root: THREE.Object3D;
  readonly animator: CharacterAnimator;

  private readonly flashMaterials: THREE.MeshStandardMaterial[] = [];
  private flashTimer = 0;
  private flashStrength = 0;

  constructor(template: THREE.Object3D, clips: Map<string, THREE.AnimationClip>, weapons: WeaponSpec[] = []) {
    this.root = cloneSkinned(template);
    enableShadows(this.root);

    // Materials are cloned per instance so a hit flash on one skeleton cannot
    // tint its twin.
    this.root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = source.map((material) => material.clone());
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      for (const material of cloned) {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissive = new THREE.Color(0x000000);
          this.flashMaterials.push(material);
        }
      }
    });

    this.animator = new CharacterAnimator(this.root, clips);
    for (const spec of weapons) {
      attachWeapon(this.root, spec.model.clone(true), spec.socket);
    }
  }

  /** Red flash used for damage feedback. */
  flash(seconds = 0.14, strength = 1): void {
    this.flashTimer = seconds;
    this.flashStrength = strength;
  }

  update(delta: number): void {
    this.animator.update(delta);

    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - delta);
      const amount = this.flashTimer > 0 ? (this.flashTimer / 0.14) * this.flashStrength : 0;
      for (const material of this.flashMaterials) {
        material.emissive.setRGB(amount * 0.85, amount * 0.12, amount * 0.08);
      }
    }
  }

  dispose(): void {
    this.animator.dispose();
    for (const material of this.flashMaterials) material.dispose();
  }
}

export function weaponFrom(gltf: GLTF): THREE.Object3D {
  const object = gltf.scene;
  object.name = object.name || 'weapon';
  return object;
}
