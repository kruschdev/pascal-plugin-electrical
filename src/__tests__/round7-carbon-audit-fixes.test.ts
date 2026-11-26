import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electricalAgentOperations } from '../agent-operations'
import { electricalAgentTools } from '../agent-tools'
import { ELECTRICAL_SCHEDULE_VIEW_ID as INDEX_VIEW_ID } from '../index'
import { auditSceneElectrical } from '../nec/audit'
import { calculateSceneLoad, type SceneNodeLike } from '../nec/load-calc'
import {
  countPathBendDegrees,
  getHvacEquipmentBox,
  routeElectricalRun,
} from '../nec/routing'
import { isZeroYokeDeviceKind } from '../nec/tables'
import { ELECTRICAL_SCHEDULE_VIEW_ID as RENDER_VIEW_ID } from '../render'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

describe('Round 7 Gemini 4 Carbon Audit Regression Suite (R7-BUG-01..06, R7-OPT-01..02, R7-CON-01..04)', () => {
  test('R7-BUG-01 & R7-CON-01: Next.js RSC client boundaries, zero static ./ui imports in src/index.ts, and version parity', () => {
    const uiFiles = [
      'src/ui/electrical-panel.tsx',
      'src/ui/inspector-card.tsx',
      'src/ui/schedule-view.tsx',
      'src/ui/panel-interior-view.tsx',
      'src/ui/chat-card.tsx',
    ]
    for (const rel of uiFiles) {
      const text = fs.readFileSync(path.join(rootDir, rel), 'utf8')
      expect(text.trimStart().startsWith("'use client'")).toBe(true)
    }

    const indexSrc = fs.readFileSync(path.join(rootDir, 'src/index.ts'), 'utf8')
    expect(/^\s*(?:import|export)\s+[^;\n]*['"]\.\/ui\//m.test(indexSrc)).toBe(false)
    expect(INDEX_VIEW_ID).toBe(RENDER_VIEW_ID)
    expect(RENDER_VIEW_ID).toBe('krusch:electrical:schedule')

    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    expect(electricalAgentTools.version).toBe(pkg.version)
  })

  test('R7-BUG-02: clearExisting on a specific level preserves root/unparented transformers and panels referenced by other levels', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_1: { id: 'level_1', type: 'level', height: 2.7 },
      level_2: { id: 'level_2', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_2', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_2', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_2', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_2', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.7 },
      z2: { id: 'z2', type: 'zone', parentId: 'level_2', name: 'Office', category: 'office', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
      // Site-level root transformer (parentId: null) — must NOT be wiped when clearing level_2
      root_tx: { id: 'root_tx', type: 'electrical:transformer', parentId: null, name: 'Site TX', position: [10, 0, 10] },
      // Panel on level_2 that is still referenced by a device on level_1 — must NOT be deleted
      shared_panel: { id: 'shared_panel', type: 'electrical:panel', parentId: 'level_2', name: 'MDP-Shared', position: [1, 1.52, 0.08], rotation: 0 },
      l1_dev: { id: 'l1_dev', type: 'electrical:device', parentId: 'level_1', panelId: 'shared_panel', deviceKind: 'duplex', position: [2, 0.38, 0.08] },
      // Stale level_2 device — SHOULD be cleared
      l2_stale_dev: { id: 'l2_stale_dev', type: 'electrical:device', parentId: 'level_2', panelId: 'shared_panel', deviceKind: 'duplex', position: [3, 0.38, 0.08] },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_2', clearExisting: true, includeWiring: false },
      { activeLevelId: 'level_2' },
    )
    const deleted = new Set(out.changes?.delete ?? [])
    expect(deleted.has('l2_stale_dev')).toBe(true)
    expect(deleted.has('root_tx')).toBe(false)
    expect(deleted.has('shared_panel')).toBe(false)
    expect(deleted.has('l1_dev')).toBe(false)
  })

  test('R7-BUG-03: RTU disconnect offset clears 1.55m x 1.05m footprint + clearance, run metadata persists VIS-02 stagger, and electrical_route_circuit excludes selfMepIds', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 3.2 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], thickness: 0.16, height: 3.2 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], thickness: 0.16, height: 3.2 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], thickness: 0.16, height: 3.2 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], thickness: 0.16, height: 3.2 },
      z_mech: { id: 'z_mech', type: 'zone', parentId: 'level_0', name: 'Mechanical', category: 'utility', polygon: [[0, 0], [12, 0], [12, 8], [0, 8]] },
      // Wide RTU rotated 90 deg so its 1.55m width (half = 0.775m) faces along +Z/+X
      rtu_1: {
        id: 'rtu_1',
        type: 'hvac:equipment',
        equipmentKind: 'rooftop-package-unit',
        parentId: 'level_0',
        name: 'RTU-1',
        position: [6, 0, 4],
        rotation: Math.PI / 2,
      },
    }

    const auto = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', occupancy: 'commercial', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...scene }
    for (const c of auto.changes?.create ?? []) merged[c.node.id] = c.node as unknown as SceneNodeLike

    const rtuDev = Object.values(merged).find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'rtu_1',
    )!
    expect(rtuDev).toBeDefined()
    const rtuBox = getHvacEquipmentBox(scene.rtu_1!)!
    const [dx, , dz] = rtuDev.position as [number, number, number]
    const insideRtuWithClearance =
      dx >= rtuBox.min[0] - 0.15 &&
      dx <= rtuBox.max[0] + 0.15 &&
      dz >= rtuBox.min[2] - 0.15 &&
      dz <= rtuBox.max[2] + 0.15
    expect(insideRtuWithClearance).toBe(false)

    // Persisted VIS-02 stagger metadata on created runs
    const createdRuns = Object.values(merged).filter((n) => n.type === 'electrical:conduit-run')
    expect(createdRuns.length).toBeGreaterThan(0)
    for (const run of createdRuns) {
      const meta = run.metadata as { preferredChaseY?: number; laneOffsetLateralM?: number } | undefined
      expect(typeof meta?.preferredChaseY).toBe('number')
      expect(typeof meta?.laneOffsetLateralM).toBe('number')
    }

    // electrical_route_circuit to RTU disconnect excludes rtu_1 self-clash
    const panel = Object.values(merged).find((n) => n.type === 'electrical:panel')!
    const rerouted = electricalAgentOperations.electrical_route_circuit(
      merged as never,
      { panelId: panel.id, targetDeviceId: rtuDev.id, occupancy: 'commercial' },
      { activeLevelId: 'level_0' },
    )
    expect(rerouted.result.remainingClashes).toHaveLength(0)
  })

  test('R7-BUG-04: wallSeparatesPoints2D does not mask NEC 406.9(C) across open doorways or slightly recessed host-wall outlets', () => {
    // Wall along x=3.0 with an open doorway from z=1.5 to z=2.5
    const doorwayScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w_bath: { id: 'w_bath', type: 'wall', parentId: 'level_0', start: [3.0, 0], end: [3.0, 5.0], thickness: 0.14, height: 2.7 },
      d_bath: { id: 'd_bath', type: 'door', parentId: 'w_bath', position: [2.0, 0, 0], width: 1.0 },
      shower_1: { id: 'shower_1', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'shower', position: [3.4, 0.05, 2.0] },
      // Hallway outlet 0.65m from shower center straight through the open doorway (z=2.0) -> MUST flag NEC 406.9(C)
      hall_doorway_outlet: {
        id: 'hall_doorway_outlet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Hallway Doorway Outlet',
        deviceKind: 'gfci',
        position: [2.75, 0.38, 2.0],
        gfciProtected: true,
      },
      // In-bathroom outlet slightly recessed 2cm past wall centerline (x=2.98, solid wall at z=4.0) next to tub at [3.4, 0.05, 4.0] -> MUST flag NEC 406.9(C)
      tub_2: { id: 'tub_2', type: 'plumbing:fixture', parentId: 'level_0', fixtureKind: 'bathtub', position: [3.4, 0.05, 4.0] },
      recessed_bath_outlet: {
        id: 'recessed_bath_outlet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Recessed Bath Outlet',
        deviceKind: 'gfci',
        position: [2.98, 1.12, 4.0],
        gfciProtected: true,
      },
      // True opposite-face dry-room outlet (x=2.92 = 8cm past centerline on solid wall at z=4.0) -> MUST be exempt
      dry_room_outlet: {
        id: 'dry_room_outlet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Dry Room Outlet',
        deviceKind: 'duplex',
        position: [2.92, 0.38, 4.0],
      },
    }

    const rep = auditSceneElectrical(doorwayScene)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('hall_doorway_outlet'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('recessed_bath_outlet'))).toBe(true)
    expect(rep.findings.some((f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('dry_room_outlet'))).toBe(false)
  })

  test('R7-BUG-05: Commercial calculateSceneLoad applies NEC 220.60 non-coincident HVAC omission for hvac-heating and hvac-cooling/heat-pump loads', () => {
    const commHvacScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      p1: { id: 'p1', type: 'electrical:panel', occupancy: 'commercial', voltageSystem: '120/208V-3P' },
      ahu_heat: {
        id: 'ahu_heat',
        type: 'electrical:device',
        deviceKind: 'dedicated-240v',
        name: 'AHU Electric Heat',
        loadVa: 12000,
        isMotor: false,
        continuous: true,
        metadata: { mepSourceNodeId: 'ahu_1', loadCategory: 'hvac-heating' },
      },
      ac_cool: {
        id: 'ac_cool',
        type: 'electrical:device',
        deviceKind: 'motor-load',
        name: 'AC Condenser',
        loadVa: 8000,
        isMotor: true,
        metadata: { mepSourceNodeId: 'ac_1', loadCategory: 'hvac-cooling' },
      },
    }

    const res = calculateSceneLoad(commHvacScene, { occupancy: 'commercial', fallbackSquareFootage: 1000 })
    expect(res.occupancy).toBe('commercial')
    if (res.occupancy === 'commercial') {
      expect(res.hvacDemandVa).toBe(12000)
      expect(res.hvacOmitVa).toBe(8000)
      expect(res.motorTotalVa).toBe(0)
      expect(res.dedicatedTotalVa).toBe(0)
    }
  })

  test('R7-BUG-06: lateral lane stagger never introduces extra diagonal bends on small vertical steps', () => {
    const base = routeElectricalRun([0, 2.4, 0], [3, 2.435, 3], [], {
      preferredChaseY: 2.435,
      racewayType: 'emt',
    })
    const staggered = routeElectricalRun([0, 2.4, 0], [3, 2.435, 3], [], {
      preferredChaseY: 2.435,
      racewayType: 'emt',
      laneOffsetLateralM: 0.014,
    })
    const baseBends = countPathBendDegrees(base.path).totalBendDegrees
    const stagBends = countPathBendDegrees(staggered.path).totalBendDegrees
    expect(stagBends).toBeLessThanOrEqual(baseBends + 2)
  })

  test('R7-CON-02 & R7-CON-04: shared isZeroYokeDeviceKind includes under-cabinet-led and getHvacEquipmentBox honors explicit dimensions', () => {
    expect(isZeroYokeDeviceKind('under-cabinet-led')).toBe(true)
    expect(isZeroYokeDeviceKind('duplex')).toBe(false)

    const customHvac: SceneNodeLike = {
      id: 'hvac_custom',
      type: 'hvac:equipment',
      equipmentKind: 'air-handler',
      position: [2, 0, 2],
      dimensions: [2.0, 1.5, 1.2],
      rotation: 0,
    }
    const box = getHvacEquipmentBox(customHvac)!
    expect(box.max[0] - box.min[0]).toBeCloseTo(2.0, 3)
    expect(box.max[1] - box.min[1]).toBeCloseTo(1.5, 3)
    expect(box.max[2] - box.min[2]).toBeCloseTo(1.2, 3)
  })

  test('R8-BUG-01, R8-CON-01 & R8-CON-02: atticY/crawlSpaceY/wallPlacement/preferredChaseY persist on autopopulate, place_device, and route_circuit runs', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      roof_0: { id: 'roof_0', type: 'roof', parentId: 'level_0', position: [3, 2.7, 2] },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], thickness: 0.14, height: 2.7 },
      z_liv: { id: 'z_liv', type: 'zone', parentId: 'level_0', name: 'Living Room', category: 'living', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
    }
    const auto = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...scene }
    for (const c of auto.changes?.create ?? []) merged[c.node.id] = c.node as unknown as SceneNodeLike

    const autoRuns = Object.values(merged).filter((n) => n.type === 'electrical:conduit-run')
    expect(autoRuns.length).toBeGreaterThan(0)
    for (const r of autoRuns) {
      const m = r.metadata as Record<string, unknown> | undefined
      expect(typeof m?.atticY).toBe('number')
      expect(typeof m?.crawlSpaceY).toBe('number')
      expect(m?.wallPlacement).toBe('in-wall')
    }

    const panel = Object.values(merged).find((n) => n.type === 'electrical:panel')!
    const dev = Object.values(merged).find((n) => n.type === 'electrical:device')!
    const routed = electricalAgentOperations.electrical_route_circuit(
      merged as never,
      { panelId: panel.id, targetDeviceId: dev.id, preferredChaseY: 2.2, wallPlacement: 'surface' },
      { activeLevelId: 'level_0' },
    )
    const routedMeta = (routed.changes?.create?.[0]?.node as { metadata?: Record<string, unknown> } | undefined)?.metadata
    expect(routedMeta?.preferredChaseY).toBe(2.2)
    expect(routedMeta?.wallPlacement).toBe('surface')
    expect(typeof routedMeta?.atticY).toBe('number')

    const placed = electricalAgentOperations.electrical_place_device(
      merged as never,
      { levelId: 'level_0', name: 'Extra Duplex', position: [3, 0.38, 0.08], deviceKind: 'duplex', panelId: panel.id, autoWire: true },
      { activeLevelId: 'level_0' },
    )
    const placedRun = placed.changes?.create?.find(
      (c) => (c.node as { type?: string }).type === 'electrical:conduit-run',
    )?.node as { metadata?: Record<string, unknown> } | undefined
    expect(typeof placedRun?.metadata?.preferredChaseY).toBe('number')
    expect(placedRun?.metadata?.wallPlacement).toBe('in-wall')
  })
})
