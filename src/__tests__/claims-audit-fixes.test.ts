import { describe, expect, test } from 'bun:test'
import type { AnyNode, GeometryContext } from '@pascal-app/core'
import { Box3 } from 'three'
import { electricalAgentOperations } from '../agent-operations'
import { buildDeviceCad, buildTransformerCad } from '../cad/equipment'
import {
  buildSmartDimmerCad,
  buildUsbDuplexReceptacleCad,
  buildWeatherproofInUseCoverCad,
} from '../cad/expansion'
import { buildWiredPanelInteriorCad } from '../cad/panel-interior'
import { auditSceneElectrical } from '../nec/audit'
import { planDeviceAutoConnection, planNecAutoPopulate } from '../nec/autopopulate'
import { calculateResidentialLoad, calculateSceneLoad, type SceneNodeLike } from '../nec/load-calc'
import { buildPanelSchedule } from '../nec/panel-schedule'
import { extractRoutingWalls, extractTradeObstacles, routeElectricalRun } from '../nec/routing'
import { calculateDeratedAmpacity } from '../nec/sizing'
import {
  buildElectricalDeviceFloorplan,
  ElectricalDeviceNode,
} from '../nodes/device'
import {
  ElectricalPanelNode,
  electricalPanelRenderDefinition,
} from '../nodes/panel'
import {
  electricalConduitRunParametrics,
  electricalDeviceParametrics,
  electricalPanelParametrics,
} from '../nodes/parametrics'
import {
  buildElectricalTransformerFloorplan,
  ElectricalTransformerNode,
  electricalTransformerRenderDefinition,
} from '../nodes/transformer'

const dummyCtx = {} as GeometryContext

