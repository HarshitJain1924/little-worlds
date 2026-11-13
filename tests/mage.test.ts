import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import { MAGE_CAST_RELEASE, MAGE_CAST_SWEEP, PROFILES, profileFor } from '../src/play/movesets.ts';
import { ProjectilePool } from '../src/play/projectiles.ts';
import type { Impact, ProjectileField, ProjectileTarget } from '../src/play/projectiles.ts';
import { solveShot } from '../src/play/aim.ts';
import type { CameraObstacle } from '../src/play/collision.ts';

function makeRig(): {
  root: THREE.Object3D;
  animator: {
    playing: string;
    play: (name: string, options?: { once?: boolean; fade?: number; clamp?: boolean }) => void;
    clipDuration: (name: string) => number;
    clampAt: (name: string, time: number) => void;
  };
  update: (delta: number) => void;
  flash: () => void;
  dispose: () => void;
} {
  const animator = {
    playing: 'Idle_A',
    play(name: string): void {
      this.playing = name;
    },
    clipDuration(name: string): number {
      if (name === 'Ranged_Magic_Shoot') return 0.933;
      if (name === 'Ranged_Magic_Raise') return 2.1;
      if (name === 'Ranged_Magic_Spellcasting') return 0.667;
      return 1.33;
    },
    clampAt(name: string): void {
      this.playing = `${name}_clamped`;
    },
  };
  return {
    root: new THREE.Object3D(),
    animator,
    update: (): void => {},
    flash: (): void => {},
    dispose: (): void => {},
  };
}

function makeInput(): {
  aim: boolean;
  heavyHeld: boolean;
  heavyEdge: boolean;
  attackEdge: boolean;
  dodgeEdge: boolean;
  readMove: () => { x: number; y: number; run: boolean };
  takeJump: () => boolean;
  takeDodge: () => boolean;
  takeHeavy: () => boolean;
  takeAttack: () => boolean;
  isBlocking: () => boolean;
  isHeavyHeld: () => boolean;
} {
  const input = {
    aim: false,
    heavyHeld: false,
    heavyEdge: false,
    attackEdge: false,
    dodgeEdge: false,
    readMove: (): { x: number; y: number; run: boolean } => ({ x: 0, y: 0, run: false }),
    takeJump: (): boolean => false,
    takeDodge(): boolean {
      const edge = input.dodgeEdge;
      input.dodgeEdge = false;
      return edge;
    },
    takeHeavy(): boolean {
      const edge = input.heavyEdge;
      input.heavyEdge = false;
      return edge;
    },
    takeAttack(): boolean {
      const edge = input.attackEdge;
      input.attackEdge = false;
      return edge;
    },
    isBlocking: (): boolean => input.aim,
    isHeavyHeld: (): boolean => input.heavyHeld,
  };
  return input;
}

interface FakeTarget extends ProjectileTarget {
  damage: number;
  hits: number;
}

function makeTarget(x: number, z: number, y = 0): FakeTarget {
  const target: FakeTarget = {
    position: { x, y, z },
    alive: true,
    damage: 0,
    hits: 0,
    takeDamage(amount: number): boolean {
      target.damage += amount;
      target.hits += 1;
      return true;
    },
  };
  return target;
}

const FLAT: ProjectileField = { obstacles: [], heightAt: () => 0 };

