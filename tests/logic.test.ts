import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { ThirdPersonCamera } from '../src/play/camera.ts';
import type { CameraObstacle } from '../src/play/collision.ts';
import { hasLineOfSight, nearestObstruction, segmentBoxEntry, segmentCylinderEntry } from '../src/play/collision.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { ASSETS, CLIP_SOURCES } from '../src/play/models.ts';
import { PROFILES, profileFor } from '../src/play/movesets.ts';

interface GltfChunk {
  nodes: { name: string }[];
  skins?: { joints: number[] }[];
  accessors?: { bufferView: number; byteOffset?: number; count: number }[];
  bufferViews?: { byteOffset?: number }[];
  animations?: {
    name: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { output: number }[];
  }[];
}

/** Reads the JSON and binary chunks of a .glb straight off disk, without a renderer. */
function readGlb(path: string): { gltf: GltfChunk; bin: Buffer } {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength)) as GltfChunk;
  const offset = 20 + jsonLength;
  return { gltf, bin: buffer.subarray(offset + 8, offset + 8 + buffer.readUInt32LE(offset)) };
}

function readGltf(path: string): GltfChunk {
  return readGlb(path).gltf;
}

function gltfClipNames(path: string): string[] {
  return (readGltf(path).animations ?? []).map((animation) => animation.name);
}

function gltfJointNames(path: string): string[] {
  const gltf = readGltf(path);
  return (gltf.skins?.[0]?.joints ?? []).map((index) => gltf.nodes[index].name).sort();
}

const ANIM_DIR = 'public/rpg/anims';
import { ADVENTURERS, findAdventurer } from '../src/play/roster.ts';
import { TargetTracker, scoreTarget } from '../src/play/targeting.ts';
import type { TargetScoring } from '../src/play/targeting.ts';

const makeScoring = (): TargetScoring => ({
  player: { x: 0, y: 0, z: 0 },
  cameraForward: { x: 0, z: -1 },
  playerForward: { x: 0, z: -1 },
  maxRange: 15,
  maxAngle: Math.PI * 0.55,
});

let scoring = makeScoring();

const target = (x: number, z: number, alive = true) => ({ position: { x, y: 0, z }, alive });

test('box segment entry finds the near wall and ignores paths above it', () => {
  const box = { kind: 'box' as const, minX: -2, maxX: 2, minZ: 3, maxZ: 4, bottom: 0, top: 4 };

  const entry = segmentBoxEntry(0, 1, 0, 0, 1, 10, box);
  assert.ok(Math.abs(entry - 0.3) < 1e-6, `expected 0.3, got ${entry}`);

  // Above the wall: length runs over the top.
  assert.equal(segmentBoxEntry(0, 6, 0, 0, 6, 10, box), 1);

  // Parallel and outside: never enters.
  assert.equal(segmentBoxEntry(9, 1, 0, 9, 1, 10, box), 1);
});

test('cylinder entry respects trunk radius and height', () => {
  const trunk = { kind: 'cylinder' as const, x: 0, z: 5, radius: 0.5, bottom: 0, top: 6 };

  const entry = segmentCylinderEntry(0, 2, 0, 0, 2, 10, trunk);
  assert.ok(entry > 0.4 && entry < 0.5, `expected ~0.45, got ${entry}`);

  // Passing above the trunk clears it.
  assert.equal(segmentCylinderEntry(0, 8, 0, 0, 8, 10, trunk), 1);

  // Missing sideways clears it.
  assert.equal(segmentCylinderEntry(5, 2, 0, 5, 2, 10, trunk), 1);
});

