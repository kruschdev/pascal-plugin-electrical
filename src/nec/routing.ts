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
import {
  INCHES_TO_METERS,
  METERS_TO_FEET,
  type RacewayType,
  type WireGauge,
  round2,
} from './tables'

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

export type RoutingWallSegment = {
  readonly id: string
  readonly start: readonly [number, number]
  readonly end: readonly [number, number]
  readonly thickness: number
  readonly height: number
  /** Door opening intervals `[tMin, tMax]` (meters from `start`) so same-wall runs climb over doors. */
  readonly doorSpans?: readonly (readonly [number, number])[]
}

export type RoutingCavityContext = {
  /** Accessible attic or framed ceiling-joist cavity exists above the active level. */
  readonly hasAttic: boolean
  /** Accessible crawl space, unfinished basement, or raised pier-and-beam void exists below the active level. */
  readonly hasCrawlSpace: boolean
  /** True when the detected crawl space is flagged damp/wet (prohibits NM-B per NEC 334.12(B)(4)). */
  readonly crawlSpaceWet: boolean
  /** Level-local elevation (m) for horizontal Euclidean pulls inside the attic/ceiling cavity. */
  readonly atticY: number
  /** Level-local elevation (m, negative below finished floor) inside the floor-joist / crawl-space cavity. */
  readonly crawlSpaceY: number
  /** Human-readable provenance tags describing which scene nodes revealed accessible cavities. */
  readonly sources: readonly string[]
}

export type RoutingMode =
  | 'wall-manhattan'
  | 'attic-euclidean'
  | 'crawlspace-euclidean'
  | 'open-manhattan'

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
  /** Optional building walls so conduit/cable follows wall Manhattan geometry instead of cutting across open rooms. */
  walls?: readonly RoutingWallSegment[]
  /**
   * Whether wall-following runs route concealed inside the wall centerline ('in-wall', default)
   * or surface-mounted on the exterior drywall face ('surface').
   */
  wallPlacement?: 'in-wall' | 'surface'
  /** Raceway/cable method: flexible cable ('nm-b' | 'mc') can transition to Euclidean pulls inside attic/crawlspace cavities; rigid conduit ('emt' | 'pvc-40' | 'rmc') stays orthogonal per NEC 110.12 / 358.30. */
  racewayType?: RacewayType
  /** Conductor gauge (used for NEC 334.15(C) bored-joist / running-board rule in crawl spaces). */
  wireGauge?: WireGauge
  /** Detected or user-configured attic / crawl-space structural cavities. */
  cavities?: Partial<RoutingCavityContext>
  /**
   * Routing geometry policy:
   * - 'auto' (default): Manhattan inside wall cavities; automatically transitions to straight Euclidean pulls
   *   inside an accessible attic or crawl space when shorter, zero-clash, and NEC-compliant.
   * - 'wall-only': Force strictly wall-guided Manhattan geometry (never enter attic or crawl space).
   */
  routingStrategy?: 'auto' | 'wall-only'
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
  routingMode: RoutingMode
  necNotes: string[]
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
 * Resolve the owning Pascal `level` node ID for any scene node by walking its `parentId` chain.
 */
export function resolveNodeLevelId(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
): string | null {
  let cur: SceneNodeLike | undefined = node
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.type === 'level') return cur.id
    cur = cur.parentId ? nodes[cur.parentId] : undefined
  }
  return null
}

/**
 * Determine whether `node` belongs to `levelId` (returns true when `levelId` is null,
 * when `node` descends from `levelId`, or when `node.parentId == null` in flat/unparented scenes).
 */
export function belongsToLevel(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
  levelId: string | null | undefined,
): boolean {
  if (!levelId) return true
  let cur: SceneNodeLike | undefined = node
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.id === levelId || cur.parentId === levelId) return true
    cur = cur.parentId ? nodes[cur.parentId] : undefined
  }
  return node.parentId == null
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

  for (const node of Object.values(nodes)) {
    if (!belongsToLevel(nodes, node, levelId)) continue
    const t = node.type

    // 2. Plumbing (gravity DWV + supply pipes — first MEP right-of-way)
    if (t === 'pipe-segment' || t === 'liquid-line' || t === 'plumbing:pipe-run') {
      const path = node.path
      if (Array.isArray(path) && path.length >= 2) {
        const parseNominalIn = (raw: unknown): number | null => {
          if (typeof raw === 'number' && raw > 0) return raw
          if (typeof raw !== 'string') return null
          const cleaned = raw.replace(/"/g, '').trim()
          if (cleaned.includes('-')) {
            const [whole, frac] = cleaned.split('-')
            const [num, den] = (frac ?? '').split('/')
            if (whole && num && den) return Number(whole) + Number(num) / Number(den)
          }
          if (cleaned.includes('/')) {
            const [num, den] = cleaned.split('/')
            if (num && den) return Number(num) / Number(den)
          }
          const n = Number(cleaned)
          return Number.isFinite(n) && n > 0 ? n : null
        }
        const diamIn =
          parseNominalIn(node.diameter) ??
          parseNominalIn(node.nominalSize) ??
          (t === 'liquid-line' ? 0.75 : 2)
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
            label: `${t === 'liquid-line' ? 'water line' : `${diamIn}" plumbing pipe`} (${node.id})`,
          })
        }
      }
      continue
    }

    if (t === 'plumbing:equipment' || t === 'plumbing:manifold') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const eqKind = typeof node.equipmentKind === 'string' ? node.equipmentKind : ''
        let halfW = t === 'plumbing:manifold' ? 0.24 : 0.30
        let minY = y
        let maxY = y + (t === 'plumbing:manifold' ? 0.70 : 1.55)
        if (t === 'plumbing:equipment') {
          if (eqKind === 'expansion-tank') {
            halfW = 0.12
            minY = y - 0.15
            maxY = y + 0.25
          } else if (eqKind === 'water-heater-tankless-gas') {
            halfW = 0.22
            minY = y + 0.90
            maxY = y + 1.95
          } else if (
            eqKind === 'recirc-pump' ||
            eqKind === 'main-shutoff-prv' ||
            eqKind === 'backwater-valve' ||
            eqKind === 'gas-meter'
          ) {
            halfW = 0.16
            minY = y
            maxY = y + 0.45
          } else if (eqKind === 'sump-pump' || eqKind === 'sewage-ejector') {
            halfW = 0.24
            minY = y
            maxY = y + 0.55
          } else if (eqKind === 'water-softener' || eqKind === 'pressure-tank') {
            halfW = 0.24
            minY = y
            maxY = y + 1.35
          }
        }
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'plumbing',
          priorityRank: 2,
          box: { min: [x - halfW, minY, z - halfW], max: [x + halfW, maxY, z + halfW] },
          requiredClearanceM: DEFAULT_CLEARANCE_M,
          label: `${t === 'plumbing:manifold' ? 'plumbing manifold' : 'plumbing equipment'} (${node.name ?? node.id})`,
        })
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
    if (t === 'duct-segment' || t === 'lineset' || t === 'hvac:duct-run') {
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

    if (t === 'hvac-equipment' || t === 'hvac:equipment') {
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

    // 1. Structural (beams, columns, and `@kruschdev/pascal-plugin-structural` nodes — inviolable)
    if (t === 'structural:beam') {
      const s = node.start
      const e = node.end
      if (Array.isArray(s) && s.length >= 2 && Array.isArray(e) && e.length >= 2) {
        const y = typeof node.elevationY === 'number' ? node.elevationY : 2.4
        const w =
          (typeof node.widthIn === 'number' ? node.widthIn : 3.5) * INCHES_TO_METERS
        const h =
          (typeof node.depthIn === 'number' ? node.depthIn : 11.875) * INCHES_TO_METERS
        const p0: Vec3 = [Number(s[0]), y, Number(s[1])]
        const p1: Vec3 = [Number(e[0]), y, Number(e[1])]
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box: segmentAabb(p0, p1, w / 2, h / 2),
          requiredClearanceM: 0.03,
          label: `structural beam ${String(node.designation ?? node.beamType ?? '')} (${node.id})`.trim(),
        })
      }
      continue
    }

    if (t === 'structural:column') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const w =
          (typeof node.widthIn === 'number' ? node.widthIn : 5.5) * INCHES_TO_METERS
        const d =
          (typeof node.depthIn === 'number' ? node.depthIn : 5.5) * INCHES_TO_METERS
        const h = typeof node.heightM === 'number' ? node.heightM : 2.8
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box: { min: [x - w / 2, y, z - d / 2], max: [x + w / 2, y + h, z + d / 2] },
          requiredClearanceM: 0.03,
          label: `structural column ${String(node.designation ?? node.columnType ?? '')} (${node.id})`.trim(),
        })
      }
      continue
    }

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

