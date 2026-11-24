import { describe, expect, test } from 'bun:test'
import {
  countPathBendDegrees,
  detectRunTradeClashes,
  extractRoutingWalls,
  extractTradeObstacles,
  routeElectricalRun,
  type RoutingWallSegment,
} from '../nec/routing'

describe('Trade-Priority Obstacle-Aware Electrical Routing', () => {
  test('Electrical yields to Plumbing (pipe-segment) — routes cleanly around pipe without moving it', () => {
    const scene = {
      'pipe-segment_1': {
        id: 'pipe-segment_1',
        type: 'pipe-segment',
        diameter: 4, // 4" DWV stack crossing the electrical ceiling chase at x=2
        path: [
          [2.0, 2.55, -1.0],
          [2.0, 2.55, 2.0],
        ],
      },
    }

    const obstacles = extractTradeObstacles(scene)
    expect(obstacles.length).toBe(1)
    expect(obstacles[0]!.trade).toBe('plumbing')
    expect(obstacles[0]!.priorityRank).toBe(2)

    const result = routeElectricalRun([0, 1.5, 0], [4, 0.4, 0], obstacles, {
      preferredChaseY: 2.55,
      clearanceM: 0.05,
    })

    expect(result.remainingClashes.length).toBe(0)
    expect(result.avoidedObstacles.length).toBe(1)
    expect(result.avoidedObstacles[0]!.nodeId).toBe('pipe-segment_1')
    expect(result.avoidedObstacles[0]!.trade).toBe('plumbing')
    // Plumbing pipe untouched; electrical path detoured cleanly around it while staying in ceiling zone (>= 2.2m)
    expect(detectRunTradeClashes(result.path, obstacles)).toHaveLength(0)
    expect(result.routedLengthM).toBeGreaterThan(4)
    const chaseYs = result.path.slice(1, -1).map((p) => p[1])
    expect(chaseYs.every((y) => y >= 2.2)).toBe(true)
  })

  test('Horizontal ceiling feeder jogs cleanly around a plumbing stack with measurable detour & bend count', () => {
    const scene = {
      'pipe-segment_stack': {
        id: 'pipe-segment_stack',
        type: 'pipe-segment',
        diameter: 4,
        path: [
          [2.0, 2.55, -1.0],
          [2.0, 2.55, 1.0],
        ],
      },
    }

    const obstacles = extractTradeObstacles(scene)
    const result = routeElectricalRun([0, 2.55, 0], [4, 2.55, 0], obstacles, {
      preferredChaseY: 2.55,
      clearanceM: 0.05,
    })

    expect(result.remainingClashes.length).toBe(0)
    expect(result.detourAddedM).toBeGreaterThan(0)
    expect(result.totalBendDegrees).toBeGreaterThanOrEqual(180)
    expect(result.avoidedObstacles.some((a) => a.trade === 'plumbing')).toBe(true)
  })

  test('Electrical yields to BOTH Plumbing (pipe-segment) and HVAC (rect duct-segment + hvac-equipment)', () => {
    const scene = {
      'pipe-segment_1': {
        id: 'pipe-segment_1',
        type: 'pipe-segment',
        diameter: 3,
        path: [
          [1.5, 2.55, -2],
          [1.5, 2.55, 2],
        ],
      },
      'duct-segment_1': {
        id: 'duct-segment_1',
        type: 'duct-segment',
        shape: 'rect',
        width: 18,
        height: 10,
        path: [
          [3.0, 2.55, -2],
          [3.0, 2.55, 2],
        ],
      },
      'hvac-equipment_1': {
        id: 'hvac-equipment_1',
        type: 'hvac-equipment',
        position: [2.2, 0, 0],
        width: 0.7,
        depth: 0.7,
        height: 1.5,
      },
    }

    const obstacles = extractTradeObstacles(scene)
    expect(obstacles.map((o) => o.trade)).toEqual(['plumbing', 'hvac', 'hvac'])

    const result = routeElectricalRun([0, 1.5, 0], [5, 0.4, 0], obstacles, {
      preferredChaseY: 2.55,
    })

    expect(result.remainingClashes.length).toBe(0)
    expect(result.avoidedObstacles.length).toBeGreaterThanOrEqual(2)
    expect(result.avoidedObstacles.some((a) => a.trade === 'plumbing')).toBe(true)
    expect(result.avoidedObstacles.some((a) => a.trade === 'hvac')).toBe(true)
  })

  test('countPathBendDegrees flags > 360° raceway runs per NEC 358.26 and suggests a pull-box point', () => {
    // Five 90° turns = 450° > 360° limit
    const zigzag = [
      [0, 1.5, 0],
      [0, 2.5, 0], // 90°
      [1, 2.5, 0], // 90°
      [1, 2.5, 1], // 90°
      [2, 2.5, 1], // 90°
      [2, 2.5, 0], // 90° -> 450°
      [2, 0.4, 0],
    ] as const

    const bends = countPathBendDegrees(zigzag)
    expect(bends.totalBendDegrees).toBe(450)
    expect(bends.bendCount90).toBe(5)
    expect(bends.pullBoxIndex).not.toBeNull()
  })

  test('Wall-guided Manhattan routing keeps same-wall outlets horizontal and climbs over doors', () => {
    const walls: RoutingWallSegment[] = [
      { id: 'w_south', start: [0, 0], end: [6, 0], thickness: 0.12, height: 2.5, doorSpans: [[2.5, 3.5]] },
    ]

    // Two outlets on the same wall with NO door between them -> concealed horizontal stud chase inside wall centerline (z=0, y=0.38)
    const horiz = routeElectricalRun([0.6, 0.38, 0.07], [2.1, 0.38, 0.07], [], {
      preferredChaseY: 2.55,
      walls,
    })
    expect(horiz.path.every((pt) => Math.abs(pt[1] - 0.38) < 0.01)).toBe(true)
    expect(horiz.path.every((pt) => Math.abs(pt[2]) <= 0.01)).toBe(true)
    expect(horiz.totalBendDegrees).toBe(0)

    // Two outlets on the same wall with a DOOR between them -> climbs over door header inside wall top plate (2.44 m)
    const overDoor = routeElectricalRun([1.2, 0.38, 0.07], [4.8, 0.38, 0.07], [], {
      preferredChaseY: 2.55,
      walls,
    })
    expect(overDoor.path.some((pt) => pt[1] >= 2.35 && pt[1] <= 2.46)).toBe(true)
    // Every waypoint stays strictly dead-center inside the wall (z = 0, between the drywall faces)
    expect(overDoor.path.every((pt) => Math.abs(pt[2]) <= 0.01)).toBe(true)
  })

  test('Wall-guided Manhattan routing follows wall corners around open rooms and still yields to plumbing', () => {
    const scene = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.1 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.1 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.1 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.1 },
      // Plumbing pipe crossing the north wall top plate cavity at x = 3, y = 2.44
      pipe_1: {
        id: 'pipe_1',
        type: 'pipe-segment',
        parentId: 'level_0',
        diameter: 4,
        path: [
          [3.0, 2.44, -0.8],
          [3.0, 2.44, 0.8],
        ],
      },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    expect(walls).toHaveLength(4)
    const obstacles = extractTradeObstacles(scene, 'level_0')

    // West wall outlet -> East wall outlet (if naive shortest path, it would cut across z=1.2 middle of room!)
    const route = routeElectricalRun([0.06, 0.38, 1.2], [5.94, 0.38, 1.2], obstacles, {
      preferredChaseY: 2.55,
      walls,
    })

    expect(route.remainingClashes).toHaveLength(0)
    expect(route.avoidedObstacles.some((o) => o.nodeId === 'pipe_1')).toBe(true)

    // Verify route follows the north perimeter wall (z ~ 0) rather than cutting across open room interior (z ~ 1.2)
    const middleInteriorPts = route.path.filter(
      (pt) => pt[0] > 0.5 && pt[0] < 5.5 && pt[2] > 0.4 && pt[2] < 3.6,
    )
    expect(middleInteriorPts).toHaveLength(0)
  })
})
