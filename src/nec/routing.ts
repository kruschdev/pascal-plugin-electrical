/**
 * Trade-Priority Obstacle-Aware 3D Electrical Router.
 *
 * Real jobsite trade right-of-way hierarchy:
 *   1. Structural (beams, columns, stairs, door/window openings) — inviolable
 *   2. Plumbing (pipe-segment, pipe-fitting, pipe-trap, liquid-line) — gravity first right-of-way
 *   3. HVAC (duct-segment, duct-fitting, duct-terminal, hvac-equipment, lineset) — rigid trunks
 *   4. Electrical (electrical:conduit-run) — ALWAYS yields & routes around 1-3, never moves pipes or ducts.
 *
 * Every detour computes exact orthogonal 3D conduit length, counts total bend degrees
 * (NEC 358.26 / 344.26 / 352.26 max 360° between pull points), and recommends pull-box locations
 * when yielding around plumbing/HVAC exceeds 360°.
 */

import type { SceneNodeLike } from './load-calc'
import { INCHES_TO_METERS, METERS_TO_FEET, round2 } from './tables'

export type Vec3 = readonly [number, number, number]

export type TradePriority = 'structural' | 'plumbing' | 'hvac'

export type Aabb3 = {
  readonly min: Vec3
  readonly max: Vec3
}

export type TradeObstacle = {
  readonly id: string
  readonly nodeId: string
  readonly nodeType: string
  readonly trade: TradePriority
  readonly priorityRank: 1 | 2 | 3 // 1 = structural, 2 = plumbing, 3 = hvac
  readonly box: Aabb3
  readonly requiredClearanceM: number
  readonly label: string
}

export type AvoidedObstacleRecord = {
  readonly nodeId: string
  readonly nodeType: string
  readonly trade: TradePriority
  readonly label: string
  readonly clearanceM: number
}

export type TradeClashFinding = {
  readonly segmentIndex: number
  readonly obstacleNodeId: string
  readonly obstacleNodeType: string
  readonly trade: TradePriority
  readonly label: string
  readonly clearanceShortfallM: number
  readonly point: Vec3
}

export type RouteElectricalOptions = {
  /** Preferred chase/ceiling routing elevation in level-local meters (default 2.55 m). */
  preferredChaseY?: number
  /** Extra clearance around plumbing & HVAC obstacles in meters (default 0.05 m ≈ 2"). */
  clearanceM?: number
  /** Conduit outer radius in meters (default 0.015 m). */
  conduitRadiusM?: number
  /** Floor/slab minimum Y allowed for horizontal runs (default 0.15 m). */
  minY?: number
  /** Ceiling/structure maximum Y allowed for horizontal runs (default 3.2 m). */
  maxY?: number
  /** Maximum total bend degrees before pull box required (NEC 358.26 = 360°). */
  maxBendDegrees?: number
}

export type ElectricalRouteResult = {
  path: Vec3[]
  directLengthM: number
  routedLengthM: number
  routedLengthFt: number
  detourAddedM: number
  totalBendDegrees: number
  bendCount90: number
  exceedsMaxBends: boolean
  recommendedPullBoxAt: Vec3 | null
  avoidedObstacles: AvoidedObstacleRecord[]
  remainingClashes: TradeClashFinding[]
}

const DEFAULT_CLEARANCE_M = 0.05 // ~2 inches
const HVAC_EQUIPMENT_CLEARANCE_M = 0.15 // ~6 inches

function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number'
  )
}

function expandAabb(box: Aabb3, margin: number): Aabb3 {
  return {
    min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin],
  }
}

function segmentAabb(a: Vec3, b: Vec3, halfWidth: number, halfHeight: number): Aabb3 {
  return {
    min: [
      Math.min(a[0], b[0]) - halfWidth,
      Math.min(a[1], b[1]) - halfHeight,
      Math.min(a[2], b[2]) - halfWidth,
    ],
    max: [
      Math.max(a[0], b[0]) + halfWidth,
      Math.max(a[1], b[1]) + halfHeight,
      Math.max(a[2], b[2]) + halfWidth,
    ],
  }
}

