import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import { buildWiredPanelInteriorCad } from '../cad/panel-interior'
import { auditSceneElectrical } from '../nec/audit'
import { findNextWallPlacement, planDeviceAutoConnection } from '../nec/autopopulate'
import {
  computeWallStudPositions,
  DRESSED_STUD_HALF_M,
  extractBonesFramingContext,
  snapWallOffsetToStud,
} from '../nec/framing-interop'
import type { SceneNodeLike } from '../nec/load-calc'
import { buildElectricalTakeoff, buildPanelSchedule } from '../nec/panel-schedule'

function makeSampleHouseScene(): Record<string, AnyNode> {
  return {
    level_0: {
      object: 'node',
      id: 'level_0',
      type: 'level',
      name: 'Ground Floor',
      parentId: null,
      visible: true,
      metadata: {},
      level: 0,
      children: [],
    } as unknown as AnyNode,

    // Rooms (Zones)
    zone_living: {
      id: 'zone_living',
      type: 'zone',
      name: 'Living Room',
      category: 'living-room',
      parentId: 'level_0',
      polygon: [
        [0, 0],
        [5, 0],
        [5, 4],
        [0, 4],
      ],
    } as unknown as AnyNode,
    zone_kitchen: {
      id: 'zone_kitchen',
      type: 'zone',
      name: 'Kitchen',
      category: 'kitchen',
      parentId: 'level_0',
      polygon: [
        [5, 0],
        [9, 0],
        [9, 4],
        [5, 4],
      ],
    } as unknown as AnyNode,
    zone_bath: {
      id: 'zone_bath',
      type: 'zone',
      name: 'Hall Bath',
      category: 'bathroom',
      parentId: 'level_0',
      polygon: [
        [0, 4],
        [3, 4],
        [3, 6.5],
        [0, 6.5],
      ],
    } as unknown as AnyNode,
    zone_garage: {
      id: 'zone_garage',
      type: 'zone',
      name: 'Garage',
      category: 'garage',
      parentId: 'level_0',
      polygon: [
        [3, 4],
        [9, 4],
        [9, 6.5],
        [3, 6.5],
      ],
    } as unknown as AnyNode,
    zone_patio: {
      id: 'zone_patio',
      type: 'zone',
      name: 'Back Patio',
      category: 'patio',
      parentId: 'level_0',
      polygon: [
        [0, -2.5],
        [5, -2.5],
        [5, 0],
        [0, 0],
      ],
    } as unknown as AnyNode,

    // Walls
    wall_front: {
      id: 'wall_front',
      type: 'wall',
      parentId: 'level_0',
      start: [0, 0],
      end: [5, 0],
      thickness: 0.14,
      height: 2.8,
    } as unknown as AnyNode,
    wall_kitchen_north: {
      id: 'wall_kitchen_north',
      type: 'wall',
      parentId: 'level_0',
      start: [5, 0],
      end: [9, 0],
      thickness: 0.14,
      height: 2.8,
    } as unknown as AnyNode,
    wall_west: {
      id: 'wall_west',
      type: 'wall',
      parentId: 'level_0',
      start: [0, 0],
      end: [0, 4],
      thickness: 0.14,
      height: 2.8,
    } as unknown as AnyNode,
    wall_garage_east: {
      id: 'wall_garage_east',
      type: 'wall',
      parentId: 'level_0',
      start: [9, 4],
      end: [9, 6.5],
      thickness: 0.14,
      height: 2.8,
    } as unknown as AnyNode,

    // Front Door on wall_front
    door_front: {
      id: 'door_front',
      type: 'door',
      name: 'Front Door',
      parentId: 'wall_front',
      position: [1.5, 0, 0],
      width: 0.92,
      height: 2.1,
    } as unknown as AnyNode,

    // Stairway inside Living Room
    stair_main: {
      id: 'stair_main',
      type: 'stair',
      name: 'Main Stairway',
      parentId: 'level_0',
      position: [2.5, 0, 1.2],
      rotation: 0,
      width: 1.0,
    } as unknown as AnyNode,

    // Higher-priority Plumbing pipe & HVAC trunk in ceiling that electrical MUST yield around
    'pipe-segment_1': {
      id: 'pipe-segment_1',
      type: 'pipe-segment',
      parentId: 'level_0',
      diameter: 4,
      path: [
        [4.5, 2.55, -1],
        [4.5, 2.55, 7],
      ],
    } as unknown as AnyNode,
    'duct-segment_1': {
      id: 'duct-segment_1',
      type: 'duct-segment',
      parentId: 'level_0',
      shape: 'rect',
      width: 16,
      height: 8,
      path: [
        [0, 2.55, 3.2],
        [9, 2.55, 3.2],
      ],
    } as unknown as AnyNode,
  }
}

