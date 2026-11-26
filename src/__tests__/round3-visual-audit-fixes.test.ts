import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import { auditSceneElectrical } from '../nec/audit'
import { planNecAutoPopulate } from '../nec/autopopulate'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  extractRoutingWalls,
  isPointInsideWallFootprint,
  isSegmentInsideWallFootprint,
  routeElectricalRun,
  type RoutingWallSegment,
  type TradeObstacle,
  type Vec3,
} from '../nec/routing'

function distPointToWalls(px: number, pz: number, walls: readonly RoutingWallSegment[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const w of walls) {
    const vx = w.end[0] - w.start[0]
    const vz = w.end[1] - w.start[1]
    const lenSq = vx * vx + vz * vz
    const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((px - w.start[0]) * vx + (pz - w.start[1]) * vz) / lenSq)) : 0
    const cx = w.start[0] + vx * t
    const cz = w.start[1] + vz * t
    const distFromSurface = Math.max(0, Math.hypot(px - cx, pz - cz) - w.thickness / 2)
    if (distFromSurface < best) best = distFromSurface
  }
  return best
}

describe('Round 3 Visual Audit Fixes (VIS-V3-05)', () => {
  test('1. Detached yard / game-spawn zones (10m away) emit zero floating outdoor GFCIs and zero yard-crossing conduits, while attached patios mount flush on exterior walls', () => {
    const scene: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg_1', level: 0, height: 2.8 },
      // Building footprint: X in [-8..8], Z in [-5..3]
      w_n: { id: 'w_n', type: 'wall', parentId: 'l0', start: [-8, -5], end: [8, -5], height: 2.8, thickness: 0.2 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'l0', start: [8, -5], end: [8, 3], height: 2.8, thickness: 0.2 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'l0', start: [8, 3], end: [-8, 3], height: 2.8, thickness: 0.2 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'l0', start: [-8, 3], end: [-8, -5], height: 2.8, thickness: 0.2 },
      z_hall: {
        id: 'z_hall',
        type: 'zone',
        parentId: 'l0',
        name: 'Great Hall',
        category: 'living',
        polygon: [[-8, -5], [8, -5], [8, 3], [-8, 3]],
      },
      // Detached game-spawn & yard zones 10m out in front courtyard (Z = 11..15)
      z_spawn_a: {
        id: 'z_spawn_a',
        type: 'zone',
        parentId: 'l0',
        name: 'Spawn A',
        category: 'outdoor',
        polygon: [[-8, 11], [-4, 11], [-4, 15], [-8, 15]],
      },
      z_spawn_b: {
        id: 'z_spawn_b',
        type: 'zone',
        parentId: 'l0',
        name: 'Spawn B',
        category: 'yard',
        polygon: [[4, 11], [8, 11], [8, 15], [4, 15]],
      },
      z_front_yard: {
        id: 'z_front_yard',
        type: 'zone',
        parentId: 'l0',
        name: 'Front Courtyard',
        category: 'courtyard',
        polygon: [[-3, 10], [3, 10], [3, 16], [-3, 16]],
      },
      // Detached gazebo pad misnamed "Patio" 8m away from all building walls
      z_detached_patio: {
        id: 'z_detached_patio',
        type: 'zone',
        parentId: 'l0',
        name: 'Gazebo Patio',
        category: 'patio',
        polygon: [[-2, 11], [2, 11], [2, 14], [-2, 14]],
      },
      // Valid attached Rear Patio directly bordering the North exterior wall (Z = -5)
      z_attached_patio: {
        id: 'z_attached_patio',
        type: 'zone',
        parentId: 'l0',
        name: 'Rear Patio',
        category: 'patio',
        polygon: [[-3, -8], [3, -8], [3, -5], [-3, -5]],
      },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'l0', occupancy: 'commercial', includeWiring: true },
      { activeLevelId: 'l0' },
    )
    const created = (out.changes?.create ?? []).map((c) => c.node as SceneNodeLike)
    const merged: Record<string, SceneNodeLike> = { ...scene }
    for (const n of created) merged[n.id] = n

    const devices = created.filter((n) => n.type === 'electrical:device')
    const runs = created.filter((n) => n.type === 'electrical:conduit-run')
    const routingWalls = extractRoutingWalls(scene, 'l0')

    // Zero devices named for Spawn A / Spawn B / Front Courtyard / Gazebo Patio
    expect(devices.some((d) => /spawn|courtyard|gazebo/i.test(String(d.name ?? '')))).toBe(false)

    // Zero devices or conduit vertices straying out into the front yard (Z > 4.0)
    for (const dev of devices) {
      const pos = dev.position as Vec3
      expect(pos[2]).toBeLessThanOrEqual(3.25)
    }
    for (const run of runs) {
      const path = run.path as Vec3[]
      for (const pt of path) {
        expect(pt[2]).toBeLessThanOrEqual(3.25)
      }
    }

    // Valid attached Rear Patio WR GFCI IS emitted and mounted flush on an exterior building wall (distToWall <= 0.15m)
    const wrDevices = devices.filter((d) => d.deviceKind === 'weatherproof-gfci')
    expect(wrDevices.length).toBeGreaterThanOrEqual(1)
    expect(wrDevices.some((d) => String(d.name ?? '').includes('Rear Patio'))).toBe(true)
    for (const wr of wrDevices) {
      const pos = wr.position as Vec3
      expect(distPointToWalls(pos[0], pos[2], routingWalls)).toBeLessThanOrEqual(0.15)
    }

    const audit = auditSceneElectrical(merged)
    expect(audit.passed).toBe(true)
    expect(audit.errorCount).toBe(0)
  })

  test('2. Multi-story buildings restrict NEC 210.52(E)(1) grade-level WR GFCIs to the ground story (upper stories only get WR GFCI for attached balcony/deck)', () => {
    const multiStory: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg', level: 0, height: 2.8 },
      l1: { id: 'l1', type: 'level', parentId: 'bldg', level: 1, height: 2.8 },
      l2: { id: 'l2', type: 'level', parentId: 'bldg', level: 2, height: 2.8 },
      // Ground floor walls & room
      w0_1: { id: 'w0_1', type: 'wall', parentId: 'l0', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.16 },
      w0_2: { id: 'w0_2', type: 'wall', parentId: 'l0', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.16 },
      w0_3: { id: 'w0_3', type: 'wall', parentId: 'l0', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.16 },
      w0_4: { id: 'w0_4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.16 },
      z0_living: { id: 'z0_living', type: 'zone', parentId: 'l0', name: 'Living Room', category: 'living', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      // Floor 1 (upper story, NO balcony) with an exterior door opening onto parapet/void
      w1_1: { id: 'w1_1', type: 'wall', parentId: 'l1', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.16 },
      w1_2: { id: 'w1_2', type: 'wall', parentId: 'l1', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.16 },
      w1_3: { id: 'w1_3', type: 'wall', parentId: 'l1', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.16 },
      w1_4: { id: 'w1_4', type: 'wall', parentId: 'l1', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.16 },
      d1_ext: { id: 'd1_ext', type: 'door', parentId: 'w1_3', name: 'Upper Door', position: [4, 0, 0], width: 0.9 },
      z1_bed: { id: 'z1_bed', type: 'zone', parentId: 'l1', name: 'Upper Bedroom', category: 'bedroom', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      // Floor 2 (upper story WITH explicit attached balcony bordering East wall)
      w2_1: { id: 'w2_1', type: 'wall', parentId: 'l2', start: [0, 0], end: [8, 0], height: 2.8, thickness: 0.16 },
      w2_2: { id: 'w2_2', type: 'wall', parentId: 'l2', start: [8, 0], end: [8, 6], height: 2.8, thickness: 0.16 },
      w2_3: { id: 'w2_3', type: 'wall', parentId: 'l2', start: [8, 6], end: [0, 6], height: 2.8, thickness: 0.16 },
      w2_4: { id: 'w2_4', type: 'wall', parentId: 'l2', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.16 },
      z2_bed: { id: 'z2_bed', type: 'zone', parentId: 'l2', name: 'Penthouse Bedroom', category: 'bedroom', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      z2_balcony: { id: 'z2_balcony', type: 'zone', parentId: 'l2', name: 'East Balcony', category: 'balcony', polygon: [[8, 1], [10, 1], [10, 5], [8, 5]] },
    }

    const p0 = planNecAutoPopulate(multiStory, { levelId: 'l0', includeWiring: true })
    const p1 = planNecAutoPopulate(multiStory, { levelId: 'l1', includeWiring: true })
    const p2 = planNecAutoPopulate(multiStory, { levelId: 'l2', includeWiring: true })

    // Ground story (l0) DOES emit NEC 210.52(E)(1) grade-accessible Front Exterior WR GFCI
    const wr0 = p0.devices.filter((d) => d.deviceKind === 'weatherproof-gfci')
    expect(wr0.length).toBeGreaterThanOrEqual(1)
    expect(wr0.some((d) => d.necRef.includes('210.52(E)(1)'))).toBe(true)

    // Upper story without balcony (l1) emits ZERO Outdoor WR GFCIs (no NEC 210.52(E)(1) on upper floors!)
    const wr1 = p1.devices.filter((d) => d.deviceKind === 'weatherproof-gfci')
    expect(wr1).toHaveLength(0)

    // Upper story WITH attached balcony (l2) emits ONLY the NEC 210.52(E)(3) balcony WR GFCI flush on the East wall
    const wr2 = p2.devices.filter((d) => d.deviceKind === 'weatherproof-gfci')
    expect(wr2).toHaveLength(1)
    expect(wr2[0]!.name).toContain('East Balcony')
    expect(wr2[0]!.necRef).toContain('210.52(E)(3)')
    expect(distPointToWalls(wr2[0]!.position[0], wr2[0]!.position[2], extractRoutingWalls(multiStory, 'l2'))).toBeLessThanOrEqual(0.15)

    // Also verify 1-indexed multi-story building (Floor 1 = level 1, Floor 2 = level 2)
    const oneIndexed: Record<string, SceneNodeLike> = {
      b: { id: 'b', type: 'building' },
      f1: { id: 'f1', type: 'level', parentId: 'b', level: 1, height: 2.8 },
      f2: { id: 'f2', type: 'level', parentId: 'b', level: 2, height: 2.8 },
      wf1a: { id: 'wf1a', type: 'wall', parentId: 'f1', start: [0, 0], end: [6, 0], height: 2.8, thickness: 0.14 },
      wf1b: { id: 'wf1b', type: 'wall', parentId: 'f1', start: [6, 0], end: [6, 5], height: 2.8, thickness: 0.14 },
      wf1c: { id: 'wf1c', type: 'wall', parentId: 'f1', start: [6, 5], end: [0, 5], height: 2.8, thickness: 0.14 },
      wf1d: { id: 'wf1d', type: 'wall', parentId: 'f1', start: [0, 5], end: [0, 0], height: 2.8, thickness: 0.14 },
      zf1: { id: 'zf1', type: 'zone', parentId: 'f1', name: 'Main Room', category: 'living', polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] },
      wf2a: { id: 'wf2a', type: 'wall', parentId: 'f2', start: [0, 0], end: [6, 0], height: 2.8, thickness: 0.14 },
      wf2b: { id: 'wf2b', type: 'wall', parentId: 'f2', start: [6, 0], end: [6, 5], height: 2.8, thickness: 0.14 },
      wf2c: { id: 'wf2c', type: 'wall', parentId: 'f2', start: [6, 5], end: [0, 5], height: 2.8, thickness: 0.14 },
      wf2d: { id: 'wf2d', type: 'wall', parentId: 'f2', start: [0, 5], end: [0, 0], height: 2.8, thickness: 0.14 },
      zf2: { id: 'zf2', type: 'zone', parentId: 'f2', name: 'Second Floor', category: 'bedroom', polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] },
    }
    expect(planNecAutoPopulate(oneIndexed, { levelId: 'f1', includeWiring: false }).devices.some((d) => d.deviceKind === 'weatherproof-gfci')).toBe(true)
    expect(planNecAutoPopulate(oneIndexed, { levelId: 'f2', includeWiring: false }).devices.some((d) => d.deviceKind === 'weatherproof-gfci')).toBe(false)

    // Full multi-story autopopulate passes auditSceneElectrical with 0 errors
    let state: Record<string, SceneNodeLike> = { ...multiStory }
    for (const lid of ['l0', 'l1', 'l2']) {
      const res = electricalAgentOperations.electrical_autopopulate_nec(
        state as never,
        { levelId: lid, includeWiring: true },
        { activeLevelId: lid },
      )
      for (const c of res.changes?.create ?? []) {
        const node = c.node as SceneNodeLike
        state[node.id] = node
      }
    }
    const audit = auditSceneElectrical(state)
    expect(audit.passed).toBe(true)
    expect(audit.errorCount).toBe(0)
  })

  test('3. L-shaped concave buildings keep horizontal conduit runs strictly inside enclosed walls (never bulging outside Z=8.22 or cutting re-entrant corner)', () => {
    // L-shaped footprint:
    // West wing: X in [0..6], Z in [0..8]
    // East wing: X in [6..12], Z in [0..4]
    // Outdoor re-entrant notch: X in (6..12], Z in (4..8]
    const lWalls: RoutingWallSegment[] = [
      { id: 'w1', start: [0, 0], end: [12, 0], thickness: 0.16, height: 3.0 },
      { id: 'w2', start: [12, 0], end: [12, 4], thickness: 0.16, height: 3.0 },
      { id: 'w3', start: [12, 4], end: [6, 4], thickness: 0.16, height: 3.0 },
      { id: 'w4', start: [6, 4], end: [6, 8], thickness: 0.16, height: 3.0 },
      { id: 'w5', start: [6, 8], end: [0, 8], thickness: 0.16, height: 3.0 },
      { id: 'w6', start: [0, 8], end: [0, 0], thickness: 0.16, height: 3.0 },
    ]

    // Verify bounded concave footprint detection
    expect(isPointInsideWallFootprint(3, 6, lWalls)).toBe(true)
    expect(isPointInsideWallFootprint(9, 2, lWalls)).toBe(true)
    expect(isPointInsideWallFootprint(9, 6, lWalls)).toBe(false) // outdoor re-entrant notch
    expect(isPointInsideWallFootprint(3, 8.22, lWalls)).toBe(false) // +0.22m outside South wall

    // Case 3a: EMT run along Z = 8.0 wall dodging an HVAC duct right at Z = 7.95 (previously bulged outside to Z = 8.22!)
    const ductObs: TradeObstacle[] = [
      {
        id: 'duct_1:seg0',
        nodeId: 'duct_1',
        nodeType: 'hvac:duct-run',
        trade: 'hvac',
        priorityRank: 3,
        box: { min: [3.2, 2.35, 7.8], max: [3.8, 2.75, 8.02] },
        requiredClearanceM: 0.05,
        label: 'HVAC supply duct',
      },
    ]
    const southWallRun = routeElectricalRun([1.14, 1.5, 7.92], [5.85, 2.1, 7.92], ductObs, {
      walls: lWalls,
      racewayType: 'emt',
      preferredChaseY: 2.5,
      wallPlacement: 'in-wall',
    })
    expect(southWallRun.remainingClashes).toHaveLength(0)
    for (const pt of southWallRun.path) {
      expect(pt[2]).toBeLessThanOrEqual(8.08) // NEVER bulges out to Z = 8.22!
    }
    for (let i = 0; i < southWallRun.path.length - 1; i++) {
      expect(isSegmentInsideWallFootprint(southWallRun.path[i]!, southWallRun.path[i + 1]!, lWalls)).toBe(true)
    }

    // Case 3b: Cross-wing EMT run from bottom of West wing [2, 1.5, 7.5] to East wing [9.5, 1.5, 2.0]
    // Must pick the interior L-elbow [2, y, 2] instead of [9.5, y, 7.5] in the outdoor re-entrant notch!
    const crossWingEmt = routeElectricalRun([2.0, 1.5, 7.5], [9.5, 1.5, 2.0], [], {
      walls: lWalls,
      racewayType: 'emt',
      preferredChaseY: 2.5,
    })
    expect(crossWingEmt.remainingClashes).toHaveLength(0)
    for (let i = 0; i < crossWingEmt.path.length - 1; i++) {
      expect(isSegmentInsideWallFootprint(crossWingEmt.path[i]!, crossWingEmt.path[i + 1]!, lWalls)).toBe(true)
    }

    // Case 3c: Cross-wing NM-B with attic cavity must NOT cut diagonally through open air across the re-entrant notch
    const crossWingAttic = routeElectricalRun([2.0, 1.5, 7.5], [9.5, 1.5, 2.0], [], {
      walls: lWalls,
      racewayType: 'nm-b',
      preferredChaseY: 2.5,
      cavities: { hasAttic: true, atticY: 3.15, levelHeight: 3.0, sources: ['roof'] },
    })
    for (let i = 0; i < crossWingAttic.path.length - 1; i++) {
      expect(isSegmentInsideWallFootprint(crossWingAttic.path[i]!, crossWingAttic.path[i + 1]!, lWalls)).toBe(true)
    }
  })

  test('4. Dedicated outdoor HVAC condensers (including grounded upper-story condensers at y < 0) route strictly inside walls, exit straight through wall, and drop vertically hugging exterior wall face', () => {
    const castleUpper: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg', level: 0, height: 2.8 },
      l1: { id: 'l1', type: 'level', parentId: 'bldg', level: 1, height: 2.8 },
      // Ground floor walls so l1 is recognized as upper story
      w0_1: { id: 'w0_1', type: 'wall', parentId: 'l0', start: [0, 0], end: [10, 0], height: 2.8, thickness: 0.2 },
      w0_2: { id: 'w0_2', type: 'wall', parentId: 'l0', start: [10, 0], end: [10, 8], height: 2.8, thickness: 0.2 },
      w0_3: { id: 'w0_3', type: 'wall', parentId: 'l0', start: [10, 8], end: [0, 8], height: 2.8, thickness: 0.2 },
      w0_4: { id: 'w0_4', type: 'wall', parentId: 'l0', start: [0, 8], end: [0, 0], height: 2.8, thickness: 0.2 },
      // Upper floor (Floor 1) walls: X in [0..10], Z in [0..8]
      w1_1: { id: 'w1_1', type: 'wall', parentId: 'l1', start: [0, 0], end: [10, 0], height: 2.8, thickness: 0.2 },
      w1_2: { id: 'w1_2', type: 'wall', parentId: 'l1', start: [10, 0], end: [10, 8], height: 2.8, thickness: 0.2 },
      w1_3: { id: 'w1_3', type: 'wall', parentId: 'l1', start: [10, 8], end: [0, 8], height: 2.8, thickness: 0.2 },
      w1_4: { id: 'w1_4', type: 'wall', parentId: 'l1', start: [0, 8], end: [0, 0], height: 2.8, thickness: 0.2 },
      z1_main: {
        id: 'z1_main',
        type: 'zone',
        parentId: 'l1',
        name: 'Upper Hall',
        category: 'living',
        polygon: [[0, 0], [10, 0], [10, 8], [0, 8]],
      },
      // Grounded outdoor heat-pump condenser sitting on grade (y = -2.8m relative to Floor 1) outside East wall (x = 11.2)
      hp_grounded: {
        id: 'hp_grounded',
        type: 'hvac:equipment',
        parentId: 'l1',
        equipmentKind: 'heat-pump-condenser',
        name: 'Upper Zone Heat Pump Condenser',
        position: [11.2, -2.8, 4.0],
        coolingTons: 3,
      },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      castleUpper as never,
      { levelId: 'l1', includeWiring: true },
      { activeLevelId: 'l1' },
    )
    const created = (out.changes?.create ?? []).map((c) => c.node as SceneNodeLike)
    const merged: Record<string, SceneNodeLike> = { ...castleUpper }
    for (const n of created) merged[n.id] = n

    const hpDev = created.find(
      (n) =>
        n.type === 'electrical:device' &&
        (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'hp_grounded',
    )
    expect(hpDev).toBeDefined()
    expect(hpDev!.deviceKind).toBe('dedicated-240v')
    const devPos = hpDev!.position as Vec3
    // Disconnect mounted at condenserY + 0.9m = -2.8 + 0.9 = -1.9m, flush on East exterior wall (x ~ 10.108)
    expect(devPos[1]).toBeCloseTo(-1.9, 2)
    expect(devPos[0]).toBeGreaterThan(10.0)
    expect(devPos[0]).toBeLessThanOrEqual(10.2)

    const hpRun = created.find(
      (n) => n.type === 'electrical:conduit-run' && n.targetDeviceId === hpDev!.id,
    )
    expect(hpRun).toBeDefined()
    const path = hpRun!.path as Vec3[]
    expect(path.length).toBeGreaterThanOrEqual(4)
    // Uses armored flexible MC cable (not indoor dry NM-B and not rigid PVC-40) for residential exterior drop
    // below floor level so wet crawlspace rules and multi-room NEC 358.26 >360° bend caps both stay clean.
    expect(hpRun!.racewayType).toBe('mc')

    // Every horizontal segment strictly > 0.25m must stay INSIDE the building wall envelope (x <= 10.15)
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!
      const b = path[i + 1]!
      const horizLen = Math.hypot(b[0] - a[0], b[2] - a[2])
      if (horizLen > 0.25) {
        expect(a[0]).toBeLessThanOrEqual(10.15)
        expect(b[0]).toBeLessThanOrEqual(10.15)
        expect(a[1]).toBeGreaterThanOrEqual(0)
        expect(b[1]).toBeGreaterThanOrEqual(0)
      }
      // No diagonal or parallel-outside-wall runs: any segment extending past x > 10.02 is either
      // a straight perpendicular penetration through the East wall (dy=0, dz=0, ending flush at x<=10.2)
      // or a strictly vertical drop hugging the exterior wall face (dx=0, dz=0).
      if (a[0] > 10.02 || b[0] > 10.02) {
        const dx = Math.abs(b[0] - a[0])
        const dy = Math.abs(b[1] - a[1])
        const dz = Math.abs(b[2] - a[2])
        const isVerticalDrop = dx < 0.02 && dz < 0.02 && dy > 0.05
        const isPerpWallExit = dy < 0.02 && dz < 0.02 && Math.max(a[0], b[0]) <= 10.2
        expect(isVerticalDrop || isPerpWallExit).toBe(true)
      }
    }

    // Verify vertical drop hugs exterior wall face cleanly down to -1.9m
    const lastPt = path[path.length - 1]!
    expect(lastPt[1]).toBeCloseTo(-1.9, 2)
    expect(lastPt[0]).toBeLessThanOrEqual(10.2)

    const audit = auditSceneElectrical(merged)
    expect(audit.passed).toBe(true)
    expect(audit.errorCount).toBe(0)

    // Direct routeElectricalRun test: indoor panel -> detached outdoor condenser pad [11.5, -1.9, 4.0]
    const upperWalls = extractRoutingWalls(castleUpper, 'l1')
    const directCond = routeElectricalRun([1.0, 1.52, 0.1], [11.5, -1.9, 4.0], [], {
      walls: upperWalls,
      racewayType: 'emt',
      preferredChaseY: 2.55,
      cavities: { hasAttic: true, atticY: 2.95, levelHeight: 2.8, sources: ['roof'] },
    })
    expect(directCond.remainingClashes).toHaveLength(0)
    expect(directCond.exceedsMaxBends).toBe(false)
    // No overhead aerial run outside the East wall (x > 10.2 must only occur at low condenser disconnect height y <= -1.8)
    for (const pt of directCond.path) {
      if (pt[0] > 10.2) {
        expect(pt[1]).toBeCloseTo(-1.9, 2)
      }
    }
  })

  test('5. Open-sided room ceiling lights never pierce structural LVL window headers, and commercial EMT grounded condensers stay <= 360° with 0 clashes around headers/ducts', () => {
    // Closed main house [0..8] x [0..4.5] + open-sided Lanai zone [0..5] x [4.5..7.5] (no outer south wall)
    const walls: RoutingWallSegment[] = [
      { id: 'w1', start: [0, 0], end: [8, 0], thickness: 0.16, height: 2.8 },
      { id: 'w2', start: [8, 0], end: [8, 4.5], thickness: 0.16, height: 2.8 },
      { id: 'w3', start: [8, 4.5], end: [0, 4.5], thickness: 0.16, height: 2.8 },
      { id: 'w4', start: [0, 4.5], end: [0, 0], thickness: 0.16, height: 2.8 },
    ]
    const interiorPolygons: Array<Array<[number, number]>> = [
      [[0, 0], [8, 0], [8, 4.5], [0, 4.5]],
      [[0, 4.5], [5, 4.5], [5, 7.5], [0, 7.5]], // open-sided Lanai room
    ]
    // Structural LVL window header spanning X in [1.0..4.5] along wall Z = 4.5 at Y in [2.15..2.50]
    const lvlHeader: TradeObstacle = {
      id: 'strbm_hdr:seg0',
      nodeId: 'strbm_hdr',
      nodeType: 'structural:beam',
      trade: 'structural',
      priorityRank: 1,
      box: { min: [1.0, 2.15, 4.42], max: [4.5, 2.50, 4.58] },
      requiredClearanceM: 0.05,
      label: 'structural beam (2) 1-3/4"x11-7/8" 2.0E LVL',
    }

    // 5a: Lanai Wall Switch -> Lanai Ceiling Light must recognize Lanai as interior AND dodge the LVL window header with 0 clashes!
    expect(isPointInsideWallFootprint(2.7, 5.6, walls, interiorPolygons)).toBe(true)
    const lanaiRun = routeElectricalRun([4.8, 1.22, 4.43], [2.7, 2.61, 5.6], [lvlHeader], {
      walls,
      racewayType: 'nm-b',
      preferredChaseY: 2.55,
      interiorPolygons,
    })
    expect(lanaiRun.remainingClashes).toHaveLength(0)

    // 5b: Commercial EMT grounded condenser behind East wall WITH an HVAC duct blocking the direct wall penetration
    // must shift clear of the duct AND stay <= 360° total bends (NEC 358.26) with 0 clashes!
    const hvacDuct: TradeObstacle = {
      id: 'duct_block:seg0',
      nodeId: 'duct_block',
      nodeType: 'hvac:duct-run',
      trade: 'hvac',
      priorityRank: 3,
      box: { min: [7.6, 2.2, 2.1], max: [8.05, 2.65, 2.9] },
      requiredClearanceM: 0.05,
      label: 'HVAC trunk blocking East wall penetration',
    }
    const commCond = routeElectricalRun([1.0, 1.52, 0.08], [8.11, -1.9, 2.5], [hvacDuct], {
      walls,
      racewayType: 'emt',
      preferredChaseY: 2.55,
      interiorPolygons,
    })
    expect(commCond.remainingClashes).toHaveLength(0)
    expect(commCond.exceedsMaxBends).toBe(false)
    expect(commCond.totalBendDegrees).toBeLessThanOrEqual(360)
  })

  test('6. Wall-snapping and dedicated MEP equipment placement never intrude on adjacent water heaters or opposite-wall interior air handlers', () => {
    // 6a: Utility wall with Water Heater right next to wall Z=4.0 and an Air Handler adjacent across the wall/bay
    // Mirrors real-world residential mechanical alcove where a water heater sits flush against the wall behind an air handler
    const utilScene: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg', level: 0, height: 2.8 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'l0', start: [-4, 0], end: [4, 0], height: 2.8, thickness: 0.16 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'l0', start: [4, 0], end: [4, 6], height: 2.8, thickness: 0.16 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'l0', start: [4, 6], end: [-4, 6], height: 2.8, thickness: 0.16 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'l0', start: [-4, 6], end: [-4, 0], height: 2.8, thickness: 0.16 },
      w_mid: { id: 'w_mid', type: 'wall', parentId: 'l0', start: [-4, 4], end: [1, 4], height: 2.8, thickness: 0.16 },
      z_util: {
        id: 'z_util',
        type: 'zone',
        parentId: 'l0',
        name: 'Utility Room',
        category: 'utility',
        polygon: [[-4, 0], [4, 0], [4, 6], [-4, 6]],
      },
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        parentId: 'l0',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Electric Water Heater (40 gal)',
        position: [-1.0, 0, 3.65],
        dimensions: [0.6, 1.5, 0.6],
      },
      ahu_1: {
        id: 'ahu_1',
        type: 'hvac:equipment',
        parentId: 'l0',
        equipmentKind: 'air-handler',
        name: 'Air Handler (20 kW Aux Heat)',
        position: [-1.0, 0, 4.7],
        dimensions: [0.56, 1.25, 0.56],
        auxHeatKw: 20,
      },
    }

    const utilOut = electricalAgentOperations.electrical_autopopulate_nec(
      utilScene as never,
      { levelId: 'l0', includeWiring: true },
      { activeLevelId: 'l0' },
    )
    const utilMerged: Record<string, SceneNodeLike> = { ...utilScene }
    for (const c of utilOut.changes?.create ?? []) {
      const n = c.node as SceneNodeLike
      utilMerged[n.id] = n
    }
    const utilAudit = auditSceneElectrical(utilMerged)
    expect(utilAudit.errorCount).toBe(0)
    expect(utilAudit.passed).toBe(true)

    // 6b: Outdoor Heat Pump Condenser outside West exterior wall (X = -1.0) directly opposite an interior Air Handler
    // whose clearance envelope reaches the wall centerline X = -1.0
    const oppositeScene: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg', level: 0, height: 2.8 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'l0', start: [-1, 0], end: [5, 0], height: 2.8, thickness: 0.14 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'l0', start: [5, 0], end: [5, 5], height: 2.8, thickness: 0.14 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'l0', start: [5, 5], end: [-1, 5], height: 2.8, thickness: 0.14 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'l0', start: [-1, 5], end: [-1, 0], height: 2.8, thickness: 0.14 },
      ahu_int: {
        id: 'ahu_int',
        type: 'hvac:equipment',
        parentId: 'l0',
        equipmentKind: 'air-handler',
        name: 'Electric Air Handler w/ A-Coil (1.5-Ton)',
        position: [-0.58, 0, 2.3],
        dimensions: [0.56, 1.25, 0.56],
      },
      hp_ext: {
        id: 'hp_ext',
        type: 'hvac:equipment',
        parentId: 'l0',
        equipmentKind: 'heat-pump-condenser',
        name: '1.5-Ton Heat Pump Condenser',
        position: [-2.1, 0, 2.3],
        coolingTons: 1.5,
      },
    }

    const oppOut = electricalAgentOperations.electrical_autopopulate_nec(
      oppositeScene as never,
      { levelId: 'l0', includeWiring: true },
      { activeLevelId: 'l0' },
    )
    const oppMerged: Record<string, SceneNodeLike> = { ...oppositeScene }
    for (const c of oppOut.changes?.create ?? []) {
      const n = c.node as SceneNodeLike
      oppMerged[n.id] = n
    }
    const oppAudit = auditSceneElectrical(oppMerged)
    expect(oppAudit.errorCount).toBe(0)
    expect(oppAudit.passed).toBe(true)

    // 6c: Direct routeElectricalRun safety net — an obstacle-free endpoint 0.28m from a wall must NOT
    // snap onto the wall centerline if that snapped anchor falls inside an adjacent equipment clearance box
    const walls6c: RoutingWallSegment[] = [
      { id: 'w1', start: [-4, 0], end: [4, 0], thickness: 0.16, height: 2.8 },
      { id: 'w2', start: [4, 0], end: [4, 6], thickness: 0.16, height: 2.8 },
      { id: 'w3', start: [4, 6], end: [-4, 6], thickness: 0.16, height: 2.8 },
      { id: 'w4', start: [-4, 6], end: [-4, 0], thickness: 0.16, height: 2.8 },
      { id: 'w_mid', start: [-4, 4], end: [1, 4], thickness: 0.16, height: 2.8 },
    ]
    const whObs: TradeObstacle = {
      id: 'wh_1:body',
      nodeId: 'wh_1',
      nodeType: 'plumbing:equipment',
      trade: 'plumbing',
      priorityRank: 2,
      box: { min: [-1.3, 0, 3.35], max: [-0.7, 1.55, 3.95] },
      requiredClearanceM: 0.05,
      label: 'plumbing equipment (Electric Water Heater (40 gal))',
    }
    const directRes = routeElectricalRun([3.9, 1.52, 2.0], [-1.02, 1.5, 4.28], [whObs], {
      walls: walls6c,
      racewayType: 'nm-b',
      preferredChaseY: 2.55,
    })
    expect(directRes.remainingClashes).toHaveLength(0)
  })
})
