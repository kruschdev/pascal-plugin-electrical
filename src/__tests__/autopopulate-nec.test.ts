import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import { buildWiredPanelInteriorCad } from '../cad/panel-interior'
import { auditSceneElectrical } from '../nec/audit'
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
    const wallDevices = devices.filter((d) => d.deviceKind !== 'luminaire')
    expect(wallDevices.length).toBeGreaterThanOrEqual(16)
    for (const dev of wallDevices) {
      const pos = dev.position as [number, number, number]
      expect(distToNearestWall(pos[0], pos[2])).toBeLessThanOrEqual(0.12)
    }

    // 2. Ceiling luminaires sit below levelHeight (2.5 m), never floating above the walls!
    const luminaires = devices.filter((d) => d.deviceKind === 'luminaire')
    expect(luminaires.length).toBeGreaterThanOrEqual(4)
    for (const lum of luminaires) {
      const pos = lum.position as [number, number, number]
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

    // 4. Full scene NEC audit passes cleanly with 0 errors and 0 warnings
    const audit = auditSceneElectrical(nodes as unknown as Readonly<Record<string, SceneNodeLike>>)
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })
})
