/**
 * Layout and terrain for the first town.
 *
 * Everything here is plain data plus closed-form geometry: no three.js, no DOM.
 * `world.ts` merges these placements into a handful of static meshes, while the
 * tests can check spawn safety, footprints and connectivity directly.
 *
 * Composition intent (the spawn view is the design reference)
 * - The spawn looks north up a trodden dirt street. The Weaver's Loft closes the
 *   left of frame, the inn the right, and the street narrows between them before
 *   opening onto the square.
 * - The square is the heart: a stone fountain, a row of market stalls facing it,
 *   a market tree and lantern posts, with the three-storey guild hall rising
 *   behind the north side as the landmark.
 * - The lane between the guild and the storehouse leads to the sealed gate, so
 *   the route spawn → plaza → guild → dungeon reads as one line.
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

/** Ridge height above the eaves, for the tall red roofs. */
export const ROOF_RISE = 2.4;
/** Ridge height of the low teal roofs. Pitch is part of a building's identity. */
const LOW_ROOF_RISE = 1.2;

export interface Vec2 {
  x: number;
  z: number;
}

export const TOWN = {
  /** Playable edge: enemies leash inside this, the ground rim rises beyond it. */
  radius: 40,
  seed: 20261116,
  /** South end of the approach street, looking north at the plaza. */
  spawn: { x: 0, z: 27 },
  plaza: { x: 0, z: 0, radius: 8.2 },
  /** Sealed ancient entrance beyond the last houses. */
  gate: { x: 0, z: -32 },
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
 * Walkable height field. Every building site and the whole street network sit
 * on flat ground, the sealed gate stands on its own raised plateau, and the rim
 * beyond the playable edge lifts into the treeline so the boundary reads as
 * terrain rather than an invisible wall.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x - TOWN.plaza.x, z - TOWN.plaza.z);
  // Flat out to the last building (storehouse corner is ~23.5 m out).
  const town = 1 - smoothstep(23, 32, r);
  const spawn = 1 - smoothstep(5, 14, Math.hypot(x - TOWN.spawn.x, z - TOWN.spawn.z));

  // The gate terrace rises north of the storehouse, over the whole width of the
  // arch, so the sealed court is level and the town itself never tilts.
  const terrace =
    smoothstep(-23, -28.5, z) * smoothstep(20, 9, Math.abs(x - TOWN.gate.x));

  // A wooded bank right past the playable edge, then a farther ridge that hides
  // the end of the ground mesh from every street in town.
  const rim = smoothstep(34, 48, r);
  const farRim = smoothstep(48, 70, r);

  const open = (1 - town) * (1 - terrace) * (1 - 0.9 * spawn);

  return rolling(x, z) * open + 2.4 * terrace + rim * 3.2 + farRim * 5.6;
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
 * The street network. The approach is dirt with a stone apron at the square;
 * lanes and thresholds are flagged so the ground reads as a lived-in town
 * instead of one continuous grey carpet. Every building has its own spur.
 */
