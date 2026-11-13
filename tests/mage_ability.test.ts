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
  // Test solver convergence: camera is at (0.45, 1.7, 4.0), muzzle is at (0.35, 1.4, 0.2)
  // Crosshair aims at distant enemy at (0, 1.05, -15). The shot trajectory from muzzle must hit that enemy.
  const world = { obstacles: [], heightAt: () => 0 };
  const targetEnemy = makeEnemy(0, 0, -15);
  const muzzle = new THREE.Vector3(0.35, 1.4, 0.2);
  const targetPoint = new THREE.Vector3(0, 1.05, -15);

  const shotDir = targetPoint.clone().sub(muzzle).normalize();
  const aimPoint = new THREE.Vector3();
  const solution = solveShot(muzzle, shotDir, world as never, [targetEnemy], 40, aimPoint);

  assert.equal(solution.kind, 'enemy');
  assert.equal(solution.target, targetEnemy);
  assert.ok(aimPoint.distanceTo(targetPoint) < 0.6, 'Trajectory converges on crosshair target');
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
