/**
 * Layout and terrain for the first town.
 *
 * Everything here is plain data plus closed-form geometry: no three.js, no DOM.
 * `world.ts` turns these placements into instanced meshes, while the tests can
 * check spawn safety, footprints and connectivity directly.
 *
 * Conventions
 * - The kit (Kenney Fantasy Town) is authored on a 1 m grid; `TILE` is the town
 *   grid. One kit tile is 2 m in the world, so a wall module is 2 m wide and 2 m
 *   tall and a character (1.7 m) fits a doorway comfortably.
 * - A building's door faces its local +Z. `yaw` rotates the whole building, so
 *   door positions can be derived without a second convention.
 */
import type { CameraObstacle } from './collision';

export const TILE = 2;

/** Ridge height above the eaves, measured from the kit's `roof-high-gable`. */
export const ROOF_RISE = 1.16 * TILE;

export interface Vec2 {
  x: number;
  z: number;
}

export const TOWN = {
  /** Playable edge: enemies leash inside this, the ground rim rises beyond it. */
  radius: 40,
  seed: 20261116,
  /** South gate, on the approach street, looking north at the plaza. */
  spawn: { x: 0, z: 23 },
  plaza: { x: 0, z: 0, radius: 7.6 },
  /** Sealed ancient entrance beyond the last houses. */
  gate: { x: 0, z: -29 },
  windmill: { x: -23, z: -19 },
} as const;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Soft rolling ground for the outskirts; the town itself is levelled. */
function rolling(x: number, z: number): number {
  return (
    Math.sin(x * 0.07 + 0.4) * Math.cos(z * 0.058 - 0.2) * 0.7 +
    Math.sin((x - z) * 0.041 + 1.3) * 0.35 +
    Math.cos(x * 0.11 + z * 0.07) * 0.18
  );
}

/**
 * Walkable height field. The plaza, every building site and the street grid sit
 * on flat ground (height 0), the sealed gate stands on its own raised plateau,
 * and the rim beyond the playable edge lifts into the treeline so the boundary
 * reads as terrain rather than an invisible wall.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x - TOWN.plaza.x, z - TOWN.plaza.z);
  const town = 1 - smoothstep(19, 30, r);
  const spawn = 1 - smoothstep(5, 13, Math.hypot(x - TOWN.spawn.x, z - TOWN.spawn.z));

  // The gate terrace rises north of the last house, over the whole width of the
  // arch, so the sealed court is level and the town itself never tilts.
  const terrace =
    smoothstep(-19.5, -24.5, z) * smoothstep(20, 9, Math.abs(x - TOWN.gate.x));

  // Two banks: a wooded rise right past the playable edge, then a farther ridge
  // that hides the end of the ground mesh from every street in town.
  const rim = smoothstep(35, 50, r);
  const farRim = smoothstep(50, 72, r);

  const open = (1 - town) * (1 - terrace) * (1 - 0.85 * spawn);

  return rolling(x, z) * open + 2.4 * terrace + rim * 3.4 + farRim * 5.5;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type PathKind = 'stone' | 'dirt';

export interface PathSpec {
  points: Vec2[];
  width: number;
  kind: PathKind;
}

/**
 * The street network. Every building door opens onto one of these spurs, so the
 * town reads as streets between houses instead of houses on a lawn.
 */
