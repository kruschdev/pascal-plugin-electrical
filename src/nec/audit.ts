/**
 * Live Pascal Scene NEC & Cross-Trade Compliance Auditor.
 *
 * Audits every `electrical:*` node against the live Pascal scene graph (`wall`, `zone`,
 * `item`, `cabinet`, `pipe-*`, `duct-*`, `hvac-equipment`, `beam`, `column`):
 * - NEC 110.26(A) Panel / Transformer Working Space 3D Clearance
 * - NEC 110.26(E) Dedicated Electrical Space (no plumbing pipes / ducts directly over panels)
 * - NEC 240.24(A)/(D)/(E)/(F) & 312.2 / 450.22 Prohibited Panel/Transformer Locations & Height (> 6'-7", bathrooms, closets, stairways, indoor NEMA outdoors)
 * - NEC 406.9(C), 404.4(C), 410.10(D), 406.5(E), 210.52(C), 410.16(C) & 210.11(C)(1)/(3) Restricted Zones & Dedicated-Circuit Isolation (tub/shower, stove, sink, closet lighting, mixed bath/kitchen circuits)
 * - Trade-Priority Clashes (electrical conduit/cable must route around plumbing, HVAC, structural)
 * - NEC 358.26 / 344.26 / 352.26 Raceway > 360° Bends Between Pull Points
 * - NEC 334.12 / 300.22(C) Commercial & Plenum NM-B Prohibition
 * - NEC 310.16 / 310.15 / 240.4(D) Ampacity, Derating & Small-Conductor OCPD Caps
 * - NEC Chapter 9 Conduit Fill (40% / 53% / 31% / 60% Nipple)
 * - NEC 314.16 Box Fill Volume Compliance
 * - NEC 210.19 / 215.2 Voltage Drop (measured from actual 3D run length)
 * - NEC 210.8(A)/(B) GFCI & NEC 210.12(A) AFCI Zone Rules
 * - NEC 220 Panel Bus Overload, Phase Imbalance & NEC 705.12(B)(3)(2) Solar 120% Busbar Rule
 */

import type { SceneNodeLike } from './load-calc'
import { buildPanelSchedule } from './panel-schedule'
import {
  type Aabb3,
  type TradeObstacle,
  type Vec3,
  belongsToLevel,
  countPathBendDegrees,
  detectRunTradeClashes,
  extractRoutingCavities,
  extractTradeObstacles,
  getHvacEquipmentBox,
  getHvacPlenumBox,
  getPlumbingFixtureBox,
  getStructuralColumnBox,
  polylineLengthM,
  resolveNodeLevelId,
} from './routing'
import {
  calculateBoxFill,
  calculateConduitFill,
  calculateDeratedAmpacity,
  calculateVoltageDrop,
} from './sizing'
import {
  type BoxType,
  type ConduitTradeSize,
  type ConductorMaterial,
  INCHES_TO_METERS,
  type InsulationRating,
  METERS_TO_FEET,
  NEC_220_RESIDENTIAL,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  type WorkingSpaceCondition,
  clampToBoxFillGauge,
  clampToBranchWireGauge,
  getWorkingClearance110_26,
  isZeroYokeDeviceKind,
  round2,
  usesSeparateRoughInBox,
} from './tables'

export type AuditSeverity = 'error' | 'warning' | 'info'

export type NecAuditFinding = {
  id: string
  severity: AuditSeverity
  codeRef: string
  category:
    | 'working-space'
    | 'dedicated-space'
    | 'prohibited-location'
    | 'trade-clash'
    | 'raceway-bends'
    | 'wiring-method'
    | 'ampacity'
    | 'conduit-fill'
    | 'box-fill'
    | 'voltage-drop'
    | 'gfci-afci'
    | 'panel-load'
    | 'solar-busbar'
    | 'life-safety'
  title: string
  message: string
  nodeIds: string[]
  suggestedFix?: string
}

export type NecSceneAuditReport = {
  passed: boolean
  errorCount: number
  warningCount: number
  infoCount: number
  panelCount: number
  deviceCount: number
  conduitRunCount: number
  transformerCount: number
  findings: NecAuditFinding[]
}

