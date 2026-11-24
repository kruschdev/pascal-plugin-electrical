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
})
