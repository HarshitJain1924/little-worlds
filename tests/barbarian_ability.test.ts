import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import {
  PROFILES,
  profileFor,
  BARBARIAN_WHIRLWIND_HIT_START,
  BARBARIAN_WHIRLWIND_HIT_END,
  BARBARIAN_WHIRLWIND_DURATION,
  BARBARIAN_ABILITY,
  KNIGHT_ABILITY,
} from '../src/play/movesets.ts';

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
    clipDuration: (): number => 0.667,
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

function createTestEnvironment(characterId: 'knight' | 'barbarian' | 'ranger' | 'rogue' = 'barbarian', obstacles: unknown[] = []) {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor(characterId));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();
  return { rig, world, player, camera, input };
}

test('Barbarian ability activation and correct animation', () => {
  const { rig, player, camera, input } = createTestEnvironment('barbarian');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  // Trigger Whirlwind via input
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Melee_2H_Attack_Spinning');
  assert.equal(player.currentAbilityCooldown, 8.0);
  assert.equal(player.canStartAbility(), false);
  assert.equal(player.currentAbility?.name, 'Whirlwind');
});

test('Barbarian cooldown behaviour and persistence across character switches', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.ok(player.currentAbilityCooldown > 7.9);

  // Cannot switch while ability is executing
  assert.equal(player.canSwitchCharacter, false);

  // Advance past total duration (0.667s, ~41 frames @ 60fps)
  for (let i = 0; i < 45; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.canSwitchCharacter, true);

  const cooldownAfterFinish = player.currentAbilityCooldown;
  assert.ok(cooldownAfterFinish > 7.1 && cooldownAfterFinish < 7.4);

  // Switch to Ranger
  player.replaceRig(makeRig() as never, profileFor('ranger'));
  assert.equal(player.profile.id, 'ranger');
  assert.equal(player.currentAbilityCooldown, 0); // Ranger has no ability cooldown

  // Advance time by 2.0 seconds while playing Ranger (120 frames @ 60fps)
  for (let i = 0; i < 120; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Switch back to Barbarian
  assert.equal(player.canSwitchCharacter, true);
  player.replaceRig(makeRig() as never, profileFor('barbarian'));
  assert.equal(player.profile.id, 'barbarian');

  // Cooldown kept ticking in background (~5.2s left)
  const cooldownAfterSwap = player.currentAbilityCooldown;
  assert.ok(cooldownAfterSwap > 5.0 && cooldownAfterSwap < 5.4);

  // Advance remaining cooldown time (~330 frames = 5.5s)
  for (let i = 0; i < 330; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.currentAbilityCooldown, 0);
  assert.equal(player.canStartAbility(), true);
});

test('Active hit-window timing bounds (startup, active, recovery, idle)', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // t = 0.016s: startup (hitStart is 0.10s)
  assert.equal(player.activeAbilityPhase, 'startup');

  // Advance to t = 0.08s (4 more frames)
  for (let i = 0; i < 4; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'startup');

  // Advance to t = 0.12s (2 more frames) -> active phase starts (hitStart = 0.10s)
  player.update(1 / 60, input as never, camera as never);
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Mid spin at t = 0.35s (14 more frames)
  for (let i = 0; i < 14; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Late spin at t = 0.50s (9 more frames, hitEnd = 0.54s)
  for (let i = 0; i < 9; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Recovery at t = 0.58s (5 more frames)
  for (let i = 0; i < 5; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Settle / Idle at t = 0.70s (7 more frames, duration = 0.667s)
  for (let i = 0; i < 7; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.isAbilityActive, false);
});

test('360-degree radial detection strikes enemies in front, behind, left, and right', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  const frontEnemy = { id: 'front', alive: true, position: new THREE.Vector3(0, 0, -2.0) };
  const backEnemy = { id: 'back', alive: true, position: new THREE.Vector3(0, 0, 2.0) };
  const leftEnemy = { id: 'left', alive: true, position: new THREE.Vector3(-2.2, 0, 0) };
  const rightEnemy = { id: 'right', alive: true, position: new THREE.Vector3(2.2, 0, 0) };

  const enemies = [frontEnemy, backEnemy, leftEnemy, rightEnemy];
  player.findAreaTargets = () => enemies;

  const hitResults: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitResults.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through active window (from 0.10s to 0.54s)
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitResults.length, 4, 'All 4 enemies around the Barbarian must be struck');
  assert.ok(hitResults.includes(frontEnemy), 'Front enemy hit');
  assert.ok(hitResults.includes(backEnemy), 'Back enemy hit');
  assert.ok(hitResults.includes(leftEnemy), 'Left enemy hit');
  assert.ok(hitResults.includes(rightEnemy), 'Right enemy hit');
});

