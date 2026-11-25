import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import { buildCeilingFanLightCad } from '../cad/expansion'
import { createCadMaterialPool } from '../cad/materials'
import { auditSceneElectrical } from '../nec/audit'
import { extractBonesFramingContext } from '../nec/framing-interop'
import { calculateSceneLoad, type SceneNodeLike } from '../nec/load-calc'
import {
  buildElectricalTakeoff,
  buildPanelSchedule,
  formatPanelScheduleCsv,
} from '../nec/panel-schedule'
import { formatElectricalBomCsv } from '../nec/pricing'
import { electricalConduitRunRenderDefinition } from '../nodes/conduit-run'
import { DeviceKindEnum, ElectricalDeviceNode } from '../nodes/device'
import {
  electricalConduitRunParametrics,
  electricalDeviceParametrics,
} from '../nodes/parametrics'

describe('Round 5 Gemini 4 Carbon Audit Regression Suite (R5-BUG-01..08, R5-OPT-01, R5-CON-01)', () => {
  test('R5-BUG-01: conduit-run geometryKey invalidates when circuitNumber changes', () => {
    const base = {
      path: [
        [0, 1.5, 0],
        [2, 1.5, 0],
      ] as [number, number, number][],
      racewayType: 'nm-b' as const,
      tradeSize: '3/4"' as const,
      wireGauge: '12' as const,
      voltage: 120,
      circuitNumber: 1,
    }
    const key1 = electricalConduitRunRenderDefinition.geometryKey!(base as never)
    const key2 = electricalConduitRunRenderDefinition.geometryKey!({ ...base, circuitNumber: 2 } as never)
    expect(key1).not.toBe(key2)
  })

  test('R5-BUG-02: Inspector parametrics expose all 25 DeviceKindEnum options and full feeder wireGauge options', () => {
    const devKindField = electricalDeviceParametrics.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === 'deviceKind') as { options?: string[] } | undefined
    expect(devKindField?.options?.length).toBe(DeviceKindEnum.options.length)
    for (const kind of DeviceKindEnum.options) {
      expect(devKindField?.options).toContain(kind)
    }

    const runGaugeField = electricalConduitRunParametrics.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === 'wireGauge') as { options?: string[] } | undefined
    expect(runGaugeField?.options).toContain('250kcmil')
    expect(runGaugeField?.options).toContain('750kcmil')
  })

  test('R5-BUG-03: Stud-snapping respects NEC 210.52(C) 2ft/4ft kitchen & 210.52(A) 6ft/12ft habitable spacing limits', () => {
    // Tight 1.20 m kitchen wall on 24" OC Bones framing (max allowed 2.0 ft = 0.61 m from either end)
    const kitchenNodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground', parentId: null, height: 2.5 } as unknown as AnyNode,
      bones_fr: {
        id: 'bonesframing_1',
        type: 'bones:framing',
        parentId: 'level_0',
        studSpacingIn: 24,
      } as unknown as AnyNode,
      wall_k: { id: 'wall_k', type: 'wall', parentId: 'level_0', start: [0, 0], end: [1.2, 0], thickness: 0.12 } as unknown as AnyNode,
      wall_r: { id: 'wall_r', type: 'wall', parentId: 'level_0', start: [1.2, 0], end: [1.2, 3], thickness: 0.12 } as unknown as AnyNode,
      wall_b: { id: 'wall_b', type: 'wall', parentId: 'level_0', start: [1.2, 3], end: [0, 3], thickness: 0.12 } as unknown as AnyNode,
      wall_l: { id: 'wall_l', type: 'wall', parentId: 'level_0', start: [0, 3], end: [0, 0], thickness: 0.12 } as unknown as AnyNode,
      zone_k: {
        id: 'zone_k',
        type: 'zone',
        name: 'Kitchen',
        parentId: 'level_0',
        polygon: [[0, 0], [1.2, 0], [1.2, 3], [0, 3]],
      } as unknown as AnyNode,
    }
    const out = electricalAgentOperations.electrical_autopopulate_nec(
      kitchenNodes,
      { levelId: 'level_0', occupancy: 'residential', protectionMode: 'hybrid' },
      { activeLevelId: 'level_0' },
    )
    const northKitchenGfcis = (out.changes?.create ?? [])
      .map((c) => c.node as unknown as SceneNodeLike)
      .filter(
        (n) =>
          n.type === 'electrical:device' &&
          (n.deviceKind === 'gfci' || n.deviceKind === 'duplex') &&
          Array.isArray(n.position) &&
          Math.abs((n.position[2] as number) - 0.068) < 0.05,
      )
    expect(northKitchenGfcis.length).toBeGreaterThanOrEqual(1)
    const x = (northKitchenGfcis[0]!.position as [number, number, number])[0]
    expect(x).toBeLessThanOrEqual(0.61)
    expect(1.2 - x).toBeLessThanOrEqual(0.61)
  })

  test('R5-BUG-04: Multi-level auditSceneElectrical prevents Level 2 bathroom/tub/furniture from falsely flagging Level 1', () => {
    const multiLevel: Record<string, SceneNodeLike> = {
      level_1: { id: 'level_1', type: 'level', name: 'Ground Floor', parentId: null, height: 2.5 },
      level_2: { id: 'level_2', type: 'level', name: 'Second Floor', parentId: null, height: 2.5 },
      // Level 2 bathroom stacked directly over Level 1 garage at identical local XZ coordinates!
      zone_l2_bath: {
        id: 'zone_l2_bath',
        type: 'zone',
        name: 'Master Bath',
        category: 'bathroom',
        parentId: 'level_2',
        polygon: [[0, 0], [5, 0], [5, 5], [0, 5]],
      },
      tub_l2: {
        id: 'tub_l2',
        type: 'item',
        name: 'Bathtub',
        parentId: 'level_2',
        position: [2.0, 0, 2.0],
        dimensions: [1.5, 0.6, 0.8],
      },
      vanity_l2: {
        id: 'vanity_l2',
        type: 'cabinet',
        name: 'Bath Vanity',
        parentId: 'level_2',
        position: [2.0, 0, 2.2],
        dimensions: [1.0, 0.9, 0.6],
      },
      // Level 1 clean living room with panel & outlet at the exact same local (x, z)
      zone_l1_living: {
        id: 'zone_l1_living',
        type: 'zone',
        name: 'Living Room',
        category: 'living',
        parentId: 'level_1',
        polygon: [[0, 0], [5, 0], [5, 5], [0, 5]],
      },
      panel_l1: {
        id: 'panel_l1',
        type: 'electrical:panel',
        name: 'MDP-1',
        parentId: 'level_1',
        position: [2.0, 1.52, 1.8],
        rotation: 0,
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        spaces: 40,
      },
      outlet_l1: {
        id: 'outlet_l1',
        type: 'electrical:device',
        name: 'Living Outlet 1',
        parentId: 'level_1',
        deviceKind: 'duplex',
        panelId: 'panel_l1',
        circuitNumber: 1,
        poles: 1,
        breakerAmps: 15,
        loadVa: 180,
        afciProtected: true,
        gfciProtected: false,
        boxType: 'single-gang-standard',
        wireGauge: '14',
        conductorCount: 2,
        position: [2.0, 0.38, 2.1],
        rotation: 0,
      },
    }

    const report = auditSceneElectrical(multiLevel)
    const l1Errors = report.findings.filter(
      (f) => f.nodeIds.includes('panel_l1') || f.nodeIds.includes('outlet_l1'),
    )
    expect(l1Errors).toHaveLength(0)
  })

  test('R5-BUG-05/06/07: weatherproof-gfci audit, new equipment NEC 220 loads, heavy feeder Zod parse & integral-enclosure BOM box exclusion', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground', parentId: null, height: 2.5 } as unknown as AnyNode,
      zone_patio: {
        id: 'zone_patio',
        type: 'zone',
        name: 'Patio',
        category: 'outdoor',
        parentId: 'level_0',
        polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      } as unknown as AnyNode,
      panel_1: {
        id: 'panel_1',
        type: 'electrical:panel',
        name: 'MDP-1',
        parentId: 'level_0',
        position: [5, 1.52, 0.1],
        rotation: 0,
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        spaces: 40,
        solarBackfeedAmps: 0,
      } as unknown as AnyNode,
      wp_gfci: {
        id: 'wp_gfci',
        type: 'electrical:device',
        name: 'Patio WR GFCI',
        parentId: 'level_0',
        deviceKind: 'weatherproof-gfci',
        panelId: 'panel_1',
        circuitNumber: 1,
        poles: 1,
        breakerAmps: 20,
        loadVa: 180,
        gfciProtected: false,
        boxType: 'single-gang-deep',
        wireGauge: '12',
        conductorCount: 2,
        position: [2, 0.45, 2],
        rotation: 0,
      } as unknown as AnyNode,
      std_duplex: {
        id: 'std_duplex',
        type: 'electrical:device',
        name: 'Indoor Duplex',
        parentId: 'level_0',
        deviceKind: 'duplex',
        panelId: 'panel_1',
        circuitNumber: 2,
        poles: 1,
        breakerAmps: 15,
        loadVa: 180,
        afciProtected: true,
        boxType: 'single-gang-standard',
        wireGauge: '14',
        conductorCount: 2,
        position: [6, 0.38, 1],
        rotation: 0,
      } as unknown as AnyNode,
    }

    // R5-BUG-06: Place 60A continuous battery-ess (#4 AWG) & 200A transfer-switch (3/0) -> both pass ElectricalDeviceNode.parse!
    const essOut = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        levelId: 'level_0',
        name: 'Wall Battery ESS',
        position: [6, 1.2, 0.1],
        deviceKind: 'battery-ess',
        panelId: 'panel_1',
        poles: 2,
        breakerAmps: 60,
        loadVa: 11500,
        continuous: true,
        autoWire: false,
      },
      { activeLevelId: 'level_0' },
    )
    const essNode = essOut.changes!.create![0]!.node
    expect(() => ElectricalDeviceNode.parse(essNode)).not.toThrow()
    nodes[essNode.id] = essNode

    const atsOut = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        levelId: 'level_0',
        name: '200A ATS',
        position: [7, 1.4, 0.1],
        deviceKind: 'transfer-switch',
        panelId: 'panel_1',
        poles: 2,
        breakerAmps: 200,
        loadVa: 0,
        autoWire: false,
      },
      { activeLevelId: 'level_0' },
    )
    const atsNode = atsOut.changes!.create![0]!.node
    expect(() => ElectricalDeviceNode.parse(atsNode)).not.toThrow()
    nodes[atsNode.id] = atsNode

    const pvOut = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        levelId: 'level_0',
        name: 'Solar PV Inverter',
        position: [8, 1.3, 0.1],
        deviceKind: 'solar-inverter',
        panelId: 'panel_1',
        poles: 2,
        breakerAmps: 40,
        loadVa: 0,
        autoWire: false,
      },
      { activeLevelId: 'level_0' },
    )
    nodes[pvOut.changes!.create![0]!.node.id] = pvOut.changes!.create![0]!.node

    const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    // R5-BUG-05: weatherproof-gfci passes outdoor GFCI audit & panel schedule marks GFCI
    const audit = auditSceneElectrical(record)
    expect(audit.findings.filter((f) => f.nodeIds.includes('wp_gfci'))).toHaveLength(0)
    // R5-BUG-07: integral enclosures (ATS / Battery ESS / PV / WP GFCI) skip 314.16 box-fill & BOM gang-box billing
    expect(audit.findings.filter((f) => f.category === 'box-fill')).toHaveLength(0)
    const takeoff = buildElectricalTakeoff(record)
    // Only std_duplex should bill a separate wall rough-in box!
    expect(takeoff.boxesByType['single-gang-standard']).toBe(1)
    expect(takeoff.boxesByType['single-gang-deep']).toBeUndefined()
    expect(takeoff.boxesByType['4-11-16-2.125']).toBeUndefined()

    const sched = buildPanelSchedule(
      record.panel_1!,
      Object.values(record).filter((n) => n.type === 'electrical:device'),
    )
    expect(sched.rows[0]?.left?.protection).toContain('GFCI')

    // R5-BUG-05: calculateSceneLoad includes battery-ess load & infers solar-inverter backfeed
    const loadRes = calculateSceneLoad(record, { occupancy: 'residential' })
    expect(loadRes.occupancy).toBe('residential')
    if (loadRes.occupancy === 'residential') {
      expect(loadRes.totalDemandVa).toBeGreaterThanOrEqual(11500)
      expect(loadRes.solarBusbarCheck?.proposedSolarBackfeedAmps).toBe(40)
    }
  })

  test('R5-BUG-08: CSV exporters neutralize spreadsheet formula injection payloads', () => {
    const panel: SceneNodeLike = {
      id: 'p1',
      type: 'electrical:panel',
      name: '=HYPERLINK("https://evil.example","MDP-1")',
      voltageSystem: '120/240V-1P',
      busRatingAmps: 200,
      mainBreakerAmps: 200,
      spaces: 12,
    }
    const dev: SceneNodeLike = {
      id: 'd1',
      type: 'electrical:device',
      name: '=CMD|"/C calc"!A0',
      deviceKind: 'duplex',
      panelId: 'p1',
      circuitNumber: 1,
      poles: 1,
      breakerAmps: 15,
      loadVa: 180,
    }
    const sched = buildPanelSchedule(panel, [dev])
    const schedCsv = formatPanelScheduleCsv(sched)
    expect(schedCsv).toContain("'=CMD")
    expect(schedCsv).not.toMatch(/,=CMD/)

    const takeoff = buildElectricalTakeoff({ p1: panel, d1: dev })
    const bomCsv = formatElectricalBomCsv(takeoff.pricing)
    expect(bomCsv).toContain("'=HYPERLINK")
    expect(bomCsv).not.toMatch(/,=HYPERLINK/)
  })

  test('R5-OPT-01 & R5-CON-01: walnutWood material pooled in CadMaterialPool & root-level bones:framing detected', () => {
    const mats = createCadMaterialPool()
    expect(mats.walnutWood).toBeDefined()
    const fan = buildCeilingFanLightCad(mats)
    expect(fan.children.length).toBeGreaterThan(0)

    const rootBones: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground', parentId: null },
      bones_root: { id: 'bones_root', type: 'bones:framing', parentId: null, studSpacingIn: 24 },
    }
    const ctx = extractBonesFramingContext(rootBones, 'level_0')
    expect(ctx.present).toBe(true)
    expect(ctx.defaultSpacingIn).toBe(24)
  })
})
