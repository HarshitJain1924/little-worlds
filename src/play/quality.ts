import * as THREE from 'three';

/**
 * Quality presets. Everything here trades a measurable cost (fill rate, shadow
 * resolution, foliage shadow casters) for image quality, and nothing changes the
 * simulation.
 */
export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  /** Upper bound on devicePixelRatio. */
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowType: THREE.ShadowMapType;
  /** Instanced foliage casts shadows; the largest single shadow cost. */
  foliageShadows: boolean;
  fogNear: number;
  fogFar: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: {
    label: 'low',
    pixelRatioCap: 1,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
    foliageShadows: false,
    fogNear: 45,
    fogFar: 95,
  },
  medium: {
    label: 'medium',
    pixelRatioCap: 1.35,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
    foliageShadows: true,
    fogNear: 60,
    fogFar: 130,
  },
  high: {
    label: 'high',
    pixelRatioCap: 2,
    shadowMapSize: 2048,
    shadowType: THREE.PCFSoftShadowMap,
    foliageShadows: true,
    fogNear: 70,
    fogFar: 150,
  },
};

const STORAGE_KEY = 'littleworlds.quality';

export function defaultQuality(coarsePointer: boolean): QualityLevel {
  return coarsePointer ? 'low' : 'medium';
}

/** URL override wins, then the stored preference, then the device default. */
export function readQualityPreference(coarsePointer: boolean): QualityLevel {
  const requested = new URLSearchParams(window.location.search).get('quality');
  if (requested === 'low' || requested === 'medium' || requested === 'high') return requested;

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'low' || stored === 'medium' || stored === 'high') return stored;

  return defaultQuality(coarsePointer);
}

export function storeQualityPreference(level: QualityLevel): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Private mode / blocked storage: the session still runs with the choice.
  }
}

export interface QualityTargets {
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  scene: THREE.Scene;
  foliage: THREE.Object3D;
}

export function applyQuality(level: QualityLevel, targets: QualityTargets): QualityPreset {
  const preset = QUALITY[level];
  const { renderer, sun, scene, foliage } = targets;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap));

  renderer.shadowMap.type = preset.shadowType;

  if (sun.shadow.mapSize.x !== preset.shadowMapSize) {
    sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    // Changing the size needs a fresh render target on the next shadow pass.
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }

  foliage.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh) child.castShadow = preset.foliageShadows;
  });

  if (scene.fog instanceof THREE.Fog) {
    scene.fog.near = preset.fogNear;
    scene.fog.far = preset.fogFar;
  }

  renderer.setSize(window.innerWidth, window.innerHeight, false);
  return preset;
}
