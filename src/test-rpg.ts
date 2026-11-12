import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Temporary integration proof — not part of the game build.
 * Loads assets straight out of the downloaded KayKit folders (no copies into public/).
 *
 * URL parameters:
 *   ?cam=full|char|grip|env   fixed camera pose for screenshots
 *   ?clip=Walking_A           clip to play on the Knight at load
 *   ?t=0.42                   seconds of animation applied before the first frame
 */

const PACK = {
  adventurers: '/KayKit_Adventurers_2.0_FREE',
  skeletons: '/KayKit_Skeletons_1.1_FREE',
  weapons: '/KayKit_FantasyWeaponsBits_1.0_FREE',
  forest: '/KayKit_Forest_Nature_Pack_1.0_FREE',
  dungeon: '/KayKit_Dungeon_Pack_1.1_FREE',
};

const ASSET = {
  knight: `${PACK.adventurers}/Characters/gltf/Knight.glb`,
  minion: `${PACK.skeletons}/characters/gltf/Skeleton_Minion.glb`,
  warrior: `${PACK.skeletons}/characters/gltf/Skeleton_Warrior.glb`,
  rigGeneral: `${PACK.skeletons}/Animations/gltf/Rig_Medium/Rig_Medium_General.glb`,
  rigMovement: `${PACK.skeletons}/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb`,
  swordA: `${PACK.weapons}/Assets/gltf/sword_A.gltf`,
  shieldA: `${PACK.weapons}/Assets/gltf/shield_A.gltf`,
  blade: `${PACK.skeletons}/assets/gltf/Skeleton_Blade.gltf`,
  shieldLarge: `${PACK.skeletons}/assets/gltf/Skeleton_Shield_Large_A.gltf`,
};

const forestFile = (name: string) => `${PACK.forest}/Assets/gltf/${name}.gltf`;
const dungeonFile = (name: string) => `${PACK.dungeon}/Assets/gltf/${name}.gltf`;

/** Weapon offsets are guesses until the grip close-up is checked. */
const TUNE = {
  sword: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  shield: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  blade: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
};

const params = new URLSearchParams(location.search);
const statsEl = document.querySelector<HTMLDivElement>('#stats');
const errorEl = document.querySelector<HTMLDivElement>('#error');
const clipsEl = document.querySelector<HTMLDivElement>('#clips');

const fail = (message: string) => {
  if (!errorEl) return;
  errorEl.classList.add('show');
  errorEl.textContent = message;
  console.error(message);
};

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  // GLTFLoader passes node names through PropertyBinding.sanitizeNodeName, which
  // strips reserved characters: an authored "handslot.r" arrives as "handslotr".
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = normalize(name);
  let found: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!found && normalize(child.name) === wanted) found = child;
  });
  return found;
}

function shadowed(object: THREE.Object3D): THREE.Object3D {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return object;
}

