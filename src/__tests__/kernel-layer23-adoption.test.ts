import { describe, expect, test } from 'bun:test'
import {
  type PlacementCandidate,
  effectivePlacementThreshold,
  evaluatePlacementCandidate,
  validateRuleTable,
} from '@kruschdev/pascal-mep-kernel'
import {
  NEC_DECLARATIVE_RULES,
  NEC_RULE_THRESHOLDS,
  auditSceneElectrical,
  countPathBendDegrees,
  detectRunTradeClashes,
  extractRoutingCavities,
  extractRoutingWalls,
  extractTradeObstacles,
  getNecRuleById,
  planNecAutoPopulate,
  routeElectricalRun,
  routeElectricalViaLegalCavity,
} from '../nec'
import type { SceneNodeLike } from '../nec/load-calc'

describe('Kernel Layer 2 & Layer 3 Adoption (Legal-Space-First Cavity Router + Single-Source Declarative NEC Rules)', () => {
  test('Layer 3: validateRuleTable(NEC_DECLARATIVE_RULES) passes with all 13 canonical NEC rules and exact thresholds', () => {
    const validation = validateRuleTable(NEC_DECLARATIVE_RULES)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)

    const requiredRuleIds = [
      'nec-110-26a-working-space',
      'nec-110-26e-dedicated-space',
      'nec-240-24a-handle-height',
      'nec-240-24de-prohibited-panel-zone',
      'nec-406-9c-tub-receptacle',
      'nec-404-4c-tub-switch',
      'nec-410-10d-tub-luminaire',
      'nec-210-52c-stove-receptacle',
      'nec-406-5e-sink-receptacle',
      'nec-410-16c-closet-luminaire',
      'nec-210-52a2-opening-keepout',
      'nec-358-26-raceway-bends',
      'nec-334-12-nmb-policy',
    ] as const

    for (const id of requiredRuleIds) {
      const rule = getNecRuleById(id)
      expect(rule).toBeDefined()
      expect(rule?.trade).toBe('electrical')
      if (rule?.placementMarginM !== undefined) {
        expect(rule.placementMarginM).toBeGreaterThanOrEqual(0)
      }
    }

    // Verify coupled audit vs placement thresholds derived via effectivePlacementThreshold
    expect(NEC_RULE_THRESHOLDS.workingSpace.widthM).toBeCloseTo(0.762, 4)
    expect(NEC_RULE_THRESHOLDS.workingSpace.depthM).toBeCloseTo(0.9144, 4)
    expect(NEC_RULE_THRESHOLDS.workingSpace.heightM).toBeCloseTo(1.9812, 4)
    expect(NEC_RULE_THRESHOLDS.dedicatedOverheadHeightM).toBe(1.829)
    expect(NEC_RULE_THRESHOLDS.panelMaxHandleHeightM).toBe(2.007)

    expect(NEC_RULE_THRESHOLDS.tubReceptacle.auditMinHorizontalM).toBe(0.914)
    expect(NEC_RULE_THRESHOLDS.tubReceptacle.placementMinHorizontalM).toBe(0.925)
    expect(NEC_RULE_THRESHOLDS.tubReceptacle.auditMaxVerticalM).toBe(2.438)

    expect(NEC_RULE_THRESHOLDS.tubSwitch.auditMinHorizontalM).toBe(0.15)
    expect(NEC_RULE_THRESHOLDS.tubSwitch.placementMinHorizontalM).toBe(0.25)

    expect(NEC_RULE_THRESHOLDS.tubLuminaire.auditMinHorizontalM).toBe(0.914)
    expect(NEC_RULE_THRESHOLDS.tubLuminaire.placementMinHorizontalM).toBe(0.925)
    expect(NEC_RULE_THRESHOLDS.tubLuminaire.auditMaxVerticalM).toBe(2.438)

    expect(NEC_RULE_THRESHOLDS.stoveReceptacle.auditMinHorizontalM).toBe(0.08)
    expect(NEC_RULE_THRESHOLDS.stoveReceptacle.placementMinHorizontalM).toBe(0.15)
    expect(NEC_RULE_THRESHOLDS.stoveReceptacle.auditVerticalBandM).toEqual([0.75, 1.65])
    expect(NEC_RULE_THRESHOLDS.stoveReceptacle.placementVerticalBandM[0]).toBeLessThanOrEqual(0.75)
    expect(NEC_RULE_THRESHOLDS.stoveReceptacle.placementVerticalBandM[1]).toBeGreaterThanOrEqual(1.65)

    expect(NEC_RULE_THRESHOLDS.sinkReceptacle.auditMinHorizontalM).toBe(0.0)
    expect(NEC_RULE_THRESHOLDS.sinkReceptacle.placementMinHorizontalM).toBe(0.25)
    expect(NEC_RULE_THRESHOLDS.sinkReceptacle.auditMaxVerticalM).toBe(1.05)

    expect(NEC_RULE_THRESHOLDS.closetLuminaireMinYM).toBe(2.1)
    expect(NEC_RULE_THRESHOLDS.openingKeepout.blockDoors).toBe(true)
    expect(NEC_RULE_THRESHOLDS.openingKeepout.floorToCeilingSillThresholdM).toBe(0.52)
    expect(NEC_RULE_THRESHOLDS.openingKeepout.trimClearanceM).toBe(0.14)
    expect(NEC_RULE_THRESHOLDS.racewayMaxBendDegrees).toBe(360)
    expect(NEC_RULE_THRESHOLDS.nmbPolicy.forbiddenInCommercial).toBe(true)
    expect(NEC_RULE_THRESHOLDS.nmbPolicy.forbiddenInPlenum).toBe(true)
    expect(NEC_RULE_THRESHOLDS.nmbPolicy.forbiddenInWetCrawlspace).toBe(true)
  })

  test('Layer 3 (INV-MEP-08): placement-mode legality strictly implies audit-mode legality across all NEC constraints', () => {
    // 1. Cushion-band soundness sweep for fixture keepouts
    const tubDistSweep = [0.0, 0.1, 0.15, 0.2, 0.25, 0.5, 0.91, 0.914, 0.92, 0.925, 1.0]
    const stoveDistSweep = [0.0, 0.05, 0.08, 0.12, 0.15, 0.25]
    const sinkDistSweep = [0.0, 0.05, 0.15, 0.25, 0.4]

    const candidates: PlacementCandidate[] = []
    for (const d of tubDistSweep) {
      candidates.push({
        kind: 'receptacle',
        role: 'receptacle',
        pos: [1, 1.12, 1],
        nearFixtures: [{ kind: 'tub-shower', horizontalDistM: d }],
      })
      candidates.push({
        kind: 'switch',
        role: 'switch',
        pos: [1, 1.22, 1],
        nearFixtures: [{ kind: 'tub-shower', horizontalDistM: d }],
      })
      candidates.push({
        kind: 'luminaire',
        role: 'luminaire',
        pos: [1, 2.35, 1],
        nearFixtures: [{ kind: 'tub-shower', horizontalDistM: d }],
      })
    }
    for (const d of stoveDistSweep) {
      for (const y of [0.38, 0.7, 1.12, 1.7, 2.2]) {
        candidates.push({
          kind: 'receptacle',
          role: 'receptacle',
          pos: [1, y, 1],
          nearFixtures: [{ kind: 'stove', horizontalDistM: d }],
        })
      }
    }
    for (const d of sinkDistSweep) {
      for (const y of [0.45, 1.05, 1.12, 1.5]) {
        candidates.push({
          kind: 'receptacle',
          role: 'receptacle',
          pos: [1, y, 1],
          nearFixtures: [{ kind: 'sink', horizontalDistM: d }],
        })
      }
    }
    // Panel zones, handle height, closet luminaire, openings, bends, NM-B policy
    candidates.push(
      { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'bathroom', nemaRating: 'NEMA-1' },
      { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'closet', nemaRating: 'NEMA-1' },
      { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'outdoor', nemaRating: 'NEMA-1', isOutdoors: true },
      { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'outdoor', nemaRating: 'NEMA-3R', isOutdoors: true },
      { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'garage', nemaRating: 'NEMA-1', handleHeightM: 1.95 },
      { kind: 'electrical:panel', pos: [0, 1.9, 0], roomCategory: 'garage', nemaRating: 'NEMA-1', handleHeightM: 2.15 },
      { kind: 'luminaire', pos: [1, 1.9, 1], roomCategory: 'closet' },
      { kind: 'luminaire', pos: [1, 2.4, 1], roomCategory: 'closet' },
      { kind: 'device', role: 'receptacle', pos: [0, 0.38, 0], openingKind: 'door' },
      { kind: 'device', role: 'receptacle', pos: [0, 0.38, 0], openingKind: 'window', openingSillYM: 0.3, openingHeadYM: 2.1 },
      { kind: 'device', role: 'receptacle', pos: [0, 0.38, 0], openingKind: 'window', openingSillYM: 0.9, openingHeadYM: 2.1 },
      { kind: 'device', role: 'receptacle', pos: [0, 1.12, 0], openingKind: 'window', openingSillYM: 0.9, openingHeadYM: 2.1 },
      { kind: 'electrical:conduit-run', system: 'emt', pos: [0, 2.4, 0], bendDegrees: 360 },
      { kind: 'electrical:conduit-run', system: 'emt', pos: [0, 2.4, 0], bendDegrees: 450 },
      { kind: 'electrical:conduit-run', system: 'nm-b', pos: [0, 2.4, 0], occupancy: 'commercial' },
      { kind: 'electrical:conduit-run', system: 'nm-b', pos: [0, 2.4, 0], inPlenum: true },
      { kind: 'electrical:conduit-run', system: 'nm-b', pos: [0, -0.2, 0], inWetCrawlspace: true },
      { kind: 'electrical:conduit-run', system: 'pvc-40', pos: [0, -0.2, 0], inWetCrawlspace: true },
    )

    for (const c of candidates) {
      const placementRes = evaluatePlacementCandidate(NEC_DECLARATIVE_RULES, c, 'placement')
      const auditRes = evaluatePlacementCandidate(NEC_DECLARATIVE_RULES, c, 'audit')
      if (placementRes.legal) {
        expect(auditRes.legal).toBe(true)
      }
    }

    // Confirm cushion band: 0.920 m from tub is rejected in placement (< 0.925) but legal in audit (>= 0.914)
    const tubCushionCandidate: PlacementCandidate = {
      kind: 'receptacle',
      role: 'receptacle',
      pos: [1, 1.12, 1],
      nearFixtures: [{ kind: 'tub-shower', horizontalDistM: 0.92 }],
    }
    expect(effectivePlacementThreshold(0.914, 0.011, 'min')).toBeCloseTo(0.925, 4)
    expect(evaluatePlacementCandidate(NEC_DECLARATIVE_RULES, tubCushionCandidate, 'placement').legal).toBe(false)
    expect(evaluatePlacementCandidate(NEC_DECLARATIVE_RULES, tubCushionCandidate, 'audit').legal).toBe(true)

    // Confirm outdoor NEMA-1 fails while NEMA-3R passes
    expect(
      evaluatePlacementCandidate(
        NEC_DECLARATIVE_RULES,
        { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'outdoor', nemaRating: 'NEMA-1', isOutdoors: true },
        'audit',
      ).legal,
    ).toBe(false)
    expect(
      evaluatePlacementCandidate(
        NEC_DECLARATIVE_RULES,
        { kind: 'electrical:panel', pos: [0, 1.52, 0], roomCategory: 'outdoor', nemaRating: 'NEMA-3R', isOutdoors: true },
        'audit',
      ).legal,
    ).toBe(true)

    // End-to-end autopopulate + audit parity on a bathroom + kitchen + closet scene
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 5], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 5], end: [0, 5], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 5], end: [0, 0], thickness: 0.14, height: 2.7 },
      wp: { id: 'wp', type: 'wall', parentId: 'level_0', start: [4, 0], end: [4, 5], thickness: 0.12, height: 2.7 },
      z_bath: {
        id: 'z_bath',
        type: 'zone',
        parentId: 'level_0',
        name: 'Bath',
        category: 'bathroom',
        polygon: [[0, 0], [4, 0], [4, 5], [0, 5]],
      },
      z_kitchen: {
        id: 'z_kitchen',
        type: 'zone',
        parentId: 'level_0',
        name: 'Kitchen',
        category: 'kitchen',
        polygon: [[4, 0], [8, 0], [8, 5], [4, 5]],
      },
      tub_1: {
        id: 'tub_1',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        fixtureKind: 'bathtub',
        position: [0.85, 0.15, 0.5],
      },
      stove_1: {
        id: 'stove_1',
        type: 'item',
        parentId: 'level_0',
        name: 'Gas Range Stove',
        position: [6.0, 0, 0.4],
        dimensions: [0.76, 0.9, 0.65],
      },
      sink_1: {
        id: 'sink_1',
        type: 'plumbing:fixture',
        parentId: 'level_0',
        fixtureKind: 'kitchen-sink',
        position: [7.2, 0.46, 0.4],
      },
    }
    const plan = planNecAutoPopulate(scene, { levelId: 'level_0', includeWiring: true })
    const fullScene: Record<string, SceneNodeLike> = { ...scene }
    if (plan.createdPanel) {
      fullScene[plan.createdPanel.id] = { type: 'electrical:panel', parentId: 'level_0', ...plan.createdPanel }
    }
    for (const d of plan.devices) {
      fullScene[d.tempId] = { id: d.tempId, type: 'electrical:device', parentId: 'level_0', ...d }
    }
    for (const r of plan.runs) {
      fullScene[r.tempId] = { id: r.tempId, type: 'electrical:conduit-run', parentId: 'level_0', ...r }
    }
    const report = auditSceneElectrical(fullScene)
    expect(report.findings.filter((f) => f.category === 'prohibited-location' && f.severity === 'error')).toHaveLength(0)
  })

  test('Layer 2: routeElectricalViaLegalCavity and routeElectricalRun avoid structural Header over Window and window prisms', () => {
    // North wall has a wide window (x=1.5..4.5, y=0.9..2.1) topped by a full-depth structural LVL header
    // ("Header over Window") occupying y=2.12..2.68 across x=1.2..4.8, completely sealing the top-plate chase!
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [6, 0], thickness: 0.16, height: 2.7 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [6, 0], end: [6, 5], thickness: 0.16, height: 2.7 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [6, 5], end: [0, 5], thickness: 0.16, height: 2.7 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [0, 5], end: [0, 0], thickness: 0.16, height: 2.7 },
      win_1: {
        id: 'win_1',
        type: 'window',
        parentId: 'w_n',
        position: [3.0, 1.5, 0],
        width: 3.0,
        height: 1.2,
        sillHeight: 0.9,
      },
      hdr_win: {
        id: 'hdr_win',
        type: 'structural:beam',
        parentId: 'level_0',
        name: 'Header over Window',
        designation: '2x12 LVL Header',
        start: [1.2, 0],
        end: [4.8, 0],
        elevationY: 2.4,
        widthIn: 6.5,
        depthIn: 22.0,
      },
      z_room: {
        id: 'z_room',
        type: 'zone',
        parentId: 'level_0',
        name: 'Living Room',
        category: 'living',
        polygon: [[0, 0], [6, 0], [6, 5], [0, 5]],
      },
    }

    const walls = extractRoutingWalls(scene, 'level_0')
    const obstacles = extractTradeObstacles(scene, 'level_0')
    const cavities = extractRoutingCavities(scene, 'level_0')
    expect(obstacles.some((o) => o.nodeId === 'hdr_win')).toBe(true)

    // Direct Layer 2 call: route across the window + structural header from x=0.6 to x=5.4 along north wall
    const cavityRes = routeElectricalViaLegalCavity({
      start: [0.6, 1.2, 0.08],
      end: [5.4, 1.2, 0.08],
      obstacles,
      nodes: scene,
      levelId: 'level_0',
      walls,
      cavities,
      racewayType: 'emt',
    })
    expect(cavityRes).not.toBeNull()
    expect(cavityRes!.ok).toBe(true)
    expect(cavityRes!.clashObstacleIds).toHaveLength(0)
    expect(cavityRes!.openingHits).toBe(0)
    expect(cavityRes!.outdoorVoidViolation).toBe(false)
    expect(detectRunTradeClashes(cavityRes!.path, obstacles, 0.05, 0.015)).toHaveLength(0)
    expect(countPathBendDegrees(cavityRes!.path).totalBendDegrees).toBeLessThanOrEqual(360)

    // Verify WeakMap caching on `nodes` returns the exact same LegalCavityGraph instance
    const cavityRes2 = routeElectricalViaLegalCavity({
      start: [0.6, 0.38, 0.08],
      end: [5.4, 0.38, 0.08],
      obstacles,
      nodes: scene,
      levelId: 'level_0',
      walls,
      cavities,
      racewayType: 'emt',
    })
    expect(cavityRes2?.graph).toBe(cavityRes?.graph)

    // Verify integrated `routeElectricalRun` also yields 0 clashes against the structural window header
    const fullRoute = routeElectricalRun([0.6, 1.2, 0.08], [5.4, 1.2, 0.08], obstacles, {
      walls,
      nodes: scene,
      levelId: 'level_0',
      cavities,
      racewayType: 'emt',
    })
    expect(fullRoute.remainingClashes).toHaveLength(0)
    expect(detectRunTradeClashes(fullRoute.path, obstacles, 0.05, 0.015)).toHaveLength(0)
  })

  test('Layer 2: routeElectricalViaLegalCavity respects concave L-shaped courtyard exclusion and wet crawlspace NM-B ban', () => {
    // Concave L-shaped floorplan:
    //   Wing A: x in [0, 10], z in [0, 4]
    //   Wing B: x in [0, 4],  z in [4, 10]
    //   Outdoor Courtyard notch: x in (4, 10], z in (4, 10]
    const lScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], thickness: 0.14, height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 4], thickness: 0.14, height: 2.7 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 4], end: [4, 4], thickness: 0.14, height: 2.7 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [4, 4], end: [4, 10], thickness: 0.14, height: 2.7 },
      w5: { id: 'w5', type: 'wall', parentId: 'level_0', start: [4, 10], end: [0, 10], thickness: 0.14, height: 2.7 },
      w6: { id: 'w6', type: 'wall', parentId: 'level_0', start: [0, 10], end: [0, 0], thickness: 0.14, height: 2.7 },
      z_wing_a: {
        id: 'z_wing_a',
        type: 'zone',
        parentId: 'level_0',
        name: 'Living Wing',
        category: 'living',
        polygon: [[0, 0], [10, 0], [10, 4], [0, 4]],
      },
      z_wing_b: {
        id: 'z_wing_b',
        type: 'zone',
        parentId: 'level_0',
        name: 'Bedroom Wing',
        category: 'bedroom',
        polygon: [[0, 4], [4, 4], [4, 10], [0, 10]],
      },
      z_courtyard: {
        id: 'z_courtyard',
        type: 'zone',
        parentId: 'level_0',
        name: 'Courtyard',
        category: 'courtyard',
        polygon: [[4, 4], [10, 4], [10, 10], [4, 10]],
      },
    }

    const walls = extractRoutingWalls(lScene, 'level_0')
    // Route from far east end of Wing A ([9.5, 0.38, 3.85]) to far south end of Wing B ([3.85, 0.38, 9.5])
    // A naive straight line crosses the courtyard midpoint (6.67, 6.67)!
    const res = routeElectricalViaLegalCavity({
      start: [9.5, 0.38, 3.85],
      end: [3.85, 0.38, 9.5],
      obstacles: [],
      nodes: lScene,
      levelId: 'level_0',
      walls,
      cavities: { hasCrawlSpace: true, crawlSpaceWet: true, crawlSpaceY: -0.25 },
      racewayType: 'nm-b',
      outdoorPolygons: [[[4, 4], [10, 4], [10, 10], [4, 10]]],
    })

    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(res!.outdoorVoidViolation).toBe(false)
    // Verify no waypoint enters the open outdoor courtyard (x > 4.2 && z > 4.2)
    for (const pt of res!.path) {
      expect(pt[0] > 4.2 && pt[2] > 4.2).toBe(false)
      // Wet crawlspace bans NM-B sub-floor routing (NEC 334.12(B)(4))
      expect(pt[1]).toBeGreaterThanOrEqual(-0.05)
    }
    expect(res!.bandsUsed).not.toContain('under-slab')
    expect(res!.bandsUsed).not.toContain('crawlspace')

    // Verify WeakMap caching on `walls` (without `nodes`) also caches LegalCavityGraph
    const wallsOnly1 = routeElectricalViaLegalCavity({
      start: [9.5, 0.38, 3.85],
      end: [3.85, 0.38, 9.5],
      obstacles: [],
      walls,
      racewayType: 'emt',
      outdoorPolygons: [[[4, 4], [10, 4], [10, 10], [4, 10]]],
    })
    const wallsOnly2 = routeElectricalViaLegalCavity({
      start: [9.0, 0.38, 3.85],
      end: [3.85, 0.38, 9.0],
      obstacles: [],
      walls,
      racewayType: 'emt',
      outdoorPolygons: [[[4, 4], [10, 4], [10, 10], [4, 10]]],
    })
    expect(wallsOnly1).not.toBeNull()
    expect(wallsOnly1!.ok).toBe(true)
    expect(wallsOnly1!.outdoorVoidViolation).toBe(false)
    expect(wallsOnly2?.graph).toBe(wallsOnly1?.graph)
  })
})
