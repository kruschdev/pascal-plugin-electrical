import { describe, expect, test } from 'bun:test'
import { electricalAgentOperations } from '../agent-operations'
import { auditSceneElectrical } from '../nec/audit'
import { countPathBendDegrees, extractTradeObstacles, routeElectricalRun } from '../nec/routing'
import type { SceneNodeLike } from '../nec/load-calc'

function applyChanges(nodes: Record<string, SceneNodeLike>, outcome: any): Record<string, SceneNodeLike> {
  const next = { ...nodes }
  for (const id of outcome?.changes?.delete ?? []) delete next[id]
  for (const item of outcome?.changes?.create ?? []) {
    const n = item.node ?? item
    if (n?.id) next[n.id] = n
  }
  return next
}

describe('Cross-Trade 4-MEP Coordination Regression Suite (XTRADE-05..15)', () => {
  test('multi-level shared panel never collides circuit numbers across Level 1 and Level 2 (XTRADE-06)', () => {
    let nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Level 1', height: 2.7, elevation: 0 },
      level_1: { id: 'level_1', type: 'level', name: 'Level 2', height: 2.7, elevation: 2.7 },
      w0_1: { id: 'w0_1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      w0_2: { id: 'w0_2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.7, thickness: 0.16 },
      w0_3: { id: 'w0_3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.7, thickness: 0.16 },
      w0_4: { id: 'w0_4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.7, thickness: 0.16 },
      r0_k: { id: 'r0_k', type: 'zone', parentId: 'level_0', name: 'Kitchen', polygon: [[0, 0], [4, 0], [4, 6], [0, 6]] },
      r0_b: { id: 'r0_b', type: 'zone', parentId: 'level_0', name: 'Bath 1', polygon: [[4, 0], [8, 0], [8, 6], [4, 6]] },
      w1_1: { id: 'w1_1', type: 'wall', parentId: 'level_1', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      w1_2: { id: 'w1_2', type: 'wall', parentId: 'level_1', start: [8, 0], end: [8, 6], height: 2.7, thickness: 0.16 },
      w1_3: { id: 'w1_3', type: 'wall', parentId: 'level_1', start: [8, 6], end: [0, 6], height: 2.7, thickness: 0.16 },
      w1_4: { id: 'w1_4', type: 'wall', parentId: 'level_1', start: [0, 6], end: [0, 0], height: 2.7, thickness: 0.16 },
      r1_bed: { id: 'r1_bed', type: 'zone', parentId: 'level_1', name: 'Bedroom 2', polygon: [[0, 0], [4, 0], [4, 6], [0, 6]] },
      r1_b: { id: 'r1_b', type: 'zone', parentId: 'level_1', name: 'Upstairs Bath', polygon: [[4, 0], [8, 0], [8, 6], [4, 6]] },
    }

    nodes = applyChanges(nodes, electricalAgentOperations.electrical_autopopulate_nec(nodes as any, { levelId: 'level_0' }, { activeLevelId: 'level_0' }))
    const l1Circuits = new Set(
      Object.values(nodes)
        .filter((n) => n.type === 'electrical:device' && n.parentId === 'level_0')
        .map((n) => n.circuitNumber),
    )
    nodes = applyChanges(nodes, electricalAgentOperations.electrical_autopopulate_nec(nodes as any, { levelId: 'level_1' }, { activeLevelId: 'level_1' }))
    const l2Circuits = new Set(
      Object.values(nodes)
        .filter((n) => n.type === 'electrical:device' && n.parentId === 'level_1')
        .map((n) => n.circuitNumber),
    )

    for (const c of l2Circuits) {
      expect(l1Circuits.has(c)).toBe(false)
    }
  })

  test('diagonal HVAC duct subdivides into tight sub-AABBs and commercial EMT stays <= 360° (XTRADE-07, XTRADE-13)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Suite 100', height: 3.0 },
      duct_diag: {
        id: 'duct_diag',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        shape: 'round',
        diameter: 8,
        path: [[1, 2.8, 1], [7, 2.8, 7]],
      },
    }
    const obs = extractTradeObstacles(scene, 'level_0')
    expect(obs.length).toBeGreaterThan(2)

    const wetPipe = {
      id: 'pipe_wet',
      nodeId: 'pipe_wet',
      nodeType: 'plumbing:pipe-run',
      trade: 'plumbing' as const,
      priorityRank: 2 as const,
      box: { min: [13.7, 0, 3.1] as [number, number, number], max: [14.0, 3.0, 4.5] as [number, number, number] },
      requiredClearanceM: 0.05,
      label: 'wet wall pipe',
    }
    const walls = [
      { id: 'w1', start: [0, 0] as [number, number], end: [14, 0] as [number, number], height: 3.0, thickness: 0.16, doors: [], windows: [] },
      { id: 'w2', start: [14, 0] as [number, number], end: [14, 10] as [number, number], height: 3.0, thickness: 0.16, doors: [], windows: [] },
      { id: 'w3', start: [14, 10] as [number, number], end: [0, 10] as [number, number], height: 3.0, thickness: 0.16, doors: [], windows: [] },
      { id: 'w4', start: [0, 10] as [number, number], end: [0, 0] as [number, number], height: 3.0, thickness: 0.16, doors: [], windows: [] },
    ]
    const routed = routeElectricalRun([13.9, 1.12, 2.5], [13.9, 0.38, 5.0], [wetPipe], {
      walls,
      racewayType: 'emt',
      preferredChaseY: 2.55,
    })
    expect(routed.remainingClashes).toHaveLength(0)
    expect(countPathBendDegrees(routed.path).totalBendDegrees).toBeLessThanOrEqual(360)
  })

  test('hardwired 240V MEP equipment is exempt from NEC 210.8(A) receptacle GFCI and bathroom MEP aux stays dedicated (XTRADE-08, XTRADE-11)', () => {
    let nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Level 1', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_util: { id: 'r_util', type: 'zone', parentId: 'level_0', name: 'Utility', polygon: [[0, 0], [5, 0], [5, 8], [0, 8]] },
      r_bath: { id: 'r_bath', type: 'zone', parentId: 'level_0', name: 'Bathroom', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
      ahu_1: {
        id: 'ahu_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        name: 'Air Handler',
        position: [2.5, 0, 4],
        electricalDemand: { required: true, voltage: 240, poles: 2, breakerAmps: 60, loadVa: 10800, dedicatedCircuit: true, loadCategory: 'hvac-heating', label: 'Air Handler' },
      },
      erv_1: {
        id: 'erv_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        name: 'ERV',
        position: [2.5, 1.8, 2.2],
        electricalDemand: { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 180, dedicatedCircuit: false, gfciRequired: true, loadCategory: 'motor', label: 'ERV' },
      },
      fan_1: {
        id: 'fan_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        name: 'Bath Exhaust Fan',
        position: [7.5, 2.65, 4],
        electricalDemand: { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 120, dedicatedCircuit: false, gfciRequired: true, loadCategory: 'motor', label: 'Bath Exhaust Fan' },
      },
    }

    nodes = applyChanges(nodes, electricalAgentOperations.electrical_autopopulate_nec(nodes as any, { levelId: 'level_0' }, { activeLevelId: 'level_0' }))
    const audit = auditSceneElectrical(nodes)
    const gfciOrBathErrors = audit.findings.filter(
      (f) => f.severity === 'error' && (f.codeRef === 'NEC 210.8(A)' || f.codeRef === 'NEC 210.11(C)(3)'),
    )
    expect(gfciOrBathErrors).toHaveLength(0)
  })
})
