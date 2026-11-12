import * as THREE from 'three';
import './play.css';
import { ThirdPersonCamera } from './camera';
import type { WeaponSpec } from './character';
import { CharacterRig, SOCKETS, weaponFrom } from './character';
import { InputController } from './input';
import { ASSETS, loadClipSet, loadModel } from './models';
import { Player } from './player';
import type { EnemyConfig } from './enemy';
import { Enemy } from './enemy';
import { ARENA, buildWorld } from './world';
import { Hud } from './hud';

const loadingFill = document.querySelector<HTMLElement>('#loading-fill');
const loadingLabel = document.querySelector<HTMLElement>('#loading-label');
const loadingRoot = document.querySelector<HTMLElement>('#loading');

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
    // Keeps scripted screenshots and pixel probes reading the frame just drawn.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdcebf6);
  scene.fog = new THREE.Fog(0xdcebf6, 70, 150);

  const sunDirection = new THREE.Vector3(0.58, 0.62, 0.36).normalize();
  scene.add(createSkyDome(sunDirection));

  const sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
  sun.castShadow = true;
  const shadowSize = coarse ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
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

  progress(0.04, 'shaping the ground…');

  const [world, clips, knightGltf, minionGltf, warriorGltf, swordGltf, shieldGltf, bladeGltf, axeGltf, largeShieldGltf] =
    await Promise.all([
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
    ]);

  scene.add(world.group);

  progress(0.72, 'arming the knight…');

  const knightWeapons: WeaponSpec[] = [
    { model: weaponFrom(swordGltf), socket: SOCKETS.sword },
    { model: weaponFrom(shieldGltf), socket: SOCKETS.shield },
  ];
  const playerRig = new CharacterRig(knightGltf.scene, clips, knightWeapons);
  scene.add(playerRig.root);

  const player = new Player(playerRig, world);

  const cameraRig = new ThirdPersonCamera(window.innerWidth / window.innerHeight);

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

  const input = new InputController(
    canvas,
    document.querySelector<HTMLButtonElement>('#attack'),
    document.querySelector<HTMLElement>('#stick'),
  );

  player.onAttackHit = (position, forward, attack, hitTargets) => {
    let hits = 0;

    for (const enemy of enemies) {
      if (!enemy.alive || hitTargets.has(enemy)) continue;

      const toEnemy = enemy.position.clone().sub(position).setY(0);
      const distance = toEnemy.length();
      if (distance > attack.range + 0.7) continue;

      if (distance > 0.001) {
        toEnemy.normalize();
        if (Math.acos(Math.min(1, Math.max(-1, toEnemy.dot(forward)))) > attack.arc) continue;
      }

      if (enemy.takeDamage(attack.damage, position)) {
        hitTargets.add(enemy);
        hits += 1;
      }
    }

    if (hits > 0) cameraRig.shake(attack.damage >= 40 ? 0.15 : 0.09);
  };

  for (const enemy of enemies) {
    enemy.onHitPlayer = (damage, from) => {
      player.takeDamage(damage, from);
      hud.flash();
      cameraRig.shake(0.16);
    };
  }

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
    defeated = false;
    lastBanner = null;
    hud.showBanner(null);
    hud.setObjective('Reach the ruin · defeat the skeletons');
  }

  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'r') restart();
  });

  // First paint before the loop starts, so a hidden tab still shows the scene.
  player.update(0, input, cameraRig);
  cameraRig.update(0, player.position, world.heightAt);
  renderer.render(scene, cameraRig.camera);
  hud.setHealth(player.health, player.maxHealth);
  hud.setObjective('Reach the ruin · defeat the skeletons');

  if (loadingRoot) {
    loadingRoot.classList.add('is-hidden');
    window.setTimeout(() => loadingRoot.remove(), 500);
  }

  let previous = performance.now();
  let statsTimer = 0;
  let frames = 0;

  /** One simulation step, shared by the render loop and the test harness. */
  function stepWorld(delta: number): void {
    const look = input.takeLook();
    cameraRig.rotate(look.x, look.y);
    const zoom = input.takeZoom();
    if (zoom !== 0) cameraRig.zoom(zoom);

    player.update(delta, input, cameraRig);

    for (const enemy of enemies) enemy.update(delta, player.position, player.alive);

    // Keep bodies apart without a physics engine.
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const away = enemy.position.clone().sub(player.position).setY(0);
      const gap = away.length();
      if (gap > 0.001 && gap < 1.1) {
        away.normalize().multiplyScalar((1.1 - gap) * 0.6);
        enemy.position.add(away);
      }
    }

    cameraRig.update(delta, player.position, world.heightAt);

    sun.position.copy(player.position).add(new THREE.Vector3(18, 20, 11));
    sun.target.position.copy(player.position);
    sun.target.updateMatrixWorld();

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

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const delta = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    if (document.hidden) return;

    stepWorld(delta);

    hud.setHealth(player.health, player.maxHealth);
    hud.update(delta, cameraRig.camera, window.innerWidth, window.innerHeight);

    renderer.render(scene, cameraRig.camera);

    frames += 1;
    statsTimer += delta;
    if (statsTimer >= 0.5) {
      const alive = enemies.filter((enemy) => enemy.alive).length;
      hud.setStats(
        [
          `fps    ${(frames / statsTimer).toFixed(0)}  (${((statsTimer * 1000) / frames).toFixed(1)} ms)`,
          `draws  ${renderer.info.render.calls}`,
          `tris   ${(renderer.info.render.triangles / 1000).toFixed(1)}k`,
          `hp     ${Math.round(player.health)}  · foes ${alive}`,
        ].join('\n'),
      );
      frames = 0;
      statsTimer = 0;
    }
  });

  // Scripted hook for verification: drives the same input path the player uses.
  (window as unknown as { __play: unknown }).__play = {
    player,
    enemies,
    camera: cameraRig,
    renderer,
    scene,
    sun,
    press: (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key }));
    },
    hold: (key: string, down: boolean) => {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key }));
    },
    teleport: (x: number, z: number) => {
      player.position.set(x, world.heightAt(x, z), z);
      playerRig.root.position.copy(player.position);
      cameraRig.update(0, player.position, world.heightAt);
    },
    snapCamera: (yaw: number, pitch: number) => {
      cameraRig.snap(yaw, pitch);
      cameraRig.update(0, player.position, world.heightAt);
    },
    state: () => ({
      player: {
        x: +player.position.x.toFixed(2),
        y: +player.position.y.toFixed(2),
        z: +player.position.z.toFixed(2),
        hp: Math.round(player.health),
        alive: player.alive,
        clip: playerRig.animator.playing,
        attacking: player.isAttacking,
        blocking: player.isBlocking,
        dodging: player.isDodging,
      },
      enemies: enemies.map((enemy) => ({
        hp: Math.round(enemy.health),
        alive: enemy.alive,
        state: enemy.state,
        clip: enemy.rig.animator.playing,
        x: +enemy.position.x.toFixed(2),
        z: +enemy.position.z.toFixed(2),
      })),
      draws: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    aimAt: (index: number) => {
      const enemy = enemies[index];
      if (!enemy) return;
      player.position.set(enemy.position.x, enemy.position.y, enemy.position.z + 1.8);
      player.yaw = Math.PI;
      playerRig.root.position.copy(player.position);
      cameraRig.update(0, player.position, world.heightAt);
    },
    spawnDistance: ARENA.spawn,
    /** Fixed-step driver: real input state, no timers, fully deterministic. */
    step: (
      frames: number,
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
      } = {},
    ) => {
      input.virtual.x = move.x ?? 0;
      input.virtual.y = move.y ?? 0;
      input.virtual.run = move.run ?? false;
      input.virtual.block = move.block ?? false;
      if (move.attack) input.queueAttack();
      if (move.heavy) input.queueHeavy();
      if (move.dodge) input.queueDodge();
      if (move.jump) input.queueJump();

      for (let i = 0; i < frames; i += 1) stepWorld(delta);

      renderer.render(scene, cameraRig.camera);
      hud.setHealth(player.health, player.maxHealth);
      hud.update(0, cameraRig.camera, window.innerWidth, window.innerHeight);

      return {
        x: +player.position.x.toFixed(2),
        y: +player.position.y.toFixed(2),
        z: +player.position.z.toFixed(2),
        hp: Math.round(player.health),
        alive: player.alive,
        clip: playerRig.animator.playing,
        attacking: player.isAttacking,
        blocking: player.isBlocking,
        dodging: player.isDodging,
        enemies: enemies.map((enemy) => ({
          hp: Math.round(enemy.health),
          alive: enemy.alive,
          state: enemy.state,
          clip: enemy.rig.animator.playing,
        })),
      };
    },
  };
}

boot().catch((error: unknown) => {
  console.error(error);
  progress(0, 'failed to start — see console');
  if (loadingLabel) loadingLabel.textContent = String(error);
});
