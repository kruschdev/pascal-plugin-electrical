/**
 * `electrical:device` — Editable Residential & Commercial Electrical Devices,
 * Loads, Luminaires, EVSE, and Junction/Pull Boxes with live NEC 314.16 Box Fill metadata.
 * Render-safe module: zero `@pascal-app/editor` imports.
 */

import {
  BaseNode,
  type FloorplanGeometry,
  type FloorplanPoint,
  type GeometryContext,
  type NodeDefinition,
  type NodePort,
  nodeType,
  objectId,
} from '@pascal-app/core'
import { z } from 'zod'
import { Group } from 'three'
import { buildDeviceCad } from '../cad/equipment'
import type { BoxType, OccupancyType } from '../nec/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const DeviceKindEnum = z.enum([
  'duplex',
  'gfci',
  'afci',
  'dedicated-240v',
  'evse',
  'switch-1p',
  'switch-3way',
  'luminaire',
  'exit-sign',
  'motor-load',
  'junction-box',
  'solar-inverter',
  'battery-ess',
  'transfer-switch',
  'generator-inlet',
  'rapid-shutdown',
  'spd',
  'vfd',
  'dimmer',
  'usb-duplex',
  'weatherproof-gfci',
  'floor-box',
  'smoke-co',
  'ceiling-fan',
  'under-cabinet-led',
])

export type ElectricalDeviceKind = z.infer<typeof DeviceKindEnum>

export const ElectricalDeviceNode = BaseNode.extend({
  id: objectId('elecdev'),
  type: nodeType('electrical:device'),
  position: Vec3Schema.default([0, 0.38, 0]), // ~15" AFF receptacle default
  rotation: z.number().default(0),
  deviceKind: DeviceKindEnum.default('duplex'),
  occupancy: z.enum(['residential', 'commercial']).default('residential'),
  panelId: z.string().optional(),
  circuitNumber: z.number().int().min(1).max(84).default(1),
  poles: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  breakerAmps: z.number().min(15).max(400).default(20),
  loadVa: z.number().min(0).max(200000).default(180),
  continuous: z.boolean().default(false),
  isMotor: z.boolean().default(false),
  gfciProtected: z.boolean().default(false),
  afciProtected: z.boolean().default(false),
  boxType: z
    .enum([
      'single-gang-shallow',
      'single-gang-standard',
      'single-gang-deep',
      'two-gang-standard',
      'two-gang-deep',
      'three-gang-standard',
      '4-sq-1.25',
      '4-sq-1.5',
      '4-sq-2.125',
      '4-11-16-1.5',
      '4-11-16-2.125',
      '4-oct-1.5',
      '4-oct-2.125',
    ])
    .default('single-gang-standard'),
  wireGauge: z
    .enum([
      '18', '16', '14', '12', '10', '8', '6', '4', '3', '2', '1',
      '1/0', '2/0', '3/0', '4/0',
      '250kcmil', '300kcmil', '350kcmil', '400kcmil', '500kcmil', '600kcmil', '750kcmil',
    ])
    .default('12'),
  conductorCount: z.number().int().min(0).max(40).default(4),
  clampCount: z.number().int().min(0).max(6).default(1),
  yokeCount: z.number().int().min(0).max(4).default(1),
})

export type ElectricalDeviceNode = z.infer<typeof ElectricalDeviceNode>

const DEVICE_COLORS: Record<ElectricalDeviceKind, { hex: string; num: number }> = {
  duplex: { hex: '#f59e0b', num: 0xf59e0b },
  gfci: { hex: '#10b981', num: 0x10b981 },
  afci: { hex: '#3b82f6', num: 0x3b82f6 },
  'dedicated-240v': { hex: '#ef4444', num: 0xef4444 },
  evse: { hex: '#06b6d4', num: 0x06b6d4 },
  'switch-1p': { hex: '#8b5cf6', num: 0x8b5cf6 },
  'switch-3way': { hex: '#a855f7', num: 0xa855f7 },
  luminaire: { hex: '#facc15', num: 0xfacc15 },
  'exit-sign': { hex: '#dc2626', num: 0xdc2626 },
  'motor-load': { hex: '#ea580c', num: 0xea580c },
  'junction-box': { hex: '#64748b', num: 0x64748b },
  'solar-inverter': { hex: '#f59e0b', num: 0xf59e0b },
  'battery-ess': { hex: '#06b6d4', num: 0x06b6d4 },
  'transfer-switch': { hex: '#22c55e', num: 0x22c55e },
  'generator-inlet': { hex: '#eab308', num: 0xeab308 },
  'rapid-shutdown': { hex: '#dc2626', num: 0xdc2626 },
  spd: { hex: '#2563eb', num: 0x2563eb },
  vfd: { hex: '#ea580c', num: 0xea580c },
  dimmer: { hex: '#8b5cf6', num: 0x8b5cf6 },
  'usb-duplex': { hex: '#38bdf8', num: 0x38bdf8 },
  'weatherproof-gfci': { hex: '#10b981', num: 0x10b981 },
  'floor-box': { hex: '#d4a63a', num: 0xd4a63a },
  'smoke-co': { hex: '#0f172a', num: 0x0f172a },
  'ceiling-fan': { hex: '#facc15', num: 0xfacc15 },
  'under-cabinet-led': { hex: '#fde047', num: 0xfde047 },
}

