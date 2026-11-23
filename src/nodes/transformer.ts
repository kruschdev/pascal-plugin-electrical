/**
 * `electrical:transformer` — Commercial Step-Down Dry-Type Transformer (480V -> 120/208V 3Φ).
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
import { getWorkingClearance110_26 } from '../nec/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const ElectricalTransformerNode = BaseNode.extend({
  id: objectId('electx'),
  type: nodeType('electrical:transformer'),
  position: Vec3Schema.default([0, 0, 0]),
  rotation: z.number().default(0),
  kvaRating: z.number().min(15).max(1000).default(75),
  primaryVoltage: z.number().default(480),
  secondaryVoltage: z.number().default(208),
  fedFromPanelId: z.string().optional(),
  impedancePct: z.number().min(1).max(10).default(4.5),
  nemaRating: z.enum(['NEMA-1', 'NEMA-2', 'NEMA-3R']).default('NEMA-2'),
  showClearanceZone: z.boolean().default(true),
  width: z.number().min(0.4).max(1.8).default(0.76),
  depth: z.number().min(0.4).max(1.5).default(0.64),
  height: z.number().min(0.5).max(1.8).default(0.95),
})

export type ElectricalTransformerNode = z.infer<typeof ElectricalTransformerNode>

export function getElectricalTransformerPorts(node: ElectricalTransformerNode): NodePort[] {
  const [x, y, zPos] = node.position
  return [
    {
      id: 'primary-480v',
      position: [x - node.width * 0.25, y + node.height, zPos],
      direction: [0, 1, 0],
      diameter: 2,
      system: 'electrical',
    },
    {
      id: 'secondary-208v',
      position: [x + node.width * 0.25, y + node.height, zPos],
      direction: [0, 1, 0],
      diameter: 2.5,
      system: 'electrical',
    },
  ]
}

export function buildElectricalTransformerGeometry(
  node: ElectricalTransformerNode,
  _ctx: GeometryContext,
): Group {
  const group = new Group()
  group.name = `electrical-transformer-${node.id}`
  const { width: w, height: h, depth: d } = node

  const body = new Mesh(
    new BoxGeometry(w, h, d),
    new MeshLambertMaterial({ color: 0x475569 }),
  )
  body.position.set(0, h / 2, 0)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // Red HV top cap indicator (480V primary)
  const cap = new Mesh(
    new BoxGeometry(w * 0.92, 0.05, d * 0.92),
    new MeshLambertMaterial({ color: 0xdc2626 }),
  )
  cap.position.set(0, h + 0.025, 0)
  group.add(cap)

  if (node.showClearanceZone) {
    const clear = getWorkingClearance110_26('277/480V-3P', 2)
    const cw = Math.max(clear.widthM, w)
    const cd = clear.depthM
    const ch = clear.heightM
    const clearGeo = new BoxGeometry(cw, ch, cd)
    const clearMesh = new Mesh(
      clearGeo,
      new MeshLambertMaterial({
        color: 0xdc2626,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    )
    clearMesh.position.set(0, ch / 2, d / 2 + cd / 2)
    group.add(clearMesh)

    const edges = new LineSegments(
      new EdgesGeometry(clearGeo),
      new LineBasicMaterial({ color: 0xdc2626, transparent: true, opacity: 0.6 }),
    )
    edges.position.copy(clearMesh.position)
    group.add(edges)
  }

  return group
}

export function buildElectricalTransformerFloorplan(
  node: ElectricalTransformerNode,
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
  const pts: FloorplanPoint[] = [
    corner(-hw, -hd),
    corner(hw, -hd),
    corner(hw, hd),
    corner(-hw, hd),
  ]

  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const stroke = selected && view?.palette ? view.palette.selectedStroke : '#dc2626'

  const children: FloorplanGeometry[] = [
    {
      kind: 'polygon',
      points: pts,
      fill: '#fef2f2',
      stroke,
      strokeWidth: selected ? 0.03 : 0.02,
    },
    { kind: 'circle', cx: cx - hw * 0.3, cy: cz, r: Math.min(hw, hd) * 0.42, stroke, strokeWidth: 0.015 },
    { kind: 'circle', cx: cx + hw * 0.3, cy: cz, r: Math.min(hw, hd) * 0.42, stroke, strokeWidth: 0.015 },
  ]
  if (selected) children.push({ kind: 'move-handle', point: [cx, cz] })
  return { kind: 'group', children }
}

export const electricalTransformerRenderDefinition: NodeDefinition<typeof ElectricalTransformerNode> = {
  kind: 'electrical:transformer',
  schemaVersion: 1,
  schema: ElectricalTransformerNode,
  category: 'utility',
  distributionRole: 'equipment',
  facingIndicator: true,
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'TX-1 (75 kVA)',
    position: [0, 0, 0],
    rotation: 0,
    kvaRating: 75,
    primaryVoltage: 480,
    secondaryVoltage: 208,
    impedancePct: 4.5,
    nemaRating: 'NEMA-2',
    showClearanceZone: true,
    width: 0.76,
    depth: 0.64,
    height: 0.95,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    floorPlaced: {
      footprint: (node: unknown) => {
        const n = node as ElectricalTransformerNode
        return {
          dimensions: [n.width, n.height, n.depth] as [number, number, number],
          rotation: [0, n.rotation, 0] as [number, number, number],
        }
      },
    },
  },
  geometry: buildElectricalTransformerGeometry,
  geometryKey: (n) => JSON.stringify([n.width, n.depth, n.height, n.kvaRating, n.showClearanceZone]),
  ports: getElectricalTransformerPorts,
  floorplan: buildElectricalTransformerFloorplan,
  presentation: {
    label: 'Step-Down Transformer',
    description:
      'Commercial dry-type step-down transformer (480V -> 120/208V 3Φ) with NEC 450.3(B) FLA/OCPD sizing & 110.26 clearance.',
    icon: { kind: 'iconify', name: 'lucide:cpu' },
    paletteSection: 'structure',
  },
  mcp: {
    description:
      'Commercial dry-type step-down transformer (e.g., 480V 3Φ primary to 120/208V 3Φ secondary). Computes primary/secondary FLA and NEC Table 450.3(B) OCPD sizing.',
  },
}
