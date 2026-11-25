import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import { ELECTRICAL_CAD_CATALOG } from '../cad/catalog'
import { buildConduitRunCad } from '../cad/equipment'
import { auditSceneElectrical } from '../nec/audit'
import { planDeviceAutoConnection } from '../nec/autopopulate'
import { estimateSceneFloorAreaSqFt, type SceneNodeLike } from '../nec/load-calc'
import { buildElectricalTakeoff, buildPanelSchedule } from '../nec/panel-schedule'
import { BOX_UNIT_PRICES_USD } from '../nec/pricing'
import { extractRoutingWalls, routeElectricalRun } from '../nec/routing'
import { calculateConduitFill, calculateDeratedAmpacity, calculateVoltageDrop } from '../nec/sizing'
import { clampToBranchWireGauge, type WireGauge } from '../nec/tables'
import { electricalPanelParametrics } from '../nodes/parametrics'

describe('Round 6 Gemini 4 Carbon Audit Regression Suite (R6-BUG-01..06, R6-OPT-01..03, R6-CON-01..04)', () => {
  test('R6-BUG-01: Multi-level planDeviceAutoConnection prefers active-level panel and never bridges level-local coordinates across floors', () => {
    const multiLevel: Record<string, SceneNodeLike> = {
      level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
      level_2: { id: 'level_2', type: 'level', level: 1, height: 2.5 },
      p_l1: { id: 'p_l1', type: 'electrical:panel', parentId: 'level_1', name: 'MDP-L1', position: [0.1, 1.52, 2], occupancy: 'residential', voltageSystem: '120/240V-1P', spaces: 40 },
      p_l2: { id: 'p_l2', type: 'electrical:panel', parentId: 'level_2', name: 'SUB-L2', position: [0.1, 1.52, 2], occupancy: 'residential', voltageSystem: '120/240V-1P', spaces: 24 },
      smoke_l1: { id: 'smoke_l1', type: 'electrical:device', parentId: 'level_1', name: 'L1 Smoke', deviceKind: 'smoke-co', position: [3, 2.47, 2], panelId: 'p_l1', circuitNumber: 1, poles: 1, breakerAmps: 15, loadVa: 25, wireGauge: '14' },
    }

    // 1. Omitting panelId on Level 2 selects SUB-L2 (on Level 2), NOT MDP-L1 (on Level 1)!
    const connL2 = planDeviceAutoConnection(
      multiLevel,
      {
        id: 'smoke_l2',
        name: 'L2 Smoke',
        position: [3, 2.47, 2],
        deviceKind: 'smoke-co',
        occupancy: 'residential',
        poles: 1,
        breakerAmps: 15,
        loadVa: 25,
        continuous: false,
        gfciProtected: false,
        afciProtected: true,
        boxType: '4-oct-2.125',
        wireGauge: '14',
        conductorCount: 3,
      },
      { levelId: 'level_2' },
    )
    expect(connL2.panelId).toBe('p_l2')
    expect(connL2.mode).toBe('new-home-run')

    // 2. Even if Level 2 explicitly shares panel p_l1 with Level 1, L2 smoke MUST NOT daisy-chain from L1's level-local coordinates!
    const sharedPanelConn = planDeviceAutoConnection(
      multiLevel,
      {
        id: 'smoke_l2b',
        name: 'L2 Shared Panel Smoke',
        position: [3, 2.47, 2],
        deviceKind: 'smoke-co',
        occupancy: 'residential',
        panelId: 'p_l1',
        poles: 1,
        breakerAmps: 15,
        loadVa: 25,
        continuous: false,
        gfciProtected: false,
        afciProtected: true,
        boxType: '4-oct-2.125',
        wireGauge: '14',
        conductorCount: 3,
      },
      { levelId: 'level_2' },
    )
    expect(sharedPanelConn.mode).toBe('new-home-run')
    expect(sharedPanelConn.connectedFromNodeId).toBe('p_l1')
    expect(sharedPanelConn.anchorDevicePatch).toBeNull()
  })

  test('R6-BUG-02: Fixture wire gauges 18/16 clamp cleanly to #14 without crashing ampacity, conduit fill, voltage drop, or audit', () => {
    expect(clampToBranchWireGauge('18')).toBe('14')
    expect(clampToBranchWireGauge('16')).toBe('14')
    expect(clampToBranchWireGauge('12')).toBe('12')

    const amp = calculateDeratedAmpacity({ wireGauge: '18' as WireGauge, loadAmps: 10 })
    expect(amp.finalAllowableAmpacity).toBeGreaterThan(0)
    const fill = calculateConduitFill({
      conduitType: 'emt',
      tradeSize: '3/4"',
      conductors: [{ gauge: '16' as WireGauge, count: 3 }],
    })
    expect(fill.compliant).toBe(true)
    const vd = calculateVoltageDrop({
      wireGauge: '18' as WireGauge,
      loadAmps: 10,
      oneWayLengthFt: 40,
      voltage: 120,
      phases: 1,
    })
    expect(vd.voltageDropPct).toBeGreaterThan(0)

    const audit = auditSceneElectrical({
      l0: { id: 'l0', type: 'level' },
      r1: {
        id: 'r1',
        type: 'electrical:conduit-run',
        parentId: 'l0',
        racewayType: 'nm-b',
        wireGauge: '16',
        loadAmps: 10,
        path: [[0, 1, 0], [3, 1, 0]],
      },
    })
    expect(audit.conduitRunCount).toBe(1)
  })

  test('R6-BUG-03: smoke-co never auto-inherits wet-zone GFCI and electrical_place_device applies kind-aware defaults', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', parentId: null, height: 2.5 } as unknown as AnyNode,
      z_laundry: { id: 'z_laundry', type: 'zone', parentId: 'level_0', name: 'Laundry', category: 'laundry', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] } as unknown as AnyNode,
      p1: { id: 'p1', type: 'electrical:panel', parentId: 'level_0', name: 'MDP-1', position: [0.1, 1.52, 2], occupancy: 'residential', voltageSystem: '120/240V-1P', spaces: 40 } as unknown as AnyNode,
    }
    const res = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Laundry Smoke', position: [2, 2.47, 2], deviceKind: 'smoke-co', panelId: 'p1' },
      { activeLevelId: 'level_0' },
    )
    const createdDev = (res.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .find((n) => n.type === 'electrical:device')!
    expect(createdDev.breakerAmps).toBe(15)
    expect(createdDev.loadVa).toBe(25)
    expect(createdDev.gfciProtected).toBe(false)
    expect(createdDev.afciProtected).toBe(true)

    // No-panel fallback also preserves gfciProtected: false for smoke-co in wet zone
    const noPanelConn = planDeviceAutoConnection(
      { level_0: nodes.level_0 as unknown as SceneNodeLike, z_laundry: nodes.z_laundry as unknown as SceneNodeLike },
      {
        id: 's_np',
        name: 'NoPanel Smoke',
        position: [2, 2.47, 2],
        deviceKind: 'smoke-co',
        occupancy: 'residential',
        poles: 1,
        breakerAmps: 15,
        loadVa: 25,
        continuous: false,
        gfciProtected: false,
        afciProtected: true,
        boxType: '4-oct-2.125',
        wireGauge: '14',
        conductorCount: 3,
      },
      { levelId: 'level_0' },
    )
    expect(noPanelConn.gfciProtected).toBe(false)
  })

  test('R6-BUG-04: Cavity Euclidean detours never laterally kick vertical wall risers out of stud cavities', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], height: 2.5, thickness: 0.14 },
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], height: 2.5, thickness: 0.14 },
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], height: 2.5, thickness: 0.14 },
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], height: 2.5, thickness: 0.14 },
    }
    const walls = extractRoutingWalls(scene, 'level_0')
    // Obstacle sitting directly inside the west wall vertical stud riser at y=1.8m (above the outlet)
    const riserBlocker = {
      id: 'pipe_riser',
      nodeId: 'pipe_riser',
      nodeType: 'pipe-segment',
      trade: 'plumbing' as const,
      priorityRank: 2 as const,
      box: { min: [-0.08, 1.7, 0.9] as const, max: [0.08, 1.9, 1.1] as const },
      requiredClearanceM: 0.05,
      label: 'vertical stack blocking attic riser',
    }
    // With dry crawl space available too, the router drops cleanly downward (zero clash!) instead of kicking the upward stud riser into open room air!
    const route = routeElectricalRun([0.07, 0.38, 1.0], [5.93, 0.38, 3.0], [riserBlocker], {
      walls,
      cavities: { hasAttic: true, hasCrawlSpace: true, crawlSpaceWet: false, atticY: 2.62, crawlSpaceY: -0.18 },
      racewayType: 'nm-b',
    })
    expect(route.remainingClashes).toHaveLength(0)
    expect(route.routingMode).toBe('crawlspace-euclidean')
    // Both terminal wall risers stay dead-center on wall_w (x=0) and wall_e (x=6)
    expect(route.path[0]![0]).toBeCloseTo(0, 2)
    expect(route.path[1]![0]).toBeCloseTo(0, 2)
    expect(route.path[route.path.length - 1]![0]).toBeCloseTo(6, 2)
  })

  test('R6-BUG-05: buildPanelSchedule & BOM aggregate max poles/amps & smallest gauge, and audit flags mixed-pole circuits', () => {
    const panel: SceneNodeLike = {
      id: 'p1',
      type: 'electrical:panel',
      name: 'MDP-1',
      occupancy: 'residential',
      voltageSystem: '120/240V-1P',
      busRatingAmps: 200,
      mainBreakerAmps: 200,
      spaces: 40,
    }
    const devices: SceneNodeLike[] = [
      { id: 'd1', type: 'electrical:device', name: '15A Outlet', deviceKind: 'duplex', panelId: 'p1', circuitNumber: 1, poles: 1, breakerAmps: 15, wireGauge: '14', loadVa: 180 },
      { id: 'd2', type: 'electrical:device', name: '50A EVSE', deviceKind: 'evse', panelId: 'p1', circuitNumber: 1, poles: 2, breakerAmps: 50, wireGauge: '6', loadVa: 9600 },
    ]
    const sched = buildPanelSchedule(panel, devices)
    const slot1 = sched.rows[0]!.left!
    expect(slot1.poles).toBe(2)
    expect(slot1.breakerAmps).toBe(50)
    expect(slot1.wireGauge).toBe('14') // Smallest conductor on the shared circuit is NOT masked!

    const takeoff = buildElectricalTakeoff({ p1: panel, d1: devices[0]!, d2: devices[1]! })
    expect(takeoff.breakersBySpec['2P-50A']).toBe(1)

    const audit = auditSceneElectrical({ p1: panel, d1: devices[0]!, d2: devices[1]! })
    expect(audit.findings.some((f) => f.codeRef === 'NEC 210.4 / 210.23' && f.severity === 'error')).toBe(true)
  })

  test('R6-OPT-01/02 & R6-CON-01/02/04: WeakMap audit cache, lazy NM-B CAD, box volume labels, busbar label, and outdoor porch exclusion', () => {
    // R6-OPT-02: Repeated calls on identical immutable scene object return identical cached report reference
    const scene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level' },
      z_living: { id: 'z_living', type: 'zone', parentId: 'l0', name: 'Living', category: 'living', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
      z_porch: { id: 'z_porch', type: 'zone', parentId: 'l0', name: 'Front Porch', polygon: [[0, 4], [5, 4], [5, 6], [0, 6]] },
      z_balcony: { id: 'z_balcony', type: 'zone', parentId: 'l0', name: 'Upper Balcony', category: 'balcony', polygon: [[5, 0], [7, 0], [7, 4], [5, 4]] },
    }
    const r1 = auditSceneElectrical(scene)
    const r2 = auditSceneElectrical(scene)
    expect(r1).toBe(r2)

    // R6-CON-04: Front Porch & Balcony excluded from conditioned NEC 220 floor area (only 20 m² Living counted!)
    const sqft = estimateSceneFloorAreaSqFt(scene)
    expect(sqft).toBeCloseTo(20 * 10.76391, 0)

    // R6-OPT-01: NM-B conduit builds cleanly without needing a pre-created CadMaterialPool
    const nmbGroup = buildConduitRunCad({
      id: 'run_1',
      path: [[0, 0.38, 0], [2, 0.38, 0]],
      racewayType: 'nm-b',
      tradeSize: '3/4"',
      wireGauge: '12',
      voltage: 120,
      circuitNumber: 1,
    })
    expect(nmbGroup.children.length).toBeGreaterThan(0)

    // R6-CON-01 & R6-CON-02: Labels aligned across parametrics, pricing, and CAD catalog
    const coverField = electricalPanelParametrics.groups.flatMap((g) => g.fields).find((f) => f.key === 'coverRemoved')
    expect(coverField?.label).toBe('Expose Interior Busbars')
    expect(BOX_UNIT_PRICES_USD['two-gang-deep']!.label).toContain('42 cu in')
    expect(BOX_UNIT_PRICES_USD['three-gang-standard']!.label).toContain('48 cu in')
    expect(ELECTRICAL_CAD_CATALOG.find((c) => c.slug === 'box-3gang-pvc')!.name).toContain('48 cu in')
  })
})