export const PATHS: PathSpec[] = [
  { points: [{ x: 0, z: 27 }, { x: 0, z: 8 }], width: 5, kind: 'stone' },
  { points: [{ x: 0, z: -7 }, { x: 0, z: -9.4 }], width: 4.4, kind: 'stone' },
  { points: [{ x: 0, z: -9.4 }, { x: -3.2, z: -10.7 }], width: 3.4, kind: 'stone' },
  { points: [{ x: 6.6, z: -1 }, { x: 11.2, z: -1.5 }], width: 4.2, kind: 'stone' },
  { points: [{ x: -6.6, z: -1 }, { x: -11.2, z: -2.5 }], width: 4.2, kind: 'stone' },
  { points: [{ x: 5.8, z: 5 }, { x: 7.4, z: 8.9 }], width: 3.4, kind: 'stone' },
  { points: [{ x: -5.8, z: 5 }, { x: -7.4, z: 8.6 }], width: 3.4, kind: 'stone' },
  { points: [{ x: 9.4, z: -1.3 }, { x: 10.3, z: -10.4 }], width: 3.2, kind: 'stone' },
  { points: [{ x: -9.6, z: -2 }, { x: -10.4, z: -11 }], width: 3.2, kind: 'stone' },
  { points: [{ x: 2.6, z: -9.4 }, { x: 4.2, z: -13.8 }, { x: 3.2, z: -19.6 }, { x: 0.8, z: -23.8 }, { x: 0, z: -25.6 }], width: 3.2, kind: 'stone' },
  { points: [{ x: 4.2, z: -17.2 }, { x: 5, z: -17.4 }], width: 3, kind: 'stone' },
  { points: [{ x: -6.9, z: 1.2 }, { x: -10.2, z: 5 }, { x: -13.6, z: 9.4 }, { x: -18, z: 15 }, { x: -22, z: 21 }], width: 3.4, kind: 'dirt' },
];

export interface NearestPath {
  distance: number;
  path: PathSpec;
}

function segmentDistance(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-9) return Math.hypot(px - a.x, pz - a.z);
  const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSquared));
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/** Closest path centreline, with the path itself so callers can use its width. */
export function nearestPath(x: number, z: number): NearestPath {
  let best: NearestPath = { distance: Number.POSITIVE_INFINITY, path: PATHS[0] };
  for (const path of PATHS) {
    for (let i = 0; i < path.points.length - 1; i += 1) {
      const distance = segmentDistance(x, z, path.points[i], path.points[i + 1]);
      if (distance < best.distance) best = { distance, path };
    }
  }
  return best;
}

/** Distance from the nearest street centreline, used to keep props off the road. */
export function pathDistance(x: number, z: number): number {
  return nearestPath(x, z).distance;
}

/** 1 on cobbles (plaza, stone streets, gate court), 0 on grass. */
export function pavingFactor(x: number, z: number): number {
  const plaza = smoothstep(
    TOWN.plaza.radius + 1.2,
    TOWN.plaza.radius - 1.2,
    Math.hypot(x - TOWN.plaza.x, z - TOWN.plaza.z),
  );

  const near = nearestPath(x, z);
  const street =
    near.path.kind === 'stone'
      ? smoothstep(near.path.width * 0.5 + 1.1, near.path.width * 0.5 - 0.9, near.distance)
      : 0;

  const gate = smoothstep(8.5, 4.2, Math.hypot(x - TOWN.gate.x, z - TOWN.gate.z));
  return Math.max(plaza, street, gate);
}

