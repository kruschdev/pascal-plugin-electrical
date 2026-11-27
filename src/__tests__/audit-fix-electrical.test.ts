import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TradeOccupancyGrid } from '@kruschdev/pascal-mep-kernel'
import {
  type RoutingWallSegment,
  type TradeObstacle,
  auditSceneElectrical,
  computeRoofEnvelopeFromWalls,
  countPathOpeningHits,
  extractRoutingWalls,
  extractWallOpeningPrisms,
  routeElectricalRun,
  routeElectricalViaLegalCavity,
} from '../nec'
import type { SceneNodeLike } from '../nec/load-calc'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function makeRectWalls(
  width = 10,
  depth = 6,
  height = 2.7,
  prefix = 'w',
): RoutingWallSegment[] {
  return [
    { id: `${prefix}1`, start: [0, 0], end: [width, 0], thickness: 0.14, height },
    { id: `${prefix}2`, start: [width, 0], end: [width, depth], thickness: 0.14, height },
    { id: `${prefix}3`, start: [width, depth], end: [0, depth], thickness: 0.14, height },
    { id: `${prefix}4`, start: [0, depth], end: [0, 0], thickness: 0.14, height },
  ]
}

describe('Phase 1 Electrical Audit Fixes (BUG-EH-01..04, BUG-EH-11, OPT-EH-01..03, CON-EH-04..05)', () => {
  test('BUG-EH-01: synthesizeKernelNodesFromWalls emits exact pitch (not roofHeight) and flat deck when hasAttic === false', () => {
    const walls = makeRectWalls(10, 6, 2.7, 'pitch_w')

    // 1. Low-pitch 2:12 gable (ridge = 2.7 + 3 * (2/12) = 3.20m vs buggy 6:12 = 4.20m)
    //    Route across the room near the eave (z = 0.5 -> z = 5.5) where a 2:12 roof is at
    //    2.7 + 0.5*(2/12) = 2.783m (attic roof clamp must respect 2:12, NOT 6:12).
    const lowPitchRes = routeElectricalViaLegalCavity({
      start: [2.0, 0.38, 0.0],
      end: [8.0, 0.38, 6.0],
      obstacles: [],
      walls,
      cavities: {
        hasAttic: true,
        roofPitchRise: 2,
        levelHeight: 2.7,
      },
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(lowPitchRes).not.toBeNull()
    expect(lowPitchRes!.roofViolation).toBe(false)
    // Verify every point on the path stays beneath the true 2:12 roof plane (wallH + (3 - |z-3|)*(2/12))
    for (const pt of lowPitchRes!.path) {
      const distFromRidge = Math.abs(pt[2] - 3)
      const true2on12Y = 2.7 + Math.max(0, 3 - distFromRidge) * (2 / 12)
      expect(pt[1]).toBeLessThanOrEqual(true2on12Y - 0.05)
    }

    // 2. Explicit low-pitch 2:12 roof-segment via cavities.explicitRoofSegs
    const expLowRes = routeElectricalViaLegalCavity({
      start: [2.0, 0.38, 0.0],
      end: [8.0, 0.38, 6.0],
      obstacles: [],
      walls,
      cavities: {
        hasAttic: true,
        levelHeight: 2.7,
        explicitRoofSegs: [
          {
            cx: 5,
            cz: 3,
            cosR: 1,
            sinR: 0,
            halfW: 5,
            halfD: 3,
            overhangM: 0.3,
            eaveY: 2.7,
            slopeTan: 2 / 12,
            roofType: 'gable',
          },
        ],
      },
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(expLowRes).not.toBeNull()
    expect(expLowRes!.roofViolation).toBe(false)
    for (const pt of expLowRes!.path) {
      const distFromRidge = Math.abs(pt[2] - 3)
      const true2on12Y = 2.7 + Math.max(0, 3 - distFromRidge) * (2 / 12)
      expect(pt[1]).toBeLessThanOrEqual(true2on12Y - 0.05)
    }

    // 3. Flat roof / no attic (`hasAttic: false` without explicitRoofSegs):
    //    must synthesize a flat deck (`pitch: 0`), never a 6:12 synthetic gable, and never enter attic.
    const flatRes = routeElectricalViaLegalCavity({
      start: [2.0, 0.38, 0.0],
      end: [8.0, 0.38, 6.0],
      obstacles: [],
      walls,
      cavities: {
        hasAttic: false,
        levelHeight: 2.7,
      },
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(flatRes).not.toBeNull()
    expect(flatRes!.roofViolation).toBe(false)
    expect(flatRes!.bandsUsed).not.toContain('attic')
    for (const pt of flatRes!.path) {
      expect(pt[1]).toBeLessThanOrEqual(2.7 + 1e-3)
    }
    // Distinct cache entry from pitched gable for the same walls array
    expect(flatRes!.graph).not.toBe(lowPitchRes!.graph)
  })

  test('BUG-EH-02: routeElectricalRun Step 4 respects routingStrategy === "wall-only" and never adopts attic/crawlspace', () => {
    // Wall with a wide window + structural header obstacle that forces Step 4 (routeElectricalViaLegalCavity)
    const walls: RoutingWallSegment[] = [
      {
        id: 'w_north',
        start: [0, 0],
        end: [8, 0],
        thickness: 0.14,
        height: 2.7,
        windowSpans: [{ startDist: 2.5, endDist: 5.5, sillY: 0.9, headY: 2.15 }],
      },
      { id: 'w_east', start: [8, 0], end: [8, 5], thickness: 0.14, height: 2.7 },
      { id: 'w_south', start: [8, 5], end: [0, 5], thickness: 0.14, height: 2.7 },
      { id: 'w_west', start: [0, 5], end: [0, 0], thickness: 0.14, height: 2.7 },
    ]
    // Place a structural header obstacle directly above the window at top-plate chase height
    const headerObstacle: TradeObstacle = {
      id: 'hdr_1',
      nodeId: 'hdr_1',
      nodeType: 'structural:beam',
      trade: 'structural',
      priorityRank: 1,
      box: { min: [2.4, 2.15, -0.1], max: [5.6, 2.68, 0.1] },
      requiredClearanceM: 0.03,
      label: 'LVL Window Header',
    }

    const res = routeElectricalRun([1.0, 1.12, 0.0], [7.0, 1.12, 0.0], [headerObstacle], {
      walls,
      cavities: {
        hasAttic: true,
        hasCrawlSpace: true,
        crawlSpaceWet: false,
        atticY: 2.95,
        crawlSpaceY: -0.25,
        levelHeight: 2.7,
        sources: ['roof', 'crawlspace'],
      },
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
      wallPlacement: 'in-wall',
    })

    expect(res.routingMode).toBe('wall-manhattan')
    for (const pt of res.path) {
      // Strictly inside wall height band — never climbed into attic (> 2.7) or dropped into crawlspace (< 0)
      expect(pt[1]).toBeGreaterThanOrEqual(0.0)
      expect(pt[1]).toBeLessThanOrEqual(2.7)
    }
  })

  test('BUG-EH-03: routeElectricalViaLegalCavity does not lock onto levelIds[0] when levelId is omitted on multi-story scenes', () => {
    // Multi-story scene: basement at x in [0, 4], z in [0, 4]; upper story (level_1) at x in [0, 12], z in [0, 8].
    // If BUG-EH-03 were present, omitting `levelId` would lock onto `level_bsmt` (levelIds[0]) and fail/distort the run!
    const multiStoryScene: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      level_bsmt: { id: 'level_bsmt', type: 'level', parentId: 'bldg', level: -1, height: 2.4 },
      level_0: { id: 'level_0', type: 'level', parentId: 'bldg', level: 0, height: 2.7 },
      level_1: { id: 'level_1', type: 'level', parentId: 'bldg', level: 1, height: 2.7 },
      // Basement walls (small 4x4 core)
      bw1: { id: 'bw1', type: 'wall', parentId: 'level_bsmt', start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.4 },
      bw2: { id: 'bw2', type: 'wall', parentId: 'level_bsmt', start: [4, 0], end: [4, 4], thickness: 0.2, height: 2.4 },
      bw3: { id: 'bw3', type: 'wall', parentId: 'level_bsmt', start: [4, 4], end: [0, 4], thickness: 0.2, height: 2.4 },
      bw4: { id: 'bw4', type: 'wall', parentId: 'level_bsmt', start: [0, 4], end: [0, 0], thickness: 0.2, height: 2.4 },
      // Ground floor walls
      gw1: { id: 'gw1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.14, height: 2.7 },
      gw2: { id: 'gw2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.14, height: 2.7 },
      gw3: { id: 'gw3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.14, height: 2.7 },
      gw4: { id: 'gw4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.14, height: 2.7 },
      // Upper story (level_1) extended wing walls at x in [0, 12], z in [0, 8]
      uw1: { id: 'uw1', type: 'wall', parentId: 'level_1', start: [0, 0], end: [12, 0], thickness: 0.14, height: 2.7 },
      uw2: { id: 'uw2', type: 'wall', parentId: 'level_1', start: [12, 0], end: [12, 8], thickness: 0.14, height: 2.7 },
      uw3: { id: 'uw3', type: 'wall', parentId: 'level_1', start: [12, 8], end: [0, 8], thickness: 0.14, height: 2.7 },
      uw4: { id: 'uw4', type: 'wall', parentId: 'level_1', start: [0, 8], end: [0, 0], thickness: 0.14, height: 2.7 },
    }

    const upperWalls = extractRoutingWalls(multiStoryScene, 'level_1')
    const inferredRes = routeElectricalViaLegalCavity({
      start: [10.0, 0.38, 0.0],
      end: [12.0, 0.38, 6.5],
      obstacles: [],
      nodes: multiStoryScene,
      // levelId intentionally omitted!
      walls: upperWalls,
      racewayType: 'nm-b',
    })
    const explicitRes = routeElectricalViaLegalCavity({
      start: [10.0, 0.38, 0.0],
      end: [12.0, 0.38, 6.5],
      obstacles: [],
      nodes: multiStoryScene,
      levelId: 'level_1',
      walls: upperWalls,
      racewayType: 'nm-b',
    })
    expect(inferredRes).not.toBeNull()
    expect(explicitRes).not.toBeNull()
    expect(inferredRes!.ok).toBe(true)
    expect(inferredRes!.outdoorVoidViolation).toBe(false)
    // Inferred level_1 graph matches the explicit level_1 cached graph identically (not level_bsmt!)
    expect(inferredRes!.graph).toBe(explicitRes!.graph)

    // Synthetic walls not present in `multiStoryScene` with omitted `levelId` must fall back to walls-only
    // rather than routing against `level_bsmt` (levelIds[0]).
    const syntheticUpperWalls = makeRectWalls(12, 8, 2.7, 'syn_u')
    const fallbackRes = routeElectricalViaLegalCavity({
      start: [10.0, 0.38, 0.0],
      end: [12.0, 0.38, 6.5],
      obstacles: [],
      nodes: multiStoryScene,
      walls: syntheticUpperWalls,
      racewayType: 'nm-b',
    })
    expect(fallbackRes).not.toBeNull()
    expect(fallbackRes!.ok).toBe(true)
    expect(fallbackRes!.outdoorVoidViolation).toBe(false)
    expect(fallbackRes!.graph).not.toBe(explicitRes!.graph)
  })

  test('BUG-EH-04: auditSceneElectrical flags lowercase and mixed-case outdoor NEMA-1 panels under NEC 312.2', () => {
    const makeOutdoorPanelScene = (nemaRating: string): Record<string, SceneNodeLike> => ({
      lvl: { id: 'lvl', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'lvl', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'lvl', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'lvl', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'lvl', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.7 },
      z_patio: {
        id: 'z_patio',
        type: 'zone',
        parentId: 'lvl',
        name: 'Back Patio',
        category: 'patio',
        polygon: [[0, 4], [6, 4], [6, 8], [0, 8]],
      },
      panel_out: {
        id: 'panel_out',
        type: 'electrical:panel',
        parentId: 'lvl',
        name: 'SUB-OUT',
        position: [3.0, 1.5, 4.12],
        rotation: 0,
        ratedAmps: 100,
        voltageSystem: '120/240V-1P',
        nemaRating,
        spaces: 20,
      },
    })

    const lowerAudit = auditSceneElectrical(makeOutdoorPanelScene('nema-1'))
    const lower312 = lowerAudit.findings.filter((f) => f.codeRef === 'NEC 312.2')
    expect(lower312.length).toBe(1)
    expect(lower312[0]!.severity).toBe('error')
    expect(lower312[0]!.nodeIds).toContain('panel_out')

    const mixedAudit = auditSceneElectrical(makeOutdoorPanelScene('Nema-1'))
    expect(mixedAudit.findings.filter((f) => f.codeRef === 'NEC 312.2').length).toBe(1)

    const validAudit = auditSceneElectrical(makeOutdoorPanelScene('nema-3r'))
    expect(validAudit.findings.filter((f) => f.codeRef === 'NEC 312.2').length).toBe(0)
  })

  test('CON-EH-05: auditSceneElectrical matches kernel evaluateFixtureKeepout strict `<` boundary for tub switch (0.15m) & stove receptacle (0.08m)', () => {
    // Tub box centered at [1.0, 0, -0.4] with width 1.5, depth 0.8 (z in [-0.8, 0.0], exact maxZ = 0).
    // Switch at z = 0.15 has exact IEEE-754 horizDist === 0.15m (legal per kernel `< 0.15`);
    // switch at z = 0.14 has horizDist === 0.14m (< 0.15 -> NEC 404.4(C) error).
    const makeBathScene = (switchZ: number): Record<string, SceneNodeLike> => ({
      lvl: { id: 'lvl', type: 'level', height: 2.7 },
      z_bath: {
        id: 'z_bath',
        type: 'zone',
        parentId: 'lvl',
        name: 'Bathroom',
        category: 'bathroom',
        polygon: [[-1, -2], [4, -2], [4, 3], [-1, 3]],
      },
      tub_1: {
        id: 'tub_1',
        type: 'item',
        parentId: 'lvl',
        name: 'Bathtub',
        position: [1.0, 0, -0.4],
        dimensions: [1.5, 0.55, 0.8],
      },
      sw_1: {
        id: 'sw_1',
        type: 'electrical:device',
        parentId: 'lvl',
        name: 'Bath Switch',
        deviceKind: 'switch-1p',
        position: [1.0, 1.22, switchZ],
      },
    })

    const atExactBoundary = auditSceneElectrical(makeBathScene(0.15))
    expect(atExactBoundary.findings.filter((f) => f.codeRef === 'NEC 404.4(C)')).toHaveLength(0)

    const insideBoundary = auditSceneElectrical(makeBathScene(0.14))
    expect(insideBoundary.findings.filter((f) => f.codeRef === 'NEC 404.4(C)')).toHaveLength(1)

    // Stove centered at [2.0, 0, -0.35] with width 0.76, depth 0.70 (z in [-0.70, 0.0], exact maxZ = 0).
    // Receptacle at z = 0.08 has exact IEEE-754 horizDist === 0.08m (legal per kernel `< 0.08`);
    // receptacle at z = 0.07 has horizDist === 0.07m (< 0.08 -> NEC 210.52(C) / 110.11 error).
    const makeKitchenScene = (recZ: number): Record<string, SceneNodeLike> => ({
      lvl: { id: 'lvl', type: 'level', height: 2.7 },
      z_kit: {
        id: 'z_kit',
        type: 'zone',
        parentId: 'lvl',
        name: 'Kitchen',
        category: 'kitchen',
        polygon: [[-1, -2], [5, -2], [5, 3], [-1, 3]],
      },
      stove_1: {
        id: 'stove_1',
        type: 'item',
        parentId: 'lvl',
        name: 'Gas Range Stove',
        position: [2.0, 0, -0.35],
        dimensions: [0.76, 0.9, 0.7],
      },
      rec_1: {
        id: 'rec_1',
        type: 'electrical:device',
        parentId: 'lvl',
        name: 'Counter Outlet',
        deviceKind: 'gfci',
        position: [2.0, 1.12, recZ],
      },
    })

    const stoveAtBoundary = auditSceneElectrical(makeKitchenScene(0.08))
    expect(stoveAtBoundary.findings.filter((f) => f.codeRef === 'NEC 210.52(C) / 110.11')).toHaveLength(0)

    const stoveInside = auditSceneElectrical(makeKitchenScene(0.07))
    expect(stoveInside.findings.filter((f) => f.codeRef === 'NEC 210.52(C) / 110.11')).toHaveLength(1)
  })

  test('OPT-EH-01..03: WeakMap caches reuse roof envelopes, opening prism kernels, and base TradeOccupancyGrid', () => {
    const walls = makeRectWalls(10, 6, 2.7, 'opt_w')
    const scene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.7 },
      opt_w1: { id: 'opt_w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [10, 0], thickness: 0.14, height: 2.7 },
      opt_w2: { id: 'opt_w2', type: 'wall', parentId: 'l0', start: [10, 0], end: [10, 6], thickness: 0.14, height: 2.7 },
      opt_w3: { id: 'opt_w3', type: 'wall', parentId: 'l0', start: [10, 6], end: [0, 6], thickness: 0.14, height: 2.7 },
      opt_w4: { id: 'opt_w4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], thickness: 0.14, height: 2.7 },
    }

    // OPT-EH-01: computeRoofEnvelopeFromWalls caches by nodes and by walls
    const envN1 = computeRoofEnvelopeFromWalls(walls, 2.7, 6, scene, 'l0')
    const envN2 = computeRoofEnvelopeFromWalls(walls, 2.7, 6, scene, 'l0')
    expect(envN1).not.toBeNull()
    expect(envN2).toBe(envN1)

    const envW1 = computeRoofEnvelopeFromWalls(walls, 2.7, 6)
    const envW2 = computeRoofEnvelopeFromWalls(walls, 2.7, 6)
    expect(envW1).not.toBeNull()
    expect(envW2).toBe(envW1)

    // OPT-EH-02: countPathOpeningHits preserves exact results with memoized kernel prism array
    const windowedWalls: RoutingWallSegment[] = [
      {
        id: 'ww1',
        start: [0, 0],
        end: [6, 0],
        thickness: 0.14,
        height: 2.7,
        windowSpans: [{ startDist: 2.0, endDist: 4.0, sillY: 0.9, headY: 2.1 }],
      },
    ]
    const prisms = extractWallOpeningPrisms(windowedWalls)
    expect(countPathOpeningHits([[1.0, 1.5, 0], [5.0, 1.5, 0]], prisms, 0)).toBe(1)
    expect(countPathOpeningHits([[1.0, 0.3, 0], [5.0, 0.3, 0]], prisms, 0)).toBe(0)

    // OPT-EH-03: routeElectricalViaLegalCavity accepts optional prebuilt TradeOccupancyGrid and caches by obstacles
    const obstacles: TradeObstacle[] = [
      {
        id: 'pipe_1',
        nodeId: 'pipe_1',
        nodeType: 'plumbing:pipe-run',
        trade: 'plumbing',
        priorityRank: 2,
        box: { min: [4.8, 0.2, -0.15], max: [5.2, 2.5, 0.15] },
        requiredClearanceM: 0.05,
        label: 'Main Stack',
      },
    ]
    const r1 = routeElectricalViaLegalCavity({
      start: [1.0, 0.38, 0.0],
      end: [9.0, 0.38, 0.0],
      obstacles,
      walls,
      racewayType: 'nm-b',
    })
    const r2 = routeElectricalViaLegalCavity({
      start: [1.0, 0.38, 0.0],
      end: [9.0, 0.38, 0.0],
      obstacles,
      walls,
      racewayType: 'nm-b',
    })
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r2!.graph).toBe(r1!.graph)
    expect(r2!.path).toEqual(r1!.path)

    const customGrid = new TradeOccupancyGrid([])
    const rCustom = routeElectricalViaLegalCavity({
      start: [1.0, 0.38, 0.0],
      end: [9.0, 0.38, 0.0],
      obstacles,
      occupancy: customGrid,
      walls,
      racewayType: 'nm-b',
    })
    expect(rCustom).not.toBeNull()
    expect(rCustom!.ok).toBe(true)
  })

  test('BUG-EH-11: build-dist keeps @kruschdev/pascal-mep-kernel strictly external (never bundled into dist/)', async () => {
    const buildScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-dist.ts'), 'utf8')
    expect(buildScript).toContain("'@kruschdev/pascal-mep-kernel'")
    expect(buildScript).toContain("'@kruschdev/pascal-mep-kernel/*'")

    // Run an in-memory Bun.build mirroring scripts/build-dist.ts external list
    const buildResult = await Bun.build({
      entrypoints: [
        path.join(REPO_ROOT, 'src', 'index.ts'),
        path.join(REPO_ROOT, 'src', 'nec', 'index.ts'),
      ],
      root: path.join(REPO_ROOT, 'src'),
      target: 'browser',
      format: 'esm',
      splitting: true,
      sourcemap: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'three',
        'zod',
        'zustand',
        '@pascal-app/*',
        '@kruschdev/pascal-mep-kernel',
        '@kruschdev/pascal-mep-kernel/*',
      ],
      throw: false,
    })
    expect(buildResult.success).toBe(true)

    let sawExternalKernelImport = false
    for (const output of buildResult.outputs) {
      if (!output.path.endsWith('.js')) continue
      const text = await output.text()
      expect(text).not.toMatch(/\bclass\s+TradeOccupancyGrid\b/)
      expect(text).not.toMatch(/\bfunction\s+compileBuildingAnatomy\b/)
      expect(text).not.toContain('pascal-mep-kernel/dist/')
      if (/from\s*['"]@kruschdev\/pascal-mep-kernel(?:\/[^'"]*)?['"]/.test(text)) {
        sawExternalKernelImport = true
      }
    }
    expect(sawExternalKernelImport).toBe(true)

    // Also verify existing dist/*.d.ts size invariant (< 15 KB for top-level entry declarations) when dist/ exists
    const distDir = path.join(REPO_ROOT, 'dist')
    if (fs.existsSync(distDir)) {
      for (const entry of fs.readdirSync(distDir)) {
        if (entry.endsWith('.d.ts')) {
          const stat = fs.statSync(path.join(distDir, entry))
          expect(stat.size).toBeLessThan(15 * 1024)
        }
      }
    }
  })
})
