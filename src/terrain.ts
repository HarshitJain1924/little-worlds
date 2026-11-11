import * as THREE from 'three';
import { PALETTE, SITES, WORLD } from './config';

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** The island outline is not a perfect circle: the rim radius varies with angle. */
function edgeRadius(angle: number): number {
  return (
    WORLD.radius *
    (1 + Math.sin(angle * 3) * 0.055 + Math.sin(angle * 7 + 1.3) * 0.03 + Math.sin(angle * 11 - 0.6) * 0.015)
  );
}

/** Island surface height at a world position. Shared by the mesh, scatter and props. */
export function terrainHeightAt(x: number, z: number): number {
  const radius = Math.hypot(x, z);

  let height =
    Math.sin(x * 0.62 + Math.cos(z * 0.41) * 1.2) * 0.16 +
    Math.cos(z * 0.78 - 0.4) * 0.11 +
    Math.sin((x + z) * 0.37) * 0.09;

  // Flatten the two built-up sites so a hut and a campfire can sit level.
  const distanceToHut = Math.hypot(x - SITES.hut.x, z - SITES.hut.z);
  const distanceToCamp = Math.hypot(x - SITES.camp.x, z - SITES.camp.z);
  const flatten = Math.min(
    smoothstep(SITES.hut.clearing * 0.55, SITES.hut.clearing, distanceToHut),
    smoothstep(SITES.camp.clearing * 0.5, SITES.camp.clearing, distanceToCamp),
  );
  height *= flatten;

  // Pond basin.
  const distanceToPond = Math.hypot(x - SITES.pond.x, z - SITES.pond.z);
  const basin = 1 - smoothstep(SITES.pond.radius * 0.5, SITES.pond.radius, distanceToPond);
  height -= basin * SITES.pond.depth;

  // A raised lip, then a short steep wall over the edge.
  const edge = edgeRadius(Math.atan2(z, x));
  const rise = Math.exp(-Math.pow((radius - (edge - 1.4)) / 0.85, 2)) * 0.12;
  const rim = smoothstep(edge - 0.85, edge, radius);
  height += rise * (1 - rim);
  height -= rim * 1.2;

  return height;
}

/** Radius and depth of the tapered underside at a given step (0 = rim, 1 = tip). */
function undersideProfile(t: number, angle: number): { radius: number; y: number } {
  const taper = Math.pow(t, 0.82);
  const wobble =
    1 +
    Math.sin(angle * 5 + t * 2.6) * 0.1 +
    Math.sin(angle * 11 - t * 4) * 0.05 +
    Math.sin(angle * 2.3 + t * 7) * 0.04;
  const radius = edgeRadius(angle) * (1 - 0.94 * taper) * wobble;
  const y =
    -1.15 -
    6.4 * Math.pow(t, 0.9) +
    Math.sin(angle * 7 + t * 5) * 0.28 * (1 - t) +
    Math.sin(angle * 3 + 0.7) * 0.16;
  return { radius, y };
}

const grass = new THREE.Color(PALETTE.grass);
const grassLight = new THREE.Color(PALETTE.grassLight);
const grassDark = new THREE.Color(PALETTE.grassDark);
const dirt = new THREE.Color(PALETTE.dirt);
const rock = new THREE.Color(PALETTE.rock);
const rockDeep = new THREE.Color(0x4b4e6e);
const strata = new THREE.Color(0x6f6479);

const colorScratch = new THREE.Color();

function vertexColor(x: number, z: number, height: number): THREE.Color {
  const radius = Math.hypot(x, z);

  const dx = terrainHeightAt(x + 0.5, z) - terrainHeightAt(x - 0.5, z);
  const dz = terrainHeightAt(x, z + 0.5) - terrainHeightAt(x, z - 0.5);
  const slope = Math.min(1, Math.hypot(dx, dz) * 0.8);

  const variation = 0.5 + 0.5 * Math.sin(x * 1.7 + z * 2.3);
  const patches = 0.5 + 0.5 * Math.sin(x * 0.61 - z * 0.47 + Math.sin(x * 0.3) * 1.6);
  colorScratch.copy(grass).lerp(grassLight, variation * 0.4 + patches * 0.28);
  colorScratch.lerp(grassDark, smoothstep(0.5, 1, slope) * 0.5 + patches * 0.12);

  // Earth follows the rim, stone follows depth below the grass line.
  const edge = edgeRadius(Math.atan2(z, x));
  const rim = smoothstep(edge - 1.3, edge, radius);
  colorScratch.lerp(dirt, rim * 0.9);
  colorScratch.lerp(rock, smoothstep(-1.0, -2.4, height));
  colorScratch.lerp(rockDeep, smoothstep(-3.0, -6.5, height));

  return colorScratch;
}

function undersideColor(t: number, angle: number): THREE.Color {
  // Earth only right under the grass, then stone with horizontal strata.
  colorScratch.copy(dirt).lerp(rock, smoothstep(0.0, 0.16, t));
  colorScratch.lerp(rockDeep, smoothstep(0.45, 1, t));

  const band = Math.sin(t * 26 + angle * 2.2) * 0.5 + 0.5;
  colorScratch.lerp(strata, smoothstep(0.55, 1, band) * 0.45);

  return colorScratch;
}

/** Island surface plus its tapered underside, as one radial grid with baked colours. */
export function createTerrain(): THREE.Mesh {
  const rings = 26;
  const skirtRings = 14;
  const segments = 84;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const push = (x: number, y: number, z: number, color: THREE.Color) => {
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b);
  };

  // Grass surface.
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const radius = WORLD.radius * Math.pow(t, 0.92);
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = terrainHeightAt(x, z);
      push(x, y, z, vertexColor(x, z, y));
    }
  }

  // Underside: continues from the rim down to a tip.
  for (let step = 1; step <= skirtRings; step += 1) {
    const t = step / skirtRings;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const { radius, y } = undersideProfile(t, angle);
      push(Math.cos(angle) * radius, y, Math.sin(angle) * radius, undersideColor(t, angle));
    }
  }

  const totalRings = rings + skirtRings;
  for (let ring = 0; ring < totalRings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const a = ring * segments + segment;
      const b = ring * segments + next;
      const c = (ring + 1) * segments + segment;
      const d = (ring + 1) * segments + next;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Close the tip with a fan to a single point.
  const tipIndex = positions.length / 3;
  const tip = undersideProfile(1.02, 0);
  positions.push(0, tip.y - 0.5, 0);
  const tipColor = undersideColor(1, 0);
  colors.push(tipColor.r, tipColor.g, tipColor.b);

  const lastRingStart = (totalRings - 1) * segments;
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(lastRingStart + segment, lastRingStart + next, tipIndex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.96,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'island-surface';
  return mesh;
}
