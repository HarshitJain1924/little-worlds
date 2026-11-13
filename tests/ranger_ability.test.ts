import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Player } from '../src/play/player.ts';
import {
  PROFILES,
  profileFor,
  RANGER_VOLLEY_DRAW_DURATION,
  RANGER_VOLLEY_RELEASE_TIME,
  RANGER_VOLLEY_RELEASE_SWEEP,
  RANGER_VOLLEY_ACTIVE_END,
  RANGER_VOLLEY_DURATION,
  RANGER_ABILITY,
  KNIGHT_ABILITY,
  BARBARIAN_ABILITY,
  ROGUE_ABILITY,
} from '../src/play/movesets.ts';
import type { CameraObstacle } from '../src/play/collision.ts';
import type { Impact, ProjectileField, ProjectileTarget } from '../src/play/projectiles.ts';
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
  characterId: 'knight' | 'barbarian' | 'ranger' | 'rogue' | 'mage' = 'ranger',
  obstacles: unknown[] = [],
) {
  const rig = makeRig();
  const world = { heightAt: (): number => 0, blockers: [], obstacles };
  const player = new Player(rig as never, world as never, { x: 0, z: 0 }, profileFor(characterId));
  const camera = { forward: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, -1) };
  const input = makeInput();
  return { rig, world, player, camera, input };
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

function makePool(field: ProjectileField = { obstacles: [], heightAt: () => 0 }, capacity = 16): ProjectilePool {
  const scene = new THREE.Scene();
  const visual = {
    geometry: new THREE.BoxGeometry(0.08, 0.08, 1.26),
    material: new THREE.MeshBasicMaterial(),
  };
  return new ProjectilePool(
    scene,
    field,
    {
      arrow: visual,
      piercingArrow: visual,
      magicLight: visual,
      magicHeavy: visual,
    },
    capacity,
  );
}

const collect = (log: Impact[]): ((impact: Impact) => void) => (impact) => {
  log.push({ ...impact, position: impact.position.clone() });
};

test('Ranger ability activation and phase progression (startup, active, recovery, idle)', () => {
  const { rig, player, camera, input } = createTestEnvironment('ranger');

  assert.equal(player.canStartAbility(), true);
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(player.currentAbilityCooldown, 0);

  let shotsFired = 0;
  player.onAbilityRangedShot = (ability) => {
    shotsFired += 1;
    assert.equal(ability.kind, 'volley');
    assert.equal(ability.piercing, true);
    assert.equal(ability.damage, 60);
  };

  // Trigger Piercing Volley via input
  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  assert.equal(player.isAbilityActive, true);
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Ranged_Bow_Draw');
  assert.equal(player.currentAbilityCooldown, 8.0);
  assert.equal(player.canStartAbility(), false);
  assert.equal(player.currentAbility?.name, 'Piercing Volley');
  assert.equal(shotsFired, 0);

  // Advance time during draw preparation (< 0.32s)
  // 15 frames @ 60fps = 0.25s total
  for (let i = 0; i < 14; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'startup');
  assert.equal(rig.animator.playing, 'Ranged_Bow_Draw');
  assert.equal(shotsFired, 0);

  // Advance to t = 0.35s (exceeds drawDuration 0.32s): transitions to active phase, plays Ranged_Bow_Release
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'active');
  assert.equal(rig.animator.playing, 'Ranged_Bow_Release');

  // Advance to t = 0.55s (exceeds releaseTime 0.32s + 0.20s = 0.52s): onAbilityRangedShot fired
  for (let i = 0; i < 12; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(shotsFired, 1);

  // Advance to t = 0.70s: still in active follow-through sweep (activeEnd = 0.784s)
  for (let i = 0; i < 9; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'active');
  assert.equal(shotsFired, 1);

  // Advance past activeEnd (0.784s) to t = 0.816s: transitions to recovery phase
  for (let i = 0; i < 7; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'recovery');
  assert.equal(shotsFired, 1);

  // Advance to t = 0.90s (exceeds total duration 0.85s): returns to idle
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.activeAbilityPhase, 'idle');
  assert.equal(shotsFired, 1);
});

