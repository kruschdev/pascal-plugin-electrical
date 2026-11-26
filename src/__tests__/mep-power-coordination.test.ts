import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import { extractTradeObstacles } from '../nec/routing'
import type { SceneNodeLike } from '../nec/load-calc'

describe('Cross-Trade Plumbing & HVAC Electrical Power Coordination', () => {
  test('extractTradeObstacles recognizes plumbing:pipe-run, plumbing:equipment, hvac:duct-run, and hvac:equipment', () => {
    const nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      p1: {
        id: 'p1',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        nominalSize: '3"',
        path: [
          [0, 2.2, 0],
          [4, 2.2, 0],
        ],
      },
      pe1: {
        id: 'pe1',
        type: 'plumbing:equipment',
        name: 'Electric WH',
        parentId: 'level_0',
        position: [1, 0, 1],
      },
      h1: {
        id: 'h1',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        diameter: 10,
        path: [
          [0, 2.4, 2],
          [4, 2.4, 2],
        ],
      },
      he1: {
        id: 'he1',
        type: 'hvac:equipment',
        name: '3-Ton Heat Pump',
        parentId: 'level_0',
        position: [5, 0, 1],
      },
    }

    const obs = extractTradeObstacles(nodes, 'level_0')
    expect(obs.filter((o) => o.trade === 'plumbing').length).toBe(2)
    expect(obs.filter((o) => o.trade === 'hvac').length).toBe(2)
  })

  test('electrical_autopopulate automatically creates breakers & 3D power runs for powered plumbing and HVAC equipment', () => {
    const scene = {
      level_0: { id: 'level_0', type: 'level' },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.16, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.16, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.16, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 2.6 },
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        name: 'Electric Water Heater (50 gal)',
        parentId: 'level_0',
        position: [1.2, 0, 0.4],
        electricalDemand: {
          required: true,
          voltage: 240,
          poles: 2,
          breakerAmps: 30,
          loadVa: 4500,
          continuous: true,
          dedicatedCircuit: true,
          gfciRequired: false,
          afciRequired: false,
          loadCategory: 'fixed',
          label: 'Electric Water Heater (4.5 kW)',
        },
      },
      sump_1: {
        id: 'sump_1',
        type: 'plumbing:equipment',
        name: 'Sump Pump',
        parentId: 'level_0',
        position: [2.4, 0, 0.4],
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
          label: 'Sump Pump (Dedicated GFCI)',
        },
      },
      dw_1: {
        id: 'dw_1',
        type: 'plumbing:fixture',
        name: 'Dishwasher',
        parentId: 'level_0',
        position: [5.5, 0.4, 0.4],
        electricalDemand: {
          required: true,
          voltage: 120,
          poles: 1,
          breakerAmps: 20,
          loadVa: 1500,
          continuous: false,
          dedicatedCircuit: true,
          gfciRequired: true,
          afciRequired: true,
          loadCategory: 'appliance',
          label: 'Dishwasher (NEC 210.8(D) GFCI)',
        },
      },
      hp_1: {
        id: 'hp_1',
        type: 'hvac:equipment',
        name: '3-Ton Heat Pump Condenser',
        parentId: 'level_0',
        position: [7.6, 0, 3.0],
        electricalDemand: {
          required: true,
          voltage: 240,
          poles: 2,
          breakerAmps: 40,
          loadVa: 6800,
          continuous: true,
          dedicatedCircuit: true,
          gfciRequired: false,
          afciRequired: false,
          loadCategory: 'heat-pump',
          label: '3-Ton Heat Pump Condenser',
        },
      },
    } as Record<string, unknown>

    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      scene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const createdNodes: Array<Record<string, unknown>> = (outcome.changes?.create ?? []).map(
      (c: { node: unknown }) => c.node as Record<string, unknown>,
    )
    const mepDevices = createdNodes.filter(
      (n) =>
        n.type === 'electrical:device' &&
        typeof (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'string',
    )
    const wiredSourceIds = new Set(
      mepDevices.map((n) => (n.metadata as { mepSourceNodeId: string }).mepSourceNodeId),
    )

    expect(wiredSourceIds.has('wh_1')).toBe(true)
    expect(wiredSourceIds.has('sump_1')).toBe(true)
    expect(wiredSourceIds.has('dw_1')).toBe(true)
    expect(wiredSourceIds.has('hp_1')).toBe(true)

    // Verify 2-pole 30A WH and 2-pole 40A Heat Pump got proper poles, breakerAmps, and wire gauges
    const whDev = mepDevices.find((n) => (n.metadata as { mepSourceNodeId: string }).mepSourceNodeId === 'wh_1')!
    expect(whDev.poles).toBe(2)
    expect(whDev.breakerAmps).toBe(30)
    expect(whDev.wireGauge).toBe('10')

    const hpDev = mepDevices.find((n) => (n.metadata as { mepSourceNodeId: string }).mepSourceNodeId === 'hp_1')!
    expect(hpDev.poles).toBe(2)
    expect(hpDev.breakerAmps).toBe(40)
    expect(hpDev.wireGauge).toBe('8')

    // Verify each MEP device has a routed 3D electrical:conduit-run targeting it
    const runs = createdNodes.filter((n) => n.type === 'electrical:conduit-run')
    for (const dev of mepDevices) {
      expect(runs.some((r) => r.targetDeviceId === dev.id)).toBe(true)
    }
  })

  test('BUG-11..14 & CON-02: 3-pole commercial loads, NEC 310.16 >=50A/100A gauges, Aux circuit splitting, self-clash exclusion, NEC 110.26(E) panel avoidance, and kind fallback', () => {
    // 1. BUG-11: 3-pole 208V commercial booster heater (100A) & 50A equipment on commercial 3-phase panel
    const commScene = {
      level_0: { id: 'level_0', type: 'level' },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.16, height: 3.0 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.16, height: 3.0 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.16, height: 3.0 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 3.0 },
      booster_3p: {
        id: 'booster_3p',
        type: 'plumbing:equipment',
        name: 'Commercial 3P Booster Heater',
        parentId: 'level_0',
        position: [2.0, 0, 0.5],
        electricalDemand: {
          required: true,
          voltage: 208,
          poles: 3,
          breakerAmps: 100,
          loadVa: 28000,
          continuous: true,
          dedicatedCircuit: true,
          gfciRequired: false,
          afciRequired: false,
          label: '3P Booster Heater',
        },
      },
      range_50a: {
        id: 'range_50a',
        type: 'hvac:equipment',
        name: '50A Commercial Makeup Air',
        parentId: 'level_0',
        position: [5.0, 0, 0.5],
        electricalDemand: {
          required: true,
          voltage: 208,
          poles: 2,
          breakerAmps: 50,
          loadVa: 8000,
          continuous: false,
          dedicatedCircuit: true,
          gfciRequired: false,
          afciRequired: false,
          label: '50A MUA',
        },
      },
    } as Record<string, unknown>

    const commOut = electricalAgentOperations.electrical_autopopulate_nec(
      commScene as never,
      { levelId: 'level_0', occupancy: 'commercial', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const commCreated = (commOut.changes?.create ?? []).map((c: { node: unknown }) => c.node as Record<string, unknown>)
    const boosterDev = commCreated.find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'booster_3p',
    )!
    expect(boosterDev.poles).toBe(3)
    expect(boosterDev.breakerAmps).toBe(100)
    expect(['1', '1/0', '2/0', '3/0', '4/0']).toContain(String(boosterDev.wireGauge))

    const muaDev = commCreated.find(
      (n) => (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'range_50a',
    )!
    expect(muaDev.poles).toBe(2)
    expect(muaDev.breakerAmps).toBe(50)
    expect(['6', '4', '3', '2', '1']).toContain(String(muaDev.wireGauge))

    // 2. BUG-12: Multiple shared non-dedicated aux loads split before exceeding 80% of 15A (1440 VA)
    //    CON-02: Passive gas tank WH with stale electricalDemand is ignored, while default-created electric WH without electricalDemand uses kind fallback!
    const auxScene = {
      level_0: { id: 'level_0', type: 'level' },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], thickness: 0.16, height: 2.6 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], thickness: 0.16, height: 2.6 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], thickness: 0.16, height: 2.6 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], thickness: 0.16, height: 2.6 },
      z1: {
        id: 'z1',
        type: 'zone',
        name: 'Utility',
        parentId: 'level_0',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 6],
          [0, 6],
        ],
      },
      // Overhead pipe along wall w1 (y=2.3, z=0.08) so NEC 110.26(E) panel placement avoids w1 (BUG-14)
      pipe_w1: {
        id: 'pipe_w1',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        nominalSize: '3"',
        path: [
          [0.2, 2.3, 0.08],
          [7.8, 2.3, 0.08],
        ],
      },
      aux1: {
        id: 'aux1',
        type: 'plumbing:equipment',
        equipmentKind: 'recirc-pump',
        parentId: 'level_0',
        position: [1.0, 0, 1.5],
        electricalDemand: { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 600, dedicatedCircuit: false, gfciRequired: true, label: 'Aux 1' },
      },
      aux2: {
        id: 'aux2',
        type: 'plumbing:equipment',
        equipmentKind: 'water-softener',
        parentId: 'level_0',
        position: [2.0, 0, 1.5],
        electricalDemand: { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 600, dedicatedCircuit: false, gfciRequired: true, label: 'Aux 2' },
      },
      aux3: {
        id: 'aux3',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tankless-gas',
        parentId: 'level_0',
        position: [3.0, 0, 1.5],
        electricalDemand: { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 600, dedicatedCircuit: false, gfciRequired: true, label: 'Aux 3' },
      },
      // Passive gas tank with STALE electricalDemand (CON-02) -> MUST NOT get a breaker
      stale_gas_wh: {
        id: 'stale_gas_wh',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank-gas',
        parentId: 'level_0',
        position: [4.5, 0, 1.5],
        electricalDemand: { required: true, voltage: 240, poles: 2, breakerAmps: 30, loadVa: 4500, dedicatedCircuit: true, label: 'Stale Electric' },
      },
      // Electric tank WH missing electricalDemand (CON-02 fallback) -> MUST get a 240V 30A breaker
      fallback_wh: {
        id: 'fallback_wh',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank-electric',
        watts: 4500,
        parentId: 'level_0',
        position: [6.0, 0, 1.5],
      },
      // Small expansion tank at y=1.65 (BUG-13) -> compact AABB [1.50..1.90], not 1.55 m tall
      exp_1: {
        id: 'exp_1',
        type: 'plumbing:equipment',
        equipmentKind: 'expansion-tank',
        parentId: 'level_0',
        position: [6.5, 1.65, 1.5],
      },
    } as Record<string, unknown>

    const obs = extractTradeObstacles(auxScene as Record<string, SceneNodeLike>, 'level_0')
    const expObs = obs.find((o) => o.nodeId === 'exp_1')!
    expect(expObs.box.max[1] - expObs.box.min[1]).toBeCloseTo(0.4, 2)
    expect(expObs.box.max[0] - expObs.box.min[0]).toBeCloseTo(0.24, 2)

    const auxOut = electricalAgentOperations.electrical_autopopulate_nec(
      auxScene as never,
      { levelId: 'level_0', includeWiring: true },
      { activeLevelId: 'level_0' },
    )
    const auxCreated = (auxOut.changes?.create ?? []).map((c: { node: unknown }) => c.node as Record<string, unknown>)
    const mepDevs = auxCreated.filter(
      (n) =>
        n.type === 'electrical:device' &&
        typeof (n.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId === 'string',
    )
    const ids = new Set(mepDevs.map((n) => (n.metadata as { mepSourceNodeId: string }).mepSourceNodeId))
    expect(ids.has('stale_gas_wh')).toBe(false)
    expect(ids.has('fallback_wh')).toBe(true)

    // Aux 1 + Aux 2 + Aux 3 = 1800 VA > 1440 VA (80% of 15A) -> must split across >= 2 distinct circuits!
    const auxCircuits = new Set(
      mepDevs
        .filter((d) => ['aux1', 'aux2', 'aux3'].includes((d.metadata as { mepSourceNodeId: string }).mepSourceNodeId))
        .map((d) => d.circuitNumber),
    )
    expect(auxCircuits.size).toBeGreaterThanOrEqual(2)

    // BUG-14: Newly created panel avoids wall w1 (z ≈ 0.15) where overhead pipe_w1 runs!
    const createdPanel = auxCreated.find((n) => n.type === 'electrical:panel')!
    const pPos = createdPanel.position as [number, number, number]
    expect(pPos[2]).toBeGreaterThan(0.4)

    // BUG-13: Electrical NEC audit reports 0 self-clash errors on MEP power feeds
    const mergedScene: Record<string, unknown> = { ...auxScene }
    for (const n of auxCreated) mergedScene[String(n.id)] = n
    const auditRes = electricalAgentOperations.electrical_audit_nec(mergedScene as never)
    const selfClashes = (auditRes.result.findings as Array<{ category?: string; nodeIds?: string[] }>).filter(
      (f) => f.category === 'trade-clash' && (f.nodeIds?.includes('fallback_wh') || f.nodeIds?.includes('aux1')),
    )
    expect(selfClashes.length).toBe(0)
  })
})
