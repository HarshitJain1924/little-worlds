import * as THREE from 'three';
import './play.css';
import { ThirdPersonCamera } from './camera';
import type { WeaponSpec } from './character';
import { CharacterRig, SOCKETS, weaponFrom } from './character';
import { hasLineOfSight } from './collision';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CombatEffects } from './effects';
import { InputController } from './input';
import { Sfx } from './sfx';
import { CombatVfx } from './vfx';
import { ASSETS, loadClipSet, loadModel } from './models';
import { Player } from './player';
import type { EnemyConfig } from './enemy';
import { Enemy } from './enemy';
import { applyQuality, readQualityPreference, storeQualityPreference, type QualityLevel } from './quality';
import { TargetTracker } from './targeting';
import { ARENA, buildWorld } from './world';
import { Hud } from './hud';
import { ADVENTURERS, findAdventurer, type CharacterId, type WeaponKey } from './roster';
import { profileFor } from './movesets';
import type { ArrowVisual, Impact, ProjectileVisual } from './projectiles';
import { ProjectilePool } from './projectiles';
import { solveShot, type AimSolution } from './aim';

const loadingFill = document.querySelector<HTMLElement>('#loading-fill');
const loadingLabel = document.querySelector<HTMLElement>('#loading-label');
const loadingRoot = document.querySelector<HTMLElement>('#loading');

/** Distance at which an enemy becomes a candidate for soft/hard targeting. */
const TARGET_RANGE = 15;
/** Fixed sun offset from the player, so the shadow frustum follows the action. */
const SUN_OFFSET = new THREE.Vector3(18, 20, 11);

function progress(fraction: number, label?: string): void {
  if (loadingFill) loadingFill.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  if (label && loadingLabel) loadingLabel.textContent = label;
}

