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
  type Vec3,
  countPathBendDegrees,
  detectRunTradeClashes,
  extractTradeObstacles,
  polylineLengthM,
} from './routing'
import {
  calculateBoxFill,
  calculateConduitFill,
  calculateDeratedAmpacity,
  calculateVoltageDrop,
} from './sizing'
import {
  type BoxFillGauge,
  type BoxType,
  type ConduitTradeSize,
  type ConductorMaterial,
  type InsulationRating,
  METERS_TO_FEET,
  NEC_220_RESIDENTIAL,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  type WorkingSpaceCondition,
  getWorkingClearance110_26,
  round2,
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
): SceneNodeLike | null {
  for (const n of Object.values(nodes)) {
    if (n.type !== 'zone') continue
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

type OrientedPrismY = {
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

function prismIntersectsAabb(prism: OrientedPrismY, box: Aabb3): boolean {
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

function getEquipmentSpacePrisms(
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

function extractObstructionBox(node: SceneNodeLike): Aabb3 | null {
  const pos = toVec3(node.position)
  if (!pos) return null
  const [x, y, z] = pos
  const asset =
    node.asset && typeof node.asset === 'object'
      ? (node.asset as Record<string, unknown>)
      : null
  const dims: Vec3 = toVec3(node.dimensions) ??
    toVec3(asset?.dimensions) ??
    toVec3(node.size) ?? [
      typeof node.width === 'number' ? node.width : 0.6,
      typeof node.height === 'number' ? node.height : 0.9,
      typeof node.depth === 'number' ? node.depth : 0.6,
    ]
  const hw = dims[0]! / 2
  const hd = dims[2]! / 2
  return {
    min: [x - hw, y, z - hd],
    max: [x + hw, y + dims[1]!, z + hd],
  }
}

const WET_ROOM_CATEGORIES = new Set([
  'kitchen',
  'bathroom',
  'bath',
  'laundry',
  'garage',
  'outdoor',
  'patio',
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

const BATHROOM_PATTERN = /bath|restroom|shower|powder|washroom/i
const CLOSET_PATTERN = /closet|wardrobe/i
const OUTDOOR_PATTERN = /outdoor|patio|deck|porch|balcony|rooftop|exterior|yard/i
const TUB_SHOWER_FIXTURE_PATTERN = /bath.?tub|\btub\b|shower/i
const STOVE_FIXTURE_PATTERN = /\bstove\b|\brange\b|cooktop|oven/i
const SINK_FIXTURE_PATTERN = /\bsink\b|lavatory|basin/i

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

function horizontalDistToAabbXZ(x: number, z: number, box: Aabb3): number {
  const dx = x < box.min[0] ? box.min[0] - x : x > box.max[0] ? x - box.max[0] : 0
  const dz = z < box.min[2] ? box.min[2] - z : z > box.max[2] ? z - box.max[2] : 0
  return Math.hypot(dx, dz)
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

export function auditSceneElectrical(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): NecSceneAuditReport {
  const all = Object.values(nodes)
  const panels = all.filter((n) => n.type === 'electrical:panel')
  const devices = all.filter((n) => n.type === 'electrical:device')
  const runs = all.filter((n) => n.type === 'electrical:conduit-run')
  const transformers = all.filter((n) => n.type === 'electrical:transformer')
  const stairs = all.filter((n) => n.type === 'stair')
  const obstacles = extractTradeObstacles(nodes)

  const wetFixtures: Array<{ node: SceneNodeLike; kind: 'tub-shower' | 'stove' | 'sink'; box: Aabb3 }> = []
  for (const n of all) {
    if (n.type !== 'item' && n.type !== 'procedural-item' && n.type !== 'cabinet') continue
    const txt = fixtureTextOf(n)
    const box = extractObstructionBox(n)
    if (!box) continue
    if (TUB_SHOWER_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, kind: 'tub-shower', box })
    } else if (STOVE_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, kind: 'stove', box })
    } else if (SINK_FIXTURE_PATTERN.test(txt)) {
      wetFixtures.push({ node: n, kind: 'sink', box })
    }
  }

  const findings: NecAuditFinding[] = []
  let seq = 1
  const push = (f: Omit<NecAuditFinding, 'id'>) => {
    findings.push({ id: `nec-${seq++}`, ...f })
  }

  const auditEquipmentClearances = (equip: SceneNodeLike, kind: 'panel' | 'transformer') => {
    const equipName = (typeof equip.name === 'string' && equip.name) || equip.id
    const { workingPrism, dedicatedOverheadPrism, depthIn } = getEquipmentSpacePrisms(equip, kind)

    // NEC 110.26(A) Working Space vs furniture / cabinets / HVAC equipment / columns / floor transformers
    for (const other of all) {
      if (other.id === equip.id) continue
      if (
        other.type !== 'item' &&
        other.type !== 'cabinet' &&
        other.type !== 'hvac-equipment' &&
        other.type !== 'column' &&
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

    // NEC 110.26(E) / 450.21 Dedicated Overhead Space vs foreign plumbing/HVAC directly overhead
    for (const obs of obstacles) {
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

      const pZone = getZoneAt(nodes, pPos[0], pPos[2])
      const pZoneCat =
        typeof pZone?.category === 'string'
          ? pZone.category.toLowerCase()
          : typeof pZone?.name === 'string'
            ? pZone.name.toLowerCase()
            : ''
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

    const solarBackfeed = typeof panel.solarBackfeedAmps === 'number' ? panel.solarBackfeedAmps : 0
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
      const txZone = getZoneAt(nodes, txPos[0], txPos[2])
      const txZoneCat =
        typeof txZone?.category === 'string'
          ? txZone.category.toLowerCase()
          : typeof txZone?.name === 'string'
            ? txZone.name.toLowerCase()
            : ''
      const txNema = typeof tx.nemaRating === 'string' ? tx.nemaRating : 'NEMA-2'
      if (txZoneCat && OUTDOOR_PATTERN.test(txZoneCat) && txNema !== 'NEMA-3R') {
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

  // 2. Audit Devices: NEC 314.16 Box Fill, 210.8 GFCI, 210.12 AFCI
  for (const dev of devices) {
    const devName = (typeof dev.name === 'string' && dev.name) || dev.id
    const occupancy = dev.occupancy === 'commercial' ? 'commercial' : 'residential'
    const boxType = (typeof dev.boxType === 'string' ? dev.boxType : 'single-gang-standard') as BoxType
    const wireGauge = (typeof dev.wireGauge === 'string' ? dev.wireGauge : '12') as BoxFillGauge
    const validBoxGauge: BoxFillGauge = ['18', '16', '14', '12', '10', '8', '6'].includes(wireGauge)
      ? wireGauge
      : '12'
    const conductorCount = typeof dev.conductorCount === 'number' ? dev.conductorCount : 4
    const yokeCount =
      typeof dev.yokeCount === 'number'
        ? dev.yokeCount
        : dev.deviceKind === 'junction-box'
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

    // Zone-based GFCI (210.8) & AFCI (210.12)
    const devPos = toVec3(dev.position)
    if (devPos) {
      const [x, , z] = devPos
      const zone = getZoneAt(nodes, x, z)
      const zoneCat =
        typeof zone?.category === 'string'
          ? zone.category.toLowerCase()
          : typeof zone?.name === 'string'
            ? zone.name.toLowerCase()
            : ''
      const isReceptacle =
        dev.deviceKind === 'duplex' ||
        dev.deviceKind === 'gfci' ||
        dev.deviceKind === 'afci' ||
        dev.deviceKind === 'dedicated-240v'
      const isSwitch = dev.deviceKind === 'switch-1p' || dev.deviceKind === 'switch-3way'
      const isLuminaire = dev.deviceKind === 'luminaire'

      // NEC 406.9(C), 404.4(C), 410.10(D), & 406.5 Fixture-Proximity Prohibited Zones
      for (const fix of wetFixtures) {
        const horizDist = horizontalDistToAabbXZ(x, z, fix.box)
        const devY = devPos[1]
        if (fix.kind === 'tub-shower') {
          if (isReceptacle && horizDist < 0.914 && devY < 2.438) {
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
          if (isLuminaire && horizDist < 0.914 && devY < 2.438) {
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
        } else if (fix.kind === 'sink' && isReceptacle && horizDist === 0 && devY <= 1.05) {
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
        const isWet = Array.from(WET_ROOM_CATEGORIES).some((w) => zoneCat.includes(w))
        if (isWet && dev.gfciProtected !== true && dev.deviceKind !== 'gfci') {
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
          const isHabitable = Array.from(HABITABLE_AFCI_CATEGORIES).some((h) => zoneCat.includes(h))
          if (isHabitable && dev.afciProtected !== true && dev.deviceKind !== 'afci') {
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
    const zone = getZoneAt(nodes, pos[0], pos[2])
    const zCat =
      typeof zone?.category === 'string'
        ? zone.category.toLowerCase()
        : typeof zone?.name === 'string'
          ? zone.name.toLowerCase()
          : ''
    if (!zCat) continue
    const key = `${dev.panelId}:${dev.circuitNumber}`
    const bucket = circuitZones.get(key) ?? { bath: [], kitchen: [], general: [], ckt: dev.circuitNumber }
    const isRecept =
      dev.deviceKind === 'duplex' || dev.deviceKind === 'gfci' || dev.deviceKind === 'afci'
    if (BATHROOM_PATTERN.test(zCat) && isRecept) bucket.bath.push(dev.id)
    else if (zCat.includes('kitchen') && isRecept) bucket.kitchen.push(dev.id)
    else if (/bed|living|hall|office|study|den|family/.test(zCat)) bucket.general.push(dev.id)
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

  // 3. Audit Conduit / Cable Runs: Trade clashes, 360° bends, NM-B commercial/plenum ban, ampacity, conduit fill, voltage drop
  for (const run of runs) {
    const runName = (typeof run.name === 'string' && run.name) || run.id
    const path = Array.isArray(run.path) ? (run.path as Vec3[]) : []
    const racewayType: RacewayType =
      typeof run.racewayType === 'string' ? (run.racewayType as RacewayType) : 'emt'
    const tradeSize: ConduitTradeSize =
      typeof run.tradeSize === 'string' ? (run.tradeSize as ConduitTradeSize) : '3/4"'
    const wireGauge: WireGauge =
      typeof run.wireGauge === 'string' ? (run.wireGauge as WireGauge) : '12'
    const material: ConductorMaterial = run.conductorMaterial === 'al' ? 'al' : 'cu'
    const insulationRating: InsulationRating =
      run.insulationRating === '60C' || run.insulationRating === '75C'
        ? run.insulationRating
        : '90C'
    const occupancy = run.occupancy === 'commercial' ? 'commercial' : 'residential'
    const inPlenum = run.inPlenum === true

    // 3a. Trade-priority clashes (electrical must yield to plumbing, HVAC, structural)
    const clashes = detectRunTradeClashes(path, obstacles)
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
    if (racewayType !== 'nm-b' && totalBendDegrees > 360) {
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

    // 3c. NEC 334.12 / 300.22(C) Commercial & Plenum NM-B restrictions
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

  return {
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
}
