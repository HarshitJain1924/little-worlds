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
  ROGUE_SHADOWSTEP_STRIKE_CONTACT,
  ROGUE_SHADOWSTEP_STRIKE_TIME_SCALE,
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

test('Sequential dash strikes across 3 steps with animation switching and timing', () => {
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

  // Step 0: advance past dashDuration (0.15s, 10 frames = 0.166s)
  for (let i = 0; i < 9; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Step 1: advance past stepDuration (0.40s, 15 more frames = 0.416s)
  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(stepsRecorded.length, 2);
  assert.equal(stepsRecorded[1], 1);
  assert.equal(rig.animator.playing, 'Dodge_Forward');

  // Step 1: advance past dashDuration (0.15s into step 1, 10 frames)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Step 2: advance into step 2 (0.80s, 15 more frames = 0.833s)
  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(stepsRecorded.length, 3);
  assert.equal(stepsRecorded[2], 2);
  assert.equal(rig.animator.playing, 'Dodge_Forward');

  // Step 2: advance past dashDuration (0.15s into step 2, 10 frames)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(rig.animator.playing, 'Melee_Dualwield_Attack_Slice');

  // Advance to recovery (t >= 1.20s, 15 more frames = 1.25s)
  for (let i = 0; i < 15; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Advance past total duration (1.38s, 10 more frames = 1.41s)
  for (let i = 0; i < 10; i += 1) {
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

  // Dash duration is 0.15s (~10 frames @ 60fps)
  for (let i = 0; i < 10; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Rogue should be stopped in front of the wall (z around -0.85 .. -1.25), never penetrating inside minZ..maxZ
  assert.ok(
    player.position.z > -1.3,
    `Player position z=${player.position.z} must stop before wall front face z=-1.3`,
  );
  assert.ok(
    player.position.z < -0.4,
    `Player position z=${player.position.z} must have dashed forward toward the wall`,
  );
});

test('Next step starts from the actual collision-resolved position', () => {
  // Wall placed at z = -1.5
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
  player.update(1 / 60, input as never, camera as never);

  // Advance through step 0 (24 frames = 0.40s)
  for (let i = 0; i < 24; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // When step 1 initiates at 0.40s, position must stay in front of the wall
  const stoppedZ = player.position.z;
  assert.ok(stoppedZ > -1.3, 'Player stopped in front of wall');

  // Advance into step 1 dash (5 frames)
  for (let i = 0; i < 5; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // The player did not teleport or penetrate the wall
  assert.ok(player.position.z > -1.3, 'Player remains safely in front of the wall during step 1');
  assert.ok(
    Math.abs(player.position.z - stoppedZ) < 0.1,
    'Player stayed at the collision boundary because obstacle is directly ahead',
  );
});

test('Damage occurs at measured animation contact timing (0.36s inStep), no damage before contact', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const enemy = { id: 'target', alive: true, position: new THREE.Vector3(0, 0, -1.5) };
  player.findAreaTargets = () => [enemy];

  const hitEvents: number[] = [];
  player.onAbilityHit = () => {
    hitEvents.push(currentFrame);
  };

  let currentFrame = 0;
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never); // Frame 0: activation (t=0.016s)

  // Frames 1-8 (t = 0.033s .. 0.150s): Dash surge phase. No damage!
  for (let f = 1; f <= 8; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(hitEvents.length, 0, 'No damage during dash surge');

  // Frames 9-20 (t = 0.167s .. 0.350s): Slice windup and swing acceleration. NO damage before contact!
  for (let f = 9; f <= 20; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(hitEvents.length, 0, 'No damage during slice windup before measured contact window');

  // Frame 21-22 (t = 0.367s >= 0.360s dashDuration + strikeContactTime): Strike connects!
  for (let f = 21; f <= 22; f += 1) {
    currentFrame = f;
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(hitEvents.length, 1, 'Hit lands precisely once the measured contact window is reached');
  assert.ok(hitEvents[0] >= 21, `Hit landed at frame ${hitEvents[0]}`);
});

test('Multiple enemies along dash path are damaged', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  const enemy1 = { id: 'e1', alive: true, position: new THREE.Vector3(0.3, 0, -1.0) };
  const enemy2 = { id: 'e2', alive: true, position: new THREE.Vector3(-0.3, 0, -2.0) };
  player.findAreaTargets = () => [enemy1, enemy2];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through step 0 strike contact (24 frames = 0.40s)
  for (let i = 0; i < 24; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 2, 'Both enemies along dash corridor must be struck');
  assert.ok(hitTargets.includes(enemy1));
  assert.ok(hitTargets.includes(enemy2));
});

test('Enemies outside dash path corridor are not damaged', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  // Path is along Z from 0 to -2.4, pathWidth is 1.3
  const lateralEnemy = { id: 'lateral', alive: true, position: new THREE.Vector3(2.5, 0, -1.2) };
  const behindEnemy = { id: 'behind', alive: true, position: new THREE.Vector3(0, 0, 2.5) };
  player.findAreaTargets = () => [lateralEnemy, behindEnemy];

  const hitTargets: unknown[] = [];
  player.onAbilityHit = (target) => {
    hitTargets.push(target);
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Advance through all 3 steps (80 frames = 1.33s)
  for (let i = 0; i < 80; i += 1) {
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

  // Advance through all 3 steps and recovery (85 frames = 1.41s)
  for (let i = 0; i < 85; i += 1) {
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

  for (let i = 0; i < 25; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  assert.equal(hitTargets.length, 0, 'Dead and elevated enemies must not be hit');
});

test('Isolated Line-of-Sight test: blocked by wall vs unobstructed vs outside corridor', () => {
  // Test scenario setup:
  // Rogue dashes along X=0 from (0,0,0) to (0,0,-2.4).
  // Wall is placed to the right of the path: minX: 0.48, maxX: 0.72, minZ: -1.5, maxZ: -0.9.
  // With BODY_RADIUS = 0.42, padded wall minX is 0.48 - 0.42 = 0.06 > 0, so the dash along X=0 is completely unobstructed!
  const wall = {
    kind: 'box',
    minX: 0.48,
    maxX: 0.72,
    minZ: -1.5,
    maxZ: -0.9,
    bottom: 0,
    top: 3,
  };

  // 1. Enemy A is at (1.0, 0, -1.2):
  // Inside path corridor (dist=1.0 <= pathWidth 1.3, u=0.5 in [0,1]).
  // BUT the wall sits between the dash path (X=0) and Enemy A (X=1.0).
  // Line of sight ray from (0, 1.2, -1.2) to (1.0, 1.2, -1.2) hits the wall at X in [0.48, 0.72]!
  const enemyBehindWall = { id: 'behindWall', alive: true, position: new THREE.Vector3(1.0, 0, -1.2) };

  // 2. Unobstructed Enemy B at (-0.8, 0, -1.2):
  // Inside path corridor on the unobstructed left side.
  const unobstructedEnemy = { id: 'unobstructed', alive: true, position: new THREE.Vector3(-0.8, 0, -1.2) };

  // 3. Out-of-path Enemy C at (2.5, 0, -1.2):
  // Outside path corridor (dist=2.5 > pathWidth 1.3).
  const outsideEnemy = { id: 'outside', alive: true, position: new THREE.Vector3(2.5, 0, -1.2) };

  const envWithWall = createTestEnvironment('rogue', [wall]);
  envWithWall.player.findAreaTargets = () => [enemyBehindWall, unobstructedEnemy, outsideEnemy];

  const hitResultsWithWall: unknown[] = [];
  envWithWall.player.onAbilityHit = (target) => {
    hitResultsWithWall.push(target);
  };

  envWithWall.input.abilityEdge = true;
  envWithWall.player.update(1 / 60, envWithWall.input as never, envWithWall.camera as never);

  // Advance through step 0 (24 frames = 0.40s)
  for (let i = 0; i < 24; i += 1) {
    envWithWall.player.update(1 / 60, envWithWall.input as never, envWithWall.camera as never);
  }

  // Verify: Rogue dashed full distance (unobstructed by wall)
  const distTraveled = envWithWall.player.position.distanceTo(new THREE.Vector3(0, 0, 0));
  assert.ok(distTraveled >= 2.3, `Rogue dashed full distance, dist=${distTraveled}`);
  // Verify: Enemy behind wall receives NO damage because of blocked LOS
  assert.ok(!hitResultsWithWall.includes(enemyBehindWall), 'Enemy behind wall was protected by line-of-sight obstruction');
  // Verify: Unobstructed enemy in corridor receives damage
  assert.ok(hitResultsWithWall.includes(unobstructedEnemy), 'Unobstructed enemy in corridor received damage');
  // Verify: Enemy outside corridor receives NO damage
  assert.ok(!hitResultsWithWall.includes(outsideEnemy), 'Enemy outside corridor received no damage');

  // 4. Now test removing the wall:
  // With no wall, Enemy A (who is genuinely in the path corridor) MUST receive damage!
  const envNoWall = createTestEnvironment('rogue', []);
  envNoWall.player.findAreaTargets = () => [enemyBehindWall];

  const hitResultsNoWall: unknown[] = [];
  envNoWall.player.onAbilityHit = (target) => {
    hitResultsNoWall.push(target);
  };

  envNoWall.input.abilityEdge = true;
  envNoWall.player.update(1 / 60, envNoWall.input as never, envNoWall.camera as never);

  for (let i = 0; i < 24; i += 1) {
    envNoWall.player.update(1 / 60, envNoWall.input as never, envNoWall.camera as never);
  }

  assert.ok(hitResultsNoWall.includes(enemyBehindWall), 'Removing the wall allows Enemy A to receive damage');
});

test('Cooldown behaviour and persistence across character switches', () => {
  const { player, camera, input } = createTestEnvironment('rogue');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.ok(player.currentAbilityCooldown > 6.9);

  // Cannot switch while ability is executing
  assert.equal(player.canSwitchCharacter, false);

  // Advance past total duration (1.38s, ~85 frames @ 60fps)
  for (let i = 0; i < 85; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.canSwitchCharacter, true);

  const cooldownAfterFinish = player.currentAbilityCooldown;
  assert.ok(cooldownAfterFinish > 5.4 && cooldownAfterFinish < 5.8);

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

  // Cooldown kept ticking in background (~3.4s - 3.8s left)
  const cooldownAfterSwap = player.currentAbilityCooldown;
  assert.ok(cooldownAfterSwap > 3.3 && cooldownAfterSwap < 3.8);

  // Advance remaining cooldown time (~230 frames = 3.83s)
  for (let i = 0; i < 230; i += 1) {
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

  // Advance into recovery phase (t >= 1.20s, 65 more frames puts t at 1.25s)
  for (let i = 0; i < 65; i += 1) {
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

  // Finish Shadowstep (85 frames)
  for (let i = 0; i < 85; i += 1) {
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
