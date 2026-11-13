import * as THREE from 'three';

/**
 * Cheap combat feedback: a small pool of additive rings for impacts and a ring
 * per attacking enemy for its wind-up telegraph.
 *
 * Everything is a single reusable mesh with a shared geometry; nothing is
 * allocated per hit and nothing lives longer than a quarter second.
 */

export type ImpactKind = 'hit' | 'heavy' | 'block' | 'magic' | 'magicHeavy';

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

interface NovaEffect {
  ringMesh: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  coreMesh: THREE.Mesh;
  coreMaterial: THREE.MeshBasicMaterial;
  flareMesh: THREE.Mesh;
  flareMaterial: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  targetRadius: number;
  active: boolean;
}

const COLORS: Record<ImpactKind, number> = {
  hit: 0xffd7a0,
  heavy: 0xffb066,
  block: 0x9ecbff,
  magic: 0xb59cff,
  magicHeavy: 0xdf70ff,
};

const BURST_COUNT = 8;
const TELEGRAPH_COUNT = 3;
const NOVA_COUNT = 3;

export class CombatEffects {
  private readonly group = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private readonly telegraphs: Telegraph[] = [];
  private readonly novaEffects: NovaEffect[] = [];
  private readonly impactGeometry = new THREE.RingGeometry(0.16, 0.26, 20);
  private readonly groundGeometry = new THREE.RingGeometry(0.62, 0.74, 28);
  private readonly novaRingGeometry = new THREE.RingGeometry(0.88, 1.0, 48);
  private readonly novaCoreGeometry = new THREE.RingGeometry(0.04, 1.0, 32);
  private readonly novaFlareGeometry = new THREE.RingGeometry(0.2, 1.0, 24);
  private cursor = 0;
  private novaCursor = 0;

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

    for (let i = 0; i < NOVA_COUNT; i += 1) {
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xdf70ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const ringMesh = new THREE.Mesh(this.novaRingGeometry, ringMaterial);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.visible = false;
      ringMesh.frustumCulled = false;
      ringMesh.renderOrder = 3;
      this.group.add(ringMesh);

      const coreMaterial = new THREE.MeshBasicMaterial({
        color: 0xffccff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const coreMesh = new THREE.Mesh(this.novaCoreGeometry, coreMaterial);
      coreMesh.rotation.x = -Math.PI / 2;
      coreMesh.visible = false;
      coreMesh.frustumCulled = false;
      coreMesh.renderOrder = 4;
      this.group.add(coreMesh);

      const flareMaterial = new THREE.MeshBasicMaterial({
        color: 0xbf55ec,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const flareMesh = new THREE.Mesh(this.novaFlareGeometry, flareMaterial);
      flareMesh.visible = false;
      flareMesh.frustumCulled = false;
      flareMesh.renderOrder = 5;
      this.group.add(flareMesh);

      this.novaEffects.push({
        ringMesh,
        ringMaterial,
        coreMesh,
        coreMaterial,
        flareMesh,
        flareMaterial,
        age: 0,
        life: 0.48,
        targetRadius: 5.5,
        active: false,
      });
    }
  }

  /**
   * Impact ripple.
   * @param lift When true (default), offsets Y by +1.15 so passing an entity's
   * base position (e.g. enemy.position) centers the ripple on the chest.
   * When false, places the burst exactly at `position` without vertical offset.
   */
  spawn(position: { x: number; y: number; z: number }, kind: ImpactKind = 'hit', lift = true): void {
    const burst = this.bursts[this.cursor % this.bursts.length];
    this.cursor += 1;

    const isHeavy = kind === 'heavy' || kind === 'magicHeavy';
    burst.age = 0;
    burst.life = isHeavy ? 0.26 : 0.2;
    burst.startScale = isHeavy ? 0.9 : 0.6;
    burst.endScale = isHeavy ? 2.5 : 1.9;
    burst.baseOpacity = kind === 'block' ? 0.7 : isHeavy ? 0.95 : 0.8;
    burst.material.color.setHex(COLORS[kind]);
    burst.material.opacity = burst.baseOpacity;
    burst.mesh.position.set(position.x, position.y + (lift ? 1.15 : 0), position.z);
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

  /**
   * Spawns an expanding radial Arcane Nova shockwave:
   * - A ground-plane circular shockwave expanding outward to `radius`.
   * - A bright central ground core pulse.
   * - An ascending 3D energy flare ring.
   */
  spawnNova(position: { x: number; y: number; z: number }, radius = 5.5): void {
    const effect = this.novaEffects[this.novaCursor % this.novaEffects.length];
    this.novaCursor += 1;

    effect.age = 0;
    effect.life = 0.48;
    effect.targetRadius = radius;
    effect.active = true;

    // Ground shockwave sits slightly above terrain to prevent Z-fighting
    effect.ringMesh.position.set(position.x, position.y + 0.08, position.z);
    effect.ringMesh.scale.set(0.4, 0.4, 1);
    effect.ringMaterial.opacity = 0.95;
    effect.ringMesh.visible = true;

    // Bright core release pulse at center
    effect.coreMesh.position.set(position.x, position.y + 0.06, position.z);
    effect.coreMesh.scale.set(0.5, 0.5, 1);
    effect.coreMaterial.opacity = 0.95;
    effect.coreMesh.visible = true;

    // Mid-torso energy flare
    effect.flareMesh.position.set(position.x, position.y + 0.9, position.z);
    effect.flareMesh.scale.setScalar(0.6);
    effect.flareMaterial.opacity = 0.8;
    effect.flareMesh.visible = true;
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

    for (const nova of this.novaEffects) {
      if (!nova.active) continue;

      nova.age += delta;
      const t = nova.age / nova.life;

      if (t >= 1) {
        nova.active = false;
        nova.ringMesh.visible = false;
        nova.coreMesh.visible = false;
        nova.flareMesh.visible = false;
        nova.ringMaterial.opacity = 0;
        nova.coreMaterial.opacity = 0;
        nova.flareMaterial.opacity = 0;
        continue;
      }

      // Ground shockwave: quadratic deceleration expansion to targetRadius
      const ease = 1 - Math.pow(1 - t, 2.5);
      const currentRadius = 0.4 + (nova.targetRadius - 0.4) * ease;
      nova.ringMesh.scale.set(currentRadius, currentRadius, 1);
      nova.ringMaterial.opacity = 0.95 * (1 - t * t);

      // Central core pulse: expands quickly to ~1.7m and fades out by t=0.5
      const coreT = Math.min(1, nova.age / 0.22);
      const coreScale = 0.5 + 1.2 * (1 - Math.pow(1 - coreT, 2));
      nova.coreMesh.scale.set(coreScale, coreScale, 1);
      nova.coreMaterial.opacity = 0.95 * (1 - coreT);

      // Vertical flare billboarding to camera
      const flareT = Math.min(1, nova.age / 0.32);
      nova.flareMesh.quaternion.copy(camera.quaternion);
      nova.flareMesh.scale.setScalar(0.6 + 2.0 * flareT);
      nova.flareMaterial.opacity = 0.8 * (1 - flareT);
    }
  }

  dispose(): void {
    this.impactGeometry.dispose();
    this.groundGeometry.dispose();
    this.novaRingGeometry.dispose();
    this.novaCoreGeometry.dispose();
    this.novaFlareGeometry.dispose();
    for (const burst of this.bursts) burst.material.dispose();
    for (const telegraph of this.telegraphs) telegraph.material.dispose();
    for (const nova of this.novaEffects) {
      nova.ringMaterial.dispose();
      nova.coreMaterial.dispose();
      nova.flareMaterial.dispose();
    }
  }
}