/**
 * Resolve the architectural ceiling/wall height (meters) of a Pascal level.
 * Checks the level node's explicit `height`, then falls back to wall node heights,
 * and finally Pascal's standard 2.5 m level height.
 */
export function resolveLevelHeightM(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
): number {
  const all = Object.values(nodes)
  const levelNode =
    (levelId ? nodes[levelId] : undefined) ?? all.find((n) => n.type === 'level')
  if (
    levelNode &&
    typeof levelNode.height === 'number' &&
    levelNode.height >= 1.8 &&
    levelNode.height <= 12
  ) {
    return levelNode.height
  }

  let maxWallH = 0
  for (const n of all) {
    if (n.type !== 'wall') continue
    if (levelId && n.parentId && n.parentId !== levelId) continue
    if (typeof n.height === 'number' && n.height >= 1.8 && n.height <= 12) {
      if (n.height > maxWallH) maxWallH = n.height
    }
  }
  return maxWallH > 0 ? maxWallH : 2.5
}

/**
 * Extract 2D wall centerlines (with height, thickness, and door opening spans) from a Pascal scene graph
 * so `routeElectricalRun` strictly follows building walls instead of cutting across open rooms.
 */
export function extractRoutingWalls(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
): RoutingWallSegment[] {
  const all = Object.values(nodes)
  const defaultHeight = resolveLevelHeightM(nodes, levelId)

  const belongsToLevel = (node: SceneNodeLike): boolean => {
    if (!levelId) return true
    let cur: SceneNodeLike | undefined = node
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (cur.id === levelId || cur.parentId === levelId) return true
      cur = cur.parentId ? nodes[cur.parentId] : undefined
    }
    return node.parentId == null
  }

  const walls: RoutingWallSegment[] = []
  for (const n of all) {
    if (n.type !== 'wall') continue
    if (!belongsToLevel(n)) continue
    if (!Array.isArray(n.start) || !Array.isArray(n.end)) continue
    const sx = Number(n.start[0])
    const sz = Number(n.start[1])
    const ex = Number(n.end[0])
    const ez = Number(n.end[1])
    const len = Math.hypot(ex - sx, ez - sz)
    if (!Number.isFinite(len) || len < 0.1) continue

    const dx = (ex - sx) / len
    const dz = (ez - sz) / len
    const thickness =
      typeof n.thickness === 'number' && n.thickness > 0 ? n.thickness : 0.14
    const height =
      typeof n.height === 'number' && n.height >= 1.5 ? n.height : defaultHeight

    const doorSpans: Array<[number, number]> = []
    for (const child of all) {
      if (child.parentId !== n.id || child.type !== 'door') continue
      const openW = typeof child.width === 'number' && child.width > 0 ? child.width : 0.9
      let tCenter = len / 2
      if (Array.isArray(child.position) && typeof child.position[0] === 'number') {
        const px = child.position[0] as number
        const pz = typeof child.position[2] === 'number' ? (child.position[2] as number) : 0
        if (Math.abs(pz) < 0.4 && px >= -0.2 && px <= len + 0.2) {
          tCenter = px
        } else {
          tCenter = (px - sx) * dx + (pz - sz) * dz
        }
      }
      doorSpans.push([
        Math.max(0, tCenter - openW / 2 - 0.1),
        Math.min(len, tCenter + openW / 2 + 0.1),
      ])
    }

    walls.push({
      id: n.id,
      start: [sx, sz],
      end: [ex, ez],
      thickness,
      height,
      doorSpans: doorSpans.length > 0 ? doorSpans : undefined,
    })
  }
  return walls
}

/**
 * Inspect a Pascal scene graph to detect accessible overhead attic/joist cavities
 * and under-floor crawl-space / unfinished-basement cavities for hybrid
 * Wall-Manhattan <-> Cavity-Euclidean cable routing.
 */