test('nearest obstruction and line of sight use the nearest proxy', () => {
  const obstacles: CameraObstacle[] = [
    { kind: 'box', minX: -1, maxX: 1, minZ: 4, maxZ: 5, bottom: 0, top: 4 },
    { kind: 'cylinder', x: 0, z: 2, radius: 0.4, bottom: 0, top: 4 },
  ];

  const nearest = nearestObstruction(0, 1, 0, 0, 1, 10, obstacles);
  assert.ok(nearest < 0.25, `expected the trunk first, got ${nearest}`);
  assert.equal(hasLineOfSight(0, 1, 0, 0, 1, 10, obstacles), false);
  assert.equal(hasLineOfSight(0, 1, 0, 0, 1, 1, obstacles), true);
});

test('target scoring prefers close, visible targets in front of the camera', () => {
  scoring = makeScoring();
  const near = scoreTarget(target(0, -4), scoring, true);
  const far = scoreTarget(target(0, -12), scoring, true);
  const behind = scoreTarget(target(0, 6), scoring, true);
  const hidden = scoreTarget(target(0, -4), scoring, false);

  assert.ok(near > far, 'closer target should score higher');
  assert.equal(behind, -1, 'targets behind the camera are rejected');
  assert.ok(near > hidden, 'visible target should beat a hidden one');
  assert.equal(scoreTarget({ ...target(0, -4), alive: false }, scoring, true), -1);
  assert.equal(scoreTarget(target(0, -20), scoring, true), -1, 'out of range is rejected');
});

test('tracker selects the best target, re-ranks after a death, and releases a distant lock', () => {
  scoring = makeScoring();
  const a = target(0, -4);
  const b = target(3, -9);
  const tracker = new TargetTracker({
    maxRange: 15,
    releaseRange: 20,
    maxAngle: Math.PI * 0.6,
    perceptionInterval: 0.2,
    isVisible: () => true,
  });

  tracker.register(a);
  tracker.register(b);

  tracker.update(scoring, 0.25);
  assert.equal(tracker.soft, a);

  tracker.toggleLock(scoring);
  assert.equal(tracker.locked, a);

  a.alive = false;
  tracker.update(scoring, 0.25);
  assert.equal(tracker.locked, null, 'dead target releases the lock');
  assert.equal(tracker.soft, b);

  tracker.toggleLock(scoring);
  assert.equal(tracker.locked, b);

  // Walk far enough away that the lock must break.
  scoring.player = { x: 0, y: 0, z: 40 };
  tracker.update(scoring, 0.25);
  assert.equal(tracker.locked, null);
});

test('switching targets cycles through ranked candidates', () => {
  scoring = makeScoring();
  const tracker = new TargetTracker({ maxRange: 15, perceptionInterval: 0.2, isVisible: () => true });
  const near = target(0, -3);
  const mid = target(1, -6);
  const far = target(2, -9);
  tracker.register(near);
  tracker.register(mid);
  tracker.register(far);

  tracker.update(scoring, 0.25);
  assert.equal(tracker.toggleLock(scoring), near);

  const switched = tracker.cycle(scoring);
  assert.ok(switched === mid || switched === far);
  assert.notEqual(switched, near);
});

test('a brief loss of sight does not break the lock, a long one does', () => {
  scoring = makeScoring();
  let visible = true;
  const tracker = new TargetTracker({
    maxRange: 15,
    releaseRange: 20,
    perceptionInterval: 0.2,
    lostSightGrace: 0.5,
    isVisible: () => visible,
  });
  const enemy = target(0, -5);
  tracker.register(enemy);

  tracker.update(scoring, 0.25);
  tracker.toggleLock(scoring);

  visible = false;
  tracker.update(scoring, 0.2);
  assert.equal(tracker.locked, enemy, 'grace period keeps the lock');

  tracker.update(scoring, 0.4);
  assert.equal(tracker.locked, null, 'sustained occlusion releases');
});