/** 1 on trodden dirt (the forest route), 0 elsewhere. */
export function dirtFactor(x: number, z: number): number {
  const near = nearestPath(x, z);
  if (near.path.kind !== 'dirt') return 0;
  return smoothstep(near.path.width * 0.5 + 1.8, near.path.width * 0.5 - 0.6, near.distance);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingTone = 'plaster' | 'timber';

export interface BuildingSpec {
  id: string;
  label: string;
  x: number;
  z: number;
  yaw: number;
  /** Footprint in kit tiles. */
  width: number;
  depth: number;
  levels: number;
  tone: BuildingTone;
  /** Direction the ridge runs in the building's local frame. */
  ridge: 'x' | 'z';
  roof: 'gable' | 'detail';
  chimney?: boolean;
  /** Open lean-to workshop along the local +X wall. */
  awning?: boolean;
}

/**
 * Eight buildings around the plaza. The guild closes the north side, the tavern
 * and smith face each other across the east-west lane, and the homes are tucked
 * behind the market with a storehouse behind the guild.
 */
export const BUILDINGS: BuildingSpec[] = [
  {
    id: 'guild',
    label: 'Adventurers’ Guild',
    x: -3.5,
    z: -13,
    yaw: 0,
    width: 3,
    depth: 2,
    levels: 2,
    tone: 'plaster',
    ridge: 'x',
    roof: 'detail',
    chimney: true,
  },
  {
    id: 'tavern',
    label: 'The Wandering Lantern',
    x: 13.5,
    z: -1.5,
    yaw: -Math.PI / 2,
    width: 3,
    depth: 2,
    levels: 2,
    tone: 'timber',
    ridge: 'z',
    roof: 'detail',
    chimney: true,
  },
  {
    id: 'blacksmith',
    label: 'Smithy',
    x: -13.5,
    z: -2.5,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'timber',
    ridge: 'x',
    roof: 'gable',
    awning: true,
  },
  {
    id: 'house-a',
    label: 'Weaver’s House',
    x: -9.5,
    z: 9,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 2,
    tone: 'plaster',
    ridge: 'z',
    roof: 'gable',
  },
  {
    id: 'house-b',
    label: 'Fisher’s House',
    x: 9.5,
    z: 9.5,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'plaster',
    ridge: 'x',
    roof: 'gable',
    chimney: true,
  },
  {
    id: 'house-c',
    label: 'Hunter’s House',
    x: 12.5,
    z: -11,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 2,
    tone: 'timber',
    ridge: 'x',
    roof: 'detail',
  },
  {
    id: 'house-d',
    label: 'Woodcutter’s House',
    x: -12.5,
    z: -11.5,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'timber',
    ridge: 'z',
    roof: 'gable',
  },
  {
    id: 'storehouse',
    label: 'Storehouse',
    x: 7.2,
    z: -17.5,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'plaster',
    ridge: 'x',
    roof: 'gable',
  },
];

export const buildingById = (id: string): BuildingSpec => {
  const found = BUILDINGS.find((building) => building.id === id);
  if (!found) throw new Error(`unknown building ${id}`);
  return found;
};

export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned hull of a rotated building footprint. */
export function footprintOf(x: number, z: number, halfX: number, halfZ: number, yaw: number): Footprint {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const extentX = halfX * c + halfZ * s;
  const extentZ = halfX * s + halfZ * c;
  return { minX: x - extentX, maxX: x + extentX, minZ: z - extentZ, maxZ: z + extentZ };
}

export function buildingFootprint(building: BuildingSpec): Footprint {
  return footprintOf(
    building.x,
    building.z,
    (building.width * TILE) / 2,
    (building.depth * TILE) / 2,
    building.yaw,
  );
}

/** Rotate a local offset into world space (matches Object3D.rotation.y). */
export function rotate(localX: number, localZ: number, yaw: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: localX * c + localZ * s, z: -localX * s + localZ * c };
}

/** Point inside a building's rotated rectangle, padded by `margin`. */
export function isInsideBuilding(x: number, z: number, margin = 0): boolean {
  for (const building of BUILDINGS) {
    const c = Math.cos(building.yaw);
    const s = Math.sin(building.yaw);
    const dx = x - building.x;
    const dz = z - building.z;
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    const halfW = (building.width * TILE) / 2 + margin;
    const halfD = (building.depth * TILE) / 2 + margin;
    if (Math.abs(localX) <= halfW && Math.abs(localZ) <= halfD) return true;
  }
  return false;
}

/** Middle of the front wall, i.e. where the door opens. */
export function doorPoint(building: BuildingSpec): Vec2 {
  const local = rotate(0, (building.depth * TILE) / 2, building.yaw);
  return { x: building.x + local.x, z: building.z + local.z };
}

/** Wall top plus roof ridge, used for camera proxies and tests. */
export function buildingHeight(building: BuildingSpec): number {
  return building.levels * TILE + ROOF_RISE;
}

// ---------------------------------------------------------------------------
// Module placements
// ---------------------------------------------------------------------------

export interface TownPlacement {
  module: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Extra scale on the module's local Z (roofs stretch across the house depth). */
  stretchZ?: number;
}

const frontModule = (building: BuildingSpec, level: number, index: number): string => {
  if (level === 0) return building.tone === 'timber' ? 'wall-wood' : 'wall';
  return index % 2 === 0 ? 'wall-wood-window-small' : 'wall-wood';
};