describe('Full Claims-vs-Reality Audit Regression Suite (AUD-01..AUD-21)', () => {
  test('AUD-01: Water Heater & Heat Pump Water Heater are classified as fixed appliances (never omitted as non-coincident HVAC) and 120V MEP loads propagate into scene load', () => {
    const std = calculateResidentialLoad({
      squareFootage: 2000,
      method: 'standard',
      appliances: [
        { name: 'Electric Water Heater (4.5 kW)', watts: 4500 },
        { name: 'Heat Pump Water Heater (Hybrid)', watts: 4500 },
        { name: 'Central A/C', watts: 5000, isMotor: true },
      ],
    })
    expect(std.hvacOmitVa).toBe(0)
    expect(std.applianceTotalVa).toBe(4500 + 4500 + 5000)

    const opt = calculateResidentialLoad({
      squareFootage: 2000,
      method: 'optional',
      appliances: [
        { name: 'Electric Water Heater (4.5 kW)', watts: 4500 },
        { name: 'Central A/C', watts: 5000 },
      ],
    })
    // General (6000 + 3000 + 1500) + Water Heater (4500) = 15,000 -> 10,000 + 0.4 * 5,000 = 12,000 + 5,000 A/C = 17,000 VA
    expect(opt.hvacOmitVa).toBe(0)
    expect(opt.demandedGeneralVa).toBe(12000)
    expect(opt.totalDemandVa).toBe(17000)

    // Scene extraction propagates 120V MEP loads & isMotor from electrical_autopopulate_nec
    const scene: Record<string, unknown> = {
      level_0: { id: 'level_0', type: 'level' },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.6 },
      sump_1: {
        id: 'sump_1',
        type: 'plumbing:equipment',
        equipmentKind: 'sump-pump',
        name: 'Sump Pump',
        parentId: 'level_0',
        position: [1.5, 0, 0.5],
        electricalDemand: {
          required: true,
          voltage: 120,
          poles: 1,
          breakerAmps: 20,
          loadVa: 1200,
          continuous: false,
          dedicatedCircuit: true,
          gfciRequired: true,
          afciRequired: false,
          loadCategory: 'motor',
          label: 'Sump Pump',
        },
      },
    }
    const autoOut = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: false },
      { activeLevelId: 'level_0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...(scene as Record<string, SceneNodeLike>) }
    for (const c of autoOut.changes?.create ?? []) {
      merged[c.node.id] = c.node as unknown as SceneNodeLike
    }
    const sumpDev = Object.values(merged).find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'sump_1',
    )!
    expect(sumpDev.isMotor).toBe(true)
    const loadRes = calculateSceneLoad(merged, { occupancy: 'residential', fallbackSquareFootage: 1000 })
    expect(loadRes.occupancy).toBe('residential')
    if (loadRes.occupancy === 'residential') {
      expect(loadRes.applianceDetails.some((a) => /sump pump/i.test(a.name))).toBe(true)
      expect(loadRes.motorAdderVa).toBeGreaterThanOrEqual(300) // 25% of 1200 VA motor
    }
  })

  test('AUD-02: NEC Table 220.42 >120kVA @ 25%, NEC 220.53 75% (4+ fixed appliances), and NEC 220.82(C)(5) 40% (4+ separate space heaters)', () => {
    // Table 220.42 third tier: 50,000 sq ft -> 150,000 + 3,000 + 1,500 = 154,500 VA
    // Tier 1: 3,000 @ 100% = 3,000; Tier 2: 117,000 @ 35% = 40,950; Tier 3: 34,500 @ 25% = 8,625 -> 52,575 VA
    const huge = calculateResidentialLoad({ squareFootage: 50000, method: 'standard' })
    expect(huge.demandedGeneralVa).toBe(3000 + 40950 + 8625)

    // NEC 220.53: 4 fixed appliances @ 75%
    const fourFixed = calculateResidentialLoad({
      squareFootage: 2000,
      method: 'standard',
      appliances: [
        { name: 'Electric Water Heater', watts: 4500 },
        { name: 'Dishwasher', watts: 1500 },
        { name: 'Garbage Disposal', watts: 1000 },
        { name: 'Trash Compactor', watts: 1000 },
      ],
    })
    expect(fourFixed.applianceTotalVa).toBe(Math.round(4500 * 0.75) + Math.round(1500 * 0.75) + 750 + 750)
    expect(fourFixed.applianceDetails.every((a) => /220\.53/.test(a.note ?? ''))).toBe(true)

    // NEC 220.82(C)(5) 4+ separately controlled space heaters @ 40% vs central furnace @ 65%
    const opt4Baseboards = calculateResidentialLoad({
      squareFootage: 1500,
      method: 'optional',
      appliances: [
        { name: 'Baseboard Heater 1', watts: 2000 },
        { name: 'Baseboard Heater 2', watts: 2000 },
        { name: 'Baseboard Heater 3', watts: 2000 },
        { name: 'Baseboard Heater 4', watts: 2000 },
      ],
    })
    // 8,000 VA * 40% = 3,200 VA
    expect(opt4Baseboards.applianceDetails[0]!.demandedVa).toBe(800)
    expect(opt4Baseboards.totalDemandVa - opt4Baseboards.demandedGeneralVa).toBe(3200)

    const optCentral = calculateResidentialLoad({
      squareFootage: 1500,
      method: 'optional',
      appliances: [{ name: 'Central Electric Furnace', watts: 10000 }],
    })
    // 10,000 VA * 65% = 6,500 VA
    expect(optCentral.applianceDetails[0]!.demandedVa).toBe(6500)
  })

  test('AUD-03 & AUD-04: Multi-segment pipe detour resolves seg1 clash and clashing crawl space never overwrites 0-clash attic', () => {
    // AUD-03: 2-segment pipe where seg0 is at x=0 and seg1 crosses the electrical run at x=3
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      pipe_multi: {
        id: 'pipe_multi',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        nominalSize: '3"',
        path: [
          [0, 0.2, -1],
          [0, 2.4, -1], // seg0 at x=0, z=-1 (far from run)
          [3, 2.4, -1], // seg1
          [3, 2.4, 2], // seg2 crosses electrical run at x=3, y=2.4, z=0!
        ],
      },
    }
    const obstacles = extractTradeObstacles(scene, 'level_0')
    expect(obstacles.filter((o) => o.nodeId === 'pipe_multi').length).toBe(3)
    const routed = routeElectricalRun([0.5, 1.5, 0], [5.5, 0.4, 0], obstacles, {
      preferredChaseY: 2.4,
      racewayType: 'emt',
    })
    expect(routed.remainingClashes).toHaveLength(0)

    // AUD-04: Both Attic (0 clashes) and Crawl Space (1 clash) available vs Manhattan (clashing)
    const boxScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.5 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.5 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.5 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.5 },
    }
    const walls = extractRoutingWalls(boxScene, 'level_0')
    // Block Manhattan wall top-plate AND block crawl-space vertical riser drop, leaving Attic 100% clear
    const blockers = [
      {
        id: 'block_top_1',
        nodeId: 'block_top_1',
        nodeType: 'pipe-segment',
        trade: 'plumbing' as const,
        priorityRank: 2 as const,
        box: { min: [2.8, 2.2, -0.2] as const, max: [3.2, 2.52, 0.2] as const },
        requiredClearanceM: 0.05,
        label: 'north top plate pipe',
      },
      {
        id: 'block_top_2',
        nodeId: 'block_top_2',
        nodeType: 'pipe-segment',
        trade: 'plumbing' as const,
        priorityRank: 2 as const,
        box: { min: [2.8, 2.2, 3.8] as const, max: [3.2, 2.52, 4.2] as const },
        requiredClearanceM: 0.05,
        label: 'south top plate pipe',
      },
      {
        id: 'block_crawl_riser',
        nodeId: 'block_crawl_riser',
        nodeType: 'pipe-segment',
        trade: 'plumbing' as const,
        priorityRank: 2 as const,
        box: { min: [-0.08, -0.25, 0.9] as const, max: [0.08, 0.15, 1.1] as const },
        requiredClearanceM: 0.05,
        label: 'crawl riser pipe',
      },
    ]
    const bestRoute = routeElectricalRun([0.07, 0.38, 1.0], [5.93, 0.38, 3.0], blockers, {
      walls,
      cavities: { hasAttic: true, hasCrawlSpace: true, crawlSpaceWet: false, atticY: 2.65, crawlSpaceY: -0.18 },
      racewayType: 'nm-b',
    })
    expect(bestRoute.routingMode).toBe('attic-euclidean')
    expect(bestRoute.remainingClashes).toHaveLength(0)
  })

  test('AUD-05, AUD-12 & AUD-21: Zone name preserved with empty/generic category, namespaced 110.26(A) obstructions, wet zones, solar-inverter 120%, zero-ampacity cap, MC bend exemption, NEMA-4X', () => {
    // AUD-12 sizing: #14 Al (0A) and >80C (0A) must return maxBreakerAmps === 0 (never 15!)
    const al14 = calculateDeratedAmpacity({ wireGauge: '14', material: 'al', loadAmps: 10 })
    expect(al14.finalAllowableAmpacity).toBe(0)
    expect(al14.maxBreakerAmps).toBe(0)
    const tooHot = calculateDeratedAmpacity({ wireGauge: '8', material: 'cu', ambientTempC: 90, loadAmps: 10 })
    expect(tooHot.maxBreakerAmps).toBe(0)

    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      // Empty category "" + name "Master Bathroom" (AUD-05)
      z_bath: {
        id: 'z_bath',
        type: 'zone',
        parentId: 'level_0',
        category: '',
        name: 'Master Bathroom',
        polygon: [[0, 0], [3, 0], [3, 3], [0, 3]],
      },
      // Generic category "storage" + name "Walk-In Closet" (AUD-05)
      z_closet: {
        id: 'z_closet',
        type: 'zone',
        parentId: 'level_0',
        category: 'storage',
        name: 'Walk-In Closet',
        polygon: [[3, 0], [5, 0], [5, 3], [3, 3]],
      },
      // Back Deck (AUD-12 WET_ROOM_CATEGORIES)
      z_deck: {
        id: 'z_deck',
        type: 'zone',
        parentId: 'level_0',
        category: 'deck',
        name: 'Back Deck',
        polygon: [[5, 0], [8, 0], [8, 3], [5, 3]],
      },
      // Panel inside Master Bathroom -> NEC 240.24(E)
      p_bath: {
        id: 'p_bath',
        type: 'electrical:panel',
        parentId: 'level_0',
        name: 'MDP-Bath',
        position: [1.5, 1.52, 1.5],
        rotation: 0,
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        spaces: 40,
      },
      // Panel with hvac:equipment directly in front + 60A solar-inverter (inferred backfeed > 40A max!)
      p_main: {
        id: 'p_main',
        type: 'electrical:panel',
        parentId: 'level_0',
        name: 'MDP-Main',
        position: [10, 1.52, 1],
        rotation: 0,
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        solarBackfeedAmps: 0,
        spaces: 40,
      },
      hvac_front: {
        id: 'hvac_front',
        type: 'hvac:equipment',
        parentId: 'level_0',
        name: 'Air Handler',
        position: [10, 0, 1.4],
        width: 0.6,
        depth: 0.6,
        height: 1.5,
      },
      pv_over: {
        id: 'pv_over',
        type: 'electrical:device',
        parentId: 'level_0',
        name: '60A PV Inverter',
        deviceKind: 'solar-inverter',
        panelId: 'p_main',
        circuitNumber: 2,
        poles: 2,
        breakerAmps: 60,
        loadVa: 0,
        position: [11, 1.4, 1],
      },
      // Unprotected duplex on Back Deck -> NEC 210.8(A)
      deck_out: {
        id: 'deck_out',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Deck Outlet',
        deviceKind: 'duplex',
        panelId: 'p_main',
        circuitNumber: 1,
        poles: 1,
        breakerAmps: 20,
        gfciProtected: false,
        afciProtected: true,
        position: [6.5, 0.45, 1.5],
      },
      // Closet luminaire < 2.1m -> NEC 410.16(C)
      closet_light: {
        id: 'closet_light',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Closet Lamp',
        deviceKind: 'luminaire',
        panelId: 'p_main',
        circuitNumber: 3,
        poles: 1,
        breakerAmps: 15,
        afciProtected: true,
        position: [4, 1.8, 1.5],
      },
      // MC cable with >360 deg bends -> exempt from NEC 358.26 (AUD-21)
      mc_run: {
        id: 'mc_run',
        type: 'electrical:conduit-run',
        parentId: 'level_0',
        name: 'MC Whip',
        racewayType: 'mc',
        wireGauge: '12',
        loadAmps: 12,
        path: [
          [10, 1.5, 5],
          [11, 1.5, 5],
          [11, 1.5, 6],
          [10, 1.5, 6],
          [10, 1.5, 7],
          [11, 1.5, 7],
          [11, 1.5, 8],
        ],
      },
      // Outdoor NEMA-4X transformer -> compliant (AUD-21)
      tx_4x: {
        id: 'tx_4x',
        type: 'electrical:transformer',
        parentId: 'level_0',
        name: 'Outdoor TX',
        nemaRating: 'NEMA-4X',
        position: [6.5, 0, 1.5],
      },
    }

    const report = auditSceneElectrical(scene)
    expect(report.findings.some((f) => f.codeRef === 'NEC 240.24(E)' && f.nodeIds.includes('p_bath'))).toBe(true)
    expect(report.findings.some((f) => f.codeRef === 'NEC 410.16(C)' && f.nodeIds.includes('closet_light'))).toBe(true)
    expect(report.findings.some((f) => f.category === 'gfci-afci' && f.nodeIds.includes('deck_out'))).toBe(true)
    expect(report.findings.some((f) => f.category === 'working-space' && f.nodeIds.includes('hvac_front'))).toBe(true)
    expect(report.findings.some((f) => f.category === 'solar-busbar' && f.nodeIds.includes('p_main'))).toBe(true)
    expect(report.findings.some((f) => f.category === 'raceway-bends' && f.nodeIds.includes('mc_run'))).toBe(false)
    expect(report.findings.some((f) => f.codeRef === 'NEC 450.22' && f.nodeIds.includes('tx_4x'))).toBe(false)
  })

  test('AUD-06, AUD-08, AUD-09, AUD-13: Hybrid GFCI uses 1 GFCI head + LOAD duplexes, duplicate dedicated MEP appliances split circuits, import-only skips MEP, exterior uses weatherproof-gfci', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.6 },
      z_kit: {
        id: 'z_kit',
        type: 'zone',
        parentId: 'level_0',
        name: 'Kitchen',
        category: 'kitchen',
        polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      },
      // Two identical dedicated electric water heaters (AUD-08)
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Water Heater 1',
        parentId: 'level_0',
        position: [1.0, 0, 0.5],
      },
      wh_2: {
        id: 'wh_2',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Water Heater 2',
        parentId: 'level_0',
        position: [2.0, 0, 0.5],
      },
    }

    const plan = planNecAutoPopulate(scene, {
      levelId: 'level_0',
      occupancy: 'residential',
      protectionMode: 'hybrid',
      includeWiring: true,
    })

    // AUD-06: Kitchen SAB circuits in hybrid mode have 1 physical 'gfci' head and downstream 'duplex' LOAD outlets
    const sab1 = plan.devices.filter((d) => d.circuitGroup === 'Kitchen SAB-1 (20A)')
    if (sab1.length >= 2) {
      expect(sab1.filter((d) => d.deviceKind === 'gfci').length).toBe(1)
      expect(sab1.filter((d) => d.deviceKind === 'duplex').length).toBe(sab1.length - 1)
      expect(sab1.every((d) => d.gfciProtected === true)).toBe(true)
    }

    // AUD-08: Both identical water heaters get DISTINCT dedicated circuits
    const whDevs = plan.devices.filter((d) => d.mepSourceNodeId === 'wh_1' || d.mepSourceNodeId === 'wh_2')
    expect(whDevs.length).toBe(2)
    expect(whDevs[0]!.circuitNumber).not.toBe(whDevs[1]!.circuitNumber)

    // AUD-13: Exterior auto-populated WR GFCI uses 'weatherproof-gfci'
    const exteriorGfcis = plan.devices.filter((d) => d.isExterior === true && d.gfciProtected === true)
    expect(exteriorGfcis.length).toBeGreaterThanOrEqual(1)
    expect(exteriorGfcis.every((d) => d.deviceKind === 'weatherproof-gfci')).toBe(true)

    // AUD-09: bonesMode: 'import-only' does NOT create extra MEP devices when no Bones nodes exist
    const importOnly = planNecAutoPopulate(scene, {
      levelId: 'level_0',
      occupancy: 'residential',
      bonesMode: 'import-only',
    })
    expect(importOnly.devices.filter((d) => Boolean(d.mepSourceNodeId))).toHaveLength(0)
  })

  test('AUD-10 & AUD-11: planDeviceAutoConnection avoids multi-pole slot collisions & 15A/20A mismatch; wall chase avoids intervening windows', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.6 },
      win_1: {
        id: 'win_1',
        type: 'window',
        parentId: 'w_n',
        position: [3.0, 0.9],
        width: 1.4,
        height: 1.2,
      },
      p1: {
        id: 'p1',
        type: 'electrical:panel',
        parentId: 'level_0',
        name: 'MDP-1',
        position: [0.5, 1.52, 0.08],
        voltageSystem: '120/240V-1P',
        spaces: 40,
      },
      // 2-pole breaker at slot 1 occupies slots 1 AND 3!
      evse_1: {
        id: 'evse_1',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'EVSE',
        deviceKind: 'evse',
        panelId: 'p1',
        circuitNumber: 1,
        poles: 2,
        breakerAmps: 50,
        loadVa: 9600,
        position: [5.5, 1.1, 0.08],
      },
      // Existing 15A living outlet at slot 5
      out_15a: {
        id: 'out_15a',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Living 15A',
        deviceKind: 'duplex',
        panelId: 'p1',
        circuitNumber: 5,
        poles: 1,
        breakerAmps: 15,
        loadVa: 180,
        wireGauge: '14',
        position: [1.2, 0.38, 0.08],
      },
    }

    // AUD-10a: Requesting explicit circuitNumber=3 MUST NOT collide with 2-pole continuation slot 3
    const slotCollisionCheck = planDeviceAutoConnection(
      scene,
      {
        id: 'd_new',
        name: 'Dedicated 20A',
        position: [4.5, 1.12, 0.08],
        deviceKind: 'dedicated-240v',
        occupancy: 'residential',
        panelId: 'p1',
        circuitNumber: 3,
        poles: 1,
        breakerAmps: 20,
        loadVa: 1800,
        continuous: false,
        gfciProtected: false,
        afciProtected: false,
        boxType: 'single-gang-standard',
        wireGauge: '12',
        conductorCount: 2,
      },
      { levelId: 'level_0' },
    )
    expect(slotCollisionCheck.circuitNumber).not.toBe(1)
    expect(slotCollisionCheck.circuitNumber).not.toBe(3)
    expect(slotCollisionCheck.run?.routingMode).toBeDefined()

    // AUD-10b: 20A draft MUST NOT join existing 15A circuit 5
    const ampCheck = planDeviceAutoConnection(
      scene,
      {
        id: 'd_20a',
        name: 'Living 20A',
        position: [2.0, 0.38, 0.08],
        deviceKind: 'duplex',
        occupancy: 'residential',
        panelId: 'p1',
        poles: 1,
        breakerAmps: 20,
        loadVa: 180,
        continuous: false,
        gfciProtected: false,
        afciProtected: true,
        boxType: 'single-gang-standard',
        wireGauge: '12',
        conductorCount: 2,
      },
      { levelId: 'level_0' },
    )
    expect(ampCheck.circuitNumber).not.toBe(5)

    // AUD-11: Same-wall routing at y=1.12m between x=1.5m and x=4.5m MUST NOT run horizontally through window [2.3..3.7, y=0.9..2.1]
    const walls = extractRoutingWalls(scene, 'level_0')
    expect(walls[0]!.windowSpans?.length).toBe(1)
    const winRoute = routeElectricalRun([1.5, 1.12, 0.08], [4.5, 1.12, 0.08], [], {
      walls,
      preferredChaseY: 2.5,
      racewayType: 'nm-b',
    })
    const cutsWindowGlass = winRoute.path.some((p, idx) => {
      const next = winRoute.path[idx + 1]
      if (!next) return false
      const midX = (p[0] + next[0]) / 2
      const midY = (p[1] + next[1]) / 2
      return midX > 2.35 && midX < 3.65 && midY > 0.95 && midY < 2.05
    })
    expect(cutsWindowGlass).toBe(false)
  })

  test('AUD-07, AUD-14, AUD-15 & AUD-16: Zero CAD air gaps, ground bar screws in bounds, rotated 2D floorplans, panel/transformer keys & parametrics', () => {
    // AUD-07: Zero air gaps on expansion device CAD builders
    for (const group of [
      buildSmartDimmerCad(),
      buildUsbDuplexReceptacleCad(),
      buildWeatherproofInUseCoverCad(),
    ]) {
      group.updateMatrixWorld(true)
      const boxPart = group.children[0]!
      const frontPart = group.children[1]!
      const boxBounds = new Box3().setFromObject(boxPart)
      const frontBounds = new Box3().setFromObject(frontPart)
      const airGapMm = (frontBounds.min.z - boxBounds.max.z) * 1000
      expect(airGapMm).toBeLessThanOrEqual(1.0)
    }

    // AUD-07: boxType forwarded for dimmer & usb-duplex
    const dimStd = buildDeviceCad({ deviceKind: 'dimmer', boxType: 'single-gang-standard' })
    const dimDeep = buildDeviceCad({ deviceKind: 'dimmer', boxType: 'single-gang-deep' })
    expect(new Box3().setFromObject(dimDeep).getSize(new Box3().min).z).toBeGreaterThan(
      new Box3().setFromObject(dimStd).getSize(new Box3().min).z + 0.01,
    )

    // AUD-14 & AUD-21: 84-space panel renders >21 rows and has no em-dash feeder description
    const panel84 = ElectricalPanelNode.parse({
      id: 'elecpanel_84',
      type: 'electrical:panel',
      spaces: 84,
      voltageSystem: '120/208V-3P',
      occupancy: 'commercial',
    })
    const sched84 = buildPanelSchedule(panel84, [
      {
        id: 'd84',
        type: 'electrical:device',
        name: 'Circuit 75',
        panelId: 'elecpanel_84',
        circuitNumber: 75,
        poles: 1,
        breakerAmps: 20,
        loadVa: 1200,
      },
    ])
    const interior84 = buildWiredPanelInteriorCad({ schedule: sched84, viewMode: 'cover-off' })
    let foundCkt75 = false
    let foundEmDashFeeder = false
    interior84.traverse((obj) => {
      const meta = obj.userData as { kind?: string; circuitNumber?: number; description?: string } | undefined
      if (meta?.circuitNumber === 75) foundCkt75 = true
      if (meta?.kind === 'feeder' && meta.description?.includes('—')) foundEmDashFeeder = true
    })
    expect(foundCkt75).toBe(true)
    expect(foundEmDashFeeder).toBe(false)

    // AUD-15: 2D floorplan rotation, smoke-co dark stroke, dedicated evse/exit-sign/motor-load
    const ess0 = ElectricalDeviceNode.parse({ id: 'elecdev_ess0', type: 'electrical:device', deviceKind: 'battery-ess', rotation: 0 })
    const ess90 = ElectricalDeviceNode.parse({ id: 'elecdev_ess90', type: 'electrical:device', deviceKind: 'battery-ess', rotation: Math.PI / 2 })
    expect(JSON.stringify(buildElectricalDeviceFloorplan(ess0, dummyCtx))).not.toBe(
      JSON.stringify(buildElectricalDeviceFloorplan(ess90, dummyCtx)),
    )
    const smokeFp = JSON.stringify(
      buildElectricalDeviceFloorplan(
        ElectricalDeviceNode.parse({ id: 'elecdev_smk', type: 'electrical:device', deviceKind: 'smoke-co' }),
        dummyCtx,
      ),
    )
    expect(smokeFp).toContain('#0f172a')

    // AUD-16: panel geometryKey tracks mainType & occupancy; transformer tracks nemaRating & draws 2D clearance; parametrics step & fields
    const pMlo = ElectricalPanelNode.parse({ id: 'elecpanel_mlo', type: 'electrical:panel', mainType: 'mlo' })
    const pMain = ElectricalPanelNode.parse({ id: 'elecpanel_mb', type: 'electrical:panel', mainType: 'main-breaker' })
    expect(electricalPanelRenderDefinition.geometryKey!(pMlo)).not.toBe(
      electricalPanelRenderDefinition.geometryKey!(pMain),
    )

    const tx2 = ElectricalTransformerNode.parse({ id: 'electx_2', type: 'electrical:transformer', nemaRating: 'NEMA-2', showClearanceZone: true })
    const tx3r = ElectricalTransformerNode.parse({ id: 'electx_3r', type: 'electrical:transformer', nemaRating: 'NEMA-3R', showClearanceZone: true })
    expect(electricalTransformerRenderDefinition.geometryKey!(tx2)).not.toBe(
      electricalTransformerRenderDefinition.geometryKey!(tx3r),
    )
    expect(buildTransformerCad({ nemaRating: 'NEMA-3R' }).children.length).toBeGreaterThan(
      buildTransformerCad({ nemaRating: 'NEMA-2' }).children.length,
    )
    expect(JSON.stringify(buildElectricalTransformerFloorplan(tx2, dummyCtx))).toContain('strokeDasharray')

    const panelFields = electricalPanelParametrics.groups.flatMap((g) => g.fields)
    const busField = panelFields.find((f) => f.key === 'busRatingAmps') as { min?: number; step?: number }
    for (const standard of [60, 100, 125, 150, 200, 225, 400]) {
      expect((standard - (busField.min ?? 0)) % (busField.step ?? 1)).toBe(0)
    }
    expect(panelFields.some((f) => f.key === 'condition110_26')).toBe(true)
    const devFields = electricalDeviceParametrics.groups.flatMap((g) => g.fields)
    expect(devFields.some((f) => f.key === 'poles')).toBe(true)
    expect(devFields.some((f) => f.key === 'isMotor')).toBe(true)
    const runFields = electricalConduitRunParametrics.groups.flatMap((g) => g.fields)
    expect(runFields.some((f) => f.key === 'insulationRating')).toBe(true)
    expect(runFields.some((f) => f.key === 'phases')).toBe(true)
  })
})