test('camera yaw follows mouse input and pitch stays clamped', () => {
  const camera = new ThirdPersonCamera(1.6);
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.3);
  camera.rotate(100, 0);
  camera.update(1, player);
  assert.ok(Math.abs(camera.yaw + 0.26) < 0.02, `yaw ${camera.yaw}`);

  camera.rotate(0, 100000);
  camera.update(1, player);
  assert.ok(camera.pitch <= camera.bounds.maxPitch + 1e-6);
  assert.ok(Math.abs(camera.pitch - camera.bounds.maxPitch) < 0.01);

  camera.rotate(0, -100000);
  camera.update(1, player);
  assert.ok(Math.abs(camera.pitch - camera.bounds.minPitch) < 0.01);
});

test('camera boom pulls in for an obstruction and eases back out', () => {
  const obstacles: CameraObstacle[] = [];
  const camera = new ThirdPersonCamera(1.6, { obstacles, heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.25);
  camera.update(0.016, player);
  const free = camera.distance;
  assert.ok(free > 6, `expected a long open boom, got ${free}`);

  obstacles.push({ kind: 'box', minX: -3, maxX: 3, minZ: 3.5, maxZ: 5, bottom: 0, top: 6 });
  camera.update(0.016, player);
  const blocked = camera.distance;
  assert.ok(blocked < free - 1, `obstruction should shorten the boom: ${blocked} vs ${free}`);

  obstacles.length = 0;
  for (let i = 0; i < 180; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance > blocked + 1, 'boom should recover once clear');
});

test('aim camera eases to a shoulder frame and preserves boom collision', () => {
  const obstacles: CameraObstacle[] = [];
  const camera = new ThirdPersonCamera(1.6, { obstacles, heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.25);
  camera.update(0.016, player);
  const normal = camera.distance;
  const normalX = camera.camera.position.x;
  camera.setAiming(true);
  for (let i = 0; i < 90; i += 1) camera.update(0.016, player);
  assert.ok(camera.aimAmount > 0.98);
  assert.ok(camera.distance <= normal + 0.1, 'aim should retain a readable gameplay distance');
  assert.ok(camera.camera.position.x > normalX + 0.8, 'aim should move to the right shoulder');

  obstacles.push({ kind: 'box', minX: -6, maxX: 6, minZ: -1, maxZ: 6, bottom: 0, top: 6 });
  camera.update(0.016, player);
  assert.ok(camera.distance < 6, 'aim boom still respects cover');

  camera.setAiming(false);
  for (let i = 0; i < 120; i += 1) camera.update(0.016, player);
  assert.ok(camera.aimAmount < 0.02);
});

test('locked camera frames the player from behind toward the target', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.3);
  camera.setLockTarget({ x: 0, z: 10 });

  for (let i = 0; i < 90; i += 1) camera.update(0.016, player);

  // Camera sits on the -z side so its forward points at the enemy (+z).
  assert.ok(Math.abs(Math.abs(camera.yaw) - Math.PI) < 0.05, `yaw ${camera.yaw}`);
  const forward = camera.forward(new THREE.Vector3());
  assert.ok(forward.z > 0.95, `forward ${forward.toArray().join(',')}`);
});

test('backpedalling never recenters the camera behind the player', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.32);
  const startYaw = camera.yaw;

  // At yaw 0 the camera looks along -z, so +z velocity is walking backwards.
  // Following that travel would point the camera into its own view and loop.
  for (let i = 0; i < 240; i += 1) camera.update(1 / 60, player, { x: 0, z: 1 });

  assert.ok(
    Math.abs(camera.yaw - startYaw) < 0.01,
    `backpedalling rotated the camera to ${camera.yaw.toFixed(3)}`,
  );
  assert.ok(Math.abs(camera.targetYaw - startYaw) < 0.01, 'target yaw drifted too');
});

test('recentering still follows forward/ diagonal travel', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  camera.snap(0, 0.32);

  // 45 degrees off the view direction, inside the recenter cone.
  for (let i = 0; i < 240; i += 1) camera.update(1 / 60, player, { x: 0.7, z: -0.7 });

  assert.ok(camera.yaw < -0.2, `expected the camera to drift, got ${camera.yaw.toFixed(3)}`);
});

