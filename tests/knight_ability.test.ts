import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import { PROFILES, profileFor, KNIGHT_COUNTER_WINDOW_START, KNIGHT_COUNTER_WINDOW_END, KNIGHT_RIPOSTE_HIT } from '../src/play/movesets.ts';

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
    clipDuration: (): number => 1.067,
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

function createTestEnvironment(characterId: 'knight' | 'barbarian' | 'ranger' = 'knight') {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles: [] };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor(characterId));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();
  return { rig, world, player, camera, input };
}

test('Knight ability activation eligibility and animation triggering', () => {
  const { rig, player, camera, input } = createTestEnvironment('knight');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  // Trigger ability via input
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Melee_Block_Attack');
  assert.equal(player.currentAbilityCooldown, 6.0);

  // While ability is active, cannot start another ability or attack
  assert.equal(player.canStartAbility(), false);
});

test('Adventurers without ability cannot activate', () => {
  const { player, camera, input } = createTestEnvironment('barbarian');

  assert.equal(player.profile.ability, undefined);
  assert.equal(player.canStartAbility(), false);

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
});

test('Knight cooldown behaviour and persistence across character switches', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.ok(player.currentAbilityCooldown > 5.9);

  // Tick 1 second
  for (let i = 0; i < 60; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  const cooldownAfter1s = player.currentAbilityCooldown;
  assert.ok(cooldownAfter1s > 4.8 && cooldownAfter1s < 5.1);

  // Switch to Ranger
  const rangerRig = makeRig();
  player.replaceRig(rangerRig as never, profileFor('ranger'));
  assert.equal(player.profile.id, 'ranger');
  assert.equal(player.currentAbilityCooldown, 0); // Ranger has no ability cooldown

  // Advance time by 2 seconds while playing Ranger
  for (let i = 0; i < 120; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Switch back to Knight
  const knightRig2 = makeRig();
  player.replaceRig(knightRig2 as never, profileFor('knight'));
  assert.equal(player.profile.id, 'knight');

  // Knight's cooldown continued ticking down while swapped out! (~2.9s left)
  const cooldownAfterSwap = player.currentAbilityCooldown;
  assert.ok(cooldownAfterSwap > 2.8 && cooldownAfterSwap < 3.1);

  // Advance remaining time
  for (let i = 0; i < 190; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.currentAbilityCooldown, 0);
  assert.equal(player.canStartAbility(), true);
});

test('Counter success and damage negation within counter window (0.00-0.35s)', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  let counterSuccessAttacker: unknown = null;
  player.onCounterSuccess = (attacker) => {
    counterSuccessAttacker = attacker;
  };

  let riposteHitTarget: unknown = null;
  let riposteHitAbility: unknown = null;
  player.onAbilityHit = (target, ability) => {
    riposteHitTarget = target;
    riposteHitAbility = ability;
  };

  // Start Shield Counter
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCounterWindowActive, true);

  // Mock enemy
  const mockAttacker = { id: 'minion_1', alive: true, position: new THREE.Vector3(0, 0, -1.8) };

  // Advance 0.15s into counter window
  for (let i = 0; i < 9; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCounterWindowActive, true);

  // Enemy hits player with 30 damage
  const applied = player.takeDamage(30, mockAttacker.position, mockAttacker);
  assert.equal(applied, 0, 'Damage must be completely negated during valid counter window');
  assert.equal(player.health, 100, 'Player health must not decrease');
  assert.equal(counterSuccessAttacker, mockAttacker, 'Attacker must be identified');
  assert.equal(player.isCounterTriggered, true);

  // Advance until riposte strike frame (0.47s)
  // Total elapsed: ~0.166s so far, need ~0.31s more (~19 frames)
  for (let i = 0; i < 20; i += 1) player.update(1 / 60, input as never, camera as never);

  assert.equal(riposteHitTarget, mockAttacker, 'Riposte must target the countering attacker');
  assert.ok(riposteHitAbility !== null);
  assert.equal((riposteHitAbility as { damage: number }).damage, 48);
});