test('Whirlwind hit detection follows the axe rotation progressively over time, rather than hitting all enemies on the first frame', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  // Facing -Z (yaw = PI):
  // Left is +X, Back is +Z, Right is -X, Front is -Z
  const enemyLeft = { id: 'left', alive: true, position: new THREE.Vector3(2.0, 0, 0) };
  const enemyBack = { id: 'back', alive: true, position: new THREE.Vector3(0, 0, 2.0) };
  const enemyRight = { id: 'right', alive: true, position: new THREE.Vector3(-2.0, 0, 0) };
  const enemyFront = { id: 'front', alive: true, position: new THREE.Vector3(0, 0, -2.0) };

  const enemies = [enemyLeft, enemyBack, enemyRight, enemyFront];
  player.findAreaTargets = () => enemies;

  const hitOrder: { id: string; frame: number }[] = [];
  player.onAbilityHit = (target) => {
    hitOrder.push({ id: (target as { id: string }).id, frame: currentFrame });
  };

  let currentFrame = 0;
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never); // Frame 0: activation

  // Step through frames 1 to 32 (~0.53s)
  for (let f = 1; f <= 32; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }

  // 1. All 4 enemies must be hit
  assert.equal(hitOrder.length, 4, 'All 4 enemies in the 360 circle must be hit');

  // 2. Hits must occur at distinctly different frames, proving progressive sweep rather than instant AoE
  const leftHit = hitOrder.find((h) => h.id === 'left')!;
  const backHit = hitOrder.find((h) => h.id === 'back')!;
  const rightHit = hitOrder.find((h) => h.id === 'right')!;
  const frontHit = hitOrder.find((h) => h.id === 'front')!;

  assert.ok(leftHit, 'Left enemy was hit');
  assert.ok(backHit, 'Back enemy was hit');
  assert.ok(rightHit, 'Right enemy was hit');
  assert.ok(frontHit, 'Front enemy was hit');

  // Verify the progressive sequential order matching axe rotation
  assert.ok(
    leftHit.frame < backHit.frame,
    `Left enemy (frame ${leftHit.frame}) must be hit before Back enemy (frame ${backHit.frame})`,
  );
  assert.ok(
    backHit.frame < rightHit.frame,
    `Back enemy (frame ${backHit.frame}) must be hit before Right enemy (frame ${rightHit.frame})`,
  );
  assert.ok(
    rightHit.frame < frontHit.frame,
    `Right enemy (frame ${rightHit.frame}) must be hit before Front enemy (frame ${frontHit.frame})`,
  );

  // Proves that at early spin (e.g. frame 8), opposite side enemies (back, right, front) were not yet hit
  assert.ok(leftHit.frame <= 8, 'Left enemy is reached early in the rotation');
  assert.ok(backHit.frame > 8, 'Back enemy is not hit on the first active frames');
  assert.ok(rightHit.frame > 14, 'Right enemy is not reached until mid-spin');
  assert.ok(frontHit.frame > 20, 'Front enemy is reached as the spin completes');
});

test('Multiple enemies hit in one activation and no duplicate damage across frames', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  const enemyA = {
    id: 'eA',
    alive: true,
    position: new THREE.Vector3(1.2, 0, 0),
    damageTaken: 0,
    takeDamage(dmg: number) {
      this.damageTaken += dmg;
      return true;
    },
  };
  const enemyB = {
    id: 'eB',
    alive: true,
    position: new THREE.Vector3(-1.4, 0, 0.5),
    damageTaken: 0,
    takeDamage(dmg: number) {
      this.damageTaken += dmg;
      return true;
    },
  };
  const enemyC = {
    id: 'eC',
    alive: true,
    position: new THREE.Vector3(0, 0, -1.8),
    damageTaken: 0,
    takeDamage(dmg: number) {
      this.damageTaken += dmg;
      return true;
    },
  };

  const enemies = [enemyA, enemyB, enemyC];
  player.findAreaTargets = () => enemies;

  let totalHits = 0;
  player.onAbilityHit = (target, ability) => {
    totalHits += 1;
    (target as typeof enemyA).takeDamage(ability.damage);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Step into active spin (25 frames = ~0.42s)
  for (let i = 0; i < 25; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(totalHits, 3, 'Exactly 3 hits delivered during active window');
  assert.equal(enemyA.damageTaken, 55, 'Enemy A hit exactly once for 55 damage');
  assert.equal(enemyB.damageTaken, 55, 'Enemy B hit exactly once for 55 damage');
  assert.equal(enemyC.damageTaken, 55, 'Enemy C hit exactly once for 55 damage');
  assert.equal(player.abilityTargetsHit.size, 3, 'All 3 targets recorded in hit set during ability');

  // Advance through remaining frames until ability finishes (16 more frames = 41 total frames > 0.667s)
  for (let i = 0; i < 16; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // No extra hits occurred in remaining frames
  assert.equal(totalHits, 3, 'No duplicate hits delivered in subsequent frames');
  assert.equal(player.isAbilityActive, false, 'Ability has ended');
});

test('Dead and vertically out-of-range enemies ignored', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  const deadEnemy = { id: 'dead', alive: false, position: new THREE.Vector3(0, 0, 1.0) };
  const highEnemy = { id: 'high', alive: true, position: new THREE.Vector3(0, 2.5, 0) }; // dy = 2.5m > 1.5m
  const lowEnemy = { id: 'low', alive: true, position: new THREE.Vector3(0, -2.0, 0) };  // dy = 2.0m > 1.5m
  const distantEnemy = { id: 'distant', alive: true, position: new THREE.Vector3(3.5, 0, 0) }; // dist = 3.5m > 2.8m
  const validEnemy = { id: 'valid', alive: true, position: new THREE.Vector3(1.0, 0.4, 0.5) };

  const enemies = [deadEnemy, highEnemy, lowEnemy, distantEnemy, validEnemy];
  player.findAreaTargets = () => enemies;

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  for (let i = 0; i < 35; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 1);
  assert.equal(hitTargets[0], validEnemy);
});

test('Obstacles preventing damage through walls', () => {
  const wallObstacle = {
    kind: 'box' as const,
    minX: -5,
    maxX: 5,
    minZ: -1.2,
    maxZ: -0.8,
    bottom: 0,
    top: 5,
  };

  const { player, camera, input } = createTestEnvironment('barbarian', [wallObstacle]);

  const enemyBehindWall = { id: 'behind_wall', alive: true, position: new THREE.Vector3(0, 0, -2.0) };
  const enemyInClear = { id: 'clear', alive: true, position: new THREE.Vector3(2.0, 0, 0) };

  const enemies = [enemyBehindWall, enemyInClear];
  player.findAreaTargets = () => enemies;

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  for (let i = 0; i < 35; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 1);
  assert.equal(hitTargets[0], enemyInClear, 'Only enemy with clear line-of-sight is hit');
  assert.ok(!hitTargets.includes(enemyBehindWall), 'Enemy behind solid wall must not be hit');
});

test('Active ability cannot be interrupted by normal attacks or dodge', () => {
  const { rig, player, camera, input } = createTestEnvironment('barbarian');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance into active spin phase (t = 0.25s)
  for (let i = 0; i < 15; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Attempt to trigger attack
  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, false, 'Attack must not interrupt active Whirlwind');
  assert.equal(player.isAbilityActive, true);

  // Attempt to trigger dodge during active phase
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false, 'Dodge must not interrupt active Whirlwind');
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Melee_2H_Attack_Spinning');
});

