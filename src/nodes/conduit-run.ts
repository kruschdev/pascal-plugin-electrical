/**
 * `electrical:conduit-run` — 3D/2D Raceway & Cable Run (NM-B, MC, EMT, PVC Sch 40, RMC).
 * Automatically routes around higher-priority Plumbing, HVAC, and Structural obstacles.
 * Render-safe module: zero `@pascal-app/editor` imports.
 */

import {
  BaseNode,
  type FloorplanGeometry,
  type GeometryContext,
  type NodeDefinition,
  type NodePort,
  nodeType,
  objectId,
} from '@pascal-app/core'
import { z } from 'zod'
import { Group } from 'three'
import { buildConduitRunCad } from '../cad/equipment'
import type { ConduitTradeSize, RacewayType, WireGauge } from '../nec/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const ElectricalConduitRunNode = BaseNode.extend({
  id: objectId('eleccond'),
  type: nodeType('electrical:conduit-run'),
  path: z.array(Vec3Schema).min(2),
  occupancy: z.enum(['residential', 'commercial']).default('residential'),
  racewayType: z.enum(['nm-b', 'mc', 'emt', 'pvc-40', 'rmc']).default('emt'),
  tradeSize: z
    .enum(['1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"'])
    .default('3/4"'),
  conductorMaterial: z.enum(['cu', 'al']).default('cu'),
  insulationRating: z.enum(['60C', '75C', '90C']).default('90C'),
  wireGauge: z
    .enum([
      '14', '12', '10', '8', '6', '4', '3', '2', '1',
      '1/0', '2/0', '3/0', '4/0',
      '250kcmil', '300kcmil', '350kcmil', '400kcmil', '500kcmil', '600kcmil', '750kcmil',
    ])
    .default('12'),
  currentCarryingCount: z.number().int().min(1).max(60).default(2),
  totalConductorCount: z.number().int().min(2).max(80).default(3),
  ambientTempC: z.number().min(-20).max(80).default(30),
  rooftopExposed: z.boolean().default(false),
  inPlenum: z.boolean().default(false),
  panelId: z.string().optional(),
  targetDeviceId: z.string().optional(),
  circuitNumber: z.number().int().min(1).max(84).default(1),
  loadAmps: z.number().min(0).max(2000).default(16),
  continuous: z.boolean().default(false),
  voltage: z.number().min(12).max(600).default(120),
  phases: z.union([z.literal(1), z.literal(3)]).default(1),
})

export type ElectricalConduitRunNode = z.infer<typeof ElectricalConduitRunNode>

function colorForRun(node: ElectricalConduitRunNode): { hex: string; num: number } {
  if (node.voltage >= 277) return { hex: '#dc2626', num: 0xdc2626 } // 277/480V commercial red
  if (node.racewayType === 'nm-b') {
    const g = node.wireGauge as WireGauge
    if (g === '14') return { hex: '#e2e8f0', num: 0xe2e8f0 } // 14 AWG NM-B white
    if (g === '12') return { hex: '#eab308', num: 0xeab308 } // 12 AWG NM-B yellow
    if (g === '10') return { hex: '#f97316', num: 0xf97316 } // 10 AWG NM-B orange
    return { hex: '#1e293b', num: 0x1e293b } // 8/6 AWG NM-B black
  }
  if (node.racewayType === 'pvc-40') return { hex: '#64748b', num: 0x64748b }
  if (node.racewayType === 'mc') return { hex: '#94a3b8', num: 0x94a3b8 }
  return { hex: '#38bdf8', num: 0x38bdf8 } // EMT / RMC bright conduit blue-steel
}