test('Ranger cooldown behaviour and persistence across character switches', () => {
  const { player, camera, input } = createTestEnvironment('ranger');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.ok(player.currentAbilityCooldown > 7.9);

  // During ability execution, switching character is prohibited
  assert.equal(player.canSwitchCharacter, false);

  // Advance until ability concludes (55 frames @ 60fps ~ 0.916s)
  for (let i = 0; i < 55; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.isAbilityActive, false);
  assert.equal(player.canSwitchCharacter, true);

  const cooldownAfterFinish = player.currentAbilityCooldown;
  assert.ok(cooldownAfterFinish > 6.9 && cooldownAfterFinish < 7.2);

  // Switch to Knight
  const knightRig = makeRig();
  player.replaceRig(knightRig as never, profileFor('knight'));
  assert.equal(player.profile.id, 'knight');
  assert.equal(player.currentAbilityCooldown, 0); // Knight ability hasn't been used yet

  // Advance time by 3 seconds while playing Knight
  for (let i = 0; i < 180; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }

  // Switch back to Ranger
  assert.equal(player.canSwitchCharacter, true);
  const rangerRig2 = makeRig();
  player.replaceRig(rangerRig2 as never, profileFor('ranger'));
  assert.equal(player.profile.id, 'ranger');

  // Cooldown should have decayed from ~7.0s down to ~4.0s
  assert.ok(
    player.currentAbilityCooldown > 3.8 && player.currentAbilityCooldown < 4.2,
    `cooldown was ${player.currentAbilityCooldown}`,
  );
});

test('Hyper-armour protects active release while startup and recovery are interruptible', () => {
  // Test 1: Hit during startup (< 0.32s) interrupts the ability
  {
    const { rig, player, camera, input } = createTestEnvironment('ranger');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);
    assert.equal(player.activeAbilityPhase, 'startup');

    // Take damage during startup
    player.takeDamage(10, new THREE.Vector3(0, 0, -2));
    assert.equal(player.isAbilityActive, false);
    assert.equal(player.activeAbilityPhase, 'idle');
    assert.equal(rig.animator.playing, 'Hit_A');
  }

  // Test 2: Hit during active phase (0.32s .. 0.784s) is resisted via hyper-armour even late in sweep (0.70s)
  {
    const { rig, player, camera, input } = createTestEnvironment('ranger');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);

    // Advance to late active follow-through sweep (0.70s)
    for (let i = 0; i < 42; i += 1) {
      player.update(1 / 60, input as never, camera as never);
    }
    assert.equal(player.activeAbilityPhase, 'active');

    // Take damage during active follow-through
    player.takeDamage(10, new THREE.Vector3(0, 0, -2));
    assert.equal(player.isAbilityActive, true);
    assert.equal(player.activeAbilityPhase, 'active');
    assert.notEqual(rig.animator.playing, 'Hit_A');
  }

  // Test 3: Hit during recovery phase (0.784s .. 0.85s) interrupts the ability
  {
    const { rig, player, camera, input } = createTestEnvironment('ranger');
    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);

    // Advance to recovery phase (0.80s, 48 frames)
    for (let i = 0; i < 48; i += 1) {
      player.update(1 / 60, input as never, camera as never);
    }
    assert.equal(player.activeAbilityPhase, 'recovery');

    // Take damage during recovery phase
    player.takeDamage(10, new THREE.Vector3(0, 0, -2));
    assert.equal(player.isAbilityActive, false);
    assert.equal(player.activeAbilityPhase, 'idle');
    assert.equal(rig.animator.playing, 'Hit_A');
  }
});

test('Dodge cancellation permitted during recovery phase', () => {
  const { player, camera, input } = createTestEnvironment('ranger');

  input.abilityEdge = true;
  player.update(1 / 60, input as never, camera as never);

  // Dodge during startup cannot interrupt
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, false);
  assert.equal(player.isAbilityActive, true);

  // Advance into late active follow-through (t = 0.70s): dodge cannot cancel
  for (let i = 0; i < 41; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'active');
  assert.equal(player.canStartDodge(), false);

  // Advance into recovery phase (t = 0.80s, 6 more frames)
  for (let i = 0; i < 6; i += 1) {
    player.update(1 / 60, input as never, camera as never);
  }
  assert.equal(player.activeAbilityPhase, 'recovery');
  assert.equal(player.canStartDodge(), true);

  // Dodge during recovery cancels remaining end-lag immediately
  input.dodgeEdge = true;
  player.update(1 / 60, input as never, camera as never);
  assert.equal(player.isDodging, true);
  assert.equal(player.isAbilityActive, false);
});

