/**
 * `electrical:panel` — Residential (120/240V 1Φ) & Commercial (120/208V, 277/480V 3Φ) Panelboard.
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
import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
} from 'three'
import { buildPanelCad } from '../cad/equipment'
import { buildWiredPanelInteriorCad } from '../cad/panel-interior'
import { buildPanelSchedule } from '../nec/panel-schedule'
import { getWorkingClearance110_26, type VoltageSystem, type WorkingSpaceCondition } from '../nec/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const ElectricalPanelNode = BaseNode.extend({
  id: objectId('elecpanel'),
  type: nodeType('electrical:panel'),
  position: Vec3Schema.default([0, 1.52, 0]), // ~60" AFF center (keeps top breaker <= 6'-7" NEC 240.24(A))
  rotation: z.number().default(0), // Yaw radians; local +Z is front working face
  occupancy: z.enum(['residential', 'commercial']).default('residential'),
  voltageSystem: z.enum(['120/240V-1P', '120/208V-3P', '277/480V-3P']).default('120/240V-1P'),
  busRatingAmps: z.number().min(60).max(4000).default(200),
  mainBreakerAmps: z.number().min(60).max(4000).default(200),
  mainType: z.enum(['main-breaker', 'mlo']).default('main-breaker'),
  spaces: z.number().int().min(4).max(84).default(40),
  nemaRating: z.enum(['NEMA-1', 'NEMA-3R', 'NEMA-4X']).default('NEMA-1'),
  condition110_26: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  fedFromPanelId: z.string().optional(),
  solarBackfeedAmps: z.number().min(0).max(400).default(0),
  showClearanceZone: z.boolean().default(true),
  coverRemoved: z.boolean().default(false),
  width: z.number().min(0.25).max(1.2).default(0.38),
  depth: z.number().min(0.09).max(0.45).default(0.14),
  height: z.number().min(0.4).max(2.1).default(0.92),
})

export type ElectricalPanelNode = z.infer<typeof ElectricalPanelNode>

const VOLTAGE_ACCENT: Record<VoltageSystem, number> = {
  '120/240V-1P': 0xf59e0b, // amber (residential split-phase)
  '120/208V-3P': 0x2563eb, // blue (commercial 208V)
  '277/480V-3P': 0xdc2626, // red (commercial 480V)
}

export function getElectricalPanelPorts(node: ElectricalPanelNode): NodePort[] {
  const [x, y, zPos] = node.position
  const topY = y + node.height / 2
  const botY = y - node.height / 2
  return [
    {
      id: 'top-knockout',
      position: [x, topY, zPos],
      direction: [0, 1, 0],
      diameter: 2,
      system: 'electrical',
    },
    {
      id: 'bottom-knockout',
      position: [x, botY, zPos],
      direction: [0, -1, 0],
      diameter: 2,
      system: 'electrical',
    },
  ]
}

export function buildElectricalPanelGeometry(
  node: ElectricalPanelNode,
  _ctx: GeometryContext,
): Group {
  const group = new Group()
  group.name = `electrical-panel-${node.id}`

  const { width: w, height: h, depth: d } = node

  // CAD-detailed NEMA panelboard (cover closed or cover-off exposed copper busbars)
  const cad = node.coverRemoved
    ? buildWiredPanelInteriorCad({
        schedule: buildPanelSchedule(node, []),
        width: w,
        height: h,
        depth: d,
        nemaRating: node.nemaRating,
        viewMode: 'cover-off',
      })
    : buildPanelCad({
        width: w,
        height: h,
        depth: d,
        voltageSystem: node.voltageSystem as VoltageSystem,
        nemaRating: node.nemaRating,
        spaces: node.spaces,
        doorOpen: false,
      })
  group.add(cad)

  // NEC 110.26(A) clear working-space envelope in front of panel (+Z)
  if (node.showClearanceZone) {
    const clear = getWorkingClearance110_26(
      node.voltageSystem as VoltageSystem,
      node.condition110_26 as WorkingSpaceCondition,
    )
    const cw = Math.max(clear.widthM, w)
    const cd = clear.depthM
    const ch = Math.max(clear.heightM, h)
    const clearGeo = new BoxGeometry(cw, ch, cd)
    const clearMat = new MeshLambertMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    })
    const clearMesh = new Mesh(clearGeo, clearMat)
    // Rests on the floor (y = 0 in level space -> offset relative to panel center Y)
    const centerOffsetY = ch / 2 - node.position[1]
    clearMesh.position.set(0, centerOffsetY, d / 2 + cd / 2)
    clearMesh.name = 'nec-110-26-clearance'
    group.add(clearMesh)

    const edges = new LineSegments(
      new EdgesGeometry(clearGeo),
      new LineBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.65 }),
    )
    edges.position.copy(clearMesh.position)
    group.add(edges)
  }

  return group
}

export function buildElectricalPanelFloorplan(
  node: ElectricalPanelNode,
  ctx: GeometryContext,
): FloorplanGeometry {
  const [cx, , cz] = node.position
  const cos = Math.cos(node.rotation)
  const sin = Math.sin(node.rotation)
  const hw = node.width / 2
  const hd = node.depth / 2

  const corner = (lx: number, lz: number): FloorplanPoint => [
    cx + lx * cos + lz * sin,
    cz - lx * sin + lz * cos,
  ]

  const bodyPts: FloorplanPoint[] = [
    corner(-hw, -hd),
    corner(hw, -hd),
    corner(hw, hd),
    corner(-hw, hd),
  ]
  // Classic IEEE half-filled panelboard symbol (filled front half)
  const filledHalf: FloorplanPoint[] = [
    corner(-hw, 0),
    corner(hw, 0),
    corner(hw, hd),
    corner(-hw, hd),
  ]

  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const accentHex =
    node.voltageSystem === '277/480V-3P'
      ? '#dc2626'
      : node.voltageSystem === '120/208V-3P'
        ? '#2563eb'
        : '#d97706'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : accentHex

  const children: FloorplanGeometry[] = [
    {
      kind: 'polygon',
      points: bodyPts,
      fill: '#ffffff',
      stroke,
      strokeWidth: selected ? 0.03 : 0.02,
    },
    {
      kind: 'polygon',
      points: filledHalf,
      fill: stroke,
      stroke,
      strokeWidth: 0.01,
      opacity: 0.9,
    },
  ]

  if (node.showClearanceZone) {
    const clear = getWorkingClearance110_26(
      node.voltageSystem as VoltageSystem,
      node.condition110_26 as WorkingSpaceCondition,
    )
    const cw = Math.max(clear.widthM, node.width) / 2
    const clearPts: FloorplanPoint[] = [
      corner(-cw, hd),
      corner(cw, hd),
      corner(cw, hd + clear.depthM),
      corner(-cw, hd + clear.depthM),
    ]
    children.push({
      kind: 'polygon',
      points: clearPts,
      fill: '#f59e0b',
      fillOpacity: 0.1,
      stroke: '#d97706',
      strokeWidth: 0.015,
      strokeDasharray: '0.08 0.06',
      pointerEvents: 'none',
    })
  }

  if (selected) {
    children.push({ kind: 'move-handle', point: [cx, cz] })
  }

  return { kind: 'group', children }
}

export const electricalPanelRenderDefinition: NodeDefinition<typeof ElectricalPanelNode> = {
  kind: 'electrical:panel',
  schemaVersion: 1,
  schema: ElectricalPanelNode,
  category: 'utility',
  distributionRole: 'equipment',
  facingIndicator: true,
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'MDP-1',
    position: [0, 1.52, 0],
    rotation: 0,
    occupancy: 'residential',
    voltageSystem: '120/240V-1P',
    busRatingAmps: 200,
    mainBreakerAmps: 200,
    mainType: 'main-breaker',
    spaces: 40,
    nemaRating: 'NEMA-1',
    condition110_26: 2,
    solarBackfeedAmps: 0,
    showClearanceZone: true,
    coverRemoved: false,
    width: 0.38,
    depth: 0.14,
    height: 0.92,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'y', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildElectricalPanelGeometry,
  geometryKey: (n) =>
    JSON.stringify([
      n.voltageSystem,
      n.nemaRating,
      n.spaces,
      n.width,
      n.depth,
      n.height,
      n.condition110_26,
      n.showClearanceZone,
      n.coverRemoved,
      n.position[1],
    ]),
  ports: getElectricalPanelPorts,
  floorplan: buildElectricalPanelFloorplan,
  presentation: {
    label: 'Electrical Panel',
    description:
      'Residential (120/240V 1Φ) or Commercial (120/208V, 277/480V 3Φ) panelboard with live NEC 110.26 working-space envelope.',
    icon: { kind: 'iconify', name: 'lucide:zap' },
    paletteSection: 'structure',
  },
  mcp: {
    description:
      'Electrical panelboard / load center (residential 120/240V 1Φ or commercial 120/208V / 277/480V 3Φ). Tracks bus rating, main breaker, spaces, solar backfeed, and NEC 110.26 working space.',
  },
}