function pointInPolygon2D(px: number, pz: number, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function getZoneAt(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  x: number,
  z: number,
  levelId: string | null = null,
  preFilteredZones?: readonly SceneNodeLike[],
): SceneNodeLike | null {
  const candidates = preFilteredZones ?? Object.values(nodes)
  for (const n of candidates) {
    if (!preFilteredZones && n.type !== 'zone') continue
    if (!belongsToLevel(nodes, n, levelId)) continue
    if (Array.isArray(n.polygon) && n.polygon.length >= 3) {
      if (pointInPolygon2D(x, z, n.polygon as [number, number][])) return n
    }
  }
  return null
}

function toVec3(v: unknown): Vec3 | null {
  if (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number'
  ) {
    return [v[0], v[1], v[2]]
  }
  return null
}

export type OrientedPrismY = {
  centerX: number
  centerZ: number
  cos: number
  sin: number
  lxMin: number
  lxMax: number
  lzMin: number
  lzMax: number
  yMin: number
  yMax: number
}

export function prismIntersectsAabb(prism: OrientedPrismY, box: Aabb3): boolean {
  if (box.max[1] < prism.yMin || box.min[1] > prism.yMax) return false

  // 2D Separating Axis Theorem (SAT) in XZ:
  // 1) Project AABB corners onto equipment's local (lx, lz) axes
  const boxCorners: [number, number][] = [
    [box.min[0], box.min[2]],
    [box.max[0], box.min[2]],
    [box.max[0], box.max[2]],
    [box.min[0], box.max[2]],
  ]
  let minLx = Number.POSITIVE_INFINITY
  let maxLx = Number.NEGATIVE_INFINITY
  let minLz = Number.POSITIVE_INFINITY
  let maxLz = Number.NEGATIVE_INFINITY
  for (const [wx, wz] of boxCorners) {
    const dx = wx - prism.centerX
    const dz = wz - prism.centerZ
    const lx = dx * prism.cos - dz * prism.sin
    const lz = dx * prism.sin + dz * prism.cos
    if (lx < minLx) minLx = lx
    if (lx > maxLx) maxLx = lx
    if (lz < minLz) minLz = lz
    if (lz > maxLz) maxLz = lz
  }
  if (maxLx < prism.lxMin || minLx > prism.lxMax) return false
  if (maxLz < prism.lzMin || minLz > prism.lzMax) return false

  // 2) Project oriented prism corners onto world (X, Z) axes
  const prismCorners: [number, number][] = [
    [prism.lxMin, prism.lzMin],
    [prism.lxMax, prism.lzMin],
    [prism.lxMax, prism.lzMax],
    [prism.lxMin, prism.lzMax],
  ]
  let minWx = Number.POSITIVE_INFINITY
  let maxWx = Number.NEGATIVE_INFINITY
  let minWz = Number.POSITIVE_INFINITY
  let maxWz = Number.NEGATIVE_INFINITY
  for (const [lx, lz] of prismCorners) {
    const wx = prism.centerX + lx * prism.cos + lz * prism.sin
    const wz = prism.centerZ - lx * prism.sin + lz * prism.cos
    if (wx < minWx) minWx = wx
    if (wx > maxWx) maxWx = wx
    if (wz < minWz) minWz = wz
    if (wz > maxWz) maxWz = wz
  }
  if (maxWx < box.min[0] || minWx > box.max[0]) return false
  if (maxWz < box.min[2] || minWz > box.max[2]) return false

  return true
}

export function getEquipmentSpacePrisms(
  equip: SceneNodeLike,
  kind: 'panel' | 'transformer',
): {
  workingPrism: OrientedPrismY
  dedicatedOverheadPrism: OrientedPrismY
  depthIn: number
} {
  const pos: Vec3 = toVec3(equip.position) ?? (kind === 'transformer' ? [0, 0, 0] : [0, 1.5, 0])
  const rotY = typeof equip.rotation === 'number' ? equip.rotation : 0
  const w = typeof equip.width === 'number' ? equip.width : kind === 'transformer' ? 0.76 : 0.4
  const d = typeof equip.depth === 'number' ? equip.depth : kind === 'transformer' ? 0.64 : 0.14
  const h = typeof equip.height === 'number' ? equip.height : kind === 'transformer' ? 0.95 : 0.9

  let voltageSystem: VoltageSystem = '120/240V-1P'
  if (kind === 'transformer') {
    const primaryV = typeof equip.primaryVoltage === 'number' ? equip.primaryVoltage : 480
    const secondaryV = typeof equip.secondaryVoltage === 'number' ? equip.secondaryVoltage : 208
    voltageSystem = primaryV > 250 || secondaryV > 250 ? '277/480V-3P' : '120/240V-1P'
  } else if (equip.voltageSystem === '120/208V-3P' || equip.voltageSystem === '277/480V-3P') {
    voltageSystem = equip.voltageSystem
  }

  const condition: WorkingSpaceCondition =
    equip.condition110_26 === 1 || equip.condition110_26 === 3 ? equip.condition110_26 : 2

  const clearance = getWorkingClearance110_26(voltageSystem, condition)
  const clearW = Math.max(clearance.widthM, w)
  const clearD = clearance.depthM
  const clearH = Math.max(clearance.heightM, h)
  const cos = Math.cos(rotY)
  const sin = Math.sin(rotY)
  const baseY = kind === 'transformer' ? pos[1] : Math.max(0, pos[1] - 1.52)
  const topY = kind === 'transformer' ? pos[1] + h : pos[1] + h / 2
  const zFront = d / 2 + 0.02

  const workingPrism: OrientedPrismY = {
    centerX: pos[0],
    centerZ: pos[2],
    cos,
    sin,
    lxMin: -clearW / 2,
    lxMax: clearW / 2,
    lzMin: zFront,
    lzMax: zFront + clearD,
    yMin: baseY,
    yMax: baseY + clearH,
  }

  // Dedicated overhead electrical space: equipment footprint extending 6 ft (1.829 m) above top
  const dedicatedOverheadPrism: OrientedPrismY = {
    centerX: pos[0],
    centerZ: pos[2],
    cos,
    sin,
    lxMin: -w / 2,
    lxMax: w / 2,
    lzMin: -d / 2,
    lzMax: d / 2,
    yMin: topY,
    yMax: topY + 1.829,
  }

  return { workingPrism, dedicatedOverheadPrism, depthIn: clearance.depthIn }
}

export function extractObstructionBox(node: SceneNodeLike): Aabb3 | null {
  const pos = toVec3(node.position)
  if (!pos) return null
  const [x, y, z] = pos

  if (node.type === 'structural:column') {
    return getStructuralColumnBox(node)
  }

  if (node.type === 'plumbing:manifold') {
    return {
      min: [x - 0.24, y - 0.35, z - 0.24],
      max: [x + 0.24, y + 0.35, z + 0.24],
    }
  }

  if (node.type === 'plumbing:fixture') {
    return getPlumbingFixtureBox(node)
  }

  if (node.type === 'hvac:plenum') {
    return getHvacPlenumBox(node)
  }

  const asset =
    node.asset && typeof node.asset === 'object'
      ? (node.asset as Record<string, unknown>)
      : null
  const explicitDims = toVec3(node.dimensions) ?? toVec3(asset?.dimensions) ?? toVec3(node.size)

  if (node.type === 'plumbing:equipment' && !explicitDims) {
    const eqKind = typeof node.equipmentKind === 'string' ? node.equipmentKind : ''
    let halfW = typeof node.width === 'number' ? node.width / 2 : 0.3
    let halfD = typeof node.depth === 'number' ? node.depth / 2 : halfW
    let minY = y
    let maxY = y + (typeof node.height === 'number' ? node.height : 1.55)
    if (typeof node.width !== 'number' && typeof node.height !== 'number' && typeof node.depth !== 'number') {
      if (eqKind === 'expansion-tank') {
        halfW = 0.12
        halfD = 0.12
        minY = y - 0.15
        maxY = y + 0.25
      } else if (eqKind === 'water-heater-tankless-gas') {
        halfW = 0.22
        halfD = 0.22
        minY = y + 0.9
        maxY = y + 1.95
      } else if (
        eqKind === 'recirc-pump' ||
        eqKind === 'main-shutoff-prv' ||
        eqKind === 'backwater-valve' ||
        eqKind === 'gas-meter'
      ) {
        halfW = 0.16
        halfD = 0.16
        minY = y
        maxY = y + 0.45
      } else if (eqKind === 'sump-pump' || eqKind === 'sewage-ejector') {
        halfW = 0.24
        halfD = 0.24
        minY = y
        maxY = y + 0.55
      } else if (eqKind === 'water-softener' || eqKind === 'pressure-tank') {
        halfW = 0.24
        halfD = 0.24
        minY = y
        maxY = y + 1.35
      }
    }
    return {
      min: [x - halfW, minY, z - halfD],
      max: [x + halfW, maxY, z + halfD],
    }
  }

  if (node.type === 'hvac:equipment' || node.type === 'hvac-equipment') {
    return getHvacEquipmentBox(node)
  }

  const dims: Vec3 = explicitDims ?? [
    typeof node.width === 'number' ? node.width : 0.6,
    typeof node.height === 'number' ? node.height : 0.9,
    typeof node.depth === 'number' ? node.depth : 0.6,
  ]
  const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
  const cos = Math.abs(Math.cos(rot))
  const sin = Math.abs(Math.sin(rot))
  const hw = (dims[0]! * cos + dims[2]! * sin) / 2
  const hd = (dims[0]! * sin + dims[2]! * cos) / 2
  return {
    min: [x - hw, y, z - hd],
    max: [x + hw, y + dims[1]!, z + hd],
  }
}

const WET_ROOM_CATEGORIES = new Set([
  'kitchen',
  'bathroom',
  'bath',
  'powder',
  'washroom',
  'laundry',
  'mudroom',
  'garage',
  'outdoor',
  'patio',
  'deck',
  'porch',
  'balcony',
  'exterior',
  'yard',
  'basement',
  'restroom',
  'rooftop',
  'utility',
])

const HABITABLE_AFCI_CATEGORIES = new Set([
  'bedroom',
  'living',
  'living-room',
  'dining',
  'dining-room',
  'kitchen',
  'hallway',
  'closet',
  'laundry',
  'family',
  'office',
  'study',
  'den',
])

export const BATHROOM_PATTERN =
  /(bath|restroom|shower|powder|washroom|\bwc\b|salle\s*de\s*bains?|salle\s*d['’]eau|\bsdb\b|toilettes?|\bbad\b|badezimmer|ba[ñn]o)/i
export const KITCHEN_PATTERN = /(kitchen|pantry|cuisine|k[üu]che|cocina)/i
export const LAUNDRY_PATTERN = /(laundry|mudroom|buanderie|lavander[íi]a|waschk[üu]che)/i
export const BEDROOM_PATTERN =
  /(bed|sleeping|master|guest|nursery|chambre|schlafzimmer|dormitorio|habitaci[óo]n)/i
export const LIVING_COMMON_PATTERN =
  /(living|great|family|foyer|entry|dining|s[ée]jour|salon|wohnzimmer|\bsala\b|comedor)/i
export const HALLWAY_PATTERN = /(hall|corridor|foyer|entry|entr[ée]e|couloir|\bflur\b|pasillo)/i
export const CLOSET_PATTERN = /(closet|wardrobe|dressing|placard|kleiderschrank|armario)/i
export const OUTDOOR_PATTERN =
  /(outdoor|patio|deck|porch|balcony|rooftop|exterior|yard|terrace|terrasse|balcon|jardin)/i
export const HABITABLE_AFCI_PATTERN =
  /(bed|sleeping|master|guest|nursery|living|great|family|dining|kitchen|hall|corridor|foyer|entry|closet|wardrobe|laundry|office|study|den|chambre|schlafzimmer|dormitorio|s[ée]jour|salon|wohnzimmer|\bsala\b|cuisine|k[üu]che|cocina|buanderie|lavander[íi]a|entr[ée]e|couloir|\bflur\b|pasillo|bureau|dressing)/i

export const NON_FIXTURE_ITEM_PATTERN =
  /\b(rug|mat|bathmat|carpet|curtain|towel|mirror|soap|caddy|rack|holder|shelf|stool|bench|chair|table|plant|lamp|art|frame|poster|pillow|blanket|bed|sofa|couch|desk|book|tv|monitor|speaker)\b/i

const TUB_SHOWER_FIXTURE_PATTERN = /bath.?tub|\btub\b|shower/i
const STOVE_FIXTURE_PATTERN = /\bstove\b|\brange\b|\bcooktop\b|\boven\b/i
const SINK_FIXTURE_PATTERN = /\bsink\b|lavatory|basin/i

export type WetFixtureRecord = {
  node: SceneNodeLike
  levelId: string | null
  kind: 'tub-shower' | 'stove' | 'sink'
  box: Aabb3
}

function zoneDescriptorOf(zone: SceneNodeLike | null | undefined): string {
  if (!zone) return ''
  const parts: string[] = []
  if (typeof zone.category === 'string' && zone.category.trim()) {
    parts.push(zone.category.trim())
  }
  if (typeof zone.name === 'string' && zone.name.trim()) {
    parts.push(zone.name.trim())
  }
  return parts.join(' ').toLowerCase()
}

export function isNonFixtureItem(node: SceneNodeLike): boolean {
  if (node.type === 'plumbing:fixture') return false
  const asset =
    node.asset && typeof node.asset === 'object'
      ? (node.asset as Record<string, unknown>)
      : null
  const primaryParts: unknown[] = [
    node.name,
    node.category,
    asset?.name,
    asset?.category,
    asset?.id,
  ]
  const primaryText = primaryParts
    .filter((p): p is string => typeof p === 'string')
    .join(' ')
    .replace(/[-_/]+/g, ' ')
  return NON_FIXTURE_ITEM_PATTERN.test(primaryText)
}

function fixtureTextOf(node: SceneNodeLike): string {
  const asset =
    node.asset && typeof node.asset === 'object'
      ? (node.asset as Record<string, unknown>)
      : null
  const parts: unknown[] = [
    node.type,
    node.name,
    node.category,
    node.modelId,
    node.assetId,
    node.itemId,
    asset?.id,
    asset?.name,
    asset?.category,
    asset?.src,
    ...(Array.isArray(asset?.tags) ? asset.tags : []),
  ]
  return parts.filter((p): p is string => typeof p === 'string').join(' ').toLowerCase()
}

export function extractWetFixtures(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): WetFixtureRecord[] {
  const wetFixtures: WetFixtureRecord[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'item' && n.type !== 'procedural-item' && n.type !== 'cabinet' && n.type !== 'plumbing:fixture') continue
    if (levelId && !belongsToLevel(nodes, n, levelId)) continue
    const box = extractObstructionBox(n)
    if (!box) continue
    const fixLevelId = resolveNodeLevelId(nodes, n)
    if (n.type === 'plumbing:fixture') {
      const fKind = typeof n.fixtureKind === 'string' ? n.fixtureKind : ''
      if (fKind === 'bathtub' || fKind === 'shower' || fKind === 'tub-shower-combo') {
        wetFixtures.push({ node: n, levelId: fixLevelId, kind: 'tub-shower', box })
        continue
      }
      if (
        fKind === 'lavatory' ||
        fKind === 'kitchen-sink' ||
        fKind === 'laundry-sink' ||
        fKind === 'bar-sink' ||
        fKind === 'mop-sink'
      ) {
        wetFixtures.push({ node: n, levelId: fixLevelId, kind: 'sink', box })
        continue
      }
      if (fKind) continue
    }
    // REAL-ELC-01: Exclude rugs, mats, carpets, curtains, furniture, and decor from fixture matchers
    if (isNonFixtureItem(n)) continue
    const txt = fixtureTextOf(n)
    if (TUB_SHOWER_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, levelId: fixLevelId, kind: 'tub-shower', box })
    } else if (STOVE_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, levelId: fixLevelId, kind: 'stove', box })
    } else if (SINK_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, levelId: fixLevelId, kind: 'sink', box })
    }
  }
  return wetFixtures
}

export function horizontalDistToAabbXZ(x: number, z: number, box: Aabb3): number {
  const dx = x < box.min[0] ? box.min[0] - x : x > box.max[0] ? x - box.max[0] : 0
  const dz = z < box.min[2] ? box.min[2] - z : z > box.max[2] ? z - box.max[2] : 0
  return Math.hypot(dx, dz)
}

export type AuditWallSegment = {
  sx: number
  sz: number
  ex: number
  ez: number
  length: number
  thickness: number
  doorOpenings: Array<[number, number]>
}