test('wheel zoom stays inside its limits', () => {
  const camera = new ThirdPersonCamera(1.6, { heightAt: () => 0 });
  const player = new THREE.Vector3(0, 0, 0);

  for (let i = 0; i < 40; i += 1) camera.zoom(1);
  for (let i = 0; i < 200; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance <= camera.bounds.maxDistance + 0.01);

  for (let i = 0; i < 80; i += 1) camera.zoom(-1);
  for (let i = 0; i < 200; i += 1) camera.update(0.016, player);
  assert.ok(camera.distance >= 1.0);
});

test('the roster offers five adventurers whose models and weapons are on disk', () => {
  assert.equal(ADVENTURERS.length, 5);
  assert.deepEqual(
    ADVENTURERS.map((entry) => entry.id),
    ['knight', 'barbarian', 'rogue', 'mage', 'ranger'],
  );

  // Keys and chips must be distinguishable, and lookup must round-trip.
  assert.equal(new Set(ADVENTURERS.map((entry) => entry.key)).size, 5);
  assert.equal(new Set(ADVENTURERS.map((entry) => entry.mark)).size, 5);
  for (const entry of ADVENTURERS) assert.equal(findAdventurer(entry.id), entry);

  // Every character resolves to its own model file, and every weapon to a real
  // asset path: a missing copy shows up here rather than as a blank model.
  const models = ADVENTURERS.map((entry) => ASSETS[entry.id]);
  assert.equal(new Set(models).size, 5);
  for (const model of models) {
    // Assets are served from public/, which is the runtime root.
    const path = `public/${model.replace('./', '')}`;
    assert.ok(existsSync(path), `missing character model: ${path}`);
  }

  for (const entry of ADVENTURERS) {
    assert.ok(entry.weapons.length > 0, `${entry.id} has no weapon`);
    for (const weapon of entry.weapons) assert.ok(weapon.asset && weapon.socket);
  }
});

test('the Knight profile is the untouched baseline', () => {
  const knight = profileFor('knight');

  assert.equal(knight.light.clip, 'Melee_1H_Attack_Slice_Diagonal');
  assert.equal(knight.light.damage, 26);
  assert.equal(knight.light.hitStart, 0.39);
  assert.equal(knight.light.hitEnd, 0.46);
  assert.equal(knight.light.timeScale, 1.15);
  assert.equal(knight.light.cooldown, 1.2);
  assert.equal(knight.light.recovery, undefined, 'Knight must keep its authored tail');

  assert.equal(knight.heavy.clip, 'Melee_1H_Attack_Chop');
  assert.equal(knight.heavy.damage, 44);
  assert.equal(knight.heavy.hitStart, 0.58);
  assert.equal(knight.heavy.armored, true);

  // Knight's guard values are the pre-M7 block numbers.
  assert.equal(knight.guard?.clip, 'Melee_Blocking');
  assert.equal(knight.guard?.damageScale, 0.25);
  assert.equal(knight.guard?.moveScale, 0.4);
});