test('Mage has its own combat profile with distinct magic attacks and aim stance', () => {
  const mage = profileFor('mage');
  assert.equal(mage.id, 'mage');

  // Mage has no block: dodging is the only defence
  assert.equal(mage.guard, null);

  // Spell-aiming stance uses Ranged_Magic_Spellcasting
  assert.equal(mage.aim?.clip, 'Ranged_Magic_Spellcasting');
  assert.equal(mage.aim?.moveScale, 0.45);

  // Light attack — Magic Bolt
  assert.equal(mage.light.clip, 'Ranged_Magic_Shoot');
  assert.equal(mage.light.damage, 16);
  assert.equal(mage.light.hitStart, MAGE_CAST_RELEASE);
  assert.equal(mage.light.hitEnd, MAGE_CAST_RELEASE);
  assert.equal(mage.light.timeScale, 1.35);
  assert.equal(mage.light.tag, 'light');
  assert.ok(mage.light.ranged !== undefined);
  assert.equal(mage.light.ranged?.speed, 32);
  assert.equal(mage.light.ranged?.maxRange, 38);

  // Responsive release: cast leaves the staff at ~0.207s
  const lightRelease = mage.light.hitStart / mage.light.timeScale;
  assert.ok(lightRelease >= 0.18 && lightRelease <= 0.22, `light release at ${lightRelease.toFixed(3)}s`);

  // Heavy attack — Charged Spell
  assert.equal(mage.heavy.clip, 'Ranged_Magic_Shoot');
  assert.equal(mage.heavy.damage, 48);
  assert.equal(mage.heavy.hitStart, MAGE_CAST_RELEASE);
  assert.equal(mage.heavy.hitEnd, MAGE_CAST_RELEASE);
  assert.equal(mage.heavy.timeScale, 0.95);
  assert.equal(mage.heavy.armored, true);
  assert.equal(mage.heavy.tag, 'heavy');
  assert.ok(mage.heavy.ranged !== undefined);
  assert.equal(mage.heavy.ranged?.speed, 44);
  assert.equal(mage.heavy.ranged?.maxRange, 48);

  // Charge configuration
  assert.ok(mage.charge !== undefined);
  assert.equal(mage.charge?.drawClip, 'Ranged_Magic_Raise');
  assert.equal(mage.charge?.minDamage, 24);
  assert.equal(mage.charge?.maxDamage, 48);
  assert.equal(mage.charge?.minSpeed, 28);
  assert.equal(mage.charge?.maxSpeed, 44);
  assert.equal(mage.charge?.clampTime, 0.95);

  // Existing Ranger profile remains unchanged
  const ranger = profileFor('ranger');
  assert.equal(ranger.id, 'ranger');
  assert.equal(ranger.light.clip, 'Ranged_Bow_Release');
  assert.equal(ranger.aim?.clip, 'Ranged_Bow_Aiming_Idle');
  assert.equal(ranger.charge?.drawClip, 'Ranged_Bow_Draw');
});

test('Mage staff projectile origin transforms from the staff crystal tip', () => {
  const rig = makeRig();
  const handslot = new THREE.Bone();
  handslot.name = 'handslot.r';
  handslot.position.set(0.4, 1.2, 0.3);
  rig.root.add(handslot);

  const staff = new THREE.Object3D();
  staff.name = 'staff';
  staff.position.set(0, 0, 0);
  handslot.add(staff);

  rig.root.updateMatrixWorld(true);

  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));

  const castingPoint = new THREE.Vector3();
  const found = player.staffCastingPoint(castingPoint);
  assert.equal(found, true);

  // Staff tip is at local (0, 1.25, 0)
  const expected = new THREE.Vector3();
  staff.localToWorld(expected.set(0, 1.25, 0));
  assert.ok(castingPoint.distanceTo(expected) < 1e-5);

  const muzzle = new THREE.Vector3();
  player.muzzlePosition(muzzle);
  assert.ok(muzzle.distanceTo(expected) < 1e-5);
});

test('Mage light attack plays Ranged_Magic_Shoot and fires once at measured release time', () => {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();

  let shotsFired = 0;
  player.onRangedShot = (attack) => {
    shotsFired += 1;
    assert.equal(attack.clip, 'Ranged_Magic_Shoot');
    assert.equal(attack.tag, 'light');
  };

  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Shoot');
  assert.equal(player.isAttacking, true);
  assert.equal(shotsFired, 0);

  // Advance to release: 0.28 / 1.35 ≈ 0.207s
  const step = 1 / 60;
  let elapsed = step;
  while (elapsed < 0.22) {
    player.update(step, input as never, camera as never);
    elapsed += step;
  }
  assert.equal(shotsFired, 1, 'fires exactly once at measured release time');

  // Advance further through recovery: should not fire a second time
  while (elapsed < 0.5) {
    player.update(step, input as never, camera as never);
    elapsed += step;
  }
  assert.equal(shotsFired, 1, 'no duplicate shots');
  assert.equal(player.isAttacking, false, 'attack completes recovery cleanly');
});