test('Piercing arrow penetrates multiple lined-up enemies in entry order', () => {
  const pool = makePool();
  const target1 = makeTarget(0, -4);
  const target2 = makeTarget(0, -8);
  const target3 = makeTarget(0, -12);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 40,
    damage: 60,
    maxRange: 55,
    kind: 'piercingArrow',
    piercing: true,
  });

  // 0.20s at 40 m/s is 8m travel: reaches target1 (-4m) and target2 (-8m)
  pool.update(0.2, [target1, target2, target3], collect(impacts));

  assert.equal(impacts.length, 2);
  assert.equal(impacts[0].target, target1);
  assert.equal(impacts[1].target, target2);
  assert.equal(target1.hits, 1);
  assert.equal(target1.damage, 60);
  assert.equal(target2.hits, 1);
  assert.equal(target2.damage, 60);
  assert.equal(target3.hits, 0);
  // Arrow is piercing so it is STILL active in flight!
  assert.equal(pool.activeCount, 1);

  // Next 0.20s travels another 8m (total 16m): reaches target3 (-12m)
  pool.update(0.2, [target1, target2, target3], collect(impacts));

  assert.equal(impacts.length, 3);
  assert.equal(impacts[2].target, target3);
  assert.equal(target3.hits, 1);
  assert.equal(target3.damage, 60);

  // Crucial: target1 and target2 must NOT be hit again
  assert.equal(target1.hits, 1);
  assert.equal(target2.hits, 1);
});

test('Piercing arrow does not hit the same enemy across consecutive frames', () => {
  const pool = makePool();
  const target = makeTarget(0, -5);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 10,
    damage: 60,
    maxRange: 50,
    kind: 'piercingArrow',
    piercing: true,
  });

  // Step 1: reaches target (travels 6m, target is at 5m)
  pool.update(0.6, [target], collect(impacts));
  assert.equal(target.hits, 1);
  assert.equal(impacts.length, 1);

  // Step 2: arrow continues flying past target (travels another 4m)
  pool.update(0.4, [target], collect(impacts));
  assert.equal(target.hits, 1);
  assert.equal(impacts.length, 1);

  // Step 3: arrow continues flying
  pool.update(0.4, [target], collect(impacts));
  assert.equal(target.hits, 1);
  assert.equal(impacts.length, 1);
});

test('Dead and vertically out-of-range targets are ignored by piercing arrow', () => {
  const pool = makePool();
  const deadTarget = makeTarget(0, -4);
  deadTarget.alive = false;

  // High target: player fires at y=1, high target sits at y=10 (well above cylinder top)
  const highTarget = makeTarget(0, -8, 10);
  const validTarget = makeTarget(0, -12);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 50,
    damage: 60,
    maxRange: 50,
    kind: 'piercingArrow',
    piercing: true,
  });

  pool.update(0.4, [deadTarget, highTarget, validTarget], collect(impacts));

  assert.equal(deadTarget.hits, 0);
  assert.equal(highTarget.hits, 0);
  assert.equal(validTarget.hits, 1);
  assert.equal(validTarget.damage, 60);
});

test('Obstacle stops piercing arrow and protects enemies behind it', () => {
  const wall: CameraObstacle = {
    kind: 'box',
    minX: -5,
    maxX: 5,
    minY: -1,
    maxY: 4,
    minZ: -9.5,
    maxZ: -8.5,
  };
  const pool = makePool({ obstacles: [wall], heightAt: () => 0 });

  const targetInFront = makeTarget(0, -5);
  const targetBehindWall = makeTarget(0, -13);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 50,
    damage: 60,
    maxRange: 55,
    kind: 'piercingArrow',
    piercing: true,
  });

  // Travels 20m forward (past the wall at -8.5m)
  pool.update(0.4, [targetInFront, targetBehindWall], collect(impacts));

  // Target in front of wall is hit
  assert.equal(targetInFront.hits, 1);
  assert.equal(targetInFront.damage, 60);

  // Target behind wall is protected: wall blocks the piercing projectile
  assert.equal(targetBehindWall.hits, 0);
  assert.equal(targetBehindWall.damage, 0);

  // Wall blocked and retired the arrow
  assert.equal(pool.activeCount, 0);
  const wallImpact = impacts.find((imp) => imp.kind === 'obstacle');
  assert.ok(wallImpact, 'wall impact was reported');
});