test('melee identities differ in timing, reach and defence', () => {
  const { knight, barbarian, rogue } = PROFILES;

  // Barbarian: slower, wider, harder, and a brace instead of a shield.
  assert.equal(barbarian.light.clip, 'Melee_2H_Attack_Slice');
  assert.ok(barbarian.light.damage > knight.light.damage);
  assert.ok(barbarian.light.cooldown > knight.light.cooldown);
  assert.ok(barbarian.light.range > knight.light.range);
  assert.ok(barbarian.light.arc > knight.light.arc, 'two-hander sweeps wider');
  // Compare real seconds to contact, not authored clip time: the Knight plays
  // its clip at 1.15x, the Barbarian at 1x.
  assert.ok(
    barbarian.light.hitStart / barbarian.light.timeScale > knight.light.hitStart / knight.light.timeScale,
    'slower to connect',
  );
  assert.equal(barbarian.heavy.armored, true);
  assert.ok((barbarian.guard?.damageScale ?? 0) > (knight.guard?.damageScale ?? 0), 'brace stops less');
  assert.notEqual(barbarian.guard?.clip, knight.guard?.clip);

  // Rogue: quick, short, alternating, and no block at all.
  assert.equal(rogue.guard, null);
  assert.equal(rogue.lightAlt?.clip, 'Melee_Dualwield_Attack_Slice');
  assert.notEqual(rogue.lightAlt?.clip, rogue.light.clip);
  assert.ok(rogue.light.damage < knight.light.damage);
  assert.ok(rogue.light.cooldown < knight.light.cooldown);
  assert.ok(rogue.light.range < knight.light.range);
  assert.ok((rogue.light.recovery ?? 1) < (barbarian.light.recovery ?? 1), 'rogue releases sooner');
  assert.ok(rogue.heavy.damage > rogue.light.damage, 'heavy is a real commitment');

  // The alternation must be a different swing, not the same clip twice.
  assert.equal(profileFor('rogue'), rogue);
  // The Mage has its own moveset in M7.4.
  assert.equal(profileFor('mage').id, 'mage');
  // The Ranger has its own bow profile since M7.3.
  assert.equal(profileFor('ranger').id, 'ranger');
});

test('every clip a moveset references ships in the animation set', () => {
  const clips = new Set<string>();
  for (const file of readdirSync(ANIM_DIR)) {
    if (file.endsWith('.glb')) for (const name of gltfClipNames(`${ANIM_DIR}/${file}`)) clips.add(name);
  }

  for (const profile of Object.values(PROFILES)) {
    const used = [
      profile.light.clip,
      profile.lightAlt?.clip,
      profile.heavy.clip,
      profile.guard?.clip,
      profile.guard?.hitClip,
      profile.aim?.clip,
      profile.ability?.clip,
    ].filter(
      (name): name is string => typeof name === 'string',
    );
    for (const clip of used) assert.ok(clips.has(clip), `${profile.id} references missing clip ${clip}`);
  }
});

test('the ranged animation library ships with Castle-combat clips', () => {
  const path = `${ANIM_DIR}/Rig_Medium_CombatRanged.glb`;
  assert.ok(existsSync(path), 'ranged clip set missing from the production asset tree');

  const clips = gltfClipNames(path);
  const required = [
    // Ranger
    'Ranged_Bow_Draw',
    'Ranged_Bow_Draw_Up',
    'Ranged_Bow_Aiming_Idle',
    'Ranged_Bow_Idle',
    'Ranged_Bow_Release',
    'Ranged_Bow_Release_Up',
    'Ranged_1H_Aiming',
    'Ranged_1H_Shoot',
    'Ranged_1H_Shooting',
    'Ranged_1H_Reload',
    'Ranged_2H_Aiming',
    'Ranged_2H_Shoot',
    'Ranged_2H_Shooting',
    'Ranged_2H_Reload',
    // Mage
    'Ranged_Magic_Spellcasting',
    'Ranged_Magic_Spellcasting_Long',
    'Ranged_Magic_Shoot',
    'Ranged_Magic_Raise',
    'Ranged_Magic_Summon',
  ];
  for (const name of required) assert.ok(clips.includes(name), `ranged set is missing ${name}`);

  // "Running while holding a bow" comes from the movement set, not this one.
  const movement = gltfClipNames(`${ANIM_DIR}/Rig_Medium_MovementAdvanced.glb`);
  assert.ok(movement.includes('Running_HoldingBow'), 'bow run clip missing');
});

