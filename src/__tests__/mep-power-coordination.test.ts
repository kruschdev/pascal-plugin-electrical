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
})