test('Terrain ground blocks and retires piercing arrow', () => {
  const pool = makePool();
  const targetBeyondGround = makeTarget(0, -10);
  const impacts: Impact[] = [];

  // Arrow fires from y=2, pitched downward towards ground (reaches ground at y=0, z=-4)
  const dir = new THREE.Vector3(0, -0.5, -1).normalize();

  pool.spawn({
    origin: new THREE.Vector3(0, 2, 0),
    direction: dir,
    speed: 20,
    damage: 60,
    maxRange: 50,
    kind: 'piercingArrow',
    piercing: true,
  });

  // Advance flight so arrow reaches the ground (travel distance ~4.5m, time 0.3s)
  pool.update(0.3, [targetBeyondGround], collect(impacts));

  // Ground stopped the arrow
  assert.equal(targetBeyondGround.hits, 0);
  assert.equal(pool.activeCount, 0);
  const groundImpact = impacts.find((imp) => imp.kind === 'ground');
  assert.ok(groundImpact, 'ground impact was reported');
  assert.ok(groundImpact.position.y <= 0.05, `ground impact y=${groundImpact.position.y}`);
});

test('Ranger basic light and heavy attacks remain intact and do not pierce', () => {
  const { player } = createTestEnvironment('ranger');
  const light = player.profile.light;
  const heavy = player.profile.heavy;

  assert.equal(light.ranged?.speed, 34);
  assert.equal(light.ranged?.maxRange, 40);
  assert.equal(heavy.ranged?.speed, 58);
  assert.equal(heavy.ranged?.maxRange, 55);

  // Normal arrow stops on first body hit
  const pool = makePool();
  const target1 = makeTarget(0, -4);
  const target2 = makeTarget(0, -8);
  const impacts: Impact[] = [];

  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 34,
    damage: 18,
    maxRange: 40,
    kind: 'arrow',
  });

  // Travels 10m: hits target1 and stops
  pool.update(0.3, [target1, target2], collect(impacts));

  assert.equal(target1.hits, 1);
  assert.equal(target2.hits, 0);
  // Non-piercing arrow retired upon hitting first body
  assert.equal(pool.activeCount, 0);
});

test('Regression check: Knight, Barbarian, and Rogue signature abilities remain fully functional', () => {
  // Knight Shield Counter
  const knightEnv = createTestEnvironment('knight');
  assert.equal(knightEnv.player.profile.ability?.kind, 'counter');
  knightEnv.input.abilityEdge = true;
  knightEnv.player.update(1 / 60, knightEnv.input as never, knightEnv.camera as never);
  assert.equal(knightEnv.player.isAbilityActive, true);
  assert.equal(knightEnv.player.currentAbility?.name, 'Shield Counter');

  // Barbarian Whirlwind
  const barbEnv = createTestEnvironment('barbarian');
  assert.equal(barbEnv.player.profile.ability?.kind, 'whirlwind');
  barbEnv.input.abilityEdge = true;
  barbEnv.player.update(1 / 60, barbEnv.input as never, barbEnv.camera as never);
  assert.equal(barbEnv.player.isAbilityActive, true);
  assert.equal(barbEnv.player.currentAbility?.name, 'Whirlwind');

  // Rogue Shadowstep
  const rogueEnv = createTestEnvironment('rogue');
  assert.equal(rogueEnv.player.profile.ability?.kind, 'shadowstep');
  rogueEnv.input.abilityEdge = true;
  rogueEnv.player.update(1 / 60, rogueEnv.input as never, rogueEnv.camera as never);
  assert.equal(rogueEnv.player.isAbilityActive, true);
  assert.equal(rogueEnv.player.currentAbility?.name, 'Shadowstep');
});

