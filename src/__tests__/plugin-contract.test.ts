import { describe, expect, test } from 'bun:test'
import { type AnyNode, type GeometryContext, loadPlugin, nodeRegistry } from '@pascal-app/core'
import { electricalAgentOperations } from '../agent-operations'
import { electricalAgentTools } from '../agent-tools'
import {
  ELECTRICAL_PLUGIN_ID,
  electricalChatExtension,
  electricalHostPanel,
  electricalPlugin,
  electricalRenderPlugin,
  electricalScheduleView,
} from '../index'
import {
  buildElectricalConduitRunFloorplan,
  buildElectricalConduitRunGeometry,
  ElectricalConduitRunNode,
} from '../nodes/conduit-run'
import {
  buildElectricalDeviceFloorplan,
  buildElectricalDeviceGeometry,
  ElectricalDeviceNode,
} from '../nodes/device'
import {
  buildElectricalPanelFloorplan,
  buildElectricalPanelGeometry,
  ElectricalPanelNode,
} from '../nodes/panel'
import {
  buildElectricalTransformerFloorplan,
  buildElectricalTransformerGeometry,
  ElectricalTransformerNode,
  electricalTransformerRenderDefinition,
  getElectricalTransformerPorts,
} from '../nodes/transformer'

const dummyCtx = {} as GeometryContext

