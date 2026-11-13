import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player, handleAbilityHit } from '../src/play/player.ts';
import { Enemy, type EnemyConfig } from '../src/play/enemy.ts';
import { CombatEffects } from '../src/play/effects.ts';
import {
  PROFILES,
  profileFor,
  MAGE_NOVA_TIME_SCALE,
  MAGE_NOVA_CHANNEL_DURATION,
  MAGE_NOVA_RELEASE_TIME,
  MAGE_NOVA_ACTIVE_END,
  MAGE_NOVA_TOTAL_DURATION,
  MAGE_NOVA_RADIUS,
  MAGE_NOVA_DAMAGE,
  MAGE_NOVA_COOLDOWN,
  MAGE_NOVA_MAX_VERTICAL,
  MAGE_NOVA_MOVE_SCALE,
  MAGE_ABILITY,
  KNIGHT_ABILITY,
  BARBARIAN_ABILITY,
  ROGUE_ABILITY,
  RANGER_ABILITY,
} from '../src/play/movesets.ts';
import type { CameraObstacle } from '../src/play/collision.ts';

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
  return {
    root: new THREE.Object3D(),
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

interface MockEnemy {
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

test('Mage ability activation and initial animation', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Ranged_Magic_Spellcasting_Long');
  assert.equal(player.currentAbilityCooldown, MAGE_NOVA_COOLDOWN);
  assert.equal(player.canStartAbility(), false);
});

test('Mage ability lifecycle timing bounds (startup, active, recovery, idle)', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.activeAbilityPhase, 'startup');

  // Channel duration = 0.70s sim time (startup phase)
  // Step to 0.65s sim time -> still in startup (< 0.70s)
  player.update(0.65 - 1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'startup');

  // Step to 0.72s sim time (>= 0.70s channelDuration, < 0.95s activeEnd) -> active
  player.update(0.07, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Step to 0.92s sim time (< 0.95s activeEnd) -> still active
  player.update(0.20, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Step to 0.98s sim time (>= 0.95s activeEnd, < 1.25s duration) -> recovery
  player.update(0.06, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Step past duration (1.25s sim time) -> idle
  player.update(0.30, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.isAbilityActive, false);
});

test('Mage cooldown behaviour and persistence across character switches', () => {
  const { rig, player, camera, input } = createTestEnvironment('mage');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.ok(player.currentAbilityCooldown > 8.9);
  assert.equal(player.canSwitchCharacter, false);

  // Advance time until ability finishes
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

test('Radial detection strikes enemies 360 degrees within 5.5m and ignores enemies outside radius', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  const frontEnemy = makeEnemy(0, 0, -4.0);
  const backEnemy = makeEnemy(0, 0, 4.0);
  const leftEnemy = makeEnemy(-4.0, 0, 0);
  const rightEnemy = makeEnemy(4.0, 0, 0);
  const farEnemy = makeEnemy(6.0, 0, 0); // Distance 6.0m > 5.5m

  const enemies = [frontEnemy, backEnemy, leftEnemy, rightEnemy, farEnemy];
  player.findAreaTargets = () => enemies;

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target, ability) => {
    hitTargets.push(target);
    (target as MockEnemy).takeDamage(ability.damage, player.position);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance to releaseTime (0.78s sim time)
  player.update(0.78, input as never, camera as never);

  // All 4 enemies within 5.5m should be hit
  assert.ok(hitTargets.includes(frontEnemy));
  assert.ok(hitTargets.includes(backEnemy));
  assert.ok(hitTargets.includes(leftEnemy));
  assert.ok(hitTargets.includes(rightEnemy));
  assert.equal(hitTargets.includes(farEnemy), false);

  assert.equal(frontEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.equal(backEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.equal(leftEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.equal(rightEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.equal(farEnemy.health, 100);
});

test('No damage dealt before release time', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  const enemy = makeEnemy(0, 0, -3.0);
  player.findAreaTargets = () => [enemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance to 0.70s (before releaseTime 0.78s)
  player.update(0.69, input as never, camera as never);
  assert.equal(hitTargets.length, 0);
  assert.equal(enemy.health, 100);

  // Advance to 0.80s (releaseTime 0.78s passed)
  player.update(0.11, input as never, camera as never);
  assert.equal(hitTargets.length, 1);
  assert.equal(hitTargets[0], enemy);
});

test('Single hit per enemy per activation and no duplicate damage across frames', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  const enemy = makeEnemy(0, 0, -2.5);
  player.findAreaTargets = () => [enemy];

  let hitCount = 0;
  player.onAbilityHit = (target, ability) => {
    hitCount += 1;
    (target as MockEnemy).takeDamage(ability.damage, player.position);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Step frame-by-frame through startup past releaseTime into recovery (60 frames = 1.0s)
  for (let i = 0; i < 60; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitCount, 1);
  assert.equal(enemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.equal(player.abilityTargetsHit.has(enemy), true);

  // Step remaining frames until ability finishes
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Hit count must still be 1 (no repeat hits on subsequent frames)
  assert.equal(hitCount, 1);
  assert.equal(player.isAbilityActive, false);
});

test('Dead and vertically out-of-range enemies ignored', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  const deadEnemy = makeEnemy(0, 0, -3.0);
  deadEnemy.alive = false;

  const tooHighEnemy = makeEnemy(0, 2.5, -3.0); // dy = 2.5m > 1.8m
  const validHeightEnemy = makeEnemy(0, 1.2, -3.0); // dy = 1.2m <= 1.8m

  player.findAreaTargets = () => [deadEnemy, tooHighEnemy, validHeightEnemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance to releaseTime
  player.update(0.78, input as never, camera as never);

  assert.equal(hitTargets.length, 1);
  assert.equal(hitTargets[0], validHeightEnemy);
});

test('Obstacles prevent damage through walls (Line-of-Sight)', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minZ: -2.2,
    maxZ: -1.8,
    bottom: 0,
    top: 5,
  };

  const { player, camera, input } = createTestEnvironment('mage', [wall]);

  const behindWallEnemy = makeEnemy(0, 0, -3.5); // Blocked by wall at z = -2.0
  const openEnemy = makeEnemy(3.0, 0, 0); // Unblocked on positive x axis

  player.findAreaTargets = () => [behindWallEnemy, openEnemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  player.update(0.78, input as never, camera as never);

  assert.equal(hitTargets.length, 1);
  assert.equal(hitTargets[0], openEnemy);
  assert.equal(hitTargets.includes(behindWallEnemy), false);
});

test('Hyper-armour protects active staff slam phase while startup and recovery are interruptible', () => {
  // Test 1: Hit during startup interrupts ability
  {
    const { player, camera, input, rig } = createTestEnvironment('mage');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.activeAbilityPhase, 'startup');

    // Take damage during startup
    player.takeDamage(10, new THREE.Vector3(0, 0, -5));
    assert.equal(player.isAbilityActive, false);
    assert.equal(player.activeAbilityPhase, 'idle');
    assert.equal(rig.animator.playing, 'Hit_A');
  }

  // Test 2: Hit during active phase is resisted by hyper-armour
  {
    const { player, camera, input, rig } = createTestEnvironment('mage');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);

    // Step into active phase (sim time 0.74s, >= 0.70s channelDuration, < 0.95s activeEnd)
    player.update(0.74, input as never, camera as never);
    assert.equal(player.activeAbilityPhase, 'active');

    // Take damage during active phase
    player.takeDamage(10, new THREE.Vector3(0, 0, -5));
    assert.equal(player.isAbilityActive, true);
    assert.equal(player.activeAbilityPhase, 'active');
    assert.notEqual(rig.animator.playing, 'Hit_A');
  }

  // Test 3: Hit during recovery phase interrupts ability
  {
    const { player, camera, input, rig } = createTestEnvironment('mage');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);

    // Step into recovery phase (sim time 1.05s, >= 0.95s activeEnd, < 1.25s duration)
    player.update(1.04, input as never, camera as never);
    assert.equal(player.activeAbilityPhase, 'recovery');

    // Take damage during recovery phase
    player.takeDamage(10, new THREE.Vector3(0, 0, -5));
    assert.equal(player.isAbilityActive, false);
    assert.equal(player.activeAbilityPhase, 'idle');
    assert.equal(rig.animator.playing, 'Hit_A');
  }
});

test('Dodge cancellation permitted during recovery phase', () => {
  const { player, camera, input } = createTestEnvironment('mage');
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // During startup (0.30s), dodge cannot interrupt
  player.update(0.30, input as never, camera as never);
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);
  assert.equal(player.isAbilityActive, true);

  // During active phase (0.75s), dodge cannot interrupt
  player.update(0.44, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);
  assert.equal(player.isAbilityActive, true);

  // During recovery phase (1.05s), dodge cancels ability
  player.update(0.29, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, true);
  assert.equal(player.isAbilityActive, false);
});

test('Controlled movement scaling during Arcane Nova', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  // Regular running movement
  input.moveDirection = { x: 0, y: 1, run: true };
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  const regularSpeed = player.speed;
  assert.ok(regularSpeed > 5.0, `Expected run speed > 5.0, got ${regularSpeed}`);

  // Activate ability while moving
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);

  // Advance time to let speed stabilize
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Speed should be scaled by moveScale = 0.2 (RUN_SPEED * 0.2 ≈ 1.24)
  assert.ok(player.speed < 2.0, `Expected slowed speed < 2.0, got ${player.speed}`);
  assert.ok(player.speed > 0.5, `Expected non-zero speed > 0.5, got ${player.speed}`);
});

test('Mage basic light and heavy attacks remain completely intact', () => {
  const { player, camera, input, rig } = createTestEnvironment('mage');

  // Test light attack
  let lightFired = false;
  player.onRangedShot = (attack) => {
    if (attack.tag === 'light') lightFired = true;
  };

  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Shoot');
  assert.equal(player.isAttacking, true);

  // Step past light hitStart (0.28 / 1.35 = 0.207s)
  player.update(0.25, input as never, camera as never);
  assert.equal(lightFired, true);

  // Let light attack finish
  player.update(0.5, input as never, camera as never);
  assert.equal(player.isAttacking, false);

  // Test heavy attack charge
  input.heavyEdge = true;
  input.heavyHeld = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCharging, true);
  assert.equal(rig.animator.playing, 'Ranged_Magic_Raise');

  // Hold charge to full (1.0s)
  player.update(1.0, input as never, camera as never);
  assert.equal(player.chargeProgress, 1.0);
  assert.equal(player.chargePower, 1.0);

  let heavyFired = false;
  player.onRangedShot = (attack) => {
    if (attack.tag === 'heavy') {
      heavyFired = true;
      assert.equal(attack.damage, 48); // Full charge maxDamage
    }
  };

  // Release heavy attack
  input.heavyHeld = false;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCharging, false);

  // Attack starts
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, true);

  // Step past cast release (0.28 / 0.95 = 0.295s)
  player.update(0.35, input as never, camera as never);
  assert.equal(heavyFired, true);
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