test('Projectile pool exhaustion and recycling for piercing arrows', () => {
  const pool = makePool(FLAT, 2);
  const targetA = makeTarget(0, -6);
  const targetB = makeTarget(0, -12);
  const impacts: Impact[] = [];

  // Spawn 1st piercing arrow: travels at 20 m/s
  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 20,
    damage: 60,
    maxRange: 55,
    kind: 'piercingArrow',
    piercing: true,
  });

  // Advance time so slot 0 hits targetA and travels past to z = -10
  pool.update(0.5, [targetA, targetB], collect(impacts));
  assert.equal(targetA.hits, 1);
  assert.equal(pool.activeCount, 1);

  // Spawn 2nd piercing arrow: pool is now completely full (2/2 active slots)
  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 10,
    damage: 60,
    maxRange: 55,
    kind: 'piercingArrow',
    piercing: true,
  });
  assert.equal(pool.activeCount, 2);

  // Step simulation: slot 0 has travelled 15m, slot 1 has travelled 5m
  pool.update(0.25, [targetA, targetB], collect(impacts));

  const slots = (pool as unknown as {
    arrows: {
      meshes: Map<string, THREE.Mesh>;
      activeMesh: THREE.Mesh | null;
      hitTargets: Set<unknown>;
      kind: string;
      travelled: number;
    }[];
  }).arrows;

  assert.equal(slots[0].activeMesh, slots[0].meshes.get('piercingArrow'));
  assert.equal(slots[0].meshes.get('piercingArrow')!.visible, true);
  assert.equal(slots[0].hitTargets.has(targetA), true);

  // Spawn 3rd projectile with kind 'piercingArrow' when pool is full.
  // Must recycle farthest active slot (slot 0).
  const spawned = pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 30,
    damage: 60,
    maxRange: 55,
    kind: 'piercingArrow',
    piercing: true,
  });
  assert.equal(spawned, true, 'pool recycling succeeds when exhausted');
  assert.equal(pool.activeCount, 2, 'active count remains at capacity');

  // Verify that slot 0's hitTargets was cleared on recycling so it doesn't remember old hits
  assert.equal(slots[0].hitTargets.size, 0, 'recycled slot clears previous hitTargets');
  assert.equal(slots[0].travelled, 0, 'recycled slot resets travelled distance');

  // Next update: the recycled arrow flies toward targetA and damages it again!
  pool.update(0.3, [targetA, targetB], collect(impacts));
  assert.equal(targetA.hits, 2, 'recycled slot successfully hits targetA without being suppressed');

  // Now test cross-kind recycling when exhausted: spawn a normal 'arrow' in slot 0 or 1
  pool.spawn({
    origin: new THREE.Vector3(0, 1, 0),
    direction: new THREE.Vector3(0, 0, -1),
    speed: 34,
    damage: 18,
    maxRange: 40,
    kind: 'arrow',
  });

  // Verify that the recycled slot hides the piercingArrow mesh and shows the normal arrow mesh
  const recycled = slots.find((s) => s.kind === 'arrow');
  assert.ok(recycled, 'slot converted to normal arrow');
  assert.equal(recycled.meshes.get('piercingArrow')!.visible, false, 'piercing mesh hidden');
  assert.equal(recycled.meshes.get('arrow')!.visible, true, 'normal arrow mesh visible');
});

