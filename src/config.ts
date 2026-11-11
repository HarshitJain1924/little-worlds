/** Palette, world layout and quality presets. All distances are in Kenney kit units. */

export type QualityName = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  maxDpr: number;
  shadows: boolean;
  shadowMapSize: number;
  grass: number;
  flowers: number;
  trees: number;
  clouds: number;
  fogDensity: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: {
    label: 'Low',
    maxDpr: 1,
    shadows: false,
    shadowMapSize: 512,
    grass: 90,
    flowers: 20,
    trees: 12,
    clouds: 6,
    fogDensity: 0.014,
  },
  medium: {
    label: 'Medium',
    maxDpr: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    grass: 190,
    flowers: 34,
    trees: 16,
    clouds: 10,
    fogDensity: 0.010,
  },
  high: {
    label: 'High',
    maxDpr: 2,
    shadows: true,
    shadowMapSize: 2048,
    grass: 300,
    flowers: 42,
    trees: 20,
    clouds: 14,
    fogDensity: 0.007,
  },
};

export const PALETTE = {
  skyTop: 0x4a6cbc,
  skyMid: 0x93b4e4,
  skyHorizon: 0xf7d8ba,
  skyBelow: 0xe6b39c,
  sunGlow: 0xfff1d2,
  fog: 0xf0d3bc,
  grass: 0x2ec9ab,
  grassLight: 0x6ee6c9,
  grassDark: 0x1d9b86,
  dirt: 0xb8754e,
  shore: 0xb9a887,
  rock: 0x7c81aa,
  rockWarm: 0x8d7f9a,
  waterDeep: 0x1d7f8c,
  waterShallow: 0x7de0d2,
  foam: 0xf4fdfa,
};

export const WORLD = {
  radius: 8,
  seed: 20261110,
  sunDirection: [-0.52, 0.6, 0.58] as [number, number, number],
};

export const CAMERA = {
  fov: 34,
  near: 0.5,
  far: 900,
  distance: 27,
  minDistance: 13,
  maxDistance: 38,
  /**
   * Half-extent of the island used to fit it into narrow viewports. The rim now
   * varies by up to ~18%, so this covers the widest lobe with a little margin.
   */
  fitRadius: 9.7,
  pitch: (33 * Math.PI) / 180,
  yaw: (46 * Math.PI) / 180,
  minPitch: (20 * Math.PI) / 180,
  maxPitch: (68 * Math.PI) / 180,
  target: [0, -2.7, 0] as [number, number, number],
};

export const SITES = {
  pond: { x: -2.6, z: 1.9, radius: 2.0, depth: 0.95, waterLevel: -0.38 },
  hut: { x: 4.0, z: 1.5, yaw: -Math.PI / 2, clearing: 1.95 },
  camp: { x: -3.5, z: -3.9, clearing: 1.65 },
};
