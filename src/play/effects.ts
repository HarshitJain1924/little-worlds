import * as THREE from 'three';

/**
 * Cheap combat feedback: a small pool of additive rings for impacts and a ring
 * per attacking enemy for its wind-up telegraph.
 *
 * Everything is a single reusable mesh with a shared geometry; nothing is
 * allocated per hit and nothing lives longer than a quarter second.
 */

export type ImpactKind = 'hit' | 'heavy' | 'block';

interface Burst {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  active: boolean;
}

interface Telegraph {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

const COLORS: Record<ImpactKind, number> = {
  hit: 0xffd7a0,
  heavy: 0xffb066,
  block: 0x9ecbff,
};

const BURST_COUNT = 8;
const TELEGRAPH_COUNT = 3;

export class CombatEffects {
  private readonly group = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private readonly telegraphs: Telegraph[] = [];
  private readonly impactGeometry = new THREE.RingGeometry(0.16, 0.26, 20);
  private readonly groundGeometry = new THREE.RingGeometry(0.62, 0.74, 28);
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'combat-effects';
    scene.add(this.group);

    for (let i = 0; i < BURST_COUNT; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: COLORS.hit,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.impactGeometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.bursts.push({
        mesh,
        material,
        age: 0,
        life: 0.2,
        startScale: 0.6,
        endScale: 1.9,
        baseOpacity: 0.8,
        active: false,
      });
    }

    for (let i = 0; i < TELEGRAPH_COUNT; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffc27a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.groundGeometry, material);
      // Flat on the ground, so it reads as a footprint rather than a screen decal.
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.telegraphs.push({ mesh, material });
    }
  }

  /** Impact ripple at roughly chest height. */
  spawn(position: { x: number; y: number; z: number }, kind: ImpactKind = 'hit'): void {
    const burst = this.bursts[this.cursor % this.bursts.length];
    this.cursor += 1;

    burst.age = 0;
    burst.life = kind === 'heavy' ? 0.26 : 0.2;
    burst.startScale = kind === 'heavy' ? 0.9 : 0.6;
    burst.endScale = kind === 'heavy' ? 2.5 : 1.9;
    burst.baseOpacity = kind === 'block' ? 0.7 : kind === 'heavy' ? 0.95 : 0.8;
    burst.material.color.setHex(COLORS[kind]);
    burst.material.opacity = burst.baseOpacity;
    burst.mesh.position.set(position.x, position.y + 1.15, position.z);
    burst.mesh.scale.setScalar(burst.startScale);
    burst.mesh.visible = true;
    burst.active = true;
  }

  /** Footprint ring that fills up while an enemy winds up. */
  setWindup(slot: number, position: { x: number; y: number; z: number }, progress: number): void {
    const telegraph = this.telegraphs[slot];
    if (!telegraph) return;

    telegraph.mesh.visible = true;
    telegraph.mesh.position.set(position.x, position.y + 0.06, position.z);
    telegraph.mesh.scale.setScalar(0.7 + progress * 0.6);
    // Ease in so the ring is quiet until the swing is actually committed.
    telegraph.material.opacity = 0.12 + progress * progress * 0.5;
  }

  hideWindupsFrom(slot: number): void {
    for (let i = slot; i < this.telegraphs.length; i += 1) {
      if (this.telegraphs[i].mesh.visible) this.telegraphs[i].mesh.visible = false;
    }
  }

  update(delta: number, camera: THREE.Camera): void {
    for (const burst of this.bursts) {
      if (!burst.active) continue;

      burst.age += delta;
      const t = burst.age / burst.life;

      if (t >= 1) {
        burst.active = false;
        burst.mesh.visible = false;
        burst.material.opacity = 0;
        continue;
      }

      burst.mesh.quaternion.copy(camera.quaternion);
      burst.mesh.scale.setScalar(burst.startScale + (burst.endScale - burst.startScale) * t);
      burst.material.opacity = burst.baseOpacity * (1 - t) * (1 - t);
    }
  }

  dispose(): void {
    this.impactGeometry.dispose();
    this.groundGeometry.dispose();
    for (const burst of this.bursts) burst.material.dispose();
    for (const telegraph of this.telegraphs) telegraph.material.dispose();
  }
}
