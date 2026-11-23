import { describe, expect, test } from 'bun:test'
import {
  countPathBendDegrees,
  detectRunTradeClashes,
  extractTradeObstacles,
  routeElectricalRun,
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
})