test('Piercing Volley aim solution: camera crosshair, muzzle offset, and target lock alignment', () => {
  // Test 1: Ranger aim facing during draw preparation tracks camera aim
  {
    const { player, input } = createTestEnvironment('ranger');
    const cameraLook = new THREE.Vector3(1, 0, 0); // camera looking East (+X)
    const camera = { forward: (out: THREE.Vector3) => out.copy(cameraLook) };

    input.abilityEdge = true;
    player.update(1 / 60, input as never, camera as never);

    // Initial facing should align with camera forward (+X, yaw = Math.PI / 2)
    assert.ok(Math.abs(player.yaw - Math.PI / 2) < 0.1, `yaw was ${player.yaw}`);

    // Camera shifts to look North-East
    const newCameraLook = new THREE.Vector3(1, 0, -1).normalize();
    const cameraNE = { forward: (out: THREE.Vector3) => out.copy(newCameraLook) };
    const targetYaw = Math.atan2(newCameraLook.x, newCameraLook.z);

    // During draw preparation, updateLocomotion turns toward camera aim
    for (let i = 0; i < 15; i += 1) {
      player.update(1 / 60, input as never, cameraNE as never);
    }
    assert.ok(
      Math.abs(player.yaw - targetYaw) < 0.15,
      `yaw ${player.yaw} tracked camera target ${targetYaw}`,
    );
  }

  // Test 2: Locked-on target aim direction
  {
    const target = makeTarget(5, -10, 0);
    const muzzle = new THREE.Vector3(0, 1.4, 0);
    const chestTarget = new THREE.Vector3(target.position.x, target.position.y + 1.05, target.position.z);
    const toTarget = chestTarget.clone().sub(muzzle).normalize();
    const aimPoint = new THREE.Vector3();

    const solution = solveShot(muzzle, toTarget, FLAT, [target], RANGER_ABILITY.maxRange, aimPoint);
    assert.equal(solution.kind, 'enemy');
    assert.equal(solution.target, target);
    assert.ok(solution.distance < 12);
    assert.ok(aimPoint.distanceTo(chestTarget) < 0.65, 'aimPoint lands on outer cylinder entry surface');
  }

  // Test 3: Free-aim third-person shoulder camera parallax convergence
  {
    const wall: CameraObstacle = {
      kind: 'box',
      minX: -10,
      maxX: 10,
      minY: 0,
      maxY: 6,
      minZ: -21,
      maxZ: -19,
    };
    const worldWithWall: ProjectileField = { obstacles: [wall], heightAt: () => 0 };

    // Camera at right shoulder, looking forward at wall
    const cameraPos = new THREE.Vector3(1.2, 1.8, 4.0);
    const aimCamera = new THREE.Vector3(0, 0, -1);
    const playerPos = new THREE.Vector3(0, 0, 0);
    const muzzle = new THREE.Vector3(-0.25, 1.35, 0); // left bow hand
    const maxRange = RANGER_ABILITY.maxRange;

    // Ray from player depth along camera sightline (mimics solvePlayerAim in main.ts)
    const depth =
      (playerPos.x - cameraPos.x) * aimCamera.x +
      (playerPos.y + 1.45 - cameraPos.y) * aimCamera.y +
      (playerPos.z - cameraPos.z) * aimCamera.z;
    const cameraRay = cameraPos.clone().addScaledVector(aimCamera, Math.max(0, depth));

    const aimReference = new THREE.Vector3();
    const camSolution = solveShot(cameraRay, aimCamera, worldWithWall, [], maxRange, aimReference);
    assert.equal(camSolution.kind, 'obstacle');
    assert.ok(Math.abs(aimReference.z + 19) < 0.05);

    // Muzzle shot direction converges on the crosshair impact point
    const shotDirection = aimReference.clone().sub(muzzle).normalize();
    const shotOrigin = muzzle.clone().addScaledVector(shotDirection, 0.4);
    const shotHit = new THREE.Vector3();
    const shotSolution = solveShot(shotOrigin, shotDirection, worldWithWall, [], maxRange, shotHit);

    assert.equal(shotSolution.kind, 'obstacle');
    assert.ok(Math.abs(shotHit.x - aimReference.x) < 1e-3, 'shot converges on crosshair X');
    assert.ok(Math.abs(shotHit.y - aimReference.y) < 1e-3, 'shot converges on crosshair Y');
    assert.ok(Math.abs(shotHit.z - aimReference.z) < 1e-3, 'shot converges on crosshair Z');

    // Spawn piercing arrow along this resolved direction and verify it hits the wall
    const pool = makePool(worldWithWall);
    const impacts: Impact[] = [];
    pool.spawn({
      origin: shotOrigin,
      direction: shotDirection,
      speed: RANGER_ABILITY.speed,
      damage: RANGER_ABILITY.damage,
      maxRange: RANGER_ABILITY.maxRange,
      kind: 'piercingArrow',
      piercing: true,
    });

    pool.update(0.4, [], collect(impacts));
    assert.equal(impacts.length, 1);
    assert.equal(impacts[0].kind, 'obstacle');
    assert.ok(Math.abs(impacts[0].position.z + 19) < 0.1);
  }
});
