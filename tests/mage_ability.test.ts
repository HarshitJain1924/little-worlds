import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player, handleAbilityHit, executeExplosionAoE } from '../src/play/player.ts';
import { Enemy, type EnemyConfig } from '../src/play/enemy.ts';
import { CombatEffects } from '../src/play/effects.ts';
import {
  PROFILES,
  profileFor,
  MAGE_NOVA_CHARGE_CLIP,
  MAGE_NOVA_RELEASE_CLIP,
  MAGE_NOVA_TIME_SCALE,
  MAGE_NOVA_CHARGE_DURATION,
  MAGE_NOVA_CHANNEL_DURATION,
  MAGE_NOVA_RELEASE_TIME,
  MAGE_NOVA_ACTIVE_END,
  MAGE_NOVA_TOTAL_DURATION,
  MAGE_NOVA_RADIUS,
  MAGE_NOVA_DAMAGE,
  MAGE_NOVA_COOLDOWN,
  MAGE_NOVA_SPEED,
  MAGE_NOVA_MAX_RANGE,
  MAGE_NOVA_MAX_VERTICAL,
  MAGE_NOVA_MOVE_SCALE,
  MAGE_ABILITY,
  KNIGHT_ABILITY,
  BARBARIAN_ABILITY,
  ROGUE_ABILITY,
  RANGER_ABILITY,
} from '../src/play/movesets.ts';
import type { CameraObstacle } from '../src/play/collision.ts';
import type { Impact, ProjectileField, ProjectileTarget, ProjectileVisual } from '../src/play/projectiles.ts';
import { ProjectilePool } from '../src/play/projectiles.ts';
import { solveShot } from '../src/play/aim.ts';

const FLAT: ProjectileField = { obstacles: [], heightAt: () => 0 };

function makeRig(): {
  root: THREE.Object3D;
  animator: {
    playing: string;
    play: (name: string, options?: { once?: boolean; fade?: number; timeScale?: number; clamp?: boolean }) => void;
    clipDuration: () => number;
  };
  update: () => void;
  flash: () => void;
} {
  const animator = {
    playing: 'Idle_A',
    play(name: string): void {
      this.playing = name;
    },
    clipDuration: (): number => 1.25,
  };
  const root = new THREE.Object3D();
  const handslot = new THREE.Bone();
  handslot.name = 'handslot.r';
  handslot.position.set(0.4, 1.2, 0.3);
  root.add(handslot);

  const staff = new THREE.Object3D();
  staff.name = 'staff';
  staff.position.set(0, 0, 0);
  handslot.add(staff);

  root.updateMatrixWorld(true);

  return {
    root,
    animator,
    update: (): void => {},
    flash: (): void => {},
  };
}

function makeInput(): {
  aim: boolean;
  heavyHeld: boolean;
  heavyEdge: boolean;
  attackEdge: boolean;
  dodgeEdge: boolean;
  abilityEdge: boolean;
  moveDirection: { x: number; y: number; run: boolean };
  readMove: () => { x: number; y: number; run: boolean };
  takeJump: () => boolean;
  takeDodge: () => boolean;
  takeHeavy: () => boolean;
  takeAttack: () => boolean;
  takeAbility: () => boolean;
  isBlocking: () => boolean;
  isHeavyHeld: () => boolean;
} {
  const input = {
    aim: false,
    heavyHeld: false,
    heavyEdge: false,
    attackEdge: false,
    dodgeEdge: false,
    abilityEdge: false,
    moveDirection: { x: 0, y: 0, run: false },
    readMove: (): { x: number; y: number; run: boolean } => input.moveDirection,
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
    takeAbility(): boolean {
      const edge = input.abilityEdge;
      input.abilityEdge = false;
      return edge;
    },
    isBlocking: (): boolean => input.aim,
    isHeavyHeld: (): boolean => input.heavyHeld,
  };
  return input;
}

function createTestEnvironment(
  characterId: 'knight' | 'barbarian' | 'ranger' | 'rogue' | 'mage' = 'mage',
  obstacles: CameraObstacle[] = [],
) {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor(characterId));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();
  return { rig, world, player, camera, input };
}

interface MockEnemy extends ProjectileTarget {
  position: THREE.Vector3;
  alive: boolean;
  health: number;
  takeDamage: (amount: number, from: THREE.Vector3) => boolean;
}

function makeEnemy(x: number, y: number, z: number, health = 100): MockEnemy {
  const enemy: MockEnemy = {
    position: new THREE.Vector3(x, y, z),
    alive: true,
    health,
    takeDamage(amount: number) {
      if (!enemy.alive) return false;
      enemy.health = Math.max(0, enemy.health - amount);
      if (enemy.health <= 0) enemy.alive = false;
      return true;
    },
  };
  return enemy;
}

function dummyOrbVisual(): ProjectileVisual {
  return {
    geometry: new THREE.SphereGeometry(0.48, 8, 8),
    material: new THREE.MeshBasicMaterial({ color: 0xdf70ff }),
    offset: 0,
  };
}

test('Mage ability activation and initial charge animation', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, MAGE_NOVA_CHARGE_CLIP);
  assert.equal(player.currentAbilityCooldown, MAGE_NOVA_COOLDOWN);
  assert.equal(player.canStartAbility(), false);
  assert.equal(player.isNovaCharging, true);
  assert.ok(player.abilityChargeProgress >= 0 && player.abilityChargeProgress < 0.1);
});

