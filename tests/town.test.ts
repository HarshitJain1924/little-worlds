import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  BUILDINGS,
  GATE,
  PATHS,
  TILE,
  TOWN,
  TOWN_MODULES,
  TOWN_PROPS,
  buildingFootprint,
  buildingHeight,
  buildingPlacements,
  dirtFactor,
  footprintOf,
  doorPoint,
  heightAt,
  isInsideBuilding,
  nearestPath,
  pavingFactor,
  pathDistance,
  propPlacements,
  roadPlacements,
  townBlockers,
  townObstacles,
  type Blocker,
  type PathSpec,
} from '../src/play/town.ts';

const insideBlocker = (blocker: Blocker, x: number, z: number, pad = 0): boolean =>
  x > blocker.minX - pad && x < blocker.maxX + pad && z > blocker.minZ - pad && z < blocker.maxZ + pad;

function pathGap(x: number, z: number, path: PathSpec): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.points.length - 1; i += 1) {
    const a = path.points[i];
    const b = path.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t =
      lengthSquared <= 1e-9
        ? 0
        : Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

test('the spawn is safe, level and on the south street', () => {
  const { x, z } = TOWN.spawn;

  assert.ok(Math.hypot(x, z) < TOWN.radius - 10, 'spawn is inside the playable bowl');
  assert.ok(pathDistance(x, z) <= 2.5, 'spawn stands on the approach street');
  assert.ok(Math.abs(heightAt(x, z)) < 0.2, 'spawn ground is level');

  const around = [
    heightAt(x + 1.5, z),
    heightAt(x - 1.5, z),
    heightAt(x, z + 1.5),
    heightAt(x, z - 1.5),
  ];
  assert.ok(Math.max(...around) - Math.min(...around) < 0.15, 'spawn clearing is flat');

  assert.equal(isInsideBuilding(x, z, 2.5), false, 'no wall encloses the spawn');
  for (const blocker of townBlockers()) {
    assert.equal(insideBlocker(blocker, x, z, 1.5), false, 'spawn is clear of solid props');
  }

  // Readable at a glance: the nearest building is far enough to see the square.
  for (const building of BUILDINGS) {
    const footprint = buildingFootprint(building);
    const dx = Math.max(footprint.minX - x, 0, x - footprint.maxX);
    const dz = Math.max(footprint.minZ - z, 0, z - footprint.maxZ);
    assert.ok(Math.hypot(dx, dz) > 4, `${building.id} crowds the spawn`);
  }
});

test('buildings are distinct, inside the bowl and off the plaza', () => {
  for (const building of BUILDINGS) {
    const footprint = buildingFootprint(building);
    for (const [cornerX, cornerZ] of [
      [footprint.minX, footprint.minZ],
      [footprint.minX, footprint.maxZ],
      [footprint.maxX, footprint.minZ],
      [footprint.maxX, footprint.maxZ],
    ]) {
      assert.ok(Math.hypot(cornerX, cornerZ) < TOWN.radius - 10, `${building.id} pokes past the bowl`);
    }

    const nearestX = Math.min(Math.max(TOWN.plaza.x, footprint.minX), footprint.maxX);
    const nearestZ = Math.min(Math.max(TOWN.plaza.z, footprint.minZ), footprint.maxZ);
    assert.ok(
      Math.hypot(nearestX - TOWN.plaza.x, nearestZ - TOWN.plaza.z) > TOWN.plaza.radius - 0.5,
      `${building.id} stands in the square`,
    );
  }

  for (let i = 0; i < BUILDINGS.length; i += 1) {
    for (let j = i + 1; j < BUILDINGS.length; j += 1) {
      const a = buildingFootprint(BUILDINGS[i]);
      const b = buildingFootprint(BUILDINGS[j]);
      const apart =
        a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ;
      assert.ok(apart, `${BUILDINGS[i].id} overlaps ${BUILDINGS[j].id}`);
    }
  }
});

test('every door opens onto the street network', () => {
  for (const building of BUILDINGS) {
    const door = doorPoint(building);
    assert.ok(pathDistance(door.x, door.z) < 1.2, `${building.id} has no street at its door`);

    // The threshold is on the wall line; half a metre out is open ground.
    const front = {
      x: door.x + Math.sin(building.yaw) * 0.5,
      z: door.z + Math.cos(building.yaw) * 0.5,
    };
    assert.equal(isInsideBuilding(front.x, front.z, 0), false);
  }
});

test('the streets are one connected network that reaches every door', () => {
  // Union paths whose endpoint touches another path, or the plaza itself.
  const parent = PATHS.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const endpoints = PATHS.map((path) => [path.points[0], path.points[path.points.length - 1]]);

  for (let i = 0; i < PATHS.length; i += 1) {
    for (const endpoint of endpoints[i]) {
      if (Math.hypot(endpoint.x - TOWN.plaza.x, endpoint.z - TOWN.plaza.z) <= TOWN.plaza.radius + 1.2) {
        union(i, 0);
      }
    }
  }

  for (let i = 0; i < PATHS.length; i += 1) {
    for (let j = 0; j < PATHS.length; j += 1) {
      if (i === j) continue;
      for (const endpoint of endpoints[i]) {
        if (pathGap(endpoint.x, endpoint.z, PATHS[j]) < 2.8) union(i, j);
      }
    }
  }

  const root = find(0);
  for (let index = 1; index < PATHS.length; index += 1) {
    assert.equal(find(index), root, `path ${index} is cut off from the plaza`);
  }

  // No street may run through a wall.
  for (const path of PATHS) {
    for (let i = 0; i < path.points.length - 1; i += 1) {
      const a = path.points[i];
      const b = path.points[i + 1];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        if (Math.hypot(x - TOWN.plaza.x, z - TOWN.plaza.z) < TOWN.plaza.radius) continue;
        assert.equal(isInsideBuilding(x, z, 0.05), false, `street ${i} crosses a building`);
      }
    }
  }
});

