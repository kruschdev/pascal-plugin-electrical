import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import { auditSceneElectrical } from '../nec/audit'
import { planNecAutoPopulate } from '../nec/autopopulate'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  type TradeObstacle,
  computeRoofEnvelopeFromWalls,
  extractRoutingCavities,
  extractRoutingWalls,
  resolveLevelHeightM,
  roofYAt,
  routeElectricalRun,
} from '../nec/routing'

describe('Round 2 Corpus Audit Fixes (R2-ELC-01, R2-ELC-02, R2-CON-03)', () => {
  test('R2-ELC-01: explicit flat roof-segment on unwalled upper level forces NM-B below roofYAt & aligns resolveLevelHeightM', () => {
    const flatRoofScene: Record<string, SceneNodeLike> = {
      bldg_a: { id: 'bldg_a', type: 'building' },
      bldg_b: { id: 'bldg_b', type: 'building' },
      // Level height says 2.4m, but walls specify 2.8m -> resolveLevelHeightM prefers maxWallH (2.8m)
      l0: { id: 'l0', type: 'level', parentId: 'bldg_a', level: 0, height: 2.4 },
      l_roof: { id: 'l_roof', type: 'level', parentId: 'bldg_a', level: 1, name: 'Roof' },
      // Unrelated building B roof should not leak into building A
      l_b0: { id: 'l_b0', type: 'level', parentId: 'bldg_b', level: 0 },
      l_b_roof: { id: 'l_b_roof', type: 'level', parentId: 'bldg_b', level: 1 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [10, 0], height: 2.8, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [10, 0], end: [10, 6], height: 2.8, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [10, 6], end: [0, 6], height: 2.8, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.8, thickness: 0.14 },
      roof_a: { id: 'roof_a', type: 'roof', parentId: 'l_roof', position: [5, 0, 3], rotation: 0 },
      seg_flat: {
        id: 'seg_flat',
        type: 'roof-segment',
        parentId: 'roof_a',
        position: [0, 0, 0],
        rotation: 0,
        width: 10,
        depth: 6,
        roofType: 'flat',
        pitch: 0,
        overhang: 0.35,
      },
      // Building B has a pitched roof; must not affect Building A
      seg_b: {
        id: 'seg_b',
        type: 'roof-segment',
        parentId: 'l_b_roof',
        position: [5, 0, 3],
        width: 10,
        depth: 6,
        roofType: 'gable',
        pitch: 35,
      },
    }

    // 1. resolveLevelHeightM alignment with Structural audit.ts
    expect(resolveLevelHeightM(flatRoofScene, 'l0')).toBe(2.8)
    expect(
      resolveLevelHeightM({
        lvl: { id: 'lvl', type: 'level', height: 2.6 },
        w: { id: 'w', type: 'wall', parentId: 'lvl', start: [0, 0], end: [4, 0] },
      }, 'lvl'),
    ).toBe(2.6)
    expect(
      resolveLevelHeightM({
        lvl: { id: 'lvl', type: 'level' },
        w: { id: 'w', type: 'wall', parentId: 'lvl', start: [0, 0], end: [4, 0] },
      }, 'lvl'),
    ).toBe(2.7)

    // 2. Explicit flat roof-segment extracted from unwalled upper level in same building
    const walls = extractRoutingWalls(flatRoofScene, 'l0')
    const cavities = extractRoutingCavities(flatRoofScene, 'l0')
    expect(cavities.explicitRoofSegs?.length).toBe(1)

    const roofEnv = computeRoofEnvelopeFromWalls(walls, 2.8, 6, flatRoofScene, 'l0')!
    expect(roofEnv.explicitSegs?.length).toBe(1)
    // Flat roof clamps roofYAt to wallH (2.8m) even at the center where fallback gable would be 4.3m
    expect(roofYAt(5, 3, roofEnv)).toBeCloseTo(2.8, 3)

    // 3. Cross-building NM-B run must NOT climb above roofYAt (2.8m) into non-existent attic space
    const run = routeElectricalRun([2.0, 0.38, 0.07], [8.0, 0.38, 5.93], [], {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(run.routingMode).toBe('wall-manhattan')
    const maxY = Math.max(...run.path.map((p) => p[1]))
    expect(maxY).toBeLessThanOrEqual(2.8 - 0.06 + 1e-3)
  })

  test('R2-ELC-01: shed and narrow rotated roof-segments keep every sampled NM-B point strictly beneath roofYAt - roofMarginM', () => {
    // Starter House-style shed roof (rotated parent roof + narrow low-slope side wing segment)
    const shedScene: Record<string, SceneNodeLike> = {
      bldg: { id: 'bldg', type: 'building' },
      l0: { id: 'l0', type: 'level', parentId: 'bldg', level: 0 },
      l_roof: { id: 'l_roof', type: 'level', parentId: 'bldg', level: 1 },
      w1: { id: 'w1', type: 'wall', parentId: 'l0', start: [0, 0], end: [10, 0], height: 2.5, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'l0', start: [10, 0], end: [10, 6], height: 2.5, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'l0', start: [10, 6], end: [0, 6], height: 2.5, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'l0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.14 },
      roof_wrap: { id: 'roof_wrap', type: 'roof', parentId: 'l_roof', position: [5, 0, 3], rotation: 0 },
      // Shed roof sloping down toward +Z (low eave at z=6 -> 2.5m, high side at z=0)
      seg_shed: {
        id: 'seg_shed',
        type: 'roof-segment',
        parentId: 'roof_wrap',
        position: [0, 0, 0],
        rotation: 0,
        width: 10,
        depth: 6,
        roofType: 'shed',
        pitch: 12,
        overhang: 0.35,
      },
    }

    const walls = extractRoutingWalls(shedScene, 'l0')
    const cavities = extractRoutingCavities(shedScene, 'l0')
    const roofEnv = computeRoofEnvelopeFromWalls(walls, 2.5, 6, shedScene, 'l0')!
    expect(roofYAt(5, 5.9, roofEnv)).toBeLessThan(2.58)
    expect(roofYAt(5, 2.0, roofEnv)).toBeGreaterThan(3.0)

    const atticDuct: TradeObstacle = {
      id: 'duct_1',
      nodeId: 'duct_1',
      nodeType: 'hvac:duct-run',
      trade: 'hvac',
      priorityRank: 3,
      box: { min: [0.5, 2.56, 2.6], max: [9.5, 2.86, 3.0] },
      requiredClearanceM: 0.05,
      label: 'Attic Trunk',
    }

    const run = routeElectricalRun([1.5, 0.38, 0.07], [8.5, 0.38, 5.93], [atticDuct], {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
    })
    expect(run.remainingClashes).toHaveLength(0)

    const roofMarginM = 0.015 + 0.065
    for (let i = 0; i < run.path.length - 1; i++) {
      const a = run.path[i]!
      const b = run.path[i + 1]!
      for (let s = 0; s <= 12; s++) {
        const f = s / 12
        const px = a[0] + (b[0] - a[0]) * f
        const py = a[1] + (b[1] - a[1]) * f
        const pz = a[2] + (b[2] - a[2]) * f
        if (py > 2.5 - 0.04) {
          expect(py).toBeLessThanOrEqual(roofYAt(px, pz, roofEnv) - roofMarginM + 0.002)
        }
      }
    }
  })

  test('R2-ELC-02: exterior Front Door WR GFCI & Exterior Light separated by perimeter wall from interior shower pass NEC 406.9(C) & 410.10(D)', () => {
    const scene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.7 },
      // Exterior south wall at z=0 with Front Door opening at x in [1.5, 2.5]
      w_south: { id: 'w_south', type: 'wall', parentId: 'l0', start: [0, 0], end: [6, 0], height: 2.7, thickness: 0.2 },
      w_east: { id: 'w_east', type: 'wall', parentId: 'l0', start: [6, 0], end: [6, 5], height: 2.7, thickness: 0.2 },
      w_north: { id: 'w_north', type: 'wall', parentId: 'l0', start: [6, 5], end: [0, 5], height: 2.7, thickness: 0.2 },
      w_west: { id: 'w_west', type: 'wall', parentId: 'l0', start: [0, 5], end: [0, 0], height: 2.7, thickness: 0.2 },
      d_front: { id: 'd_front', type: 'door', parentId: 'w_south', name: 'Front Door', position: [2.0, 0, 0], width: 1.0 },
      z_bath: {
        id: 'z_bath',
        type: 'zone',
        parentId: 'l0',
        name: 'Bathroom',
        category: 'bathroom',
        polygon: [[0, 0], [3.5, 0], [3.5, 3.0], [0, 3.0]],
      },
      // Interior Squared Shower directly behind the exterior front wall near the doorway
      shower_1: {
        id: 'shower_1',
        type: 'item',
        parentId: 'l0',
        name: 'Squared Shower',
        position: [1.5, 0, 0.55],
        dimensions: [0.95, 2.05, 0.95],
      },
      panel_1: {
        id: 'panel_1',
        type: 'electrical:panel',
        parentId: 'l0',
        name: 'MDP-1',
        position: [5.8, 1.52, 2.5],
        rotation: -Math.PI / 2,
      },
      // Exterior Front Door WR GFCI facing outward (-Z, rotation = Math.PI) on exterior face (z = -0.12)
      ext_wr_gfci: {
        id: 'ext_wr_gfci',
        type: 'electrical:device',
        parentId: 'l0',
        name: 'Front Door Outdoor WR GFCI',
        deviceKind: 'weatherproof-gfci',
        position: [1.2, 0.45, -0.12],
        rotation: Math.PI,
        gfciProtected: true,
        metadata: { isExterior: true },
        panelId: 'panel_1',
        circuitNumber: 1,
        breakerAmps: 20,
        wireGauge: '12',
        boxType: 'single-gang-deep',
        conductorCount: 2,
      },
      // Exterior Front Door Light facing outward (-Z) on exterior face (z = -0.16), diagonally near door opening
      ext_light: {
        id: 'ext_light',
        type: 'electrical:device',
        parentId: 'l0',
        name: 'Front Door Exterior Light',
        deviceKind: 'luminaire',
        position: [2.15, 1.92, -0.16],
        rotation: Math.PI,
        metadata: { isExterior: true },
        panelId: 'panel_1',
        circuitNumber: 3,
        breakerAmps: 15,
        wireGauge: '14',
        boxType: '4-oct-2.125',
        conductorCount: 2,
      },
    }

    const report = auditSceneElectrical(scene)
    const showerFindings = report.findings.filter(
      (f) => f.codeRef === 'NEC 406.9(C)' || f.codeRef === 'NEC 410.10(D)',
    )
    expect(showerFindings).toHaveLength(0)

    // Negative control: an interior receptacle inside the bathroom within 3 ft of the shower MUST still fail NEC 406.9(C)
    const withBadInteriorOutlet: Record<string, SceneNodeLike> = {
      ...scene,
      bad_bath_outlet: {
        id: 'bad_bath_outlet',
        type: 'electrical:device',
        parentId: 'l0',
        name: 'Bad Interior Bath Outlet',
        deviceKind: 'gfci',
        position: [1.5, 1.12, 0.14],
        rotation: 0,
        gfciProtected: true,
        panelId: 'panel_1',
        circuitNumber: 5,
        breakerAmps: 20,
        wireGauge: '12',
        boxType: 'single-gang-deep',
        conductorCount: 2,
      },
    }
    const badReport = auditSceneElectrical(withBadInteriorOutlet)
    expect(
      badReport.findings.some(
        (f) => f.codeRef === 'NEC 406.9(C)' && f.nodeIds.includes('bad_bath_outlet'),
      ),
    ).toBe(true)
  })

  test('R2-ELC-02: dense furniture room with unzoned corridor / opposite interior wall face avoids NEC 110.26(A) working-space clash for MDP-1', () => {
    // Living room zone is packed with furniture along every interior wall face, while an unzoned
    // interior hallway on the opposite side of the partition wall has a clear 30"W x 36"D working space.
    const denseScene: Record<string, SceneNodeLike> = {
      l0: { id: 'l0', type: 'level', height: 2.7 },
      // Outer shell (8m x 5m)
      w_n: { id: 'w_n', type: 'wall', parentId: 'l0', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.14 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'l0', start: [8, 0], end: [8, 5], height: 2.7, thickness: 0.14 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'l0', start: [8, 5], end: [0, 5], height: 2.7, thickness: 0.14 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'l0', start: [0, 5], end: [0, 0], height: 2.7, thickness: 0.14 },
      // Interior partition at x=5.5 dividing zoned Living Room [0..5.5] from unzoned interior corridor [5.5..8]
      w_part: { id: 'w_part', type: 'wall', parentId: 'l0', start: [5.5, 0], end: [5.5, 5], height: 2.7, thickness: 0.14 },
      z_living: {
        id: 'z_living',
        type: 'zone',
        parentId: 'l0',
        name: 'Living Room',
        category: 'living',
        polygon: [[0, 0], [5.5, 0], [5.5, 5], [0, 5]],
      },
      // Pack every wall inside Living Room with furniture + plumbing equipment
      sofa_n: { id: 'sofa_n', type: 'item', parentId: 'l0', name: 'Sofa N', position: [2.75, 0, 0.6], dimensions: [5.2, 0.9, 1.0] },
      sofa_s: { id: 'sofa_s', type: 'item', parentId: 'l0', name: 'Sofa S', position: [2.75, 0, 4.4], dimensions: [5.2, 0.9, 1.0] },
      desk_w: { id: 'desk_w', type: 'item', parentId: 'l0', name: 'Desk W', position: [0.6, 0, 2.5], dimensions: [1.0, 0.8, 4.6] },
      wh_part: {
        id: 'wh_part',
        type: 'plumbing:equipment',
        parentId: 'l0',
        name: 'Cabinet Bank',
        position: [4.9, 0, 2.5],
        width: 1.0,
        depth: 4.6,
        height: 1.6,
      },
      // Also block east wall of the unzoned corridor so only the east face of w_part is clear
      shelf_e: { id: 'shelf_e', type: 'item', parentId: 'l0', name: 'Storage Wall', position: [7.4, 0, 2.5], dimensions: [1.0, 1.8, 4.8] },
    }

    const plan = planNecAutoPopulate(denseScene, { levelId: 'l0', includeLighting: false, includeSmokeAlarms: false })
    expect(plan.createdPanel).not.toBeNull()

    const applied = electricalAgentOperations.electrical_autopopulate_nec(
      denseScene as never,
      { includeLighting: false, includeSmokeAlarms: false },
      { activeLevelId: 'l0' },
    )
    const merged: Record<string, SceneNodeLike> = { ...denseScene }
    for (const c of applied.changes?.create ?? []) {
      merged[c.node.id] = c.node as unknown as SceneNodeLike
    }

    const report = auditSceneElectrical(merged)
    const wsFindings = report.findings.filter(
      (f) => f.codeRef === 'NEC 110.26(A)' || f.codeRef === 'NEC 110.26(E)',
    )
    expect(wsFindings).toHaveLength(0)
  })
})