test('Hyper-armour protects active spin phase while recovery is interruptible', () => {
  const { rig, player, camera, input } = createTestEnvironment('barbarian');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // 1. Advance to active phase (0.25s = 15 frames)
  for (let i = 0; i < 15; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'active');

  // Enemy hits player with 20 damage during active spin
  const attacker = { id: 'skel', alive: true, position: new THREE.Vector3(0, 0, -1) };
  const applied1 = player.takeDamage(20, attacker.position, attacker);
  assert.equal(applied1, 20);
  assert.equal(player.health, 80);
  // Hyper-armour protects active spin: stays in Whirlwind
  assert.equal(player.isAbilityActive, true);
  assert.equal(rig.animator.playing, 'Melee_2H_Attack_Spinning');

  // Finish ability and reset
  for (let i = 0; i < 35; i += 1) player.update(1 / 60, input as never, camera as never);
  player.reset();

  // 2. Start fresh Whirlwind and advance to recovery phase (0.58s = 35 frames)
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  for (let i = 0; i < 35; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Enemy hits player during recovery phase
  const applied2 = player.takeDamage(20, attacker.position, attacker);
  assert.equal(applied2, 20);
  assert.equal(player.health, 80);
  // Recovery is interruptible: ability ends and Hit_A plays
  assert.equal(player.isAbilityActive, false);
  assert.equal(rig.animator.playing, 'Hit_A');
});

test('Dodge cancellation permitted during recovery phase', () => {
  const { rig, player, camera, input } = createTestEnvironment('barbarian');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance to recovery phase (0.58s = 35 frames)
  for (let i = 0; i < 35; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Cancel recovery into dodge
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isDodging, true, 'Dodge successfully cancelled recovery');
  assert.equal(player.isAbilityActive, false, 'Ability cleanly ended');
  assert.equal(rig.animator.playing, 'Dodge_Forward');
});

test('Controlled movement scaling during Whirlwind', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  input.moveDirection = { x: 0, y: 1, run: false }; // Walk forward
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Step into active spin
  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Speed is non-zero (controlled movement), but scaled down by moveScale (0.35)
  const speed = player.velocity.length();
  assert.ok(speed > 0.4 && speed < 1.2, `Speed ${speed} must reflect ~0.35 * 2.5m/s walk speed`);
});

test('Regression check: Knight Shield Counter remains fully operational', () => {
  const { rig, player, camera, input } = createTestEnvironment('knight');

  let riposteHitTarget: unknown = null;
  player.onAbilityHit = (target) => {
    riposteHitTarget = target;
  };

  // Start Knight Shield Counter
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(player.isCounterWindowActive, true);
  assert.equal(rig.animator.playing, 'Melee_Block_Attack');

  // Attacker strikes within counter window
  const attacker = { id: 'orc', alive: true, position: new THREE.Vector3(0, 0, -1.8) };
  const applied = player.takeDamage(30, attacker.position, attacker);
  assert.equal(applied, 0, 'Damage negated');
  assert.equal(player.isCounterTriggered, true);

  // Advance to riposte strike frame
  for (let i = 0; i < 28; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(riposteHitTarget, attacker, 'Riposte counters attacker');
});