const backModule = (building: BuildingSpec, level: number, index: number): string => {
  if (level === 0) return building.tone === 'timber' ? 'wall-wood' : 'wall';
  return index === Math.floor(building.width / 2) ? 'wall-wood-window-small' : 'wall-wood';
};

const sideModule = (building: BuildingSpec, level: number, index: number): string => {
  if (level === 0) return building.tone === 'timber' ? 'wall-wood' : 'wall';
  return index === Math.floor(building.depth / 2) ? 'wall-wood-window-small' : 'wall-wood';
};

/**
 * Walls and roof for one building, in world space. Walls tile on the 2 m grid:
 * front and back walls span the full width, side walls close the ends, and the
 * ridge row covers the footprint with a slight eave overhang.
 */
export function buildingPlacements(building: BuildingSpec): TownPlacement[] {
  const out: TownPlacement[] = [];
  const ground = heightAt(building.x, building.z) + 0.02;
  const halfW = (building.width * TILE) / 2;
  const halfD = (building.depth * TILE) / 2;
  const doorIndex = Math.floor((building.width - 1) / 2);
  // Closed door panels: the town has no interiors yet, so a solid door reads
  // better than looking into an empty shell.
  const door = building.tone === 'timber' ? 'wall-wood-door' : 'wall-door';

  const put = (
    module: string,
    localX: number,
    localZ: number,
    y: number,
    moduleYaw: number,
    scale: number,
    stretchZ?: number,
  ): void => {
    const point = rotate(localX, localZ, building.yaw);
    out.push({
      module,
      x: building.x + point.x,
      y,
      z: building.z + point.z,
      yaw: building.yaw + moduleYaw,
      scale,
      stretchZ,
    });
  };

  for (let level = 0; level < building.levels; level += 1) {
    const y = ground + level * TILE;

    for (let i = 0; i < building.width; i += 1) {
      const localX = -halfW + TILE / 2 + i * TILE;
      const front = level === 0 && i === doorIndex ? door : frontModule(building, level, i);
      put(front, localX, halfD - TILE / 2, y, -Math.PI / 2, TILE);
      put(backModule(building, level, i), localX, -halfD + TILE / 2, y, Math.PI / 2, TILE);
    }

    for (let i = 0; i < building.depth; i += 1) {
      const localZ = -halfD + TILE / 2 + i * TILE;
      put(sideModule(building, level, i), -halfW + TILE / 2, localZ, y, Math.PI, TILE);
      put(sideModule(building, level, i), halfW - TILE / 2, localZ, y, 0, TILE);
    }
  }

  const roofY = ground + building.levels * TILE;
  const roofModule = building.roof === 'detail' ? 'roof-high-gable-detail' : 'roof-high-gable';
  const across = building.ridge === 'x' ? building.depth : building.width;
  const ridgeCount = building.ridge === 'x' ? building.width : building.depth;

  for (let i = 0; i < ridgeCount; i += 1) {
    if (building.ridge === 'x') {
      put(roofModule, -halfW + TILE / 2 + i * TILE, 0, roofY, 0, TILE, across + 0.2);
    } else {
      put(roofModule, 0, -halfD + TILE / 2 + i * TILE, roofY, Math.PI / 2, TILE, across + 0.2);
    }
  }

  if (building.chimney) {
    put('chimney', -halfW + TILE * 0.9, 0, roofY + 0.9, 0, TILE * 1.05);
  }

  if (building.awning) {
    // Lean-to forge shelter on the local +X side, opening onto the west lane.
    put('roof-high', halfW + 1.15, 0, ground + 1.9, Math.PI, TILE, building.depth + 0.5);
    put('pillar-wood', halfW + 2.15, -halfD + TILE * 0.55, ground, 0, TILE);
    put('pillar-wood', halfW + 2.15, halfD - TILE * 0.55, ground, 0, TILE);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type PropSolid =
  | { shape: 'box'; halfX: number; halfZ: number; height: number }
  | { shape: 'cylinder'; radius: number; height: number };

export interface PropSpec {
  kind: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** Height above the terrain, for wall-mounted pieces such as banners. */
  lift?: number;
  solid?: PropSolid;
}

/** Street furniture, market stalls and greenery. Kept deliberately sparse. */
export const TOWN_PROPS: PropSpec[] = [
  // Plaza market and fountain.
  { kind: 'fountain-round', x: 0, z: 0, yaw: 0, scale: TILE * 1.2, solid: { shape: 'cylinder', radius: 2.4, height: 0.8 } },
  { kind: 'fountain-center', x: 0, z: 0, yaw: 0, scale: TILE * 1.1, lift: 0.28 },
  { kind: 'stall-red', x: -4.2, z: 3.2, yaw: 2.55, scale: TILE, solid: { shape: 'box', halfX: 1, halfZ: 1, height: 2.5 } },
  { kind: 'stall-green', x: 3.2, z: 4.6, yaw: -2.35, scale: TILE, solid: { shape: 'box', halfX: 1, halfZ: 1, height: 2.5 } },
  { kind: 'stall-bench', x: -3.9, z: -3.4, yaw: 2.2, scale: TILE * 0.9, solid: { shape: 'box', halfX: 0.95, halfZ: 0.45, height: 0.6 } },
  { kind: 'stall-stool', x: -5.6, z: 1.8, yaw: 0.4, scale: TILE * 0.8 },
  { kind: 'banner-red', x: -5, z: -10.92, yaw: Math.PI / 2, scale: 1.7, lift: 2.6 },
  { kind: 'banner-green', x: -2, z: -10.92, yaw: Math.PI / 2, scale: 1.7, lift: 2.6 },
  { kind: 'banner-red', x: 11.44, z: -1.5, yaw: 0, scale: 1.7, lift: 2.7 },

  // Street lanterns.
  { kind: 'lantern', x: 3.1, z: 13.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -3.1, z: 13.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 3.1, z: 6.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -3.1, z: 6.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 5.2, z: -8.6, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -5.2, z: -8.6, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -6.9, z: -10.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 11.2, z: 1.6, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -15.2, z: -6.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },

  // Carts and workshop clutter.
  { kind: 'cart', x: -17.4, z: -4.6, yaw: 1.2, scale: TILE * 1.1, solid: { shape: 'box', halfX: 1.05, halfZ: 1.4, height: 1.5 } },
  { kind: 'cart', x: -12.4, z: 1.6, yaw: 1.25, scale: TILE, solid: { shape: 'box', halfX: 0.95, halfZ: 1.3, height: 1.4 } },
  { kind: 'cart-high', x: 16.4, z: 6.2, yaw: 0.9, scale: TILE, solid: { shape: 'box', halfX: 0.95, halfZ: 1.3, height: 1.6 } },
  { kind: 'planks-half', x: -13.2, z: -6.6, yaw: 0.35, scale: TILE, solid: { shape: 'box', halfX: 0.9, halfZ: 1, height: 0.7 } },
  { kind: 'planks-half', x: 9.9, z: -16.4, yaw: -0.4, scale: TILE * 0.9 },

  // Gardens, hedges and trees inside the town.
  { kind: 'fence', x: -10.4, z: 12.5, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.15, height: 0.8 } },
  { kind: 'fence', x: -8.4, z: 12.5, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.15, height: 0.8 } },
  { kind: 'fence', x: 8.5, z: 12.9, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.15, height: 0.8 } },
  { kind: 'fence', x: 10.5, z: 12.9, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.15, height: 0.8 } },
  { kind: 'fence', x: -16.4, z: -0.6, yaw: 0, scale: TILE, solid: { shape: 'box', halfX: 0.15, halfZ: 1.05, height: 0.8 } },
  { kind: 'hedge-large', x: 6.6, z: -5.4, yaw: -0.5, scale: TILE, solid: { shape: 'box', halfX: 0.55, halfZ: 1.05, height: 1.2 } },
  { kind: 'hedge-large', x: -6.3, z: -5.7, yaw: 0.6, scale: TILE, solid: { shape: 'box', halfX: 0.55, halfZ: 1.05, height: 1.2 } },
  { kind: 'hedge-large', x: 11.6, z: 4.4, yaw: 1.15, scale: TILE, solid: { shape: 'box', halfX: 0.55, halfZ: 1.05, height: 1.2 } },
  { kind: 'tree-high-round', x: -5.6, z: -3.6, yaw: 0.4, scale: TILE * 1.3, solid: { shape: 'cylinder', radius: 0.5, height: 7.5 } },
  { kind: 'tree-high', x: -15.4, z: 6.4, yaw: 1.1, scale: TILE * 1.1, solid: { shape: 'cylinder', radius: 0.4, height: 6.5 } },
  { kind: 'tree-high', x: 15.7, z: 3.8, yaw: 2.2, scale: TILE, solid: { shape: 'cylinder', radius: 0.4, height: 6 } },

  // The windmill on the north-west rise is the silhouette the town is known by.
  { kind: 'windmill', x: TOWN.windmill.x, z: TOWN.windmill.z, yaw: 0.6, scale: 2.6, solid: { shape: 'cylinder', radius: 1.3, height: 7 } },
];

