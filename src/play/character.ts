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
  /** Generic grips, so a new Adventurer does not need its own socket entry. */
  mainHand: { bone: 'handslot.r', rotation: [0, 0, 0], scale: 1 } as Socket,
  offHand: { bone: 'handslot.l', rotation: [0, 0, 0], scale: 1 } as Socket,
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

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly names = new Map<THREE.AnimationAction, string>();

  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private readonly missingWarned = new Set<string>();

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
  }

  get playing(): string {
    return this.currentName;
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  /** Authored length of a clip in seconds (0 when the clip is absent). */
  clipDuration(name: string): number {
    return this.clips.get(name)?.duration ?? 0;
  }

  play(name: string, options: PlayOptions = {}): void {
    const clip = this.clips.get(name);
    if (!clip) {
      if (!this.missingWarned.has(name)) {
        this.missingWarned.add(name);
        console.warn(`Animation clip "${name}" is not loaded; keeping current pose.`);
      }
      return;
    }

    const once = options.once ?? false;

    // A looping state that is already active is never restarted: locomotion
    // asks for the same clip every frame.
    if (!once && this.currentName === name) {
      if (this.current && options.timeScale !== undefined) this.current.timeScale = options.timeScale;
      return;
    }

    // A one-shot that is still running is not restarted either, so holding the
    // attack button cannot rewind the swing.
    if (once && this.currentName === name && this.current?.isRunning()) return;

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

  update(delta: number): void {
    this.mixer.update(delta);
  }

  /** Freezes the specified clip at a target timestamp (used for held charge poses). */
  clampAt(name: string, time: number): void {
    const action = this.actions.get(name);
    if (action && action.time >= time) {
      action.time = time;
      action.paused = true;
    }
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