export function getElectricalDevicePorts(node: ElectricalDeviceNode): NodePort[] {
  const [x, y, zPos] = node.position
  return [
    {
      id: 'conduit-entry',
      position: [x, y, zPos],
      direction: [0, 1, 0],
      diameter: 0.75,
      system: 'electrical',
    },
  ]
}

export function buildElectricalDeviceGeometry(
  node: ElectricalDeviceNode,
  _ctx: GeometryContext,
): Group {
  const group = buildDeviceCad({
    deviceKind: node.deviceKind,
    boxType: node.boxType as BoxType,
    occupancy: node.occupancy as OccupancyType,
    breakerAmps: node.breakerAmps,
  })
  group.name = `electrical-device-${node.id}`
  return group
}

export function buildElectricalDeviceFloorplan(
  node: ElectricalDeviceNode,
  ctx: GeometryContext,
): FloorplanGeometry {
  const [x, , zPos] = node.position
  const cos = Math.cos(node.rotation)
  const sin = Math.sin(node.rotation)
  const pt = (lx: number, lz: number): FloorplanPoint => [
    x + lx * cos + lz * sin,
    zPos - lx * sin + lz * cos,
  ]
  const rectPts = (hw: number, hd: number): FloorplanPoint[] => [
    pt(-hw, -hd),
    pt(hw, -hd),
    pt(hw, hd),
    pt(-hw, hd),
  ]
  const rotLine = (
    lx1: number,
    lz1: number,
    lx2: number,
    lz2: number,
    lineStroke: string,
    strokeWidth: number,
  ): FloorplanGeometry => {
    const [x1, y1] = pt(lx1, lz1)
    const [x2, y2] = pt(lx2, lz2)
    return { kind: 'line', x1, y1, x2, y2, stroke: lineStroke, strokeWidth }
  }

  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const baseColor = DEVICE_COLORS[node.deviceKind]?.hex ?? '#f59e0b'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : baseColor

  const children: FloorplanGeometry[] = []

  if (node.deviceKind === 'junction-box') {
    children.push({
      kind: 'polygon',
      points: rectPts(0.09, 0.09),
      fill: '#e2e8f0',
      stroke,
      strokeWidth: 0.02,
    })
  } else if (
    node.deviceKind === 'solar-inverter' ||
    node.deviceKind === 'battery-ess' ||
    node.deviceKind === 'transfer-switch' ||
    node.deviceKind === 'generator-inlet' ||
    node.deviceKind === 'rapid-shutdown' ||
    node.deviceKind === 'spd' ||
    node.deviceKind === 'vfd'
  ) {
    const hw =
      node.deviceKind === 'battery-ess'
        ? 0.36
        : node.deviceKind === 'solar-inverter' || node.deviceKind === 'transfer-switch'
          ? 0.21
          : 0.12
    const hd = 0.09
    children.push(
      {
        kind: 'polygon',
        points: rectPts(hw, hd),
        fill: '#1e293b',
        stroke,
        strokeWidth: 0.02,
      },
      rotLine(-hw, -hd, hw, hd, stroke, 0.014),
    )
  } else if (node.deviceKind === 'evse') {
    // Wall-mounted Level 2 EVSE charger box + lightning bolt & side holster indicator
    const hw = 0.12
    const hd = 0.065
    children.push(
      {
        kind: 'polygon',
        points: rectPts(hw, hd),
        fill: '#ecfeff',
        stroke,
        strokeWidth: 0.02,
      },
      {
        kind: 'polyline',
        points: [pt(0.02, -0.045), pt(-0.025, 0.005), pt(0.015, 0.005), pt(-0.02, 0.045)],
        fill: 'none',
        stroke,
        strokeWidth: 0.016,
      },
      rotLine(hw, 0, hw + 0.04, 0, stroke, 0.02),
    )
  } else if (node.deviceKind === 'exit-sign') {
    // Slim EXIT sign rectangle with red fill, directional arrow, and twin emergency flood heads
    const hw = 0.16
    const hd = 0.035
    const [hlx, hlz] = pt(-hw - 0.025, 0.015)
    const [hrx, hrz] = pt(hw + 0.025, 0.015)
    children.push(
      {
        kind: 'polygon',
        points: rectPts(hw, hd),
        fill: '#dc2626',
        fillOpacity: 0.85,
        stroke,
        strokeWidth: 0.018,
      },
      rotLine(-0.09, 0, 0.09, 0, '#ffffff', 0.014),
      rotLine(0.04, -0.02, 0.09, 0, '#ffffff', 0.014),
      rotLine(0.04, 0.02, 0.09, 0, '#ffffff', 0.014),
      { kind: 'circle', cx: hlx, cy: hlz, r: 0.022, fill: '#ffffff', stroke, strokeWidth: 0.012 },
      { kind: 'circle', cx: hrx, cy: hrz, r: 0.022, fill: '#ffffff', stroke, strokeWidth: 0.012 },
    )
  } else if (node.deviceKind === 'motor-load') {
    // IEEE motor load symbol: circle with geometric 'M' & shaft/rotor terminal lines
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.16, fill: '#fff7ed', stroke, strokeWidth: 0.022 },
      rotLine(-0.16, 0, -0.22, 0, stroke, 0.018),
      rotLine(0.16, 0, 0.22, 0, stroke, 0.018),
      {
        kind: 'polyline',
        points: [
          pt(-0.075, 0.065),
          pt(-0.075, -0.065),
          pt(0, 0.015),
          pt(0.075, -0.065),
          pt(0.075, 0.065),
        ],
        fill: 'none',
        stroke,
        strokeWidth: 0.018,
      },
    )
  } else if (node.deviceKind === 'ceiling-fan') {
    children.push({ kind: 'circle', cx: x, cy: zPos, r: 0.16, fill: '#fef9c3', stroke, strokeWidth: 0.02 })
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5
      children.push(rotLine(0, 0, Math.cos(a) * 0.45, Math.sin(a) * 0.45, stroke, 0.018))
    }
  } else if (node.deviceKind === 'smoke-co') {
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.12, fill: '#f8fafc', stroke, strokeWidth: 0.02 },
      { kind: 'circle', cx: x, cy: zPos, r: 0.055, fill: '#f8fafc', stroke, strokeWidth: 0.014 },
    )
  } else if (node.deviceKind === 'under-cabinet-led') {
    children.push({
      kind: 'polygon',
      points: rectPts(0.3, 0.045),
      fill: '#fef08a',
      stroke,
      strokeWidth: 0.016,
    })
  } else if (node.deviceKind === 'floor-box') {
    children.push(
      {
        kind: 'polygon',
        points: rectPts(0.085, 0.085),
        fill: '#fef3c7',
        stroke,
        strokeWidth: 0.02,
      },
      { kind: 'circle', cx: x, cy: zPos, r: 0.045, fill: '#ffffff', stroke, strokeWidth: 0.015 },
    )
  } else if (node.deviceKind === 'luminaire') {
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.14, fill: '#fef9c3', stroke, strokeWidth: 0.02 },
      rotLine(-0.14, 0, 0.14, 0, stroke, 0.015),
      rotLine(0, -0.14, 0, 0.14, stroke, 0.015),
    )
  } else if (node.deviceKind === 'switch-1p' || node.deviceKind === 'switch-3way' || node.deviceKind === 'dimmer') {
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.08, fill: '#f3e8ff', stroke, strokeWidth: 0.02 },
      rotLine(0, 0, 0.14, -0.14, stroke, 0.02),
    )
  } else {
    // Standard NEC duplex / GFCI / AFCI / dedicated receptacle symbol (circle + rotated twin bars)
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.09, fill: '#ffffff', stroke, strokeWidth: 0.02 },
      rotLine(-0.04, -0.12, -0.04, 0.12, stroke, 0.015),
      rotLine(0.04, -0.12, 0.04, 0.12, stroke, 0.015),
    )
  }

  if (selected) {
    children.push({ kind: 'move-handle', point: [x, zPos] })
  }

  return { kind: 'group', children }
}