test('the sealed dungeon entrance stands beyond the houses', () => {
  const lastHouse = Math.min(...BUILDINGS.map((building) => buildingFootprint(building).minZ));
  assert.ok(GATE.z < lastHouse - 8, 'the gate is outside the town');

  const court = { x: GATE.x, z: GATE.z + 2 };
  const reach = Math.min(...PATHS.map((path) => pathGap(court.x, court.z, path)));
  assert.ok(reach < 2.5, 'the paved way reaches the gate court');

  assert.ok(
    townBlockers().some((blocker) => insideBlocker(blocker, GATE.x, GATE.z - 0.9)),
    'the arch passage is sealed',
  );
  assert.ok(!townBlockers().some((blocker) => insideBlocker(blocker, GATE.x, GATE.z + 2.4)));

  // It is a raised plateau, but the court itself is flat enough to fight on.
  assert.ok(heightAt(GATE.x, GATE.z) > heightAt(GATE.x, GATE.z + 12) + 1.5);
  const courtHeights = [
    heightAt(GATE.x - 2, GATE.z + 2.4),
    heightAt(GATE.x + 2, GATE.z + 2.4),
    heightAt(GATE.x, GATE.z + 2.4),
    heightAt(GATE.x, GATE.z - 0.2),
  ];
  assert.ok(Math.max(...courtHeights) - Math.min(...courtHeights) < 0.3);
});

test('buildings and solid props register player and camera collision', () => {
  const blockers = townBlockers();
  const obstacles = townObstacles();

  for (const building of BUILDINGS) {
    const footprint = buildingFootprint(building);
    const solid = blockers.some(
      (blocker) =>
        Math.abs(blocker.minX - footprint.minX) < 0.01 &&
        Math.abs(blocker.maxX - footprint.maxX) < 0.01 &&
        Math.abs(blocker.minZ - footprint.minZ) < 0.01 &&
        Math.abs(blocker.maxZ - footprint.maxZ) < 0.01,
    );
    assert.ok(solid, `${building.id} has no blocker`);

    const ground = heightAt(building.x, building.z);
    const proxy = obstacles.find(
      (obstacle) =>
        obstacle.kind === 'box' &&
        Math.abs(obstacle.minX - footprint.minX) < 0.01 &&
        Math.abs(obstacle.maxZ - footprint.maxZ) < 0.01,
    );
    assert.ok(proxy, `${building.id} has no camera proxy`);
    if (proxy && proxy.kind === 'box') {
      assert.ok((proxy.top ?? 0) > ground + buildingHeight(building) * 0.9);
    }

    // The doorway stays approachable: half a metre in front of the door is open.
    const door = doorPoint(building);
    const front = {
      x: door.x + Math.sin(building.yaw) * 0.6,
      z: door.z + Math.cos(building.yaw) * 0.6,
    };
    for (const blocker of blockers) {
      assert.equal(insideBlocker(blocker, front.x, front.z), false, `${building.id} door is blocked`);
    }
  }

  for (const kind of ['fountain-round', 'stall-red', 'cart', 'hedge-large']) {
    assert.ok(
      TOWN_PROPS.some((prop) => prop.kind === kind && prop.solid),
      `${kind} should be solid`,
    );
  }
});

