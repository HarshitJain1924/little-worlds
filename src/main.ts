import * as THREE from 'three';
import { PALETTE, QUALITY, SITES } from './config';
import type { QualityName } from './config';
import { ModelLibrary } from './assets';
import { buildIsland } from './island';
import { createTerrain } from './terrain';
import { createClouds, createLighting, createSky, createWater } from './environment';
import { OrbitCamera } from './camera';
import { createQualityControl, createStats, hideLoading, setLoading } from './ui';

const QUALITY_KEY = 'little-worlds.quality';

interface ExtendedNavigator extends Navigator {
  deviceMemory?: number;
}

function isQualityName(value: string | null): value is QualityName {
  return value === 'low' || value === 'medium' || value === 'high';
}

/** Device-aware starting preset; coarse pointers are treated as the weaker target. */
function detectQuality(): QualityName {
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const memory = (navigator as ExtendedNavigator).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;

  if (coarsePointer) {
    return memory >= 6 && cores >= 6 ? 'medium' : 'low';
  }

  // Logical cores say nothing about the GPU: a 4-core laptop with a dedicated
  // card and an 8-core one on integrated graphics both report a high count, and
  // deviceMemory only reveals the RAM tier. Start conservative and let High be
  // an explicit opt-in (remembered once chosen) instead of guessing.
  return 'medium';
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  if (!canvas) throw new Error('Canvas element missing');

  const stored = localStorage.getItem(QUALITY_KEY);
  let current: QualityName = isQualityName(stored) ? stored : detectQuality();

  // Antialiasing is fixed when the context is created, so it is decided from the
  // starting preset: the weakest devices render without MSAA.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: current !== 'low',
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[current].maxDpr));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Neutral tone mapping keeps the pastel palette from being washed out.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.fog);
  scene.fog = new THREE.FogExp2(PALETTE.fog, QUALITY[current].fogDensity);

  const orbit = new OrbitCamera(canvas, window.innerWidth / window.innerHeight);
  // Read the real context flag: MSAA is fixed at context creation, so the panel
  // must report it rather than assume it follows the selected preset.
  const stats = createStats({ antialias: renderer.getContextAttributes()?.antialias ?? false });

  setLoading(0.02, 'loading models…');
  const models = new ModelLibrary();
  await models.loadAll((fraction) => setLoading(0.05 + fraction * 0.85));

  setLoading(0.94, 'shaping the island…');

  const lighting = createLighting();
  scene.add(lighting.sun, lighting.sun.target, lighting.hemisphere);
  scene.add(createSky(lighting.sunDirection));

  const clouds = createClouds();
  scene.add(clouds.group);

  scene.add(createTerrain());
  scene.add(createWater(SITES.pond.radius * 0.82, SITES.pond.waterLevel));

  const island = buildIsland(models);
  scene.add(island.root);

  const water = scene.getObjectByName('pond-water') as THREE.Mesh | undefined;
  const waterMaterial = water?.material as THREE.ShaderMaterial | undefined;

  const syncQualityButton = createQualityControl(current, (name) => applyQuality(name));

  function applyQuality(name: QualityName): void {
    current = name;
    const preset = QUALITY[name];

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.maxDpr));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    scene.fog = new THREE.FogExp2(PALETTE.fog, preset.fogDensity);

    lighting.sun.castShadow = preset.shadows;
    if (preset.shadows) {
      lighting.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      lighting.sun.shadow.map?.dispose();
      lighting.sun.shadow.map = null;
    }

    clouds.setCount(preset.clouds);
    island.applyDensity({ grass: preset.grass, flowers: preset.flowers, trees: preset.trees });

    syncQualityButton(name);
    try {
      localStorage.setItem(QUALITY_KEY, name);
    } catch {
      /* storage can be unavailable in private mode; the preset still applies */
    }
  }

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    orbit.setAspect(width / height);
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, QUALITY[current].maxDpr),
    );
    renderer.setSize(width, height, false);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  applyQuality(current);

  // Paint one frame immediately so the scene is visible even if the tab starts
  // in the background (animation frames are paused while a tab is hidden).
  orbit.update(0);
  renderer.render(scene, orbit.camera);
  stats.update(
    {
      fps: null,
      frameMs: null,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    },
    current,
  );
  setLoading(1, 'ready');
  hideLoading();

  let previous = performance.now();
  let statsTimer = 0;
  let frames = 0;
  let layoutWidth = canvas.clientWidth;
  let layoutHeight = canvas.clientHeight;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const delta = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (document.hidden) return;

    // A viewport can change without a resize event (mobile chrome, split view,
    // dev panels). Poll the canvas box so the framing can never go stale.
    if (canvas.clientWidth !== layoutWidth || canvas.clientHeight !== layoutHeight) {
      layoutWidth = canvas.clientWidth;
      layoutHeight = canvas.clientHeight;
      resize();
    }

    orbit.update(delta);
    clouds.update(delta);
    if (waterMaterial) waterMaterial.uniforms.uTime.value += delta;

    renderer.render(scene, orbit.camera);

    frames += 1;
    statsTimer += delta;
    if (statsTimer >= 0.5) {
      const fps = frames / statsTimer;
      stats.update(
        {
          fps,
          frameMs: (statsTimer * 1000) / frames,
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        },
        current,
      );
      frames = 0;
      statsTimer = 0;
    }
  });

}

boot().catch((error: unknown) => {
  console.error(error);
  setLoading(0, 'failed to start — see console');
});