export function extractRoutingCavities(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
): RoutingCavityContext {
  const all = Object.values(nodes)
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const activeLevel =
    (levelId ? nodes[levelId] : undefined) ?? all.find((n) => n.type === 'level')
  const activeLevelId = activeLevel?.id ?? levelId ?? null
  const activeLevelNum =
    activeLevel && typeof activeLevel.level === 'number' ? activeLevel.level : 0

  const levelNumById = new Map<string, number>()
  for (const n of all) {
    if (n.type === 'level') {
      levelNumById.set(n.id, typeof n.level === 'number' ? n.level : 0)
    }
  }

  let hasAttic = false
  let hasCrawlSpace = false
  let crawlSpaceWet = false
  const sources: string[] = []
  const addSource = (s: string) => {
    if (!sources.includes(s)) sources.push(s)
  }

  const ATTIC_PATTERN = /\b(attic|plenum|truss|rafter)\b/i
  const CRAWL_PATTERN = /\b(crawl\s*space|crawlspace|subfloor|underfloor|unfinished\s*basement|basement|cellar)\b/i
  const WET_CRAWL_PATTERN = /\b(wet|damp|flood|moist|exposed\s*earth)\b/i

  for (const n of all) {
    const t = n.type
    const nLevelId = resolveNodeLevelId(nodes, n)
    const nLevelNum = nLevelId !== null ? (levelNumById.get(nLevelId) ?? 0) : activeLevelNum
    const nameCat = `${typeof n.name === 'string' ? n.name : ''} ${typeof n.category === 'string' ? n.category : ''}`
    const meta = (n.metadata && typeof n.metadata === 'object' ? n.metadata : {}) as Record<string, unknown>

    // 1. Attic / overhead joist cavity detection
    if (t === 'roof' || t === 'roof-segment') {
      if (nLevelId === null || nLevelId === activeLevelId || nLevelNum >= activeLevelNum) {
        hasAttic = true
        addSource('roof')
      }
    } else if (t === 'level' && n.id !== activeLevelId) {
      if (typeof n.level === 'number' && n.level === activeLevelNum + 1) {
        hasAttic = true
        addSource('upper-floor-joists')
      }
      if (
        (typeof n.level === 'number' && n.level < activeLevelNum && CRAWL_PATTERN.test(nameCat)) ||
        (n.level === undefined && CRAWL_PATTERN.test(nameCat))
      ) {
        hasCrawlSpace = true
        addSource('lower-crawlspace-level')
        if (WET_CRAWL_PATTERN.test(nameCat) || meta.wet === true || meta.damp === true) {
          crawlSpaceWet = true
        }
      }
    } else if (t === 'ceiling' && belongsToLevel(nodes, n, activeLevelId)) {
      if (meta.hasAttic === true || meta.plenum === true || ATTIC_PATTERN.test(nameCat)) {
        hasAttic = true
        addSource('ceiling-plenum')
      }
    } else if (t === 'zone') {
      if (ATTIC_PATTERN.test(nameCat) && nLevelNum >= activeLevelNum) {
        hasAttic = true
        addSource('attic-zone')
      }
      if (CRAWL_PATTERN.test(nameCat) && (nLevelId !== activeLevelId || /crawl\s*space|crawlspace|subfloor/i.test(nameCat))) {
        hasCrawlSpace = true
        addSource('crawlspace-zone')
        if (WET_CRAWL_PATTERN.test(nameCat) || meta.wet === true || meta.damp === true) {
          crawlSpaceWet = true
        }
      }
    } else if (t === 'slab' && belongsToLevel(nodes, n, activeLevelId)) {
      const elev = typeof n.elevation === 'number' ? n.elevation : 0
      if (elev >= 0.35 || meta.crawlSpace === true) {
        hasCrawlSpace = true
        addSource('raised-slab')
        if (meta.wet === true || meta.damp === true) crawlSpaceWet = true
      }
    }
  }

  // Also check if a lower level below activeLevelNum contains a crawlspace/basement/utility zone
  if (!hasCrawlSpace) {
    for (const n of all) {
      if (n.type !== 'zone') continue
      const nLevelId = resolveNodeLevelId(nodes, n)
      if (!nLevelId || nLevelId === activeLevelId) continue
      const nLevelNum = levelNumById.get(nLevelId) ?? 0
      if (nLevelNum >= activeLevelNum) continue
      const nameCat = `${typeof n.name === 'string' ? n.name : ''} ${typeof n.category === 'string' ? n.category : ''}`
      if (CRAWL_PATTERN.test(nameCat) || /utility|mechanical/i.test(nameCat)) {
        hasCrawlSpace = true
        addSource('lower-level-utility')
        const meta = (n.metadata && typeof n.metadata === 'object' ? n.metadata : {}) as Record<string, unknown>
        if (WET_CRAWL_PATTERN.test(nameCat) || meta.wet === true || meta.damp === true) {
          crawlSpaceWet = true
        }
      }
    }
  }

  return {
    hasAttic,
    hasCrawlSpace,
    crawlSpaceWet,
    atticY: round3(levelHeight + 0.12),
    crawlSpaceY: -0.18,
    sources,
  }
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

// ─── Wall-Guided Manhattan Geometry (2D Wall Graph + Dijkstra) ──────────────

type WallProjection = {
  wallIdx: number
  t: number
  len: number
  x: number
  z: number
  dist: number
  signedDist: number
  dx: number
  dz: number
  wall: RoutingWallSegment
}

function projectPointToWalls(
  px: number,
  pz: number,
  walls: readonly RoutingWallSegment[],
): WallProjection | null {
  let best: WallProjection | null = null
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]!
    const vx = w.end[0] - w.start[0]
    const vz = w.end[1] - w.start[1]
    const len = Math.hypot(vx, vz)
    if (len < 1e-4) continue
    const dx = vx / len
    const dz = vz / len
    const rawT = (px - w.start[0]) * dx + (pz - w.start[1]) * dz
    const t = Math.max(0, Math.min(len, rawT))
    const x = w.start[0] + dx * t
    const z = w.start[1] + dz * t
    const dist = Math.hypot(px - x, pz - z)
    // Left normal (-dz, dx)
    const signedDist = (px - x) * -dz + (pz - z) * dx
    if (!best || dist < best.dist - 1e-4) {
      best = { wallIdx: i, t, len, x, z, dist, signedDist, dx, dz, wall: w }
    }
  }
  return best
}

function isEndpointWallMounted(pt: Vec3, proj: WallProjection): boolean {
  const wallSnapThreshold = Math.max(0.32, proj.wall.thickness / 2 + 0.18)
  const isCeilingFixture =
    pt[1] >= proj.wall.height - 0.18 && proj.dist > proj.wall.thickness / 2 + 0.1
  return proj.dist <= wallSnapThreshold && !isCeilingFixture
}

