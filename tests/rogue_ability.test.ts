import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import {
  PROFILES,
  profileFor,
  ROGUE_SHADOWSTEP_STEP_COUNT,
  ROGUE_SHADOWSTEP_STEP_DURATION,
  ROGUE_SHADOWSTEP_DASH_DURATION,
  ROGUE_SHADOWSTEP_DASH_DISTANCE,
  ROGUE_SHADOWSTEP_TOTAL_DURATION,
  ROGUE_ABILITY,
  KNIGHT_ABILITY,
  BARBARIAN_ABILITY,
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
    clipDuration: (): number => 0.4,
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
  characterId: 'knight' | 'barbarian' | 'ranger' | 'rogue' = 'rogue',
  obstacles: unknown[] = [],
) {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor(characterId));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();
  return { rig, world, player, camera, input };
}

test('Rogue ability activation and correct initial animation', () => {
  const { rig, player, camera, input } = createTestEnvironment('rogue');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  // Trigger Shadowstep via input
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Dodge_Forward');
  assert.equal(player.currentAbilityCooldown, 7.0);
  assert.equal(player.canStartAbility(), false);
  assert.equal(player.currentAbility?.name, 'Shadowstep');
});

test('Sequential dash strikes across 3 steps with animation switching', () => {
  const { rig, player, camera, input } = createTestEnvironment('rogue');

  const stepsRecorded: number[] = [];
  player.onAbilityStep = (step) => {
    stepsRecorded.push(step);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never); // Step 0 starts (t=0.016s)

  assert.equal(stepsRecorded.length, 1);
  assert.equal(stepsRecorded[0], 0);
  assert.equal(rig.animator.playing, 'Dodge_Forward');

  // Advance to strike window of step 0 (t = 0.133s >= 0.12s)
  for (let i = 0; i < 7; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Advance into step 1 (t = 0.233s > 0.22s)
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(stepsRecorded.length, 2);
  assert.equal(stepsRecorded[1], 1);
  assert.equal(rig.animator.playing, 'Dodge_Forward');

  // Advance to strike window of step 1 (t = 0.35s, inStep = 0.13s >= 0.12s)
  for (let i = 0; i < 7; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Advance into step 2 (t = 0.45s > 0.44s)
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(stepsRecorded.length, 3);
  assert.equal(stepsRecorded[2], 2);
  assert.equal(rig.animator.playing, 'Dodge_Forward');

  // Advance to strike window of step 2 (t = 0.57s)
  for (let i = 0; i < 7; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Advance to recovery (t >= 0.66s)
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Advance past total duration (0.82s, ~10 more frames)
  for (let i = 0; i < 12; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.isAbilityActive, false);
});

test('Collision stopping each dash at walls and obstacles without teleporting through', () => {
  // A box obstacle placed at z = -1.5 (thickness 0.4m, width 4m)
  const wall = {
    kind: 'box',
    minX: -2,
    maxX: 2,
    minZ: -1.7,
    maxZ: -1.3,
    bottom: 0,
    top: 3,
  };

  const { player, camera, input } = createTestEnvironment('rogue', [wall]);

  input.abilityEdge = true;
  // Rogue at (0, 0, 0) facing -Z towards the wall at z = -1.5
  player.update(1 / 60, input as never, camera as never);

  // Dash duration is 0.12s (~8 frames @ 60fps)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Rogue should be stopped in front of the wall (z around -0.9 .. -1.2), never penetrating inside minZ..maxZ
  assert.ok(
    player.position.z > -1.3,
    `Player position z=${player.position.z} must stop before wall front face z=-1.3`,
  );
  assert.ok(
    player.position.z < -0.5,
    `Player position z=${player.position.z} must have dashed forward toward the wall`,
  );
});

test('Strike timing matches animation windows: hits land during strike phase, not frame 0', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const enemy = { id: 'target', alive: true, position: new THREE.Vector3(0, 0, -1.8) };
  player.findAreaTargets = () => [enemy];

  const hitEvents: number[] = [];
  player.onAbilityHit = () => {
    hitEvents.push(currentFrame);
  };

  let currentFrame = 0;
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never); // Frame 0: activation

  // Frames 1-6 (t = 0.016s .. 0.10s): in dash surge, strike has not landed yet
  for (let f = 1; f <= 6; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(hitEvents.length, 0, 'No damage during dash surge before strike window');

  // Frames 7-8 (t reaches 0.133s >= 0.12s dashDuration): strike executes
  for (let f = 7; f <= 8; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(hitEvents.length, 1, 'Hit lands once strike window begins');
  assert.ok(hitEvents[0] >= 7, 'Hit landed at or after frame 7');
});

test('Multiple enemies along dash path are damaged', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const enemy1 = { id: 'e1', alive: true, position: new THREE.Vector3(0.3, 0, -1.0) };
  const enemy2 = { id: 'e2', alive: true, position: new THREE.Vector3(-0.3, 0, -2.2) };
  player.findAreaTargets = () => [enemy1, enemy2];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through step 0 strike (10 frames)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 2, 'Both enemies along dash corridor must be struck');
  assert.ok(hitTargets.includes(enemy1));
  assert.ok(hitTargets.includes(enemy2));
});

test('Enemies outside dash path corridor are not damaged', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  // Path is along Z from 0 to -2.8, pathWidth is 1.3
  const lateralEnemy = { id: 'lateral', alive: true, position: new THREE.Vector3(3.0, 0, -1.5) };
  const behindEnemy = { id: 'behind', alive: true, position: new THREE.Vector3(0, 0, 2.5) };
  player.findAreaTargets = () => [lateralEnemy, behindEnemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through all 3 steps (50 frames)
  for (let i = 0; i < 50; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 0, 'No enemies outside dash corridor should be hit');
});

test('One hit per enemy per activation: no duplicate damage across steps', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const enemy = { id: 'target', alive: true, position: new THREE.Vector3(0, 0, -1.5) };
  player.findAreaTargets = () => [enemy];

  let hitCount = 0;
  player.onAbilityHit = () => {
    hitCount += 1;
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through all 3 steps and recovery (55 frames)
  for (let i = 0; i < 55; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitCount, 1, 'Enemy must take damage exactly once across all 3 steps');
});

test('Dead and vertically out-of-range enemies are ignored', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const deadEnemy = { id: 'dead', alive: false, position: new THREE.Vector3(0, 0, -1.5) };
  const highEnemy = { id: 'high', alive: true, position: new THREE.Vector3(0, 3.0, -1.5) }; // dy = 3.0 > 1.5 maxVerticalOffset
  player.findAreaTargets = () => [deadEnemy, highEnemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 0, 'Dead and elevated enemies must not be hit');
});