export function getElectricalConduitRunPorts(node: ElectricalConduitRunNode): NodePort[] {
  const start = node.path[0]
  const end = node.path[node.path.length - 1]
  if (!start || !end) return []
  const second = node.path[1] ?? end
  const prev = node.path[node.path.length - 2] ?? start
  const startDir = normalizeDir(start, second, -1)
  const endDir = normalizeDir(prev, end, 1)
  return [
    { id: 'start', position: start, direction: startDir, diameter: 0.75, system: 'electrical' },
    { id: 'end', position: end, direction: endDir, diameter: 0.75, system: 'electrical' },
  ]
}

function normalizeDir(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  sign: 1 | -1,
): [number, number, number] {
  const dx = (b[0] - a[0]) * sign
  const dy = (b[1] - a[1]) * sign
  const dz = (b[2] - a[2]) * sign
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-5) return [0, 1, 0]
  return [dx / len, dy / len, dz / len]
}

export function buildElectricalConduitRunGeometry(
  node: ElectricalConduitRunNode,
  _ctx: GeometryContext,
): Group {
  return buildConduitRunCad({
    id: node.id,
    path: node.path,
    racewayType: node.racewayType as RacewayType,
    tradeSize: node.tradeSize as ConduitTradeSize,
    wireGauge: node.wireGauge as WireGauge,
    voltage: node.voltage,
  })
}

export function buildElectricalConduitRunFloorplan(
  node: ElectricalConduitRunNode,
  ctx: GeometryContext,
): FloorplanGeometry {
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const { hex } = colorForRun(node)
  const stroke = selected && view?.palette ? view.palette.selectedStroke : hex
  const children: FloorplanGeometry[] = []

  for (let i = 0; i < node.path.length - 1; i++) {
    const a = node.path[i]!
    const b = node.path[i + 1]!
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) < 1e-3) continue
    children.push({
      kind: 'line',
      x1: a[0],
      y1: a[2],
      x2: b[0],
      y2: b[2],
      stroke,
      strokeWidth: selected ? 0.04 : 0.025,
      strokeDasharray: (node.racewayType as RacewayType) === 'nm-b' ? '0.12 0.06' : undefined,
    })
  }

  const start = node.path[0]
  if (selected && start) {
    children.push({ kind: 'move-handle', point: [start[0], start[2]] })
  }

  return { kind: 'group', children }
}

export const electricalConduitRunRenderDefinition: NodeDefinition<typeof ElectricalConduitRunNode> = {
  kind: 'electrical:conduit-run',
  schemaVersion: 1,
  schema: ElectricalConduitRunNode,
  category: 'utility',
  distributionRole: 'run',
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Circuit Run',
    path: [
      [0, 1.5, 0],
      [0, 2.55, 0],
      [2, 2.55, 0],
      [2, 0.38, 0],
    ],
    occupancy: 'residential',
    racewayType: 'emt',
    tradeSize: '3/4"',
    conductorMaterial: 'cu',
    insulationRating: '90C',
    wireGauge: '12',
    currentCarryingCount: 2,
    totalConductorCount: 3,
    ambientTempC: 30,
    rooftopExposed: false,
    inPlenum: false,
    circuitNumber: 1,
    loadAmps: 16,
    continuous: false,
    voltage: 120,
    phases: 1,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildElectricalConduitRunGeometry,
  geometryKey: (n) => JSON.stringify([n.path, n.racewayType, n.tradeSize, n.wireGauge, n.voltage]),
  ports: getElectricalConduitRunPorts,
  floorplan: buildElectricalConduitRunFloorplan,
  presentation: {
    label: 'Conduit / Cable Run',
    description:
      'NEC-checked 3D conduit or cable run (NM-B, MC, EMT, PVC-40, RMC) that yields around plumbing, HVAC, and structural obstacles.',
    icon: { kind: 'iconify', name: 'lucide:cable' },
    paletteSection: 'structure',
  },
  mcp: {
    description:
      'Electrical conduit or cable homerun polyline in level-local meters. Tracks racewayType, tradeSize, wireGauge, ampacity derating, Ch. 9 fill, 360° bend count, and actual-length voltage drop.',
  },
}