function hasInterveningDoor(wall: RoutingWallSegment, tA: number, tB: number): boolean {
  if (!wall.doorSpans || wall.doorSpans.length === 0) return false
  const lo = Math.min(tA, tB)
  const hi = Math.max(tA, tB)
  for (const [dMin, dMax] of wall.doorSpans) {
    if (dMax > lo + 0.05 && dMin < hi - 0.05) return true
  }
  return false
}

/**
 * Build a strictly wall-following 3D Manhattan path between `start` and `end`:
 * - Same-wall, same-height outlets (no intervening door): horizontal stud chase inside/along that wall.
 * - Cross-wall runs & home runs: climb vertically along the source wall to `chaseY`, walk Dijkstra's
 *   shortest path strictly along real wall top plates around actual wall corners, and drop vertically
 *   along the target wall into the destination box.
 * - Wall-to-ceiling luminaires: follow wall top plates to the closest wall point, then take a single
 *   clean orthogonal 90° ceiling branch to the luminaire box.
 */
function buildWallGuidedManhattanPath(
  start: Vec3,
  end: Vec3,
  chaseY: number,
  walls: readonly RoutingWallSegment[],
  wallPlacement: 'in-wall' | 'surface' = 'in-wall',
): Vec3[] | null {
  if (walls.length === 0) return null
  const sProj = projectPointToWalls(start[0], start[2], walls)
  const eProj = projectPointToWalls(end[0], end[2], walls)
  if (!sProj || !eProj) return null

  const isStartWall = isEndpointWallMounted(start, sProj)
  const isEndWall = isEndpointWallMounted(end, eProj)
  const concealed = wallPlacement === 'in-wall'

  // In concealed ('in-wall') mode, wall-mounted boxes terminate inside the stud cavity on the wall centerline
  // (where the rough-in box rear/top knockouts sit between the two drywall faces).
  const startPt: Vec3 =
    concealed && isStartWall ? [round3(sProj.x), start[1], round3(sProj.z)] : start
  const endPt: Vec3 =
    concealed && isEndWall ? [round3(eProj.x), end[1], round3(eProj.z)] : end

  // Fast path A: Same wall, same mounting height band, no door in between -> horizontal stud-bored wall chase!
  if (
    isStartWall &&
    isEndWall &&
    sProj.wallIdx === eProj.wallIdx &&
    Math.abs(start[1] - end[1]) < 0.25 &&
    Math.max(start[1], end[1]) < chaseY - 0.35 &&
    !hasInterveningDoor(sProj.wall, sProj.t, eProj.t)
  ) {
    const midY = round3((start[1] + end[1]) / 2)
    if (concealed) {
      return simplifyOrthogonalPath([
        startPt,
        [round3(sProj.x), midY, round3(sProj.z)],
        [round3(eProj.x), midY, round3(eProj.z)],
        endPt,
      ])
    }
    const sameSide = sProj.signedDist * eProj.signedDist >= -1e-4
    if (sameSide) {
      return simplifyOrthogonalPath([
        start,
        [start[0], midY, start[2]],
        [end[0], midY, end[2]],
        end,
      ])
    }
    return simplifyOrthogonalPath([
      start,
      [sProj.x, midY, sProj.z],
      [eProj.x, midY, eProj.z],
      end,
    ])
  }

  // Fast path B: Same wall (e.g. climbing over a door header, or panel -> outlet on the same wall)
  if (isStartWall && isEndWall && sProj.wallIdx === eProj.wallIdx) {
    if (concealed) {
      return simplifyOrthogonalPath([
        startPt,
        [round3(sProj.x), chaseY, round3(sProj.z)],
        [round3(eProj.x), chaseY, round3(eProj.z)],
        endPt,
      ])
    }
    const sameSide = sProj.signedDist * eProj.signedDist >= -1e-4
    if (sameSide) {
      return simplifyOrthogonalPath([
        start,
        [start[0], chaseY, start[2]],
        [end[0], chaseY, end[2]],
        end,
      ])
    }
    return simplifyOrthogonalPath([
      start,
      [start[0], chaseY, start[2]],
      [sProj.x, chaseY, sProj.z],
      [eProj.x, chaseY, eProj.z],
      [end[0], chaseY, end[2]],
      end,
    ])
  }

  // Build 2D wall centerline graph with wall-to-wall intersections & T-junction snapping
  const wallGeom = walls.map((w) => {
    const vx = w.end[0] - w.start[0]
    const vz = w.end[1] - w.start[1]
    const len = Math.hypot(vx, vz)
    return { w, len, dx: len > 1e-4 ? vx / len : 1, dz: len > 1e-4 ? vz / len : 0 }
  })

  const splits: number[][] = wallGeom.map((g) => [0, g.len])
  splits[sProj.wallIdx]!.push(sProj.t)
  splits[eProj.wallIdx]!.push(eProj.t)

  const JUNCTION_SNAP = 0.25
  for (let i = 0; i < wallGeom.length; i++) {
    const a = wallGeom[i]!
    if (a.len < 1e-4) continue
    for (let j = i + 1; j < wallGeom.length; j++) {
      const b = wallGeom[j]!
      if (b.len < 1e-4) continue

      // 1) Segment-segment intersection (with small endpoint tolerance)
      const denom = a.dx * b.dz - a.dz * b.dx
      if (Math.abs(denom) > 1e-4) {
        const rx = b.w.start[0] - a.w.start[0]
        const rz = b.w.start[1] - a.w.start[1]
        const ta = (rx * b.dz - rz * b.dx) / denom
        const tb = (rx * a.dz - rz * a.dx) / denom
        if (
          ta >= -JUNCTION_SNAP &&
          ta <= a.len + JUNCTION_SNAP &&
          tb >= -JUNCTION_SNAP &&
          tb <= b.len + JUNCTION_SNAP
        ) {
          splits[i]!.push(Math.max(0, Math.min(a.len, ta)))
          splits[j]!.push(Math.max(0, Math.min(b.len, tb)))
        }
      }

      // 2) T-junction endpoint snapping (endpoints of A onto B and B onto A)
      for (const ep of [a.w.start, a.w.end]) {
        const tb = (ep[0] - b.w.start[0]) * b.dx + (ep[1] - b.w.start[1]) * b.dz
        if (tb >= 0 && tb <= b.len) {
          const px = b.w.start[0] + b.dx * tb
          const pz = b.w.start[1] + b.dz * tb
          if (Math.hypot(ep[0] - px, ep[1] - pz) <= JUNCTION_SNAP) {
            splits[j]!.push(tb)
          }
        }
      }
      for (const ep of [b.w.start, b.w.end]) {
        const ta = (ep[0] - a.w.start[0]) * a.dx + (ep[1] - a.w.start[1]) * a.dz
        if (ta >= 0 && ta <= a.len) {
          const px = a.w.start[0] + a.dx * ta
          const pz = a.w.start[1] + a.dz * ta
          if (Math.hypot(ep[0] - px, ep[1] - pz) <= JUNCTION_SNAP) {
            splits[i]!.push(ta)
          }
        }
      }
    }
  }

  // Merge nearby wall junction vertices (<= 0.20 m) into shared graph nodes
  const nodes2D: Array<{ x: number; z: number }> = []
  const findOrAddVertex = (x: number, z: number, eps: number): number => {
    for (let idx = 0; idx < nodes2D.length; idx++) {
      const v = nodes2D[idx]!
      if (Math.hypot(v.x - x, v.z - z) <= eps) return idx
    }
    nodes2D.push({ x, z })
    return nodes2D.length - 1
  }

  // Register wall endpoints & T-junctions first so corners cluster accurately
  for (let i = 0; i < wallGeom.length; i++) {
    const g = wallGeom[i]!
    for (const t of splits[i]!) {
      if (
        (i === sProj.wallIdx && Math.abs(t - sProj.t) < 1e-4) ||
        (i === eProj.wallIdx && Math.abs(t - eProj.t) < 1e-4)
      ) {
        continue
      }
      findOrAddVertex(g.w.start[0] + g.dx * t, g.w.start[1] + g.dz * t, 0.2)
    }
  }

  // Register exact start & end wall projections (only snap if practically on top of a corner)
  const startV = findOrAddVertex(sProj.x, sProj.z, 0.04)
  const endV = findOrAddVertex(eProj.x, eProj.z, 0.04)

  type GraphEdge = { to: number; weight: number; isWall: boolean }
  const adj: GraphEdge[][] = Array.from({ length: nodes2D.length }, () => [])
  const addEdge = (u: number, v: number, weight: number, isWall: boolean) => {
    if (u === v) return
    adj[u]!.push({ to: v, weight, isWall })
    adj[v]!.push({ to: u, weight, isWall })
  }

  for (let i = 0; i < wallGeom.length; i++) {
    const g = wallGeom[i]!
    const ts = [...splits[i]!].sort((a, b) => a - b)
    let prevV = -1
    for (const t of ts) {
      const px = g.w.start[0] + g.dx * t
      const pz = g.w.start[1] + g.dz * t
      let vIdx: number
      if (i === sProj.wallIdx && Math.abs(t - sProj.t) < 1e-4) {
        vIdx = startV
      } else if (i === eProj.wallIdx && Math.abs(t - eProj.t) < 1e-4) {
        vIdx = endV
      } else {
        vIdx = findOrAddVertex(px, pz, 0.2)
      }
      if (prevV !== -1 && prevV !== vIdx) {
        const uNode = nodes2D[prevV]!
        const vNode = nodes2D[vIdx]!
        addEdge(prevV, vIdx, Math.hypot(vNode.x - uNode.x, vNode.z - uNode.z), true)
      }
      prevV = vIdx
    }
  }

  // Ensure connectivity across disconnected wall islands using orthogonal Manhattan ceiling bridges
  const nVerts = nodes2D.length
  const getComponents = (): number[] => {
    const comp = new Array<number>(nVerts).fill(-1)
    let cid = 0
    for (let i = 0; i < nVerts; i++) {
      if (comp[i] !== -1) continue
      const q = [i]
      comp[i] = cid
      while (q.length > 0) {
        const cur = q.shift()!
        for (const e of adj[cur]!) {
          if (comp[e.to] === -1) {
            comp[e.to] = cid
            q.push(e.to)
          }
        }
      }
      cid += 1
    }
    return comp
  }

  let comp = getComponents()
  let guard = 0
  while (comp[startV] !== comp[endV] && guard < 32) {
    guard += 1
    let bestU = -1
    let bestV = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let u = 0; u < nVerts; u++) {
      for (let v = u + 1; v < nVerts; v++) {
        if (comp[u] === comp[v]) continue
        const a = nodes2D[u]!
        const b = nodes2D[v]!
        const md = Math.abs(b.x - a.x) + Math.abs(b.z - a.z)
        if (md < bestD) {
          bestD = md
          bestU = u
          bestV = v
        }
      }
    }
    if (bestU === -1 || bestV === -1) break
    // Penalize ceiling bridges slightly so real wall paths are always preferred when connected
    addEdge(bestU, bestV, bestD * 1.6 + 0.5, false)
    comp = getComponents()
  }

  // Dijkstra shortest wall-following path from startV to endV
  const distArr = new Array<number>(nVerts).fill(Number.POSITIVE_INFINITY)
  const prevArr = new Array<number>(nVerts).fill(-1)
  const prevIsWall = new Array<boolean>(nVerts).fill(true)
  const visited = new Array<boolean>(nVerts).fill(false)
  distArr[startV] = 0

  for (let step = 0; step < nVerts; step++) {
    let u = -1
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < nVerts; i++) {
      if (!visited[i] && distArr[i]! < best) {
        best = distArr[i]!
        u = i
      }
    }
    if (u === -1 || u === endV) break
    visited[u] = true
    for (const e of adj[u]!) {
      if (visited[e.to]) continue
      const nd = distArr[u]! + e.weight
      if (nd < distArr[e.to]!) {
        distArr[e.to] = nd
        prevArr[e.to] = u
        prevIsWall[e.to] = e.isWall
      }
    }
  }

  if (!Number.isFinite(distArr[endV]!)) return null

  const revNodes: number[] = []
  const revEdgeWall: boolean[] = []
  let cur = endV
  while (cur !== -1) {
    revNodes.push(cur)
    if (prevArr[cur] !== -1) revEdgeWall.push(prevIsWall[cur]!)
    cur = prevArr[cur]!
  }
  revNodes.reverse()
  revEdgeWall.reverse()

  // Compact consecutive collinear wall edges so each straight wall run is 1 clean segment
  const pts2D: Array<[number, number]> = []
  const edgeWall: boolean[] = []
  for (let i = 0; i < revNodes.length; i++) {
    const v = nodes2D[revNodes[i]!]!
    const pt: [number, number] = [v.x, v.z]
    if (pts2D.length >= 2) {
      const lastWall = edgeWall[edgeWall.length - 1]
      const curWall = revEdgeWall[i - 1]
      if (lastWall && curWall) {
        const a = pts2D[pts2D.length - 2]!
        const b = pts2D[pts2D.length - 1]!
        const v1x = b[0] - a[0]
        const v1z = b[1] - a[1]
        const v2x = pt[0] - b[0]
        const v2z = pt[1] - b[1]
        const l1 = Math.hypot(v1x, v1z)
        const l2 = Math.hypot(v2x, v2z)
        if (l1 > 1e-4 && l2 > 1e-4 && (v1x * v2x + v1z * v2z) / (l1 * l2) > 0.999) {
          pts2D[pts2D.length - 1] = pt
          continue
        }
      }
    }
    if (pts2D.length > 0) edgeWall.push(revEdgeWall[i - 1]!)
    pts2D.push(pt)
  }

  // In surface-mounted mode, corner-align flush wall offsets at start & end to eliminate 6cm micro-jogs.
  // In concealed ('in-wall') mode, keep every vertex dead-center on the 2D wall centerline between drywall faces!
  if (!concealed && isStartWall && pts2D.length >= 3 && edgeWall[0] && edgeWall[1]) {
    const offX = startPt[0] - pts2D[0]![0]
    const offZ = startPt[2] - pts2D[0]![1]
    if (Math.hypot(offX, offZ) <= 0.16) {
      const u0x = pts2D[1]![0] - pts2D[0]![0]
      const u0z = pts2D[1]![1] - pts2D[0]![1]
      const u1x = pts2D[2]![0] - pts2D[1]![0]
      const u1z = pts2D[2]![1] - pts2D[1]![1]
      const l0 = Math.hypot(u0x, u0z)
      const l1 = Math.hypot(u1x, u1z)
      if (l0 > 0.05 && l1 > 0.05 && Math.abs((u0x * u1x + u0z * u1z) / (l0 * l1)) < 0.2) {
        pts2D[0] = [startPt[0], startPt[2]]
        pts2D[1] = [pts2D[1]![0] + offX, pts2D[1]![1] + offZ]
      }
    }
  }
  if (!concealed && isEndWall && pts2D.length >= 3) {
    const last = pts2D.length - 1
    if (edgeWall[last - 1] && edgeWall[last - 2]) {
      const offX = endPt[0] - pts2D[last]![0]
      const offZ = endPt[2] - pts2D[last]![1]
      if (Math.hypot(offX, offZ) <= 0.16) {
        const uPx = pts2D[last - 1]![0] - pts2D[last - 2]![0]
        const uPz = pts2D[last - 1]![1] - pts2D[last - 2]![1]
        const uLx = pts2D[last]![0] - pts2D[last - 1]![0]
        const uLz = pts2D[last]![1] - pts2D[last - 1]![1]
        const lP = Math.hypot(uPx, uPz)
        const lL = Math.hypot(uLx, uLz)
        if (lP > 0.05 && lL > 0.05 && Math.abs((uPx * uLx + uPz * uLz) / (lP * lL)) < 0.2) {
          pts2D[last] = [endPt[0], endPt[2]]
          pts2D[last - 1] = [pts2D[last - 1]![0] + offX, pts2D[last - 1]![1] + offZ]
        }
      }
    }
  }

  // Assemble clean 3D Manhattan polyline inside wall top plates (or along wall surface) with orthogonal ceiling branches
  const pts3D: Vec3[] = [startPt, [startPt[0], chaseY, startPt[2]]]
  const first2D = pts2D[0]!
  if (!isStartWall) {
    if (Math.abs(startPt[0] - first2D[0]) > 0.01 && Math.abs(startPt[2] - first2D[1]) > 0.01) {
      pts3D.push([first2D[0], chaseY, startPt[2]])
    }
    pts3D.push([first2D[0], chaseY, first2D[1]])
  } else if (Math.hypot(startPt[0] - first2D[0], startPt[2] - first2D[1]) > 0.01) {
    pts3D.push([first2D[0], chaseY, first2D[1]])
  }

  for (let i = 0; i < pts2D.length - 1; i++) {
    const a = pts2D[i]!
    const b = pts2D[i + 1]!
    if (!edgeWall[i] && Math.abs(b[0] - a[0]) > 0.01 && Math.abs(b[1] - a[1]) > 0.01) {
      pts3D.push([b[0], chaseY, a[1]])
    }
    pts3D.push([b[0], chaseY, b[1]])
  }

  const last2D = pts2D[pts2D.length - 1]!
  if (!isEndWall) {
    if (Math.abs(endPt[0] - last2D[0]) > 0.01 && Math.abs(endPt[2] - last2D[1]) > 0.01) {
      pts3D.push([last2D[0], chaseY, endPt[2]])
    }
    pts3D.push([endPt[0], chaseY, endPt[2]])
  } else if (Math.hypot(endPt[0] - last2D[0], endPt[2] - last2D[1]) > 0.01) {
    pts3D.push([endPt[0], chaseY, endPt[2]])
  }
  pts3D.push(endPt)

  return simplifyOrthogonalPath(pts3D)
}