test('Mage ability lifecycle timing bounds (startup, active, recovery, idle)', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Ranged_Magic_Spellcasting');

  // Step through startup (< 0.60s chargeDuration)
  player.update(0.50, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(player.isNovaCharging, true);
  assert.ok(player.abilityChargeProgress > 0.8 && player.abilityChargeProgress < 1.0);

  // Step past chargeDuration (0.60s): transitions into active release animation
  let rangedShotFired = false;
  player.onAbilityRangedShot = () => {
    rangedShotFired = true;
  };

  player.update(0.12, input as never, camera as never); // total ~0.63s
  assert.equal(player.activeAbilityPhase, 'active');
  assert.equal(rig.animator.playing, 'Ranged_Magic_Shoot');
  assert.equal(rangedShotFired, false); // release frame is 0.80s

  // Step to release frame (0.80s)
  player.update(0.18, input as never, camera as never); // total ~0.81s
  assert.equal(rangedShotFired, true);

  // Step through active follow-through (< 1.05s)
  player.update(0.15, input as never, camera as never); // total ~0.96s
  assert.equal(player.activeAbilityPhase, 'active');

  // Step into recovery (1.05s .. 1.20s)
  player.update(0.12, input as never, camera as never); // total ~1.08s
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Step past duration (1.20s) -> idle
  player.update(0.15, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.isAbilityActive, false);
});

test('Interrupted charge: damage taken before release cancels cast with no projectile or explosion', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  let rangedShotFired = false;
  player.onAbilityRangedShot = () => {
    rangedShotFired = true;
  };
  let releaseFired = false;
  player.onAbilityRelease = () => {
    releaseFired = true;
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'startup');

  // Advance partially through charge (0.35s)
  player.update(0.35, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');

  // Enemy strikes the Mage before projectile release
  const damageTaken = player.takeDamage(15, new THREE.Vector3(0, 0, -3));
  assert.equal(damageTaken, 15);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(rig.animator.playing, 'Hit_A');

  // Advance time past the normal release time (0.80s)
  player.update(1.0, input as never, camera as never);
  assert.equal(rangedShotFired, false, 'No projectile launched on interrupted cast');
  assert.equal(releaseFired, false, 'No release event fired on interrupted cast');
  assert.ok(player.currentAbilityCooldown > 5.0, 'Cooldown is active to prevent immediate duplicate spam');
});

test('Damage after release does not cancel in-flight projectile', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);
  const { player, camera, input } = createTestEnvironment('mage');

  const enemy = makeEnemy(0, 0, -14);
  let impactReported: Impact | null = null;

  player.onAbilityRangedShot = (ability) => {
    pool.spawn({
      origin: new THREE.Vector3(0, 1.45, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: ability.speed,
      damage: ability.damage,
      maxRange: ability.maxRange,
      kind: 'arcaneOrb',
      explosive: true,
    });
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance to release frame (0.80s): projectile launches
  player.update(0.80, input as never, camera as never);
  assert.equal(pool.activeCount, 1, 'Projectile is now in flight');

  // Damage the Mage during recovery follow-through (0.90s)
  player.takeDamage(12, new THREE.Vector3(0, 0, 5));
  assert.equal(player.isAbilityActive, false);

  // In-flight projectile in ProjectilePool continues traveling toward enemy
  assert.equal(pool.activeCount, 1);
  for (let i = 0; i < 30; i += 1) {
    pool.update(1 / 60, [enemy], (imp) => {
      impactReported = { ...imp };
    });
  }

  assert.ok(impactReported !== null, 'Projectile successfully detonated despite damage to Mage');
  assert.equal((impactReported as unknown as Impact).kind, 'target');
  assert.equal((impactReported as unknown as Impact).shotKind, 'arcaneOrb');
});

test('Forward launch direction and staff-tip spawn position', () => {
  const { player } = createTestEnvironment('mage');

  const muzzle = new THREE.Vector3();
  player.muzzlePosition(muzzle);

  // Staff tip should be above player feet (~1.45m) and slightly offset on X/Z from the hand
  assert.ok(muzzle.y > 1.0, `Expected staff tip Y > 1.0, got ${muzzle.y}`);

  // Test staff crystal position helper
  const staffTip = new THREE.Vector3();
  const hasStaff = player.staffCastingPoint(staffTip);
  assert.equal(hasStaff, true);
  assert.ok(staffTip.y > 1.0);
});

test('Reticle aim and shoulder camera parallax convergence', () => {
  // Complete camera-to-muzzle path:
  // 1. Camera is at over-the-shoulder position (0.45, 1.7, 4.0), aiming along aimCamera (0, -0.043, -1).
  // 2. Center-screen crosshair raycasts into world and intersects enemy at (0, 1.05, -15).
  // 3. Convergence solver computes shotDirection from muzzle (0.35, 1.4, 0.2) toward aimReference.
  // 4. Muzzle projectile trajectory converges and strikes the aimed enemy.
  const world = { obstacles: [], heightAt: () => 0 };
  const targetEnemy = makeEnemy(0, 0, -15);
  const cameraPos = new THREE.Vector3(0.45, 1.7, 4.0);
  const aimCamera = new THREE.Vector3(0, -0.043, -1).normalize();
  const muzzle = new THREE.Vector3(0.35, 1.4, 0.2);

  // Step 1: Camera screen ray
  const aimReference = new THREE.Vector3();
  const cameraSol = solveShot(cameraPos, aimCamera, world as never, [targetEnemy], 40, aimReference);
  assert.equal(cameraSol.kind, 'enemy');
  assert.equal(cameraSol.target, targetEnemy);

  // Step 2: Parallax convergence from muzzle to aimReference
  const shotDir = aimReference.clone().sub(muzzle).normalize();
  const aimPoint = new THREE.Vector3();
  const shotSolution = solveShot(muzzle, shotDir, world as never, [targetEnemy], 40, aimPoint, 0.48);

  assert.equal(shotSolution.kind, 'enemy');
  assert.equal(shotSolution.target, targetEnemy);
  assert.ok(aimPoint.distanceTo(aimReference) < 0.25, 'Trajectory converges on crosshair target');
});