export const electricalDeviceRenderDefinition: NodeDefinition<typeof ElectricalDeviceNode> = {
  kind: 'electrical:device',
  schemaVersion: 1,
  schema: ElectricalDeviceNode,
  category: 'utility',
  distributionRole: 'terminal',
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Receptacle',
    position: [0, 0.38, 0],
    rotation: 0,
    deviceKind: 'duplex',
    occupancy: 'residential',
    circuitNumber: 1,
    poles: 1,
    breakerAmps: 20,
    loadVa: 180,
    continuous: false,
    isMotor: false,
    gfciProtected: false,
    afciProtected: false,
    boxType: 'single-gang-standard',
    wireGauge: '12',
    conductorCount: 4,
    clampCount: 1,
    yokeCount: 1,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'y', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildElectricalDeviceGeometry,
  geometryKey: (n) => JSON.stringify([n.deviceKind, n.boxType, n.occupancy, n.breakerAmps]),
  ports: getElectricalDevicePorts,
  floorplan: buildElectricalDeviceFloorplan,
  presentation: {
    label: 'Electrical Device',
    description:
      'Receptacle, GFCI/AFCI, switch, luminaire, EVSE, motor/dedicated load, or junction box with NEC 314.16 box-fill tracking.',
    icon: { kind: 'iconify', name: 'lucide:plug' },
    paletteSection: 'structure',
  },
  mcp: {
    description:
      'Editable electrical device or junction box assigned to a panel/circuit. Carries loadVa, breakerAmps, poles, GFCI/AFCI status, and NEC 314.16 box-fill parameters.',
  },
}