test('Counter timing boundaries: hits after 0.35s are not negated', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  const mockAttacker = { id: 'warrior_1', alive: true, position: new THREE.Vector3(0, 0, -2) };

  // Advance past the 0.35s counter window to 0.40s (~24 frames)
  for (let i = 0; i < 24; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isCounterWindowActive, false, 'Counter window should be closed at 0.40s');
  assert.equal(player.activeAbilityPhase, 'active');

  // Enemy strikes at 0.40s
  const applied = player.takeDamage(20, mockAttacker.position, mockAttacker);
  assert.equal(applied, 20, 'Hit after counter window must deal full damage');
  assert.equal(player.health, 80, 'Player health should decrease');
  assert.equal(player.isCounterTriggered, false, 'Counter should not be triggered');
});

test('Multiple attackers during one activation: prevents duplicate ripostes', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  let counterSuccessCount = 0;
  player.onCounterSuccess = () => {
    counterSuccessCount += 1;
  };

  let riposteHitCount = 0;
  let riposteTarget: unknown = null;
  player.onAbilityHit = (target) => {
    riposteHitCount += 1;
    riposteTarget = target;
  };

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  const enemyA = { id: 'enemy_a', alive: true, position: new THREE.Vector3(0, 0, -1.5) };
  const enemyB = { id: 'enemy_b', alive: true, position: new THREE.Vector3(1, 0, -1.5) };

  // Enemy A hits at t = 0.10s
  for (let i = 0; i < 6; i += 1) player.update(1 / 60, input as never, camera as never);
  const dmgA = player.takeDamage(25, enemyA.position, enemyA);
  assert.equal(dmgA, 0);
  assert.equal(counterSuccessCount, 1);

  // Enemy B hits at t = 0.20s
  for (let i = 0; i < 6; i += 1) player.update(1 / 60, input as never, camera as never);
  const dmgB = player.takeDamage(25, enemyB.position, enemyB);
  assert.equal(dmgB, 0, 'Second hit during counter window should also be negated');
  assert.equal(counterSuccessCount, 1, 'Counter success must not fire duplicates');

  // Advance through riposte hit (0.47s) and recovery to end of clip
  for (let i = 0; i < 60; i += 1) player.update(1 / 60, input as never, camera as never);

  assert.equal(riposteHitCount, 1, 'Exactly one riposte strike must be delivered');
  assert.equal(riposteTarget, enemyA, 'Initial countering attacker must be riposted');
});

test('Dead attacker handling: safely falls back to alive forward target or null', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  const enemyA = { id: 'enemy_a', alive: true, position: new THREE.Vector3(0, 0, -1.5) };
  const enemyB = { id: 'enemy_b', alive: true, position: new THREE.Vector3(0, 0, -2.0) };

  let riposteTarget: unknown = undefined;
  player.onAbilityHit = (target) => {
    riposteTarget = target;
  };

  player.findFallbackTarget = () => enemyB;

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Enemy A hits during counter window
  player.takeDamage(20, enemyA.position, enemyA);

  // Enemy A dies before riposte hit lands
  enemyA.alive = false;

  // Advance to riposte hit
  for (let i = 0; i < 30; i += 1) player.update(1 / 60, input as never, camera as never);

  // Riposte must NOT strike dead Enemy A, but safely hit fallback Enemy B
  assert.equal(riposteTarget, enemyB);
});

test('Character switching and interruption rules', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Cannot switch character while ability is active
  assert.equal(player.isAbilityActive, true);
  assert.equal(player.canSwitchCharacter, false);

  // Cannot dodge during startup / active phase
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);

  // Advance to recovery phase (t >= 0.55s, ~33 frames)
  for (let i = 0; i < 33; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.activeAbilityPhase, 'recovery');

  // Can dodge cancel out of recovery
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, true);
  assert.equal(player.isAbilityActive, false, 'Dodge must interrupt ability recovery');
});

test('Existing Knight moveset remains intact', () => {
  const { player, camera, input } = createTestEnvironment('knight');

  // Light attack works normally
  input.attackEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, true);
  assert.equal(player.attackingWith, PROFILES.knight.light.clip);

  // Advance through light attack and its cooldown (cooldown = 1.2s, 80 frames @ 60fps = 1.33s)
  for (let i = 0; i < 80; i += 1) player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, false);

  // Heavy attack works normally
  input.heavyEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isAttacking, true);
  assert.equal(player.attackingWith, PROFILES.knight.heavy.clip);
});