/**
 * Build a 3-phase hybrid Manhattan-in-wall <-> Euclidean-in-cavity cable path:
 * 1. Vertical stud-bay transition inside the source wall (up through top plate to attic, or down through sole plate to crawl space)
 * 2. Straight point-to-point Euclidean run across the concealed accessible cavity (`atticY` or `crawlSpaceY`)
 * 3. Vertical stud-bay transition inside the destination wall into the target rough-in box.
 *
 * Returns `null` when both endpoints share the same wall with no intervening door (horizontal stud bore is strictly cleaner).
 */
function buildCavityEuclideanPath(
  start: Vec3,
  end: Vec3,
  cavityY: number,
  walls: readonly RoutingWallSegment[],
  wallPlacement: 'in-wall' | 'surface' = 'in-wall',
): Vec3[] | null {
  if (walls.length === 0) return null
  const sProj = projectPointToWalls(start[0], start[2], walls)
  const eProj = projectPointToWalls(end[0], end[2], walls)
  if (!sProj || !eProj) return null

  const isStartWall = isEndpointWallMounted(start, sProj)
  const isEndWall = isEndpointWallMounted(end, eProj)
  const concealed = wallPlacement === 'in-wall'

  // Same wall, same height band, no door between -> keep horizontal in-wall stud bore (never bore plates needlessly)
  if (
    isStartWall &&
    isEndWall &&
    sProj.wallIdx === eProj.wallIdx &&
    Math.abs(start[1] - end[1]) < 0.25 &&
    !hasInterveningDoor(sProj.wall, sProj.t, eProj.t)
  ) {
    return null
  }

  const startPt: Vec3 =
    concealed && isStartWall ? [round3(sProj.x), start[1], round3(sProj.z)] : start
  const endPt: Vec3 =
    concealed && isEndWall ? [round3(eProj.x), end[1], round3(eProj.z)] : end

  return simplifyOrthogonalPath([
    startPt,
    [round3(startPt[0]), round3(cavityY), round3(startPt[2])],
    [round3(endPt[0]), round3(cavityY), round3(endPt[2])],
    endPt,
  ])
}