export function propPlacements(): TownPlacement[] {
  return TOWN_PROPS.map((prop) => ({
    module: prop.kind,
    x: prop.x,
    y: heightAt(prop.x, prop.z) + 0.01 + (prop.lift ?? 0),
    z: prop.z,
    yaw: prop.yaw,
    scale: prop.scale,
  }));
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

/**
 * Cobble tiles, laid as short strips along every stone path plus a paved plaza.
 * Dirt lanes stay unpaved (the ground shader carries their colour).
 */
export function roadPlacements(): TownPlacement[] {
  const out: TownPlacement[] = [];
  const seen = new Set<string>();

  const add = (x: number, z: number): void => {
    const key = `${Math.round(x * 2)}:${Math.round(z * 2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (isInsideBuilding(x, z, 0.2)) return;

    // Flat slabs are only laid on level ground; the climb to the gate stays
    // bare stone-coloured ground rather than a staircase of floating tiles.
    const slope = Math.max(
      Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)),
      Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)),
    );
    if (slope > 0.2) return;

    out.push({ module: 'road', x, y: heightAt(x, z) + 0.045, z, yaw: 0, scale: TILE });
  };

  // Plaza paving, skipping the fountain basin.
  for (let x = -6; x <= 6; x += TILE) {
    for (let z = -6; z <= 6; z += TILE) {
      if (Math.hypot(x, z) > TOWN.plaza.radius - 0.8) continue;
      if (Math.abs(x) < 2.6 && Math.abs(z) < 2.6) continue;
      add(x, z);
    }
  }

  for (const path of PATHS) {
    if (path.kind !== 'stone') continue;

    const across = Math.max(1, Math.floor(path.width / TILE));
    const offsets: number[] = [];
    for (let i = 0; i < across; i += 1) offsets.push((i - (across - 1) / 2) * TILE);

    for (let i = 0; i < path.points.length - 1; i += 1) {
      const a = path.points[i];
      const b = path.points[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const dirX = (b.x - a.x) / length;
      const dirZ = (b.z - a.z) / length;
      const normalX = -dirZ;
      const normalZ = dirX;

      for (let travelled = 0; travelled <= length; travelled += TILE) {
        const cx = a.x + dirX * travelled;
        const cz = a.z + dirZ * travelled;
        if (Math.hypot(cx - TOWN.plaza.x, cz - TOWN.plaza.z) < TOWN.plaza.radius - 1.2) continue;
        for (const offset of offsets) add(cx + normalX * offset, cz + normalZ * offset);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

export interface Blocker {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface GateLayout {
  x: number;
  z: number;
  seal: Blocker;
  pillars: Vec2[];
  walls: Blocker[];
}

/**
 * The sealed entrance: a stone arch filled by a wall plug, flanked by two
 * wings and two torch pillars. The seal sits inside the arch, so the courtyard
 * is walkable but the passage is not.
 */
export const GATE: GateLayout = {
  x: TOWN.gate.x,
  z: TOWN.gate.z,
  seal: { minX: -2.3, maxX: 2.3, minZ: TOWN.gate.z - 1.6, maxZ: TOWN.gate.z - 0.3 },
  pillars: [
    { x: TOWN.gate.x - 3.4, z: TOWN.gate.z + 1.4 },
    { x: TOWN.gate.x + 3.4, z: TOWN.gate.z + 1.4 },
  ],
  walls: [
    { minX: TOWN.gate.x - 6.1, maxX: TOWN.gate.x - 1.9, minZ: TOWN.gate.z - 1.2, maxZ: TOWN.gate.z + 0.2 },
    { minX: TOWN.gate.x + 1.9, maxX: TOWN.gate.x + 6.1, minZ: TOWN.gate.z - 1.2, maxZ: TOWN.gate.z + 0.2 },
  ],
};

export const gateGround = (): number => heightAt(GATE.x, GATE.z);

/** Solid footprints the player cannot enter. */
export function townBlockers(): Blocker[] {
  const out: Blocker[] = BUILDINGS.map((building) => buildingFootprint(building));

  for (const prop of TOWN_PROPS) {
    if (!prop.solid) continue;
    if (prop.solid.shape === 'cylinder') {
      const { radius } = prop.solid;
      out.push({ minX: prop.x - radius, maxX: prop.x + radius, minZ: prop.z - radius, maxZ: prop.z + radius });
    } else {
      out.push(footprintOf(prop.x, prop.z, prop.solid.halfX, prop.solid.halfZ, prop.yaw));
    }
  }

  out.push(GATE.seal, ...GATE.walls);
  for (const pillar of GATE.pillars) {
    out.push({ minX: pillar.x - 0.75, maxX: pillar.x + 0.75, minZ: pillar.z - 0.75, maxZ: pillar.z + 0.75 });
  }
  return out;
}

/** Convex proxies for camera collision and target line of sight. */
export function townObstacles(): CameraObstacle[] {
  const out: CameraObstacle[] = [];

  for (const building of BUILDINGS) {
    const footprint = buildingFootprint(building);
    const bottom = heightAt(building.x, building.z) - 0.4;
    out.push({ kind: 'box', ...footprint, bottom, top: bottom + buildingHeight(building) + 0.6 });
  }

  for (const prop of TOWN_PROPS) {
    if (!prop.solid) continue;
    const bottom = heightAt(prop.x, prop.z) - 0.3;
    if (prop.solid.shape === 'cylinder') {
      out.push({
        kind: 'cylinder',
        x: prop.x,
        z: prop.z,
        radius: prop.solid.radius,
        bottom,
        top: bottom + prop.solid.height,
      });
    } else {
      const footprint = footprintOf(prop.x, prop.z, prop.solid.halfX, prop.solid.halfZ, prop.yaw);
      out.push({ kind: 'box', ...footprint, bottom, top: bottom + prop.solid.height });
    }
  }

  const gateBottom = heightAt(GATE.x, GATE.z) - 0.4;
  for (const box of [GATE.seal, ...GATE.walls]) {
    out.push({ kind: 'box', ...box, bottom: gateBottom, top: gateBottom + 5 });
  }
  for (const pillar of GATE.pillars) {
    out.push({
      kind: 'box',
      minX: pillar.x - 0.75,
      maxX: pillar.x + 0.75,
      minZ: pillar.z - 0.75,
      maxZ: pillar.z + 0.75,
      bottom: gateBottom,
      top: gateBottom + 4.6,
    });
  }

  return out;
}

/** Modules that the renderer must load. Kept explicit so a typo fails fast. */
export const TOWN_MODULES = [
  'wall',
  'wall-door',
  'wall-wood',
  'wall-wood-door',
  'wall-wood-window-small',
  'roof-high-gable',
  'roof-high-gable-detail',
  'roof-high',
  'chimney',
  'pillar-wood',
  'road',
  'fountain-round',
  'fountain-center',
  'stall-red',
  'stall-green',
  'stall-bench',
  'stall-stool',
  'banner-red',
  'banner-green',
  'lantern',
  'cart',
  'cart-high',
  'planks-half',
  'fence',
  'hedge-large',
  'tree-high',
  'tree-high-round',
  'windmill',
] as const;

export type TownModule = (typeof TOWN_MODULES)[number];