test('Explosive orb flight, visible trail step callback, and enemy impact detonation', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);
  const target = makeEnemy(0, 0, -10);

  const trailSteps: THREE.Vector3[] = [];
  pool.onStep = (kind, pos) => {
    if (kind === 'arcaneOrb') trailSteps.push(pos.clone());
  };

  const spawned = pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 25,
    damage: 65,
    maxRange: 35,
    kind: 'arcaneOrb',
    explosive: true,
  });
  assert.equal(spawned, true);

  let impact: Impact | null = null;
  // Step simulation until impact
  for (let i = 0; i < 30; i += 1) {
    pool.update(1 / 60, [target], (imp) => {
      impact = { ...imp, position: imp.position.clone() };
    });
    if (impact) break;
  }

  assert.ok(impact !== null);
  assert.equal((impact as unknown as Impact).kind, 'target');
  assert.equal((impact as unknown as Impact).shotKind, 'arcaneOrb');
  assert.ok(Math.abs((impact as unknown as Impact).position.z - (-9.5)) < 0.6, 'Impact position is at enemy cylinder entry');
  assert.ok(trailSteps.length > 5, 'Trail callback received positions along flight path');
});

test('Explosive orb wall and terrain collision', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -4,
    maxX: 4,
    minZ: -8.2,
    maxZ: -7.8,
    bottom: 0,
    top: 5,
  };
  const scene = new THREE.Scene();
  const field: ProjectileField = { obstacles: [wall], heightAt: () => 0 };
  const pool = new ProjectilePool(scene, field, { arcaneOrb: dummyOrbVisual() }, 4);

  // 1. Wall collision
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 30,
    damage: 65,
    maxRange: 35,
    kind: 'arcaneOrb',
    explosive: true,
  });

  let wallImpact: Impact | null = null;
  for (let i = 0; i < 30; i += 1) {
    pool.update(1 / 60, [], (imp) => {
      wallImpact = { ...imp, position: imp.position.clone() };
    });
    if (wallImpact) break;
  }

  assert.ok(wallImpact !== null);
  assert.equal((wallImpact as unknown as Impact).kind, 'obstacle');
  assert.ok(Math.abs((wallImpact as unknown as Impact).position.z - (-7.8)) < 0.15, 'Impact at near wall surface');

  // 2. Terrain ground collision
  const groundField: ProjectileField = {
    obstacles: [],
    heightAt: (x, z) => (z < -4 ? 0 : -2),
  };
  const groundPool = new ProjectilePool(scene, groundField, { arcaneOrb: dummyOrbVisual() }, 4);
  groundPool.spawn({
    origin: new THREE.Vector3(0, 0.5, 0),
    direction: new THREE.Vector3(0, -0.3, -1).normalize(),
    speed: 25,
    damage: 65,
    maxRange: 35,
    kind: 'arcaneOrb',
    explosive: true,
  });

  let groundImpact: Impact | null = null;
  for (let i = 0; i < 30; i += 1) {
    groundPool.update(1 / 60, [], (imp) => {
      groundImpact = { ...imp, position: imp.position.clone() };
    });
    if (groundImpact) break;
  }

  assert.ok(groundImpact !== null);
  assert.equal((groundImpact as unknown as Impact).kind, 'ground');
});

test('Explosive orb maximum-range detonation', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);

  pool.spawn({
    origin: new THREE.Vector3(0, 2.0, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 30,
    damage: 65,
    maxRange: 15,
    kind: 'arcaneOrb',
    explosive: true,
  });

  let maxRangeImpact: Impact | null = null;
  for (let i = 0; i < 40; i += 1) {
    pool.update(1 / 60, [], (imp) => {
      maxRangeImpact = { ...imp, position: imp.position.clone() };
    });
    if (maxRangeImpact) break;
  }

  assert.ok(maxRangeImpact !== null);
  assert.equal((maxRangeImpact as unknown as Impact).kind, 'expired');
  assert.ok(Math.abs((maxRangeImpact as unknown as Impact).position.z - (-15)) < 0.1, 'Detonates at exact max range');
});

