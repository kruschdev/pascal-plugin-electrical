/**
 * `electrical:device` — Editable Residential & Commercial Electrical Devices,
 * Loads, Luminaires, EVSE, and Junction/Pull Boxes with live NEC 314.16 Box Fill metadata.
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
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial } from 'three'

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
  wireGauge: z.enum(['18', '16', '14', '12', '10', '8', '6']).default('12'),
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
  const group = new Group()
  group.name = `electrical-device-${node.id}`
  const color = DEVICE_COLORS[node.deviceKind]?.num ?? 0xf59e0b

  if (node.deviceKind === 'luminaire') {
    const housing = new Mesh(
      new CylinderGeometry(0.16, 0.16, 0.04, 16),
      new MeshLambertMaterial({ color: 0xfef08a }),
    )
    group.add(housing)
    return group
  }

  if (node.deviceKind === 'evse') {
    const body = new Mesh(
      new BoxGeometry(0.24, 0.36, 0.12),
      new MeshLambertMaterial({ color: 0x0e7490 }),
    )
    const statusBar = new Mesh(
      new BoxGeometry(0.16, 0.03, 0.015),
      new MeshLambertMaterial({ color: 0x22d3ee }),
    )
    statusBar.position.set(0, 0.08, 0.065)
    group.add(body, statusBar)
    return group
  }

  if (node.deviceKind === 'junction-box') {
    const jbox = new Mesh(
      new BoxGeometry(0.11, 0.11, 0.055),
      new MeshLambertMaterial({ color: 0x64748b }),
    )
    group.add(jbox)
    return group
  }

  if (node.deviceKind === 'exit-sign') {
    const sign = new Mesh(
      new BoxGeometry(0.32, 0.2, 0.05),
      new MeshLambertMaterial({ color: 0xdc2626 }),
    )
    group.add(sign)
    return group
  }

  // Standard wall box + color-coded faceplate
  const box = new Mesh(
    new BoxGeometry(0.075, 0.115, 0.065),
    new MeshLambertMaterial({ color: 0x475569 }),
  )
  const plate = new Mesh(
    new BoxGeometry(0.082, 0.125, 0.008),
    new MeshLambertMaterial({ color }),
  )
  plate.position.set(0, 0, 0.036)
  group.add(box, plate)
  return group
}

export function buildElectricalDeviceFloorplan(
  node: ElectricalDeviceNode,
  ctx: GeometryContext,
): FloorplanGeometry {
  const [x, , zPos] = node.position
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const baseColor = DEVICE_COLORS[node.deviceKind]?.hex ?? '#f59e0b'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : baseColor

  const children: FloorplanGeometry[] = []

  if (node.deviceKind === 'junction-box') {
    const h = 0.09
    children.push({
      kind: 'polygon',
      points: [
        [x - h, zPos - h],
        [x + h, zPos - h],
        [x + h, zPos + h],
        [x - h, zPos + h],
      ],
      fill: '#e2e8f0',
      stroke,
      strokeWidth: 0.02,
    })
  } else if (node.deviceKind === 'luminaire') {
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.14, fill: '#fef9c3', stroke, strokeWidth: 0.02 },
      { kind: 'line', x1: x - 0.14, y1: zPos, x2: x + 0.14, y2: zPos, stroke, strokeWidth: 0.015 },
      { kind: 'line', x1: x, y1: zPos - 0.14, x2: x, y2: zPos + 0.14, stroke, strokeWidth: 0.015 },
    )
  } else if (node.deviceKind === 'switch-1p' || node.deviceKind === 'switch-3way') {
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.08, fill: '#f3e8ff', stroke, strokeWidth: 0.02 },
      {
        kind: 'line',
        x1: x,
        y1: zPos,
        x2: x + 0.14,
        y2: zPos - 0.14,
        stroke,
        strokeWidth: 0.02,
      },
    )
  } else {
    // Standard NEC duplex / GFCI / AFCI / dedicated receptacle symbol (circle + twin bars)
    children.push(
      { kind: 'circle', cx: x, cy: zPos, r: 0.09, fill: '#ffffff', stroke, strokeWidth: 0.02 },
      { kind: 'line', x1: x - 0.04, y1: zPos - 0.12, x2: x - 0.04, y2: zPos + 0.12, stroke, strokeWidth: 0.015 },
      { kind: 'line', x1: x + 0.04, y1: zPos - 0.12, x2: x + 0.04, y2: zPos + 0.12, stroke, strokeWidth: 0.015 },
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
  geometryKey: (n) => JSON.stringify([n.deviceKind]),
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