describe('Pascal Plugin API v1 Conformance & Agent Operations (E-014 / E-016)', () => {
  test('electricalPlugin & electricalRenderPlugin conform to Plugin v1 and register all 4 node kinds', async () => {
    expect(electricalPlugin.id).toBe(ELECTRICAL_PLUGIN_ID)
    expect(electricalPlugin.apiVersion).toBe(1)
    expect(electricalRenderPlugin.id).toBe(ELECTRICAL_PLUGIN_ID)
    expect(electricalRenderPlugin.apiVersion).toBe(1)
    expect(electricalPlugin.nodes?.length).toBe(4)
    expect(electricalRenderPlugin.nodes?.length).toBe(4)

    expect(electricalHostPanel.pluginId).toBe(ELECTRICAL_PLUGIN_ID)
    expect(electricalScheduleView.pluginId).toBe(ELECTRICAL_PLUGIN_ID)
    expect(electricalChatExtension.pluginId).toBe(ELECTRICAL_PLUGIN_ID)

    await loadPlugin(electricalPlugin)
    expect(nodeRegistry.get('electrical:panel')).toBeDefined()
    expect(nodeRegistry.get('electrical:device')).toBeDefined()
    expect(nodeRegistry.get('electrical:conduit-run')).toBeDefined()
    expect(nodeRegistry.get('electrical:transformer')).toBeDefined()
  })

  test('Every PluginAgentTool contract in ./agent-tools has a matching pure operation in ./agent-operations', () => {
    expect(electricalAgentTools.pluginId).toBe(ELECTRICAL_PLUGIN_ID)
    expect(electricalAgentTools.apiVersion).toBe(1)
    const opNames = new Set(Object.keys(electricalAgentOperations))
    for (const tool of electricalAgentTools.tools) {
      expect(tool.name.startsWith('electrical_')).toBe(true)
      if (tool.runsIn === 'operation') {
        expect(opNames.has(tool.name)).toBe(true)
      }
    }
  })

  test('End-to-end pure agent operations place panel + device, route around plumbing & HVAC, and pass NEC audit', () => {
    const nodes: Record<string, AnyNode> = {
      level_0: {
        object: 'node',
        id: 'level_0',
        type: 'level',
        name: 'Level 0',
        parentId: null,
        visible: true,
        metadata: {},
        level: 0,
        children: [],
      } as unknown as AnyNode,
      'pipe-segment_1': {
        object: 'node',
        id: 'pipe-segment_1',
        type: 'pipe-segment',
        parentId: 'level_0',
        visible: true,
        metadata: {},
        diameter: 4,
        path: [
          [2, 2.55, -1],
          [2, 2.55, 2],
        ],
      } as unknown as AnyNode,
      'duct-segment_1': {
        object: 'node',
        id: 'duct-segment_1',
        type: 'duct-segment',
        parentId: 'level_0',
        visible: true,
        metadata: {},
        shape: 'rect',
        width: 16,
        height: 8,
        path: [
          [3, 2.55, -1],
          [3, 2.55, 2],
        ],
      } as unknown as AnyNode,
    }

    const ctx = { activeLevelId: 'level_0' }
    const panelOut = electricalAgentOperations.electrical_place_panel(
      nodes,
      { name: 'MDP-1', position: [0, 1.52, 0], occupancy: 'residential' },
      ctx,
    )
    const panelNode = panelOut.changes!.create![0]!.node
    nodes[panelNode.id] = panelNode

    const devOut = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        name: 'Living Outlet',
        position: [4.5, 0.38, 0],
        deviceKind: 'afci',
        panelId: panelNode.id,
        circuitNumber: 1,
        loadVa: 180,
      },
      ctx,
    )
    const devNode = devOut.changes!.create![0]!.node
    nodes[devNode.id] = devNode

    const routeOut = electricalAgentOperations.electrical_route_circuit(
      nodes,
      { panelId: panelNode.id, targetDeviceId: devNode.id, racewayType: 'emt' },
      ctx,
    )
    const runNode = routeOut.changes!.create![0]!.node
    nodes[runNode.id] = runNode

    expect((routeOut.result.avoidedObstacles as unknown[]).length).toBeGreaterThanOrEqual(2)
    expect((routeOut.result.remainingClashes as unknown[]).length).toBe(0)

    const auditOut = electricalAgentOperations.electrical_audit_nec(nodes)
    expect(auditOut.result.passed).toBe(true)
    expect(auditOut.result.errorCount).toBe(0)

    const schedOut = electricalAgentOperations.electrical_generate_schedule(nodes, {})
    expect(schedOut.result.panelCount).toBe(1)

    const loadOut = electricalAgentOperations.electrical_calculate_load(nodes, {
      fallbackSquareFootage: 2000,
    })
    expect(loadOut.result.minimumServiceAmps).toBe(100)

    // BUG-03: Placing & routing a 50A continuous EVSE without manual wireGauge/tradeSize auto-sizes cleanly
    const evseOut = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        name: 'Garage EVSE',
        position: [6, 1.1, 0],
        deviceKind: 'evse',
        panelId: panelNode.id,
        circuitNumber: 2,
        poles: 2,
        breakerAmps: 50,
        loadVa: 9600,
        continuous: true,
        gfciProtected: true,
      },
      ctx,
    )
    const evseNode = evseOut.changes!.create![0]!.node
    nodes[evseNode.id] = evseNode

    const evseRoute = electricalAgentOperations.electrical_route_circuit(
      nodes,
      { panelId: panelNode.id, targetDeviceId: evseNode.id, racewayType: 'nm-b' },
      ctx,
    )
    const evseRun = evseRoute.changes!.create![0]!.node
    nodes[evseRun.id] = evseRun
    // 40A * 1.25 = 50A required -> NM-B 60°C cap requires #6 Cu (55A)
    expect(evseRoute.result.wireGauge).toBe('6')

    const auditAfterEvse = electricalAgentOperations.electrical_audit_nec(nodes)
    expect(auditAfterEvse.result.passed).toBe(true)

    // OPT-02: Commercial step-down transformer placement operation creates electrical:transformer with NEC 450.3(B) sizing
    const txOut = electricalAgentOperations.electrical_place_transformer(
      nodes,
      {
        name: 'TX-1 (75 kVA)',
        position: [3, 0, -2],
        kvaRating: 75,
        primaryVoltage: 480,
        secondaryVoltage: 208,
        fedFromPanelId: panelNode.id,
      },
      ctx,
    )
    const txNode = txOut.changes!.create![0]!.node
    nodes[txNode.id] = txNode
    expect(txNode.type).toBe('electrical:transformer')
    expect(txOut.result.maxPrimaryOcpdAmps).toBe(125)
    expect(txOut.result.maxSecondaryOcpdAmps).toBe(300)
  })

  test('All 4 node 3D geometry and 2D floorplan builders produce valid Three.js & Floorplan outputs', () => {
    const panel = ElectricalPanelNode.parse({ id: 'elecpanel_test', type: 'electrical:panel' })
    const pGeo = buildElectricalPanelGeometry(panel, dummyCtx)
    const pPlan = buildElectricalPanelFloorplan(panel, dummyCtx)
    expect(pGeo.children.length).toBeGreaterThan(2)
    expect(pPlan.kind).toBe('group')

    const dev = ElectricalDeviceNode.parse({ id: 'elecdev_test', type: 'electrical:device' })
    const dGeo = buildElectricalDeviceGeometry(dev, dummyCtx)
    const dPlan = buildElectricalDeviceFloorplan(dev, dummyCtx)
    expect(dGeo.children.length).toBeGreaterThan(0)
    expect(dPlan.kind).toBe('group')

    const run = ElectricalConduitRunNode.parse({
      id: 'eleccond_test',
      type: 'electrical:conduit-run',
      path: [
        [0, 1.5, 0],
        [0, 2.5, 0],
        [3, 2.5, 0],
        [3, 0.4, 0],
      ],
    })
    const rGeo = buildElectricalConduitRunGeometry(run, dummyCtx)
    const rPlan = buildElectricalConduitRunFloorplan(run, dummyCtx)
    expect(rGeo.children.length).toBe(5) // 3 cylinders + 2 bend elbows sharing 1 SphereGeometry
    expect((rGeo.children[3] as { geometry: unknown }).geometry).toBe(
      (rGeo.children[4] as { geometry: unknown }).geometry,
    )
    expect(rPlan.kind).toBe('group')

    const tx = ElectricalTransformerNode.parse({ id: 'electx_test', type: 'electrical:transformer' })
    const tGeo = buildElectricalTransformerGeometry(tx, dummyCtx)
    const tPlan = buildElectricalTransformerFloorplan(tx, dummyCtx)
    expect(tGeo.children.length).toBeGreaterThan(2)
    expect(tPlan.kind).toBe('group')

    // BUG-04: Rotated 90° transformer rotates ports & coil circles onto Z axis and keys geometry by primaryVoltage
    const txRot = ElectricalTransformerNode.parse({
      id: 'electx_rot',
      type: 'electrical:transformer',
      position: [5, 0, 10],
      rotation: Math.PI / 2,
      primaryVoltage: 240,
      secondaryVoltage: 120,
    })
    const ports = getElectricalTransformerPorts(txRot)
    expect(ports[0]!.position[0]).toBeCloseTo(5, 5)
    expect(ports[0]!.position[2]).toBeGreaterThan(10.1)
    expect(ports[1]!.position[2]).toBeLessThan(9.9)
    expect(electricalTransformerRenderDefinition.geometryKey!(tx)).not.toBe(
      electricalTransformerRenderDefinition.geometryKey!(txRot),
    )
  })
})