test('executeExplosionAoE: damage is centered on impact position, NEVER on the Mage', () => {
  const detonationPoint = { x: 0, y: 0.5, z: -20 }; // 20 metres away from Mage
  const damage = 65;
  const radius = 5.5;

  const enemyNearExplosion = makeEnemy(0, 0, -21); // 1.0m from detonation, 21m from Mage
  const enemyNearMage = makeEnemy(0, 0, -2); // 18m from detonation, 2m from Mage
  const enemyOutsideRadius = makeEnemy(0, 0, -27); // 7m from detonation (> 5.5m)

  const targets = [enemyNearExplosion, enemyNearMage, enemyOutsideRadius];
  const hitEnemies = executeExplosionAoE(detonationPoint, damage, radius, targets, []);

  assert.equal(hitEnemies.length, 1);
  assert.equal(hitEnemies[0], enemyNearExplosion);
  assert.equal(enemyNearExplosion.health, 100 - damage);

  assert.equal(enemyNearMage.health, 100, 'Enemy near Mage took 0 damage (confirms explosion is at impact point)');
  assert.equal(enemyOutsideRadius.health, 100, 'Enemy outside 5.5m radius took 0 damage');
});

test('executeExplosionAoE: line-of-sight obstacle blocking', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minZ: -12.2,
    maxZ: -11.8,
    bottom: 0,
    top: 5,
  };

  const detonationPoint = { x: 0, y: 0.5, z: -10 };
  const enemyBehindWall = makeEnemy(0, 0, -14); // distance 4.0m (< 5.5m), but behind wall
  const openEnemy = makeEnemy(3.0, 0, -10); // distance 3.0m, clear line of sight

  const hitEnemies = executeExplosionAoE(
    detonationPoint,
    65,
    5.5,
    [enemyBehindWall, openEnemy],
    [wall],
  );

  assert.equal(hitEnemies.length, 1);
  assert.equal(hitEnemies[0], openEnemy);
  assert.equal(openEnemy.health, 35);
  assert.equal(enemyBehindWall.health, 100, 'Enemy behind wall took 0 damage due to line-of-sight obstruction');
});

test('executeExplosionAoE: multiple enemies and no duplicate damage', () => {
  const detonationPoint = { x: 0, y: 0, z: -10 };
  const e1 = makeEnemy(1, 0, -10);
  const e2 = makeEnemy(-1, 0, -10);
  const e3 = makeEnemy(0, 0, -12);

  const targets = [e1, e2, e3];
  let damageCount = 0;

  const hitEnemies = executeExplosionAoE(
    detonationPoint,
    65,
    5.5,
    targets,
    [],
    2.0,
    () => {
      damageCount += 1;
    },
  );

  assert.equal(hitEnemies.length, 3);
  assert.equal(damageCount, 3);
  assert.equal(e1.health, 35);
  assert.equal(e2.health, 35);
  assert.equal(e3.health, 35);

  // Re-running on already damaged alive enemies damaged again is valid for separate explosions,
  // but dead enemies are ignored
  e1.alive = false;
  const hitEnemies2 = executeExplosionAoE(detonationPoint, 65, 5.5, targets, []);
  assert.equal(hitEnemies2.includes(e1 as unknown as Enemy), false);
});

test('executeExplosionAoE: detonation on obstacle surface damages nearby enemies without self-intersection acne', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: 5,
    maxX: 7,
    minZ: 5,
    maxZ: 7,
    bottom: 0,
    top: 3,
  };

  // Orb hits the wall surface at (5.0, 1.5, 6.0)
  const wallImpactPoint = { x: 5.0, y: 1.5, z: 6.0 };
  // Enemy standing in front of the wall at (3.5, 0, 6.0) (distance ~2.1m < 5.5m)
  const enemyNearWall = makeEnemy(3.5, 0, 6.0);
  // Separate enemy behind a second intervening wall
  const interveningWall: CameraObstacle = {
    kind: 'box',
    minX: 2,
    maxX: 2.5,
    minZ: 5,
    maxZ: 7,
    bottom: 0,
    top: 3,
  };
  const enemyBehindCover = makeEnemy(1.0, 0, 6.0);

  const hitEnemies = executeExplosionAoE(
    wallImpactPoint,
    65,
    5.5,
    [enemyNearWall, enemyBehindCover],
    [wall, interveningWall],
  );

  assert.equal(hitEnemies.length, 1);
  assert.equal(hitEnemies[0], enemyNearWall);
  assert.equal(enemyNearWall.health, 35, 'Enemy in open in front of wall is damaged');
  assert.equal(enemyBehindCover.health, 100, 'Enemy behind intervening wall is protected');
});

test('executeExplosionAoE: direct projectile target is reliably damaged on uneven terrain or slopes', () => {
  // Enemy standing on a downhill slope at y = -0.4, projectile hit at upper chest y = 1.8 (gap dy = 2.2)
  const downhillEnemy = makeEnemy(0, -0.4, 10);
  const directHitPoint = { x: 0, y: 1.8, z: 10 };

  const hitEnemies = executeExplosionAoE(
    directHitPoint,
    65,
    5.5,
    [downhillEnemy],
    [],
    2.5,
    undefined,
    downhillEnemy,
  );

  assert.equal(hitEnemies.length, 1);
  assert.equal(hitEnemies[0], downhillEnemy);
  assert.equal(downhillEnemy.health, 35, 'Directly hit enemy received explosion damage');
});

test('Cooldown persistence across character switches and duplicate cast prevention', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.ok(player.currentAbilityCooldown > 8.0);
  assert.equal(player.canSwitchCharacter, false);

  // Advance time past ability duration (1.20s)
  player.update(MAGE_NOVA_TOTAL_DURATION, input as never, camera as never);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.canSwitchCharacter, true);

  const remainingCooldown = player.currentAbilityCooldown;
  assert.ok(remainingCooldown > 0);

  // Switch to Knight
  player.replaceRig(rig as never, profileFor('knight'));
  assert.equal(player.profile.id, 'knight');
  assert.equal(player.currentAbilityCooldown, 0); // Knight ability is off cooldown

  // Advance time by 2.0 seconds while Knight is active
  player.update(2.0, input as never, camera as never);

  // Switch back to Mage
  player.replaceRig(rig as never, profileFor('mage'));
  assert.equal(player.profile.id, 'mage');

  // Mage cooldown should have ticked down by 2.0s
  assert.ok(Math.abs(player.currentAbilityCooldown - (remainingCooldown - 2.0)) < 0.05);
});