function equip(
  character: THREE.Object3D,
  weapon: THREE.Object3D,
  boneName: string,
  tune: { position: number[]; rotation: number[]; scale: number },
): boolean {
  const bone = findNode(character, boneName);
  if (!bone) {
    fail(`Bone "${boneName}" not found on the character`);
    return false;
  }
  const local = new THREE.Box3().setFromObject(weapon);
  weapon.position.set(tune.position[0], tune.position[1], tune.position[2]);
  weapon.rotation.set(tune.rotation[0], tune.rotation[1], tune.rotation[2]);
  weapon.scale.setScalar(tune.scale);
  bone.add(weapon);

  const box = new THREE.Box3().setFromObject(weapon);
  const size = box.getSize(new THREE.Vector3());
  console.info(
    `equip ${weapon.name || 'weapon'} → ${bone.name} | local pivot z ${local.min.z.toFixed(2)}..${local.max.z.toFixed(2)} y ${local.min.y.toFixed(2)}..${local.max.y.toFixed(2)} | world size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`,
  );
  return true;
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  if (!canvas) throw new Error('canvas missing');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8cf);
  scene.fog = new THREE.Fog(0x9fb8cf, 34, 78);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 300);

  // Daylight key + sky fill, matching the island's warm/cool split.
  const sun = new THREE.DirectionalLight(0xfff2df, 2.6);
  sun.position.set(9, 14, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xc7dcff, 0x5b6a52, 1.15));

  // Ground so shadows and scale read.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0x6f9a63, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const loader = new GLTFLoader();
  THREE.Cache.enabled = true;
  const load = (url: string) => loader.loadAsync(url);

  const [knightGltf, minionGltf, warriorGltf, generalGltf, movementGltf] = await Promise.all([
    load(ASSET.knight),
    load(ASSET.minion),
    load(ASSET.warrior),
    load(ASSET.rigGeneral),
    load(ASSET.rigMovement),
  ]);

  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of [...generalGltf.animations, ...movementGltf.animations]) {
    clips.set(clip.name, clip);
  }

  // ---- characters -------------------------------------------------------
  const knight = shadowed(knightGltf.scene);
  knight.position.set(0, 0, 0);
  knight.rotation.y = 0.3;
  scene.add(knight);

  const minion = shadowed(minionGltf.scene);
  minion.position.set(1.9, 0, -2.5);
  minion.rotation.y = Math.atan2(0 - 1.9, 0 - -2.5);
  scene.add(minion);

  const warrior = shadowed(warriorGltf.scene);
  warrior.position.set(4.9, 0, -1.9);
  warrior.rotation.y = Math.atan2(0 - 4.9, 0 - -1.9);
  scene.add(warrior);

  // ---- weapons ----------------------------------------------------------
  const [swordGltf, shieldGltf, bladeGltf, shieldLargeGltf] = await Promise.all([
    load(ASSET.swordA),
    load(ASSET.shieldA),
    load(ASSET.blade),
    load(ASSET.shieldLarge),
  ]);

  const sword = shadowed(swordGltf.scene);
  sword.name = 'sword_A';
  equip(knight, sword, 'handslot.r', TUNE.sword);

  const handSlot = findNode(knight, 'handslot.r');
  if (handSlot) {
    console.info('knight bone names:', handSlot.name);
  }

  const shield = shadowed(shieldGltf.scene);
  shield.name = 'shield_A';
  equip(knight, shield, 'handslot.l', TUNE.shield);

  const blade = shadowed(bladeGltf.scene);
  blade.name = 'Skeleton_Blade';
  equip(minion, blade, 'handslot.r', TUNE.blade);

  const enemyShield = shadowed(shieldLargeGltf.scene);
  enemyShield.name = 'Skeleton_Shield_Large_A';
  equip(warrior, enemyShield, 'handslot.l', TUNE.shield);

  // ---- animation --------------------------------------------------------
  const knightMixer = new THREE.AnimationMixer(knight);
  const minionMixer = new THREE.AnimationMixer(minion);
  const warriorMixer = new THREE.AnimationMixer(warrior);

  const idle = clips.get('Idle_A');
  if (idle) {
    minionMixer.clipAction(idle).play();
    warriorMixer.clipAction(idle).play();
  }

  let active: THREE.AnimationAction | null = null;
  let activeName = '';

  const play = (name: string) => {
    const clip = clips.get(name);
    if (!clip) {
      fail(`Clip "${name}" not found (${clips.size} loaded)`);
      return;
    }
    const action = knightMixer.clipAction(clip);
    if (active && active !== action) active.fadeOut(0.18);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    if (name.startsWith('Death') || name.startsWith('Hit') || name.startsWith('Jump_Start')) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    action.fadeIn(0.18).play();
    active = action;
    activeName = name;

    for (const button of clipsEl?.querySelectorAll('button') ?? []) {
      button.setAttribute('aria-pressed', String(button.textContent === name));
    }
  };

  const BUTTONS = [
    'Idle_A',
    'Walking_A',
    'Running_A',
    'Jump_Start',
    'Hit_A',
    'Death_A',
    'Use_Item',
    'Interact',
  ];
  for (const name of BUTTONS) {
    if (!clips.has(name)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => play(name));
    clipsEl?.append(button);
  }

  const wanted = params.get('clip');
  if (wanted && clips.has(wanted)) play(wanted);
  else if (idle) play('Idle_A');

  // ---- environment: KayKit Forest --------------------------------------
  const FOREST: [string, number, number, number, number][] = [
    ['Tree_1_A_Color1', -4.6, -2.6, 0.9, 0.4],
    ['Tree_2_B_Color1', -7.2, 0.4, 1.05, 1.9],
    ['Tree_3_A_Color1', -3.4, -5.4, 0.95, 3.1],
    ['Tree_4_B_Color1', -8.4, -3.6, 1.0, 5.0],
    ['Tree_Bare_1_A_Color1', -1.9, -3.4, 0.85, 2.2],
    ['Bush_1_A_Color1', -2.2, 1.4, 1.0, 0.7],
    ['Bush_3_B_Color1', -5.6, -1.2, 1.1, 2.8],
    ['Bush_2_C_Color1', -3.0, -0.4, 0.9, 4.4],
    ['Rock_1_B_Color1', -1.3, 1.9, 1.0, 1.2],
    ['Rock_2_A_Color1', -6.2, -4.6, 1.2, 0.2],
    ['Rock_3_C_Color1', -4.2, 0.6, 0.85, 3.6],
    ['Grass_1_A_Color1', -3.6, 1.0, 1.4, 1.1],
    ['Grass_2_B_Color1', -5.0, -2.0, 1.3, 2.5],
  ];

  await Promise.all(
    FOREST.map(async ([name, x, z, scale, yaw]) => {
      const gltf = await load(forestFile(name));
      const object = shadowed(gltf.scene);
      object.position.set(x, 0, z);
      object.rotation.y = yaw;
      object.scale.setScalar(scale);
      scene.add(object);
    }),
  );

  // ---- environment: KayKit Dungeon -------------------------------------
  const place = async (
    name: string,
    x: number,
    y: number,
    z: number,
    yaw = 0,
    scale = 1,
  ): Promise<THREE.Object3D> => {
    const gltf = await load(dungeonFile(name));
    const object = shadowed(gltf.scene);
    object.position.set(x, y, z);
    object.rotation.y = yaw;
    object.scale.setScalar(scale);
    scene.add(object);
    return object;
  };

  // 2 x 2 floor of 4-unit tiles, so the modular grid is visible.
  const FLOOR: [number, number][] = [
    [7, -8],
    [11, -8],
    [7, -4],
    [11, -4],
  ];
  await Promise.all(FLOOR.map(([x, z]) => place('floor_tile_large', x, 0.075, z)));

  await Promise.all([
    place('wall', 9, 2, -10.4),
    place('wall', 5.4, 2, -6.5, Math.PI / 2),
    place('wall', 12.6, 2, -6.5, Math.PI / 2),
    place('wall_doorway', 9, 2, -1.6),
    place('pillar', 6.2, 0, -2.6),
    place('pillar', 11.8, 0, -2.6),
  ]);

  const torchPositions: [number, number, number][] = [
    [6.6, 2.9, -9.9],
    [11.4, 2.9, -9.9],
  ];
  for (const [x, y, z] of torchPositions) {
    await place('torch_lit', x, y, z);
    const light = new THREE.PointLight(0xffb766, 9, 11, 2);
    light.position.set(x, y, z + 0.4);
    scene.add(light);
  }

  // ---- camera poses ----------------------------------------------------
  const fovFor = (pose: string) => (pose === 'grip' ? 38 : pose === 'char' ? 40 : pose === 'full' ? 50 : 45);

  const applyCamera = (pose: string) => {
    camera.fov = fovFor(pose);
    camera.updateProjectionMatrix();

    if (pose === 'char') {
      camera.position.set(1.55, 1.55, 2.05);
      camera.lookAt(0, 1.2, 0);
      return;
    }
    if (pose === 'mid') {
      camera.position.set(3.3, 2.5, 4.7);
      camera.lookAt(0, 1.05, 0);
      return;
    }
    if (pose === 'grip') {
      const target = findNode(knight, 'handslot.r') ?? knight;
      const hand = new THREE.Vector3();
      knight.updateMatrixWorld(true);
      target.getWorldPosition(hand);
      // Approach the hand down the same line as the wider shot, so the grip is
      // never hidden behind the torso.
      const viewLine = new THREE.Vector3(8.2, 6.2, 16.2).sub(hand).normalize();
      camera.position.copy(hand).addScaledVector(viewLine, 1.6).add(new THREE.Vector3(0, 0.12, 0));
      camera.lookAt(hand);
      return;
    }
    if (pose === 'env') {
      camera.position.set(1.8, 3.0, 12.0);
      camera.lookAt(9.0, 1.8, -6.5);
      return;
    }
    camera.position.set(8.2, 6.2, 16.2);
    camera.lookAt(6.2, 1.35, -4.2);
  };

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  // ---- settle animation, then paint one frame synchronously ------------
  const settle = Number(params.get('t') ?? '0.45');
  knightMixer.update(settle);
  minionMixer.update(settle * 0.8);
  warriorMixer.update(settle * 1.3);
  scene.updateMatrixWorld(true);

  applyCamera(params.get('cam') ?? 'full');
  renderer.render(scene, camera);

  // Console hook used for scripted captures; temporary, like everything here.
  (window as unknown as { __rpg: unknown }).__rpg = {
    setPose: (pose: string) => {
      applyCamera(pose);
      renderer.render(scene, camera);
    },
    setClip: (name: string, seconds = 0.42) => {
      play(name);
      knightMixer.update(seconds);
      scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
    },
    swing: (seconds: number) => {
      knightMixer.update(seconds);
      scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
    },
    /** Renders up to four clips into a 2x2 sheet laid over the page. */
    sheet: (names: string[], pose = 'char') => {
      const width = Math.floor(window.innerWidth / 2);
      const height = Math.floor(window.innerHeight / 2);
      const sheet = document.createElement('canvas');
      sheet.width = width * 2;
      sheet.height = height * 2;
      sheet.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:5;background:#0d1117';
      const context = sheet.getContext('2d');
      if (!context) return 0;

      names.forEach((name, index) => {
        const clip = clips.get(name);
        if (!clip) return;
        // Hard cut instead of a crossfade: every cell must be one clip at full weight.
        knightMixer.stopAllAction();
        const action = knightMixer.clipAction(clip);
        action.reset();
        action.setEffectiveWeight(1);
        action.play();
        knightMixer.update(name.startsWith('Death') ? 0.72 : name.startsWith('Jump') ? 0.28 : 0.5);
        scene.updateMatrixWorld(true);
        applyCamera(pose);
        renderer.render(scene, camera);
        const column = index % 2;
        const row = Math.floor(index / 2);
        context.drawImage(renderer.domElement, column * width, row * height, width, height);
        context.fillStyle = 'rgba(13,17,23,0.72)';
        context.fillRect(column * width, row * height, width, 26);
        context.fillStyle = '#7ee2c4';
        context.font = '600 14px ui-monospace, monospace';
        context.fillText(name, column * width + 10, row * height + 18);
      });

      document.body.append(sheet);
      return names.length;
    },
    clearSheet: () => {
      document.querySelectorAll('canvas[style*="z-index:5"]').forEach((node) => node.remove());
    },
  };

  if (statsEl) {
    statsEl.textContent = [
      `draws  ${renderer.info.render.calls}`,
      `tris   ${(renderer.info.render.triangles / 1000).toFixed(1)}k`,
      `clips  ${clips.size}`,
      `clip   ${activeName}`,
      `bones  ${(() => {
        let count = 0;
        knight.traverse((o) => {
          if ((o as THREE.Bone).isBone) count += 1;
        });
        return count;
      })()}`,
    ].join('\n');
  }

  // ---- loop ------------------------------------------------------------
  let previous = performance.now();
  let frames = 0;
  let timer = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const delta = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (document.hidden) return;

    knightMixer.update(delta);
    minionMixer.update(delta);
    warriorMixer.update(delta);
    renderer.render(scene, camera);

    frames += 1;
    timer += delta;
    if (timer >= 0.5 && statsEl) {
      statsEl.textContent = [
        `fps    ${(frames / timer).toFixed(0)}  (${((timer * 1000) / frames).toFixed(1)} ms)`,
        `draws  ${renderer.info.render.calls}`,
        `tris   ${(renderer.info.render.triangles / 1000).toFixed(1)}k`,
        `clips  ${clips.size}`,
        `clip   ${activeName}`,
      ].join('\n');
      frames = 0;
      timer = 0;
    }
  });
}

boot().catch((error: unknown) => {
  fail(`Failed to load: ${error instanceof Error ? error.message : String(error)}`);
});