export function buildAuditWallSegments(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): AuditWallSegment[] {
  const all = Object.values(nodes)
  const doorsByWallId = new Map<string, SceneNodeLike[]>()
  for (const n of all) {
    if (n.type === 'door' && typeof n.parentId === 'string') {
      const bucket = doorsByWallId.get(n.parentId) ?? []
      bucket.push(n)
      doorsByWallId.set(n.parentId, bucket)
    }
  }
  const list: AuditWallSegment[] = []
  for (const n of all) {
    if (n.type !== 'wall') continue
    if (!belongsToLevel(nodes, n, levelId)) continue
    if (!Array.isArray(n.start) || !Array.isArray(n.end)) continue
    const sx = Number(n.start[0])
    const sz = Number(n.start[1])
    const ex = Number(n.end[0])
    const ez = Number(n.end[1])
    const length = Math.hypot(ex - sx, ez - sz)
    if (!Number.isFinite(length) || length < 0.05) continue
    const dx = (ex - sx) / length
    const dz = (ez - sz) / length
    const thickness =
      typeof n.thickness === 'number' && n.thickness > 0 ? n.thickness : 0.14
    const doorOpenings: Array<[number, number]> = []
    for (const door of doorsByWallId.get(n.id) ?? []) {
      const openW = typeof door.width === 'number' && door.width > 0 ? door.width : 0.9
      let tCenter = length / 2
      if (Array.isArray(door.position) && typeof door.position[0] === 'number') {
        const px = door.position[0] as number
        const pz = typeof door.position[2] === 'number' ? (door.position[2] as number) : 0
        if (Math.abs(pz) < 0.4 && px >= -0.2 && px <= length + 0.2) {
          tCenter = px
        } else {
          tCenter = (px - sx) * dx + (pz - sz) * dz
        }
      }
      doorOpenings.push([Math.max(0, tCenter - openW / 2), Math.min(length, tCenter + openW / 2)])
    }
    list.push({ sx, sz, ex, ez, length, thickness, doorOpenings })
  }
  return list
}

/**
 * Return true if any solid 2D wall segment (excluding door openings and host-wall centerline jitter)
 * strictly separates points `(ax, az)` and `(bx, bz)`.
 * Used so solid drywall partitions properly separate rooms for NEC 406.9(C) & 406.5(E) proximity checks.
 */
export function wallSeparatesPoints2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  walls: ReadonlyArray<AuditWallSegment>,
): boolean {
  const rX = bx - ax
  const rZ = bz - az
  const segDist = Math.hypot(rX, rZ)
  if (segDist < 1e-4) return false
  for (const w of walls) {
    if (w.length < 1e-4) continue
    const sX = w.ex - w.sx
    const sZ = w.ez - w.sz
    const denom = rX * sZ - rZ * sX
    if (Math.abs(denom) < 1e-7) continue
    const qpx = w.sx - ax
    const qpz = w.sz - az
    const t = (qpx * sZ - qpz * sX) / denom
    const u = (qpx * rZ - qpz * rX) / denom
    if (t <= 0.01 || t >= 0.99 || u < -0.02 || u > 1.02) continue
    // An open doorway does not form a solid partition barrier (NEC 406.9(C) applies across open doorways)
    const alongWall = u * w.length
    if (w.doorOpenings.some(([dMin, dMax]) => alongWall >= dMin && alongWall <= dMax)) continue
    // Require the device to be on the opposite face of the wall (>= 40% of thickness / >= 4cm),
    // preventing slightly recessed in-bathroom boxes from being masked by their own backing wall centerline.
    const perpDistFromA = Math.abs((ax - w.sx) * sZ - (az - w.sz) * sX) / w.length
    const minOppositeFaceClearance = Math.max(0.04, w.thickness * 0.4)
    if (perpDistFromA < minOppositeFaceClearance) continue
    return true
  }
  return false
}

function extractStairFootprintBox(stair: SceneNodeLike): Aabb3 | null {
  const pos = toVec3(stair.position)
  if (!pos) return null
  const rot = typeof stair.rotation === 'number' ? stair.rotation : 0
  const w = typeof stair.width === 'number' ? stair.width : 1.0
  const len = typeof stair.length === 'number' ? stair.length : 2.8
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const corners: [number, number][] = [
    [pos[0] - (w / 2) * cos, pos[2] + (w / 2) * sin],
    [pos[0] + (w / 2) * cos, pos[2] - (w / 2) * sin],
    [pos[0] + (w / 2) * cos + len * sin, pos[2] - (w / 2) * sin + len * cos],
    [pos[0] - (w / 2) * cos + len * sin, pos[2] + (w / 2) * sin + len * cos],
  ]
  const xs = corners.map((c) => c[0])
  const zs = corners.map((c) => c[1])
  return {
    min: [Math.min(...xs), pos[1], Math.min(...zs)],
    max: [Math.max(...xs), pos[1] + 2.8, Math.max(...zs)],
  }
}

const auditSceneCache = new WeakMap<object, NecSceneAuditReport>()