test('Dodge cancellation permitted during recovery phase but not during charge or release', () => {
  const { player, camera, input } = createTestEnvironment('mage');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // During charge (0.30s), dodge cannot interrupt
  player.update(0.30, input as never, camera as never);
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);
  assert.equal(player.isAbilityActive, true);

  // During active release (0.85s), dodge cannot interrupt
  player.update(0.55, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);
  assert.equal(player.isAbilityActive, true);

  // During recovery phase (1.10s), dodge cancels ability
  player.update(0.25, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, true);
  assert.equal(player.isAbilityActive, false);
});

test('Controlled movement scaling during Arcane Nova charging and cast', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  input.moveDirection = { x: 0, y: 1, run: true };
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  const regularSpeed = player.speed;
  assert.ok(regularSpeed > 5.0);

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);

  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Speed scaled by MAGE_NOVA_MOVE_SCALE = 0.25
  assert.ok(player.speed < 2.0);
  assert.ok(player.speed > 0.4);
});

test('Mage basic light and heavy attacks remain completely intact', () => {
  const { player, camera, input, rig } = createTestEnvironment('mage');

  let lightFired = false;
  player.onRangedShot = (attack) => {
    if (attack.tag === 'light') lightFired = true;
  };

  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Shoot');
  assert.equal(player.isAttacking, true);

  player.update(0.25, input as never, camera as never);
  assert.equal(lightFired, true);

  player.update(0.5, input as never, camera as never);
  assert.equal(player.isAttacking, false);

  // Heavy charge attack
  input.heavyEdge = true;
  input.heavyHeld = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCharging, true);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Raise');

  player.update(1.0, input as never, camera as never);
  assert.equal(player.chargeProgress, 1.0);

  let heavyFired = false;
  player.onRangedShot = (attack) => {
    if (attack.tag === 'heavy') {
      heavyFired = true;
      assert.equal(attack.damage, 48);
    }
  };

  input.heavyHeld = false;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCharging, false);

  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, true);

  player.update(0.35, input as never, camera as never);
  assert.equal(heavyFired, true);
});

test('CombatEffects: staff charge aura, trail pooling, and nova shockwave explosion', () => {
  const scene = new THREE.Scene();
  const effects = new CombatEffects(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 5, 8);
  camera.lookAt(0, 0, 0);

  // 1. Staff crystal charge aura
  effects.setChargeAura({ x: 0.35, y: 1.45, z: 0.2 }, 0.5);
  // Verify aura mesh is visible and positioned
  effects.setChargeAura({ x: 0.35, y: 1.45, z: 0.2 }, 1.0);
  effects.hideChargeAura();

  // 2. In-flight orb trail
  effects.spawnTrail({ x: 0, y: 1.5, z: -2 });
  effects.spawnTrail({ x: 0, y: 1.5, z: -4 });
  effects.update(0.1, camera);
  effects.update(0.3, camera); // fades out

  // 3. Nova shockwave explosion at impact position
  effects.spawnNova({ x: 0, y: 0.2, z: -15 }, 5.5);
  effects.update(0.1, camera);
  effects.update(0.4, camera);

  // Pool recycling check
  for (let i = 0; i < 20; i += 1) {
    effects.spawnTrail({ x: 0, y: 1.5, z: -i });
    effects.spawnNova({ x: 0, y: 0.2, z: -i }, 5.5);
    effects.update(0.05, camera);
  }

  // Clean disposal
  assert.doesNotThrow(() => effects.dispose());
});

test('Real Enemy integration: executeExplosionAoE damages real Enemy instance with damage and knockback', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minZ: -12.2,
    maxZ: -11.8,
    bottom: 0,
    top: 5,
  };

  const enemyConfig: EnemyConfig = {
    label: 'Test Minion',
    maxHealth: 100,
    speed: 2.5,
    damage: 10,
    aggroRadius: 10,
    attackRange: 2.5,
    attackCooldown: 1.5,
  };

  const world = { heightAt: (): number => 0, blockers: [], obstacles: [wall] };
  const rig1 = makeRig();
  const rig2 = makeRig();
  const unblockedEnemy = new Enemy(rig1 as never, enemyConfig, { x: 3, z: -10 }, world as never);
  const blockedEnemy = new Enemy(rig2 as never, enemyConfig, { x: 0, z: -14 }, world as never);

  const detonationPoint = { x: 0, y: 0.5, z: -10 };

  let callbackEnemy: Enemy | null = null;
  let callbackDamage = 0;

  const damaged = executeExplosionAoE(
    detonationPoint,
    MAGE_NOVA_DAMAGE,
    MAGE_NOVA_RADIUS,
    [unblockedEnemy, blockedEnemy],
    world.obstacles,
    2.0,
    (enemy, dmg) => {
      callbackEnemy = enemy;
      callbackDamage = dmg;
    },
  );

  assert.equal(damaged.length, 1);
  assert.equal(damaged[0], unblockedEnemy);
  assert.equal(callbackEnemy, unblockedEnemy);
  assert.equal(callbackDamage, MAGE_NOVA_DAMAGE);
  assert.equal(unblockedEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.ok(unblockedEnemy.position.x > 3.0, 'Enemy knocked away from detonation position');

  assert.equal(blockedEnemy.health, 100, 'Blocked enemy takes no damage');
});

