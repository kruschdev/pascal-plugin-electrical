import { describe, expect, test } from 'bun:test'
import type { AnyNode, GeometryContext } from '@pascal-app/core'
import { Box3 } from 'three'
import { electricalAgentOperations } from '../agent-operations'
import { electricalAgentTools } from '../agent-tools'
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
import {
  detectRunTradeClashes,
  extractRoutingWalls,
  extractTradeObstacles,
  routeElectricalRun,
} from '../nec/routing'
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

  test('Pass-2 Referee Regressions: WindowNode centerY, HPWH non-HVAC load, commercial motor dedupe, exterior/master-bath audit parity, panel min 60A, mainHandle userData', () => {
    // 1. Real Pascal WindowNode position[1] is vertical center (1.6m with height 1.2m => sillY=1.0m, headY=2.2m)
    const winScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.6 },
      win_real: { id: 'win_real', type: 'window', parentId: 'w1', position: [3.0, 1.6, 0], width: 1.5, height: 1.2 },
    }
    const winWalls = extractRoutingWalls(winScene, 'level_0')
    expect(winWalls[0]!.windowSpans?.[0]?.sillY).toBeCloseTo(1.0, 2)
    expect(winWalls[0]!.windowSpans?.[0]?.headY).toBeCloseTo(2.2, 2)
    const counterRoute = routeElectricalRun([1.5, 1.15, 0.08], [4.5, 1.15, 0.08], [], {
      walls: winWalls,
      preferredChaseY: 2.5,
      racewayType: 'nm-b',
    })
    const crossesRealGlass = counterRoute.path.some((p, idx) => {
      const next = counterRoute.path[idx + 1]
      if (!next) return false
      const midX = (p[0] + next[0]) / 2
      const midY = (p[1] + next[1]) / 2
      return midX > 2.3 && midX < 3.7 && midY > 1.05 && midY < 2.15
    })
    expect(crossesRealGlass).toBe(false)

    // 2. Auto-populated HPWH + Electric Furnace: HPWH is NEVER omitted as non-coincident HVAC
    const hpwhScene: Record<string, unknown> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.6 },
      hpwh_1: {
        id: 'hpwh_1',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-hpwh',
        name: 'Heat-Pump Water Heater',
        parentId: 'level_0',
        position: [1.5, 0, 0.5],
      },
      furnace_1: {
        id: 'furnace_1',
        type: 'electrical:device',
        deviceKind: 'dedicated-240v',
        name: 'Electric Furnace',
        parentId: 'level_0',
        poles: 2,
        breakerAmps: 60,
        loadVa: 10000,
        position: [4.5, 1.0, 0.5],
      },
    }
    const hpwhAuto = electricalAgentOperations.electrical_autopopulate_nec(
      hpwhScene as never,
      { levelId: 'level_0', includeWiring: false },
      { activeLevelId: 'level_0' },
    )
    const mergedHpwh: Record<string, SceneNodeLike> = { ...(hpwhScene as Record<string, SceneNodeLike>) }
    for (const c of hpwhAuto.changes?.create ?? []) mergedHpwh[c.node.id] = c.node as unknown as SceneNodeLike
    const hpwhLoad = calculateSceneLoad(mergedHpwh, { occupancy: 'residential', residentialMethod: 'standard', fallbackSquareFootage: 1500 })
    expect(hpwhLoad.occupancy).toBe('residential')
    if (hpwhLoad.occupancy === 'residential') {
      expect(hpwhLoad.hvacOmitVa).toBe(0)
    }

    // 3. Commercial calculateSceneLoad does NOT double-count isMotor=true dedicated-240v / gfci pumps
    const commMotorScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      p1: { id: 'p1', type: 'electrical:panel', occupancy: 'commercial', voltageSystem: '120/208V-3P' },
      pump_240: {
        id: 'pump_240',
        type: 'electrical:device',
        deviceKind: 'dedicated-240v',
        name: 'Well Booster Pump',
        isMotor: true,
        loadVa: 1800,
      },
      sump_120: {
        id: 'sump_120',
        type: 'electrical:device',
        deviceKind: 'gfci',
        name: 'Sump Pump',
        isMotor: true,
        loadVa: 1200,
      },
    }
    const commLoad = calculateSceneLoad(commMotorScene, { occupancy: 'commercial', fallbackSquareFootage: 1000 })
    expect(commLoad.occupancy).toBe('commercial')
    if (commLoad.occupancy === 'commercial') {
      expect(commLoad.motorTotalVa).toBe(3000)
      expect(commLoad.dedicatedTotalVa).toBe(0)
      expect(commLoad.receptacleRawVa).toBe(0)
    }

    // 4. Exterior zone + Master Bath + Master Closet auto-populate -> 0 NEC 210.8 errors and 0 false IRC R314.3 warnings
    const parityScene: Record<string, unknown> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.14, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.14, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.14, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.14, height: 2.6 },
      wm: { id: 'wm', type: 'wall', parentId: 'level_0', start: [4, 0], end: [4, 6], thickness: 0.12, height: 2.6 },
      wh: { id: 'wh', type: 'wall', parentId: 'level_0', start: [4, 3], end: [8, 3], thickness: 0.12, height: 2.6 },
      z_bed: { id: 'z_bed', type: 'zone', parentId: 'level_0', name: 'Master Bedroom', category: 'bedroom', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] },
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'level_0', name: 'Master Bath', category: 'bathroom', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] },
      z_closet: { id: 'z_closet', type: 'zone', parentId: 'level_0', name: 'Master Closet', category: 'closet', polygon: [[4, 3], [8, 3], [8, 6], [4, 6]] },
      z_ext: { id: 'z_ext', type: 'zone', parentId: 'level_0', name: 'Exterior Side', category: 'exterior', polygon: [[0, 3], [4, 3], [4, 6], [0, 6]] },
    }
    const parityAuto = electricalAgentOperations.electrical_autopopulate_nec(
      parityScene as never,
      { levelId: 'level_0', occupancy: 'residential', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const mergedParity: Record<string, SceneNodeLike> = { ...(parityScene as Record<string, SceneNodeLike>) }
    for (const c of parityAuto.changes?.create ?? []) mergedParity[c.node.id] = c.node as unknown as SceneNodeLike
    const parityAudit = auditSceneElectrical(mergedParity)
    expect(parityAudit.findings.filter((f) => f.category === 'gfci-afci')).toHaveLength(0)
    expect(
      parityAudit.findings.filter(
        (f) => f.category === 'life-safety' && /Master Bath|Master Closet/.test(f.title),
      ),
    ).toHaveLength(0)

    // 5. Panel parametrics min (60A) matches ElectricalPanelNode Zod schema
    const busField = electricalPanelParametrics.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === 'busRatingAmps') as { min?: number; step?: number }
    expect(busField.min).toBe(60)
    expect(
      ElectricalPanelNode.safeParse({
        id: 'elecpanel_min',
        type: 'electrical:panel',
        busRatingAmps: busField.min,
        mainBreakerAmps: busField.min,
      }).success,
    ).toBe(true)

    // 6. Main breaker handle in Panel Cover On carries main breaker userData for opaque-first raycasting
    const panelCover = buildWiredPanelInteriorCad({
      schedule: buildPanelSchedule(
        ElectricalPanelNode.parse({ id: 'elecpanel_main', type: 'electrical:panel', mainType: 'main-breaker' }),
        [],
      ),
      viewMode: 'panel-cover-on',
    })
    let handleFound = false
    panelCover.traverse((obj) => {
      const m = obj as { geometry?: { type?: string }; userData?: { kind?: string; description?: string }; position?: { z: number } }
      if (m.userData?.kind === 'breaker' && /Main Circuit Breaker/.test(m.userData.description ?? '') && (m.position?.z ?? 0) > -0.02) {
        handleFound = true
      }
    })
    expect(handleFound).toBe(true)
  })

  test('XT-03: Kitchen MEP aux loads (range-hood) isolate onto Kitchen MEP Aux separate from general MEP Aux (0 NEC 210.11(C)(1) errors)', () => {
    const scene: Record<string, unknown> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 6], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 6], end: [0, 6], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 2.7 },
      wm: { id: 'wm', type: 'wall', parentId: 'level_0', start: [5, 0], end: [5, 6], thickness: 0.12, height: 2.7 },
      z_kit: { id: 'z_kit', type: 'zone', parentId: 'level_0', name: 'Kitchen', category: 'kitchen', polygon: [[0, 0], [5, 0], [5, 6], [0, 6]] },
      z_liv: { id: 'z_liv', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[5, 0], [10, 0], [10, 6], [5, 6]] },
      hood_1: {
        id: 'hood_1',
        type: 'hvac:equipment',
        equipmentKind: 'range-hood',
        name: 'Range Hood',
        parentId: 'level_0',
        position: [2.5, 1.8, 0.5],
        electricalDemand: {
          required: true,
          voltage: 120,
          poles: 1,
          breakerAmps: 15,
          loadVa: 300,
          dedicatedCircuit: false,
          gfciRequired: false,
          afciRequired: true,
          loadCategory: 'appliance',
          label: 'Kitchen Range Exhaust Hood',
        },
      },
      erv_1: {
        id: 'erv_1',
        type: 'hvac:equipment',
        equipmentKind: 'erv-ventilator',
        name: 'ERV Ventilator',
        parentId: 'level_0',
        position: [7.5, 2.0, 1.0],
        electricalDemand: {
          required: true,
          voltage: 120,
          poles: 1,
          breakerAmps: 15,
          loadVa: 180,
          dedicatedCircuit: false,
          gfciRequired: false,
          loadCategory: 'motor',
          label: 'ERV Ventilator',
        },
      },
    }
    const out = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...(scene as Record<string, SceneNodeLike>) }
    for (const c of out.changes?.create ?? []) merged[c.node.id] = c.node as unknown as SceneNodeLike
    const hoodDev = Object.values(merged).find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'hood_1',
    )!
    const ervDev = Object.values(merged).find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'erv_1',
    )!
    expect(hoodDev).toBeDefined()
    expect(ervDev).toBeDefined()
    expect((hoodDev.metadata as { circuitGroup?: string }).circuitGroup).toBe('Kitchen MEP Aux (120V 15A)')
    expect(hoodDev.circuitNumber).not.toBe(ervDev.circuitNumber)
    const audit = auditSceneElectrical(merged)
    expect(audit.findings.filter((f) => f.codeRef === 'NEC 210.11(C)(1)')).toHaveLength(0)
  })

  test('XT-05(a): electrical_autopopulate_nec supports clearExisting to rebuild cleanly around newly added plumbing/HVAC obstacles without touching other levels', () => {
    const autoTool = electricalAgentTools.tools.find((t) => t.name === 'electrical_autopopulate_nec')!
    expect('clearExisting' in autoTool.input).toBe(true)

    let scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      level_1: { id: 'level_1', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 2.7 },
      z_liv: { id: 'z_liv', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      l1_dev: { id: 'l1_dev', type: 'electrical:device', parentId: 'level_1', name: 'Upstairs Outlet', deviceKind: 'duplex', position: [2, 0.38, 0.1] },
    }
    const first = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const firstIds = (first.changes?.create ?? []).map((c) => c.node.id)
    for (const c of first.changes?.create ?? []) scene[c.node.id] = c.node as unknown as SceneNodeLike

    // Insert plumbing pipe & HVAC duct directly through the existing first-pass conduit chase!
    const sampleRun = Object.values(scene).find((n) => n.type === 'electrical:conduit-run' && Array.isArray(n.path) && n.path.length >= 2)!
    const midPt = (sampleRun.path as [number, number, number][])[1]!
    scene.late_pipe = {
      id: 'late_pipe',
      type: 'plumbing:pipe-run',
      parentId: 'level_0',
      nominalSize: '3"',
      path: [
        [midPt[0] - 0.5, midPt[1], midPt[2] - 0.5],
        [midPt[0] + 0.5, midPt[1], midPt[2] + 0.5],
      ],
    }
    scene.late_duct = {
      id: 'late_duct',
      type: 'hvac:duct-run',
      parentId: 'level_0',
      shape: 'round',
      diameter: 8,
      path: [
        [0.5, 2.45, 3.0],
        [7.5, 2.45, 3.0],
      ],
    }
    const staleAudit = auditSceneElectrical(scene)
    expect(staleAudit.findings.filter((f) => f.category === 'trade-clash').length).toBeGreaterThan(0)

    // Re-run with clearExisting: true
    const rebuilt = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: true, clearExisting: true },
      { activeLevelId: 'level_0' },
    )
    expect(rebuilt.changes?.delete?.length).toBe(firstIds.length)
    for (const oldId of firstIds) {
      expect(rebuilt.changes?.delete).toContain(oldId)
    }
    expect(rebuilt.changes?.delete).not.toContain('l1_dev')

    const nextScene: Record<string, SceneNodeLike> = { ...scene }
    for (const id of rebuilt.changes?.delete ?? []) delete nextScene[id]
    for (const c of rebuilt.changes?.create ?? []) nextScene[c.node.id] = c.node as unknown as SceneNodeLike
    expect(nextScene.l1_dev).toBeDefined()
    const cleanAudit = auditSceneElectrical(nextScene)
    expect(cleanAudit.findings.filter((f) => f.category === 'trade-clash')).toHaveLength(0)
  })

  test('XT-05(b) & XT-05(c): Wall-embedded structural columns are bypassed with 0 clashes and MDP-1 selects a 100% clear NEC 110.26(A) working space', () => {
    // 1. Direct routeElectricalRun around a wall-embedded 6x6 ridge bearing post at [0, 0, 4.5]
    const colScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.8 },
      roof_1: { id: 'roof_1', type: 'roof', parentId: 'level_0' },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [0, 0], end: [0, 9], thickness: 0.16, height: 2.8 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], thickness: 0.16, height: 2.8 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 9], thickness: 0.16, height: 2.8 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [10, 9], end: [0, 9], thickness: 0.16, height: 2.8 },
      z_liv: { id: 'z_liv', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[0, 0], [10, 0], [10, 9], [0, 9]] },
      col_1: { id: 'col_1', type: 'structural:column', parentId: 'level_0', name: 'Ridge Beam Bearing Post #1', position: [0, 0, 4.5], widthIn: 5.5, depthIn: 5.5, heightM: 4.8 },
      col_2: { id: 'col_2', type: 'structural:column', parentId: 'level_0', name: 'Ridge Beam Bearing Post #2', position: [10, 0, 4.5], widthIn: 5.5, depthIn: 5.5, heightM: 4.8 },
    }
    const walls = extractRoutingWalls(colScene, 'level_0')
    const obs = extractTradeObstacles(colScene, 'level_0')
    const branch = routeElectricalRun([0.088, 0.38, 2.0], [0.088, 0.38, 7.0], obs, {
      walls,
      racewayType: 'nm-b',
      preferredChaseY: 2.55,
    })
    expect(branch.remainingClashes).toHaveLength(0)
    expect(branch.avoidedObstacles.some((a) => a.nodeId === 'col_1')).toBe(true)

    // Full Scenario D auto-populate -> 0 trade clashes and 0 working-space errors
    const scenD = electricalAgentOperations.electrical_autopopulate_nec(
      colScene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const mergedD: Record<string, SceneNodeLike> = { ...colScene }
    for (const c of scenD.changes?.create ?? []) mergedD[c.node.id] = c.node as unknown as SceneNodeLike
    const auditD = auditSceneElectrical(mergedD)
    expect(auditD.findings.filter((f) => f.category === 'trade-clash')).toHaveLength(0)
    expect(auditD.findings.filter((f) => f.category === 'working-space')).toHaveLength(0)

    // 2. XT-05(c): Utility room with HVAC air handler & plumbing manifold blocking preferred wall midpoint -> MDP-1 slides to clear NEC 110.26(A) spot
    const utilScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.16, height: 2.7 },
      z_util: { id: 'z_util', type: 'zone', parentId: 'level_0', name: 'Utility Room', category: 'utility', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
      ahu_block: { id: 'ahu_block', type: 'hvac:equipment', equipmentKind: 'air-handler', parentId: 'level_0', position: [3.0, 0, 0.55] },
      man_block: { id: 'man_block', type: 'plumbing:manifold', parentId: 'level_0', position: [1.5, 1.2, 0.4] },
      plenum_block: { id: 'plenum_block', type: 'hvac:plenum', parentId: 'level_0', position: [3.0, 1.65, 0.55], widthIn: 18, heightIn: 12, depthIn: 24 },
    }
    const utilOut = electricalAgentOperations.electrical_autopopulate_nec(
      utilScene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const mergedUtil: Record<string, SceneNodeLike> = { ...utilScene }
    for (const c of utilOut.changes?.create ?? []) mergedUtil[c.node.id] = c.node as unknown as SceneNodeLike
    const utilAudit = auditSceneElectrical(mergedUtil)
    expect(utilAudit.findings.filter((f) => f.category === 'working-space')).toHaveLength(0)
    expect(utilAudit.findings.filter((f) => f.category === 'dedicated-space')).toHaveLength(0)
  })

  test('VIS-02: Multi-circuit home runs stagger vertically across ceiling lanes and laterally without coplanar overlap or new clashes', () => {
    const multiRoom: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], thickness: 0.14, height: 2.7 },
      wm1: { id: 'wm1', type: 'wall', parentId: 'level_0', start: [4, 0], end: [4, 8], thickness: 0.12, height: 2.7 },
      wm2: { id: 'wm2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 8], thickness: 0.12, height: 2.7 },
      wh: { id: 'wh', type: 'wall', parentId: 'level_0', start: [0, 4], end: [12, 4], thickness: 0.12, height: 2.7 },
      z1: { id: 'z1', type: 'zone', parentId: 'level_0', name: 'Garage', category: 'garage', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      z2: { id: 'z2', type: 'zone', parentId: 'level_0', name: 'Kitchen', category: 'kitchen', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
      z3: { id: 'z3', type: 'zone', parentId: 'level_0', name: 'Bathroom', category: 'bathroom', polygon: [[8, 0], [12, 0], [12, 4], [8, 4]] },
      z4: { id: 'z4', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[0, 4], [4, 4], [4, 8], [0, 8]] },
      z5: { id: 'z5', type: 'zone', parentId: 'level_0', name: 'Bedroom 1', category: 'bedroom', polygon: [[4, 4], [8, 4], [8, 8], [4, 8]] },
      z6: { id: 'z6', type: 'zone', parentId: 'level_0', name: 'Laundry', category: 'laundry', polygon: [[8, 4], [12, 4], [12, 8], [8, 8]] },
    }
    const out = electricalAgentOperations.electrical_autopopulate_nec(
      multiRoom as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...multiRoom }
    for (const c of out.changes?.create ?? []) merged[c.node.id] = c.node as unknown as SceneNodeLike
    const homeRuns = Object.values(merged).filter(
      (n) =>
        n.type === 'electrical:conduit-run' &&
        (n.metadata as { runKind?: string } | undefined)?.runKind === 'home-run',
    )
    expect(homeRuns.length).toBeGreaterThanOrEqual(6)

    // Collect distinct chase elevations across home runs (must span multiple staggered lanes, not all identical Y!)
    const chaseYs = new Set<number>()
    for (const r of homeRuns) {
      const path = r.path as [number, number, number][]
      for (const pt of path.slice(1, -1)) {
        if (pt[1] >= 2.2 && pt[1] <= 2.6) chaseYs.add(pt[1])
      }
    }
    expect(chaseYs.size).toBeGreaterThanOrEqual(4)
    const audit = auditSceneElectrical(merged)
    expect(audit.errorCount).toBe(0)
  })

  test('XT-08, XT-09, XT-10 & XT-13: Trade obstacle & audit parity (center-anchored manifold, hvac:plenum/terminal, plumbing:fixture wet+clearance, rotated column, nominal HVAC dims, diagonal pipe subdivision)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.8 },
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'level_0', name: 'Bath', category: 'bathroom', polygon: [[0, 0], [6, 0], [6, 6], [0, 6]] },
      man_1: { id: 'man_1', type: 'plumbing:manifold', parentId: 'level_0', position: [1.0, 1.2, 1.0] },
      plenum_1: { id: 'plenum_1', type: 'hvac:plenum', parentId: 'level_0', position: [2.0, 1.5, 2.0], widthIn: 24, heightIn: 12, depthIn: 12, rotation: Math.PI / 2 },
      term_1: { id: 'term_1', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'supply-ceiling-diffuser', position: [3.0, 2.6, 3.0], neckSizeIn: 8 },
      tub_1: { id: 'tub_1', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'bathtub', position: [1.5, 0.15, 4.5] },
      sink_1: { id: 'sink_1', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'lavatory', position: [4.5, 0.53, 4.5] },
      col_rot: { id: 'col_rot', type: 'structural:column', parentId: 'level_0', position: [5.0, 0, 1.0], widthIn: 12, depthIn: 4, heightM: 2.8, rotation: Math.PI / 2 },
      rtu_1: { id: 'rtu_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'rooftop-package-unit', position: [10, 0, 10] },
      ahu_1: { id: 'ahu_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'air-handler', position: [12, 0, 10] },
      hp_1: { id: 'hp_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'heat-pump-condenser', position: [14, 0, 10] },
      erv_1: { id: 'erv_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'erv-ventilator', position: [16, 0, 10] },
      hood_1: { id: 'hood_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'range-hood', position: [18, 0, 10] },
      fan_1: { id: 'fan_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'bath-exhaust-fan', position: [20, 0, 10] },
      diag_pipe: { id: 'diag_pipe', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '2"', path: [[1, 2.2, 1], [7, 2.2, 7]] },
    }
    const obs = extractTradeObstacles(scene, 'level_0')

    // XT-08: plumbing:manifold center-anchored minY = y - 0.35, maxY = y + 0.35
    const manObs = obs.find((o) => o.nodeId === 'man_1')!
    expect(manObs.box.min[1]).toBeCloseTo(0.85, 3)
    expect(manObs.box.max[1]).toBeCloseTo(1.55, 3)

    // XT-09: hvac:plenum (inches->meters + rotated 90 deg) and hvac:terminal are conduit routing obstacles,
    // while plumbing:fixture is audited by NEC 406.9(C)/406.5(E)/110.26(A) without blocking dry stud-cavity conduits behind walls
    const plObs = obs.find((o) => o.nodeId === 'plenum_1')!
    expect(plObs).toBeDefined()
    // widthIn=24 (0.6096m) rotated 90deg -> Z span ~ 0.6096, X span ~ 12in (0.3048m)
    expect(plObs.box.max[0] - plObs.box.min[0]).toBeCloseTo(12 * 0.0254, 3)
    expect(plObs.box.max[2] - plObs.box.min[2]).toBeCloseTo(24 * 0.0254, 3)
    expect(obs.some((o) => o.nodeId === 'term_1')).toBe(true)
    expect(obs.some((o) => o.nodeId === 'tub_1')).toBe(false)

    // XT-10: structural:column rotated 90 deg swaps widthIn (12") and depthIn (4")
    const colObs = obs.find((o) => o.nodeId === 'col_rot')!
    expect(colObs.box.max[0] - colObs.box.min[0]).toBeCloseTo(4 * 0.0254, 3)
    expect(colObs.box.max[2] - colObs.box.min[2]).toBeCloseTo(12 * 0.0254, 3)

    // XT-13: nominal hvac:equipment dimensions & diagonal plumbing:pipe-run subdivision
    const rtuObs = obs.find((o) => o.nodeId === 'rtu_1')!
    expect(rtuObs.box.max[0] - rtuObs.box.min[0]).toBeCloseTo(1.55, 2)
    expect(rtuObs.box.max[2] - rtuObs.box.min[2]).toBeCloseTo(1.05, 2)
    expect(rtuObs.box.max[1] - rtuObs.box.min[1]).toBeCloseTo(1.15, 2)
    const ahuObs = obs.find((o) => o.nodeId === 'ahu_1')!
    expect(ahuObs.box.max[1] - ahuObs.box.min[1]).toBeCloseTo(1.42, 2)
    const hpObs = obs.find((o) => o.nodeId === 'hp_1')!
    expect(hpObs.box.max[0] - hpObs.box.min[0]).toBeCloseTo(0.85, 2)
    const ervObs = obs.find((o) => o.nodeId === 'erv_1')!
    expect(ervObs.box.max[1] - ervObs.box.min[1]).toBeCloseTo(0.45, 2)
    const hoodObs = obs.find((o) => o.nodeId === 'hood_1')!
    expect(hoodObs.box.max[1] - hoodObs.box.min[1]).toBeCloseTo(0.35, 2)
    const fanObs = obs.find((o) => o.nodeId === 'fan_1')!
    expect(fanObs.box.max[1] - fanObs.box.min[1]).toBeCloseTo(0.22, 2)

    const diagSegs = obs.filter((o) => o.nodeId === 'diag_pipe')
    expect(diagSegs.length).toBeGreaterThan(2)
    // Conduit far off the diagonal (at x=1, z=7) has 0 false clashes against subdivided diagonal pipe!
    expect(detectRunTradeClashes([[1, 2.2, 6.5], [1, 2.2, 7.5]], diagSegs)).toHaveLength(0)

    // XT-09 + XT-10 audit checks: tub/shower NEC 406.9(C), sink NEC 406.5(E), and NEC 110.26(A) against manifold, fixture, plenum, & rotated column
    const auditScene: Record<string, SceneNodeLike> = {
      ...scene,
      dev_tub: { id: 'dev_tub', type: 'electrical:device', parentId: 'level_0', name: 'Bad Tub Outlet', deviceKind: 'gfci', position: [1.5, 1.0, 4.9], gfciProtected: true },
      dev_sink: { id: 'dev_sink', type: 'electrical:device', parentId: 'level_0', name: 'Bad Sink Outlet', deviceKind: 'gfci', position: [4.5, 0.85, 4.5], gfciProtected: true },
      p_man: { id: 'p_man', type: 'electrical:panel', parentId: 'level_0', name: 'P-Manifold', position: [1.0, 1.52, 0.5], rotation: 0 },
      p_plenum: { id: 'p_plenum', type: 'electrical:panel', parentId: 'level_0', name: 'P-Plenum', position: [2.0, 1.52, 1.5], rotation: 0 },
      p_fix: { id: 'p_fix', type: 'electrical:panel', parentId: 'level_0', name: 'P-Fixture', position: [4.5, 1.52, 4.0], rotation: 0 },
      p_rotcol: { id: 'p_rotcol', type: 'electrical:panel', parentId: 'level_0', name: 'P-RotCol', position: [5.0, 1.52, 0.25], rotation: 0 },
    }
    const rep = auditSceneElectrical(auditScene)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('tub_1'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 406.5(E)' && f.nodeIds.includes('sink_1'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 110.26(A)' && f.nodeIds.includes('man_1'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 110.26(A)' && f.nodeIds.includes('plenum_1'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 110.26(A)' && f.nodeIds.includes('sink_1'))).toBe(true)
    // Rotated column at z=1.0 extends +/-0.1524m along Z (zMin=0.8476), inside p_rotcol front prism (0.25 + 0.09..1.004)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 110.26(A)' && f.nodeIds.includes('col_rot'))).toBe(true)
  })

  test('XT-11 & XT-12: Commercial 120V MEP load calc counts dedicatedLoads without 180VA receptacle duplication, and hvac:equipment fallback + stale kind-mismatch validation works', () => {
    // XT-11: Commercial 120V non-motor MEP loads counted in dedicatedLoads, excluded from generic 180VA receptacles
    const commScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      p1: { id: 'p1', type: 'electrical:panel', occupancy: 'commercial', voltageSystem: '120/208V-3P' },
      std_rec: { id: 'std_rec', type: 'electrical:device', deviceKind: 'duplex', name: 'Office Duplex', loadVa: 180 },
      mep_dw: {
        id: 'mep_dw',
        type: 'electrical:device',
        deviceKind: 'gfci',
        name: 'Commercial Dishwasher Power',
        isMotor: false,
        loadVa: 1500,
        metadata: { mepSourceNodeId: 'dw_1' },
      },
      mep_furn: {
        id: 'mep_furn',
        type: 'electrical:device',
        deviceKind: 'duplex',
        name: 'Gas Furnace Power',
        isMotor: false,
        loadVa: 850,
        metadata: { mepSourceNodeId: 'furn_1' },
      },
    }
    const commLoad = calculateSceneLoad(commScene, { occupancy: 'commercial', fallbackSquareFootage: 1000 })
    expect(commLoad.occupancy).toBe('commercial')
    if (commLoad.occupancy === 'commercial') {
      expect(commLoad.receptacleRawVa).toBe(180) // Only std_rec, NOT mep_dw or mep_furn
      expect(commLoad.dedicatedTotalVa).toBe(2350) // 1500 + 850
    }

    // XT-12: hvac:equipment fallback demands + stale kind-mismatch override + passive mini-split-indoor skip
    const hvacScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 6], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 6], end: [0, 6], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 2.7 },
      z_util: { id: 'z_util', type: 'zone', parentId: 'level_0', name: 'Utility', category: 'utility', polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] },
      // No explicit electricalDemand -> fallback derives 240V 2P 35A 4350VA
      hp_no_demand: { id: 'hp_no_demand', type: 'hvac:equipment', equipmentKind: 'heat-pump-condenser', coolingTons: 3, parentId: 'level_0', position: [2, 0, 1] },
      // Stale 240V 60A air-handler demand on a gas-furnace-96 -> overridden to 120V 1P 15A 850VA!
      furn_stale: {
        id: 'furn_stale',
        type: 'hvac:equipment',
        equipmentKind: 'gas-furnace-96',
        parentId: 'level_0',
        position: [5, 0, 1],
        electricalDemand: {
          required: true,
          voltage: 240,
          poles: 2,
          breakerAmps: 60,
          loadVa: 10600,
          dedicatedCircuit: true,
          loadCategory: 'hvac-heating',
          label: 'Stale Air Handler',
        },
      },
      // Passive mini-split-indoor with stale demand -> completely ignored (no breaker created)
      ms_indoor_stale: {
        id: 'ms_indoor_stale',
        type: 'hvac:equipment',
        equipmentKind: 'mini-split-indoor',
        parentId: 'level_0',
        position: [8, 2.2, 1],
        electricalDemand: {
          required: true,
          voltage: 240,
          poles: 2,
          breakerAmps: 30,
          loadVa: 4000,
          dedicatedCircuit: true,
          loadCategory: 'heat-pump',
          label: 'Stale Mini Split',
        },
      },
    }
    const hvacPlan = planNecAutoPopulate(hvacScene, { levelId: 'level_0', includeWiring: false })
    const hpDev = hvacPlan.devices.find((d) => d.mepSourceNodeId === 'hp_no_demand')!
    expect(hpDev).toBeDefined()
    expect(hpDev.poles).toBe(2)
    expect(hpDev.breakerAmps).toBe(35)
    expect(hpDev.loadVa).toBe(4350)

    const furnDev = hvacPlan.devices.find((d) => d.mepSourceNodeId === 'furn_stale')!
    expect(furnDev).toBeDefined()
    expect(furnDev.poles).toBe(1)
    expect(furnDev.breakerAmps).toBe(15)
    expect(furnDev.loadVa).toBe(850)

    expect(hvacPlan.devices.some((d) => d.mepSourceNodeId === 'ms_indoor_stale')).toBe(false)
  })

  test('Live 6-Scenario Edge Cases: plumbing:fixture wall-cavity clearance, NEC 406.9(C) partition-wall separation + ceiling bath-exhaust-fan, and HVAC side-return duct drop avoidance', () => {
    // 1. Kitchen conduit inside dividing wall at x=6.0 behind Master Bath Walk-In Shower (x=6.34) has 0 false clashes
    const showerWallScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w_div: { id: 'w_div', type: 'wall', parentId: 'level_0', start: [6.0, 0], end: [6.0, 6.0], thickness: 0.14, height: 2.7 },
      shower_1: { id: 'shower_1', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'shower', name: 'Master Bath Walk-In Shower', roomName: 'Master Bath', position: [6.34, 0.05, 3.0] },
      kit_gfci_run: {
        id: 'kit_gfci_run',
        type: 'electrical:conduit-run',
        parentId: 'level_0',
        name: 'Kitchen GFCI Wall Chase',
        racewayType: 'nm-b',
        wireGauge: '12',
        path: [[6.0, 1.12, 1.0], [6.0, 1.12, 5.0]],
      },
      // 2a. Guest Bedroom Outlet 3 on opposite side of drywall partition wall (x=5.92) from Guest Bath shower (x=6.34) -> 0 NEC 406.9(C) false positive!
      guest_bed_outlet: {
        id: 'guest_bed_outlet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Guest Bedroom Outlet 3',
        roomName: 'Guest Bedroom',
        deviceKind: 'duplex',
        position: [5.92, 0.38, 3.0],
        rotation: -Math.PI / 2,
      },
      // Same-room bath outlet on east side of wall (x=6.08, same side as shower x=6.34) -> STILL flagged by NEC 406.9(C)!
      bad_bath_outlet: {
        id: 'bad_bath_outlet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Bad Same-Room Bath Outlet',
        roomName: 'Master Bath',
        deviceKind: 'gfci',
        position: [6.08, 1.12, 3.0],
        rotation: Math.PI / 2,
        gfciProtected: true,
      },
      // Legacy duplex device referencing ceiling bath-exhaust-fan via mepSourceNodeId -> exempt from NEC 406.9(C)
      bath_fan_mep: {
        id: 'bath_fan_mep',
        type: 'hvac:equipment',
        parentId: 'level_0',
        equipmentKind: 'bath-exhaust-fan',
        name: 'Bath Exhaust Fan',
        position: [6.5, 2.69, 3.0],
      },
      legacy_fan_dev: {
        id: 'legacy_fan_dev',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Bath Exhaust Fan Power',
        deviceKind: 'duplex',
        position: [6.5, 1.5, 3.0],
        gfciProtected: true,
        metadata: { mepSourceNodeId: 'bath_fan_mep' },
      },
    }
    const showerAudit = auditSceneElectrical(showerWallScene)
    expect(showerAudit.findings.filter((f) => f.category === 'trade-clash')).toHaveLength(0)
    expect(
      showerAudit.findings.filter((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('guest_bed_outlet')),
    ).toHaveLength(0)
    expect(
      showerAudit.findings.filter((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('legacy_fan_dev')),
    ).toHaveLength(0)
    expect(
      showerAudit.findings.filter((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('bad_bath_outlet')),
    ).toHaveLength(1)

    // 2b. Autopopulate emits ceiling bath-exhaust-fan as hardwired luminaire at ceiling height (>= 2.44m) with 0 NEC 406.9(C) / 410.10(D) errors
    const bathFanScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.16, height: 2.7 },
      wm: { id: 'wm', type: 'wall', parentId: 'level_0', start: [3, 0], end: [3, 4], thickness: 0.12, height: 2.7 },
      z_hall: { id: 'z_hall', type: 'zone', parentId: 'level_0', name: 'Hallway', category: 'hallway', polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] },
      z_bath: { id: 'z_bath', type: 'zone', parentId: 'level_0', name: 'Guest Bath', category: 'bathroom', polygon: [[3, 0], [6, 0], [6, 4], [3, 4]] },
      tub_guest: { id: 'tub_guest', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'tub-shower-combo', position: [5.1, 0.15, 2.0] },
      fan_guest: { id: 'fan_guest', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'bath-exhaust-fan', name: 'Guest Bath Exhaust Fan', position: [5.0, 2.69, 2.0] },
    }
    const bathAuto = electricalAgentOperations.electrical_autopopulate_nec(
      bathFanScene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const mergedBath: Record<string, SceneNodeLike> = { ...bathFanScene }
    for (const c of bathAuto.changes?.create ?? []) mergedBath[c.node.id] = c.node as unknown as SceneNodeLike
    const fanDev = Object.values(mergedBath).find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'fan_guest',
    )!
    expect(fanDev).toBeDefined()
    expect(fanDev.deviceKind).toBe('luminaire')
    expect((fanDev.position as [number, number, number])[1]).toBeGreaterThanOrEqual(2.44)
    const bathAudit = auditSceneElectrical(mergedBath)
    expect(bathAudit.findings.filter((f) => f.codeRef === 'NEC 406.9(C)' || f.codeRef === 'NEC 410.10(D)')).toHaveLength(0)

    // 3. HVAC side-return vertical duct drop immediately beside Air Handler (~0.55m away):
    //    MEP power terminal avoids return drop face AND conduit routes around vertical HVAC drop with 0 clashes!
    const hvacDropScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.16, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 5], thickness: 0.16, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 5], end: [0, 5], thickness: 0.16, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 5], end: [0, 0], thickness: 0.16, height: 2.7 },
      z_util: { id: 'z_util', type: 'zone', parentId: 'level_0', name: 'Utility', category: 'utility', polygon: [[0, 0], [8, 0], [8, 5], [0, 5]] },
      ahu_main: { id: 'ahu_main', type: 'hvac:equipment', equipmentKind: 'air-handler', parentId: 'level_0', position: [4.0, 0, 1.0], rotation: 0 },
      // Vertical side-return duct drop right in front (+Z) of Air Handler at z=1.55 (where naive +0.56m offset would land!)
      hvacduct_auto_12: {
        id: 'hvacduct_auto_12',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        shape: 'rect',
        width: 14,
        height: 10,
        path: [
          [4.0, 2.5, 1.55],
          [4.0, 0.35, 1.55],
        ],
      },
    }
    const dropAuto = electricalAgentOperations.electrical_autopopulate_nec(
      hvacDropScene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const mergedDrop: Record<string, SceneNodeLike> = { ...hvacDropScene }
    for (const c of dropAuto.changes?.create ?? []) mergedDrop[c.node.id] = c.node as unknown as SceneNodeLike
    const dropAudit = auditSceneElectrical(mergedDrop)
    expect(dropAudit.findings.filter((f) => f.category === 'trade-clash')).toHaveLength(0)
  })
})