/** Exact Liang-Barsky / slab intersection between 3D line segment [a, b] and AABB. */
export function segmentIntersectsAabb(a: Vec3, b: Vec3, box: Aabb3, eps = 1e-6): boolean {
  let tMin = 0
  let tMax = 1
  for (let axis = 0; axis < 3; axis++) {
    const start = a[axis]!
    const dir = b[axis]! - start
    const bMin = box.min[axis]!
    const bMax = box.max[axis]!
    if (Math.abs(dir) < eps) {
      if (start < bMin - eps || start > bMax + eps) return false
    } else {
      let t1 = (bMin - start) / dir
      let t2 = (bMax - start) / dir
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      tMin = Math.max(tMin, t1)
      tMax = Math.min(tMax, t2)
      if (tMin > tMax + eps) return false
    }
  }
  return tMax >= -eps && tMin <= 1 + eps
}

export function aabbIntersects(a: Aabb3, b: Aabb3): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  )
}

/**
 * Extract all higher-priority trade obstacles (Structural, Plumbing, HVAC) from a Pascal scene graph.
 * Electrical routes around these — it never relocates plumbing pipes or HVAC ducts.
 */
export function extractTradeObstacles(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
): TradeObstacle[] {
  const obstacles: TradeObstacle[] = []

  const belongsToLevel = (node: SceneNodeLike): boolean => {
    if (!levelId) return true
    let cur: SceneNodeLike | undefined = node
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (cur.id === levelId || cur.parentId === levelId) return true
      cur = cur.parentId ? nodes[cur.parentId] : undefined
    }
    // Include nodes with null parentId only when caller didn't filter or no level hierarchy exists
    return node.parentId == null
  }

  for (const node of Object.values(nodes)) {
    if (!belongsToLevel(node)) continue
    const t = node.type

    // 2. Plumbing (gravity DWV + supply pipes — first MEP right-of-way)
    if (t === 'pipe-segment' || t === 'liquid-line') {
      const path = node.path
      if (Array.isArray(path) && path.length >= 2) {
        const diamIn = typeof node.diameter === 'number' ? node.diameter : t === 'liquid-line' ? 0.75 : 2
        const halfM = Math.max(0.015, (diamIn * INCHES_TO_METERS) / 2)
        for (let i = 0; i < path.length - 1; i++) {
          const p0 = path[i]
          const p1 = path[i + 1]
          if (!isVec3(p0) || !isVec3(p1)) continue
          obstacles.push({
            id: `${node.id}:seg${i}`,
            nodeId: node.id,
            nodeType: t,
            trade: 'plumbing',
            priorityRank: 2,
            box: segmentAabb(p0, p1, halfM, halfM),
            requiredClearanceM: DEFAULT_CLEARANCE_M,
            label: `${t === 'pipe-segment' ? `${diamIn}" plumbing pipe` : 'water line'} (${node.id})`,
          })
        }
      }
      continue
    }

    if (t === 'pipe-fitting' || t === 'pipe-trap') {
      if (isVec3(node.position)) {
        const diamIn = typeof node.diameter === 'number' ? node.diameter : 2
        const halfM = Math.max(0.05, (diamIn * INCHES_TO_METERS) / 2 + 0.03)
        const [x, y, z] = node.position
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'plumbing',
          priorityRank: 2,
          box: { min: [x - halfM, y - halfM, z - halfM], max: [x + halfM, y + halfM, z + halfM] },
          requiredClearanceM: DEFAULT_CLEARANCE_M,
          label: `plumbing ${t} (${node.id})`,
        })
      }
      continue
    }

    // 3. HVAC (ducts, trunks, equipment, linesets — second MEP right-of-way)
    if (t === 'duct-segment' || t === 'lineset') {
      const path = node.path
      if (Array.isArray(path) && path.length >= 2) {
        const shape = typeof node.shape === 'string' ? node.shape : 'round'
        const widthIn =
          t === 'lineset'
            ? 1.5
            : shape === 'round'
              ? typeof node.diameter === 'number'
                ? node.diameter
                : 8
              : typeof node.width === 'number'
                ? node.width
                : 14
        const heightIn =
          t === 'lineset'
            ? 1.5
            : shape === 'round'
              ? widthIn
              : typeof node.height === 'number'
                ? node.height
                : 8
        const halfW = Math.max(0.025, (widthIn * INCHES_TO_METERS) / 2)
        const halfH = Math.max(0.025, (heightIn * INCHES_TO_METERS) / 2)
        for (let i = 0; i < path.length - 1; i++) {
          const p0 = path[i]
          const p1 = path[i + 1]
          if (!isVec3(p0) || !isVec3(p1)) continue
          obstacles.push({
            id: `${node.id}:seg${i}`,
            nodeId: node.id,
            nodeType: t,
            trade: 'hvac',
            priorityRank: 3,
            box: segmentAabb(p0, p1, halfW, halfH),
            requiredClearanceM: DEFAULT_CLEARANCE_M,
            label: `${t === 'lineset' ? 'refrigerant lineset' : `HVAC ${shape} duct`} (${node.id})`,
          })
        }
      }
      continue
    }

    if (t === 'hvac-equipment') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const w = typeof node.width === 'number' ? node.width : 0.6
        const d = typeof node.depth === 'number' ? node.depth : 0.7
        const h = typeof node.height === 'number' ? node.height : 1.1
        const halfSpan = Math.max(w, d) / 2
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'hvac',
          priorityRank: 3,
          box: {
            min: [x - halfSpan, y, z - halfSpan],
            max: [x + halfSpan, y + h, z + halfSpan],
          },
          requiredClearanceM: HVAC_EQUIPMENT_CLEARANCE_M,
          label: `HVAC equipment (${node.id})`,
        })
      }
      continue
    }

    if (t === 'duct-fitting' || t === 'duct-terminal') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const half = 0.14
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'hvac',
          priorityRank: 3,
          box: { min: [x - half, y - half, z - half], max: [x + half, y + half, z + half] },
          requiredClearanceM: DEFAULT_CLEARANCE_M,
          label: `HVAC ${t} (${node.id})`,
        })
      }
      continue
    }

    // 1. Structural (beams, columns — inviolable)
    if (t === 'beam') {
      const start = node.start
      const end = node.end
      if (isVec3(start) && isVec3(end)) {
        const w = typeof node.width === 'number' ? node.width : 0.2
        const h = typeof node.height === 'number' ? node.height : 0.3
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box: segmentAabb(start, end, w / 2, h / 2),
          requiredClearanceM: 0.03,
          label: `structural beam (${node.id})`,
        })
      }
      continue
    }

    if (t === 'column') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const w = typeof node.width === 'number' ? node.width : 0.3
        const d = typeof node.depth === 'number' ? node.depth : w
        const h = typeof node.height === 'number' ? node.height : 2.8
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box: { min: [x - w / 2, y, z - d / 2], max: [x + w / 2, y + h, z + d / 2] },
          requiredClearanceM: 0.03,
          label: `structural column (${node.id})`,
        })
      }
    }
  }

  return obstacles.sort((a, b) => a.priorityRank - b.priorityRank)
}