test('Mage heavy attack charge timing, scaling, and one-shot release', () => {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();

  input.heavyHeld = true;
  input.heavyEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Raise');
  assert.equal(player.isCharging, true);

  // Locomotion must not overwrite the charge clip while charging
  for (let i = 0; i < 20; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Ranged_Magic_Raise');
  assert.equal(player.isCharging, true);

  // Releasing K fires once
  let shotsFired = 0;
  let firedDamage = 0;
  player.onRangedShot = (attack) => {
    shotsFired += 1;
    firedDamage = attack.damage;
    assert.equal(attack.clip, 'Ranged_Magic_Shoot');
    assert.equal(attack.tag, 'heavy');
  };

  input.heavyHeld = false;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Shoot');
  assert.equal(player.isCharging, false);

  // Advance to release: 0.28 / 0.95 ≈ 0.295s
  for (let i = 0; i < 25; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(shotsFired, 1);
  assert.ok(firedDamage >= 24 && firedDamage <= 48, `damage was ${firedDamage}`);

  // Holding the key after release does NOT re-fire
  input.heavyHeld = true;
  for (let i = 0; i < 40; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(shotsFired, 1, 'cannot repeatedly fire while heavy input remains held');
});

test('Mage charge cancellation on dodge, damage, death, character switch, and restart', () => {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };

  // 1. Dodge cancels charge
  {
    const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
    const input = makeInput();
    input.heavyHeld = true;
    input.heavyEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, true);

    input.dodgeEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, false, 'dodge cancels charge');
  }

  // 2. Damage cancels charge
  {
    const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
    const input = makeInput();
    input.heavyHeld = true;
    input.heavyEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, true);

    player.takeDamage(10, new THREE.Vector3(0, 0, 1));
    assert.equal(player.isCharging, false, 'damage cancels charge');
  }

  // 3. Death cancels charge
  {
    const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
    const input = makeInput();
    input.heavyHeld = true;
    input.heavyEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, true);

    player.takeDamage(200, new THREE.Vector3(0, 0, 1));
    assert.equal(player.alive, false);
    assert.equal(player.isCharging, false, 'death cancels charge');
  }

  // 4. Character switch cancels charge
  {
    const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
    const input = makeInput();
    input.heavyHeld = true;
    input.heavyEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, true);

    const nextRig = makeRig();
    player.replaceRig(nextRig as never, profileFor('knight'));
    assert.equal(player.isCharging, false, 'character switch cancels charge');
  }

  // 5. Restart cancels charge
  {
    const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor('mage'));
    const input = makeInput();
    input.heavyHeld = true;
    input.heavyEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.isCharging, true);

    player.reset();
    assert.equal(player.isCharging, false, 'restart cancels charge');
  }
});

test('Magic projectiles deal damage and obey segment collision and obstacle blocking', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, {
    arrow: { geometry: new THREE.BoxGeometry(0.1, 0.1, 1), material: new THREE.MeshBasicMaterial() },
    magicLight: { geometry: new THREE.SphereGeometry(0.2), material: new THREE.MeshBasicMaterial() },
    magicHeavy: { geometry: new THREE.SphereGeometry(0.4), material: new THREE.MeshBasicMaterial() },
  });

  const target = makeTarget(0, -10);
  const impacts: Impact[] = [];
  const collect = (impact: Impact) => {
    impacts.push({ ...impact, position: impact.position.clone() });
  };

  // Spawn magic light bolt
  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 32,
    damage: 16,
    maxRange: 38,
    kind: 'magicLight',
  });

  // Step towards target
  pool.update(0.35, [target], collect);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'target');
  assert.equal(impacts[0].shotKind, 'magicLight');
  assert.equal(target.damage, 16);
  assert.equal(target.hits, 1);

  // Obstacle blocking test with magic heavy spell
  impacts.length = 0;
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -3,
    maxX: 3,
    minZ: -4,
    maxZ: -3,
    bottom: 0,
    top: 3,
  };
  const blockedPool = new ProjectilePool(new THREE.Scene(), { obstacles: [wall], heightAt: () => 0 }, {
    geometry: new THREE.SphereGeometry(0.3),
    material: new THREE.MeshBasicMaterial(),
  });

  const wallTarget = makeTarget(0, -8);
  blockedPool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 44,
    damage: 48,
    maxRange: 48,
    kind: 'magicHeavy',
  });

  blockedPool.update(0.25, [wallTarget], collect);
  assert.equal(wallTarget.hits, 0, 'no magic damage through cover');
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, 'obstacle');
  assert.equal(impacts[0].shotKind, 'magicHeavy');
});