/** Bright daylight dome for the arena; the island's pastel sky reads too warm here. */
function createSkyDome(sunDirection: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x3f7fc4) },
      uHorizon: { value: new THREE.Color(0xdcebf6) },
      uSun: { value: new THREE.Color(0xfff3d6) },
      uSunDir: { value: sunDirection.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSun;
      uniform vec3 uSunDir;
      varying vec3 vDirection;

      void main() {
        vec3 dir = normalize(vDirection);
        float height = clamp(dir.y, -1.0, 1.0);
        vec3 colour = mix(uHorizon, uTop, smoothstep(-0.02, 0.62, height));

        float sun = max(dot(dir, normalize(uSunDir)), 0.0);
        colour += uSun * pow(sun, 260.0) * 1.1;
        colour += uSun * pow(sun, 7.0) * 0.12;

        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 20), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

const MINION: EnemyConfig = {
  label: 'Skeleton Minion',
  maxHealth: 52,
  speed: 2.7,
  damage: 9,
  aggroRadius: 9.5,
  attackRange: 2.3,
  attackCooldown: 1.45,
  attackClip: 'Melee_1H_Attack_Slice_Diagonal',
  attackStrike: 0.4,
  attackTimeScale: 1,
};

const WARRIOR: EnemyConfig = {
  label: 'Skeleton Warrior',
  maxHealth: 80,
  speed: 2.2,
  damage: 14,
  aggroRadius: 10.5,
  attackRange: 2.5,
  attackCooldown: 1.9,
  attackClip: 'Melee_1H_Attack_Chop',
  attackStrike: 0.6,
  attackTimeScale: 0.95,
};

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  if (!canvas) throw new Error('canvas missing');

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const hud = new Hud();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !coarse,
    powerPreference: 'high-performance',
    // No preserveDrawingBuffer: screenshots re-render and read in the same task
    // instead of paying for a permanently retained back buffer.
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdcebf6);
  scene.fog = new THREE.Fog(0xdcebf6, 60, 130);

  const sunDirection = new THREE.Vector3(0.58, 0.62, 0.36).normalize();
  scene.add(createSkyDome(sunDirection));

  const sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 72;
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 16;
  sun.shadow.camera.bottom = -16;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x6f7f52, 1.7));

  const effects = new CombatEffects(scene);
  const sfx = new Sfx();

  progress(0.04, 'shaping the ground…');

  const [
    world,
    clips,
    knightGltf,
    minionGltf,
    warriorGltf,
    swordGltf,
    shieldGltf,
    bladeGltf,
    axeGltf,
    largeShieldGltf,
    barbarianGltf,
    rogueGltf,
    mageGltf,
    rangerGltf,
    axeTwoHandedGltf,
    shieldBarbarianGltf,
    daggerGltf,
    staffGltf,
    bowGltf,
    arrowGltf,
  ] = await Promise.all([
    buildWorld((fraction, label) => progress(0.05 + fraction * 0.62, label)),
    loadClipSet(),
    loadModel(ASSETS.knight),
    loadModel(ASSETS.skeletonMinion),
    loadModel(ASSETS.skeletonWarrior),
    loadModel(ASSETS.sword),
    loadModel(ASSETS.shield),
    loadModel(ASSETS.skeletonBlade),
    loadModel(ASSETS.skeletonAxe),
    loadModel(ASSETS.skeletonShield),
    loadModel(ASSETS.barbarian),
    loadModel(ASSETS.rogue),
    loadModel(ASSETS.mage),
    loadModel(ASSETS.ranger),
    loadModel(ASSETS.axeTwoHanded),
    loadModel(ASSETS.shieldBarbarian),
    loadModel(ASSETS.dagger),
    loadModel(ASSETS.staff),
    loadModel(ASSETS.bow),
    loadModel(ASSETS.arrow),
  ]);

  scene.add(world.group);

  let quality: QualityLevel = readQualityPreference(coarse);
  const qualityTargets = { renderer, sun, scene, foliage: world.foliage };
  applyQuality(quality, qualityTargets);

  progress(0.72, 'arming the adventurers…');

  // One template per character and per weapon. Every rig is a skinned clone of
  // these, so switching never re-downloads or re-parses a model.
  const characterTemplates: Record<CharacterId, THREE.Object3D> = {
    knight: knightGltf.scene,
    barbarian: barbarianGltf.scene,
    rogue: rogueGltf.scene,
    mage: mageGltf.scene,
    ranger: rangerGltf.scene,
  };

  const weaponTemplates: Record<WeaponKey, THREE.Object3D> = {
    sword: weaponFrom(swordGltf),
    shield: weaponFrom(shieldGltf),
    axe: weaponFrom(axeTwoHandedGltf),
    barbarianShield: weaponFrom(shieldBarbarianGltf),
    dagger: weaponFrom(daggerGltf),
    staff: weaponFrom(staffGltf),
    bow: weaponFrom(bowGltf),
  };

  function buildRig(id: CharacterId): CharacterRig {
    const adventurer = findAdventurer(id);
    if (!adventurer) throw new Error(`Unknown adventurer "${id}"`);

    const weapons: WeaponSpec[] = adventurer.weapons.map((entry) => ({
      model: weaponTemplates[entry.asset],
      socket: SOCKETS[entry.socket],
    }));

    return new CharacterRig(characterTemplates[id], clips, weapons);
  }

  const player = new Player(buildRig('knight'), world, undefined, profileFor('knight'));
  scene.add(player.rig.root);
  let activeCharacter: CharacterId = 'knight';

  // ---- projectiles -------------------------------------------------------
  /** Uses the authored arrow's own mesh: one shared geometry and material. */
  function arrowVisual(gltf: GLTF): ArrowVisual {
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    const first = meshes[0];
    if (!first) throw new Error('arrow model has no mesh');
    const material = Array.isArray(first.material) ? first.material[0] : first.material;
    return { geometry: first.geometry, material };
  }

  function createMagicVisuals(): {
    light: ProjectileVisual;
    heavy: ProjectileVisual;
  } {
    // Magic light bolt: an aerodynamic glowing arcane comet pointing forward (+Z)
    const lightGeom = new THREE.SphereGeometry(1, 12, 8);
    lightGeom.scale(0.18, 0.18, 0.36);
    const lightMat = new THREE.MeshBasicMaterial({
      color: 0xc4a3ff,
      toneMapped: false,
    });

    // Magic heavy bolt: a dense, powerful sphere of concentrated magical energy
    const heavyGeom = new THREE.SphereGeometry(1, 16, 12);
    heavyGeom.scale(0.38, 0.38, 0.52);
    const heavyMat = new THREE.MeshBasicMaterial({
      color: 0xee88ff,
      toneMapped: false,
    });

    return {
      light: { geometry: lightGeom, material: lightMat, offset: 0 },
      heavy: { geometry: heavyGeom, material: heavyMat, offset: 0 },
    };
  }

  const magicVisuals = createMagicVisuals();
  const projectiles = new ProjectilePool(scene, world, {
    arrow: arrowVisual(arrowGltf),
    magicLight: magicVisuals.light,
    magicHeavy: magicVisuals.heavy,
  });

  /** Height of the aim ray's origin: the player's shoulder, not the camera boom. */
  const AIM_HEIGHT = 1.45;
  const aimCamera = new THREE.Vector3();
  const cameraPos = new THREE.Vector3();
  const cameraRay = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  const shotDirection = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const aimReference = new THREE.Vector3();

  /**
   * Where the camera forward ray first meets the world: an obstacle, the ground,
   * or nothing within range. Firing at this point (rather than parallel to the
   * view) is what makes pitch matter and aligns the reticle with projectile flight.
   */
  function solvePlayerAim(maxRange: number): AimSolution {
    cameraRig.camera.getWorldPosition(cameraPos);
    cameraRig.camera.getWorldDirection(aimCamera);
    player.muzzlePosition(muzzle);

    let aimSolution: AimSolution;

    // Free aim uses the camera centre. Lock-on only supplies a preferred point;
    // the shared solver still decides whether the body is actually reachable.
    const locked = tracker.locked;
    if (locked && locked.alive) {
      aimReference.set(locked.position.x, locked.position.y + 1.05, locked.position.z);
      aimSolution = { kind: 'enemy', target: locked, distance: muzzle.distanceTo(aimReference) };
    } else {
      // Free aim: raycast from the camera sightline forward from the player's depth.
      // This matches what the screen-centred crosshair points at, eliminating
      // the third-person shoulder parallax error while ignoring anything behind the avatar.
      const depth = Math.max(
        0,
        (player.position.x - cameraPos.x) * aimCamera.x +
        (player.position.y + AIM_HEIGHT - cameraPos.y) * aimCamera.y +
        (player.position.z - cameraPos.z) * aimCamera.z,
      );
      cameraRay.copy(cameraPos).addScaledVector(aimCamera, depth);
      aimSolution = solveShot(cameraRay, aimCamera, world, enemies, maxRange, aimReference);
      if (aimSolution.kind === 'range') {
        aimReference.copy(cameraRay).addScaledVector(aimCamera, maxRange);
      } else if (aimSolution.kind === 'enemy' && aimSolution.target) {
        aimReference.y = THREE.MathUtils.clamp(
          aimReference.y,
          aimSolution.target.position.y + 0.5,
          aimSolution.target.position.y + 1.6,
        );
      }
    }

    shotDirection.copy(aimReference).sub(muzzle);
    if (shotDirection.lengthSq() < 1e-6) shotDirection.copy(aimCamera);
    shotDirection.normalize();

    const clearance = activeCharacter === 'mage' ? 0.1 : 0.4;
    shotOrigin.copy(muzzle).addScaledVector(shotDirection, clearance);

    // Solve from the projectile's actual origin. The returned aim state honestly
    // represents the actual projectile path and its collision result (never reporting
    // 'enemy' if the actual muzzle shot misses, is blocked by cover, or returns 'range').
    const shotSolution = solveShot(shotOrigin, shotDirection, world, enemies, maxRange, aimPoint);
    return shotSolution;
  }

  player.onRangedShot = (attack) => {
    const ranged = attack.ranged;
    if (!ranged) return;

    solvePlayerAim(ranged.maxRange);

    if (shotDirection.lengthSq() < 1e-6) return;

    const heavy = attack.tag === 'heavy';
    const isMage = activeCharacter === 'mage';

    projectiles.spawn({
      origin: shotOrigin,
      direction: shotDirection,
      speed: ranged.speed,
      damage: attack.damage,
      maxRange: ranged.maxRange,
      kind: isMage ? (heavy ? 'magicHeavy' : 'magicLight') : 'arrow',
    });

    if (isMage) {
      effects.spawn(shotOrigin, heavy ? 'magicHeavy' : 'magic', false);
      sfx.magicCast(heavy);
      cameraRig.shake(heavy ? 0.08 : 0.04);
    } else {
      sfx.bowRelease(heavy);
      cameraRig.shake(heavy ? 0.06 : 0.035);
    }
  };

  /**
   * Swaps the visible Adventurer without touching the encounter: the single
   * Player controller, camera, target lock and enemies keep their state.
   */
  function switchCharacter(id: CharacterId): boolean {
    if (id === activeCharacter) return false;
    if (!player.canSwitchCharacter) return false;

    const next = buildRig(id);
    const previous = player.rig;

    scene.add(next.root);
    player.replaceRig(next, profileFor(id));
    scene.remove(previous.root);
    // Geometry, textures and animation clips are shared with the templates, so
    // only this rig's mixer and its cloned materials are released.
    previous.dispose();

    activeCharacter = id;
    hud.setActiveCharacter(id);
    const ability = player.profile.ability;
    hud.setAbility(ability?.name ?? null, player.currentAbilityCooldown, ability?.cooldown ?? 0);
    return true;
  }

  hud.setRoster(ADVENTURERS, (id) => {
    switchCharacter(id as CharacterId);
  });
  hud.setActiveCharacter(activeCharacter);

  // Flipbook VFX. Quality decides which pools exist at all; low never loads a
  // sheet, so the lightweight rings in CombatEffects carry that tier alone.
  const vfx = new CombatVfx(scene, (out) => player.weaponHand(out));
  vfx.setQuality(quality);

  const cameraRig = new ThirdPersonCamera(window.innerWidth / window.innerHeight, {
    obstacles: world.obstacles,
    heightAt: world.heightAt,
  });

  // Three enemies between the spawn and the ruin, so the walk has a fight in it.
  const enemySpecs: { config: EnemyConfig; spawn: { x: number; z: number }; kind: 'minion' | 'warrior' }[] = [
    { config: MINION, spawn: { x: 8, z: 1 }, kind: 'minion' },
    { config: MINION, spawn: { x: -8, z: 3 }, kind: 'minion' },
    { config: WARRIOR, spawn: { x: 2, z: -11 }, kind: 'warrior' },
  ];

  const enemies: Enemy[] = enemySpecs.map((spec) => {
    const template = spec.kind === 'warrior' ? warriorGltf.scene : minionGltf.scene;
    const weapons: WeaponSpec[] =
      spec.kind === 'warrior'
        ? [
            { model: weaponFrom(axeGltf), socket: SOCKETS.axe },
            { model: weaponFrom(largeShieldGltf), socket: SOCKETS.largeShield },
          ]
        : [{ model: weaponFrom(bladeGltf), socket: SOCKETS.blade }];

    const rig = new CharacterRig(template, clips, weapons);
    scene.add(rig.root);
    const enemy = new Enemy(rig, spec.config, spec.spawn, world);
    hud.register(enemy);
    return enemy;
  });

  // Target selection reads the same convex proxies the camera collides with, so
  // visibility costs a handful of segment tests rather than a scene raycast.
  const tracker = new TargetTracker<Enemy>({
    maxRange: TARGET_RANGE,
    releaseRange: TARGET_RANGE + 6,
    maxAngle: Math.PI * 0.6,
    perceptionInterval: 0.2,
    lostSightGrace: 1.2,
    isVisible: (from, to) =>
      hasLineOfSight(from.x, from.y + 1.2, from.z, to.x, to.y + 1.2, to.z, world.obstacles),
  });
  for (const enemy of enemies) tracker.register(enemy);

  const scoring = {
    player: player.position as { x: number; y: number; z: number },
    cameraForward: { x: 0, z: -1 },
    playerForward: { x: 0, z: 1 },
    maxRange: TARGET_RANGE,
    maxAngle: Math.PI * 0.6,
  };

  const input = new InputController(
    canvas,
    document.querySelector<HTMLButtonElement>('#attack'),
    document.querySelector<HTMLElement>('#stick'),
    document.querySelector<HTMLButtonElement>('#lock'),
    {
      heavy: document.querySelector<HTMLButtonElement>('#heavy'),
      block: document.querySelector<HTMLButtonElement>('#block'),
      dodge: document.querySelector<HTMLButtonElement>('#dodge'),
      ability: document.querySelector<HTMLButtonElement>('#ability'),
    },
  );

  hud.setCaptureHint(input.needsCapture);
  input.onPointerLockChange = (locked) => hud.setCaptureHint(!locked && input.needsCapture);

  const scratchA = new THREE.Vector3();
  const scratchForward = new THREE.Vector3();
  const scratchFacing = new THREE.Vector3();

  /** Seconds of slowed world time left from the last landed blow. */
  let hitStopTimer = 0;

  /**
   * The slash sheet peaks at frame 8, i.e. 0.1 s after its first played frame,
   * so it is scheduled to start that much before the authored strike time and
   * its brightest frame lands on the frame the damage can connect.
   */
  const SLASH_LEAD = 0.1;
  let slashPending: { remaining: number; kind: 'slashLight' | 'slashHeavy'; clip: string } | null = null;

  player.onAttackStart = (attack) => {
    const heavy = attack === player.profile.heavy;
    if (!attack.ranged) {
      sfx.swing(heavy);
      slashPending = {
        remaining: Math.max(0, attack.hitStart / attack.timeScale - SLASH_LEAD),
        kind: heavy ? 'slashHeavy' : 'slashLight',
        clip: attack.clip,
      };
    }
  };

  /** Projectile impact feedback (arrows and magic bolts). Damage has already been applied. */
  function onProjectileImpact(impact: Impact): void {
    if (impact.kind === 'expired') return;

    const isMagic = impact.shotKind === 'magicLight' || impact.shotKind === 'magicHeavy';
    const isHeavy = impact.shotKind === 'magicHeavy';

    if (impact.kind === 'target' && impact.target) {
      const enemy = impact.target as Enemy;
      hud.damageNumber(enemy.position, impact.damage, 'dealt');

      if (isMagic) {
        effects.spawn(enemy.position, isHeavy ? 'magicHeavy' : 'magic');
        vfx.spawn(isHeavy ? 'impactHeavy' : 'impact', impact.position, player.yaw);
        sfx.magicHit(isHeavy);
        hitStopTimer = Math.max(hitStopTimer, isHeavy ? 0.05 : 0.03);
        cameraRig.shake(isHeavy ? 0.08 : 0.05);
      } else {
        effects.spawn(enemy.position, 'hit');
        vfx.spawn('impact', impact.position, player.yaw);
        sfx.arrowHit();
        hitStopTimer = Math.max(hitStopTimer, 0.03);
        cameraRig.shake(0.05);
      }

      if (!enemy.alive) sfx.enemyDeath();
      return;
    }

    // Wall, pillar, trunk or ground: the projectile stops there. Only the flipbook
    // spark is used, because the ring pool sits at chest height and would float
    // above a ground or low obstacle strike.
    if (isMagic) {
      vfx.spawn(isHeavy ? 'impactHeavy' : 'impact', impact.position, player.yaw);
      sfx.magicHit(isHeavy);
    } else {
      vfx.spawn('impact', impact.position, player.yaw);
      sfx.arrowHit();
    }
  }

  player.onDodgeStart = () => {
    sfx.dodge();
    vfx.spawn('dodgeDust', player.position, player.yaw);
  };

  player.onLand = () => vfx.spawn('landing', player.position, player.yaw);

  player.onAttackHit = (position, forward, attack, hitTargets) => {
    let hits = 0;

    const tryHit = (enemy: Enemy): boolean => {
      if (!enemy.alive || hitTargets.has(enemy)) return false;

      const toEnemy = scratchA.copy(enemy.position).sub(position).setY(0);
      const distance = toEnemy.length();
      if (distance > attack.range + 0.7) return false;

      if (distance > 0.001) {
        toEnemy.normalize();
        if (Math.acos(Math.min(1, Math.max(-1, toEnemy.dot(forward)))) > attack.arc) return false;
      }

      // A swing does not reach through a wall, pillar or trunk.
      if (
        !hasLineOfSight(
          position.x,
          position.y + 1.2,
          position.z,
          enemy.position.x,
          enemy.position.y + 1.2,
          enemy.position.z,
          world.obstacles,
        )
      ) {
        return false;
      }

      if (!enemy.takeDamage(attack.damage, position)) return false;
      hitTargets.add(enemy);
      hud.damageNumber(enemy.position, attack.damage, 'dealt');

      const heavy = attack === player.profile.heavy;
      effects.spawn(enemy.position, heavy ? 'heavy' : 'hit');
      // Only a confirmed hit sparks; a whiffed swing shows the trail alone.
      vfx.spawn(heavy ? 'impactHeavy' : 'impact', enemy.position, player.yaw);
      sfx.impact(heavy);
      // A heavy cleave freezes the world a touch longer, so the weight reads.
      hitStopTimer = Math.max(hitStopTimer, heavy ? 0.075 : 0.045);
      if (!enemy.alive) sfx.enemyDeath();

      hits += 1;
      return true;
    };

    // The selected target is struck first; the cone only sweeps alternatives
    // when it cannot reach the selection.
    const preferred = tracker.preferred;
    if (preferred) tryHit(preferred);
    if (hits === 0) for (const enemy of enemies) tryHit(enemy);

    if (hits > 0) cameraRig.shake(attack === player.profile.heavy ? 0.15 : 0.09);
  };

  for (const enemy of enemies) {
    enemy.onHitPlayer = (damage, from, attacker) => {
      const applied = player.takeDamage(damage, from, attacker);
      const blocked = applied > 0 && applied < damage - 0.01;

      // Dodge i-frames and counter negation take nothing, so they get no number, spark or sound.
      if (applied > 0) {
        hud.damageNumber(player.position, applied, blocked ? 'blocked' : 'taken');
        effects.spawn(player.position, blocked ? 'block' : 'hit');
        hitStopTimer = Math.max(hitStopTimer, blocked ? 0.05 : 0.035);
        if (blocked) sfx.block();
        else sfx.hurt();
        if (!player.alive) sfx.enemyDeath();
        hud.flash();
        cameraRig.shake(blocked ? 0.1 : 0.16);
      }
    };
  }

  player.onCounterSuccess = () => {
    effects.spawn(player.position, 'block');
    sfx.counterClash();
    hitStopTimer = Math.max(hitStopTimer, 0.08);
    cameraRig.shake(0.18);
  };

  player.findFallbackTarget = () => {
    const forward = player.facing(scratchFacing);
    let bestEnemy: Enemy | null = null;
    let bestDist = Infinity;
    const ability = player.currentAbility;
    const range = ability && 'range' in ability ? ability.range : 2.6;
    const arc = ability && 'arc' in ability ? ability.arc : Math.PI * 0.4;
    const cosArc = Math.cos(arc);

    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const to = scratchA.copy(enemy.position).sub(player.position).setY(0);
      const dist = to.length();
      if (dist > range) continue;
      if (dist > 0.001) to.multiplyScalar(1 / dist);
      if (to.dot(forward) >= cosArc && dist < bestDist) {
        if (
          hasLineOfSight(
            player.position.x,
            player.position.y + 1.2,
            player.position.z,
            enemy.position.x,
            enemy.position.y + 1.2,
            enemy.position.z,
            world.obstacles,
          )
        ) {
          bestDist = dist;
          bestEnemy = enemy;
        }
      }
    }
    return bestEnemy;
  };

  player.findAreaTargets = () => enemies;

  player.onAbilityStart = (ability) => {
    if (ability.kind === 'whirlwind') {
      sfx.whirlwind();
    } else if (ability.kind === 'shadowstep') {
      sfx.shadowstepDash();
    }
  };

  player.onAbilityStep = (stepIndex, ability) => {
    if (ability.kind === 'shadowstep') {
      if (stepIndex > 0) sfx.shadowstepDash();
      vfx.spawn('dodgeDust', player.position, player.yaw);
    }
  };

  player.onAbilityHit = (target, ability) => {
    if (target && typeof target === 'object' && 'takeDamage' in target) {
      const enemy = target as Enemy;
      if (
        ability.kind !== 'shadowstep' &&
        !hasLineOfSight(
          player.position.x,
          player.position.y + 1.2,
          player.position.z,
          enemy.position.x,
          enemy.position.y + 1.2,
          enemy.position.z,
          world.obstacles,
        )
      ) {
        return;
      }
      if (enemy.takeDamage(ability.damage, player.position)) {
        hud.damageNumber(enemy.position, ability.damage, 'dealt');
        if (ability.kind === 'shadowstep') {
          effects.spawn(enemy.position, 'hit');
          vfx.spawn('slashLight', enemy.position, player.yaw);
          sfx.shadowstepStrike();
          hitStopTimer = Math.max(hitStopTimer, 0.05);
          cameraRig.shake(0.14);
        } else {
          effects.spawn(enemy.position, 'heavy');
          vfx.spawn('impactHeavy', enemy.position, player.yaw);
          if (ability.kind === 'whirlwind') {
            sfx.whirlwindHit();
          } else {
            sfx.shieldRiposte();
          }
          hitStopTimer = Math.max(hitStopTimer, 0.09);
          cameraRig.shake(ability.kind === 'whirlwind' ? 0.24 : 0.22);
        }
        if (!enemy.alive) sfx.enemyDeath();
      }
    }
  };

  progress(0.95, 'ready');

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    cameraRig.setAspect(width / height);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  let defeated = false;
  let lastBanner: string | null = null;

  function restart(): void {
    player.reset();
    enemies.forEach((enemy) => enemy.reset());
    vfx.clear();
    projectiles.clear();
    slashPending = null;
    tracker.release();
    defeated = false;
    lastBanner = null;
    hud.showBanner(null);
    hud.setObjective('Reach the ruin · defeat the skeletons');
    const ability = player.profile.ability;
    hud.setAbility(ability?.name ?? null, player.currentAbilityCooldown, ability?.cooldown ?? 0);
  }

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (key === 'r') restart();
    if (key === 'm') sfx.toggleMute();

    const slot = Number(key);
    if (Number.isInteger(slot) && slot >= 1 && slot <= ADVENTURERS.length) {
      switchCharacter(ADVENTURERS[slot - 1].id);
    }
  });

  function updateScoring(): void {
    const forward = cameraRig.forward(scratchForward);
    scoring.cameraForward.x = forward.x;
    scoring.cameraForward.z = forward.z;
    const facing = player.facing(scratchFacing);
    scoring.playerForward.x = facing.x;
    scoring.playerForward.z = facing.z;
  }

  /** One simulation step, shared by the render loop and the test harness. */
  function stepWorld(delta: number): void {
    const look = input.takeLook();
    if (look.x !== 0 || look.y !== 0) cameraRig.rotate(look.x, look.y);
    const zoom = input.takeZoom();
    if (zoom !== 0) cameraRig.zoom(zoom);

    updateScoring();

    if (input.takeLockToggle()) tracker.toggleLock(scoring);
    if (input.takeLockNext()) tracker.cycle(scoring);

    player.update(delta, input, cameraRig);

    // Fire the slash once the swing reaches its strike, not when the key went down.
    if (slashPending) {
      slashPending.remaining -= delta;
      if (slashPending.remaining <= 0) {
        if (player.attackingWith === slashPending.clip) {
          vfx.spawn(slashPending.kind, player.position, player.yaw);
        }
        slashPending = null;
      }
    }

    projectiles.update(delta, enemies, onProjectileImpact);

    for (const enemy of enemies) enemy.update(delta, player.position, player.alive);

    // Keep bodies apart without a physics engine.
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const away = scratchA.copy(enemy.position).sub(player.position).setY(0);
      const gap = away.length();
      if (gap > 0.001 && gap < 1.1) {
        away.normalize().multiplyScalar((1.1 - gap) * 0.6);
        enemy.position.add(away);
      }
    }

    // Ground telegraph under every enemy that has committed to a swing. Its
    // ring fills as the wind-up completes, so the blow is telegraphed in-world.
    let windupSlot = 0;
    for (const enemy of enemies) {
      if (enemy.isWindingUp) {
        effects.setWindup(windupSlot, enemy.position, enemy.windupProgress);
        windupSlot += 1;
      }
    }
    effects.hideWindupsFrom(windupSlot);

    updateScoring();
    tracker.update(scoring, delta);

    const locked = tracker.locked;
    player.setLockTarget(locked ? locked.position : null);
    cameraRig.setLockTarget(locked ? locked.position : null);

    cameraRig.setAiming(player.isAiming);
    cameraRig.update(delta, player.position, player.velocity);
    effects.update(delta, cameraRig.camera);
    vfx.update(delta, cameraRig.camera);

    sun.position.copy(player.position).add(SUN_OFFSET);
    sun.target.position.copy(player.position);
    sun.target.updateMatrixWorld();

    hud.setTarget(tracker.locked ?? tracker.soft, tracker.isLocked);

    const showAim =
      (player.isAiming && player.profile.aim?.clip) ||
      (player.isCharging && activeCharacter === 'mage');
    if (showAim) {
      const ranged = player.isCharging ? player.profile.heavy.ranged : player.profile.light.ranged;
      const solution = solvePlayerAim(ranged?.maxRange ?? 55);
      // The visible reticle is deliberately screen-centred, like a normal
      // third-person bow/shooter camera. The solver still uses aimPoint for the
      // real projectile direction and uses `solution.kind` for honest feedback;
      // projecting the impact point itself made a nearby ground hit draw the
      // reticle back over the Ranger's head.
      hud.setAim(
        true,
        window.innerWidth * 0.5,
        window.innerHeight * 0.5,
        solution.kind,
        player.chargeProgress,
        player.isCharging,
      );
    } else {
      hud.setAim(false, 0, 0, 'range', 0, false);
    }

    // Run-end state lives here so it fires whether the loop is running or the
    // simulation is being stepped by a test.
    if (!player.alive && lastBanner === null) {
      lastBanner = 'You fell — press R';
      hud.showBanner(lastBanner);
    }

    if (!defeated && enemies.every((enemy) => !enemy.alive)) {
      defeated = true;
      hud.setObjective('The ruin is clear — press R to start again');
    }
  }

  function refreshStats(frames: number, seconds: number): void {
    const alive = enemies.filter((enemy) => enemy.alive).length;
    hud.setStats(
      [
        `fps    ${(frames / Math.max(seconds, 0.0001)).toFixed(0)}  (${((seconds * 1000) / Math.max(frames, 1)).toFixed(1)} ms)`,
        `draws  ${renderer.info.render.calls}`,
        `tris   ${(renderer.info.render.triangles / 1000).toFixed(1)}k`,
        `qual   ${quality}  ${renderer.getPixelRatio().toFixed(2)}x  shadow ${sun.shadow.mapSize.x}`,
        `hp     ${Math.round(player.health)}  · foes ${alive}`,
      ].join('\n'),
    );
  }

  // First paint before the loop starts, so a hidden tab still shows the scene.
  player.update(0, input, cameraRig);
  cameraRig.update(0, player.position);
  renderer.render(scene, cameraRig.camera);
  hud.setHealth(player.health, player.maxHealth);
  const initialAbility = player.profile.ability;
  hud.setAbility(initialAbility?.name ?? null, player.currentAbilityCooldown, initialAbility?.cooldown ?? 0);
  hud.setObjective('Reach the ruin · defeat the skeletons');

  if (loadingRoot) {
    loadingRoot.classList.add('is-hidden');
    window.setTimeout(() => loadingRoot.remove(), 500);
  }

  let previous = performance.now();
  let statsTimer = 0;
  let frames = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const raw = (now - previous) / 1000;
    previous = now;
    if (document.hidden) return;

    // Bound catch-up work: a spike (tab switch, GC, shader compile) is replayed
    // in at most three slices so movement and animation never jump.
    // Brief hit-stop: the world slows for a few dozen milliseconds on impact.
    // Measured in real time so it cannot extend itself.
    const timeScale = hitStopTimer > 0 ? 0.32 : 1;
    if (hitStopTimer > 0) hitStopTimer = Math.max(0, hitStopTimer - raw);

    if (raw > 0.05) {
      const steps = Math.min(3, Math.ceil(raw / 0.05));
      const slice = (Math.min(raw, 0.25) / steps) * timeScale;
      for (let i = 0; i < steps; i += 1) stepWorld(slice);
    } else {
      stepWorld(raw * timeScale);
    }

    hud.setHealth(player.health, player.maxHealth);
    const loopAbility = player.profile.ability;
    hud.setAbility(loopAbility?.name ?? null, player.currentAbilityCooldown, loopAbility?.cooldown ?? 0);
    hud.update(raw, cameraRig.camera, window.innerWidth, window.innerHeight);

    renderer.render(scene, cameraRig.camera);

    frames += 1;
    statsTimer += raw;
    if (statsTimer >= 0.5) {
      refreshStats(frames, statsTimer);
      frames = 0;
      statsTimer = 0;
    }
  });

  // Scripted hook for verification: drives the same input path the player uses.
  // Development only, or a production build explicitly opened with ?debug.
  const debugEnabled =
    import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug');

  if (debugEnabled) {
  (window as unknown as { __play: unknown }).__play = {
    player,
    enemies,
    camera: cameraRig,
    tracker,
    renderer,
    scene,
    sun,
    quality: () => quality,
    setQuality: (level: QualityLevel) => {
      quality = level;
      storeQualityPreference(level);
      applyQuality(level, qualityTargets);
      vfx.setQuality(level);
      resize();
      refreshStats(0, 1);
      return quality;
    },
    press: (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key }));
    },
    hold: (key: string, down: boolean) => {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key }));
    },
    /** Camera-only look, for camera-math checks that bypass pointer lock. */
    look: (dx: number, dy: number) => {
      cameraRig.rotate(dx, dy);
      cameraRig.update(0, player.position, player.velocity);
    },
    lock: () => tracker.toggleLock(scoring),
    cycle: () => tracker.cycle(scoring),
    switchCharacter: (id: string) => switchCharacter(id as CharacterId),
    character: () => activeCharacter,
    teleport: (x: number, z: number) => {
      player.position.set(x, world.heightAt(x, z), z);
      player.rig.root.position.copy(player.position);
      cameraRig.update(0, player.position);
    },
    snapCamera: (yaw: number, pitch: number) => {
      cameraRig.snap(yaw, pitch);
      cameraRig.update(0, player.position);
    },
    state: () => ({
      player: {
        x: +player.position.x.toFixed(2),
        y: +player.position.y.toFixed(2),
        z: +player.position.z.toFixed(2),
        hp: Math.round(player.health),
        alive: player.alive,
        clip: player.rig.animator.playing,
        character: activeCharacter,
        profile: player.profile.id,
        attacking: player.isAttacking,
        blocking: player.isBlocking,
        aiming: player.isAiming,
        dodging: player.isDodging,
        dodgeClip: player.dodgingWith,
        arrows: projectiles.activeCount,
      },
      enemies: enemies.map((enemy) => ({
        hp: Math.round(enemy.health),
        alive: enemy.alive,
        state: enemy.state,
        clip: enemy.rig.animator.playing,
        x: +enemy.position.x.toFixed(2),
        z: +enemy.position.z.toFixed(2),
      })),
      camera: {
        yaw: +cameraRig.yaw.toFixed(3),
        pitch: +cameraRig.pitch.toFixed(3),
        distance: +cameraRig.distance.toFixed(2),
      },
      target: {
        locked: tracker.isLocked,
        soft: tracker.soft?.config.label ?? null,
        lock: tracker.locked?.config.label ?? null,
        softIndex: tracker.soft ? enemies.indexOf(tracker.soft) : -1,
        lockIndex: tracker.locked ? enemies.indexOf(tracker.locked) : -1,
      },
      pointerLock: input.isPointerLocked,
      quality,
      pixelRatio: +renderer.getPixelRatio().toFixed(2),
      shadowMap: sun.shadow.mapSize.x,
      draws: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    aimAt: (index: number) => {
      const enemy = enemies[index];
      if (!enemy) return;
      player.position.set(enemy.position.x, enemy.position.y, enemy.position.z + 1.8);
      player.yaw = Math.PI;
      player.rig.root.position.copy(player.position);
      cameraRig.update(0, player.position);
    },
    spawnDistance: ARENA.spawn,
    /** Fixed-step driver: real input state, no timers, fully deterministic. */
    step: (
      count: number,
      delta: number,
      move: {
        x?: number;
        y?: number;
        run?: boolean;
        attack?: boolean;
        heavy?: boolean;
        dodge?: boolean;
        block?: boolean;
        jump?: boolean;
        ability?: boolean;
        lock?: boolean;
        next?: boolean;
      } = {},
    ) => {
      input.virtual.x = move.x ?? 0;
      input.virtual.y = move.y ?? 0;
      input.virtual.run = move.run ?? false;
      input.virtual.block = move.block ?? false;
      input.virtual.heavy = move.heavy ?? false;
      if (move.attack) input.queueAttack();
      if (move.heavy) input.queueHeavy();
      if (move.ability) input.queueAbility();
      if (move.dodge) input.queueDodge();
      if (move.jump) input.queueJump();
      if (move.lock) input.queueLockToggle();
      if (move.next) input.queueLockNext();

      for (let i = 0; i < count; i += 1) stepWorld(delta);

      renderer.render(scene, cameraRig.camera);
      hud.setHealth(player.health, player.maxHealth);
      const debugAbility = player.profile.ability;
      hud.setAbility(debugAbility?.name ?? null, player.currentAbilityCooldown, debugAbility?.cooldown ?? 0);
      hud.update(0, cameraRig.camera, window.innerWidth, window.innerHeight);

      return {
        x: +player.position.x.toFixed(2),
        y: +player.position.y.toFixed(2),
        z: +player.position.z.toFixed(2),
        hp: Math.round(player.health),
        alive: player.alive,
        clip: player.rig.animator.playing,
        character: activeCharacter,
        attacking: player.isAttacking,
        abilityActive: player.isAbilityActive,
        abilityPhase: player.activeAbilityPhase,
        abilityCooldown: +player.currentAbilityCooldown.toFixed(2),
        blocking: player.isBlocking,
        aiming: player.isAiming,
        dodging: player.isDodging,
        dodgeClip: player.dodgingWith,
        arrows: projectiles.activeCount,
        camera: {
          yaw: +cameraRig.yaw.toFixed(3),
          pitch: +cameraRig.pitch.toFixed(3),
          distance: +cameraRig.distance.toFixed(2),
        },
        locked: tracker.isLocked,
        lock: tracker.locked?.config.label ?? null,
        soft: tracker.soft?.config.label ?? null,
        enemies: enemies.map((enemy) => ({
          hp: Math.round(enemy.health),
          alive: enemy.alive,
          state: enemy.state,
          clip: enemy.rig.animator.playing,
        })),
        draws: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      };
    },
    /** Repeated render timing for before/after comparison. */
    benchmark: (sampleCount = 180) => {
      const samples: number[] = [];
      for (let i = 0; i < sampleCount; i += 1) {
        const start = performance.now();
        stepWorld(1 / 60);
        hud.update(0, cameraRig.camera, window.innerWidth, window.innerHeight);
        renderer.render(scene, cameraRig.camera);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const total = samples.reduce((sum, value) => sum + value, 0);
      const at = (fraction: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
      return {
        frames: sampleCount,
        avgMs: +(total / samples.length).toFixed(2),
        medianMs: +at(0.5).toFixed(2),
        p95Ms: +at(0.95).toFixed(2),
        maxMs: +samples[samples.length - 1].toFixed(2),
        fps: +(1000 / (total / samples.length)).toFixed(1),
        draws: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        pixelRatio: +renderer.getPixelRatio().toFixed(2),
        shadowMap: sun.shadow.mapSize.x,
        quality,
      };
    },
    /** Renders and reads the frame in the same task: no preserveDrawingBuffer. */
    screenshot: () => {
      renderer.render(scene, cameraRig.camera);
      return canvas.toDataURL('image/png');
    },
  };
  }
}

boot().catch((error: unknown) => {
  console.error(error);
  progress(0, 'failed to start — see console');
  if (loadingLabel) loadingLabel.textContent = String(error);
});