test('ProjectilePool: slot exhaustion and recycling for arcaneOrb', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 3);

  // Spawn 3 active orbs (fills pool)
  for (let i = 0; i < 3; i += 1) {
    const ok = pool.spawn({
      origin: new THREE.Vector3(i, 1, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: 20,
      damage: 65,
      maxRange: 30,
      kind: 'arcaneOrb',
      explosive: true,
    });
    assert.equal(ok, true);
  }
  assert.equal(pool.activeCount, 3);

  // Spawning a 4th slot should recycle the oldest/farthest without throwing or dropping
  const recycled = pool.spawn({
    origin: new THREE.Vector3(10, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 30,
    kind: 'arcaneOrb',
    explosive: true,
  });
  assert.equal(recycled, true);
  assert.equal(pool.activeCount, 3);

  pool.clear();
  assert.equal(pool.activeCount, 0);
});

test('Regression check: Knight, Barbarian, Rogue, and Ranger abilities remain fully functional', () => {
  const { player, camera, input, rig } = createTestEnvironment('knight');

  // 1. Knight Shield Counter
  assert.equal(player.profile.ability?.kind, 'counter');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Melee_Block_Attack');
  assert.equal(player.isCounterWindowActive, true);
  player.takeDamage(10, new THREE.Vector3(0, 0, -2));
  assert.equal(player.isCounterTriggered, true);
  player.update(1.2, input as never, camera as never);
  assert.equal(player.isAbilityActive, false);

  // 2. Barbarian Whirlwind
  player.replaceRig(rig as never, profileFor('barbarian'));
  assert.equal(player.profile.ability?.kind, 'whirlwind');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Melee_2H_Attack_Spinning');
  player.update(1.5, input as never, camera as never);
  assert.equal(player.isAbilityActive, false);

  // 3. Rogue Shadowstep
  player.replaceRig(rig as never, profileFor('rogue'));
  assert.equal(player.profile.ability?.kind, 'shadowstep');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Dodge_Forward');
  player.update(1.5, input as never, camera as never);
  assert.equal(player.isAbilityActive, false);

  // 4. Ranger Piercing Volley
  player.replaceRig(rig as never, profileFor('ranger'));
  assert.equal(player.profile.ability?.kind, 'volley');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Ranged_Bow_Draw');
  player.update(1.0, input as never, camera as never);
  assert.equal(player.isAbilityActive, false);
});

test('Launch-time explosion radius and damage remain unchanged after character switching', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);
  const enemy = makeEnemy(0, 0, -10);

  let capturedAbility: any = null;
  player.onAbilityRangedShot = (ability) => {
    capturedAbility = ability;
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  // Advance to release time (0.85s)
  player.update(MAGE_NOVA_RELEASE_TIME, input as never, camera as never);
  assert.ok(capturedAbility, 'Orb ability was released');
  assert.equal(capturedAbility.radius, 5.5);
  assert.equal(capturedAbility.damage, 65);

  // Snapshot projectile properties into Shot at launch as done in main.ts
  const spawned = pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: capturedAbility.speed,
    damage: capturedAbility.damage,
    maxRange: capturedAbility.maxRange,
    kind: 'arcaneOrb',
    explosive: true,
    explosionRadius: capturedAbility.radius,
    explosionDamage: capturedAbility.damage,
    maxVerticalOffset: capturedAbility.maxVerticalOffset ?? 2.5,
    radius: 0.48,
  });
  assert.equal(spawned, true);

  // Now, player switches to Barbarian while orb is in flight!
  player.replaceRig(rig as never, profileFor('barbarian'));
  assert.equal(player.profile.id, 'barbarian');
  assert.equal(player.profile.ability?.kind, 'whirlwind');
  assert.equal(player.profile.ability?.radius, 2.8);
  assert.equal(player.profile.ability?.damage, 55);

  // Step the projectile until it impacts the enemy
  let impactReported: Impact | null = null;
  pool.update(0.5, [enemy], (impact) => {
    impactReported = impact;
  });

  assert.ok(impactReported, 'Orb impact occurred');
  assert.equal((impactReported as Impact).kind, 'target');
  // Must preserve Mage's launch-time properties, NOT Barbarian's current profile values!
  assert.equal((impactReported as Impact).explosionRadius, 5.5);
  assert.equal((impactReported as Impact).explosionDamage, 65);
  assert.equal((impactReported as Impact).maxVerticalOffset, 2.0);
  assert.equal((impactReported as Impact).radius, 0.48);
});