test('the ranged clip set is registered with the animation loader', () => {
  assert.ok(CLIP_SOURCES.includes(ASSETS.rigRanged), 'ranged set is not loaded');
  assert.ok(ASSETS.rigRanged.endsWith('Rig_Medium_CombatRanged.glb'));

  // Every source the loader fetches must exist at runtime, and be a unique file.
  assert.equal(new Set(CLIP_SOURCES).size, CLIP_SOURCES.length);
  for (const url of CLIP_SOURCES) {
    assert.ok(existsSync(`public${url.slice(1)}`), `loader source missing on disk: ${url}`);
  }

  // Adding the set may only duplicate the unused T-Pose clip.
  const owners = new Map<string, string[]>();
  for (const file of readdirSync(ANIM_DIR)) {
    if (!file.endsWith('.glb')) continue;
    for (const name of gltfClipNames(`${ANIM_DIR}/${file}`)) {
      owners.set(name, [...(owners.get(name) ?? []), file]);
    }
  }
  const duplicates = [...owners.entries()].filter(([, files]) => files.length > 1);
  for (const [name] of duplicates) assert.equal(name, 'T-Pose', `${name} is registered by more than one file`);
});

test('melee and locomotion clips survive the ranged addition', () => {
  const melee = gltfClipNames(`${ANIM_DIR}/Rig_Medium_CombatMelee.glb`);
  const basic = gltfClipNames(`${ANIM_DIR}/Rig_Medium_MovementBasic.glb`);

  assert.equal(melee.length, 22, 'melee clip count changed');
  for (const name of ['Melee_1H_Attack_Slice_Diagonal', 'Melee_1H_Attack_Chop', 'Melee_Blocking', 'Melee_Block_Hit']) {
    assert.ok(melee.includes(name), `melee clip lost: ${name}`);
  }
  const general = gltfClipNames(`${ANIM_DIR}/Rig_Medium_General.glb`);
  for (const name of ['Idle_A', 'Idle_B', 'Hit_A', 'Death_A']) {
    assert.ok(general.includes(name), `general clip lost: ${name}`);
  }
  for (const name of ['Running_A', 'Walking_A', 'Jump_Land', 'Jump_Start']) {
    assert.ok(basic.includes(name), `locomotion clip lost: ${name}`);
  }
  for (const name of ['Dodge_Forward', 'Dodge_Backward', 'Dodge_Left', 'Dodge_Right']) {
    assert.ok(gltfClipNames(`${ANIM_DIR}/Rig_Medium_MovementAdvanced.glb`).includes(name), `dodge clip lost: ${name}`);
  }
});

test('the Ranger shoots physical arrows from the bow release', () => {
  const ranger = profileFor('ranger');

  // A bow user does not block: the defence input draws the bow instead.
  assert.equal(ranger.guard, null);
  assert.equal(ranger.aim?.clip, 'Ranged_Bow_Aiming_Idle');
  assert.ok((ranger.aim?.moveScale ?? 1) < 1, 'aiming slows the walk');

  for (const attack of [ranger.light, ranger.heavy]) {
    assert.ok(attack.ranged, 'both shots launch a projectile');
    assert.equal(attack.clip, 'Ranged_Bow_Release');
    // The string hand reverses direction at this authored time.
    assert.equal(attack.hitStart, 0.28);
    assert.ok(attack.ranged && attack.ranged.speed > 20);
    assert.ok(attack.range >= attack.ranged!.maxRange * 0.9, 'range covers the arrow flight');
  }

  // Hip shot: fast and light. Aimed shot: slower cadence, more damage, further.
  assert.ok(ranger.light.cooldown < ranger.heavy.cooldown);
  assert.ok(ranger.light.damage < ranger.heavy.damage);
  assert.ok(ranger.light.recovery! < ranger.heavy.recovery!);
  assert.ok(ranger.light.timeScale! > ranger.heavy.timeScale!);
  assert.ok(ranger.heavy.ranged!.speed > ranger.light.ranged!.speed);

  // Real seconds from the press to the arrow leaving.
  const hipRelease = ranger.light.hitStart / ranger.light.timeScale;
  const aimedRelease = ranger.heavy.hitStart / ranger.heavy.timeScale;
  assert.ok(hipRelease > 0.15 && hipRelease < 0.25, `hip release at ${hipRelease.toFixed(3)}s`);
  assert.ok(aimedRelease > 0.28 && aimedRelease < 0.4, `aimed release at ${aimedRelease.toFixed(3)}s`);

  // Melee identities are untouched by the ranged milestone.
  assert.equal(profileFor('knight').light.clip, 'Melee_1H_Attack_Slice_Diagonal');
  assert.equal(profileFor('knight').light.ranged, undefined);
  assert.equal(profileFor('mage').id, 'mage', 'the Mage has its own combat profile in M7.4');
});