// ─── Polyline Geometry & Bend Math ──────────────────────────────────────────

export function polylineLengthM(path: readonly Vec3[]): number {
  let sum = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return round2(sum)
}

export function simplifyOrthogonalPath(points: readonly Vec3[], eps = 1e-4): Vec3[] {
  const deduped: Vec3[] = []
  for (const pt of points) {
    const prev = deduped[deduped.length - 1]
    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1], pt[2] - prev[2]) > eps) {
      deduped.push([round3(pt[0]), round3(pt[1]), round3(pt[2])])
    }
  }
  if (deduped.length <= 2) return deduped

  const out: Vec3[] = [deduped[0]!]
  for (let i = 1; i < deduped.length - 1; i++) {
    const a = out[out.length - 1]!
    const b = deduped[i]!
    const c = deduped[i + 1]!
    const v1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v2: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
    const len1 = Math.hypot(v1[0], v1[1], v1[2])
    const len2 = Math.hypot(v2[0], v2[1], v2[2])
    if (len1 < eps || len2 < eps) continue
    const dot = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (len1 * len2)
    // Drop collinear intermediate vertex
    if (dot > 0.9995) continue
    out.push(b)
  }
  out.push(deduped[deduped.length - 1]!)
  return out
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Compute cumulative bend degrees along a 3D conduit polyline (NEC 358.26 / 344.26 / 352.26).
 * Max 360° permitted between pull points (boxes/fittings).
 */
export function countPathBendDegrees(path: readonly Vec3[]): {
  totalBendDegrees: number
  bendCount90: number
  pullBoxIndex: number | null
} {
  let total = 0
  let count90 = 0
  let pullBoxIndex: number | null = null

  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const c = path[i + 1]!
    const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
    const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]] as const
    const len1 = Math.hypot(v1[0], v1[1], v1[2])
    const len2 = Math.hypot(v2[0], v2[1], v2[2])
    if (len1 < 1e-4 || len2 < 1e-4) continue
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (len1 * len2)))
    const deg = (Math.acos(cos) * 180) / Math.PI
    if (deg > 1) {
      total += deg
      if (deg >= 75) count90 += 1
      if (pullBoxIndex === null && total > 270) {
        pullBoxIndex = i
      }
    }
  }
  return { totalBendDegrees: Math.round(total), bendCount90: count90, pullBoxIndex }
}