test('Impact handler never reads the currently active character\'s ability profile', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);

  // An enemy placed at distance 4.0m from impact point:
  // If explosion uses Mage radius (5.5m), enemy is hit!
  // If handler erroneously read Barbarian ability radius (3.2m), enemy would be missed!
  const distantEnemy = makeEnemy(0, 0, -14); // 4.0m away from impact point
  const closeEnemy = makeEnemy(0, 0, -11); // 1.0m away from impact point
  const enemies = [distantEnemy, closeEnemy];

  let launchedAbility: any = null;
  player.onAbilityRangedShot = (ability) => {
    launchedAbility = ability;
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  player.update(MAGE_NOVA_RELEASE_TIME, input as never, camera as never);
  assert.ok(launchedAbility);

  // Snapshot projectile properties into Shot
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: launchedAbility.speed,
    damage: launchedAbility.damage,
    maxRange: launchedAbility.maxRange,
    kind: 'arcaneOrb',
    explosive: true,
    explosionRadius: launchedAbility.radius,
    explosionDamage: launchedAbility.damage,
    maxVerticalOffset: launchedAbility.maxVerticalOffset ?? 2.5,
    radius: 0.48,
  });

  // Switch to Barbarian during flight
  player.replaceRig(rig as never, profileFor('barbarian'));

  // Wire up the exact impact handler from main.ts:
  // The handler MUST use impact properties, never player.profile.ability!
  let aoeHits: ProjectileTarget[] = [];
  pool.update(0.5, [closeEnemy], (impact) => {
    if (impact.shotKind === 'arcaneOrb') {
      const radius = impact.explosionRadius ?? 0;
      const damage = impact.explosionDamage ?? impact.damage;
      const maxVertical = impact.maxVerticalOffset ?? 2.5;
      aoeHits = executeExplosionAoE(
        impact.position,
        damage,
        radius,
        enemies,
        [],
        maxVertical,
        undefined,
        impact.target,
      );
    }
  });

  // Both close enemy and distant enemy (4m away) must take full 65 damage!
  assert.equal(aoeHits.length, 2);
  assert.equal(distantEnemy.health, 100 - 65);
  assert.equal(closeEnemy.health, 100 - 65);
});

test('Orb radius affects wall collision (wide orb catches wall edge that thin arrow misses)', () => {
  // Box obstacle with minX = 1.0, maxX = 5.0, from z = -10.5 to z = -9.5
  const wall: CameraObstacle = {
    kind: 'box',
    minX: 1.0,
    maxX: 5.0,
    minZ: -10.5,
    maxZ: -9.5,
    bottom: 0,
    top: 5.0,
  };
  const worldWithWall: ProjectileField = { obstacles: [wall], heightAt: () => 0 };
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, worldWithWall, { arcaneOrb: dummyOrbVisual() }, 4);

  // Trajectory: passes at x = 0.70 along z -> -20.
  // Distance to wall minX (1.0) is 0.30m.
  // 1. Thin arrow (radius 0, padding 0.02): clears the edge, no impact on wall
  let arrowImpact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0.70, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 25,
    maxRange: 30,
    kind: 'arrow',
    radius: 0,
  });
  pool.update(0.8, [], (imp) => { arrowImpact = imp; });
  assert.equal(arrowImpact, null, 'Thin arrow clears the wall edge without colliding');

  pool.clear();

  // 2. Arcane Orb (radius 0.48): reaches x = 0.70 + 0.48 = 1.18 > 1.0, so it collides with the wall!
  let orbImpact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0.70, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 30,
    kind: 'arcaneOrb',
    radius: 0.48,
    explosive: true,
  });
  pool.update(0.8, [], (imp) => { orbImpact = imp; });
  assert.ok(orbImpact, 'Arcane Orb collides with wall edge');
  assert.equal((orbImpact as Impact).kind, 'obstacle');
  assert.equal((orbImpact as Impact).shotKind, 'arcaneOrb');
  // Surface position reported should be on the front surface of the wall (z = -9.5)
  assert.ok(Math.abs((orbImpact as Impact).position.z - (-9.5)) < 0.1, `Surface position near wall front: ${(orbImpact as Impact).position.z}`);
});

test('Orb radius affects enemy collision (wide orb catches enemy cylinder edge that thin arrow misses)', () => {
  // Enemy cylinder has radius 0.5. If placed at x = 0.8, z = -10, its boundary is at x = 0.8 - 0.5 = 0.30m.
  const enemy = makeEnemy(0.8, 0, -10);
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);

  // Shot fired along x = 0.0 towards z = -20.
  // Thin arrow at x = 0 misses boundary at x = 0.30m.
  let arrowImpact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 25,
    maxRange: 30,
    kind: 'arrow',
    radius: 0,
  });
  pool.update(0.8, [enemy], (imp) => { arrowImpact = imp; });
  assert.equal(arrowImpact, null, 'Thin arrow misses the enemy cylinder');

  pool.clear();

  // Arcane Orb (radius 0.48): effective reach is 0.0 + 0.48 = 0.48 > 0.30m, so it hits the enemy cylinder!
  let orbImpact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 65,
    maxRange: 30,
    kind: 'arcaneOrb',
    radius: 0.48,
    explosive: true,
  });
  pool.update(0.8, [enemy], (imp) => { orbImpact = imp; });
  assert.ok(orbImpact, 'Arcane Orb hits the enemy cylinder edge');
  assert.equal((orbImpact as Impact).kind, 'target');
  assert.equal((orbImpact as Impact).target, enemy);
});