/**
 * Given a single axis-aligned or horizontal-diagonal segment [a, b] that hits obstacle `obs`,
 * generate clean saddle/jog detours (over, under, left, right) around `obs`.
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

  // Horizontal diagonal segment (e.g. attic or crawl-space Euclidean cable pull):
  // detour cleanly over/under in Y along the same XZ line, or step around obstacle corners in XZ.
  if (dy < 0.02 && dx > 0.05 && dz > 0.05) {
    const yOver = round3(expanded.max[1] + stepPad)
    const yUnder = round3(expanded.min[1] - stepPad)
    if (yOver <= maxY) {
      detours.push([a, [a[0], yOver, a[2]], [b[0], yOver, b[2]], b])
    }
    if (yUnder >= minY) {
      detours.push([a, [a[0], yUnder, a[2]], [b[0], yUnder, b[2]], b])
    }
    const corners: Array<[number, number]> = [
      [round3(expanded.min[0] - stepPad), round3(expanded.min[2] - stepPad)],
      [round3(expanded.max[0] + stepPad), round3(expanded.min[2] - stepPad)],
      [round3(expanded.min[0] - stepPad), round3(expanded.max[2] + stepPad)],
      [round3(expanded.max[0] + stepPad), round3(expanded.max[2] + stepPad)],
    ]
    for (const [cx, cz] of corners) {
      detours.push([a, [cx, a[1], cz], b])
    }
    return detours.map((d) => simplifyOrthogonalPath(d))
  }

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
  const walls = options.walls && options.walls.length > 0 ? options.walls : null
  const wallPlacement = options.wallPlacement ?? 'in-wall'
  const fullHeightWalls = walls ? walls.filter((w) => w.height >= 1.8) : []
  const wallCeilingH =
    fullHeightWalls.length > 0
      ? Math.min(...fullHeightWalls.map((w) => w.height))
      : walls && walls.length > 0
        ? Math.max(...walls.map((w) => w.height))
        : 0
  const rawPreferredChaseY = options.preferredChaseY ?? 2.55
  const preferredChaseY =
    walls && wallCeilingH > 0
      ? round3(
          Math.min(
            rawPreferredChaseY,
            wallPlacement === 'in-wall' ? wallCeilingH - 0.06 : wallCeilingH + 0.012,
          ),
        )
      : rawPreferredChaseY
  const clearanceM = options.clearanceM ?? DEFAULT_CLEARANCE_M
  const conduitRadiusM = options.conduitRadiusM ?? 0.015
  const minY = options.minY ?? 0.15
  const maxY = options.maxY ?? 3.2
  const inWallMaxY =
    walls && wallCeilingH > 0 && wallPlacement === 'in-wall'
      ? round3(Math.min(maxY, wallCeilingH - 0.04))
      : maxY
  const maxBendDegrees = options.maxBendDegrees ?? 360
  const racewayType: RacewayType = options.racewayType ?? 'nm-b'
  const wireGauge: WireGauge = options.wireGauge ?? '12'
  const routingStrategy = options.routingStrategy ?? 'auto'
  const isFlexibleCable = racewayType === 'nm-b' || racewayType === 'mc'

  // Baseline route (wall-guided Manhattan when building walls are supplied, else open Manhattan)
  const fallbackXZ = buildManhattanCandidate(start, end, preferredChaseY, 'xz')
  const fallbackZX = buildManhattanCandidate(start, end, preferredChaseY, 'zx')
  const fallbackManhattan =
    polylineLengthM(fallbackXZ) <= polylineLengthM(fallbackZX) ? fallbackXZ : fallbackZX
  const baseline =
    (walls ? buildWallGuidedManhattanPath(start, end, preferredChaseY, walls, wallPlacement) : null) ??
    fallbackManhattan
  const directLengthM = polylineLengthM(baseline)
  const baselineClashes = detectRunTradeClashes(baseline, obstacles, clearanceM, conduitRadiusM)

  // Candidate chase elevations stay in the overhead ceiling/top-plate zone.
  // In concealed ('in-wall') mode, NEVER climb above the wall top plate into empty air; duck inside the stud cavity instead.
  const rawCandidateElevations =
    walls && wallCeilingH > 0 && wallPlacement === 'in-wall'
      ? [
          preferredChaseY,
          Math.min(inWallMaxY, round3(preferredChaseY + 0.02)),
          Math.max(minY, round3(preferredChaseY - 0.16)),
          Math.max(minY, round3(preferredChaseY - 0.34)),
        ]
      : [
          preferredChaseY,
          Math.min(maxY, preferredChaseY + 0.25),
          Math.min(maxY, preferredChaseY + 0.45),
          Math.max(Math.min(preferredChaseY, 2.2), preferredChaseY - 0.25),
        ]
  const candidateElevations = Array.from(new Set(rawCandidateElevations))

  const scorePath = (p: Vec3[]): { score: number; clashes: TradeClashFinding[] } => {
    const clashes = detectRunTradeClashes(p, obstacles, clearanceM, conduitRadiusM)
    const len = polylineLengthM(p)
    const { totalBendDegrees } = countPathBendDegrees(p)
    // Strongly prioritize 0 clashes, staying near preferred chase elevation, fewer bends, then shorter length
    const bendPenalty = totalBendDegrees > maxBendDegrees ? 50 : totalBendDegrees * 0.004
    return { score: clashes.length * 1000 + len + bendPenalty, clashes }
  }

  const resolveDetours = (
    initialPath: Vec3[],
    detourMinY: number,
    detourMaxY: number,
    lockTerminalWallRisers = false,
  ): { path: Vec3[]; score: number; clashes: TradeClashFinding[] } => {
    let cur = initialPath
    let curEval = scorePath(cur)
    const maxIterations = 8
    for (let iter = 0; iter < maxIterations; iter++) {
      if (curEval.clashes.length === 0) break
      const firstClash = curEval.clashes[0]!
      const obs = obstacles.find((o) => o.nodeId === firstClash.obstacleNodeId)
      if (!obs) break

      const segIdx = firstClash.segmentIndex
      // R6-BUG-04: On attic/crawlspace cavity candidates, never laterally kick the first or last
      // vertical wall-cavity riser out of its stud bay into open room air.
      if (lockTerminalWallRisers && (segIdx === 0 || segIdx === cur.length - 2)) {
        break
      }
      const segA = cur[segIdx]!
      const segB = cur[segIdx + 1]!
      const margin = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
      const expanded = expandAabb(obs.box, margin)
      const detours = buildSegmentDetours(segA, segB, expanded, detourMinY, detourMaxY)

      let improved = false
      let localBest = cur
      let localBestEval = curEval
      for (const detour of detours) {
        const spliced = simplifyOrthogonalPath([
          ...cur.slice(0, segIdx),
          ...detour,
          ...cur.slice(segIdx + 2),
        ])
        const ev = scorePath(spliced)
        if (ev.score < localBestEval.score) {
          localBest = spliced
          localBestEval = ev
          improved = true
        }
      }
      if (!improved) break
      cur = localBest
      curEval = localBestEval
    }
    return { path: cur, score: curEval.score, clashes: curEval.clashes }
  }

  let bestPath: Vec3[] = baseline
  let bestScore = Number.POSITIVE_INFINITY
  let bestMode: RoutingMode = walls ? 'wall-manhattan' : 'open-manhattan'
  let bestNecNotes: string[] = []

  // Step 1: Evaluate Wall-Guided (or Open) Manhattan candidates across chase elevations
  if (walls) {
    for (const y of candidateElevations) {
      const candidate =
        buildWallGuidedManhattanPath(start, end, y, walls, wallPlacement) ??
        buildManhattanCandidate(start, end, y, 'xz')
      const { score, clashes } = scorePath(candidate)
      if (score < bestScore) {
        bestScore = score
        bestPath = candidate
        bestMode = 'wall-manhattan'
      }
      if (clashes.length === 0 && y === preferredChaseY) break
    }
  } else {
    for (const y of candidateElevations) {
      for (const order of ['xz', 'zx'] as const) {
        const candidate = buildManhattanCandidate(start, end, y, order)
        const { score, clashes } = scorePath(candidate)
        if (score < bestScore) {
          bestScore = score
          bestPath = candidate
          bestMode = 'open-manhattan'
        }
        if (clashes.length === 0 && y === preferredChaseY) break
      }
    }
  }

  // Step 2: Splice orthogonal saddle/jog detours on the Manhattan candidate if clashes remain
  const resolvedManhattan = resolveDetours(bestPath, minY, inWallMaxY)
  bestPath = resolvedManhattan.path
  bestScore = resolvedManhattan.score

  // Step 3: Hybrid Manhattan-in-Wall <-> Euclidean-in-Attic / Crawlspace evaluation
  // Only activated when `routingStrategy === 'auto'`, flexible cable (`NM-B` / `MC`, preserving orthogonal
  // `EMT`/`RMC`/`PVC` per NEC 110.12 / 358.30), and an accessible attic or dry crawl space is present!
  const cavities = options.cavities
  const CAVITY_MIN_SAVINGS_M = 0.35
  if (walls && cavities && routingStrategy === 'auto' && isFlexibleCable) {
    const manhattanClashes = resolvedManhattan.clashes.length

    // 3a. Wall-Vertical -> Attic Euclidean -> Wall-Vertical (NEC 334.23 / 320.23)
    if (cavities.hasAttic) {
      const atticY = cavities.atticY ?? round3((wallCeilingH > 0 ? wallCeilingH : 2.5) + 0.12)
      const rawAttic = buildCavityEuclideanPath(start, end, atticY, walls, wallPlacement)
      if (rawAttic) {
        const atticDetour = resolveDetours(rawAttic, Math.max(minY, atticY - 0.1), atticY + 0.55, true)
        const resolvesClash = atticDetour.clashes.length < manhattanClashes
        const strictlyShorter =
          atticDetour.clashes.length <= manhattanClashes &&
          atticDetour.score + CAVITY_MIN_SAVINGS_M < bestScore
        if (resolvesClash || strictlyShorter) {
          bestPath = atticDetour.path
          bestScore = atticDetour.score
          bestMode = 'attic-euclidean'
          bestNecNotes = [
            'NEC 334.23 / 320.23: Vertical wall-cavity riser through bored top plate into attic Euclidean run; protect cable with guard strips within 6 ft of attic access.',
          ]
        }
      }
    }

    // 3b. Wall-Vertical -> Crawl Space / Unfinished Basement Euclidean -> Wall-Vertical (NEC 334.15(C) / 334.12(B)(4))
    const crawlAllowedForCable = !(cavities.crawlSpaceWet === true && racewayType === 'nm-b')
    const endpointsNearFloorOrWall = start[1] < 1.9 && end[1] < 1.9
    if (cavities.hasCrawlSpace && crawlAllowedForCable && endpointsNearFloorOrWall) {
      const crawlY = cavities.crawlSpaceY ?? -0.18
      const rawCrawl = buildCavityEuclideanPath(start, end, crawlY, walls, wallPlacement)
      if (rawCrawl) {
        const crawlDetour = resolveDetours(rawCrawl, crawlY - 0.45, Math.min(-0.04, crawlY + 0.12), true)
        const resolvesClash = crawlDetour.clashes.length < manhattanClashes
        const strictlyShorter =
          crawlDetour.clashes.length <= manhattanClashes &&
          crawlDetour.score + CAVITY_MIN_SAVINGS_M < bestScore
        if (resolvesClash || strictlyShorter) {
          bestPath = crawlDetour.path
          bestScore = crawlDetour.score
          bestMode = 'crawlspace-euclidean'
          const smallGaugeForJoists = ['14', '12', '10', '8'].includes(wireGauge)
          bestNecNotes = smallGaugeForJoists
            ? [
                `NEC 334.15(C) / 300.4(A)(1): Vertical stud drop through sole plate into crawl space; #${wireGauge} ${racewayType.toUpperCase()} must run through bored floor joists (>= 1.25" from edge) or on running boards (not stapled to lower joist edges).`,
              ]
            : [
                `NEC 334.15(C): #${wireGauge} ${racewayType.toUpperCase()} permitted through bored floor joists or fastened across lower edges of joists in dry crawl space.`,
              ]
        }
      }
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
    routingMode: bestMode,
    necNotes: bestNecNotes,
  }
}