/** Detect clashes between a conduit/cable polyline and higher-priority trade obstacles. */
export function detectRunTradeClashes(
  path: readonly Vec3[],
  obstacles: readonly TradeObstacle[],
  extraClearanceM = 0.05,
  conduitRadiusM = 0.015,
): TradeClashFinding[] {
  const clashes: TradeClashFinding[] = []
  const seenKey = new Set<string>()

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    for (const obs of obstacles) {
      const margin = Math.max(obs.requiredClearanceM, extraClearanceM) + conduitRadiusM
      const expanded = expandAabb(obs.box, margin)
      if (!segmentIntersectsAabb(a, b, expanded)) continue
      const key = `${obs.nodeId}:${i}`
      if (seenKey.has(key)) continue
      seenKey.add(key)
      const mid: Vec3 = [round3((a[0] + b[0]) / 2), round3((a[1] + b[1]) / 2), round3((a[2] + b[2]) / 2)]
      clashes.push({
        segmentIndex: i,
        obstacleNodeId: obs.nodeId,
        obstacleNodeType: obs.nodeType,
        trade: obs.trade,
        label: obs.label,
        clearanceShortfallM: round2(margin),
        point: mid,
      })
    }
  }
  return clashes
}

function buildManhattanCandidate(start: Vec3, end: Vec3, chaseY: number, order: 'xz' | 'zx'): Vec3[] {
  const pts: Vec3[] = [start]
  const sRise: Vec3 = [start[0], chaseY, start[2]]
  const eDrop: Vec3 = [end[0], chaseY, end[2]]
  pts.push(sRise)
  if (order === 'xz') {
    pts.push([end[0], chaseY, start[2]])
  } else {
    pts.push([start[0], chaseY, end[2]])
  }
  pts.push(eDrop, end)
  return simplifyOrthogonalPath(pts)
}

/**
 * Given a single axis-aligned segment [a, b] that hits obstacle `obs`, generate
 * clean orthogonal saddle/jog detours (over, under, left, right) around `obs`.
 */