describe('NEC Minimum Auto-Populate (Outlets, GFCIs, Doors, Stairs, Circuits, Home Runs & Daisy Chains)', () => {
  test('Hybrid mode auto-populates Front Door, Outdoor WR GFCI, Stairway 3-way & landing outlet, 2x Kitchen SAB circuits, Home Runs & Daisy-Chain runs yielding around plumbing/HVAC', () => {
    const nodes = makeSampleHouseScene()
    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { occupancy: 'residential', protectionMode: 'hybrid' },
      { activeLevelId: 'level_0' },
    )

    const creates = outcome.changes?.create ?? []
    expect(creates.length).toBeGreaterThan(20)
    for (const c of creates) {
      nodes[c.node.id] = c.node
    }

    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const panels = Object.values(record).filter((n) => n.type === 'electrical:panel')
    const devices = Object.values(record).filter((n) => n.type === 'electrical:device')
    const runs = Object.values(record).filter((n) => n.type === 'electrical:conduit-run')

    expect(panels).toHaveLength(1)
    expect(outcome.result.circuitsCreated).toBeGreaterThanOrEqual(6)
    expect(outcome.result.homeRunsPlanned).toBe(outcome.result.circuitsCreated)
    expect(outcome.result.daisyChainRunsPlanned).toBeGreaterThan(5)

    // Verify specific NEC locations requested by user:
    // 1) Front Door Outdoor WR GFCI + Entry Switch + Exterior Light + Entry Outlet
    expect(devices.some((d) => String(d.name).includes('Front Door Outdoor WR GFCI'))).toBe(true)
    expect(devices.some((d) => String(d.name).includes('Front Door Entry Switch'))).toBe(true)
    expect(devices.some((d) => String(d.name).includes('Front Door Exterior Light'))).toBe(true)
    expect(devices.some((d) => String(d.name).includes('Front Door Entry Receptacle'))).toBe(true)

    // 2) Stairway Landing Receptacle + Top & Bottom 3-Way Switches + Overhead Light
    expect(devices.some((d) => String(d.name).includes('Stairway Landing Receptacle'))).toBe(true)
    expect(devices.filter((d) => d.deviceKind === 'switch-3way').length).toBeGreaterThanOrEqual(2)

    // 3) Kitchen split across 2x 20A SAB circuits + Bathroom & Garage dedicated 20A GFCIs
    const kitchenCkts = new Set(
      devices
        .filter((d) => String((d.metadata as { circuitGroup?: string })?.circuitGroup).startsWith('Kitchen SAB'))
        .map((d) => d.circuitNumber),
    )
    expect(kitchenCkts.size).toBe(2)
    expect(devices.some((d) => String(d.name).includes('Hall Bath Vanity GFCI'))).toBe(true)
    expect(devices.some((d) => String(d.name).includes('Garage GFCI'))).toBe(true)

    // 4) Home runs + Outlet-to-Outlet daisy-chain runs created and yielding around Plumbing & HVAC
    const homeRuns = runs.filter((r) => (r.metadata as { runKind?: string })?.runKind === 'home-run')
    const daisyRuns = runs.filter((r) => (r.metadata as { runKind?: string })?.runKind === 'daisy-chain')
    expect(homeRuns.length).toBeGreaterThanOrEqual(6)
    expect(daisyRuns.length).toBeGreaterThanOrEqual(6)

    // 5) Full NEC scene audit passes with ZERO errors (0 trade clashes, 0 box fill errors, 0 missing GFCI!)
    const audit = auditSceneElectrical(record)
    expect(audit.errorCount).toBe(0)
    expect(audit.passed).toBe(true)

    // 6) Priced BOM takeoff & Cover-Off 3D Panel Interior both reflect all auto-populated circuits
    const takeoff = buildElectricalTakeoff(record)
    expect(takeoff.pricing.materialSubtotalUsd).toBeGreaterThan(500)
    expect(takeoff.pricing.estimatedTotalUsd).toBeGreaterThan(takeoff.pricing.materialSubtotalUsd)

    const sched = buildPanelSchedule(panels[0]!, devices, runs)
    expect(sched.usedSpaces).toBeGreaterThanOrEqual(6)
    const interior = buildWiredPanelInteriorCad({ schedule: sched, viewMode: 'cover-off' })
    expect(interior.children.length).toBeGreaterThan(40)
  })

  test('GFCI-Breakers protection mode uses panel GFCI breakers instead of physical GFCI outlets', () => {
    const nodes = makeSampleHouseScene()
    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { occupancy: 'residential', protectionMode: 'gfci-breakers' },
      { activeLevelId: 'level_0' },
    )
    for (const c of outcome.changes?.create ?? []) {
      nodes[c.node.id] = c.node
    }
    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const devices = Object.values(record).filter((n) => n.type === 'electrical:device')

    // Zero physical 'gfci' outlets, yet all wet/outdoor outlets have gfciProtected = true -> GFCI breakers on panel!
    expect(devices.filter((d) => d.deviceKind === 'gfci')).toHaveLength(0)
    expect(devices.filter((d) => d.gfciProtected === true).length).toBeGreaterThanOrEqual(4)

    const takeoff = buildElectricalTakeoff(record)
    expect(Object.keys(takeoff.breakersBySpec).some((spec) => spec.includes('GFCI'))).toBe(true)

    const audit = auditSceneElectrical(record)
    expect(audit.passed).toBe(true)
  })

  test('R3-BUG-01..04: LPT phase balancing keeps imbalance <= 20% (0 NEC 220.61 warnings), stairway light uses 4-oct-2.125, and upsized wireGauge syncs to device boxes', () => {
    const nodes = makeSampleHouseScene()
    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { occupancy: 'residential', protectionMode: 'hybrid', includeLighting: true, includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    for (const c of outcome.changes?.create ?? []) {
      nodes[c.node.id] = c.node
    }
    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const panels = Object.values(record).filter((n) => n.type === 'electrical:panel')
    const devices = Object.values(record).filter((n) => n.type === 'electrical:device')
    const runs = Object.values(record).filter((n) => n.type === 'electrical:conduit-run')

    // R3-BUG-01: LPT greedy phase balancer keeps phase imbalance <= 20% (zero NEC 220.61 warnings)
    const sched = buildPanelSchedule(panels[0]!, devices, runs)
    expect(sched.imbalancePct).toBeLessThanOrEqual(20)
    const audit = auditSceneElectrical(record)
    expect(audit.errorCount).toBe(0)
    expect(audit.findings.filter((f) => f.codeRef === 'NEC 220.61')).toHaveLength(0)

    // R3-BUG-02: Stairway Overhead Light uses 4-oct-2.125 (21.5 cu in)
    const stairLight = devices.find((d) => String(d.name).includes('Stairway Overhead Light'))
    expect(stairLight?.boxType).toBe('4-oct-2.125')

    // R3-BUG-03 & R3-BUG-04: Every device's wireGauge matches its circuit's home-run wireGauge & passes NEC 314.16 box fill
    for (const hr of runs.filter((r) => (r.metadata as { runKind?: string })?.runKind === 'home-run')) {
      const cktDevs = devices.filter((d) => d.circuitNumber === hr.circuitNumber && d.panelId === hr.panelId)
      for (const dev of cktDevs) {
        expect(dev.wireGauge).toBe(hr.wireGauge)
      }
    }
    expect(audit.findings.filter((f) => f.category === 'box-fill')).toHaveLength(0)
  })

  test('Enclosed Two-Bedroom apartment: 100% wall-snapped outlets/switches (zero floating), ceiling lights <= level height, and wall-following Manhattan runs', () => {
    const wallsList: Array<[string, [number, number], [number, number]]> = [
      ['wall_n', [-5, -4], [5, -4]],
      ['wall_e', [5, -4], [5, 4]],
      ['wall_s', [5, 4], [-5, 4]],
      ['wall_w', [-5, 4], [-5, -4]],
      ['wall_corr_1', [-5, 0], [-1, 0]],
      ['wall_corr_2', [-1, 0], [2, 0]],
      ['wall_corr_3', [2, 0], [5, 0]],
      ['wall_part_1', [-1, -4], [-1, 0]],
      ['wall_part_2', [2, -4], [2, 0]],
    ]

    const nodes: Record<string, AnyNode> = {
      level_0: {
        id: 'level_0',
        type: 'level',
        name: 'Ground Floor',
        parentId: null,
        height: 2.5,
      } as unknown as AnyNode,
      zone_living: {
        id: 'zone_living',
        type: 'zone',
        name: 'Living / Kitchen',
        parentId: 'level_0',
        polygon: [[-5, 0], [5, 0], [5, 4], [-5, 4]],
      } as unknown as AnyNode,
      zone_bed1: {
        id: 'zone_bed1',
        type: 'zone',
        name: 'Bedroom 1',
        parentId: 'level_0',
        polygon: [[-5, -4], [-1, -4], [-1, 0], [-5, 0]],
      } as unknown as AnyNode,
      zone_bath: {
        id: 'zone_bath',
        type: 'zone',
        name: 'Bath',
        parentId: 'level_0',
        polygon: [[-1, -4], [2, -4], [2, 0], [-1, 0]],
      } as unknown as AnyNode,
      zone_bed2: {
        id: 'zone_bed2',
        type: 'zone',
        name: 'Bedroom 2',
        parentId: 'level_0',
        polygon: [[2, -4], [5, -4], [5, 0], [2, 0]],
      } as unknown as AnyNode,
      door_front: { id: 'door_front', type: 'door', name: 'Front Door', parentId: 'wall_s', position: [0, 1.05, 0], width: 0.8 } as unknown as AnyNode,
      door_bed1: { id: 'door_bed1', type: 'door', name: 'Bed 1 Door', parentId: 'wall_corr_1', position: [2.0, 1.05, 0], width: 0.8 } as unknown as AnyNode,
      door_bath: { id: 'door_bath', type: 'door', name: 'Bath Door', parentId: 'wall_corr_2', position: [1.5, 1.05, 0], width: 0.8 } as unknown as AnyNode,
      door_bed2: { id: 'door_bed2', type: 'door', name: 'Bed 2 Door', parentId: 'wall_corr_3', position: [1.5, 1.05, 0], width: 0.8 } as unknown as AnyNode,
    }
    for (const [id, start, end] of wallsList) {
      nodes[id] = { id, type: 'wall', parentId: 'level_0', start, end, thickness: 0.1 } as unknown as AnyNode
    }

    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { occupancy: 'residential', protectionMode: 'hybrid', includeLighting: true, includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    for (const c of outcome.changes?.create ?? []) {
      nodes[c.node.id] = c.node
    }

    const distToNearestWall = (x: number, z: number): number => {
      let best = Number.POSITIVE_INFINITY
      for (const [, s, e] of wallsList) {
        const vx = e[0] - s[0]
        const vz = e[1] - s[1]
        const len = Math.hypot(vx, vz)
        const t = Math.max(0, Math.min(len, ((x - s[0]) * vx + (z - s[1]) * vz) / len))
        const px = s[0] + (vx / len) * t
        const pz = s[1] + (vz / len) * t
        const d = Math.hypot(x - px, z - pz)
        if (d < best) best = d
      }
      return best
    }

    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const devices = Object.values(record).filter((n) => n.type === 'electrical:device')
    const runs = Object.values(record).filter((n) => n.type === 'electrical:conduit-run')

    // 1. ZERO floating wall-mounted devices (every outlet, GFCI, and switch sits flush within 0.12 m of a wall!)
    const wallDevices = devices.filter((d) => d.deviceKind !== 'luminaire' && d.deviceKind !== 'smoke-co')
    expect(wallDevices.length).toBeGreaterThanOrEqual(16)
    for (const dev of wallDevices) {
      const pos = dev.position as [number, number, number]
      expect(distToNearestWall(pos[0], pos[2])).toBeLessThanOrEqual(0.12)
    }

    // 2. Ceiling luminaires & interconnected Smoke/CO alarms sit below levelHeight (2.5 m), never floating above the walls!
    const luminaires = devices.filter((d) => d.deviceKind === 'luminaire')
    expect(luminaires.length).toBeGreaterThanOrEqual(4)
    for (const lum of luminaires) {
      const pos = lum.position as [number, number, number]
      expect(pos[1]).toBeLessThanOrEqual(2.5)
    }
    const smokeAlarms = devices.filter((d) => d.deviceKind === 'smoke-co')
    expect(smokeAlarms.length).toBeGreaterThanOrEqual(3)
    for (const sm of smokeAlarms) {
      const pos = sm.position as [number, number, number]
      expect(pos[1]).toBeLessThanOrEqual(2.5)
    }

    // 3. Every wall-to-wall circuit run strictly follows building walls (every waypoint within 0.18 m of a wall!)
    const luminaireIds = new Set(luminaires.map((l) => l.id))
    const wallToWallRuns = runs.filter(
      (r) => !luminaireIds.has(String(r.targetDeviceId)) && !luminaireIds.has(String((r.metadata as { fromNodeId?: string })?.fromNodeId)),
    )
    expect(wallToWallRuns.length).toBeGreaterThanOrEqual(10)
    for (const run of wallToWallRuns) {
      const path = run.path as [number, number, number][]
      // Skip runs whose start or end is a ceiling luminaire (identified by being > 0.3 m from walls)
      if (
        distToNearestWall(path[0]![0], path[0]![2]) > 0.25 ||
        distToNearestWall(path[path.length - 1]![0], path[path.length - 1]![2]) > 0.25
      ) {
        continue
      }
      for (const pt of path) {
        // Concealed in-wall mode: every waypoint sits dead-center inside a wall cavity (<= 0.02 m from centerline) and below wall top cap (<= 2.46 m)
        expect(distToNearestWall(pt[0], pt[2])).toBeLessThanOrEqual(0.02)
        expect(pt[1]).toBeLessThanOrEqual(2.46)
      }
    }

    // 4. Full NEC audit passes with 0 errors and 0 warnings
    const audit = auditSceneElectrical(record)
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('Adding an outlet auto-joins existing room run (wall-following daisy chain) or creates a new Home Run in a new room', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground Floor', parentId: null, height: 2.5 } as unknown as AnyNode,
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [-5, -4], end: [5, -4], thickness: 0.1 } as unknown as AnyNode,
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [5, -4], end: [5, 0], thickness: 0.1 } as unknown as AnyNode,
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [5, 0], end: [-5, 0], thickness: 0.1 } as unknown as AnyNode,
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [-5, 0], end: [-5, -4], thickness: 0.1 } as unknown as AnyNode,
      wall_mid: { id: 'wall_mid', type: 'wall', parentId: 'level_0', start: [0, -4], end: [0, 0], thickness: 0.1 } as unknown as AnyNode,
      zone_bed1: { id: 'zone_bed1', type: 'zone', name: 'Bedroom 1', parentId: 'level_0', polygon: [[-5, -4], [0, -4], [0, 0], [-5, 0]] } as unknown as AnyNode,
      zone_bed2: { id: 'zone_bed2', type: 'zone', name: 'Bedroom 2', parentId: 'level_0', polygon: [[0, -4], [5, -4], [5, 0], [0, 0]] } as unknown as AnyNode,
    }
    const ctx = { activeLevelId: 'level_0' }
    const applyOutcome = (out: { changes?: { create?: Array<{ node: AnyNode }>; update?: Array<{ id: string; data: Partial<AnyNode> }> } }) => {
      for (const c of out.changes?.create ?? []) nodes[c.node.id] = c.node
      for (const u of out.changes?.update ?? []) {
        if (nodes[u.id]) nodes[u.id] = { ...nodes[u.id], ...u.data } as AnyNode
      }
    }

    // Place panel on Bedroom 1 south wall
    const pOut = electricalAgentOperations.electrical_place_panel(
      nodes,
      { name: 'MDP-1', position: [-3.5, 1.52, -0.12], rotation: Math.PI, occupancy: 'residential' },
      ctx,
    )
    applyOutcome(pOut)
    const panelId = pOut.result.panelId

    // 1. Add first outlet in Bedroom 1 (new room -> automatically creates a Home Run from MDP-1!)
    const bed1Out1 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed1 Outlet 1', position: [-4.94, 0.38, -2.0], rotation: Math.PI / 2, deviceKind: 'duplex', panelId },
      ctx,
    )
    applyOutcome(bed1Out1)
    expect(bed1Out1.result.connectionMode).toBe('new-home-run')
    expect(bed1Out1.result.roomName).toBe('Bedroom 1')
    expect(bed1Out1.result.conduitRunId).toBeTruthy()
    const run1 = nodes[bed1Out1.result.conduitRunId!] as unknown as SceneNodeLike
    expect((run1.metadata as { runKind?: string })?.runKind).toBe('home-run')

    // 2. Add second outlet on the SAME wall in Bedroom 1 -> joins Bedroom 1's existing circuit with horizontal wall daisy chain!
    const bed1Out2 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed1 Outlet 2', position: [-4.94, 0.38, -3.2], rotation: Math.PI / 2, deviceKind: 'duplex', panelId },
      ctx,
    )
    applyOutcome(bed1Out2)
    expect(bed1Out2.result.connectionMode).toBe('joined-existing-run')
    expect(bed1Out2.result.circuitNumber).toBe(bed1Out1.result.circuitNumber)
    expect(bed1Out2.result.connectedFromNodeId).toBe(bed1Out1.result.deviceId)
    const run2 = nodes[bed1Out2.result.conduitRunId!] as unknown as SceneNodeLike
    expect((run2.metadata as { runKind?: string })?.runKind).toBe('daisy-chain')
    // Same wall, same height -> stays horizontally on west wall at y = 0.38 (zero ceiling drop!)
    expect((run2.path as [number, number, number][]).every((pt) => Math.abs(pt[1] - 0.38) < 0.01)).toBe(true)
    // Anchor device conductorCount bumped from 2 -> 4 (feed-in + feed-thru)
    expect((nodes[bed1Out1.result.deviceId] as unknown as SceneNodeLike).conductorCount).toBe(4)

    // 3. Add outlet in Bedroom 2 (a NEW room!) -> automatically allocates a NEW circuit & creates a Home Run!
    const bed2Out1 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed2 Outlet 1', position: [4.94, 0.38, -2.0], rotation: -Math.PI / 2, deviceKind: 'duplex', panelId },
      ctx,
    )
    applyOutcome(bed2Out1)
    expect(bed2Out1.result.connectionMode).toBe('new-home-run')
    expect(bed2Out1.result.roomName).toBe('Bedroom 2')
    expect(bed2Out1.result.circuitNumber).not.toBe(bed1Out1.result.circuitNumber)
    const run3 = nodes[bed2Out1.result.conduitRunId!] as unknown as SceneNodeLike
    expect((run3.metadata as { runKind?: string })?.runKind).toBe('home-run')

    // 4. Full scene NEC audit passes with 0 errors and 0 wiring/box-fill warnings (only expected IRC R314.3 smoke-alarm reminders since this test only places 3 outlets)
    const audit = auditSceneElectrical(nodes as unknown as Readonly<Record<string, SceneNodeLike>>)
    expect(audit.errorCount).toBe(0)
    expect(audit.findings.filter((f) => f.category !== 'life-safety')).toHaveLength(0)
  })

  test('R4-BUG-02/03 & R4-OPT-02 & R4-CON-01: 3rd outlet splice increments anchor box to 6 conductors + upsizes box, tub exclusion + motor floor mount + multi-level isolation + VD sizing + explicit bath circuit isolation', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground Floor', parentId: null, height: 2.5 } as unknown as AnyNode,
      level_1: { id: 'level_1', type: 'level', name: 'Upper Floor', parentId: null, height: 2.5 } as unknown as AnyNode,
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14 } as unknown as AnyNode,
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14 } as unknown as AnyNode,
      wall_s: { id: 'wall_s', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14 } as unknown as AnyNode,
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14 } as unknown as AnyNode,
      wall_mid: { id: 'wall_mid', type: 'wall', parentId: 'level_0', start: [3, 0], end: [3, 4], thickness: 0.14 } as unknown as AnyNode,
      zone_bed: { id: 'zone_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] } as unknown as AnyNode,
      zone_bath: { id: 'zone_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[3, 0], [6, 0], [6, 4], [3, 4]] } as unknown as AnyNode,
      tub_1: { id: 'tub_1', type: 'item', name: 'Bathtub', parentId: 'level_0', position: [5.1, 0, 0.5], dimensions: [1.6, 0.6, 0.8] } as unknown as AnyNode,
      // Upper floor identical wall (to verify level_0 outlets never block level_1 placement)
      wall_l1_n: { id: 'wall_l1_n', type: 'wall', parentId: 'level_1', start: [0, 0], end: [3, 0], thickness: 0.14 } as unknown as AnyNode,
      zone_l1_bed: { id: 'zone_l1_bed', type: 'zone', name: 'Upper Bed', parentId: 'level_1', polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] } as unknown as AnyNode,
    }
    const ctx = { activeLevelId: 'level_0' }
    const apply = (out: { changes?: { create?: Array<{ node: AnyNode }>; update?: Array<{ id: string; data: Partial<AnyNode> }> } }) => {
      for (const c of out.changes?.create ?? []) nodes[c.node.id] = c.node
      for (const u of out.changes?.update ?? []) {
        if (nodes[u.id]) nodes[u.id] = { ...nodes[u.id], ...u.data } as AnyNode
      }
    }

    const pOut = electricalAgentOperations.electrical_place_panel(
      nodes,
      { name: 'MDP-1', position: [0.08, 1.52, 2.0], rotation: Math.PI / 2, occupancy: 'residential' },
      ctx,
    )
    apply(pOut)
    const panelId = pOut.result.panelId

    // R4-BUG-02: Place 3 outlets where #2 and #3 both splice from #1 (at x=1.5, z=0.08) -> #1 jumps 2 -> 4 -> 6 + upsizes box!
    const o1 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed Center', position: [1.5, 0.38, 0.08], rotation: 0, deviceKind: 'duplex', panelId, breakerAmps: 20 },
      ctx,
    )
    apply(o1)
    const o2 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed Left', position: [0.7, 0.38, 0.08], rotation: 0, deviceKind: 'duplex', panelId, breakerAmps: 20 },
      ctx,
    )
    apply(o2)
    expect((nodes[o1.result.deviceId] as unknown as SceneNodeLike).conductorCount).toBe(4)

    const o3 = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bed Right', position: [2.3, 0.38, 0.08], rotation: 0, deviceKind: 'duplex', panelId, breakerAmps: 20 },
      ctx,
    )
    apply(o3)
    expect(o3.result.connectedFromNodeId).toBe(o1.result.deviceId)
    const o1After = nodes[o1.result.deviceId] as unknown as SceneNodeLike
    expect(o1After.conductorCount).toBe(6)
    expect(o1After.boxType).not.toBe('single-gang-standard') // Must auto-upsize past 18 cu in for 6x#12 + yoke + clamp + EGC!

    // R4-BUG-03A: findNextWallPlacement in Bathroom respects NEC 406.9(C) >= 0.96 m clearance from tub_1
    const bathPlace = findNextWallPlacement(nodes as unknown as Readonly<Record<string, SceneNodeLike>>, 'level_0', {
      deviceKind: 'gfci',
      preferredZoneId: 'zone_bath',
    })
    const dxTub = bathPlace.position[0] < 4.3 ? 4.3 - bathPlace.position[0] : bathPlace.position[0] > 5.9 ? bathPlace.position[0] - 5.9 : 0
    const dzTub = bathPlace.position[2] < 0.1 ? 0.1 - bathPlace.position[2] : bathPlace.position[2] > 0.9 ? bathPlace.position[2] - 0.9 : 0
    expect(Math.hypot(dxTub, dzTub)).toBeGreaterThanOrEqual(0.95)

    // R4-BUG-03B: motor-load places on floor (y = 0), never wall outlet height (0.38)
    const motorPlace = findNextWallPlacement(nodes as unknown as Readonly<Record<string, SceneNodeLike>>, 'level_0', {
      deviceKind: 'motor-load',
    })
    expect(motorPlace.position[1]).toBe(0)

    // R4-BUG-03C: Level 0 outlets at (0.7/1.5/2.3, 0.38, 0.08) do NOT block Level 1 wall placement!
    const upperPlace = findNextWallPlacement(nodes as unknown as Readonly<Record<string, SceneNodeLike>>, 'level_1', {
      deviceKind: 'duplex',
      preferredZoneId: 'zone_l1_bed',
    })
    expect(upperPlace.zoneName).toBe('Upper Bed')
    expect(upperPlace.position[2]).toBeCloseTo(0.078, 2)

    // R4-CON-01: Place a Bathroom GFCI on its dedicated 20A circuit, then try passing its explicit circuitNumber for a Bedroom outlet -> rejected & isolated!
    const bathOut = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bath GFCI', position: [...bathPlace.position] as [number, number, number], rotation: bathPlace.rotation, deviceKind: 'gfci', panelId, breakerAmps: 20 },
      ctx,
    )
    apply(bathOut)
    const bedCross = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        name: 'Bed Isolated',
        position: [1.5, 0.38, 3.92],
        rotation: Math.PI,
        deviceKind: 'duplex',
        panelId,
        circuitNumber: bathOut.result.circuitNumber,
        breakerAmps: 20,
      },
      ctx,
    )
    expect(bedCross.result.circuitNumber).not.toBe(bathOut.result.circuitNumber)

    // R4-OPT-02: Long daisy-chain hop (~30 m / ~98 ft) at high circuit load upsizes wireGauge for <= 3% VD
    const longNodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', parentId: null, height: 3.0 },
      wall_long: { id: 'wall_long', type: 'wall', parentId: 'level_0', start: [0, 0], end: [40, 0], thickness: 0.14 },
      zone_shop: { id: 'zone_shop', type: 'zone', name: 'Shop', parentId: 'level_0', polygon: [[0, 0], [40, 0], [40, 6], [0, 6]] },
      panel_shop: { id: 'panel_shop', type: 'electrical:panel', parentId: 'level_0', name: 'LP-1', position: [0.2, 1.52, 0.08], voltageSystem: '120/240V-1P', spaces: 24 },
      dev_start: {
        id: 'dev_start',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Shop 1',
        deviceKind: 'duplex',
        panelId: 'panel_shop',
        circuitNumber: 1,
        poles: 1,
        breakerAmps: 20,
        loadVa: 1440,
        wireGauge: '12',
        conductorCount: 2,
        position: [2, 0.38, 0.08],
        rotation: 0,
      },
    }
    const longPlan = planDeviceAutoConnection(
      longNodes,
      {
        id: 'dev_far',
        name: 'Shop Far',
        position: [34, 0.38, 0.08],
        rotation: 0,
        deviceKind: 'duplex',
        occupancy: 'residential',
        panelId: 'panel_shop',
        poles: 1,
        breakerAmps: 20,
        loadVa: 360,
        continuous: false,
        gfciProtected: false,
        afciProtected: false,
        boxType: 'single-gang-standard',
        wireGauge: '12',
        conductorCount: 2,
      },
      { levelId: 'level_0' },
    )
    expect(longPlan.mode).toBe('joined-existing-run')
    // ~105 ft one-way at 15A -> #12 is 5.2% VD, #10 is 3.26% (> 3%), so NEC 210.19(A) upsizes to #8 AWG (2.04% <= 3%)!
    expect(longPlan.wireGauge).toBe('8')
  })

  test('Bones framing interop: snaps nail-on wall boxes flush to 16"/24" OC studs, aligns MDP-1 to bones:service, and skips CMU walls', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground', parentId: null, height: 2.5 } as unknown as AnyNode,
      bones_fr: {
        id: 'bonesframing_1',
        type: 'bones:framing',
        parentId: 'level_0',
        studSpacingIn: 24,
        wallOverrides: { wall_cmu: 'cmu' },
      } as unknown as AnyNode,
      bones_panel: {
        id: 'bonesservice_panel_1',
        type: 'bones:service',
        parentId: 'level_0',
        serviceType: 'panel',
        wallId: 'wall_n',
        wallT: 0.72,
        heightAff: 1.55,
        position: [0, 0, 0],
      } as unknown as AnyNode,
      wall_n: { id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.12 } as unknown as AnyNode,
      wall_e: { id: 'wall_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.12 } as unknown as AnyNode,
      wall_cmu: { id: 'wall_cmu', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.2 } as unknown as AnyNode,
      wall_w: { id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.12 } as unknown as AnyNode,
      zone_living: {
        id: 'zone_living',
        type: 'zone',
        name: 'Living Room',
        parentId: 'level_0',
        polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      } as unknown as AnyNode,
    }

    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const ctx = extractBonesFramingContext(record, 'level_0')
    expect(ctx.present).toBe(true)
    expect(ctx.defaultSpacingIn).toBe(24)
    expect(ctx.servicePanel?.wallId).toBe('wall_n')

    // CMU override bypasses stud snapping cleanly
    const cmuSnap = snapWallOffsetToStud(6, 2.5, {
      spanMin: 0,
      spanMax: 6,
      rule: ctx.wallRules.get('wall_cmu')!,
    })
    expect(cmuSnap.snappedToStud).toBe(false)
    expect(cmuSnap.offsetM).toBe(2.5)

    // Auto-populate places MDP-1 near bones:service (wallT=0.72 -> ~4.32m on 6m wall_n, centered in a 24" OC bay)
    const out = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { levelId: 'level_0', occupancy: 'residential', protectionMode: 'hybrid' },
      { activeLevelId: 'level_0' },
    )
    const panel = out.changes?.create?.find(
      (c) => (c.node as unknown as { type?: string }).type === 'electrical:panel',
    )?.node as unknown as SceneNodeLike
    expect(panel).toBeDefined()
    const pPos = panel.position as [number, number, number]
    expect(pPos[0]).toBeGreaterThan(3.8)
    expect(pPos[0]).toBeLessThan(4.8)
    expect(pPos[1]).toBeCloseTo(1.55, 2)

    // Every wall_n receptacle sits flush against the side face of an exact 24" OC Bones stud (|uBox - uStud| ~= halfStud + halfBox + 2mm)
    const studs24 = computeWallStudPositions(6, 24)
    const expectedFaceDist = DRESSED_STUD_HALF_M + 0.058 / 2 + 0.002
    const northOutlets = (out.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .filter(
        (n) =>
          n.type === 'electrical:device' &&
          (n.deviceKind === 'duplex' || n.deviceKind === 'gfci') &&
          Array.isArray(n.position) &&
          Math.abs((n.position[2] as number) - 0.068) < 0.05,
      )
    expect(northOutlets.length).toBeGreaterThanOrEqual(2)
    for (const dev of northOutlets) {
      const u = (dev.position as [number, number, number])[0]
      const nearestDist = Math.min(...studs24.map((s) => Math.abs(u - s)))
      expect(Math.abs(nearestDist - expectedFaceDist)).toBeLessThan(0.004)
    }
  })

  test('IRC R314/R315 & NFPA 72: residential auto-populate wires interconnected Smoke/CO alarms (14/3) with pilot Hall/Living light on one non-GFCI 15A AFCI circuit', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { object: 'node', id: 'level_0', type: 'level', name: 'Ground Floor', parentId: null, visible: true, metadata: {}, level: 0, children: [] } as unknown as AnyNode,
      wall_n: { object: 'node', id: 'wall_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], thickness: 0.15, height: 2.6, children: [] } as unknown as AnyNode,
      wall_s: { object: 'node', id: 'wall_s', type: 'wall', parentId: 'level_0', start: [0, 6], end: [10, 6], thickness: 0.15, height: 2.6, children: [] } as unknown as AnyNode,
      wall_w: { object: 'node', id: 'wall_w', type: 'wall', parentId: 'level_0', start: [0, 0], end: [0, 6], thickness: 0.15, height: 2.6, children: [] } as unknown as AnyNode,
      wall_e: { object: 'node', id: 'wall_e', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 6], thickness: 0.15, height: 2.6, children: [] } as unknown as AnyNode,
      wall_mid: { object: 'node', id: 'wall_mid', type: 'wall', parentId: 'level_0', start: [5, 0], end: [5, 6], thickness: 0.12, height: 2.6, children: [] } as unknown as AnyNode,
      wall_bed: { object: 'node', id: 'wall_bed', type: 'wall', parentId: 'level_0', start: [5, 3], end: [10, 3], thickness: 0.12, height: 2.6, children: [] } as unknown as AnyNode,
      z_living: { object: 'node', id: 'z_living', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[0, 0], [5, 0], [5, 6], [0, 6]] } as unknown as AnyNode,
      z_bed1: { object: 'node', id: 'z_bed1', type: 'zone', parentId: 'level_0', name: 'Bedroom 1', category: 'bedroom', polygon: [[5, 0], [10, 0], [10, 3], [5, 3]] } as unknown as AnyNode,
      z_bed2: { object: 'node', id: 'z_bed2', type: 'zone', parentId: 'level_0', name: 'Bedroom 2', category: 'bedroom', polygon: [[5, 3], [10, 3], [10, 6], [5, 6]] } as unknown as AnyNode,
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      { levelId: 'level_0', occupancy: 'residential', protectionMode: 'hybrid', includeLighting: true, includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    for (const c of out.changes?.create ?? []) nodes[c.node.id] = c.node
    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const allDevs = Object.values(record).filter((n) => n.type === 'electrical:device')
    const allRuns = Object.values(record).filter((n) => n.type === 'electrical:conduit-run')
    const panel = Object.values(record).find((n) => n.type === 'electrical:panel')!

    // 3 interconnected hardwired Smoke/CO alarms: Bedroom 1, Bedroom 2, and Living Room (outside sleeping areas)
    const smokes = allDevs.filter((d) => d.deviceKind === 'smoke-co')
    expect(smokes.length).toBe(3)
    const smokeCkts = new Set(smokes.map((s) => Number(s.circuitNumber)))
    expect(smokeCkts.size).toBe(1)
    const smokeCkt = Array.from(smokeCkts)[0]!

    // Non-GFCI 15A AFCI circuit shared with the pilot Living Room ceiling light (NFPA 72 A.29.9.4 + 29.9.4(5))
    for (const s of smokes) {
      expect(s.gfciProtected).toBe(false)
      expect(s.afciProtected).toBe(true)
      expect(s.breakerAmps).toBe(15)
    }
    const cktPeers = allDevs.filter((d) => d.circuitNumber === smokeCkt)
    expect(cktPeers.some((d) => d.deviceKind === 'luminaire')).toBe(true)

    // Interconnect hops between smoke alarms use 14/3 (4 total conductors incl. red interconnect & ground)
    const smokeInterconnectRuns = allRuns.filter(
      (r) => r.circuitNumber === smokeCkt && Number(r.totalConductorCount) === 4,
    )
    expect(smokeInterconnectRuns.length).toBe(2)

    // Panel Schedule clearly labels the circuit as Smoke/CO Alarms & Lighting
    const schedule = buildPanelSchedule(panel, allDevs, allRuns)
    const smokeSlot = schedule.rows
      .flatMap((row) => [row.left, row.right])
      .find((entry) => entry && entry.circuitNumber === smokeCkt)
    expect(smokeSlot).toBeDefined()
    expect(smokeSlot!.description).toContain('Smoke/CO Alarms & Lighting')
    expect(smokeSlot!.protection).toContain('AFCI')
    expect(smokeSlot!.protection).not.toContain('GFCI')

    // Passes NEC + NFPA 72 / IRC R314 audit with 0 errors and 0 life-safety warnings!
    const audit = auditSceneElectrical(record)
    expect(audit.errorCount).toBe(0)
    expect(audit.findings.filter((f) => f.category === 'life-safety')).toHaveLength(0)
    expect(audit.findings.filter((f) => f.category === 'box-fill')).toHaveLength(0)

    // Adding another Smoke/CO alarm manually in another room interconnects onto the SAME smoke circuit with 14/3!
    const extraSmoke = electricalAgentOperations.electrical_place_device(
      nodes,
      { name: 'Bonus Smoke/CO', position: [2.5, 2.57, 4.5], deviceKind: 'smoke-co', panelId: panel.id, breakerAmps: 15, loadVa: 25 },
      { activeLevelId: 'level_0' },
    )
    expect(extraSmoke.result.circuitNumber).toBe(smokeCkt)
    const newRun = (extraSmoke.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .find((n) => n.type === 'electrical:conduit-run')!
    expect(newRun.totalConductorCount).toBe(4)
  })

  test('NFPA 72 & IRC R314 audit catches GFCI smoke alarm error, isolated smoke-only warning, split circuits, and missing bedroom alarms', () => {
    const badScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      z_bed1: { id: 'z_bed1', type: 'zone', parentId: 'level_0', name: 'Bedroom 1', category: 'bedroom', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      z_bed2: { id: 'z_bed2', type: 'zone', parentId: 'level_0', name: 'Bedroom 2', category: 'bedroom', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
      p1: { id: 'p1', type: 'electrical:panel', parentId: 'level_0', name: 'MDP-1', position: [0.1, 1.52, 2], occupancy: 'residential', voltageSystem: '120/240V-1P', busRatingAmps: 200, mainBreakerAmps: 200, spaces: 40 },
      s1: { id: 's1', type: 'electrical:device', parentId: 'level_0', name: 'Bed 1 Smoke', deviceKind: 'smoke-co', position: [2, 2.55, 2], panelId: 'p1', circuitNumber: 1, breakerAmps: 15, loadVa: 25, gfciProtected: true, afciProtected: true, boxType: '4-oct-2.125', wireGauge: '14', conductorCount: 3 },
      s2: { id: 's2', type: 'electrical:device', parentId: 'level_0', name: 'Bed 1 Extra Smoke', deviceKind: 'smoke-co', position: [3, 2.55, 2], panelId: 'p1', circuitNumber: 3, breakerAmps: 15, loadVa: 25, gfciProtected: false, afciProtected: true, boxType: '4-oct-2.125', wireGauge: '14', conductorCount: 3 },
    }
    const audit = auditSceneElectrical(badScene)
    expect(audit.findings.some((f) => f.codeRef === 'NFPA 72 29.9.4(5)' && f.severity === 'error')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'NFPA 72 A.29.9.4' && f.severity === 'warning')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IRC R314.4' && f.severity === 'warning')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IRC R314.3(1)' && f.title.includes('Bedroom 2'))).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IRC R314.3(2) / R315.3')).toBe(true)
  })
})