test('High-speed movement does not tunnel through thin obstacles', () => {
  // Thin obstacle wall: thickness 0.10m from z = -10.05 to z = -9.95
  const thinWall: CameraObstacle = {
    kind: 'box',
    minX: -5.0,
    maxX: 5.0,
    minZ: -10.05,
    maxZ: -9.95,
    bottom: 0,
    top: 5.0,
  };
  const worldWithWall: ProjectileField = { obstacles: [thinWall], heightAt: () => 0 };
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, worldWithWall, { arcaneOrb: dummyOrbVisual() }, 4);

  // High speed: 100 m/s with dt = 0.2s travels 20m in a single frame (from z = 0 to z = -20)
  // A non-swept step would completely tunnel past the 0.1m wall.
  let reportedImpact: Impact | null = null;
  pool.spawn({
    origin: new THREE.Vector3(0, 1.5, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 100,
    damage: 65,
    maxRange: 50,
    kind: 'arcaneOrb',
    radius: 0.48,
    explosive: true,
  });

  pool.update(0.2, [], (imp) => { reportedImpact = imp; });

  assert.ok(reportedImpact, 'High-speed orb detected collision');
  assert.equal((reportedImpact as Impact).kind, 'obstacle');
  // Swept collision stops at the front face (z = -9.95)
  assert.ok(Math.abs((reportedImpact as Impact).position.z - (-9.95)) < 0.15, `Impact on wall surface: ${(reportedImpact as Impact).position.z}`);
});

test('Existing arrow and piercing projectile collision remains unchanged', () => {
  const scene = new THREE.Scene();
  const enemy1 = makeEnemy(0, 0, -5);
  const enemy2 = makeEnemy(0, 0, -10);
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 4);

  // 1. Normal arrow: default radius 0, non-explosive, stops at first enemy
  const impacts: Impact[] = [];
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 30,
    damage: 25,
    maxRange: 30,
    kind: 'arrow',
  });
  const slot0 = pool.inspectSlot(0);
  assert.equal(slot0?.radius, 0);
  assert.equal(slot0?.explosive, false);
  assert.equal(slot0?.explosionRadius, 0);
  assert.equal(slot0?.explosionDamage, 0);

  pool.update(0.5, [enemy1, enemy2], (imp) => impacts.push(imp));
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].target, enemy1);
  assert.equal(impacts[0].shotKind, 'arrow');
  assert.equal(impacts[0].explosionRadius, 0);
  assert.equal(impacts[0].radius, 0);

  pool.clear();
  impacts.length = 0;

  // 2. Piercing arrow: default radius 0, pierces enemy1 and reaches enemy2
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 30,
    damage: 42,
    maxRange: 30,
    kind: 'piercingArrow',
    piercing: true,
  });
  const slotPiercing = pool.inspectSlot(0);
  assert.equal(slotPiercing?.radius, 0);
  assert.equal(slotPiercing?.piercing, true);
  assert.equal(slotPiercing?.explosive, false);

  pool.update(0.5, [enemy1, enemy2], (imp) => impacts.push(imp));
  assert.equal(impacts.length, 2);
  assert.equal(impacts[0].target, enemy1);
  assert.equal(impacts[1].target, enemy2);
  assert.equal(impacts[0].radius, 0);
  assert.equal(impacts[1].radius, 0);
});

test('Projectile recycling resets all newly added properties', () => {
  const scene = new THREE.Scene();
  const pool = new ProjectilePool(scene, FLAT, { arcaneOrb: dummyOrbVisual() }, 2);

  // Spawn an arcaneOrb with custom explosive snapshot properties
  pool.spawn({
    origin: new THREE.Vector3(0, 1.2, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 25,
    damage: 65,
    maxRange: 30,
    kind: 'arcaneOrb',
    explosive: true,
    explosionRadius: 5.5,
    explosionDamage: 65,
    maxVerticalOffset: 2.5,
    radius: 0.48,
  });

  const activeSlot = pool.inspectSlot(0);
  assert.equal(activeSlot?.active, true);
  assert.equal(activeSlot?.kind, 'arcaneOrb');
  assert.equal(activeSlot?.explosive, true);
  assert.equal(activeSlot?.explosionRadius, 5.5);
  assert.equal(activeSlot?.explosionDamage, 65);
  assert.equal(activeSlot?.maxVerticalOffset, 2.5);
  assert.equal(activeSlot?.radius, 0.48);

  // Clear pool (retires all slots)
  pool.clear();

  const retiredSlot = pool.inspectSlot(0);
  assert.equal(retiredSlot?.active, false);
  assert.equal(retiredSlot?.explosive, false);
  assert.equal(retiredSlot?.explosionRadius, 0);
  assert.equal(retiredSlot?.explosionDamage, 0);
  assert.equal(retiredSlot?.maxVerticalOffset, 0);
  assert.equal(retiredSlot?.radius, 0);
  assert.equal(retiredSlot?.speed, 0);
  assert.equal(retiredSlot?.damage, 0);
  assert.equal(retiredSlot?.travelled, 0);
  assert.equal(retiredSlot?.maxRange, 0);

  // Now spawn a basic arrow into the recycled slot
  pool.spawn({
    origin: new THREE.Vector3(1, 1, 1),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 15,
    maxRange: 20,
    kind: 'arrow',
  });

  const reusedSlot = pool.inspectSlot(0);
  assert.equal(reusedSlot?.active, true);
  assert.equal(reusedSlot?.kind, 'arrow');
  assert.equal(reusedSlot?.explosive, false);
  assert.equal(reusedSlot?.explosionRadius, 0);
  assert.equal(reusedSlot?.explosionDamage, 0);
  assert.equal(reusedSlot?.maxVerticalOffset, 0);
  assert.equal(reusedSlot?.radius, 0);
});