test('Real Enemy integration: handleAbilityHit damages real Enemy instance with damage and knockback', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minZ: -2.2,
    maxZ: -1.8,
    bottom: 0,
    top: 5,
  };
  const { player } = createTestEnvironment('mage', [wall]);

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
  const unblockedEnemy = new Enemy(rig1 as never, enemyConfig, { x: 3, z: 0 }, world as never);
  const blockedEnemy = new Enemy(rig2 as never, enemyConfig, { x: 0, z: -3.5 }, world as never);

  let damageCallbackEnemy: Enemy | null = null;
  let damageCallbackAmount = 0;

  // Unblocked enemy hit
  const hitSuccess = handleAbilityHit(
    unblockedEnemy,
    MAGE_ABILITY,
    player,
    world.obstacles,
    (enemy, damage) => {
      damageCallbackEnemy = enemy;
      damageCallbackAmount = damage;
    },
  );

  assert.equal(hitSuccess, true);
  assert.equal(damageCallbackEnemy, unblockedEnemy);
  assert.equal(damageCallbackAmount, MAGE_NOVA_DAMAGE);
  assert.equal(unblockedEnemy.health, 100 - MAGE_NOVA_DAMAGE);
  assert.ok(unblockedEnemy.position.x > 3.0, 'Enemy was knocked back along positive X axis');

  // Blocked enemy hit should fail LOS check
  const blockedSuccess = handleAbilityHit(
    blockedEnemy,
    MAGE_ABILITY,
    player,
    world.obstacles,
  );
  assert.equal(blockedSuccess, false);
  assert.equal(blockedEnemy.health, 100);
});