test('Mage lock-on and free-aim direction with solveShot', () => {
  const target = makeTarget(0, -10, 0);
  const aimPoint = new THREE.Vector3();

  // Free aim away from target (aiming into open space)
  const openOrigin = new THREE.Vector3(5, 1.5, 0);
  const freeDirection = new THREE.Vector3(0, 0, -1);
  const freeSolution = solveShot(openOrigin, freeDirection, FLAT, [target], 40, aimPoint);
  assert.equal(freeSolution.kind, 'range');

  // Aim directly at target cylinder (chest height)
  const origin = new THREE.Vector3(0, 1.5, 0);
  const chest = new THREE.Vector3(target.position.x, target.position.y + 1.05, target.position.z);
  const toTarget = chest.sub(origin).normalize();
  const lockedSolution = solveShot(origin, toTarget, FLAT, [target], 40, aimPoint);
  assert.equal(lockedSolution.kind, 'enemy');
  assert.equal(lockedSolution.target, target);
  assert.ok(lockedSolution.distance < 11);
});

test('Switching between Mage and other Adventurers preserves state and safely swaps profiles', () => {
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const rigKnight = makeRig();
  const player = new Player(rigKnight as never, world as never, { x: 3, z: -4 }, profileFor('knight'));

  player.health = 75;
  assert.equal(player.profile.id, 'knight');

  // Switch to Mage
  const rigMage = makeRig();
  player.replaceRig(rigMage as never, profileFor('mage'));
  assert.equal(player.profile.id, 'mage');
  assert.equal(player.health, 75, 'health preserved');
  assert.equal(player.position.x, 3);
  assert.equal(player.position.z, -4);
  assert.equal(player.isCharging, false);
  assert.equal(player.isAttacking, false);

  // Switch to Ranger
  const rigRanger = makeRig();
  player.replaceRig(rigRanger as never, profileFor('ranger'));
  assert.equal(player.profile.id, 'ranger');
  assert.equal(player.health, 75);
});

test('Camera crosshair sightline and projectile trajectory converge on the aimed target', () => {
  const world = {
    obstacles: [
      // Wall / gate at Z = -15
      { kind: 'box' as const, minX: -5, maxX: 5, minY: 0, maxY: 6, minZ: -16, maxZ: -14 },
    ],
    heightAt: (): number => 0,
  };

  const cameraPos = new THREE.Vector3(1.35, 1.8, 6.0); // right shoulder offset camera
  const aimCamera = new THREE.Vector3(0, 0, -1); // looking forward
  const playerPos = new THREE.Vector3(0, 0, 0); // player center
  const muzzle = new THREE.Vector3(-0.36, 1.16, 0); // staff tip
  const maxRange = 38;

  // Camera sightline forward from player plane
  const playerDist =
    (playerPos.x - cameraPos.x) * aimCamera.x +
    (playerPos.y + 1.45 - cameraPos.y) * aimCamera.y +
    (playerPos.z - cameraPos.z) * aimCamera.z;
  const cameraRay = cameraPos.clone().addScaledVector(aimCamera, Math.max(0, playerDist));
  const aimReference = new THREE.Vector3();
  const camSolution = solveShot(cameraRay, aimCamera, world, [], maxRange, aimReference);
  assert.equal(camSolution.kind, 'obstacle');

  // Shot directed toward what the crosshair sees
  const shotDirection = aimReference.clone().sub(muzzle).normalize();
  const shotOrigin = muzzle.clone().addScaledVector(shotDirection, 0.1);
  const shotHit = new THREE.Vector3();
  const shotSolution = solveShot(shotOrigin, shotDirection, world, [], maxRange, shotHit);

  assert.equal(shotSolution.kind, 'obstacle');
  // The projectile impact must match the crosshair impact point (no lateral offset)
  assert.ok(Math.abs(shotHit.x - aimReference.x) < 1e-3, 'projectile aligns with crosshair X');
  assert.ok(Math.abs(shotHit.y - aimReference.y) < 1e-3, 'projectile aligns with crosshair Y');
  assert.ok(Math.abs(shotHit.z - aimReference.z) < 1e-3, 'projectile aligns with crosshair Z');
});