export function auditSceneElectrical(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): NecSceneAuditReport {
  const cached = auditSceneCache.get(nodes as object)
  if (cached) return cached

  const all = Object.values(nodes)
  const panels = all.filter((n) => n.type === 'electrical:panel')
  const devices = all.filter((n) => n.type === 'electrical:device')
  const runs = all.filter((n) => n.type === 'electrical:conduit-run')
  const transformers = all.filter((n) => n.type === 'electrical:transformer')
  const stairs = all.filter((n) => n.type === 'stair')
  const zones = all.filter((n) => n.type === 'zone')
  const doorsByWallId = new Map<string, SceneNodeLike[]>()
  for (const n of all) {
    if (n.type === 'door' && typeof n.parentId === 'string') {
      const bucket = doorsByWallId.get(n.parentId) ?? []
      bucket.push(n)
      doorsByWallId.set(n.parentId, bucket)
    }
  }
  const wallsByLevel = new Map<string, AuditWallSegment[]>()
  const getWallsForLevel = (levelId: string | null) => {
    const key = levelId ?? '__all__'
    let list = wallsByLevel.get(key)
    if (!list) {
      list = []
      for (const n of all) {
        if (n.type !== 'wall') continue
        if (!belongsToLevel(nodes, n, levelId)) continue
        if (!Array.isArray(n.start) || !Array.isArray(n.end)) continue
        const sx = Number(n.start[0])
        const sz = Number(n.start[1])
        const ex = Number(n.end[0])
        const ez = Number(n.end[1])
        const length = Math.hypot(ex - sx, ez - sz)
        if (!Number.isFinite(length) || length < 0.05) continue
        const dx = (ex - sx) / length
        const dz = (ez - sz) / length
        const thickness =
          typeof n.thickness === 'number' && n.thickness > 0 ? n.thickness : 0.14
        const doorOpenings: Array<[number, number]> = []
        for (const door of doorsByWallId.get(n.id) ?? []) {
          const openW = typeof door.width === 'number' && door.width > 0 ? door.width : 0.9
          let tCenter = length / 2
          if (Array.isArray(door.position) && typeof door.position[0] === 'number') {
            const px = door.position[0] as number
            const pz = typeof door.position[2] === 'number' ? (door.position[2] as number) : 0
            if (Math.abs(pz) < 0.4 && px >= -0.2 && px <= length + 0.2) {
              tCenter = px
            } else {
              tCenter = (px - sx) * dx + (pz - sz) * dz
            }
          }
          doorOpenings.push([Math.max(0, tCenter - openW / 2), Math.min(length, tCenter + openW / 2)])
        }
        list.push({ sx, sz, ex, ez, length, thickness, doorOpenings })
      }
      wallsByLevel.set(key, list)
    }
    return list
  }
  const obstaclesByLevel = new Map<string, TradeObstacle[]>()
  const getObstaclesForLevel = (levelId: string | null): TradeObstacle[] => {
    const key = levelId ?? '__all__'
    let list = obstaclesByLevel.get(key)
    if (!list) {
      list = extractTradeObstacles(nodes, levelId)
      obstaclesByLevel.set(key, list)
    }
    return list
  }
  const cavitiesByLevel = new Map<string, ReturnType<typeof extractRoutingCavities>>()
  const getCavitiesForLevel = (levelId: string | null): ReturnType<typeof extractRoutingCavities> => {
    const key = levelId ?? '__all__'
    let ctx = cavitiesByLevel.get(key)
    if (!ctx) {
      ctx = extractRoutingCavities(nodes, levelId)
      cavitiesByLevel.set(key, ctx)
    }
    return ctx
  }

  const wetFixtures = extractWetFixtures(nodes)

  const findings: NecAuditFinding[] = []
  let seq = 1
  const push = (f: Omit<NecAuditFinding, 'id'>) => {
    findings.push({ id: `nec-${seq++}`, ...f })
  }

  const auditEquipmentClearances = (equip: SceneNodeLike, kind: 'panel' | 'transformer') => {
    const equipName = (typeof equip.name === 'string' && equip.name) || equip.id
    const equipLevelId = resolveNodeLevelId(nodes, equip)
    const levelObstacles = getObstaclesForLevel(equipLevelId)
    const { workingPrism, dedicatedOverheadPrism, depthIn } = getEquipmentSpacePrisms(equip, kind)

    // NEC 110.26(A) Working Space vs same-level furniture / cabinets / HVAC equipment / columns / floor transformers
    for (const other of all) {
      if (other.id === equip.id) continue
      if (!belongsToLevel(nodes, other, equipLevelId)) continue
      if (
        other.type !== 'item' &&
        other.type !== 'procedural-item' &&
        other.type !== 'cabinet' &&
        other.type !== 'hvac-equipment' &&
        other.type !== 'hvac:equipment' &&
        other.type !== 'hvac:plenum' &&
        other.type !== 'plumbing:equipment' &&
        other.type !== 'plumbing:manifold' &&
        other.type !== 'plumbing:fixture' &&
        other.type !== 'column' &&
        other.type !== 'structural:column' &&
        other.type !== 'electrical:transformer'
      ) {
        continue
      }
      const box = extractObstructionBox(other)
      if (!box) continue
      if (prismIntersectsAabb(workingPrism, box)) {
        push({
          severity: 'error',
          codeRef: 'NEC 110.26(A)',
          category: 'working-space',
          title: `Working space obstructed in front of ${equipName}`,
          message: `${other.type} (${other.id}) intrudes into the required 30"W x ${depthIn}"D x 78"H clear working space in front of ${equipName}.`,
          nodeIds: [equip.id, other.id],
          suggestedFix: `Relocate ${equipName} or clear ${other.id} at least ${depthIn}" in front of ${equipName}.`,
        })
      }
    }

    // NEC 110.26(E) / 450.21 Dedicated Overhead Space vs same-level foreign plumbing/HVAC directly overhead
    for (const obs of levelObstacles) {
      if (obs.trade !== 'plumbing' && obs.trade !== 'hvac') continue
      if (prismIntersectsAabb(dedicatedOverheadPrism, obs.box)) {
        push({
          severity: 'error',
          codeRef: 'NEC 110.26(E)',
          category: 'dedicated-space',
          title: `Foreign ${obs.trade} piping/duct over ${equipName}`,
          message: `${obs.label} passes through the dedicated electrical space directly above ${equipName}. Foreign systems cannot occupy the footprint above ${kind === 'transformer' ? 'electrical distribution equipment' : 'a panelboard'} unless protected against leaks/condensation.`,
          nodeIds: [equip.id, obs.nodeId],
          suggestedFix: `Relocate ${equipName} clear of ${obs.label} (plumbing/HVAC hold right-of-way) or add NEC 110.26(E)(1)(a) leak protection above structural ceiling.`,
        })
      }
    }
  }

  // 1. Audit Panels: NEC 110.26(A)/(E), NEC 240.24 prohibited locations & height, NEC 312.2 wet rating, bus load, phase balance, solar 120%
  for (const panel of panels) {
    const panelName = (typeof panel.name === 'string' && panel.name) || panel.id
    auditEquipmentClearances(panel, 'panel')

    // 1b. NEC 240.24(A)/(D)/(E)/(F) & NEC 312.2 Prohibited Panel Locations & Mounting Height
    const pPos = toVec3(panel.position)
    if (pPos) {
      const pHeight = typeof panel.height === 'number' ? panel.height : 0.92
      const topBreakerY = pPos[1] + pHeight * 0.35
      if (topBreakerY > 2.007) {
        push({
          severity: 'error',
          codeRef: 'NEC 240.24(A)',
          category: 'prohibited-location',
          title: `Panel ${panelName} mounted too high (${round2(topBreakerY * METERS_TO_FEET)} ft > 6'-7")`,
          message: `Top circuit breaker on ${panelName} reaches ${round2(topBreakerY)} m (${round2(topBreakerY * METERS_TO_FEET)} ft), exceeding the 6'-7" (2.0 m) maximum handle height.`,
          nodeIds: [panel.id],
          suggestedFix: `Lower ${panelName} center elevation so the highest breaker handle is <= 6'-7" (2.0 m) AFF.`,
        })
      }

      const panelLevelId = resolveNodeLevelId(nodes, panel)
      const pZone = getZoneAt(nodes, pPos[0], pPos[2], panelLevelId, zones)
      const pZoneCat = zoneDescriptorOf(pZone)
      if (pZoneCat && BATHROOM_PATTERN.test(pZoneCat)) {
        push({
          severity: 'error',
          codeRef: 'NEC 240.24(E)',
          category: 'prohibited-location',
          title: `Panel ${panelName} prohibited inside bathroom ("${pZone?.name ?? pZoneCat}")`,
          message: `Overcurrent devices and panelboards are strictly prohibited inside dwelling bathrooms, showering facilities, and locker rooms (NEC 240.24(E)).`,
          nodeIds: [panel.id, ...(pZone ? [pZone.id] : [])],
          suggestedFix: `Relocate ${panelName} outside "${pZone?.name ?? pZoneCat}" to a hallway, utility room, or garage.`,
        })
      }
      if (pZoneCat && CLOSET_PATTERN.test(pZoneCat)) {
        push({
          severity: 'error',
          codeRef: 'NEC 240.24(D)',
          category: 'prohibited-location',
          title: `Panel ${panelName} prohibited in clothes closet ("${pZone?.name ?? pZoneCat}")`,
          message: `Overcurrent devices cannot be located in the vicinity of easily ignitable material such as clothes closets (NEC 240.24(D)).`,
          nodeIds: [panel.id, ...(pZone ? [pZone.id] : [])],
          suggestedFix: `Relocate ${panelName} outside the clothes closet with clear 30"W x 36"D working space.`,
        })
      }
      const pNema = typeof panel.nemaRating === 'string' ? panel.nemaRating : 'NEMA-1'
      if (pZoneCat && OUTDOOR_PATTERN.test(pZoneCat) && pNema === 'NEMA-1') {
        push({
          severity: 'error',
          codeRef: 'NEC 312.2',
          category: 'prohibited-location',
          title: `Indoor NEMA-1 panel ${panelName} placed in wet/outdoor zone`,
          message: `${panelName} is rated NEMA-1 (indoor dry only) but sits in outdoor/wet zone "${pZone?.name ?? pZoneCat}".`,
          nodeIds: [panel.id, ...(pZone ? [pZone.id] : [])],
          suggestedFix: `Change ${panelName} nemaRating to "NEMA-3R" or "NEMA-4X", or move indoors.`,
        })
      }

      for (const stair of stairs) {
        if (!belongsToLevel(nodes, stair, panelLevelId)) continue
        const sBox = extractStairFootprintBox(stair)
        if (sBox && horizontalDistToAabbXZ(pPos[0], pPos[2], sBox) < 0.25) {
          push({
            severity: 'error',
            codeRef: 'NEC 240.24(F)',
            category: 'prohibited-location',
            title: `Panel ${panelName} prohibited over stairway steps`,
            message: `Overcurrent devices shall not be located over steps of a stairway (${stair.id}) per NEC 240.24(F).`,
            nodeIds: [panel.id, stair.id],
            suggestedFix: `Move ${panelName} away from the stairway onto a level landing or adjacent wall.`,
          })
        }
      }
    }

    // 1c. Panel Schedule Slot Conflicts, Capacity, Phase Balance, & Solar 120% Busbar
    const schedule = buildPanelSchedule(panel, devices, runs)
    for (const conflict of schedule.slotConflicts) {
      push({
        severity: 'error',
        codeRef: 'NEC 408.36',
        category: 'panel-load',
        title: `Breaker slot collision on ${panelName} (Circuit ${conflict.slot})`,
        message: `Circuit slot ${conflict.slot} on ${panelName} is double-booked by multi-pole breaker span (${conflict.existingDeviceIds.join(', ')}) and (${conflict.conflictingDeviceIds.join(', ')}).`,
        nodeIds: [panel.id, ...conflict.existingDeviceIds, ...conflict.conflictingDeviceIds],
        suggestedFix: `Move conflicting device(s) to an unoccupied circuit slot on ${panelName}.`,
      })
    }
    for (const over of schedule.overflowCircuits) {
      push({
        severity: 'error',
        codeRef: 'NEC 408.54',
        category: 'panel-load',
        title: `Circuit ${over.circuitNumber} (${over.poles}P) exceeds ${panelName} spaces (${schedule.spaces})`,
        message: `${over.poles}-pole circuit starting at slot ${over.circuitNumber} extends past ${panelName}'s ${schedule.spaces}-space bus.`,
        nodeIds: [panel.id, ...over.deviceIds],
        suggestedFix: `Increase ${panelName} spaces or move circuit ${over.circuitNumber} to a lower available slot.`,
      })
    }
    if (schedule.utilizationPct > 100) {
      push({
        severity: 'error',
        codeRef: 'NEC 220 / 408.30',
        category: 'panel-load',
        title: `${panelName} exceeds rated capacity (${schedule.utilizationPct}%)`,
        message: `Connected line load (${schedule.totalLineAmps}A) exceeds panel rating (${schedule.busRatingAmps}A bus / ${schedule.mainBreakerAmps}A main).`,
        nodeIds: [panel.id],
        suggestedFix: `Upgrade ${panelName} service/bus rating or move loads to a subpanel.`,
      })
    } else if (schedule.utilizationPct > 80) {
      push({
        severity: 'warning',
        codeRef: 'NEC 215.2 / 408.30',
        category: 'panel-load',
        title: `${panelName} above 80% continuous load threshold (${schedule.utilizationPct}%)`,
        message: `Panel utilization is ${schedule.utilizationPct}% (${schedule.totalLineAmps}A). Leave headroom for continuous loads and future expansion.`,
        nodeIds: [panel.id],
      })
    }

    if (schedule.totalConnectedVa > 3000 && schedule.imbalancePct > 20) {
      push({
        severity: 'warning',
        codeRef: 'NEC 220.61',
        category: 'panel-load',
        title: `Phase imbalance on ${panelName} (${schedule.imbalancePct}%)`,
        message: `Phase loads are imbalanced by ${schedule.imbalancePct}% (A: ${schedule.phaseVa.A} VA, B: ${schedule.phaseVa.B} VA${schedule.phaseVa.C !== undefined ? `, C: ${schedule.phaseVa.C} VA` : ''}).`,
        nodeIds: [panel.id],
        suggestedFix: 'Reassign single-pole branch circuits across alternate bus slots to balance phases within 15%.',
      })
    }

    const explicitSolarBackfeed =
      typeof panel.solarBackfeedAmps === 'number' && panel.solarBackfeedAmps > 0
        ? panel.solarBackfeedAmps
        : 0
    const inferredSolarBackfeed =
      explicitSolarBackfeed > 0
        ? 0
        : devices
            .filter((d) => d.panelId === panel.id && d.deviceKind === 'solar-inverter')
            .reduce(
              (sum, d) =>
                sum + (typeof d.breakerAmps === 'number' && d.breakerAmps > 0 ? d.breakerAmps : 40),
              0,
            )
    const solarBackfeed = explicitSolarBackfeed > 0 ? explicitSolarBackfeed : inferredSolarBackfeed
    if (solarBackfeed > 0) {
      const maxBackfeed = round2(
        schedule.busRatingAmps * NEC_220_RESIDENTIAL.solarBusbarRuleFactor - schedule.mainBreakerAmps,
      )
      if (solarBackfeed > maxBackfeed) {
        push({
          severity: 'error',
          codeRef: 'NEC 705.12(B)(3)(2)',
          category: 'solar-busbar',
          title: `Solar backfeed violates 120% busbar rule on ${panelName}`,
          message: `${solarBackfeed}A PV breaker exceeds max ${Math.max(0, maxBackfeed)}A permitted on a ${schedule.busRatingAmps}A bus with ${schedule.mainBreakerAmps}A main.`,
          nodeIds: [panel.id],
          suggestedFix: 'Derate the main breaker, upgrade busbar rating (e.g., 225A bus / 200A main), or use a line-side tap.',
        })
      }
    }
  }

  // 1d. Audit Step-Down Transformers: NEC 110.26(A) working space, 110.26(E) overhead space, & NEC 312.2 outdoor NEMA rating
  for (const tx of transformers) {
    auditEquipmentClearances(tx, 'transformer')
    const txPos = toVec3(tx.position)
    if (txPos) {
      const txLevelId = resolveNodeLevelId(nodes, tx)
      const txZone = getZoneAt(nodes, txPos[0], txPos[2], txLevelId, zones)
      const txZoneCat = zoneDescriptorOf(txZone)
      const txNema = typeof tx.nemaRating === 'string' ? tx.nemaRating : 'NEMA-2'
      if (txZoneCat && OUTDOOR_PATTERN.test(txZoneCat) && !['NEMA-3R', 'NEMA-4', 'NEMA-4X'].includes(txNema)) {
        push({
          severity: 'error',
          codeRef: 'NEC 312.2 / 450.22',
          category: 'prohibited-location',
          title: `Indoor ${txNema} transformer ${(typeof tx.name === 'string' && tx.name) || tx.id} placed outdoors`,
          message: `Dry-type transformer inside outdoor zone "${txZone?.name ?? txZoneCat}" requires a weatherproof NEMA-3R enclosure.`,
          nodeIds: [tx.id, ...(txZone ? [txZone.id] : [])],
          suggestedFix: 'Switch transformer nemaRating to "NEMA-3R" or relocate into an indoor electrical room.',
        })
      }
    }
  }

  // 2. Audit Devices: NEC 314.16 Box Fill (separate rough-in boxes only), 210.8 GFCI, 210.12 AFCI
  for (const dev of devices) {
    const devName = (typeof dev.name === 'string' && dev.name) || dev.id
    const devLevelId = resolveNodeLevelId(nodes, dev)
    const devKind = typeof dev.deviceKind === 'string' ? dev.deviceKind : 'duplex'
    const occupancy = dev.occupancy === 'commercial' ? 'commercial' : 'residential'
    if (usesSeparateRoughInBox(devKind)) {
      const boxType = (typeof dev.boxType === 'string' ? dev.boxType : 'single-gang-standard') as BoxType
      const validBoxGauge = clampToBoxFillGauge(typeof dev.wireGauge === 'string' ? dev.wireGauge : undefined)
      const conductorCount = typeof dev.conductorCount === 'number' ? dev.conductorCount : 4
      const yokeCount =
        typeof dev.yokeCount === 'number'
          ? dev.yokeCount
          : isZeroYokeDeviceKind(devKind)
            ? 0
            : 1
      const clampCount = typeof dev.clampCount === 'number' ? dev.clampCount : 1

      const boxFill = calculateBoxFill({
        boxType,
        conductors: [{ gauge: validBoxGauge, count: conductorCount }],
        deviceYokeCount: yokeCount,
        internalClampCount: clampCount,
        equipmentGroundCount: 1,
      })
      if (!boxFill.compliant) {
        push({
          severity: 'error',
          codeRef: 'NEC 314.16',
          category: 'box-fill',
          title: `Box fill exceeded at ${devName} (${boxFill.utilizationPct}%)`,
          message: `${boxFill.totalRequiredCuIn} cu in required vs ${boxFill.boxVolumeCuIn} cu in capacity (${boxFill.boxLabel}).`,
          nodeIds: [dev.id],
          suggestedFix: `Upgrade boxType to "${boxFill.recommendedBoxType}".`,
        })
      }
    }

    // Zone-based GFCI (210.8) & AFCI (210.12)
    const devPos = toVec3(dev.position)
    if (devPos) {
      const [x, , z] = devPos
      const devRot = typeof dev.rotation === 'number' && Number.isFinite(dev.rotation) ? dev.rotation : 0
      const zone =
        getZoneAt(nodes, x, z, devLevelId, zones) ??
        getZoneAt(nodes, x + Math.sin(devRot) * 0.22, z + Math.cos(devRot) * 0.22, devLevelId, zones)
      const zoneCat = zoneDescriptorOf(zone)
      const devMeta = dev.metadata as {
        mepSourceNodeId?: string
        mepHardwired?: boolean
        roomName?: string
        zoneName?: string
      } | undefined
      const mepSource =
        typeof devMeta?.mepSourceNodeId === 'string' ? nodes[devMeta.mepSourceNodeId] : undefined
      const isCeilingBathExhaustMep = Boolean(
        mepSource &&
          (mepSource.type === 'hvac:equipment' || mepSource.type === 'hvac-equipment') &&
          (mepSource.equipmentKind === 'bath-exhaust-fan' ||
            (/bath.*exhaust|exhaust.*fan/i.test(String(mepSource.name ?? '')) &&
              Array.isArray(mepSource.position) &&
              Number(mepSource.position[1]) >= 2.2)),
      )
      // REAL-ELC-01: Hardwired MEP equipment disconnects/junctions (Air Handler, Water Heater, ERV,
      // Range Hood, Furnace, Condenser, RTU, etc.) are NOT receptacles under NEC 406.9(C) / 406.5(E).
      // Cord-and-plug receptacles (duplex, gfci, weatherproof-gfci, dishwasher/disposal/washer/sump)
      // remain strictly audited.
      const isHardwiredMepEquip = Boolean(
        devMeta?.mepHardwired === true ||
          devKind === 'junction-box' ||
          devKind === 'disconnect' ||
          (devKind === 'dedicated-240v' && Boolean(devMeta?.mepSourceNodeId)) ||
          (mepSource &&
            (mepSource.type === 'hvac:equipment' ||
              mepSource.type === 'hvac-equipment' ||
              (mepSource.type === 'plumbing:equipment' &&
                (devKind === 'dedicated-240v' ||
                  (typeof dev.poles === 'number' && dev.poles >= 2) ||
                  mepSource.equipmentKind === 'water-heater-tank-electric' ||
                  mepSource.equipmentKind === 'water-heater-hpwh' ||
                  mepSource.equipmentKind === 'boiler-hydronic' ||
                  mepSource.equipmentKind === 'pressure-tank' ||
                  mepSource.equipmentKind === 'water-heater-tankless-gas' ||
                  mepSource.equipmentKind === 'recirc-pump')))),
      )
      const devRoomTag = (
        (typeof dev.roomName === 'string' && dev.roomName) ||
        (typeof dev.zoneName === 'string' && dev.zoneName) ||
        (typeof devMeta?.roomName === 'string' && devMeta.roomName) ||
        (typeof devMeta?.zoneName === 'string' && devMeta.zoneName) ||
        (typeof zone?.name === 'string' && zone.name) ||
        ''
      )
        .trim()
        .toLowerCase()
      const isReceptacle =
        !isHardwiredMepEquip &&
        (devKind === 'duplex' ||
          devKind === 'gfci' ||
          devKind === 'afci' ||
          devKind === 'dedicated-240v' ||
          devKind === 'usb-duplex' ||
          devKind === 'weatherproof-gfci' ||
          devKind === 'floor-box')
      const isSwitch =
        devKind === 'switch-1p' ||
        devKind === 'switch-3way' ||
        devKind === 'dimmer'
      const isLuminaire =
        devKind === 'luminaire' ||
        devKind === 'ceiling-fan' ||
        devKind === 'under-cabinet-led'

      // NEC 406.9(C), 404.4(C), 410.10(D), & 406.5 Fixture-Proximity Prohibited Zones
      // Only enforce within the same level and same room zone (solid partition walls & floor slabs separate spaces)
      const levelWallSegs = getWallsForLevel(devLevelId)
      for (const fix of wetFixtures) {
        if (devLevelId && fix.levelId && devLevelId !== fix.levelId) continue
        const fixCx = (fix.box.min[0] + fix.box.max[0]) / 2
        const fixCz = (fix.box.min[2] + fix.box.max[2]) / 2
        const fixZone = getZoneAt(nodes, fixCx, fixCz, fix.levelId ?? devLevelId, zones)
        if (zone && fixZone && zone.id !== fixZone.id) continue
        const fixRoomTag = (
          (typeof fix.node.roomName === 'string' && fix.node.roomName) ||
          (typeof fix.node.zoneName === 'string' && fix.node.zoneName) ||
          (typeof fixZone?.name === 'string' && fixZone.name) ||
          ''
        )
          .trim()
          .toLowerCase()
        if (!zone || !fixZone) {
          if (devRoomTag && fixRoomTag && devRoomTag !== fixRoomTag) continue
        }
        // Solid partition wall strictly between device and fixture separates adjacent rooms
        if (wallSeparatesPoints2D(x, z, fixCx, fixCz, levelWallSegs)) continue
        const horizDist = horizontalDistToAabbXZ(x, z, fix.box)
        const devY = devPos[1]
        if (fix.kind === 'tub-shower') {
          if (isReceptacle && !isCeilingBathExhaustMep && horizDist < 0.914 && devY < 2.438) {
            // NEC 2023 406.9(C) Exception: In compact bathrooms with less than the required 3 ft zone,
            // the mandatory NEC 210.52(D) basin GFCI receptacle is permitted on the farthest wall
            // outside the tub/shower rim (horizDist > 0.15 m).
            let qualifiesCompactBathException = false
            if (
              devKind === 'gfci' &&
              horizDist > 0.15 &&
              zone &&
              Array.isArray(zone.polygon) &&
              zone.polygon.length >= 3
            ) {
              const roomTubs = wetFixtures.filter((wf) => {
                if (wf.kind !== 'tub-shower') return false
                if (devLevelId && wf.levelId && devLevelId !== wf.levelId) return false
                const cx = (wf.box.min[0] + wf.box.max[0]) / 2
                const cz = (wf.box.min[2] + wf.box.max[2]) / 2
                const wfZone = getZoneAt(nodes, cx, cz, wf.levelId ?? devLevelId, zones)
                return Boolean(wfZone && wfZone.id === zone.id)
              })
              if (roomTubs.length > 0) {
                let maxAchievableDist = 0
                const poly = zone.polygon as ReadonlyArray<readonly [number, number]>
                for (let pi = 0; pi < poly.length; pi++) {
                  const a = poly[pi]!
                  const b = poly[(pi + 1) % poly.length]!
                  for (const frac of [0, 0.25, 0.5, 0.75]) {
                    const px = a[0] + (b[0] - a[0]) * frac
                    const pz = a[1] + (b[1] - a[1]) * frac
                    const minDistToAnyTub = Math.min(
                      ...roomTubs.map((rt) => horizontalDistToAabbXZ(px, pz, rt.box)),
                    )
                    if (minDistToAnyTub > maxAchievableDist) maxAchievableDist = minDistToAnyTub
                  }
                }
                if (maxAchievableDist < 0.914 && horizDist >= maxAchievableDist - 0.18) {
                  qualifiesCompactBathException = true
                }
              }
            }
            if (qualifiesCompactBathException) {
              push({
                severity: 'warning',
                codeRef: 'NEC 406.9(C) Exception',
                category: 'prohibited-location',
                title: `Compact bathroom GFCI ${devName} installed under NEC 406.9(C) Exception`,
                message: `${devName} is ${round2(horizDist * METERS_TO_FEET)} ft from ${fix.node.name ?? fix.node.id} in a compact bathroom with less than 3 ft clear wall zone; permitted on the farthest wall per NEC 406.9(C) Exception.`,
                nodeIds: [dev.id, fix.node.id],
                suggestedFix: `Keep ${devName} GFCI-protected and mounted on the wall farthest from the tub/shower rim.`,
              })
            } else {
              push({
                severity: 'error',
                codeRef: 'NEC 406.9(C)',
                category: 'prohibited-location',
                title: `Receptacle ${devName} inside bathtub/shower restricted zone`,
                message: `${devName} is ${round2(horizDist * METERS_TO_FEET)} ft horizontally from ${fix.node.name ?? fix.node.id} at ${round2(devY * METERS_TO_FEET)} ft high; receptacles are prohibited within 3 ft horizontally and 8 ft vertically of a bathtub or shower space.`,
                nodeIds: [dev.id, fix.node.id],
                suggestedFix: `Move ${devName} at least 3 ft (0.92 m) away from the bathtub/shower rim.`,
              })
            }
          }
          if (isSwitch && horizDist <= 0.15) {
            push({
              severity: 'error',
              codeRef: 'NEC 404.4(C)',
              category: 'prohibited-location',
              title: `Wall switch ${devName} prohibited inside tub/shower space`,
              message: `Switches cannot be installed within wet locations in tub or shower spaces (${fix.node.name ?? fix.node.id}) per NEC 404.4(C).`,
              nodeIds: [dev.id, fix.node.id],
              suggestedFix: `Relocate switch ${devName} outside the tub/shower enclosure.`,
            })
          }
          if (isLuminaire && !isCeilingBathExhaustMep && horizDist < 0.914 && devY < 2.438) {
            push({
              severity: 'error',
              codeRef: 'NEC 410.10(D)',
              category: 'prohibited-location',
              title: `Luminaire ${devName} too low in bathtub/shower zone (< 8 ft)`,
              message: `${devName} is ${round2(devY * METERS_TO_FEET)} ft AFF inside the 3 ft x 8 ft bathtub/shower zone (${fix.node.name ?? fix.node.id}). Cord-connected, hanging, or non-wet-rated luminaires are prohibited here.`,
              nodeIds: [dev.id, fix.node.id],
              suggestedFix: `Raise ${devName} to >= 8 ft (2.44 m) AFF or move >= 3 ft outside the tub/shower rim.`,
            })
          }
        } else if (fix.kind === 'stove' && isReceptacle && horizDist <= 0.08 && devY >= 0.75 && devY <= 1.65) {
          push({
            severity: 'error',
            codeRef: 'NEC 210.52(C) / 110.11',
            category: 'prohibited-location',
            title: `Receptacle ${devName} located directly over stove/cooktop`,
            message: `${devName} is mounted directly above cooking surface "${fix.node.name ?? fix.node.id}", creating a heat/cord hazard.`,
            nodeIds: [dev.id, fix.node.id],
            suggestedFix: `Shift ${devName} laterally onto adjacent countertop wall clear of the cooktop.`,
          })
        } else if (fix.kind === 'sink' && isReceptacle && !isCeilingBathExhaustMep && horizDist === 0 && devY <= 1.05) {
          push({
            severity: 'error',
            codeRef: 'NEC 406.5(E)',
            category: 'prohibited-location',
            title: `Receptacle ${devName} placed inside sink basin footprint`,
            message: `${devName} sits directly inside the sink footprint (${fix.node.name ?? fix.node.id}).`,
            nodeIds: [dev.id, fix.node.id],
            suggestedFix: `Move ${devName} to the wall beside the sink (>= 44" AFF) with GFCI protection.`,
          })
        }
      }

      // NEC 410.16(C): Closet luminaire clearance
      if (isLuminaire && zoneCat && CLOSET_PATTERN.test(zoneCat) && devPos[1] < 2.1) {
        push({
          severity: 'error',
          codeRef: 'NEC 410.16(C)',
          category: 'prohibited-location',
          title: `Closet luminaire ${devName} mounted too low in storage space`,
          message: `${devName} inside closet "${zone?.name ?? zoneCat}" is at ${round2(devPos[1] * METERS_TO_FEET)} ft AFF, encroaching on clothes storage clearance (must be ceiling-mounted enclosed LED >= 6" from storage).`,
          nodeIds: [dev.id, ...(zone ? [zone.id] : [])],
          suggestedFix: `Raise ${devName} to ceiling height (>= 2.2 m) with an enclosed LED fixture.`,
        })
      }

      if (isReceptacle && zoneCat) {
        const isHardwired240vMep =
          devKind === 'dedicated-240v' &&
          Boolean((dev.metadata as { mepSourceNodeId?: string } | undefined)?.mepSourceNodeId)
        const isWet =
          BATHROOM_PATTERN.test(zoneCat) ||
          KITCHEN_PATTERN.test(zoneCat) ||
          LAUNDRY_PATTERN.test(zoneCat) ||
          OUTDOOR_PATTERN.test(zoneCat) ||
          Array.from(WET_ROOM_CATEGORIES).some((w) => zoneCat.includes(w))
        if (
          isWet &&
          !isHardwired240vMep &&
          dev.gfciProtected !== true &&
          devKind !== 'gfci' &&
          devKind !== 'weatherproof-gfci'
        ) {
          push({
            severity: 'error',
            codeRef: occupancy === 'commercial' ? 'NEC 210.8(B)' : 'NEC 210.8(A)',
            category: 'gfci-afci',
            title: `Missing GFCI protection at ${devName}`,
            message: `Receptacle ${devName} is inside wet/damp zone "${zone?.name ?? zoneCat}" without GFCI protection.`,
            nodeIds: [dev.id, ...(zone ? [zone.id] : [])],
            suggestedFix: 'Set gfciProtected = true or switch deviceKind to "gfci".',
          })
        }

        if (occupancy === 'residential') {
          const isHabitable =
            !BATHROOM_PATTERN.test(zoneCat) &&
            (HABITABLE_AFCI_PATTERN.test(zoneCat) ||
              Array.from(HABITABLE_AFCI_CATEGORIES).some((h) => zoneCat.includes(h)))
          const devPoles = typeof dev.poles === 'number' ? dev.poles : 1
          const devAmps = typeof dev.breakerAmps === 'number' ? dev.breakerAmps : 15
          // NEC 210.12(A): Dwelling AFCI applies only to 120V, single-phase, 15A and 20A branch circuits
          const is120v15Or20Branch =
            devPoles === 1 && devAmps <= 20 && devKind !== 'dedicated-240v'
          if (
            isHabitable &&
            is120v15Or20Branch &&
            dev.afciProtected !== true &&
            dev.deviceKind !== 'afci'
          ) {
            push({
              severity: 'warning',
              codeRef: 'NEC 210.12(A)',
              category: 'gfci-afci',
              title: `Missing AFCI protection at ${devName}`,
              message: `Residential receptacle ${devName} in "${zone?.name ?? zoneCat}" requires AFCI (or dual-function AFCI/GFCI) protection.`,
              nodeIds: [dev.id, ...(zone ? [zone.id] : [])],
              suggestedFix: 'Enable afciProtected = true on the branch circuit or breaker.',
            })
          }
        }
      }
    }
  }

  // 2b. NEC 210.11(C)(1)/(3) Dedicated Circuit Isolation Check (no mixing bathroom or kitchen SAB circuits with bedroom/living outlets)
  const circuitZones = new Map<string, { bath: string[]; kitchen: string[]; general: string[]; ckt: number }>()
  for (const dev of devices) {
    if (dev.occupancy === 'commercial') continue
    if (typeof dev.panelId !== 'string' || typeof dev.circuitNumber !== 'number' || dev.circuitNumber <= 0) continue
    const pos = toVec3(dev.position)
    if (!pos) continue
    const devLevelId = resolveNodeLevelId(nodes, dev)
    const zone = getZoneAt(nodes, pos[0], pos[2], devLevelId, zones)
    const zCat = zoneDescriptorOf(zone)
    if (!zCat) continue
    const key = `${dev.panelId}:${dev.circuitNumber}`
    const bucket = circuitZones.get(key) ?? { bath: [], kitchen: [], general: [], ckt: dev.circuitNumber }
    const isRecept =
      dev.deviceKind === 'duplex' ||
      dev.deviceKind === 'gfci' ||
      dev.deviceKind === 'afci' ||
      dev.deviceKind === 'usb-duplex' ||
      dev.deviceKind === 'floor-box'
    if (BATHROOM_PATTERN.test(zCat) && isRecept) bucket.bath.push(dev.id)
    else if (KITCHEN_PATTERN.test(zCat) && isRecept) bucket.kitchen.push(dev.id)
    else if (
      !BATHROOM_PATTERN.test(zCat) &&
      !KITCHEN_PATTERN.test(zCat) &&
      (BEDROOM_PATTERN.test(zCat) ||
        LIVING_COMMON_PATTERN.test(zCat) ||
        HALLWAY_PATTERN.test(zCat) ||
        /office|study|den|bureau/i.test(zCat))
    ) {
      bucket.general.push(dev.id)
    }
    circuitZones.set(key, bucket)
  }
  for (const bucket of circuitZones.values()) {
    if (bucket.bath.length > 0 && (bucket.general.length > 0 || bucket.kitchen.length > 0)) {
      push({
        severity: 'error',
        codeRef: 'NEC 210.11(C)(3)',
        category: 'prohibited-location',
        title: `Circuit ${bucket.ckt} mixes Bathroom receptacle with non-bathroom outlets`,
        message: `Bathroom receptacle circuits must be dedicated 20A circuits and cannot feed bedrooms, living rooms, or kitchen receptacles (NEC 210.11(C)(3)).`,
        nodeIds: [...bucket.bath, ...bucket.general, ...bucket.kitchen],
        suggestedFix: `Move bathroom receptacle(s) onto their own dedicated 20A GFCI circuit.`,
      })
    }
    if (bucket.kitchen.length > 0 && bucket.general.length > 0) {
      push({
        severity: 'error',
        codeRef: 'NEC 210.11(C)(1)',
        category: 'prohibited-location',
        title: `Circuit ${bucket.ckt} mixes Kitchen Small-Appliance circuit with general room outlets`,
        message: `20A Kitchen Small-Appliance branch circuits cannot supply outlets in bedrooms, living rooms, or hallways (NEC 210.52(B)(2)).`,
        nodeIds: [...bucket.kitchen, ...bucket.general],
        suggestedFix: `Separate non-kitchen room outlets onto a dedicated general-purpose AFCI circuit.`,
      })
    }
  }

  // 2c. IRC R314 / R315 & NFPA 72 Life-Safety Audit: Hardwired 120V Interconnected Smoke/CO Alarms
  const smokeDevices = devices.filter((d) => d.deviceKind === 'smoke-co')
  for (const sDev of smokeDevices) {
    const sName = (typeof sDev.name === 'string' && sDev.name) || sDev.id
    if (sDev.gfciProtected === true) {
      push({
        severity: 'error',
        codeRef: 'NFPA 72 29.9.4(5)',
        category: 'life-safety',
        title: `Smoke/CO alarm ${sName} is on a GFCI-protected circuit`,
        message: `Hardwired smoke and CO alarms must not be powered through a GFCI breaker or GFCI receptacle load terminals because nuisance trips can silently disable life-safety alarms.`,
        nodeIds: [sDev.id],
        suggestedFix: `Move ${sName} to a non-GFCI 15A AFCI circuit shared with a frequently-used hallway or living-area lighting load.`,
      })
    }
  }

  // Group smoke/CO alarms by level + panel to check NFPA 72 A.29.9.4 shared lighting & IRC R314.4 single-circuit interconnect
  const smokeByLevelAndPanel = new Map<string, { levelId: string; panelId: string; alarms: SceneNodeLike[] }>()
  for (const sDev of smokeDevices) {
    if (sDev.occupancy === 'commercial') continue
    const lvl = resolveNodeLevelId(nodes, sDev) ?? '__root__'
    const pid = typeof sDev.panelId === 'string' ? sDev.panelId : '__unassigned__'
    const key = `${lvl}::${pid}`
    let entry = smokeByLevelAndPanel.get(key)
    if (!entry) {
      entry = { levelId: lvl, panelId: pid, alarms: [] }
      smokeByLevelAndPanel.set(key, entry)
    }
    entry.alarms.push(sDev)
  }

  for (const { levelId: lvl, panelId: pid, alarms } of smokeByLevelAndPanel.values()) {
    const cktSet = new Set(
      alarms
        .map((a) => (typeof a.circuitNumber === 'number' && a.circuitNumber >= 1 ? Math.floor(a.circuitNumber) : 0))
        .filter((c) => c > 0),
    )
    if (cktSet.size > 1) {
      push({
        severity: 'warning',
        codeRef: 'IRC R314.4',
        category: 'life-safety',
        title: `Smoke/CO alarms split across ${cktSet.size} circuits (${Array.from(cktSet).map((c) => `CKT-${c}`).join(', ')})`,
        message: `Residential hardwired smoke/CO alarms must be interconnected on a single 15A AFCI circuit (14/3 interconnect conductor) so all alarms sound together.`,
        nodeIds: alarms.map((a) => a.id),
        suggestedFix: `Assign all interconnected smoke/CO alarms on this level to one shared 15A AFCI Smoke/CO & Lighting circuit.`,
      })
    }
    for (const ckt of cktSet) {
      const cktPeers = devices.filter(
        (d) =>
          d.panelId === pid &&
          Math.floor(Number(d.circuitNumber ?? 0)) === ckt &&
          (resolveNodeLevelId(nodes, d) ?? '__root__') === lvl,
      )
      const hasLightingLoad = cktPeers.some((d) => d.deviceKind === 'luminaire')
      if (!hasLightingLoad) {
        const cktAlarms = alarms.filter((a) => Math.floor(Number(a.circuitNumber ?? 0)) === ckt)
        push({
          severity: 'warning',
          codeRef: 'NFPA 72 A.29.9.4',
          category: 'life-safety',
          title: `Circuit CKT-${ckt} supplies Smoke/CO alarms without a pilot lighting load`,
          message: `Best practice is to tie hardwired smoke/CO alarms onto a frequently-used 15A AFCI hallway or living-area lighting circuit (constant hot) so a tripped breaker is immediately visible.`,
          nodeIds: cktAlarms.map((a) => a.id),
          suggestedFix: `Share CKT-${ckt} with a frequently-used hallway or living room ceiling light (non-GFCI 15A AFCI).`,
        })
      }
    }
  }

  // IRC R314.3 / R315.3: On residential levels that have electrical devices AND bedroom zone(s), warn if any bedroom lacks a hardwired smoke/CO alarm
  const residentialDevicesByLevel = new Map<string, SceneNodeLike[]>()
  for (const dev of devices) {
    if (dev.occupancy === 'commercial') continue
    const lvl = resolveNodeLevelId(nodes, dev) ?? '__root__'
    const list = residentialDevicesByLevel.get(lvl) ?? []
    list.push(dev)
    residentialDevicesByLevel.set(lvl, list)
  }
  for (const [lvl, lvlDevices] of residentialDevicesByLevel.entries()) {
    const lvlZones = all.filter(
      (n) => n.type === 'zone' && (resolveNodeLevelId(nodes, n) ?? '__root__') === lvl,
    )
    const bedroomZones = lvlZones.filter((z) => {
      const txt = zoneDescriptorOf(z)
      return (
        BEDROOM_PATTERN.test(txt) &&
        !BATHROOM_PATTERN.test(txt) &&
        !CLOSET_PATTERN.test(txt) &&
        Array.isArray(z.polygon) &&
        z.polygon.length >= 3
      )
    })
    if (bedroomZones.length === 0) continue

    const lvlSmokes = lvlDevices.filter((d) => d.deviceKind === 'smoke-co')
    let anySmokeOutsideBedrooms = false
    const bedroomMatchedSmokeIds = new Set<string>()
    for (const bz of bedroomZones) {
      const poly = bz.polygon as [number, number][]
      const inBed = lvlSmokes.filter((s) => {
        const sp = toVec3(s.position)
        return Boolean(sp && pointInPolygon2D(sp[0], sp[2], poly))
      })
      for (const s of inBed) bedroomMatchedSmokeIds.add(s.id)
      if (inBed.length === 0) {
        const bzName = (typeof bz.name === 'string' && bz.name) || bz.id
        push({
          severity: 'warning',
          codeRef: 'IRC R314.3(1)',
          category: 'life-safety',
          title: `Bedroom "${bzName}" is missing a hardwired Smoke/CO alarm`,
          message: `IRC R314.3(1) requires a hardwired 120V interconnected smoke alarm inside every sleeping room.`,
          nodeIds: [bz.id],
          suggestedFix: `Add a ceiling-mounted smoke-co alarm in "${bzName}" interconnected via 14/3 on the 15A AFCI Smoke/CO & Lighting circuit.`,
        })
      }
    }
    for (const s of lvlSmokes) {
      if (!bedroomMatchedSmokeIds.has(s.id)) anySmokeOutsideBedrooms = true
    }
    if (!anySmokeOutsideBedrooms) {
      push({
        severity: 'warning',
        codeRef: 'IRC R314.3(2) / R315.3',
        category: 'life-safety',
        title: `Missing hardwired Smoke/CO alarm outside sleeping area`,
        message: `IRC R314.3(2) and R315.3 require a hardwired interconnected smoke/CO alarm outside each separate sleeping area in the immediate vicinity of bedrooms.`,
        nodeIds: bedroomZones.map((b) => b.id),
        suggestedFix: `Add a ceiling-mounted smoke-co alarm in the hallway or living area outside the bedrooms on the 15A AFCI Smoke/CO & Lighting circuit.`,
      })
    }
  }

  // 2d. R6-BUG-05: NEC 210.4 / 210.23 Mixed-Pole Circuit Validation (never mix 1P 120V and 2P/3P loads on the same circuit number)
  const polesByPanelCkt = new Map<string, { panelId: string; ckt: number; poles: Set<number>; nodeIds: string[] }>()
  for (const dev of devices) {
    const pid = typeof dev.panelId === 'string' ? dev.panelId : ''
    const ckt = typeof dev.circuitNumber === 'number' && dev.circuitNumber >= 1 ? Math.floor(dev.circuitNumber) : 0
    if (!pid || ckt <= 0) continue
    const key = `${pid}:${ckt}`
    let entry = polesByPanelCkt.get(key)
    if (!entry) {
      entry = { panelId: pid, ckt, poles: new Set<number>(), nodeIds: [] }
      polesByPanelCkt.set(key, entry)
    }
    const devPoles = dev.poles === 3 ? 3 : dev.poles === 2 ? 2 : 1
    entry.poles.add(devPoles)
    entry.nodeIds.push(dev.id)
  }
  for (const entry of polesByPanelCkt.values()) {
    if (entry.poles.size > 1) {
      const poleList = Array.from(entry.poles).sort((a, b) => a - b).map((p) => `${p}P`).join(' & ')
      push({
        severity: 'error',
        codeRef: 'NEC 210.4 / 210.23',
        category: 'panel-load',
        title: `Circuit CKT-${entry.ckt} mixes incompatible pole counts (${poleList})`,
        message: `Devices assigned to CKT-${entry.ckt} on panel ${entry.panelId} mix ${poleList} loads on the same breaker slot.`,
        nodeIds: entry.nodeIds,
        suggestedFix: `Assign multi-pole (240V/208V/480V) loads to dedicated circuit numbers separate from 1-pole 120V branch circuits.`,
      })
    }
  }

  // 3. Audit Conduit / Cable Runs: Trade clashes, 360° bends, NM-B commercial/plenum ban, ampacity, conduit fill, voltage drop
  for (const run of runs) {
    const runName = (typeof run.name === 'string' && run.name) || run.id
    const path = Array.isArray(run.path) ? (run.path as Vec3[]) : []
    const racewayType: RacewayType =
      typeof run.racewayType === 'string' ? (run.racewayType as RacewayType) : 'emt'
    const tradeSize: ConduitTradeSize =
      typeof run.tradeSize === 'string' ? (run.tradeSize as ConduitTradeSize) : '3/4"'
    const wireGauge: WireGauge = clampToBranchWireGauge(
      typeof run.wireGauge === 'string' ? run.wireGauge : undefined,
      '12',
    )
    const material: ConductorMaterial = run.conductorMaterial === 'al' ? 'al' : 'cu'
    const insulationRating: InsulationRating =
      run.insulationRating === '60C' || run.insulationRating === '75C'
        ? run.insulationRating
        : '90C'
    const occupancy = run.occupancy === 'commercial' ? 'commercial' : 'residential'
    const inPlenum = run.inPlenum === true

    // 3a. Trade-priority clashes (electrical must yield to same-level plumbing, HVAC, structural)
    const runLevelId = resolveNodeLevelId(nodes, run)
    const selfMepIds = new Set<string>()
    const runMeta = run.metadata as { fromNodeId?: string } | undefined
    for (const endId of [run.fromNodeId, runMeta?.fromNodeId, run.targetDeviceId, run.toNodeId]) {
      if (typeof endId === 'string') {
        const endNode = nodes[endId]
        const meta = endNode?.metadata as { mepSourceNodeId?: string } | undefined
        if (typeof meta?.mepSourceNodeId === 'string') selfMepIds.add(meta.mepSourceNodeId)
      }
    }
    const levelObs = getObstaclesForLevel(runLevelId)
    const filteredObs =
      selfMepIds.size > 0 ? levelObs.filter((o) => !selfMepIds.has(o.nodeId)) : levelObs
    const clashes = detectRunTradeClashes(path, filteredObs)
    for (const clash of clashes) {
      push({
        severity: 'error',
        codeRef: 'TRADE-PRIORITY',
        category: 'trade-clash',
        title: `Electrical run ${runName} clashes with ${clash.trade}`,
        message: `${runName} (segment ${clash.segmentIndex + 1}) intrudes on ${clash.label}. Electrical must route around ${clash.trade}; do not move ${clash.trade}.`,
        nodeIds: [run.id, clash.obstacleNodeId],
        suggestedFix: `Run electrical_route_circuit / Auto-Reroute on ${runName} to detour around ${clash.label}.`,
      })
    }

    // 3b. NEC 358.26 / 344.26 / 352.26 max 360° bends between pull points (raceways)
    const { totalBendDegrees } = countPathBendDegrees(path)
    if (
      (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') &&
      totalBendDegrees > 360
    ) {
      push({
        severity: 'error',
        codeRef: 'NEC 358.26',
        category: 'raceway-bends',
        title: `Conduit ${runName} exceeds 360° total bends (${totalBendDegrees}°)`,
        message: `${runName} accumulates ${totalBendDegrees}° of bends between pull points (maximum 360° allowed in EMT/RMC/PVC).`,
        nodeIds: [run.id],
        suggestedFix: 'Split the run with an accessible junction/pull box (electrical:device junction-box).',
      })
    }

    // 3c. NEC 334.12 / 300.22(C) Commercial, Plenum & Wet Crawl-Space NM-B restrictions
    if (racewayType === 'nm-b' && (occupancy === 'commercial' || inPlenum)) {
      push({
        severity: 'error',
        codeRef: inPlenum ? 'NEC 300.22(C)' : 'NEC 334.12',
        category: 'wiring-method',
        title: `NM-B cable prohibited on ${runName}`,
        message: inPlenum
          ? `NM-B (Romex) is prohibited in environmental air-handling plenums (NEC 300.22(C)).`
          : `NM-B (Romex) is restricted in commercial construction / suspended ceilings (NEC 334.12).`,
        nodeIds: [run.id],
        suggestedFix: 'Switch racewayType to "emt", "mc", or "rmc".',
      })
    } else if (racewayType === 'nm-b' && path.some((pt) => pt[1] < -0.05)) {
      const runCavities = getCavitiesForLevel(runLevelId)
      if (runCavities.crawlSpaceWet) {
        push({
          severity: 'error',
          codeRef: 'NEC 334.12(B)(4)',
          category: 'wiring-method',
          title: `NM-B cable routed in wet/damp crawl space on ${runName}`,
          message: `Type NM-B cable cannot be installed in wet or damp crawl spaces or unfinished basements (NEC 334.12(B)(4)).`,
          nodeIds: [run.id],
          suggestedFix: 'Switch racewayType to wet-rated "pvc-40"/"emt" with THWN-2 or reroute through dry attic / wall cavities.',
        })
      }
    }

    // 3d. NEC 310.16 / 310.15 / 240.4(D) Derated Ampacity & Breaker OCPD Protection
    const loadAmps = typeof run.loadAmps === 'number' ? run.loadAmps : 16
    const ccc = typeof run.currentCarryingCount === 'number' ? run.currentCarryingCount : 2
    const ambientTempC = typeof run.ambientTempC === 'number' ? run.ambientTempC : 30
    const rooftopExposed = run.rooftopExposed === true
    const continuousLoad = run.continuous === true

    let connectedBreakerAmps: number | undefined =
      typeof run.breakerAmps === 'number' ? run.breakerAmps : undefined
    let connectedDevId: string | undefined
    if (connectedBreakerAmps === undefined && typeof run.targetDeviceId === 'string') {
      const target = nodes[run.targetDeviceId]
      if (target && typeof target.breakerAmps === 'number') {
        connectedBreakerAmps = target.breakerAmps
        connectedDevId = target.id
      }
    }
    if (
      connectedBreakerAmps === undefined &&
      typeof run.panelId === 'string' &&
      typeof run.circuitNumber === 'number'
    ) {
      for (const dev of devices) {
        if (
          dev.panelId === run.panelId &&
          dev.circuitNumber === run.circuitNumber &&
          typeof dev.breakerAmps === 'number'
        ) {
          if (connectedBreakerAmps === undefined || dev.breakerAmps > connectedBreakerAmps) {
            connectedBreakerAmps = dev.breakerAmps
            connectedDevId = dev.id
          }
        }
      }
    }

    const ampResult = calculateDeratedAmpacity({
      wireGauge,
      material,
      insulationRating,
      racewayType,
      ambientTempC,
      rooftopExposed,
      currentCarryingCount: ccc,
      loadAmps,
      continuousLoad,
      breakerAmps: connectedBreakerAmps,
    })
    if (!ampResult.compliant) {
      push({
        severity: 'error',
        codeRef: 'NEC 310.16 / 310.15',
        category: 'ampacity',
        title: `Undersized conductor on ${runName} (#${wireGauge} ${material.toUpperCase()})`,
        message: `Allowable derated ampacity (${ampResult.finalAllowableAmpacity}A) is below required load (${ampResult.requiredAmpacity}A).`,
        nodeIds: [run.id],
        suggestedFix: `Upsize wireGauge to #${ampResult.recommendedGauge} ${material.toUpperCase()}.`,
      })
    } else if (connectedBreakerAmps !== undefined && !ampResult.breakerCompliant) {
      push({
        severity: 'error',
        codeRef: ampResult.smallConductorCapApplied ? 'NEC 240.4(D)' : 'NEC 240.4',
        category: 'ampacity',
        title: `Over-fused conductor on ${runName} (#${wireGauge} ${material.toUpperCase()} on ${connectedBreakerAmps}A breaker)`,
        message: `Circuit breaker (${connectedBreakerAmps}A) exceeds maximum OCPD (${ampResult.maxBreakerAmps}A) permitted for #${wireGauge} ${material.toUpperCase()} (allowable ampacity ${ampResult.finalAllowableAmpacity}A).`,
        nodeIds: connectedDevId ? [run.id, connectedDevId] : [run.id],
        suggestedFix: `Upsize wireGauge to #${ampResult.recommendedGauge} ${material.toUpperCase()} or reduce breaker rating to <= ${ampResult.maxBreakerAmps}A.`,
      })
    }

    // 3e. NEC Chapter 9 Conduit Fill (for EMT / PVC-40 / RMC)
    if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
      const totalConductors = typeof run.totalConductorCount === 'number' ? run.totalConductorCount : ccc + 1
      const lengthIn = polylineLengthM(path) * METERS_TO_FEET * 12
      const fill = calculateConduitFill({
        conduitType: racewayType,
        tradeSize,
        conductors: [{ gauge: wireGauge, count: totalConductors }],
        lengthInches: lengthIn > 0 ? lengthIn : undefined,
      })
      if (!fill.compliant) {
        push({
          severity: 'error',
          codeRef: 'NEC Chapter 9 Table 1',
          category: 'conduit-fill',
          title: `Conduit overfilled on ${runName} (${fill.actualFillPct}% > ${fill.maxAllowedFillPct}%)`,
          message: `${totalConductors}x #${wireGauge} THHN in ${tradeSize} ${racewayType.toUpperCase()} reaches ${fill.actualFillPct}% fill (max ${fill.maxAllowedFillPct}%).`,
          nodeIds: [run.id],
          suggestedFix: `Upsize tradeSize to ${fill.recommendedTradeSize} ${racewayType.toUpperCase()}.`,
        })
      }
    }

    // 3f. NEC 210.19 / 215.2 Voltage Drop from actual 3D routed length
    const lengthFt = polylineLengthM(path) * METERS_TO_FEET
    if (lengthFt > 0 && loadAmps > 0) {
      const voltage = typeof run.voltage === 'number' ? run.voltage : 120
      const phases: 1 | 3 = run.phases === 3 ? 3 : 1
      const vd = calculateVoltageDrop({
        wireGauge,
        material,
        loadAmps,
        oneWayLengthFt: lengthFt,
        voltage,
        phases,
        maxDropPct: 3.0,
      })
      if (!vd.compliant) {
        push({
          severity: vd.voltageDropPct > 5 ? 'error' : 'warning',
          codeRef: 'NEC 210.19 / 215.2',
          category: 'voltage-drop',
          title: `Excessive voltage drop on ${runName} (${vd.voltageDropPct}%)`,
          message: `Actual 3D routed run (${round2(lengthFt)} ft, ${loadAmps}A @ ${voltage}V ${phases}Φ) drops ${vd.voltageDropVolts}V (${vd.voltageDropPct}%, recommended <= 3%).`,
          nodeIds: [run.id],
          suggestedFix: `Upsize wireGauge to #${vd.recommendedGauge} ${material.toUpperCase()} to stay within 3% voltage drop.`,
        })
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length
  const warningCount = findings.filter((f) => f.severity === 'warning').length
  const infoCount = findings.filter((f) => f.severity === 'info').length

  const report: NecSceneAuditReport = {
    passed: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    panelCount: panels.length,
    deviceCount: devices.length,
    conduitRunCount: runs.length,
    transformerCount: transformers.length,
    findings,
  }
  auditSceneCache.set(nodes as object, report)
  return report
}
