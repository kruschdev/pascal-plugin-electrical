import { describe, expect, test } from 'bun:test'
import { auditSceneElectrical } from '../nec/audit'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  countPathBendDegrees,
  detectRunTradeClashes,
  extractRoutingCavities,
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

  test('R4-BUG-05: In-wall obstacle detours stay inside the wall cavity (never climbing above top plate even if a taller feature wall exists)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', parentId: null, height: 2.5 },
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], height: 2.5, thickness: 0.14 },
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], height: 2.5, thickness: 0.14 },
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], height: 3.6, thickness: 0.14 },
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], height: 2.5, thickness: 0.14 },
      pipe_top: {
        id: 'pipe_top',
        type: 'pipe-segment',
        parentId: 'level_0',
        diameter: 4,
        path: [
          [3.0, 2.44, -0.5],
          [3.0, 2.44, 0.5],
        ],
      },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    const obstacles = extractTradeObstacles(scene, 'level_0')
    const route = routeElectricalRun([0.07, 0.38, 1.2], [5.93, 0.38, 1.2], obstacles, {
      preferredChaseY: 2.55,
      walls,
      wallPlacement: 'in-wall',
    })

    expect(route.remainingClashes).toHaveLength(0)
    expect(route.avoidedObstacles.some((o) => o.nodeId === 'pipe_top')).toBe(true)
    // Every single waypoint MUST stay inside the 2.5 m standard wall height (<= 2.46 m), never floating into empty air!
    for (const pt of route.path) {
      expect(pt[1]).toBeLessThanOrEqual(2.46)
    }
  })

  test('Hybrid Wall-Manhattan <-> Attic Euclidean: transitions vertically through top plate into attic diagonal when roof exists and yields around attic HVAC duct', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', parentId: null, height: 2.5, level: 0 },
      roof_1: { id: 'roof_1', type: 'roof', parentId: 'level_0', name: 'Gable Roof' },
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.5, thickness: 0.14 },
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.5, thickness: 0.14 },
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.5, thickness: 0.14 },
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.14 },
      // Attic HVAC supply trunk crossing diagonally across the attic at y=2.62 (right across the direct diagonal!)
      duct_attic: {
        id: 'duct_attic',
        type: 'duct-segment',
        parentId: 'level_0',
        shape: 'round',
        diameter: 10,
        path: [
          [4.0, 2.62, 0.2],
          [4.0, 2.62, 5.8],
        ],
      },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    const cavities = extractRoutingCavities(scene, 'level_0')
    const obstacles = extractTradeObstacles(scene, 'level_0')
    expect(cavities.hasAttic).toBe(true)
    expect(cavities.hasCrawlSpace).toBe(false)
    expect(cavities.sources).toContain('roof')

    // Opposite-corner switches (y=1.22): Wall-Manhattan walks 14m around perimeter; Attic Euclidean cuts straight across attic (~10m + vertical risers) and clears the attic duct!
    const wallOnly = routeElectricalRun([0.07, 1.22, 1.0], [7.93, 1.22, 5.0], obstacles, {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
    })
    const hybrid = routeElectricalRun([0.07, 1.22, 1.0], [7.93, 1.22, 5.0], obstacles, {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })

    expect(wallOnly.routingMode).toBe('wall-manhattan')
    expect(hybrid.routingMode).toBe('attic-euclidean')
    expect(hybrid.remainingClashes).toHaveLength(0)
    expect(hybrid.routedLengthM).toBeLessThan(wallOnly.routedLengthM - 1.0)
    // Starts vertically up source wall centerline, enters attic (> 2.5m), drops vertically down destination wall centerline
    expect(hybrid.path[0]![0]).toBeCloseTo(0, 2)
    expect(hybrid.path[hybrid.path.length - 1]![0]).toBeCloseTo(8, 2)
    expect(hybrid.path.some((pt) => pt[1] >= 2.6)).toBe(true)
    expect(hybrid.necNotes.some((n) => n.includes('NEC 334.23'))).toBe(true)
  })

  test('Hybrid Wall-Manhattan <-> Crawl Space Euclidean: low opposite-wall outlets drop cleanly through sole plate into crawl space while same-wall outlets stay horizontally in-wall', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_crawl: { id: 'level_crawl', type: 'level', parentId: null, name: 'Crawl Space', level: -1, height: 1.0 },
      level_0: { id: 'level_0', type: 'level', parentId: null, name: 'Main Floor', level: 0, height: 2.5 },
      roof_1: { id: 'roof_1', type: 'roof', parentId: 'level_0' },
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.5, thickness: 0.14 },
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.5, thickness: 0.14 },
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.5, thickness: 0.14 },
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.14 },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    const cavities = extractRoutingCavities(scene, 'level_0')
    expect(cavities.hasAttic).toBe(true)
    expect(cavities.hasCrawlSpace).toBe(true)
    expect(cavities.crawlSpaceWet).toBe(false)

    // 1. Low outlets (y=0.38m) on opposite walls: dropping 0.56m into crawl space beats climbing 2.24m into attic!
    const lowCross = routeElectricalRun([0.07, 0.38, 1.5], [7.93, 0.38, 4.5], [], {
      walls,
      cavities,
      racewayType: 'nm-b',
      wireGauge: '12',
    })
    expect(lowCross.routingMode).toBe('crawlspace-euclidean')
    expect(lowCross.path.some((pt) => pt[1] < -0.1)).toBe(true)
    expect(lowCross.necNotes.some((n) => n.includes('NEC 334.15(C)'))).toBe(true)

    // 2. Ceiling fixtures / high devices (y >= 2.0m): NEVER drop to crawl space — use Attic Euclidean instead!
    const highCross = routeElectricalRun([0.07, 2.1, 1.5], [7.93, 2.46, 4.5], [], {
      walls,
      cavities,
      racewayType: 'nm-b',
      wireGauge: '14',
    })
    expect(highCross.routingMode).toBe('attic-euclidean')
    expect(highCross.path.every((pt) => pt[1] > 0)).toBe(true)

    // 3. Same-wall outlets with no door: stay horizontally bored inside the wall cavity (no pointless drop to crawl space!)
    const sameWall = routeElectricalRun([1.0, 0.38, 0.07], [3.5, 0.38, 0.07], [], {
      walls,
      cavities,
      racewayType: 'nm-b',
      wireGauge: '12',
    })
    expect(sameWall.routingMode).toBe('wall-manhattan')
    expect(sameWall.path.every((pt) => Math.abs(pt[1] - 0.38) < 0.02)).toBe(true)
  })

  test('NEC code gates: rigid EMT conduit stays orthogonal (NEC 110.12) and wet crawl space blocks NM-B (NEC 334.12(B)(4))', () => {
    const wetCrawlScene: Record<string, SceneNodeLike> = {
      level_crawl: { id: 'level_crawl', type: 'level', parentId: null, name: 'Damp Crawl Space', level: -1, height: 1.0 },
      level_0: { id: 'level_0', type: 'level', parentId: null, name: 'Main Floor', level: 0, height: 2.5 },
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], height: 2.5, thickness: 0.14 },
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], height: 2.5, thickness: 0.14 },
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], height: 2.5, thickness: 0.14 },
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], height: 2.5, thickness: 0.14 },
    }
    const walls = extractRoutingWalls(wetCrawlScene, 'level_0')
    const cavities = extractRoutingCavities(wetCrawlScene, 'level_0')
    expect(cavities.hasCrawlSpace).toBe(true)
    expect(cavities.crawlSpaceWet).toBe(true)

    // 1. NM-B is blocked from entering wet/damp crawl space per NEC 334.12(B)(4) -> stays Wall-Manhattan!
    const nmbRoute = routeElectricalRun([0.07, 0.38, 1.0], [5.93, 0.38, 3.0], [], {
      walls,
      cavities,
      racewayType: 'nm-b',
    })
    expect(nmbRoute.routingMode).toBe('wall-manhattan')
    expect(nmbRoute.path.every((pt) => pt[1] >= 0)).toBe(true)

    // 2. Rigid EMT conduit ALWAYS stays orthogonal wall-manhattan even with dry attic + dry crawl space (NEC 110.12 / 358.30)
    const emtRoute = routeElectricalRun([0.07, 0.38, 1.0], [5.93, 0.38, 3.0], [], {
      walls,
      cavities: { hasAttic: true, hasCrawlSpace: true, crawlSpaceWet: false, atticY: 2.62, crawlSpaceY: -0.18 },
      racewayType: 'emt',
    })
    expect(emtRoute.routingMode).toBe('wall-manhattan')

    // 3. auditSceneElectrical catches a manually forced NM-B run passing through a wet/damp crawl space (NEC 334.12(B)(4))
    const audit = auditSceneElectrical({
      ...wetCrawlScene,
      bad_run: {
        id: 'bad_run',
        type: 'electrical:conduit-run',
        parentId: 'level_0',
        name: 'Wet Crawl NM-B Run',
        occupancy: 'residential',
        racewayType: 'nm-b',
        wireGauge: '12',
        loadAmps: 10,
        path: [
          [0, 0.38, 1],
          [0, -0.18, 1],
          [6, -0.18, 3],
          [6, 0.38, 3],
        ],
      },
    })
    expect(audit.findings.some((f) => f.codeRef === 'NEC 334.12(B)(4)' && f.severity === 'error')).toBe(true)
  })
})