test('props stay out of buildings and off the streets', () => {
  for (const prop of TOWN_PROPS) {
    assert.equal(isInsideBuilding(prop.x, prop.z, 0), false, `${prop.kind} is inside a building`);

    if (!prop.solid) continue;
    const near = nearestPath(prop.x, prop.z);
    assert.ok(
      near.distance > near.path.width / 2 + 0.25,
      `${prop.kind} blocks the ${near.path.kind} street`,
    );
  }

  // Solid street furniture must not interpenetrate, and it must clear the walls.
  const boxes = TOWN_PROPS.filter((prop) => prop.solid).map((prop) => {
    if (prop.solid && prop.solid.shape === 'cylinder') {
      const { radius } = prop.solid;
      return { label: prop.kind, minX: prop.x - radius, maxX: prop.x + radius, minZ: prop.z - radius, maxZ: prop.z + radius };
    }
    const solid = prop.solid as { halfX: number; halfZ: number };
    const box = footprintOf(prop.x, prop.z, solid.halfX, solid.halfZ, prop.yaw);
    return { label: prop.kind, ...box };
  });

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const apart =
        a.maxX <= b.minX + 0.02 ||
        b.maxX <= a.minX + 0.02 ||
        a.maxZ <= b.minZ + 0.02 ||
        b.maxZ <= a.minZ + 0.02;
      assert.ok(apart, `${a.label} overlaps ${b.label}`);
    }
  }

  for (const box of boxes) {
    for (const building of BUILDINGS) {
      const footprint = buildingFootprint(building);
      const apart =
        box.maxX <= footprint.minX + 0.02 ||
        footprint.maxX <= box.minX + 0.02 ||
        box.maxZ <= footprint.minZ + 0.02 ||
        footprint.maxZ <= box.minZ + 0.02;
      assert.ok(apart, `${box.label} clips ${building.id}`);
    }
  }
});

test('walls and roofs line up with the building layout', () => {
  for (const building of BUILDINGS) {
    const placements = buildingPlacements(building);
    const ground = heightAt(building.x, building.z) + 0.02;

    const walls = placements.filter((placement) => placement.module.startsWith('wall'));
    assert.equal(walls.length, building.levels * (building.width * 2 + building.depth * 2));
    for (const wall of walls) {
      assert.equal(wall.scale, TILE);
      const level = Math.round((wall.y - ground) / TILE);
      assert.ok(level >= 0 && level < building.levels, `${building.id} wall floats at the wrong level`);
    }

    const roofs = placements.filter((placement) => placement.module.startsWith('roof-high-gable'));
    assert.equal(roofs.length, building.ridge === 'x' ? building.width : building.depth);
    for (const roof of roofs) {
      assert.ok(Math.abs(roof.y - (ground + building.levels * TILE)) < 1e-6);
      assert.ok((roof.stretchZ ?? 0) >= (building.ridge === 'x' ? building.depth : building.width));
    }

    for (const placement of placements) {
      assert.ok(
        (TOWN_MODULES as readonly string[]).includes(placement.module),
        `${placement.module} is not a curated town module`,
      );
    }
  }
});

test('the town kit is present in public assets', () => {
  for (const module of TOWN_MODULES) {
    assert.ok(existsSync(`public/rpg/town/${module}.glb`), `missing public/rpg/town/${module}.glb`);
  }
  assert.ok(existsSync('public/rpg/town/rock-large.glb'), 'gate boulders need rock-large');
});

test('the plaza, streets and forest route read as different ground', () => {
  assert.ok(pavingFactor(0, 4) > 0.9, 'plaza is paved');
  assert.ok(pavingFactor(TOWN.spawn.x, TOWN.spawn.z) > 0.5, 'the approach street is paved');
  assert.ok(pavingFactor(8, 15) < 0.2, 'open grass stays grass');
  assert.ok(dirtFactor(-13.6, 9.4) > 0.9, 'the forest route is trodden dirt');
  assert.equal(dirtFactor(0, 4), 0, 'the plaza is not dirt');
});

test('the road tiles follow the street network without crossing walls', () => {
  const tiles = roadPlacements();
  assert.ok(tiles.length > 60, 'the plaza and streets are paved');
  for (const tile of tiles) {
    assert.equal(tile.module, 'road');
    assert.equal(tile.scale, TILE);
    assert.equal(isInsideBuilding(tile.x, tile.z, 0.1), false);
    assert.ok(Math.abs(tile.y - heightAt(tile.x, tile.z) - 0.045) < 1e-6);
  }
  assert.ok(propPlacements().length >= 25);
});