export const PATHS: PathSpec[] = [
  // Approach street and the apron where it opens into the square.
  { points: [{ x: 0, z: 31 }, { x: 0, z: 9 }], width: 4.6, kind: 'dirt' },
  { points: [{ x: 0, z: 9 }, { x: 0, z: 7.4 }], width: 4.6, kind: 'stone' },

  // Door thresholds.
  { points: [{ x: -2.1, z: 20.5 }, { x: -3.4, z: 20.5 }], width: 2.2, kind: 'stone' },
  { points: [{ x: 2.0, z: 18.5 }, { x: 3.4, z: 18.5 }], width: 2.2, kind: 'stone' },
  { points: [{ x: -2.1, z: 13.5 }, { x: -5.0, z: 13.5 }], width: 2.2, kind: 'dirt' },
  { points: [{ x: 2.0, z: 11.5 }, { x: 4.6, z: 11.5 }], width: 2.2, kind: 'dirt' },
  { points: [{ x: -4.5, z: -8.0 }, { x: -4.5, z: -11.1 }], width: 3.6, kind: 'stone' },
  { points: [{ x: -7.0, z: -3.6 }, { x: -11.1, z: -4.5 }], width: 3, kind: 'dirt' },
  { points: [{ x: 6.6, z: -5.6 }, { x: 9.1, z: -8.2 }], width: 2.6, kind: 'dirt' },
  { points: [{ x: 3.6, z: -19.5 }, { x: 5.0, z: -19.5 }], width: 2.4, kind: 'dirt' },
  { points: [{ x: -6.2, z: -7.0 }, { x: -10.6, z: -12.4 }, { x: -11.1, z: -13.1 }], width: 2.6, kind: 'dirt' },

  // Paved lane between guild and storehouse, climbing to the sealed gate.
  { points: [{ x: 2.6, z: -7.6 }, { x: 3.6, z: -12 }, { x: 3.6, z: -17.8 }, { x: 2.4, z: -23 }, { x: 0.4, z: -28.8 }], width: 3.4, kind: 'stone' },

  // Trodden way out to the woods, between the smithy and the cottages.
  { points: [{ x: -6.6, z: 4.8 }, { x: -10.5, z: 8.6 }, { x: -15, z: 13.5 }, { x: -20, z: 19.5 }], width: 3, kind: 'dirt' },
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

/** 1 on trodden dirt (the approach street and forest routes), 0 elsewhere. */
export function dirtFactor(x: number, z: number): number {
  const near = nearestPath(x, z);
  if (near.path.kind !== 'dirt') return 0;
  return smoothstep(near.path.width * 0.5 + 1.8, near.path.width * 0.5 - 0.6, near.distance);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingTone = 'plaster' | 'timber';
export type RoofStyle = 'red' | 'red-detail' | 'teal' | 'teal-detail';

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
  roof: RoofStyle;
  chimney?: boolean;
  /** Upper floors overhang the street by 30 cm. */
  jetty?: boolean;
  /** Small tiled awning over the door. */
  canopy?: boolean;
  /** Open lean-to forge yard on the local -X wall. */
  forge?: boolean;
  /** Guild porch: posts, tiled canopy and paired banners. */
  portico?: boolean;
}

/**
 * Nine buildings around the square. The guild hall closes the north side and is
 * the tallest silhouette; the inn and weaver frame the approach; the smithy and
 * market share the west/east edges; homes and the storehouse fill the lanes.
 * Roofs alternate red/teal, ridges alternate x/z, and heights stagger 1–3 floors
 * so the skyline never reads as a row of identical boxes.
 */
export const BUILDINGS: BuildingSpec[] = [
  {
    id: 'guild',
    label: 'Adventurers’ Guild',
    x: -4.5,
    z: -14.5,
    yaw: 0,
    width: 4,
    depth: 3,
    levels: 3,
    tone: 'plaster',
    ridge: 'x',
    roof: 'red-detail',
    chimney: true,
    portico: true,
  },
  {
    id: 'inn',
    label: 'The Wandering Lantern',
    x: 5.8,
    z: 18.5,
    yaw: -Math.PI / 2,
    width: 3,
    depth: 2,
    levels: 2,
    tone: 'timber',
    ridge: 'x',
    roof: 'red',
    chimney: true,
    jetty: true,
    canopy: true,
  },
  {
    id: 'weaver',
    label: 'Weaver’s Loft',
    x: -5.8,
    z: 20.5,
    yaw: Math.PI / 2,
    width: 3,
    depth: 2,
    levels: 2,
    tone: 'plaster',
    ridge: 'z',
    roof: 'teal',
    jetty: true,
    canopy: true,
  },
  {
    id: 'smithy',
    label: 'Smithy',
    x: -13.5,
    z: -4.5,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'timber',
    ridge: 'x',
    roof: 'teal',
    chimney: true,
    forge: true,
  },
  {
    id: 'cottage-a',
    label: 'Cobbler’s Cottage',
    x: -7.4,
    z: 13.5,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'plaster',
    ridge: 'z',
    roof: 'teal-detail',
  },
  {
    id: 'cottage-b',
    label: 'Fisher’s Cottage',
    x: 7.0,
    z: 11.5,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'timber',
    ridge: 'x',
    roof: 'red',
    chimney: true,
  },
  {
    id: 'house-c',
    label: 'Hunter’s House',
    x: 11.5,
    z: -8.5,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 2,
    tone: 'plaster',
    ridge: 'z',
    roof: 'teal',
    jetty: true,
  },
  {
    id: 'storehouse',
    label: 'Storehouse',
    x: 7.4,
    z: -19.5,
    yaw: -Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 1,
    tone: 'timber',
    ridge: 'x',
    roof: 'red',
  },
  {
    id: 'cottage-c',
    label: 'Woodcutter’s Cottage',
    x: -13.5,
    z: -13.5,
    yaw: Math.PI / 2,
    width: 2,
    depth: 2,
    levels: 2,
    tone: 'timber',
    ridge: 'z',
    roof: 'red',
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

const roofRise = (roof: RoofStyle): number => {
  if (roof === 'red') return ROOF_RISE;
  if (roof === 'red-detail') return 2.6;
  if (roof === 'teal') return LOW_ROOF_RISE;
  return 1.4;
};

/** Wall top plus roof ridge, used for camera proxies and tests. */
export function buildingHeight(building: BuildingSpec): number {
  return building.levels * TILE + roofRise(building.roof);
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

const ROOF_MODULE: Record<RoofStyle, string> = {
  red: 'roof-high-gable',
  'red-detail': 'roof-high-gable-detail',
  teal: 'roof-gable',
  'teal-detail': 'roof-gable-detail',
};

/**
 * Walls and roof for one building, in world space.
 *
 * Façade rhythm: the door sits in the front wall with a shuttered window beside
 * it, upper floors alternate plain and glassed panels and finish in timber-cross
 * panels at the corners, and the guild gets stone-framed windows all the way up.
 * Upper floors can jetty out by 30 cm, and the roof pitch is chosen per building
 * so red steep roofs and low teal roofs break the skyline.
 */
export function buildingPlacements(building: BuildingSpec): TownPlacement[] {
  const out: TownPlacement[] = [];
  const ground = heightAt(building.x, building.z) + 0.02;
  const halfW = (building.width * TILE) / 2;
  const halfD = (building.depth * TILE) / 2;
  const doorIndex = Math.floor((building.width - 1) / 2);
  const doorX = -halfW + TILE / 2 + doorIndex * TILE;
  const last = building.width - 1;
  const door = building.tone === 'timber' ? 'wall-wood-door' : 'wall-door';
  const plain = building.tone === 'timber' ? 'wall-wood' : 'wall';
  const upper = building.tone === 'timber' ? 'wall' : 'wall-wood';

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

  const groundFront = (index: number): string => {
    if (index === doorIndex) return door;
    if (building.id === 'guild') {
      return index === 0 || index === last ? 'wall-detail-cross' : 'wall-window-stone';
    }
    if (building.width === 2) return 'wall-window-shutters';
    if (index === 0) return 'wall-window-shutters';
    if (index === last) return 'wall-detail-cross';
    return 'wall-window-shutters';
  };

  const upperFront = (level: number, index: number): string => {
    if (building.id === 'guild') {
      if (index === 0 || index === last) return 'wall-detail-cross';
      return index % 2 === 0 ? 'wall-window-stone' : 'wall-wood-window-small';
    }
    if (building.id === 'inn' && level === 1 && index === doorIndex) return 'wall-window-round';
    if (index === 0 || index === last) return 'wall-detail-cross';
    return index % 2 === 0 ? 'wall-wood-window-small' : upper;
  };

  for (let level = 0; level < building.levels; level += 1) {
    const y = ground + level * TILE;
    // The upper storeys lean out over the street; the roof follows the outer face.
    const grow = building.jetty && level > 0 ? 0.3 : 0;
    const frontZ = halfD - TILE / 2 + grow;
    const backZ = -halfD + TILE / 2 - grow;
    const sideX = halfW - TILE / 2 + grow;

    for (let i = 0; i < building.width; i += 1) {
      const localX = -halfW + TILE / 2 + i * TILE;
      const front = level === 0 ? groundFront(i) : upperFront(level, i);
      put(front, localX, frontZ, y, -Math.PI / 2, TILE);

      const isEnd = i === 0 || i === last;
      const back =
        level === 0
          ? plain
          : i === Math.floor(building.width / 2) && !isEnd
            ? 'wall-wood-window-small'
            : topBand(building, level, i);
      put(back, localX, backZ, y, Math.PI / 2, TILE);
    }

    for (let i = 0; i < building.depth; i += 1) {
      const localZ = -halfD + TILE / 2 + i * TILE;
      const side =
        level === 0
          ? plain
          : i === Math.floor(building.depth / 2)
            ? 'wall-wood-window-small'
            : topBand(building, level, i);
      put(side, -sideX, localZ, y, Math.PI, TILE);
      put(side, sideX, localZ, y, 0, TILE);
    }
  }

  const roofY = ground + building.levels * TILE;
  const rise = roofRise(building.roof);
  const roofModule = ROOF_MODULE[building.roof];
  const across = building.ridge === 'x' ? building.depth : building.width;
  const ridgeCount = building.ridge === 'x' ? building.width : building.depth;
  // One ridge tile covers 2.2 m across at TILE scale; add eaves and jetty.
  const acrossTiles = (across * TILE + 0.8 + (building.jetty ? 0.6 : 0)) / (1.1 * TILE);

  for (let i = 0; i < ridgeCount; i += 1) {
    if (building.ridge === 'x') {
      put(roofModule, -halfW + TILE / 2 + i * TILE, 0, roofY, 0, TILE, acrossTiles);
    } else {
      put(roofModule, 0, -halfD + TILE / 2 + i * TILE, roofY, Math.PI / 2, TILE, acrossTiles);
    }
  }

  if (building.chimney) {
    put('chimney', -halfW + 1.0, -halfD * 0.4, roofY + rise * 0.45, 0, 2.4);
  }

  if (building.canopy) {
    // Small tiled awning over the door, high edge tucked into the wall.
    put('roof-high', doorX, halfD + 1.1, ground + 2.15, Math.PI / 2, 1.15, 1.6);
  }

  if (building.portico) {
    // Guild porch: a deeper canopy carried on two posts, with paired banners.
    put('roof-high', doorX, halfD + 1.9, ground + 2.2, Math.PI / 2, 1.7, 1.9);
    put('pillar-wood', doorX - 1.15, halfD + 1.62, ground, 0, 2.2);
    put('pillar-wood', doorX + 1.15, halfD + 1.62, ground, 0, 2.2);
    put('banner-red', doorX - 1.9, halfD + 0.15, ground + 3.5, 0, 2);
    put('banner-green', doorX + 1.9, halfD + 0.15, ground + 3.5, 0, 2);
  }

  if (building.forge) {
    // Open forge yard tacked onto the local -X wall, with two posts at the eave.
    put('roof-high', -halfW - 1.9, 0, ground + 1.8, 0, 2, 2.2);
    put('pillar-wood', -halfW - 1.9, -halfD + 0.9, ground, 0, 1.95);
    put('pillar-wood', -halfW - 1.9, halfD - 0.9, ground, 0, 1.95);
  }

  return out;
}

/** Plain infill for back and side walls; the guild keeps its stone band. */
function topBand(building: BuildingSpec, level: number, index: number): string {
  if (building.id === 'guild' && (level % 2 === 1 || index === 0)) return 'wall-window-stone';
  return 'wall-wood';
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

/**
 * Street furniture, market and greenery. Every prop earns its place: the market
 * row faces the fountain, carts and planks belong to the smithy and storehouse,
 * lanterns mark thresholds, and the trees frame the street without blocking it.
 */
export const TOWN_PROPS: PropSpec[] = [
  // --- fountain and market row -------------------------------------------
  { kind: 'fountain-round', x: 0, z: 0, yaw: 0, scale: 2.5, solid: { shape: 'cylinder', radius: 2.5, height: 0.9 } },
  { kind: 'fountain-center', x: 0, z: 0, yaw: 0, scale: 2.2, lift: 0.5 },
  { kind: 'stall-red', x: 5.6, z: 2.6, yaw: -Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1, halfZ: 1, height: 2.4 } },
  { kind: 'stall-green', x: 5.6, z: -0.2, yaw: -Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1, halfZ: 1, height: 2.4 } },
  { kind: 'stall-red', x: 5.4, z: -3.0, yaw: -1.9, scale: TILE, solid: { shape: 'box', halfX: 1, halfZ: 1, height: 2.4 } },
  { kind: 'stall-bench', x: 3.4, z: -5.6, yaw: -0.4, scale: TILE * 0.95, solid: { shape: 'box', halfX: 0.95, halfZ: 0.45, height: 0.6 } },
  { kind: 'stall-stool', x: 4.2, z: 4.6, yaw: 0.5, scale: 1.6 },
  { kind: 'cart', x: 7.0, z: 5.4, yaw: 1.2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 1.4, height: 1.4 } },
  { kind: 'planks-half', x: 8.0, z: -1.6, yaw: 0.3, scale: TILE, solid: { shape: 'box', halfX: 0.9, halfZ: 1, height: 0.7 } },

  // --- guild frontage -----------------------------------------------------
  { kind: 'lantern', x: -6.9, z: -10.6, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },

  // --- thresholds and street lanterns ------------------------------------
  { kind: 'lantern', x: -3.1, z: 24.8, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 3.1, z: 24.8, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -4.2, z: 5.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 4.2, z: 5.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 3.0, z: 15.8, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -3.0, z: 15.4, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: -10.4, z: -1.8, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },
  { kind: 'lantern', x: 9.8, z: -6.0, yaw: 0, scale: 1.45, solid: { shape: 'cylinder', radius: 0.3, height: 2.3 } },

  // --- banners ------------------------------------------------------------
  { kind: 'banner-red', x: 3.6, z: 18.5, yaw: 0, scale: 2.0, lift: 3.4 },
  { kind: 'banner-red', x: -11.3, z: -4.5, yaw: 0, scale: 1.8, lift: 2.7 },

  // --- workshop clutter ---------------------------------------------------
  { kind: 'cart', x: -9.8, z: -8.2, yaw: 1.2, scale: TILE * 0.95, solid: { shape: 'box', halfX: 1.05, halfZ: 1.4, height: 1.4 } },
  { kind: 'planks-half', x: -13.6, z: -8.6, yaw: 0.35, scale: TILE, solid: { shape: 'box', halfX: 0.9, halfZ: 1, height: 0.7 } },
  { kind: 'planks-half', x: 10.4, z: -18.2, yaw: -0.3, scale: 1.8, lift: 0.05 },

  // --- entrance fences and plaza hedges ----------------------------------
  { kind: 'fence', x: -3.4, z: 29.4, yaw: 0, scale: TILE, solid: { shape: 'box', halfX: 0.1, halfZ: 1.05, height: 0.8 } },
  { kind: 'fence', x: 3.4, z: 29.4, yaw: 0, scale: TILE, solid: { shape: 'box', halfX: 0.1, halfZ: 1.05, height: 0.8 } },
  { kind: 'fence', x: -4.6, z: 16.4, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.1, height: 0.8 } },
  { kind: 'fence', x: -2.6, z: 16.4, yaw: Math.PI / 2, scale: TILE, solid: { shape: 'box', halfX: 1.05, halfZ: 0.1, height: 0.8 } },
  { kind: 'hedge-large', x: 4.4, z: 7.4, yaw: 0.3, scale: TILE, solid: { shape: 'box', halfX: 0.55, halfZ: 1.05, height: 1.2 } },
  { kind: 'hedge-large', x: -4.6, z: 7.2, yaw: -0.3, scale: TILE, solid: { shape: 'box', halfX: 0.55, halfZ: 1.05, height: 1.2 } },

  // --- town trees: frame the street and the square, never the sightline ---
  { kind: 'tree-high', x: -6.2, z: 30.4, yaw: 0.6, scale: TILE * 1.15, solid: { shape: 'cylinder', radius: 0.5, height: 7 } },
  { kind: 'tree-high', x: 6.2, z: 30.0, yaw: 2.1, scale: TILE * 1.05, solid: { shape: 'cylinder', radius: 0.5, height: 6.6 } },
  { kind: 'tree-high-round', x: -8.0, z: 3.0, yaw: 0.4, scale: TILE * 1.3, solid: { shape: 'cylinder', radius: 0.5, height: 7.5 } },
  { kind: 'tree-high-round', x: 9.8, z: 6.0, yaw: 2.4, scale: TILE * 1.1, solid: { shape: 'cylinder', radius: 0.5, height: 6.5 } },
  { kind: 'tree-high', x: -8.4, z: 10.2, yaw: 1.1, scale: TILE * 1.0, solid: { shape: 'cylinder', radius: 0.5, height: 6 } },
  { kind: 'tree-high-round', x: 12.4, z: 2.0, yaw: 0.9, scale: TILE * 1.05, solid: { shape: 'cylinder', radius: 0.5, height: 6.2 } },
  { kind: 'tree-high', x: 11.0, z: -19.0, yaw: 2.8, scale: TILE * 1.1, solid: { shape: 'cylinder', radius: 0.5, height: 6.6 } },

  // --- the windmill on the north-west rise --------------------------------
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
 * Cobble tiles are laid as a worn ring around the fountain and as a single
 * threshold slab at each door — not as a carpet over every lane. Dirt streets
 * and the climbs stay painted by the ground shader, which avoids both tile gaps
 * and staircases of floating slabs.
 */
export function roadPlacements(): TownPlacement[] {
  const out: TownPlacement[] = [];
  const seen = new Set<string>();

  const add = (x: number, z: number): void => {
    const key = `${Math.round(x * 2)}:${Math.round(z * 2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (isInsideBuilding(x, z, 0.2)) return;

    const slope = Math.max(
      Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)),
      Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)),
    );
    if (slope > 0.2) return;

    out.push({ module: 'road', x, y: heightAt(x, z) + 0.045, z, yaw: 0, scale: TILE });
  };

  // Paved square: a disc with a grass rim, so the fountain sits on stone and the
  // market stalls stand at the edge of it.
  for (let x = -8; x <= 8; x += TILE) {
    for (let z = -8; z <= 8; z += TILE) {
      const r = Math.hypot(x, z);
      if (r < 2.2 || r > TOWN.plaza.radius - 0.2) continue;
      add(x, z);
    }
  }

  // One stone threshold slab outside each door.
  for (const building of BUILDINGS) {
    const door = doorPoint(building);
    const outward = { x: Math.sin(building.yaw), z: Math.cos(building.yaw) };
    add(door.x + outward.x * 1.15, door.z + outward.z * 1.15);
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
 * The sealed entrance: a stone arch filled by a wall plug, flanked by two wings
 * and two torch pillars. The seal sits inside the arch, so the courtyard is
 * walkable but the passage is not.
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
  'wall-wood',
  'wall-door',
  'wall-wood-door',
  'wall-wood-window-small',
  'wall-window-stone',
  'wall-window-shutters',
  'wall-window-round',
  'wall-detail-cross',
  'roof-high-gable',
  'roof-high-gable-detail',
  'roof-gable',
  'roof-gable-detail',
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
  'planks-half',
  'fence',
  'hedge-large',
  'tree-high',
  'tree-high-round',
  'windmill',
  'rock-large',
] as const;

export type TownModule = (typeof TOWN_MODULES)[number];