function buildSegmentDetours(
  a: Vec3,
  b: Vec3,
  expanded: Aabb3,
  minY: number,
  maxY: number,
): Vec3[][] {
  const stepPad = 0.03
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  const dz = Math.abs(b[2] - a[2])
  const detours: Vec3[][] = []

  // Horizontal X-run: jog around in Y (over/under) or Z (sideways)
  if (dx >= dy && dx >= dz) {
    const dir = b[0] >= a[0] ? 1 : -1
    const xBefore = dir > 0 ? Math.max(a[0], expanded.min[0] - stepPad) : Math.min(a[0], expanded.max[0] + stepPad)
    const xAfter = dir > 0 ? Math.min(b[0], expanded.max[0] + stepPad) : Math.max(b[0], expanded.min[0] - stepPad)
    const yOver = expanded.max[1] + stepPad
    const yUnder = expanded.min[1] - stepPad
    const zPlus = expanded.max[2] + stepPad
    const zMinus = expanded.min[2] - stepPad

    if (yOver <= maxY) {
      detours.push([a, [xBefore, a[1], a[2]], [xBefore, yOver, a[2]], [xAfter, yOver, a[2]], [xAfter, b[1], b[2]], b])
    }
    if (yUnder >= minY) {
      detours.push([a, [xBefore, a[1], a[2]], [xBefore, yUnder, a[2]], [xAfter, yUnder, a[2]], [xAfter, b[1], b[2]], b])
    }
    detours.push([a, [xBefore, a[1], a[2]], [xBefore, a[1], zPlus], [xAfter, a[1], zPlus], [xAfter, b[1], b[2]], b])
    detours.push([a, [xBefore, a[1], a[2]], [xBefore, a[1], zMinus], [xAfter, a[1], zMinus], [xAfter, b[1], b[2]], b])
  } else if (dz >= dx && dz >= dy) {
    // Horizontal Z-run: jog around in Y (over/under) or X (sideways)
    const dir = b[2] >= a[2] ? 1 : -1
    const zBefore = dir > 0 ? Math.max(a[2], expanded.min[2] - stepPad) : Math.min(a[2], expanded.max[2] + stepPad)
    const zAfter = dir > 0 ? Math.min(b[2], expanded.max[2] + stepPad) : Math.max(b[2], expanded.min[2] - stepPad)
    const yOver = expanded.max[1] + stepPad
    const yUnder = expanded.min[1] - stepPad
    const xPlus = expanded.max[0] + stepPad
    const xMinus = expanded.min[0] - stepPad

    if (yOver <= maxY) {
      detours.push([a, [a[0], a[1], zBefore], [a[0], yOver, zBefore], [a[0], yOver, zAfter], [b[0], b[1], zAfter], b])
    }
    if (yUnder >= minY) {
      detours.push([a, [a[0], a[1], zBefore], [a[0], yUnder, zBefore], [a[0], yUnder, zAfter], [b[0], b[1], zAfter], b])
    }
    detours.push([a, [a[0], a[1], zBefore], [xPlus, a[1], zBefore], [xPlus, a[1], zAfter], [b[0], b[1], zAfter], b])
    detours.push([a, [a[0], a[1], zBefore], [xMinus, a[1], zBefore], [xMinus, a[1], zAfter], [b[0], b[1], zAfter], b])
  } else {
    // Vertical Y-riser: offset laterally in X or Z around obstacle
    const dir = b[1] >= a[1] ? 1 : -1
    const yBefore = dir > 0 ? Math.max(a[1], expanded.min[1] - stepPad) : Math.min(a[1], expanded.max[1] + stepPad)
    const yAfter = dir > 0 ? Math.min(b[1], expanded.max[1] + stepPad) : Math.max(b[1], expanded.min[1] - stepPad)
    const xPlus = expanded.max[0] + stepPad
    const xMinus = expanded.min[0] - stepPad
    const zPlus = expanded.max[2] + stepPad
    const zMinus = expanded.min[2] - stepPad

    detours.push([a, [a[0], yBefore, a[2]], [xPlus, yBefore, a[2]], [xPlus, yAfter, a[2]], [b[0], yAfter, b[2]], b])
    detours.push([a, [a[0], yBefore, a[2]], [xMinus, yBefore, a[2]], [xMinus, yAfter, a[2]], [b[0], yAfter, b[2]], b])
    detours.push([a, [a[0], yBefore, a[2]], [a[0], yBefore, zPlus], [a[0], yAfter, zPlus], [b[0], yAfter, b[2]], b])
    detours.push([a, [a[0], yBefore, a[2]], [a[0], yBefore, zMinus], [a[0], yAfter, zMinus], [b[0], yAfter, b[2]], b])
  }

  return detours.map((d) => simplifyOrthogonalPath(d))
}

/**
 * Route an electrical conduit/cable run orthogonally in 3D from `start` to `end`,
 * automatically yielding around all higher-priority trade obstacles (Structural -> Plumbing -> HVAC).
 */
