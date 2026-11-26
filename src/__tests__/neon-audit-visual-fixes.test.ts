import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import {
  auditSceneElectrical,
  extractWetFixtures,
  getEquipmentSpacePrisms,
  isNonFixtureItem,
} from '../nec/audit'
import { findNextWallPlacement, planNecAutoPopulate } from '../nec/autopopulate'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  computeRoofEnvelopeFromWalls,
  extractRoutingCavities,
  extractRoutingWalls,
  extractTradeObstacles,
  resolveLevelHeightM,
  roofYAt,
  routeElectricalRun,
  type TradeObstacle,
} from '../nec/routing'

function applyChanges(
  nodes: Record<string, SceneNodeLike>,
  out: { changes?: { create?: Array<{ node: unknown }>; delete?: string[] } },
): Record<string, SceneNodeLike> {
  const next: Record<string, SceneNodeLike> = { ...nodes }
  for (const id of out.changes?.delete ?? []) delete next[id]
  for (const c of out.changes?.create ?? []) {
    const n = c.node as SceneNodeLike
    next[n.id] = n
  }
  return next
}

describe('Neon Electrical Audit & Visual Geometry Regression Suite (ELC-A-BUG-01..08, ELC-R-BUG-01..10, VIS-05, VIS-06)', () => {
  test('ELC-A-BUG-01..03: fixtureTextOf separator normalization, Dining on Kitchen SAB (NEC 210.52(B)(1)), and isNonFixtureItem precision', () => {
    // ELC-A-BUG-01: Underscore/slash-delimited fixture identifiers recognized
    const underscoreScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.6 },
      f_sink: { id: 'f_sink', type: 'item', parentId: 'l0', name: 'kitchen_sink_double', position: [1, 0, 1] },
      f_cooktop: { id: 'f_cooktop', type: 'item', parentId: 'l0', name: 'induction_cooktop_36', position: [3, 0, 1] },
      f_oven: { id: 'f_oven', type: 'item', parentId: 'l0', asset: { src: '/models/double_oven.glb' }, position: [5, 0, 1] },
      f_tub: { id: 'f_tub', type: 'item', parentId: 'l0', name: 'soaking_tub', position: [7, 0, 1] },
    }
    const extracted = extractWetFixtures(underscoreScene, 'l0')
    expect(extracted.map((f) => `${f.node.id}:${f.kind}`).sort()).toEqual([
      'f_cooktop:stove',
      'f_oven:stove',
      'f_sink:sink',
      'f_tub:tub-shower',
    ])

    // ELC-A-BUG-03: Real fixtures with decor words stay fixtures; plural accessories are excluded
    expect(isNonFixtureItem({ id: '1', type: 'item', name: 'Framed Shower' })).toBe(false)
    expect(isNonFixtureItem({ id: '2', type: 'item', name: 'Shower with Bench' })).toBe(false)
    expect(isNonFixtureItem({ id: '3', type: 'item', name: 'Vanity Sink & Mirror' })).toBe(false)
    expect(isNonFixtureItem({ id: '4', type: 'item', name: 'Tub with Shelf' })).toBe(false)
    expect(isNonFixtureItem({ id: '5', type: 'item', name: 'Double Oven with Rack' })).toBe(false)
    expect(isNonFixtureItem({ id: '6', type: 'cabinet', name: 'Sink Vanity Mirror Cabinet' })).toBe(false)

    expect(isNonFixtureItem({ id: '7', type: 'item', name: 'Shower Curtains' })).toBe(true)
    expect(isNonFixtureItem({ id: '8', type: 'item', name: 'Tub Mats' })).toBe(true)
    expect(isNonFixtureItem({ id: '9', type: 'item', name: 'Shower Shelves' })).toBe(true)
    expect(isNonFixtureItem({ id: '10', type: 'item', name: 'Shower Caddies' })).toBe(true)
    expect(isNonFixtureItem({ id: '11', type: 'item', name: 'Shower Racks' })).toBe(true)

    // ELC-A-BUG-02: Dining / Comedor receptacles on Kitchen SAB circuit pass NEC 210.52(B)(1),
    // while Bathroom + Dining on same circuit still fails NEC 210.11(C)(3).
    const sabScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.6 },
      z_kit: { id: 'z_kit', type: 'zone', parentId: 'l0', name: 'Kitchen', category: 'kitchen', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      z_din: { id: 'z_din', type: 'zone', parentId: 'l0', name: 'Comedor', category: 'dining', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'l0', name: 'Bath', category: 'bathroom', polygon: [[8, 0], [11, 0], [11, 4], [8, 4]] },
      p1: { id: 'p1', type: 'electrical:panel', parentId: 'l0', position: [0.2, 1.52, 0.2], busRatingAmps: 200, mainBreakerAmps: 200, spaces: 40 },
      d_kit: { id: 'd_kit', type: 'electrical:device', parentId: 'l0', panelId: 'p1', circuitNumber: 1, deviceKind: 'gfci', gfciProtected: true, afciProtected: true, breakerAmps: 20, wireGauge: '12', position: [1.5, 1.12, 0.2] },
      d_din: { id: 'd_din', type: 'electrical:device', parentId: 'l0', panelId: 'p1', circuitNumber: 1, deviceKind: 'duplex', gfciProtected: true, afciProtected: true, breakerAmps: 20, wireGauge: '12', position: [5.5, 0.38, 0.2] },
      d_bath: { id: 'd_bath', type: 'electrical:device', parentId: 'l0', panelId: 'p1', circuitNumber: 3, deviceKind: 'gfci', gfciProtected: true, breakerAmps: 20, wireGauge: '12', position: [9.5, 1.12, 0.2] },
      d_din_bad: { id: 'd_din_bad', type: 'electrical:device', parentId: 'l0', panelId: 'p1', circuitNumber: 3, deviceKind: 'duplex', gfciProtected: true, afciProtected: true, breakerAmps: 20, wireGauge: '12', position: [6.5, 0.38, 0.2] },
    }
    const report = auditSceneElectrical(sabScene)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.11(C)(1)')).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.11(C)(3)' && f.severity === 'error')).toBe(true)
  })

  test('ELC-A-BUG-04..06 & ELC-CON-03: NEC 406.9(C) Exception (breaker GFCI, bathroom-only, recessed tub), mepHardwired: false, and AFCI outdoor/garage/garden exclusions', () => {
    const scene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.6 },
      // Compact bathroom (1.05m x 1.0m) with recessed alcove shower whose center falls slightly outside polygon
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'l0', name: 'Half Bath', category: 'bathroom', polygon: [[0, 0], [1.05, 0], [1.05, 1.0], [0, 1.0]] },
      tub_alcove: { id: 'tub_alcove', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'shower', name: 'Alcove Shower', position: [-0.05, 0, 0.5], width: 0.9, depth: 0.9, height: 2.1 },
      // Breaker-GFCI protected duplex on opposite wall (horizDist ~ 0.58m < 0.914m; max achievable < 0.72m)
      d_bath_brk: { id: 'd_bath_brk', type: 'electrical:device', parentId: 'l0', deviceKind: 'duplex', gfciProtected: true, position: [0.98, 1.12, 0.5] },
      // Master Bedroom with a soaking tub — must NOT get compact bathroom exception!
      z_bed: { id: 'z_bed', type: 'zone', parentId: 'l0', name: 'Master Bedroom', category: 'bedroom', polygon: [[4, 0], [5.4, 0], [5.4, 1.5], [4, 1.5]] },
      tub_bed: { id: 'tub_bed', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'bathtub', name: 'Soaking Tub', position: [4.3, 0, 0.75], width: 0.6, depth: 0.8, height: 0.6 },
      d_bed_gfci: { id: 'd_bed_gfci', type: 'electrical:device', parentId: 'l0', deviceKind: 'gfci', gfciProtected: true, afciProtected: true, position: [5.32, 1.12, 0.75] },
      // Outdoor Kitchen, Garden (substring "den"), Garage Entry, and Spanish Habitación
      z_out_kit: { id: 'z_out_kit', type: 'zone', parentId: 'l0', name: 'Outdoor Kitchen', category: 'outdoor', polygon: [[10, 0], [13, 0], [13, 3], [10, 3]] },
      z_garden: { id: 'z_garden', type: 'zone', parentId: 'l0', name: 'Garden', category: 'garden', polygon: [[14, 0], [17, 0], [17, 3], [14, 3]] },
      z_gar: { id: 'z_gar', type: 'zone', parentId: 'l0', name: 'Garage Entry', category: 'garage', polygon: [[18, 0], [21, 0], [21, 3], [18, 3]] },
      z_hab: { id: 'z_hab', type: 'zone', parentId: 'l0', name: 'Habitación Principal', category: 'room', polygon: [[22, 0], [25, 0], [25, 3], [22, 3]] },
      d_out_kit: { id: 'd_out_kit', type: 'electrical:device', parentId: 'l0', deviceKind: 'weatherproof-gfci', gfciProtected: true, afciProtected: false, position: [11, 0.45, 1] },
      d_garden: { id: 'd_garden', type: 'electrical:device', parentId: 'l0', deviceKind: 'weatherproof-gfci', gfciProtected: true, afciProtected: false, position: [15, 0.45, 1] },
      d_gar: { id: 'd_gar', type: 'electrical:device', parentId: 'l0', deviceKind: 'gfci', gfciProtected: true, afciProtected: false, position: [19, 1.22, 1] },
      d_hab_no_afci: { id: 'd_hab_no_afci', type: 'electrical:device', parentId: 'l0', deviceKind: 'duplex', afciProtected: false, position: [23, 0.38, 1] },
      // Cord-and-plug tankless gas water heater in garage without GFCI (explicit mepHardwired: false)
      wh_tankless: { id: 'wh_tankless', type: 'plumbing:equipment', parentId: 'l0', equipmentKind: 'water-heater-tankless-gas', position: [19.5, 0, 2.0] },
      d_tankless: {
        id: 'd_tankless',
        type: 'electrical:device',
        parentId: 'l0',
        deviceKind: 'duplex',
        gfciProtected: false,
        metadata: { mepSourceNodeId: 'wh_tankless', mepHardwired: false },
        position: [19.5, 0.9, 2.2],
      },
    }

    const report = auditSceneElectrical(scene)
    // Compact bath breaker-GFCI gets warning (Exception), NOT hard error
    const bathFindings = report.findings.filter((f) => f.nodeIds.includes('d_bath_brk'))
    expect(bathFindings.some((f) => f.codeRef === 'NEC 406.9(C) Exception' && f.severity === 'warning')).toBe(true)
    expect(bathFindings.some((f) => f.codeRef === 'NEC 406.9(C)' && f.severity === 'error')).toBe(false)

    // Master bedroom soaking tub gets hard NEC 406.9(C) error (never bathroom exception)
    expect(
      report.findings.some((f) => f.nodeIds.includes('d_bed_gfci') && f.codeRef === 'NEC 406.9(C)' && f.severity === 'error'),
    ).toBe(true)

    // Outdoor Kitchen, Garden, Garage Entry do NOT trigger NEC 210.12(A) AFCI warnings
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.12(A)' && f.nodeIds.includes('d_out_kit'))).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.12(A)' && f.nodeIds.includes('d_garden'))).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.12(A)' && f.nodeIds.includes('d_gar'))).toBe(false)
    // Spanish Habitación DOES trigger NEC 210.12(A) (ELC-CON-03)
    expect(report.findings.some((f) => f.codeRef === 'NEC 210.12(A)' && f.nodeIds.includes('d_hab_no_afci'))).toBe(true)

    // Cord-and-plug tankless gas water heater in garage without GFCI IS caught by NEC 210.8(A) (ELC-A-BUG-05)
    expect(
      report.findings.some((f) => f.codeRef === 'NEC 210.8(A)' && f.nodeIds.includes('d_tankless')),
    ).toBe(true)
  })

  test('ELC-A-BUG-07, ELC-A-BUG-08 & ELC-CON-01: NEC 110.26(E) structural ceiling cap & below-panel space, site-parented panel routing, and 2.40m chase clamp', () => {
    const panel: SceneNodeLike = {
      id: 'p1',
      type: 'electrical:panel',
      parentId: 'l0',
      position: [1, 1.52, 0.1],
      rotation: 0,
      width: 0.4,
      depth: 0.14,
      height: 1.2, // topY = 2.12m > 1.981m (tall commercial panel)
    }
    const { workingPrism, dedicatedOverheadPrism } = getEquipmentSpacePrisms(panel, 'panel', 2.5)
    expect(workingPrism.yMin).toBe(0)
    expect(workingPrism.yMax).toBeCloseTo(2.12, 2)
    expect(dedicatedOverheadPrism.yMin).toBe(0)
    expect(dedicatedOverheadPrism.yMax).toBe(2.5) // Capped at structural ceiling, not 3.95m!

    // Attic duct at y=2.85m above 2.5m structural ceiling must NOT trigger NEC 110.26(E);
    // pipe directly below wall-mounted panel (y=0.4m) MUST trigger NEC 110.26(E)!
    const sceneAtticClear: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [6, 0], height: 2.5, thickness: 0.14 },
      p1: panel,
      attic_duct: { id: 'attic_duct', type: 'duct-segment', parentId: 'l0', diameter: 8, path: [[0, 2.85, 0.1], [3, 2.85, 0.1]] },
    }
    const rAttic = auditSceneElectrical(sceneAtticClear)
    expect(rAttic.findings.some((f) => f.codeRef === 'NEC 110.26(E)')).toBe(false)

    const sceneBelowPipe: Record<string, SceneNodeLike> = {
      ...sceneAtticClear,
      low_pipe: { id: 'low_pipe', type: 'pipe-segment', parentId: 'l0', diameter: 2, path: [[0, 0.4, 0.1], [3, 0.4, 0.1]] },
    }
    const rBelow = auditSceneElectrical(sceneBelowPipe)
    expect(rBelow.findings.some((f) => f.codeRef === 'NEC 110.26(E)' && f.nodeIds.includes('low_pipe'))).toBe(true)

    // ELC-A-BUG-08: electrical_route_circuit resolves device level even when panel is site-parented
    const sitePanelScene: Record<string, SceneNodeLike> = {
      site_0: { id: 'site_0', type: 'site' },
      l0: { id: 'l0', type: 'level', parentId: 'site_0', height: 2.4 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [6, 0], height: 2.4, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [6, 0], end: [6, 4], height: 2.4, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [6, 4], end: [0, 4], height: 2.4, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 4], end: [0, 0], height: 2.4, thickness: 0.14 },
      z1: { id: 'z1', type: 'zone', parentId: 'l0', name: 'Office', category: 'office', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
      p_site: { id: 'p_site', type: 'electrical:panel', parentId: 'site_0', position: [1, 1.52, 0.08], rotation: 0, height: 0.92 },
      dev1: { id: 'dev1', type: 'electrical:device', parentId: 'l0', panelId: 'p_site', circuitNumber: 1, deviceKind: 'duplex', position: [5, 0.38, 0.08] },
      col1: { id: 'col1', type: 'structural:column', parentId: 'l0', position: [3, 0, 0.08], width: 0.3, depth: 0.3, height: 2.4 },
    }
    const routed = electricalAgentOperations.electrical_route_circuit(
      sitePanelScene as never,
      { panelId: 'p_site', targetDeviceId: 'dev1' },
      { activeLevelId: 'l0' },
    )
    expect(routed.result.remainingClashes).toHaveLength(0)
    const runNode = routed.changes?.create?.[0]?.node as unknown as { parentId: string; path: [number, number, number][] }
    expect(runNode.parentId).toBe('l0')
    expect(Math.max(...runNode.path.map((p) => p[1]))).toBeLessThanOrEqual(2.4 - 0.04)

    // ELC-CON-01: autopopulate clamps default chase Y to <= levelHeight - 0.06 on 2.40m level
    const autoOut = electricalAgentOperations.electrical_autopopulate_nec(
      {
        l0: sitePanelScene.l0!,
        w1: sitePanelScene.w1!,
        w2: sitePanelScene.w2!,
        w3: sitePanelScene.w3!,
        w4: sitePanelScene.w4!,
        z1: sitePanelScene.z1!,
      } as never,
      { levelId: 'l0', includeWiring: true },
      { activeLevelId: 'l0' },
    )
    const createdRuns = (autoOut.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .filter((n) => n.type === 'electrical:conduit-run')
    expect(createdRuns.length).toBeGreaterThan(0)
    for (const r of createdRuns) {
      const pts = r.path as [number, number, number][]
      for (const pt of pts) {
        expect(pt[1]).toBeLessThanOrEqual(2.4 - 0.03)
      }
    }
  })

  test('ELC-R-BUG-01..03 & VIS-05: Pitched roof eave clamping, upper-floor-joists ceiling cap, non-attic inWallMaxY, Step 2a routingMode, and >3-clash HVAC detection', () => {
    // 1. Pitched gable roof (pitch 4:12 from structural:assembly) with eave-to-eave cross run over ridge HVAC trunk
    const pitchedScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', level: 0, height: 2.5 },
      roof_0: { id: 'roof_0', type: 'roof', parentId: 'l0' },
      asm_0: { id: 'asm_0', type: 'structural:assembly', parentId: 'l0', roofPitchRise: 4 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [10, 0], height: 2.5, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [10, 0], end: [10, 6], height: 2.5, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [10, 6], end: [0, 6], height: 2.5, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.14 },
      trunk: {
        id: 'trunk',
        type: 'hvac:duct-run',
        parentId: 'l0',
        shape: 'rectangular',
        width: 20,
        height: 10,
        path: [[0.5, 2.75, 3.0], [9.5, 2.75, 3.0]],
      },
    }
    const walls = extractRoutingWalls(pitchedScene, 'l0')
    const cavities = extractRoutingCavities(pitchedScene, 'l0')
    const obstacles = extractTradeObstacles(pitchedScene, 'l0')
    expect(cavities.roofPitchRise).toBe(4)

    const roofEnv = computeRoofEnvelopeFromWalls(walls, 2.5, 4)!
    const eaveToEave = routeElectricalRun([2.0, 0.38, 0.07], [8.0, 0.38, 5.93], obstacles, {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
      preferredChaseY: 2.44,
    })
    expect(eaveToEave.remainingClashes).toHaveLength(0)
    // Verify EVERY sampled point along EVERY segment stays strictly beneath roofYAt(x, z) - 0.06 (VIS-05)
    for (let i = 0; i < eaveToEave.path.length - 1; i++) {
      const a = eaveToEave.path[i]!
      const b = eaveToEave.path[i + 1]!
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const px = a[0] + (b[0] - a[0]) * f
        const py = a[1] + (b[1] - a[1]) * f
        const pz = a[2] + (b[2] - a[2]) * f
        if (py > 2.5 + 0.05) {
          expect(py + 0.015).toBeLessThanOrEqual(roofYAt(px, pz, roofEnv) - 0.06 + 0.002)
        }
      }
    }

    // 2. Multi-story upper-floor-joists: Level 0 cables MUST stay <= atticY + 0.16 (never shooting into Level 1 rooms!)
    const multiStory: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', level: 0, height: 2.5 },
      l1: { id: 'l1', type: 'level', level: 1, height: 2.5 },
      roof_top: { id: 'roof_top', type: 'roof', parentId: 'l1' },
      w0_1: { id: 'w0_1', type: 'wall', parentId: 'l0', start: [0, 0], end: [8, 0], height: 2.5, thickness: 0.14 },
      w0_2: { id: 'w0_2', type: 'wall', parentId: 'l0', start: [8, 0], end: [8, 6], height: 2.5, thickness: 0.14 },
      w0_3: { id: 'w0_3', type: 'wall', parentId: 'l0', start: [8, 6], end: [0, 6], height: 2.5, thickness: 0.14 },
      w0_4: { id: 'w0_4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.14 },
      w1_1: { id: 'w1_1', type: 'wall', parentId: 'l1', start: [0, 0], end: [8, 0], height: 2.5, thickness: 0.14 },
    }
    const l0Cavs = extractRoutingCavities(multiStory, 'l0')
    expect(l0Cavs.sources).toContain('upper-floor-joists')
    expect(l0Cavs.sources).not.toContain('roof')
    const l0Walls = extractRoutingWalls(multiStory, 'l0')
    const joistBlocker: TradeObstacle = {
      id: 'duct_joist',
      nodeId: 'duct_joist',
      nodeType: 'hvac:duct-run',
      trade: 'hvac',
      priorityRank: 3,
      box: { min: [0.5, 2.55, 2.8], max: [7.5, 2.95, 3.2] },
      requiredClearanceM: 0.05,
      label: 'Joist Trunk',
    }
    const l0Route = routeElectricalRun([2.0, 0.38, 0.07], [6.0, 0.38, 5.93], [joistBlocker], {
      walls: l0Walls,
      cavities: l0Cavs,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(Math.max(...l0Route.path.map((p) => p[1]))).toBeLessThanOrEqual(l0Cavs.atticY + 0.16 + 0.005)

    // 3. Wall-only bypass never exceeds inWallMaxY and updates routingMode when leaving walls (ELC-R-BUG-01/02)
    const bigCol: TradeObstacle = {
      id: 'col_1',
      nodeId: 'col_1',
      nodeType: 'structural:column',
      trade: 'structural',
      priorityRank: 1,
      box: { min: [3.6, 0, -0.2], max: [4.4, 2.5, 0.4] },
      requiredClearanceM: 0.05,
      label: 'Column',
    }
    const wallOnlyRoute = routeElectricalRun([1.0, 0.38, 0.07], [7.0, 0.38, 0.07], [bigCol], {
      walls: l0Walls,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
      preferredChaseY: 2.44,
    })
    expect(wallOnlyRoute.remainingClashes).toHaveLength(0)
    expect(Math.max(...wallOnlyRoute.path.map((p) => p[1]))).toBeLessThanOrEqual(2.5 - 0.04)

    // 4. ELC-R-BUG-02 & ELC-R-BUG-03: >=3 structural clashes before an HVAC plenum clash do NOT mask HVAC bypass,
    //    and Step 2a open-air bypass updates routingMode from 'wall-manhattan' to 'open-manhattan'
    const multiObs: TradeObstacle[] = [
      { id: 's1', nodeId: 's1', nodeType: 'structural:column', trade: 'structural', priorityRank: 1, box: { min: [2.0, 0, -0.3], max: [2.4, 2.5, 0.4] }, requiredClearanceM: 0.05, label: 'Col1' },
      { id: 's2', nodeId: 's2', nodeType: 'structural:column', trade: 'structural', priorityRank: 1, box: { min: [3.2, 0, -0.3], max: [3.6, 2.5, 0.4] }, requiredClearanceM: 0.05, label: 'Col2' },
      { id: 's3', nodeId: 's3', nodeType: 'structural:column', trade: 'structural', priorityRank: 1, box: { min: [4.4, 0, -0.3], max: [4.8, 2.5, 0.4] }, requiredClearanceM: 0.05, label: 'Col3' },
      // Wide mechanical plenum + adjacent partition columns occupying z in [-0.3, 1.45] across x=[1.6, 6.2] so
      // Step 2 single-obstacle detours stall and Step 2a `outerMechLateral` (+1.8m) routes cleanly at z=1.87m!
      { id: 'h1', nodeId: 'h1', nodeType: 'hvac:plenum', trade: 'hvac', priorityRank: 3, box: { min: [1.6, 0, -0.3], max: [6.2, 2.5, 0.9] }, requiredClearanceM: 0.08, label: 'Plenum' },
      { id: 'h2', nodeId: 'h2', nodeType: 'hvac:duct-run', trade: 'hvac', priorityRank: 3, box: { min: [1.6, 0, 0.95], max: [6.2, 2.5, 1.45] }, requiredClearanceM: 0.05, label: 'BranchTrunk' },
      // Block far perimeter walls so wall-manhattan cannot walk around z=6 cheaply
      { id: 'b_w', nodeId: 'b_w', nodeType: 'structural:column', trade: 'structural', priorityRank: 1, box: { min: [-0.4, 0, 2.5], max: [0.5, 2.5, 3.5] }, requiredClearanceM: 0.05, label: 'WestBlock' },
      { id: 'b_e', nodeId: 'b_e', nodeType: 'structural:column', trade: 'structural', priorityRank: 1, box: { min: [7.5, 0, 2.5], max: [8.4, 2.5, 3.5] }, requiredClearanceM: 0.05, label: 'EastBlock' },
    ]
    const multiRoute = routeElectricalRun([1.0, 1.22, 0.07], [7.0, 1.22, 0.07], multiObs, {
      walls: l0Walls,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
      preferredChaseY: 2.44,
    })
    expect(multiRoute.remainingClashes).toHaveLength(0)
    expect(multiRoute.routingMode).toBe('open-manhattan')
  })

  test('ELC-R-BUG-04..08 & ELC-CON-04..05: Cord-and-plug MEP mepHardwired: false, 2.40m bath ceiling light & exhaust fan, exterior WR GFCI on exterior wall, Wardrobe closet exclusion', () => {
    const lowCeilScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.38 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'l0', start: [0, 0], end: [8, 0], height: 2.38, thickness: 0.14 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'l0', start: [8, 0], end: [8, 5], height: 2.38, thickness: 0.14 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'l0', start: [8, 5], end: [0, 5], height: 2.38, thickness: 0.14 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'l0', start: [0, 5], end: [0, 0], height: 2.38, thickness: 0.14 },
      w_mid: { id: 'w_mid', type: 'wall', parentId: 'l0', start: [4, 0], end: [4, 5], height: 2.38, thickness: 0.12 },
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'l0', name: 'Bathroom', category: 'bathroom', polygon: [[0, 0], [4, 0], [4, 5], [0, 5]] },
      z_wardrobe: { id: 'z_wardrobe', type: 'zone', parentId: 'l0', name: 'Wardrobe', category: 'wardrobe', polygon: [[4, 0], [8, 0], [8, 2.5], [4, 2.5]] },
      z_kit: { id: 'z_kit', type: 'zone', parentId: 'l0', name: 'Kitchen', category: 'kitchen', polygon: [[4, 2.5], [8, 2.5], [8, 5], [4, 5]] },
      tub_1: { id: 'tub_1', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'bathtub', name: 'Bathtub', position: [1.5, 0, 2.5], width: 1.5, depth: 0.8, height: 0.6 },
      exhaust_1: { id: 'exhaust_1', type: 'hvac:equipment', parentId: 'l0', equipmentKind: 'bath-exhaust-fan', name: 'Bath Exhaust Fan', position: [3.2, 2.35, 1.0] },
      wh_gas: { id: 'wh_gas', type: 'plumbing:equipment', parentId: 'l0', equipmentKind: 'water-heater-tankless-gas', name: 'Tankless Gas WH', position: [7.2, 0.9, 3.8] },
      sink_kit: { id: 'sink_kit', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'kitchen-sink', name: 'Kitchen Sink', position: [6.0, 0, 4.7], width: 0.8, depth: 0.6, height: 0.9 },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      lowCeilScene as never,
      { levelId: 'l0', includeWiring: true },
      { activeLevelId: 'l0' },
    )
    const merged = applyChanges(lowCeilScene, out)
    const devices = Object.values(merged).filter((n) => n.type === 'electrical:device')

    // ELC-R-BUG-04: tankless gas water heater power drop marked mepHardwired: false
    const whDev = devices.find(
      (d) => (d.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'wh_gas',
    )
    expect(whDev).toBeDefined()
    expect((whDev?.metadata as { mepHardwired?: boolean } | undefined)?.mepHardwired).toBe(false)

    // ELC-R-BUG-05: bath-exhaust-fan Y clamped strictly <= 2.38 - 0.03 = 2.35m (never forced to 2.44m!)
    const exhaustDev = devices.find(
      (d) => (d.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'exhaust_1',
    )
    expect(exhaustDev).toBeDefined()
    expect((exhaustDev!.position as number[])[1]!).toBeLessThanOrEqual(2.35)

    // ELC-R-BUG-05: Bathroom ceiling light on 2.38m ceiling avoids NEC 410.10(D) tub zone
    const audit = auditSceneElectrical(merged)
    expect(audit.findings.some((f) => f.codeRef === 'NEC 410.10(D)')).toBe(false)

    // ELC-R-BUG-08: Fallback Front Exterior WR GFCI sits outside the [0..8] x [0..5] interior footprint
    const extGfci = devices.find((d) => d.name === 'Front Exterior WR GFCI')
    expect(extGfci).toBeDefined()
    const [ex, , ez] = extGfci!.position as [number, number, number]
    const isOutsideInterior = ex < 0 || ex > 8 || ez < 0 || ez > 5
    expect(isOutsideInterior).toBe(true)

    // ELC-CON-04: Wardrobe is NOT chosen for story-minimum Smoke/CO alarm
    const smokeDevs = devices.filter((d) => d.deviceKind === 'smoke-co')
    expect(smokeDevs.some((d) => String(d.name ?? '').includes('Wardrobe'))).toBe(false)

    // ELC-CON-05: findNextWallPlacement avoids Kitchen Sink basin & allows Bedroom/Wardrobe wall backing a tub
    const manualSpot = findNextWallPlacement(lowCeilScene, 'l0', {
      deviceKind: 'gfci',
      preferredZoneId: 'z_kit',
    })
    const distToSink = Math.hypot(manualSpot.position[0] - 6.0, manualSpot.position[2] - 4.7)
    expect(distToSink).toBeGreaterThan(0.25)

    // ELC-R-BUG-06: Compact bath GFCI fallback never picks tubDist === 0 inside shower stall over vanity wall
    const tinyBathScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [1.4, 0], height: 2.5, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [1.4, 0], end: [1.4, 1.4], height: 2.5, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [1.4, 1.4], end: [0, 1.4], height: 2.5, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 1.4], end: [0, 0], height: 2.5, thickness: 0.14 },
      z_b: { id: 'z_b', type: 'zone', parentId: 'l0', name: 'Tiny Bath', category: 'bathroom', polygon: [[0, 0], [1.4, 0], [1.4, 1.4], [0, 1.4]] },
      sh_1: { id: 'sh_1', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'shower', name: 'Shower', position: [0.45, 0, 0.7], width: 0.85, depth: 0.9, height: 2.1 },
      lav_1: { id: 'lav_1', type: 'plumbing:fixture', parentId: 'l0', fixtureKind: 'lavatory', name: 'Vanity Sink', position: [1.2, 0, 0.7], width: 0.45, depth: 0.45, height: 0.85 },
    }
    const tinyPlan = planNecAutoPopulate(tinyBathScene, { levelId: 'l0', includeWiring: false })
    const vanityGfci = tinyPlan.devices.find((d) => /Vanity GFCI/i.test(d.name))
    expect(vanityGfci).toBeDefined()
    // Must stay outside the shower stall footprint (x <= 0.875)
    expect(vanityGfci!.position[0]).toBeGreaterThan(0.9)

    // ELC-R-BUG-07: When interior zoned walls have conflicts, scanWallsForPanel(true) never mounts NEMA-1 panel outdoors
    const crowdedPanelScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [4, 0], height: 2.6, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [4, 0], end: [4, 3], height: 2.6, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [4, 3], end: [0, 3], height: 2.6, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 3], end: [0, 0], height: 2.6, thickness: 0.14 },
      z1: { id: 'z1', type: 'zone', parentId: 'l0', name: 'Office', category: 'office', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] },
      // Giant cabinet filling the interior so all zoned spots have working-space conflict
      cab_big: { id: 'cab_big', type: 'cabinet', parentId: 'l0', position: [2, 0, 1.5], width: 3.6, depth: 2.6, height: 2.0 },
    }
    const crowdedPlan = planNecAutoPopulate(crowdedPanelScene, { levelId: 'l0', includeWiring: false })
    expect(crowdedPlan.createdPanel).not.toBeNull()
    const [px, , pz] = crowdedPlan.createdPanel!.position
    expect(px).toBeGreaterThanOrEqual(0)
    expect(px).toBeLessThanOrEqual(4)
    expect(pz).toBeGreaterThanOrEqual(0)
    expect(pz).toBeLessThanOrEqual(3)

    // ELC-R-BUG-10: Shared-panel check spawns sub-panel when lower panel occupied + estLevelSpaces > 85% of spaces
    const sharedOverflowScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', level: 0, height: 2.6 },
      l1: { id: 'l1', type: 'level', level: 1, height: 2.6 },
      p_l0: { id: 'p_l0', type: 'electrical:panel', parentId: 'l0', name: 'MDP-1', position: [0.5, 1.52, 0.08], busRatingAmps: 200, mainBreakerAmps: 200, spaces: 20 },
      w1: { id: 'w1', type: 'wall', parentId: 'l1', start: [0, 0], end: [8, 0], height: 2.6, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l1', start: [8, 0], end: [8, 6], height: 2.6, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l1', start: [8, 6], end: [0, 6], height: 2.6, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l1', start: [0, 6], end: [0, 0], height: 2.6, thickness: 0.14 },
      z1: { id: 'z1', type: 'zone', parentId: 'l1', name: 'Bedroom 1', category: 'bedroom', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] },
      z2: { id: 'z2', type: 'zone', parentId: 'l1', name: 'Bedroom 2', category: 'bedroom', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] },
      z3: { id: 'z3', type: 'zone', parentId: 'l1', name: 'Bath 2', category: 'bathroom', polygon: [[0, 3], [4, 3], [4, 6], [0, 6]] },
      z4: { id: 'z4', type: 'zone', parentId: 'l1', name: 'Hall', category: 'hallway', polygon: [[4, 3], [8, 3], [8, 6], [4, 6]] },
    }
    // 14 occupied spaces on 20-space panel (< 18 fixed threshold, but 14 + estLevelSpaces(6) = 20 > floor(20*0.85)=17!)
    for (let c = 1; c <= 14; c++) {
      sharedOverflowScene[`l0_d_${c}`] = {
        id: `l0_d_${c}`,
        type: 'electrical:device',
        parentId: 'l0',
        panelId: 'p_l0',
        circuitNumber: c,
        poles: 1,
        loadVa: 180,
        deviceKind: 'duplex',
        position: [1, 0.38, 0.08],
      }
    }
    const subPlan = planNecAutoPopulate(sharedOverflowScene, { levelId: 'l1', includeWiring: false })
    expect(subPlan.createdPanel).not.toBeNull()
  })

  test('VIS-06 & ELC-OPT-02: Swimming pool exclusion, indoor conduit wall-envelope containment, tallest perimeter levelH, and >35 wall islands bridging', () => {
    // 1. Swimming pool zone gets ZERO indoor ceiling lights, general outlets, or pool-edge receptacles
    const poolScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.8 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.14 },
      z_living: { id: 'z_living', type: 'zone', parentId: 'l0', name: 'Living Room', category: 'living', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      z_pool: { id: 'z_pool', type: 'zone', parentId: 'l0', name: 'Swimming Pool', category: 'pool', polygon: [[10, 0], [16, 0], [16, 4], [10, 4]] },
      z_piscine: { id: 'z_piscine', type: 'zone', parentId: 'l0', name: 'Piscine', category: 'general', polygon: [[10, 5], [16, 5], [16, 8], [10, 8]] },
    }
    const poolPlan = planNecAutoPopulate(poolScene, { levelId: 'l0', includeWiring: true })
    const poolDevices = poolPlan.devices.filter(
      (d) =>
        /pool|piscine/i.test(d.name) ||
        (d.position[0] >= 9.5 && d.position[0] <= 16.5),
    )
    expect(poolDevices).toHaveLength(0)

    // 2. Indoor conduit detouring near perimeter wall stays strictly inside building wall envelope (<= 0.28m)
    const walls = extractRoutingWalls(poolScene, 'l0')
    const perimeterBlocker: TradeObstacle = {
      id: 'hvac_edge',
      nodeId: 'hvac_edge',
      nodeType: 'hvac:equipment',
      trade: 'hvac',
      priorityRank: 3,
      box: { min: [3.5, 0, -0.05], max: [4.5, 2.8, 0.6] },
      requiredClearanceM: 0.15,
      label: 'Perimeter Air Handler',
    }
    const indoorRun = routeElectricalRun([1.0, 0.38, 0.08], [7.0, 0.38, 0.08], [perimeterBlocker], {
      walls,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
    })
    expect(indoorRun.remainingClashes).toHaveLength(0)
    for (const pt of indoorRun.path) {
      expect(pt[0]).toBeGreaterThanOrEqual(-0.28)
      expect(pt[0]).toBeLessThanOrEqual(8.28)
      expect(pt[2]).toBeGreaterThanOrEqual(-0.28)
      expect(pt[2]).toBeLessThanOrEqual(6.28)
    }

    // 3. Tall commercial perimeter walls (5.0m) + short interior partition (2.1m) resolve levelH = 5.0m
    const gymScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level' },
      w_ext: { id: 'w_ext', type: 'wall', parentId: 'l0', start: [0, 0], end: [12, 0], height: 5.0, thickness: 0.2 },
      w_part: { id: 'w_part', type: 'wall', parentId: 'l0', start: [4, 2], end: [4, 6], height: 2.1, thickness: 0.12 },
    }
    expect(resolveLevelHeightM(gymScene, 'l0')).toBe(5.0)

    // 4. ELC-OPT-02: Kruskal MST wall-island bridging connects >35 disconnected wall islands without 32-island truncation
    const manyIslands: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 3.0 },
    }
    for (let i = 0; i < 38; i++) {
      const gx = (i % 8) * 3
      const gz = Math.floor(i / 8) * 3
      manyIslands[`w_${i}`] = {
        id: `w_${i}`,
        type: 'wall',
        parentId: 'l0',
        start: [gx, gz],
        end: [gx + 1.2, gz],
        height: 3.0,
        thickness: 0.14,
      }
    }
    const islandWalls = extractRoutingWalls(manyIslands, 'l0')
    const crossIslands = routeElectricalRun([0.5, 0.38, 0.08], [21.5, 0.38, 12.08], [], {
      walls: islandWalls,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
    })
    expect(crossIslands.routingMode).toBe('wall-manhattan')
    expect(crossIslands.path.length).toBeGreaterThan(4)
  })
})