test('Line of sight check prevents damaging enemies through walls', () => {
  const wall = {
    kind: 'box',
    minX: -2,
    maxX: 2,
    minZ: -1.2,
    maxZ: -0.8,
    bottom: 0,
    top: 3,
  };

  const { player, camera, input } = createTestEnvironment('rogue', [wall]);

  // Enemy is placed behind the wall at z = -2.0
  const enemyBehindWall = { id: 'behindWall', alive: true, position: new THREE.Vector3(0, 0, -2.0) };
  player.findAreaTargets = () => [enemyBehindWall];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 0, 'Enemy behind wall must not be hit through cover');
});

test('Cooldown behaviour and persistence across character switches', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.ok(player.currentAbilityCooldown > 6.9);

  // Cannot switch while ability is executing
  assert.equal(player.canSwitchCharacter, false);

  // Advance past total duration (0.82s, ~50 frames @ 60fps)
  for (let i = 0; i < 55; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.canSwitchCharacter, true);

  const cooldownAfterFinish = player.currentAbilityCooldown;
  assert.ok(cooldownAfterFinish > 5.9 && cooldownAfterFinish < 6.2);

  // Switch to Knight
  player.replaceRig(makeRig() as never, profileFor('knight'));
  assert.equal(player.profile.id, 'knight');
  assert.equal(player.currentAbilityCooldown, 0); // Knight hasn't used its ability yet

  // Advance time by 2.0 seconds while playing Knight (120 frames @ 60fps)
  for (let i = 0; i < 120; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Switch back to Rogue
  assert.equal(player.canSwitchCharacter, true);
  player.replaceRig(makeRig() as never, profileFor('rogue'));
  assert.equal(player.profile.id, 'rogue');

  // Cooldown kept ticking in background (~3.9s - 4.2s left)
  const cooldownAfterSwap = player.currentAbilityCooldown;
  assert.ok(cooldownAfterSwap > 3.8 && cooldownAfterSwap < 4.2);

  // Advance remaining cooldown time (~260 frames = 4.33s)
  for (let i = 0; i < 260; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.currentAbilityCooldown, 0);
  assert.equal(player.canStartAbility(), true);
});

test('Hyper-armour during active sequence and dodge cancel during recovery', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);

  // Advance to active phase (t >= 0.10s, 10 frames = 0.166s)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'active');

  // Incoming damage during active sequence should not interrupt (hyper-armour)
  const damageTaken = player.takeDamage(20, new THREE.Vector3(0, 0, 1));
  assert.equal(damageTaken, 20);
  assert.equal(player.isAbilityActive, true, 'Ability must not be cancelled by damage (hyper-armour)');

  // Normal attack inputs cannot interrupt active sequence
  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);
  assert.equal(player.isAttacking, false);

  // Advance into recovery phase (t >= 0.66s, 30 more frames from t=0.18s puts t at 0.68s)
  for (let i = 0; i < 30; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Dodge during recovery phase cancels recovery into a dodge roll
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, false, 'Dodge in recovery phase cancels ability');
  assert.equal(player.isDodging, true, 'Player enters dodge state');
});

test('Rogue light-attack alternation remains intact and is not corrupted by ability', () => {
  const { rig, player, camera, input } = createTestEnvironment('rogue');

  // First light attack: Melee_Dualwield_Attack_Stab
  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Stab');

  // Finish light attack (0.6s)
  for (let i = 0; i < 40; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAttacking, false);

  // Perform Shadowstep
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAbilityActive, true);

  // Finish Shadowstep
  for (let i = 0; i < 55; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);

  // Next light attack must alternate to Melee_Dualwield_Attack_Slice
  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice', 'Light attack alternation preserved');
});

test('Knight Shield Counter and Barbarian Whirlwind remain fully functional', () => {
  // Knight
  const knightEnv = createTestEnvironment('knight');
  knightEnv.input.abilityEdge = true;
  knightEnv.player.update(1 / 60, knightEnv.input as never, knightEnv.camera as never);
  assert.equal(knightEnv.player.isAbilityActive, true);
  assert.equal(knightEnv.player.currentAbility?.id, 'shield_counter');
  assert.equal(knightEnv.rig.animator.playing, 'Melee_Block_Attack');

  // Barbarian
  const barbEnv = createTestEnvironment('barbarian');
  barbEnv.input.abilityEdge = true;
  barbEnv.player.update(1 / 60, barbEnv.input as never, barbEnv.camera as never);
  assert.equal(barbEnv.player.isAbilityActive, true);
  assert.equal(barbEnv.player.currentAbility?.id, 'whirlwind');
  assert.equal(barbEnv.rig.animator.playing, 'Melee_2H_Attack_Spinning');
});