test('Arcane Nova triggers onAbilityRelease for shockwave VFX even with zero enemies present', () => {
  const { player, camera, input } = createTestEnvironment('mage');

  player.findAreaTargets = () => []; // No enemies in scene

  let releaseFired = false;
  let releasedAbilityKind = '';
  let releasedRadius = 0;

  player.onAbilityRelease = (ability) => {
    releaseFired = true;
    releasedAbilityKind = ability.kind;
    if (ability.kind === 'nova') {
      releasedRadius = ability.radius;
    }
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(releaseFired, false);

  // Advance to releaseTime
  player.update(0.78, input as never, camera as never);
  assert.equal(releaseFired, true);
  assert.equal(releasedAbilityKind, 'nova');
  assert.equal(releasedRadius, 5.5);
});

test('CombatEffects: Arcane Nova shockwave pooling, expansion to target radius, and disposal', () => {
  const scene = new THREE.Scene();
  const effects = new CombatEffects(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 5, 8);
  camera.lookAt(0, 0, 0);

  // Spawn nova shockwave at (2, 0, 3) with target radius 5.5
  effects.spawnNova({ x: 2, y: 0, z: 3 }, 5.5);

  const group = scene.getObjectByName('combat-effects') as THREE.Group;
  assert.ok(group, 'CombatEffects group exists in scene');

  // Verify effects update and expand
  // At t=0.1s: radius expands from 0.4 toward 5.5
  effects.update(0.1, camera);

  // Step until nova finishes (life = 0.48s)
  effects.update(0.40, camera);

  // Spawn multiple times to verify pool wraps around and recycles cleanly without throwing
  for (let i = 0; i < 6; i += 1) {
    effects.spawnNova({ x: i, y: 0, z: 0 }, 5.5);
    effects.update(0.05, camera);
  }

  // Dispose cleanly
  effects.dispose();
  assert.doesNotThrow(() => effects.dispose());
});
