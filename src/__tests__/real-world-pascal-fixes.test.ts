import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import { auditSceneElectrical, extractWetFixtures, isNonFixtureItem } from '../nec/audit'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  extractRoutingCavities,
  extractRoutingWalls,
  extractTradeObstacles,
  routeElectricalRun,
} from '../nec/routing'

function applyChanges(
  nodes: Record<string, SceneNodeLike>,
  outcome: ReturnType<typeof electricalAgentOperations.electrical_autopopulate_nec>,
): Record<string, SceneNodeLike> {
  const next: Record<string, SceneNodeLike> = { ...nodes }
  for (const id of outcome.changes?.delete ?? []) delete next[id]
  for (const item of outcome.changes?.create ?? []) {
    const n = item.node as unknown as SceneNodeLike
    next[n.id] = n
  }
  for (const u of outcome.changes?.update ?? []) {
    const existing = next[u.id]
    if (existing) next[u.id] = { ...existing, ...(u.data as Partial<SceneNodeLike>) } as SceneNodeLike
  }
  return next
}

describe('Real-World 50-House Pascal Electrical Audit Regressions (REAL-ELC-01..04)', () => {
  test('REAL-ELC-01: Shower Rug, Rectangular Carpet (woven), and shower curtain are excluded from fixture matchers; hardwired MEP drops exempt from NEC 406.9(C) while real receptacles remain audited', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Level 1', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], height: 2.6, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 4], height: 2.6, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 4], end: [0, 4], height: 2.6, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 4], end: [0, 0], height: 2.6, thickness: 0.14 },
      z_room: {
        id: 'z_room',
        type: 'zone',
        parentId: 'level_0',
        name: 'Bathroom',
        category: 'bathroom',
        polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      },
      // False-positive decor items observed in real Pascal public houses
      rug_1: {
        id: 'rug_1',
        type: 'item',
        parentId: 'level_0',
        name: 'Shower Rug',
        position: [1.0, 0, 0.4],
        asset: { id: 'shower-rug', name: 'Shower Rug', tags: ['rug', 'mat', 'bathmat'] },
      },
      carpet_1: {
        id: 'carpet_1',
        type: 'item',
        parentId: 'level_0',
        name: 'Rectangular Carpet',
        position: [2.5, 0, 0.4],
        asset: { id: 'rectangular-carpet', name: 'Rectangular Carpet', tags: ['carpet', 'rug', 'woven'] },
      },
      curtain_1: {
        id: 'curtain_1',
        type: 'item',
        parentId: 'level_0',
        name: 'Wall-to-wall shower curtain',
        position: [3.6, 0, 0.4],
        asset: { id: 'curtain-1', name: 'Wall-to-wall shower curtain' },
      },
      // Real plumbing tub/shower fixture at far end
      real_tub: {
        id: 'real_tub',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        name: 'Bathtub',
        fixtureKind: 'tub-shower-combo',
        position: [5.2, 0.15, 3.4],
      },
      // Hardwired MEP equipment nodes
      ahu_1: {
        id: 'ahu_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        equipmentKind: 'air-handler',
        name: 'Air Handler',
        position: [4.8, 0, 2.5],
      },
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        parentId: 'level_0',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Electric Water Heater',
        position: [4.8, 0, 2.8],
      },
      hood_1: {
        id: 'hood_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        equipmentKind: 'range-hood',
        name: 'Kitchen Range Exhaust Hood',
        position: [5.0, 1.5, 3.0],
      },
      p1: {
        id: 'p1',
        type: 'electrical:panel',
        parentId: 'level_0',
        name: 'MDP-1',
        position: [0.08, 1.52, 2.0],
        rotation: Math.PI / 2,
      },
      // Outlets right beside Shower Rug, Rectangular Carpet, & Shower Curtain -> MUST NOT trigger 406.9(C) or 210.52(C)
      outlet_by_rug: {
        id: 'outlet_by_rug',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Outlet By Rug',
        deviceKind: 'gfci',
        gfciProtected: true,
        position: [1.0, 0.38, 0.12],
        panelId: 'p1',
        circuitNumber: 1,
      },
      outlet_by_carpet: {
        id: 'outlet_by_carpet',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Outlet By Carpet',
        deviceKind: 'gfci',
        gfciProtected: true,
        position: [2.5, 1.1, 0.35],
        panelId: 'p1',
        circuitNumber: 1,
      },
      // Hardwired MEP power drops near real_tub -> MUST NOT be flagged as receptacles under NEC 406.9(C)
      ahu_pwr: {
        id: 'ahu_pwr',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Air Handler (5 kW Aux Heat) Power',
        deviceKind: 'dedicated-240v',
        poles: 2,
        breakerAmps: 40,
        position: [4.8, 1.5, 2.8],
        panelId: 'p1',
        circuitNumber: 3,
        metadata: { mepSourceNodeId: 'ahu_1', mepHardwired: true },
      },
      wh_pwr: {
        id: 'wh_pwr',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Electric Water Heater (4.5 kW) Power',
        deviceKind: 'dedicated-240v',
        poles: 2,
        breakerAmps: 30,
        position: [4.9, 0.9, 2.9],
        panelId: 'p1',
        circuitNumber: 7,
        metadata: { mepSourceNodeId: 'wh_1', mepHardwired: true },
      },
      hood_pwr: {
        id: 'hood_pwr',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Kitchen Range Exhaust Hood Power',
        deviceKind: 'duplex',
        poles: 1,
        breakerAmps: 15,
        position: [5.0, 1.5, 3.0],
        panelId: 'p1',
        circuitNumber: 2,
        metadata: { mepSourceNodeId: 'hood_1', mepHardwired: true },
      },
      // Real cord-connected GFCI receptacle within 3 ft of real_tub -> MUST STILL BE FLAGGED under NEC 406.9(C)!
      bad_recept_by_tub: {
        id: 'bad_recept_by_tub',
        type: 'electrical:device',
        parentId: 'level_0',
        name: 'Illegal Tub Receptacle',
        deviceKind: 'gfci',
        gfciProtected: true,
        position: [4.9, 1.12, 2.85],
        panelId: 'p1',
        circuitNumber: 1,
      },
    }

    expect(isNonFixtureItem(scene.rug_1!)).toBe(true)
    expect(isNonFixtureItem(scene.carpet_1!)).toBe(true)
    expect(isNonFixtureItem(scene.curtain_1!)).toBe(true)
    expect(isNonFixtureItem(scene.real_tub!)).toBe(false)

    const wetFixtures = extractWetFixtures(scene, 'level_0')
    expect(wetFixtures.map((f) => f.node.id)).toEqual(['real_tub'])

    const report = auditSceneElectrical(scene)
    const f4069 = report.findings.filter((f) => f.codeRef === 'NEC 406.9(C)')
    const fStove = report.findings.filter((f) => f.codeRef === 'NEC 210.52(C) / 110.11')

    expect(fStove).toHaveLength(0)
    expect(f4069).toHaveLength(1)
    expect(f4069[0]!.nodeIds).toContain('bad_recept_by_tub')
    expect(f4069.some((f) => f.nodeIds.includes('ahu_pwr'))).toBe(false)
    expect(f4069.some((f) => f.nodeIds.includes('wh_pwr'))).toBe(false)
    expect(f4069.some((f) => f.nodeIds.includes('hood_pwr'))).toBe(false)
    expect(f4069.some((f) => f.nodeIds.includes('outlet_by_rug'))).toBe(false)
  })

  test('REAL-ELC-02: French room names (Salle de Bains, Cuisine, Chambre, Séjour) + Dishwasher Power clear of Kitchen Sink + Entry Switch/Receptacle clear of tub', () => {
    let nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Rez-de-chaussée', height: 2.6 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.6, thickness: 0.14 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 6], height: 2.6, thickness: 0.14 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [10, 6], end: [0, 6], height: 2.6, thickness: 0.14 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.6, thickness: 0.14 },
      w_mid1: { id: 'w_mid1', type: 'wall', parentId: 'level_0', start: [3.2, 0], end: [3.2, 6], height: 2.6, thickness: 0.14 },
      w_mid2: { id: 'w_mid2', type: 'wall', parentId: 'level_0', start: [6.8, 0], end: [6.8, 6], height: 2.6, thickness: 0.14 },
      z_sdb: {
        id: 'z_sdb',
        type: 'zone',
        parentId: 'level_0',
        name: 'Salle de Bains',
        polygon: [[0, 0], [3.2, 0], [3.2, 6], [0, 6]],
      },
      z_cuisine: {
        id: 'z_cuisine',
        type: 'zone',
        parentId: 'level_0',
        name: 'Cuisine',
        polygon: [[3.2, 0], [6.8, 0], [6.8, 6], [3.2, 6]],
      },
      z_chambre: {
        id: 'z_chambre',
        type: 'zone',
        parentId: 'level_0',
        name: 'Chambre 1',
        polygon: [[6.8, 0], [10, 0], [10, 6], [6.8, 6]],
      },
      // Bathtub & Vanity Sink inside French bathroom
      sdb_tub: {
        id: 'sdb_tub',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        name: 'Bathtub',
        fixtureKind: 'bathtub',
        position: [0.85, 0.15, 0.55],
      },
      sdb_vanity: {
        id: 'sdb_vanity',
        type: 'item',
        parentId: 'level_0',
        name: 'Single Vanity',
        position: [0.45, 0, 3.0],
        dimensions: [0.8, 0.85, 0.55],
        asset: { id: 'single-vanity', name: 'Single Vanity', tags: ['sink', 'basin', 'vanity'] },
      },
      // Kitchen Sink & adjacent Dishwasher where naive +0.36m offset would land straight inside Kitchen Sink!
      kitchen_sink: {
        id: 'kitchen_sink',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        name: 'Kitchen Sink',
        fixtureKind: 'kitchen-sink',
        position: [5.0, 0.46, 0.35],
        rotation: 0,
      },
      dishwasher_1: {
        id: 'dishwasher_1',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        name: 'Dishwasher',
        fixtureKind: 'dishwasher',
        position: [4.62, 0.4, 0.35],
        rotation: 0,
        electricalDemand: {
          required: true,
          voltage: 120,
          poles: 1,
          breakerAmps: 20,
          loadVa: 1200,
          dedicatedCircuit: true,
          gfciRequired: true,
          afciRequired: true,
          label: 'Dishwasher (NEC 210.8(D) GFCI)',
        },
      },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      nodes as never,
      { levelId: 'level_0', occupancy: 'residential', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    nodes = applyChanges(nodes, out)

    const devs = Object.values(nodes).filter((n) => n.type === 'electrical:device')
    // French bathroom gets dedicated Vanity GFCI (not general 6ft/12ft outlets!)
    expect(devs.some((d) => String(d.name).includes('Salle de Bains Vanity GFCI'))).toBe(true)
    expect(devs.some((d) => /^Salle de Bains Outlet/.test(String(d.name)))).toBe(false)
    // French kitchen gets Kitchen SAB GFCI outlets
    expect(devs.some((d) => String(d.name).includes('Cuisine GFCI'))).toBe(true)
    // French bedroom gets a Smoke/CO alarm (IRC R314.3(1))
    expect(devs.some((d) => d.deviceKind === 'smoke-co' && String(d.name).includes('Chambre 1'))).toBe(true)
    // Dishwasher Power must exist and NOT sit inside Kitchen Sink!
    const dwDev = devs.find(
      (d) => (d.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'dishwasher_1',
    )
    expect(dwDev).toBeDefined()

    const report = auditSceneElectrical(nodes)
    const wetErrors = report.findings.filter(
      (f) =>
        f.severity === 'error' &&
        (f.codeRef === 'NEC 406.9(C)' || f.codeRef === 'NEC 406.5(E)' || f.codeRef === 'NEC 404.4(C)'),
    )
    expect(wetErrors).toHaveLength(0)
  })

  test('REAL-ELC-03: Panel placement avoids item furniture (110.26(A)) and overhead plumbing/HVAC runs (110.26(E)) even in zero-zone (Z=0) buildings', () => {
    let nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'IT Room', height: 2.8 },
      // Zero zones — reproduces IT Room / Office / My Home / Warner 2 real Pascal scenes!
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], height: 2.8, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 5], height: 2.8, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 5], end: [0, 5], height: 2.8, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 5], end: [0, 0], height: 2.8, thickness: 0.14 },
      // Obstruct w1 completely with desks & a plumbing stack directly overhead
      desk_1: {
        id: 'desk_1',
        type: 'item',
        parentId: 'level_0',
        name: 'Office Desk 1',
        position: [1.5, 0, 0.5],
        dimensions: [2.4, 0.8, 0.9],
      },
      desk_2: {
        id: 'desk_2',
        type: 'item',
        parentId: 'level_0',
        name: 'Office Desk 2',
        position: [4.5, 0, 0.5],
        dimensions: [2.4, 0.8, 0.9],
      },
      dwv_over_w1: {
        id: 'dwv_over_w1',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        name: '3" Main DWV Stack',
        diameter: 3,
        path: [[0.5, 2.4, 0.14], [5.5, 2.4, 0.14]],
      },
      // Obstruct w2 with an overhead HVAC return air trunk
      duct_over_w2: {
        id: 'duct_over_w2',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: 'Return Air Trunk',
        shape: 'rectangular',
        width: 18,
        height: 10,
        path: [[5.86, 2.5, 0.2], [5.86, 2.5, 4.8]],
      },
    }

    const out = electricalAgentOperations.electrical_autopopulate_nec(
      nodes as never,
      { levelId: 'level_0', occupancy: 'commercial', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    nodes = applyChanges(nodes, out)

    const panel = Object.values(nodes).find((n) => n.type === 'electrical:panel')
    expect(panel).toBeDefined()

    const report = auditSceneElectrical(nodes)
    const clearanceErrors = report.findings.filter(
      (f) => f.severity === 'error' && (f.codeRef === 'NEC 110.26(A)' || f.codeRef === 'NEC 110.26(E)'),
    )
    expect(clearanceErrors).toHaveLength(0)
  })

  test('REAL-ELC-04: NM-B hops cleanly over tall attic rectangular HVAC trunk and detours around mechanical equipment & terminals with 0 clashes', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Main Floor', height: 2.6 },
      roof_1: { id: 'roof_1', type: 'roof', parentId: 'level_0', name: 'Gable Roof' },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.6, thickness: 0.14 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.6, thickness: 0.14 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.6, thickness: 0.14 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.6, thickness: 0.14 },
      // Large 24"x12" rectangular HVAC main supply trunk running right through base atticY (2.72 m)!
      attic_trunk: {
        id: 'attic_trunk',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: '24"x12" Main Supply Trunk',
        shape: 'rectangular',
        width: 24,
        height: 12,
        path: [[0.5, 2.8, 3.0], [7.5, 2.8, 3.0]],
      },
      // Mechanical equipment sitting near wall w4
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        parentId: 'level_0',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Electric Water Heater (75 gal)',
        position: [0.38, 0, 3.0],
      },
      // Return air grille sitting in ceiling corridor
      ret_grille: {
        id: 'ret_grille',
        type: 'hvac:terminal',
        parentId: 'level_0',
        name: 'Central Return Air Grille',
        terminalKind: 'return-grille',
        neckSizeIn: 14,
        position: [4.0, 2.52, 0.25],
      },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    const obstacles = extractTradeObstacles(scene, 'level_0')
    const cavities = extractRoutingCavities(scene, 'level_0')
    expect(cavities.hasAttic).toBe(true)

    // 1. Cross-house NM-B run crossing directly over the tall attic rectangular trunk -> hops cleanly over with 0 clashes
    const atticHop = routeElectricalRun([2.0, 0.38, 0.08], [6.0, 0.38, 5.92], obstacles, {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
      preferredChaseY: 2.52,
    })
    expect(atticHop.remainingClashes).toHaveLength(0)
    expect(atticHop.routingMode).toBe('attic-euclidean')
    // Path must climb above the trunk top (~2.95 m + clearance)
    expect(Math.max(...atticHop.path.map((p) => p[1]))).toBeGreaterThan(3.0)

    // 2. Wall-only run along w1 past Central Return Air Grille -> detours cleanly with 0 clashes
    const terminalDetour = routeElectricalRun([1.5, 1.22, 0.08], [6.5, 1.22, 0.08], obstacles, {
      walls,
      racewayType: 'nm-b',
      routingStrategy: 'wall-only',
      preferredChaseY: 2.52,
    })
    expect(terminalDetour.remainingClashes).toHaveLength(0)

    // 3. Same-wall run along w4 past Water Heater -> hops cleanly with 0 clashes
    const equipDetour = routeElectricalRun([0.08, 0.38, 1.0], [0.08, 0.38, 5.0], obstacles, {
      walls,
      cavities,
      racewayType: 'nm-b',
      routingStrategy: 'auto',
      preferredChaseY: 2.52,
    })
    expect(equipDetour.remainingClashes).toHaveLength(0)
  })
})