test('the arrow asset is present and points along its local +z axis', () => {
  const path = 'public/rpg/weapons/arrow_bow.gltf';
  assert.ok(existsSync(path), 'arrow model missing from the asset tree');
  assert.ok(existsSync('public/rpg/weapons/arrow_bow.bin'), 'arrow buffer missing');
  assert.ok(existsSync('public/rpg/weapons/ranger_texture.png'), 'arrow texture missing');

  const gltf = JSON.parse(readFileSync(path, 'utf8')) as {
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: { min?: number[]; max?: number[] }[];
  };
  assert.equal(gltf.meshes.length, 1, 'one mesh keeps the pool at one draw per arrow');

  const bounds = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const min = bounds.min ?? [0, 0, 0];
  const max = bounds.max ?? [0, 0, 0];

  // Length is on z, and the origin sits at the middle: the projectile code
  // orients the mesh by aligning +z with the flight direction.
  assert.ok(max[2] - min[2] > 1.1, 'arrow is long on z');
  assert.ok(max[0] - min[0] < 0.25 && max[1] - min[1] < 0.25, 'thin on x/y');
  assert.ok(Math.abs(max[2] + min[2]) < 0.1, 'centred on its origin');
});

test('all five Adventurers share the animation skeleton', () => {
  const reference = gltfJointNames(`${ANIM_DIR}/Rig_Medium_CombatRanged.glb`);
  assert.equal(reference.length, 23);
  for (const joint of ['handslot.r', 'handslot.l', 'head', 'hips']) {
    assert.ok(reference.includes(joint), `rig lacks ${joint}`);
  }

  for (const url of CLIP_SOURCES) {
    assert.deepEqual(gltfJointNames(`public${url.slice(1)}`), reference, `${url} uses a different skeleton`);
  }

  const characters = ['Knight', 'Barbarian', 'Rogue', 'Mage', 'Ranger'];
  for (const name of characters) {
    const path = `public/rpg/characters/${name}.glb`;
    assert.ok(existsSync(path), `${name} model missing`);
    assert.deepEqual(gltfJointNames(path), reference, `${name} cannot bind the ranged clips`);
  }
});

// Root translation in every ranged clip is a static zero, unlike the Dodge_* clips
// which carry authored travel and get their XZ stripped by the loader. Guard that,
// so a future asset swap that introduces real root travel fails here first.
test('ranged clips carry no root translation to strip', () => {
  const { gltf, bin } = readGlb(`${ANIM_DIR}/Rig_Medium_CombatRanged.glb`);
  const accessors = gltf.accessors ?? [];
  const bufferViews = gltf.bufferViews ?? [];

  const floatAt = (accessor: number, index: number): number => {
    const view = accessors[accessor];
    return bin.readFloatLE((bufferViews[view.bufferView].byteOffset ?? 0) + (view.byteOffset ?? 0) + index * 4);
  };

  let checked = 0;
  for (const animation of gltf.animations ?? []) {
    for (const channel of animation.channels) {
      if (channel.target.path !== 'translation' || gltf.nodes[channel.target.node].name !== 'root') continue;
      const output = animation.samplers[channel.sampler].output;
      assert.ok(accessors[output].count <= 2, `${animation.name} animates root translation`);
      for (let i = 0; i < accessors[output].count * 3; i++) {
        assert.equal(floatAt(output, i), 0, `${animation.name} has non-zero root translation`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected every ranged clip to key root translation');
});