export function routeElectricalRun(
  start: Vec3,
  end: Vec3,
  obstacles: readonly TradeObstacle[],
  options: RouteElectricalOptions = {},
): ElectricalRouteResult {
  const preferredChaseY = options.preferredChaseY ?? 2.55
  const clearanceM = options.clearanceM ?? DEFAULT_CLEARANCE_M
  const conduitRadiusM = options.conduitRadiusM ?? 0.015
  const minY = options.minY ?? 0.15
  const maxY = options.maxY ?? 3.2
  const maxBendDegrees = options.maxBendDegrees ?? 360

  // Baseline naive route (without obstacles) to measure detour overhead & avoided obstacles
  const baselineXZ = buildManhattanCandidate(start, end, preferredChaseY, 'xz')
  const baselineZX = buildManhattanCandidate(start, end, preferredChaseY, 'zx')
  const baseline =
    polylineLengthM(baselineXZ) <= polylineLengthM(baselineZX) ? baselineXZ : baselineZX
  const directLengthM = polylineLengthM(baseline)
  const baselineClashes = detectRunTradeClashes(baseline, obstacles, clearanceM, conduitRadiusM)

  // Candidate chase elevations stay in the overhead ceiling/plenum zone
  // (never dropping mid-room across doorways or walkways), preferring the exact chase Y
  // before stepping slightly above or below pipes/ducts.
  const candidateElevations = [
    preferredChaseY,
    Math.min(maxY, preferredChaseY + 0.25),
    Math.min(maxY, preferredChaseY + 0.45),
    Math.max(Math.min(preferredChaseY, 2.2), preferredChaseY - 0.25),
  ]

  let bestPath: Vec3[] = baseline
  let bestScore = Number.POSITIVE_INFINITY

  const scorePath = (p: Vec3[]): { score: number; clashes: TradeClashFinding[] } => {
    const clashes = detectRunTradeClashes(p, obstacles, clearanceM, conduitRadiusM)
    const len = polylineLengthM(p)
    const { totalBendDegrees } = countPathBendDegrees(p)
    // Strongly prioritize 0 clashes, staying near preferred chase elevation, fewer bends, then shorter length
    const bendPenalty = totalBendDegrees > maxBendDegrees ? 50 : totalBendDegrees * 0.004
    return { score: clashes.length * 1000 + len + bendPenalty, clashes }
  }

  // Step 1: Try clean Manhattan candidates across chase elevations & XZ/ZX orders
  for (const y of candidateElevations) {
    for (const order of ['xz', 'zx'] as const) {
      const candidate = buildManhattanCandidate(start, end, y, order)
      const { score, clashes } = scorePath(candidate)
      if (score < bestScore) {
        bestScore = score
        bestPath = candidate
      }
      if (clashes.length === 0 && y === preferredChaseY) break
    }
  }

  // Step 2: If clashes remain, iteratively splice orthogonal saddle/jog detours around each hit obstacle
  let currentPath = bestPath
  const maxIterations = 8
  for (let iter = 0; iter < maxIterations; iter++) {
    const clashes = detectRunTradeClashes(currentPath, obstacles, clearanceM, conduitRadiusM)
    if (clashes.length === 0) break

    const firstClash = clashes[0]!
    const obs = obstacles.find((o) => o.nodeId === firstClash.obstacleNodeId)
    if (!obs) break

    const segIdx = firstClash.segmentIndex
    const segA = currentPath[segIdx]!
    const segB = currentPath[segIdx + 1]!
    const margin = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
    const expanded = expandAabb(obs.box, margin)
    const detours = buildSegmentDetours(segA, segB, expanded, minY, maxY)

    let improved = false
    let localBest = currentPath
    let localBestScore = scorePath(currentPath).score

    for (const detour of detours) {
      const spliced = simplifyOrthogonalPath([
        ...currentPath.slice(0, segIdx),
        ...detour,
        ...currentPath.slice(segIdx + 2),
      ])
      const { score } = scorePath(spliced)
      if (score < localBestScore) {
        localBestScore = score
        localBest = spliced
        improved = true
      }
    }

    if (!improved) break
    currentPath = localBest
    if (localBestScore < bestScore) {
      bestScore = localBestScore
      bestPath = localBest
    }
  }

  const finalClashes = detectRunTradeClashes(bestPath, obstacles, clearanceM, conduitRadiusM)
  const remainingIds = new Set(finalClashes.map((c) => c.obstacleNodeId))

  // Every obstacle that clashed on the naive baseline (or near the corridor) and is now cleared
  const avoidedMap = new Map<string, AvoidedObstacleRecord>()
  for (const bc of baselineClashes) {
    if (!remainingIds.has(bc.obstacleNodeId) && !avoidedMap.has(bc.obstacleNodeId)) {
      avoidedMap.set(bc.obstacleNodeId, {
        nodeId: bc.obstacleNodeId,
        nodeType: bc.obstacleNodeType,
        trade: bc.trade,
        label: bc.label,
        clearanceM: bc.clearanceShortfallM,
      })
    }
  }

  const routedLengthM = polylineLengthM(bestPath)
  const routedLengthFt = round2(routedLengthM * METERS_TO_FEET)
  const detourAddedM = round2(Math.max(0, routedLengthM - directLengthM))
  const { totalBendDegrees, bendCount90, pullBoxIndex } = countPathBendDegrees(bestPath)
  const exceedsMaxBends = totalBendDegrees > maxBendDegrees
  const recommendedPullBoxAt =
    exceedsMaxBends && pullBoxIndex !== null ? bestPath[pullBoxIndex] ?? null : null

  return {
    path: bestPath,
    directLengthM,
    routedLengthM,
    routedLengthFt,
    detourAddedM,
    totalBendDegrees,
    bendCount90,
    exceedsMaxBends,
    recommendedPullBoxAt,
    avoidedObstacles: Array.from(avoidedMap.values()),
    remainingClashes: finalClashes,
  }
}
