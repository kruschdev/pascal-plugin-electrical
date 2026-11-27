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
  readonly obstacleId: string
  readonly obstacleNodeId: string
  readonly obstacleNodeType: string
  readonly trade: TradePriority
  readonly label: string
  readonly clearanceShortfallM: number
  readonly point: Vec3
}

export type RoutingWindowSpan = {
  readonly startDist: number
  readonly endDist: number
  readonly sillY: number
  readonly headY: number
}

export type RoutingDoorDetail = {
  readonly startDist: number
  readonly endDist: number
  readonly headY: number
}

export type WallOpeningPrism = {
  readonly id: string
  readonly wallId: string
  readonly wallIdx: number
  readonly kind: 'door' | 'window'
  readonly originX: number
  readonly originZ: number
  readonly dx: number
  readonly dz: number
  readonly nx: number
  readonly nz: number
  readonly tMin: number
  readonly tMax: number
  readonly halfPerp: number
  readonly yMin: number
  readonly yMax: number
  readonly wallLen: number
  readonly aabb: Aabb3
}

export type RoutingWallSegment = {
  readonly id: string
  readonly start: readonly [number, number]
  readonly end: readonly [number, number]
  readonly thickness: number
  readonly height: number
  /** Door opening intervals `[tMin, tMax]` (meters from `start`) so wall runs avoid doors. */
  readonly doorSpans?: readonly (readonly [number, number])[]
  /** Door opening intervals with explicit head elevations. */
  readonly doorDetails?: readonly RoutingDoorDetail[]
  /** Window opening intervals with sill/head elevations so wall chases never cut across glass. */
  readonly windowSpans?: readonly RoutingWindowSpan[]
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
  /** Roof pitch rise over 12 (from structural:assembly if present, else 6) for sloped attic clamping. */
  readonly roofPitchRise?: number
  /** Resolved architectural ceiling/wall height (m) of the active level. */
  readonly levelHeight?: number
  /** Explicit `roof-segment` planes applicable to this level (same-level or unwalled upper roof level). */
  readonly explicitRoofSegs?: readonly ExplicitRoofSegment[]
}

export type ExplicitRoofSegment = {
  readonly cx: number
  readonly cz: number
  readonly cosR: number
  readonly sinR: number
  readonly halfW: number
  readonly halfD: number
  readonly overhangM: number
  readonly eaveY: number
  readonly slopeTan: number
  readonly roofType: string
}

export type PitchedRoofEnvelope = {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly wallH: number
  readonly pitchRiseOver12: number
  readonly ridgeAlongX: boolean
  readonly halfSpan: number
  readonly ridgeCenter: number
  readonly explicitSegs?: readonly ExplicitRoofSegment[]
}

export function levelElevationOrder(lvl: SceneNodeLike | undefined): number {
  if (!lvl) return 0
  if (typeof lvl.baseElevation === 'number' && Number.isFinite(lvl.baseElevation)) {
    return lvl.baseElevation
  }
  if (typeof lvl.elevation === 'number' && Number.isFinite(lvl.elevation)) {
    return lvl.elevation
  }
  if (typeof lvl.level === 'number' && Number.isFinite(lvl.level)) {
    return lvl.level
  }
  if (typeof lvl.index === 'number' && Number.isFinite(lvl.index)) {
    return lvl.index
  }
  return 0
}

/**
 * Determine whether `levelId` is the building's ground / lowest walled story:
 * - Single-story or unlevelled scenes -> true
 * - Explicit `level <= 0` / `baseElevation <= 0` -> true
 * - Otherwise true only when `levelId` is at or below the minimum elevation among walled sibling levels in the same building.
 */
export function isGroundOrLowestWalledLevel(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null | undefined,
): boolean {
  if (!levelId) return true
  const curLvl = nodes[levelId]
  if (!curLvl || curLvl.type !== 'level') return true
  const curOrder = levelElevationOrder(curLvl)
  const curBldg = typeof curLvl.parentId === 'string' ? curLvl.parentId : null
  const all = Object.values(nodes)
  const wallLevelIds = new Set<string>()
  for (const n of all) {
    if (n.type === 'wall' && n.visible !== false) {
      const lid = resolveNodeLevelId(nodes, n)
      if (lid) wallLevelIds.add(lid)
    }
  }
  const walledSiblings = all.filter((n) => {
    if (n.type !== 'level') return false
    if (!wallLevelIds.has(n.id)) return false
    const nBldg = typeof n.parentId === 'string' ? n.parentId : null
    if (curBldg && nBldg && curBldg !== nBldg) return false
    return true
  })
  if (walledSiblings.length <= 1) return true
  if (curOrder <= 0) return true
  const minWalledOrder = Math.min(...walledSiblings.map((l) => levelElevationOrder(l)))
  return curOrder <= minWalledOrder + 1e-4
}

/**
 * Extract explicit `roof-segment` planes applicable to `levelId` (same-level AND, when `levelId`
 * has no walled level above it in the same building, any unwalled roof level at/above `curElev`
 * in the same building), transforming ancestor `roof` positions & rotations identically to
 * Structural `audit.ts` and HVAC `buildAtticRoofEnvelope`.
 */
export function extractExplicitRoofSegments(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null | undefined,
  wallH: number,
): ExplicitRoofSegment[] {
  const all = Object.values(nodes)
  const levels = all.filter((n) => n.type === 'level')
  const curLvl = (levelId ? nodes[levelId] : undefined) ?? levels[0]
  const curLvlId = levelId ?? curLvl?.id ?? null
  const curBuildingId = typeof curLvl?.parentId === 'string' ? curLvl.parentId : null
  const curElev = levelElevationOrder(curLvl)

  const hasWalledLevelAbove = Boolean(
    curLvl &&
      levels.some((o) => {
        if (o.id === curLvl.id) return false
        const oBldg = typeof o.parentId === 'string' ? o.parentId : null
        if (curBuildingId && oBldg && curBuildingId !== oBldg) return false
        const oElev = levelElevationOrder(o)
        return (
          oElev > curElev &&
          all.some((w) => w.type === 'wall' && w.visible !== false && belongsToLevel(nodes, w, o.id))
        )
      }),
  )

  const unwalledUpperLevelIds = new Set<string>()
  if (!hasWalledLevelAbove && curLvl) {
    for (const o of levels) {
      if (o.id === curLvl.id) continue
      const oBldg = typeof o.parentId === 'string' ? o.parentId : null
      if (curBuildingId && oBldg && curBuildingId !== oBldg) continue
      const oElev = levelElevationOrder(o)
      const oHasWalls = all.some(
        (w) => w.type === 'wall' && w.visible !== false && belongsToLevel(nodes, w, o.id),
      )
      if (!oHasWalls && oElev >= curElev) {
        unwalledUpperLevelIds.add(o.id)
      }
    }
  }

  const explicitSegs: ExplicitRoofSegment[] = []
  for (const n of all) {
    if (n.type !== 'roof-segment' || n.visible === false) continue
    let inScope = belongsToLevel(nodes, n, curLvlId)
    if (!inScope && unwalledUpperLevelIds.size > 0) {
      for (const uid of unwalledUpperLevelIds) {
        if (belongsToLevel(nodes, n, uid)) {
          inScope = true
          break
        }
      }
    }
    if (!inScope) continue

    let wx = Array.isArray(n.position) ? Number(n.position[0] ?? 0) : 0
    let wy = Array.isArray(n.position) ? Number(n.position[1] ?? 0) : 0
    let wz = Array.isArray(n.position) ? Number(n.position[2] ?? 0) : 0
    let rot = typeof n.rotation === 'number' && Number.isFinite(n.rotation) ? n.rotation : 0
    let curParentId = typeof n.parentId === 'string' ? n.parentId : null
    const seenParents = new Set<string>()
    while (curParentId && !seenParents.has(curParentId)) {
      seenParents.add(curParentId)
      const parent = nodes[curParentId]
      if (!parent) break
      if (parent.type === 'roof') {
        const pRot = typeof parent.rotation === 'number' && Number.isFinite(parent.rotation) ? parent.rotation : 0
        const pc = Math.cos(pRot)
        const ps = Math.sin(pRot)
        const px = Array.isArray(parent.position) ? Number(parent.position[0] ?? 0) : 0
        const py = Array.isArray(parent.position) ? Number(parent.position[1] ?? 0) : 0
        const pz = Array.isArray(parent.position) ? Number(parent.position[2] ?? 0) : 0
        const rx = wx * pc + wz * ps
        const rz = -wx * ps + wz * pc
        wx = px + rx
        wy = py + wy
        wz = pz + rz
        rot += pRot
      } else if (parent.type === 'level') {
        break
      }
      curParentId = typeof parent.parentId === 'string' ? parent.parentId : null
    }

    const width = typeof n.width === 'number' && n.width > 0.2 ? n.width : 6
    const depth = typeof n.depth === 'number' && n.depth > 0.2 ? n.depth : 6
    const roofType = typeof n.roofType === 'string' ? n.roofType : 'gable'
    const rawPitch = typeof n.pitch === 'number' && Number.isFinite(n.pitch) ? n.pitch : 26.57
    const pitchRad =
      rawPitch <= 0
        ? 0
        : rawPitch > 1.4
          ? (Math.min(65, rawPitch) * Math.PI) / 180
          : Math.min((65 * Math.PI) / 180, rawPitch)
    const overhangM = typeof n.overhang === 'number' && n.overhang >= 0 ? n.overhang : 0.35
    const segWallH =
      typeof n.wallHeight === 'number' && Number.isFinite(n.wallHeight) && n.wallHeight >= 0
        ? n.wallHeight
        : 0
    const eaveY = wy > 0.05 ? wy + segWallH : wallH + segWallH
    explicitSegs.push({
      cx: wx,
      cz: wz,
      cosR: Math.cos(rot),
      sinR: Math.sin(rot),
      halfW: width / 2,
      halfD: depth / 2,
      overhangM,
      eaveY,
      slopeTan: roofType === 'flat' || pitchRad <= 0.008 ? 0 : Math.tan(pitchRad),
      roofType,
    })
  }
  return explicitSegs
}

/**
 * Compute approximate gable roof plane parameters from the level's wall envelope,
 * matching structural gable framing (ridge along longer axis, slope = pitch/12 over shorter half-span)
 * and optionally incorporating explicit `roof-segment` planes from the scene graph.
 */
export function computeRoofEnvelopeFromWalls(
  walls: readonly RoutingWallSegment[],
  wallH: number,
  pitchRiseOver12 = 6,
  nodes?: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
  explicitSegsOverride?: readonly ExplicitRoofSegment[],
): PitchedRoofEnvelope | null {
  if (walls.length === 0 || !(wallH > 0)) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const w of walls) {
    for (const pt of [w.start, w.end]) {
      if (pt[0] < minX) minX = pt[0]
      if (pt[0] > maxX) maxX = pt[0]
      if (pt[1] < minZ) minZ = pt[1]
      if (pt[1] > maxZ) maxZ = pt[1]
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  if (spanX < 0.2 || spanZ < 0.2) return null
  const ridgeAlongX = spanX >= spanZ
  const halfSpan = (ridgeAlongX ? spanZ : spanX) / 2
  const ridgeCenter = ridgeAlongX ? (minZ + maxZ) / 2 : (minX + maxX) / 2
  const pitch = Number.isFinite(pitchRiseOver12) && pitchRiseOver12 > 0 ? pitchRiseOver12 : 6
  const explicitSegs =
    explicitSegsOverride && explicitSegsOverride.length > 0
      ? explicitSegsOverride
      : nodes
        ? extractExplicitRoofSegments(nodes, levelId, wallH)
        : undefined
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    wallH,
    pitchRiseOver12: pitch,
    ridgeAlongX,
    halfSpan,
    ridgeCenter,
    ...(explicitSegs && explicitSegs.length > 0 ? { explicitSegs } : {}),
  }
}

/** Compute sloped roof plane elevation (m) at world/level-local (x, z), tightening to explicit `roof-segment` planes when covered. */
export function roofYAt(x: number, z: number, env: PitchedRoofEnvelope): number {
  const distFromRidge = Math.abs((env.ridgeAlongX ? z : x) - env.ridgeCenter)
  const riseM = Math.max(0, env.halfSpan - distFromRidge) * (env.pitchRiseOver12 / 12)
  const fallbackGableY = env.wallH + riseM
  if (env.explicitSegs && env.explicitSegs.length > 0) {
    let bestSegY: number | null = null
    for (const seg of env.explicitSegs) {
      const dx = x - seg.cx
      const dz = z - seg.cz
      const lx = dx * seg.cosR - dz * seg.sinR
      const lz = dx * seg.sinR + dz * seg.cosR
      if (
        Math.abs(lx) <= seg.halfW + 0.15 &&
        Math.abs(lz) <= seg.halfD + seg.overhangM + 0.15
      ) {
        const segY =
          seg.roofType === 'shed'
            ? seg.eaveY + Math.max(0, seg.halfD - lz) * seg.slopeTan
            : seg.eaveY + Math.max(0, seg.halfD - Math.abs(lz)) * seg.slopeTan
        if (bestSegY === null || segY > bestSegY) bestSegY = segY
      }
    }
    if (bestSegY !== null) return Math.min(fallbackGableY, bestSegY)
  }
  return fallbackGableY
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
  /** Optional small lateral wall-chase stagger (meters, clamped to +/- 0.018 m) to prevent coplanar parallel conduit Z-fighting. */
  laneOffsetLateralM?: number
  /** Optional scene graph nodes for extracting explicit `roof-segment` envelopes when not already supplied on `cavities`. */
  nodes?: Readonly<Record<string, SceneNodeLike>>
  /** Optional active level ID paired with `nodes` for explicit `roof-segment` scoping. */
  levelId?: string | null
  /** Optional interior room polygons for concave footprint containment when wall loops are incomplete. */
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[]
  /** Optional outdoor/courtyard polygons excluded from enclosed interior footprint. */
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[]
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

/** Exact Liang-Barsky / slab intersection between 3D line segment [a, b] and AABB (with optional inline margin). */
export function segmentIntersectsAabb(
  a: Vec3,
  b: Vec3,
  box: Aabb3,
  eps = 1e-6,
  margin = 0,
): boolean {
  let tMin = 0
  let tMax = 1
  for (let axis = 0; axis < 3; axis++) {
    const start = a[axis]!
    const dir = b[axis]! - start
    const bMin = box.min[axis]! - margin
    const bMax = box.max[axis]! + margin
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

/** Compute rotated XZ half-extents of a box with local dimensions (width, depth) rotated by `rotY` radians. */
function rotatedHalfExtentsXZ(width: number, depth: number, rotY: number): [number, number] {
  const cos = Math.abs(Math.cos(rotY))
  const sin = Math.abs(Math.sin(rotY))
  return [(width * cos + depth * sin) / 2, (width * sin + depth * cos) / 2]
}

/** Shared nominal footprint & AABB for `hvac:equipment` / `hvac-equipment` (routing + NEC 110.26 audit parity). */
export function getHvacEquipmentBox(node: SceneNodeLike): Aabb3 | null {
  if (!isVec3(node.position)) return null
  const [x, y, z] = node.position
  const asset =
    node.asset && typeof node.asset === 'object'
      ? (node.asset as Record<string, unknown>)
      : null
  const explicitDims = isVec3(node.dimensions)
    ? node.dimensions
    : isVec3(asset?.dimensions)
      ? asset.dimensions
      : isVec3(node.size)
        ? node.size
        : null
  const eqKind = typeof node.equipmentKind === 'string' ? node.equipmentKind : ''
  const defaultDims: [number, number, number] =
    eqKind === 'rooftop-package-unit'
      ? [1.55, 1.05, 1.15]
      : eqKind === 'air-handler' || eqKind === 'gas-furnace-96' || eqKind === 'gas-furnace-80' || eqKind.startsWith('gas-furnace')
        ? [0.56, 0.72, 1.42]
        : eqKind === 'heat-pump-condenser' || eqKind === 'ac-condenser'
          ? [0.85, 0.85, 0.95]
          : eqKind === 'erv-ventilator'
            ? [0.6, 0.45, 0.45]
            : eqKind === 'range-hood'
              ? [0.76, 0.5, 0.35]
              : eqKind === 'bath-exhaust-fan'
                ? [0.3, 0.3, 0.22]
                : eqKind === 'mini-split-outdoor'
                  ? [0.82, 0.34, 0.6]
                  : eqKind === 'mini-split-indoor'
                    ? [0.85, 0.24, 0.3]
                    : eqKind === 'dehumidifier-whole-house'
                      ? [0.52, 0.38, 0.4]
                      : [0.6, 0.7, 1.1]
  // explicitDims follows Three.js Y-up [width, height, depth] convention (matching audit.ts)
  const w = explicitDims ? explicitDims[0] : typeof node.width === 'number' ? node.width : defaultDims[0]
  const h = explicitDims ? explicitDims[1] : typeof node.height === 'number' ? node.height : defaultDims[2]
  const d = explicitDims ? explicitDims[2] : typeof node.depth === 'number' ? node.depth : defaultDims[1]
  const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
  const [halfX, halfZ] = rotatedHalfExtentsXZ(w, d, rot)
  return {
    min: [x - halfX, y, z - halfZ],
    max: [x + halfX, y + h, z + halfZ],
  }
}

/** Shared AABB for `hvac:plenum` (converting `widthIn`/`heightIn`/`depthIn` x INCHES_TO_METERS, honoring `rotation`). */
export function getHvacPlenumBox(node: SceneNodeLike): Aabb3 | null {
  if (!isVec3(node.position)) return null
  const [x, y, z] = node.position
  const w = Math.max(0.24, (typeof node.widthIn === 'number' ? node.widthIn : 18) * INCHES_TO_METERS)
  const h = Math.max(0.2, (typeof node.heightIn === 'number' ? node.heightIn : 10) * INCHES_TO_METERS)
  const d = Math.max(0.24, (typeof node.depthIn === 'number' ? node.depthIn : 24) * INCHES_TO_METERS)
  const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
  const [halfX, halfZ] = rotatedHalfExtentsXZ(w, d, rot)
  return {
    min: [x - halfX, y - h / 2, z - halfZ],
    max: [x + halfX, y + h / 2, z + halfZ],
  }
}

/** Shared AABB for `plumbing:fixture` (honoring `fixtureKind` footprint and `rotation`). */
export function getPlumbingFixtureBox(node: SceneNodeLike): Aabb3 | null {
  if (!isVec3(node.position)) return null
  const [x, y, z] = node.position
  const kind = typeof node.fixtureKind === 'string' ? node.fixtureKind : ''
  let w = 0.55
  let h = 0.85
  let d = 0.5
  let roughInY = 0.45
  let centeredY = false
  switch (kind) {
    case 'bathtub':
      w = 1.52; h = 0.5; d = 0.76; roughInY = 0.15
      break
    case 'tub-shower-combo':
      w = 1.52; h = 2.05; d = 0.8; roughInY = 0.15
      break
    case 'shower':
      w = 0.96; h = 2.05; d = 0.96; roughInY = 0.05
      break
    case 'water-closet':
      w = 0.42; h = 0.78; d = 0.7; roughInY = 0.15
      break
    case 'lavatory':
      w = 0.6; h = 0.84; d = 0.5; roughInY = 0.53
      break
    case 'kitchen-sink':
      w = 0.84; h = 0.91; d = 0.56; roughInY = 0.46
      break
    case 'laundry-sink':
    case 'bar-sink':
    case 'mop-sink':
      w = 0.6; h = 0.86; d = 0.52; roughInY = 0.46
      break
    case 'dishwasher':
      w = 0.6; h = 0.86; d = 0.6; roughInY = 0.4
      break
    case 'clothes-washer':
      w = 0.68; h = 0.96; d = 0.7; roughInY = 0.0
      break
    case 'garbage-disposal':
      w = 0.22; h = 0.34; d = 0.22; centeredY = true
      break
    case 'hose-bibb':
      w = 0.12; h = 0.12; d = 0.12; centeredY = true
      break
    case 'floor-drain':
      w = 0.18; h = 0.1; d = 0.18; centeredY = true
      break
    case 'bidet':
      w = 0.4; h = 0.42; d = 0.6; roughInY = 0.15
      break
    case 'urinal':
      w = 0.38; h = 0.65; d = 0.36; roughInY = 0.45
      break
    case 'drinking-fountain':
      w = 0.45; h = 0.5; d = 0.45; roughInY = 0.45
      break
    case 'grease-interceptor':
      w = 0.65; h = 0.55; d = 0.5; roughInY = 0.0
      break
    default:
      break
  }
  if (typeof node.width === 'number' && node.width > 0) w = node.width
  if (typeof node.height === 'number' && node.height > 0) h = node.height
  if (typeof node.depth === 'number' && node.depth > 0) d = node.depth
  const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
  const [halfX, halfZ] = rotatedHalfExtentsXZ(w, d, rot)
  const minY = centeredY ? y - h / 2 : Math.max(0, y - roughInY)
  const maxY = centeredY ? y + h / 2 : minY + h
  return {
    min: [x - halfX, minY, z - halfZ],
    max: [x + halfX, maxY, z + halfZ],
  }
}

/** Shared AABB for `structural:column` (honoring `rotation`, `widthIn`, `depthIn`, `heightM`/`height`). */
export function getStructuralColumnBox(node: SceneNodeLike): Aabb3 | null {
  if (!isVec3(node.position)) return null
  const [x, y, z] = node.position
  const w = (typeof node.widthIn === 'number' ? node.widthIn : 5.5) * INCHES_TO_METERS
  const d = (typeof node.depthIn === 'number' ? node.depthIn : 5.5) * INCHES_TO_METERS
  const h =
    typeof node.heightM === 'number'
      ? node.heightM
      : typeof node.height === 'number'
        ? node.height
        : 2.8
  const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
  const [halfX, halfZ] = rotatedHalfExtentsXZ(w, d, rot)
  return {
    min: [x - halfX, y, z - halfZ],
    max: [x + halfX, y + h, z + halfZ],
  }
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
        const label = `${t === 'liquid-line' ? 'water line' : `${diamIn}" plumbing pipe`} (${node.id})`
        for (let i = 0; i < path.length - 1; i++) {
          const p0 = path[i]
          const p1 = path[i + 1]
          if (!isVec3(p0) || !isVec3(p1)) continue
          const isDiagonal = Math.abs(p1[0] - p0[0]) > 0.2 && Math.abs(p1[2] - p0[2]) > 0.2
          if (isDiagonal) {
            const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
            const steps = Math.max(2, Math.min(16, Math.ceil(len / 0.45)))
            for (let s = 0; s < steps; s++) {
              const t0 = s / steps
              const t1 = (s + 1) / steps
              const a: Vec3 = [
                p0[0] + (p1[0] - p0[0]) * t0,
                p0[1] + (p1[1] - p0[1]) * t0,
                p0[2] + (p1[2] - p0[2]) * t0,
              ]
              const b: Vec3 = [
                p0[0] + (p1[0] - p0[0]) * t1,
                p0[1] + (p1[1] - p0[1]) * t1,
                p0[2] + (p1[2] - p0[2]) * t1,
              ]
              obstacles.push({
                id: `${node.id}:seg${i}_${s}`,
                nodeId: node.id,
                nodeType: t,
                trade: 'plumbing',
                priorityRank: 2,
                box: segmentAabb(a, b, halfM, halfM),
                requiredClearanceM: DEFAULT_CLEARANCE_M,
                label,
              })
            }
          } else {
            obstacles.push({
              id: `${node.id}:seg${i}`,
              nodeId: node.id,
              nodeType: t,
              trade: 'plumbing',
              priorityRank: 2,
              box: segmentAabb(p0, p1, halfM, halfM),
              requiredClearanceM: DEFAULT_CLEARANCE_M,
              label,
            })
          }
        }
      }
      continue
    }

    if (t === 'plumbing:equipment' || t === 'plumbing:manifold') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const eqKind = typeof node.equipmentKind === 'string' ? node.equipmentKind : ''
        let halfW = t === 'plumbing:manifold' ? 0.24 : 0.30
        let minY = t === 'plumbing:manifold' ? y - 0.35 : y
        let maxY = t === 'plumbing:manifold' ? y + 0.35 : y + 1.55
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
          const isDiagonal = Math.abs(p1[0] - p0[0]) > 0.2 && Math.abs(p1[2] - p0[2]) > 0.2
          if (isDiagonal) {
            const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
            const steps = Math.max(2, Math.min(16, Math.ceil(len / 0.45)))
            for (let s = 0; s < steps; s++) {
              const t0 = s / steps
              const t1 = (s + 1) / steps
              const a: Vec3 = [
                p0[0] + (p1[0] - p0[0]) * t0,
                p0[1] + (p1[1] - p0[1]) * t0,
                p0[2] + (p1[2] - p0[2]) * t0,
              ]
              const b: Vec3 = [
                p0[0] + (p1[0] - p0[0]) * t1,
                p0[1] + (p1[1] - p0[1]) * t1,
                p0[2] + (p1[2] - p0[2]) * t1,
              ]
              obstacles.push({
                id: `${node.id}:seg${i}_${s}`,
                nodeId: node.id,
                nodeType: t,
                trade: 'hvac',
                priorityRank: 3,
                box: segmentAabb(a, b, halfW, halfH),
                requiredClearanceM: DEFAULT_CLEARANCE_M,
                label: `${t === 'lineset' ? 'refrigerant lineset' : `HVAC ${shape} duct`} (${node.id})`,
              })
            }
          } else {
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
      }
      continue
    }

    if (t === 'hvac-equipment' || t === 'hvac:equipment') {
      const box = getHvacEquipmentBox(node)
      if (box) {
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'hvac',
          priorityRank: 3,
          box,
          requiredClearanceM: HVAC_EQUIPMENT_CLEARANCE_M,
          label: `HVAC equipment (${node.name ?? node.id})`,
        })
      }
      continue
    }

    if (t === 'hvac:plenum') {
      const box = getHvacPlenumBox(node)
      if (box) {
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'hvac',
          priorityRank: 3,
          box,
          requiredClearanceM: DEFAULT_CLEARANCE_M,
          label: `HVAC plenum (${node.name ?? node.id})`,
        })
      }
      continue
    }

    if (t === 'duct-fitting' || t === 'duct-terminal' || t === 'hvac:terminal') {
      if (isVec3(node.position)) {
        const [x, y, z] = node.position
        const termKind = typeof node.terminalKind === 'string' ? node.terminalKind : ''
        if (termKind === 'mini-split-wall-head') {
          const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
          const [halfX, halfZ] = rotatedHalfExtentsXZ(0.85, 0.24, rot)
          obstacles.push({
            id: node.id,
            nodeId: node.id,
            nodeType: t,
            trade: 'hvac',
            priorityRank: 3,
            box: { min: [x - halfX, y - 0.15, z - halfZ], max: [x + halfX, y + 0.15, z + halfZ] },
            requiredClearanceM: DEFAULT_CLEARANCE_M,
            label: `HVAC ${t} (${node.name ?? node.id})`,
          })
        } else {
          const isLowProfileSensor = termKind === 'smart-thermostat' || termKind === 'zone-sensor'
          const neckIn = typeof node.neckSizeIn === 'number' && node.neckSizeIn > 0 ? node.neckSizeIn : 6
          const half = isLowProfileSensor
            ? 0.06
            : t === 'hvac:terminal'
              ? Math.max(0.14, (neckIn * INCHES_TO_METERS) / 2 + 0.06)
              : 0.14
          const halfY = isLowProfileSensor ? 0.06 : t === 'hvac:terminal' ? 0.1 : half
          obstacles.push({
            id: node.id,
            nodeId: node.id,
            nodeType: t,
            trade: 'hvac',
            priorityRank: 3,
            box: { min: [x - half, y - halfY, z - half], max: [x + half, y + halfY, z + half] },
            requiredClearanceM: DEFAULT_CLEARANCE_M,
            label: `HVAC ${t} (${node.name ?? node.id})`,
          })
        }
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
        const sx = Number(s[0])
        const sz = Number(s[1])
        const ex = Number(e[0])
        const ez = Number(e[1])
        const label = `structural beam ${String(node.designation ?? node.beamType ?? '')} (${node.id})`.trim()
        const isDiagonal = Math.abs(ex - sx) > 0.2 && Math.abs(ez - sz) > 0.2
        if (isDiagonal) {
          const len = Math.hypot(ex - sx, ez - sz)
          const steps = Math.max(2, Math.min(24, Math.ceil(len / 0.6)))
          for (let i = 0; i < steps; i++) {
            const t0 = i / steps
            const t1 = (i + 1) / steps
            const p0: Vec3 = [sx + (ex - sx) * t0, y, sz + (ez - sz) * t0]
            const p1: Vec3 = [sx + (ex - sx) * t1, y, sz + (ez - sz) * t1]
            obstacles.push({
              id: `${node.id}:seg${i}`,
              nodeId: node.id,
              nodeType: t,
              trade: 'structural',
              priorityRank: 1,
              box: segmentAabb(p0, p1, w / 2, h / 2),
              requiredClearanceM: 0.03,
              label,
            })
          }
        } else {
          const p0: Vec3 = [sx, y, sz]
          const p1: Vec3 = [ex, y, ez]
          obstacles.push({
            id: node.id,
            nodeId: node.id,
            nodeType: t,
            trade: 'structural',
            priorityRank: 1,
            box: segmentAabb(p0, p1, w / 2, h / 2),
            requiredClearanceM: 0.03,
            label,
          })
        }
      }
      continue
    }

    if (t === 'structural:column') {
      const box = getStructuralColumnBox(node)
      if (box) {
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box,
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
        const rot = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0
        const [halfX, halfZ] = rotatedHalfExtentsXZ(w, d, rot)
        obstacles.push({
          id: node.id,
          nodeId: node.id,
          nodeType: t,
          trade: 'structural',
          priorityRank: 1,
          box: { min: [x - halfX, y, z - halfZ], max: [x + halfX, y + h, z + halfZ] },
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
 * Aligns with Structural `audit.ts`: prefers `maxWallH` (> 1.5 m) when explicit tall walls exist
 * on the level, falling back to `levelNode.height` when walls omit explicit heights, and 2.7 m otherwise.
 */
export function resolveLevelHeightM(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId?: string | null,
): number {
  const all = Object.values(nodes)
  let maxWallH = 0
  for (const n of all) {
    if (n.type !== 'wall' || n.visible === false) continue
    if (levelId && !belongsToLevel(nodes, n, levelId)) continue
    if (typeof n.height === 'number' && Number.isFinite(n.height) && n.height > 1.5 && n.height <= 12) {
      if (n.height > maxWallH) maxWallH = n.height
    }
  }
  if (maxWallH > 1.5) return maxWallH

  const levelNode =
    (levelId ? nodes[levelId] : undefined) ?? all.find((n) => n.type === 'level')
  if (
    levelNode &&
    typeof levelNode.height === 'number' &&
    Number.isFinite(levelNode.height) &&
    levelNode.height > 1.5 &&
    levelNode.height <= 12
  ) {
    return levelNode.height
  }
  return 2.7
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
    const doorDetails: RoutingDoorDetail[] = []
    const windowSpans: RoutingWindowSpan[] = []
    for (const child of all) {
      if (child.parentId !== n.id) continue
      if (child.type === 'door') {
        const openW = typeof child.width === 'number' && child.width > 0 ? child.width : 0.9
        const openH = typeof child.height === 'number' && child.height > 0 ? child.height : 2.13
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
        const dStart = Math.max(0, tCenter - openW / 2)
        const dEnd = Math.min(len, tCenter + openW / 2)
        doorSpans.push([dStart, dEnd])
        doorDetails.push({ startDist: dStart, endDist: dEnd, headY: Math.min(height, openH) })
      } else if (child.type === 'window') {
        const winW = typeof child.width === 'number' && child.width > 0 ? child.width : 1.0
        const winH = typeof child.height === 'number' && child.height > 0 ? child.height : 1.2
        let tCenter = len / 2
        if (Array.isArray(child.position) && typeof child.position[0] === 'number') {
          const px = child.position[0] as number
          const pz = typeof child.position[2] === 'number' ? (child.position[2] as number) : 0
          if (Math.abs(pz) < 0.4 && px >= -0.2 && px <= len + 0.2) {
            tCenter = px
          } else {
            tCenter = (px - sx) * dx + (pz - sz) * dz
          }
        } else if (typeof child.offset === 'number' && Number.isFinite(child.offset)) {
          tCenter = child.offset
        }
        let sillY = 0.9
        if (typeof child.sillHeight === 'number' && Number.isFinite(child.sillHeight)) {
          sillY = child.sillHeight
        } else if (
          Array.isArray(child.position) &&
          typeof child.position[1] === 'number' &&
          Number.isFinite(child.position[1]) &&
          child.position[1] > 0
        ) {
          // Pascal WindowNode stores vertical center at position[1] (sillY = centerY - height / 2)
          sillY = Math.max(0, child.position[1] - winH / 2)
        }
        const headY = sillY + winH
        windowSpans.push({
          startDist: Math.max(0, tCenter - winW / 2),
          endDist: Math.min(len, tCenter + winW / 2),
          sillY,
          headY,
        })
      }
    }

    walls.push({
      id: n.id,
      start: [sx, sz],
      end: [ex, ez],
      thickness,
      height,
      doorSpans: doorSpans.length > 0 ? doorSpans : undefined,
      doorDetails: doorDetails.length > 0 ? doorDetails : undefined,
      windowSpans: windowSpans.length > 0 ? windowSpans : undefined,
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
  const activeBuildingId = typeof activeLevel?.parentId === 'string' ? activeLevel.parentId : null
  const activeLevelIdx =
    activeLevel && typeof activeLevel.level === 'number' ? activeLevel.level : 0
  const activeLevelOrder = levelElevationOrder(activeLevel)

  const levelOrderById = new Map<string, number>()
  const levelBuildingById = new Map<string, string | null>()
  for (const n of all) {
    if (n.type === 'level') {
      levelOrderById.set(n.id, levelElevationOrder(n))
      levelBuildingById.set(n.id, typeof n.parentId === 'string' ? n.parentId : null)
    }
  }
  const sameBuildingLevel = (lid: string | null): boolean => {
    if (!lid || !activeBuildingId) return true
    const b = levelBuildingById.get(lid) ?? null
    return !b || b === activeBuildingId
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

  const wallLevelIds = new Set<string>()
  const roofLevelIds = new Set<string>()
  for (const n of all) {
    if (n.type === 'wall' && n.visible !== false) {
      const lid = resolveNodeLevelId(nodes, n)
      if (lid) wallLevelIds.add(lid)
    } else if ((n.type === 'roof' || n.type === 'roof-segment') && n.visible !== false) {
      const lid = resolveNodeLevelId(nodes, n)
      if (lid) roofLevelIds.add(lid)
    }
  }

  const hasUpperWallLevel = all.some(
    (n) =>
      n.type === 'level' &&
      n.id !== activeLevelId &&
      sameBuildingLevel(n.id) &&
      levelElevationOrder(n) > activeLevelOrder &&
      wallLevelIds.has(n.id),
  )

  const assemblyNode =
    all.find((n) => n.type === 'structural:assembly' && belongsToLevel(nodes, n, activeLevelId)) ??
    all.find((n) => n.type === 'structural:assembly')
  const roofPitchRise =
    assemblyNode &&
    typeof assemblyNode.roofPitchRise === 'number' &&
    Number.isFinite(assemblyNode.roofPitchRise) &&
    assemblyNode.roofPitchRise > 0
      ? assemblyNode.roofPitchRise
      : 6

  for (const n of all) {
    const t = n.type
    const nLevelId = resolveNodeLevelId(nodes, n)
    const nLevelOrder = nLevelId !== null ? (levelOrderById.get(nLevelId) ?? 0) : activeLevelOrder
    const nameCat = `${typeof n.name === 'string' ? n.name : ''} ${typeof n.category === 'string' ? n.category : ''}`
    const meta = (n.metadata && typeof n.metadata === 'object' ? n.metadata : {}) as Record<string, unknown>

    // 1. Attic / overhead joist cavity detection
    if ((t === 'roof' || t === 'roof-segment') && n.visible !== false) {
      if (
        !hasUpperWallLevel &&
        sameBuildingLevel(nLevelId) &&
        (nLevelId === null || nLevelId === activeLevelId || nLevelOrder >= activeLevelOrder)
      ) {
        hasAttic = true
        addSource('roof')
      }
    } else if (t === 'level' && n.id !== activeLevelId && sameBuildingLevel(n.id)) {
      if (typeof n.level === 'number' && n.level === activeLevelIdx + 1) {
        hasAttic = true
        const upperIsRoofOnly =
          !wallLevelIds.has(n.id) && (roofLevelIds.has(n.id) || /\b(roof|attic)\b/i.test(nameCat))
        addSource(upperIsRoofOnly ? 'roof' : 'upper-floor-joists')
      }
      if (
        (typeof n.level === 'number' && n.level < activeLevelIdx && CRAWL_PATTERN.test(nameCat)) ||
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
      if (ATTIC_PATTERN.test(nameCat) && !hasUpperWallLevel && sameBuildingLevel(nLevelId) && nLevelOrder >= activeLevelOrder) {
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

  // Also check if a lower level below activeLevelOrder contains a crawlspace/basement/utility zone
  if (!hasCrawlSpace) {
    for (const n of all) {
      if (n.type !== 'zone') continue
      const nLevelId = resolveNodeLevelId(nodes, n)
      if (!nLevelId || nLevelId === activeLevelId || !sameBuildingLevel(nLevelId)) continue
      const nLevelOrder = levelOrderById.get(nLevelId) ?? 0
      if (nLevelOrder >= activeLevelOrder) continue
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

  const explicitRoofSegs = !hasUpperWallLevel
    ? extractExplicitRoofSegments(nodes, activeLevelId, levelHeight)
    : []

  return {
    hasAttic,
    hasCrawlSpace,
    crawlSpaceWet,
    atticY: round3(levelHeight + 0.12),
    crawlSpaceY: -0.18,
    sources,
    roofPitchRise,
    levelHeight,
    ...(explicitRoofSegs.length > 0 ? { explicitRoofSegs } : {}),
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
      if (!segmentIntersectsAabb(a, b, obs.box, 1e-6, margin)) continue
      const key = `${obs.nodeId}:${i}`
      if (seenKey.has(key)) continue
      seenKey.add(key)
      const mid: Vec3 = [round3((a[0] + b[0]) / 2), round3((a[1] + b[1]) / 2), round3((a[2] + b[2]) / 2)]
      clashes.push({
        segmentIndex: i,
        obstacleId: obs.id,
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

function hasInterveningWindow(
  wall: RoutingWallSegment,
  tA: number,
  tB: number,
  chaseY: number,
): boolean {
  if (!wall.windowSpans || wall.windowSpans.length === 0) return false
  const lo = Math.min(tA, tB)
  const hi = Math.max(tA, tB)
  for (const win of wall.windowSpans) {
    if (
      win.endDist > lo + 0.05 &&
      win.startDist < hi - 0.05 &&
      chaseY >= win.sillY - 0.05 &&
      chaseY <= win.headY + 0.05
    ) {
      return true
    }
  }
  return false
}

/**
 * Build inviolable 3D architectural opening exclusion prisms (windows & doors) from routing walls.
 * Each prism spans `[tMin + 0.04, tMax - 0.04]` along the wall, `±(wall.thickness/2 + 0.05)`
 * perpendicular to the wall, and `[0.02, headY]` (door) or `[sillY, headY]` (window) vertically.
 */
export function extractWallOpeningPrisms(
  walls: readonly RoutingWallSegment[],
): WallOpeningPrism[] {
  const prisms: WallOpeningPrism[] = []
  const makePrism = (
    wall: RoutingWallSegment,
    wallIdx: number,
    kind: 'door' | 'window',
    idx: number,
    rawStart: number,
    rawEnd: number,
    yMin: number,
    yMax: number,
  ) => {
    const vx = wall.end[0] - wall.start[0]
    const vz = wall.end[1] - wall.start[1]
    const wallLen = Math.hypot(vx, vz)
    if (wallLen < 1e-4) return
    const tMin = Math.max(0, rawStart + 0.04)
    const tMax = Math.min(wallLen, rawEnd - 0.04)
    if (tMax <= tMin + 0.02 || yMax <= yMin + 0.02) return
    const dx = vx / wallLen
    const dz = vz / wallLen
    const nx = -dz
    const nz = dx
    const halfPerp = wall.thickness / 2 + 0.05
    const x0 = wall.start[0] + dx * tMin
    const z0 = wall.start[1] + dz * tMin
    const x1 = wall.start[0] + dx * tMax
    const z1 = wall.start[1] + dz * tMax
    const cxs = [
      x0 + nx * halfPerp,
      x0 - nx * halfPerp,
      x1 + nx * halfPerp,
      x1 - nx * halfPerp,
    ]
    const czs = [
      z0 + nz * halfPerp,
      z0 - nz * halfPerp,
      z1 + nz * halfPerp,
      z1 - nz * halfPerp,
    ]
    prisms.push({
      id: `${wall.id}:${kind}:${idx}`,
      wallId: wall.id,
      wallIdx,
      kind,
      originX: wall.start[0],
      originZ: wall.start[1],
      dx,
      dz,
      nx,
      nz,
      tMin,
      tMax,
      halfPerp,
      yMin,
      yMax,
      wallLen,
      aabb: {
        min: [Math.min(...cxs), yMin, Math.min(...czs)],
        max: [Math.max(...cxs), yMax, Math.max(...czs)],
      },
    })
  }

  for (let wi = 0; wi < walls.length; wi++) {
    const w = walls[wi]!
    if (w.doorDetails && w.doorDetails.length > 0) {
      for (let di = 0; di < w.doorDetails.length; di++) {
        const d = w.doorDetails[di]!
        makePrism(w, wi, 'door', di, d.startDist, d.endDist, 0.02, Math.min(w.height, d.headY))
      }
    } else if (w.doorSpans && w.doorSpans.length > 0) {
      const defHeadY = Math.min(w.height - 0.04, 2.13)
      for (let di = 0; di < w.doorSpans.length; di++) {
        const [dStart, dEnd] = w.doorSpans[di]!
        makePrism(w, wi, 'door', di, dStart, dEnd, 0.02, Math.max(0.5, defHeadY))
      }
    }
    if (w.windowSpans && w.windowSpans.length > 0) {
      for (let wni = 0; wni < w.windowSpans.length; wni++) {
        const win = w.windowSpans[wni]!
        makePrism(w, wi, 'window', wni, win.startDist, win.endDist, win.sillY, win.headY)
      }
    }
  }
  return prisms
}

/**
 * Exact 3D oriented-slab intersection test between segment `[a, b]` and a wall opening prism
 * (works identically for axis-aligned and diagonal walls with zero discretization artifacts).
 */
export function segmentIntersectsOpeningPrism(
  a: Vec3,
  b: Vec3,
  prism: WallOpeningPrism,
  padM = 0,
): boolean {
  const broadAabb: Aabb3 =
    padM > 0
      ? {
          min: [prism.aabb.min[0] - padM, prism.aabb.min[1] - padM, prism.aabb.min[2] - padM],
          max: [prism.aabb.max[0] + padM, prism.aabb.max[1] + padM, prism.aabb.max[2] + padM],
        }
      : prism.aabb
  if (!segmentIntersectsAabb(a, b, broadAabb)) return false
  const rax = a[0] - prism.originX
  const raz = a[2] - prism.originZ
  const rbx = b[0] - prism.originX
  const rbz = b[2] - prism.originZ
  const localA: Vec3 = [rax * prism.dx + raz * prism.dz, a[1], rax * prism.nx + raz * prism.nz]
  const localB: Vec3 = [rbx * prism.dx + rbz * prism.dz, b[1], rbx * prism.nx + rbz * prism.nz]
  const localBox: Aabb3 = {
    min: [prism.tMin - padM, prism.yMin - padM, -(prism.halfPerp + padM)],
    max: [prism.tMax + padM, prism.yMax + padM, prism.halfPerp + padM],
  }
  return segmentIntersectsAabb(localA, localB, localBox)
}

/**
 * Count how many segments along `path` intersect at least one door or window opening prism.
 */
export function countPathOpeningHits(
  path: readonly Vec3[],
  prisms: readonly WallOpeningPrism[],
  padM = 0,
): number {
  if (prisms.length === 0 || path.length < 2) return 0
  let hits = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    for (let pi = 0; pi < prisms.length; pi++) {
      if (segmentIntersectsOpeningPrism(a, b, prisms[pi]!, padM)) {
        hits += 1
        break
      }
    }
  }
  return hits
}

function findFirstOpeningHit(
  path: readonly Vec3[],
  prisms: readonly WallOpeningPrism[],
  padM = 0,
): { segmentIndex: number; prism: WallOpeningPrism } | null {
  if (prisms.length === 0 || path.length < 2) return null
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    for (let pi = 0; pi < prisms.length; pi++) {
      const prism = prisms[pi]!
      if (segmentIntersectsOpeningPrism(a, b, prism, padM)) {
        return { segmentIndex: i, prism }
      }
    }
  }
  return null
}

function wallSpanHitsOpeningAtY(
  wall: RoutingWallSegment,
  tA: number,
  tB: number,
  y: number,
): boolean {
  const lo = Math.min(tA, tB)
  const hi = Math.max(tA, tB)
  if (hi - lo < 0.02) return false
  if (wall.doorDetails && wall.doorDetails.length > 0) {
    for (const d of wall.doorDetails) {
      if (d.endDist - 0.04 > lo && d.startDist + 0.04 < hi && y >= 0.02 && y <= Math.min(wall.height, d.headY)) {
        return true
      }
    }
  } else if (wall.doorSpans && wall.doorSpans.length > 0) {
    const defHead = Math.min(wall.height - 0.04, 2.13)
    for (const [dStart, dEnd] of wall.doorSpans) {
      if (dEnd - 0.04 > lo && dStart + 0.04 < hi && y >= 0.02 && y <= defHead) {
        return true
      }
    }
  }
  if (wall.windowSpans && wall.windowSpans.length > 0) {
    for (const win of wall.windowSpans) {
      if (
        win.endDist - 0.04 > lo &&
        win.startDist + 0.04 < hi &&
        y >= win.sillY &&
        y <= win.headY
      ) {
        return true
      }
    }
  }
  return false
}

type WallRiserPier = {
  readonly pierT: number
  readonly pierX: number
  readonly pierZ: number
  readonly jogY: number
}

/**
 * If a wall-mounted endpoint sits below a raised window (or above a window/door) and its vertical
 * riser toward `targetY` would slice through the opening glass/void, jog horizontally inside the
 * solid cripple-stud zone (below `sillY - 0.12` or above `headY + 0.08`) to the nearest solid
 * king-stud pier outside `[startDist, endDist]` BEFORE climbing/dropping vertically.
 */
function resolveWallRiserPier(
  proj: WallProjection,
  pt: Vec3,
  targetY: number,
): WallRiserPier | null {
  const w = proj.wall
  const yLo = Math.min(pt[1], targetY)
  const yHi = Math.max(pt[1], targetY)
  if (yHi - yLo < 0.05) return null

  const openings: Array<{ startDist: number; endDist: number; yMin: number; yMax: number; kind: 'door' | 'window' }> = []
  if (w.doorDetails && w.doorDetails.length > 0) {
    for (const d of w.doorDetails) {
      openings.push({ startDist: d.startDist, endDist: d.endDist, yMin: 0.02, yMax: Math.min(w.height, d.headY), kind: 'door' })
    }
  } else if (w.doorSpans && w.doorSpans.length > 0) {
    const defHead = Math.min(w.height - 0.04, 2.13)
    for (const [ds, de] of w.doorSpans) {
      openings.push({ startDist: ds, endDist: de, yMin: 0.02, yMax: defHead, kind: 'door' })
    }
  }
  if (w.windowSpans && w.windowSpans.length > 0) {
    for (const win of w.windowSpans) {
      openings.push({ startDist: win.startDist, endDist: win.endDist, yMin: win.sillY, yMax: win.headY, kind: 'window' })
    }
  }
  if (openings.length === 0) return null

  const hitOp = openings.find(
    (op) =>
      proj.t >= op.startDist + 0.02 &&
      proj.t <= op.endDist - 0.02 &&
      Math.max(yLo, op.yMin) <= Math.min(yHi, op.yMax),
  )
  if (!hitOp) return null

  let jogY = pt[1]
  if (targetY > pt[1] && pt[1] < hitOp.yMin + 0.05 && hitOp.yMin >= 0.25) {
    jogY = round3(Math.max(0.15, Math.min(pt[1], hitOp.yMin - 0.12)))
  } else if (targetY < pt[1] && pt[1] > hitOp.yMax - 0.05) {
    jogY = round3(Math.min(w.height - 0.04, Math.max(pt[1], hitOp.yMax + 0.08)))
  }

  const riserYLo = Math.min(jogY, targetY)
  const riserYHi = Math.max(jogY, targetY)
  const blocking = openings.filter((op) => Math.max(riserYLo, op.yMin) <= Math.min(riserYHi, op.yMax))

  // Scan left & right past any contiguous blocking openings to find the closest solid king-stud pier
  let tL = proj.t
  for (let step = 0; step < blocking.length + 1; step++) {
    const inside = blocking.find((op) => tL >= op.startDist - 0.02 && tL <= op.endDist + 0.02)
    if (!inside) break
    tL = inside.startDist - 0.08
  }
  let tR = proj.t
  for (let step = 0; step < blocking.length + 1; step++) {
    const inside = blocking.find((op) => tR >= op.startDist - 0.02 && tR <= op.endDist + 0.02)
    if (!inside) break
    tR = inside.endDist + 0.08
  }

  const leftOk = tL >= 0.03 && !wallSpanHitsOpeningAtY(w, proj.t, tL, jogY)
  const rightOk = tR <= proj.len - 0.03 && !wallSpanHitsOpeningAtY(w, proj.t, tR, jogY)
  let bestT: number | null = null
  if (leftOk && rightOk) {
    bestT = Math.abs(proj.t - tL) <= Math.abs(tR - proj.t) ? tL : tR
  } else if (leftOk) {
    bestT = tL
  } else if (rightOk) {
    bestT = tR
  }
  if (bestT === null) return null
  return {
    pierT: round3(bestT),
    pierX: round3(w.start[0] + proj.dx * bestT),
    pierZ: round3(w.start[1] + proj.dz * bestT),
    jogY,
  }
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
  bypassHorizontalShortcut = false,
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
  isPointTrapped?: (pt: Vec3) => boolean,
): Vec3[] | null {
  if (walls.length === 0) return null
  const sProj = projectPointToWalls(start[0], start[2], walls)
  const eProj = projectPointToWalls(end[0], end[2], walls)
  if (!sProj || !eProj) return null

  const rawStartWall = isEndpointWallMounted(start, sProj)
  const rawEndWall = isEndpointWallMounted(end, eProj)
  const concealed = wallPlacement === 'in-wall'

  // In concealed ('in-wall') mode, wall-mounted boxes terminate inside the stud cavity on the wall centerline,
  // EXCEPT never snap a clear endpoint onto a wall centerline point that falls inside an adjacent obstacle's clearance!
  const sSnapped: Vec3 = [round3(sProj.x), start[1], round3(sProj.z)]
  const eSnapped: Vec3 = [round3(eProj.x), end[1], round3(eProj.z)]
  const isStartWall =
    rawStartWall && !(concealed && isPointTrapped && !isPointTrapped(start) && isPointTrapped(sSnapped))
  const isEndWall =
    rawEndWall && !(concealed && isPointTrapped && !isPointTrapped(end) && isPointTrapped(eSnapped))
  const startPt: Vec3 = concealed && isStartWall ? sSnapped : start
  const endPt: Vec3 = concealed && isEndWall ? eSnapped : end

  // Fast path A: Same wall, same mounting height band, no door or window in between -> horizontal stud-bored wall chase!
  const midY = round3((start[1] + end[1]) / 2)
  if (
    !bypassHorizontalShortcut &&
    isStartWall &&
    isEndWall &&
    sProj.wallIdx === eProj.wallIdx &&
    Math.abs(start[1] - end[1]) < 0.25 &&
    Math.max(start[1], end[1]) < chaseY - 0.35 &&
    !hasInterveningDoor(sProj.wall, sProj.t, eProj.t) &&
    !hasInterveningWindow(sProj.wall, sProj.t, eProj.t, midY)
  ) {
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
    const startPier = resolveWallRiserPier(sProj, startPt, chaseY)
    const endPier = resolveWallRiserPier(eProj, endPt, chaseY)
    if (concealed) {
      const pts: Vec3[] = [startPt]
      if (startPier) {
        pts.push(
          [startPt[0], startPier.jogY, startPt[2]],
          [startPier.pierX, startPier.jogY, startPier.pierZ],
          [startPier.pierX, chaseY, startPier.pierZ],
        )
      } else {
        pts.push([round3(sProj.x), chaseY, round3(sProj.z)])
      }
      if (endPier) {
        pts.push(
          [endPier.pierX, chaseY, endPier.pierZ],
          [endPier.pierX, endPier.jogY, endPier.pierZ],
          [endPt[0], endPier.jogY, endPt[2]],
        )
      } else {
        pts.push([round3(eProj.x), chaseY, round3(eProj.z)])
      }
      pts.push(endPt)
      return simplifyOrthogonalPath(pts)
    }
    const sameSide = sProj.signedDist * eProj.signedDist >= -1e-4
    if (sameSide && !startPier && !endPier) {
      return simplifyOrthogonalPath([
        start,
        [start[0], chaseY, start[2]],
        [end[0], chaseY, end[2]],
        end,
      ])
    }
    const pts: Vec3[] = [start]
    if (startPier) {
      const nx = -sProj.dz
      const nz = sProj.dx
      const sOffX = round3(startPier.pierX + nx * sProj.signedDist)
      const sOffZ = round3(startPier.pierZ + nz * sProj.signedDist)
      pts.push([start[0], startPier.jogY, start[2]], [sOffX, startPier.jogY, sOffZ], [sOffX, chaseY, sOffZ])
    } else {
      pts.push([start[0], chaseY, start[2]])
    }
    if (!sameSide) {
      pts.push(
        [startPier ? startPier.pierX : sProj.x, chaseY, startPier ? startPier.pierZ : sProj.z],
        [endPier ? endPier.pierX : eProj.x, chaseY, endPier ? endPier.pierZ : eProj.z],
      )
    }
    if (endPier) {
      const nx = -eProj.dz
      const nz = eProj.dx
      const eOffX = round3(endPier.pierX + nx * eProj.signedDist)
      const eOffZ = round3(endPier.pierZ + nz * eProj.signedDist)
      pts.push([eOffX, chaseY, eOffZ], [eOffX, endPier.jogY, eOffZ], [end[0], endPier.jogY, end[2]])
    } else {
      pts.push([end[0], chaseY, end[2]])
    }
    pts.push(end)
    return simplifyOrthogonalPath(pts)
  }

  return routeViaWallNetwork(
    start,
    end,
    chaseY,
    walls,
    sProj,
    eProj,
    isStartWall,
    isEndWall,
    startPt,
    endPt,
    concealed,
    interiorPolygons,
    outdoorPolygons,
  )
}

interface CachedWallGraphEdge {
  to: number
  weight: number
  isWall: boolean
  wallIdx?: number
  t0?: number
  t1?: number
}

interface CachedWallNetworkBase {
  wallGeom: Array<{ w: RoutingWallSegment; len: number; dx: number; dz: number }>
  nodes2D: Array<{ x: number; z: number }>
  adj: CachedWallGraphEdge[][]
  /** Sorted wall split points `(t, vIdx)` along each wall index for O(log k) start/end splicing. */
  wallChains: Array<Array<{ t: number; vIdx: number }>>
  /** Bounded interior face polygons extracted from wall-only cycles (positive signed area in XZ). */
  boundedFaces: Array<Array<[number, number]>>
  /** True when `boundedFaces` covers the vast majority (>= 72%) of wall length (closed perimeter footprint). */
  boundedFacesComplete: boolean
  /** Tight XZ bounding box of all walls in this level. */
  aabb: XZBounds
  /** Inviolable 3D door/window opening exclusion prisms extracted once per wall array. */
  openingPrisms: WallOpeningPrism[]
}

function pointInPolygon2D(px: number, pz: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!
    const [xj, zj] = poly[j]!
    const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Extract all bounded interior face polygons (positive signed area in XZ) from wall-only edges
 * of the planar wall graph using half-edge angle sorting. Handles concave L/U/T/H footprints
 * and multi-room layouts without requiring `zone` nodes.
 */
function extractBoundedWallFaces(
  nodes2D: ReadonlyArray<{ x: number; z: number }>,
  adj: ReadonlyArray<ReadonlyArray<CachedWallGraphEdge>>,
): Array<Array<[number, number]>> {
  type HalfEdge = { id: number; from: number; to: number; twin: number; angle: number }
  const halfEdges: HalfEdge[] = []
  const seenUndirected = new Set<string>()
  const outgoing: number[][] = Array.from({ length: nodes2D.length }, () => [])

  for (let u = 0; u < adj.length; u++) {
    const nu = nodes2D[u]!
    for (const e of adj[u]!) {
      if (!e.isWall) continue
      const v = e.to
      if (u === v) continue
      const key = u < v ? `${u}:${v}` : `${v}:${u}`
      if (seenUndirected.has(key)) continue
      seenUndirected.add(key)
      const nv = nodes2D[v]!
      if (Math.hypot(nv.x - nu.x, nv.z - nu.z) < 1e-4) continue
      const id1 = halfEdges.length
      const id2 = id1 + 1
      halfEdges.push({ id: id1, from: u, to: v, twin: id2, angle: Math.atan2(nv.z - nu.z, nv.x - nu.x) })
      halfEdges.push({ id: id2, from: v, to: u, twin: id1, angle: Math.atan2(nu.z - nv.z, nu.x - nv.x) })
      outgoing[u]!.push(id1)
      outgoing[v]!.push(id2)
    }
  }
  if (halfEdges.length === 0) return []

  const outIndex = new Int32Array(halfEdges.length)
  for (let v = 0; v < outgoing.length; v++) {
    const list = outgoing[v]!
    list.sort((a, b) => halfEdges[a]!.angle - halfEdges[b]!.angle)
    for (let i = 0; i < list.length; i++) {
      outIndex[list[i]!] = i
    }
  }

  const visited = new Uint8Array(halfEdges.length)
  const faces: Array<Array<[number, number]>> = []
  const maxSteps = halfEdges.length + 2
  for (let i = 0; i < halfEdges.length; i++) {
    if (visited[i]) continue
    const poly: Array<[number, number]> = []
    let cur = i
    let steps = 0
    while (!visited[cur] && steps < maxSteps) {
      visited[cur] = 1
      const he = halfEdges[cur]!
      const nv = nodes2D[he.from]!
      poly.push([nv.x, nv.z])
      const nextList = outgoing[he.to]!
      const deg = nextList.length
      if (deg === 0) break
      const twinPos = outIndex[he.twin]!
      cur = nextList[(twinPos - 1 + deg) % deg]!
      steps += 1
    }
    if (poly.length < 3) continue
    let area2 = 0
    for (let k = 0; k < poly.length; k++) {
      const [x1, z1] = poly[k]!
      const [x2, z2] = poly[(k + 1) % poly.length]!
      area2 += x1 * z2 - x2 * z1
    }
    if (area2 > 0.2) {
      faces.push(poly)
    }
  }
  return faces
}

const wallNetworkCache = new WeakMap<readonly RoutingWallSegment[], CachedWallNetworkBase>()

function getCachedWallNetworkBase(walls: readonly RoutingWallSegment[]): CachedWallNetworkBase {
  const hit = wallNetworkCache.get(walls)
  if (hit) return hit

  const wallGeom = walls.map((w) => {
    const vx = w.end[0] - w.start[0]
    const vz = w.end[1] - w.start[1]
    const len = Math.hypot(vx, vz)
    return { w, len, dx: len > 1e-4 ? vx / len : 1, dz: len > 1e-4 ? vz / len : 0 }
  })

  const splits: number[][] = wallGeom.map((g) => [0, g.len])
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

  const nodes2D: Array<{ x: number; z: number }> = []
  const findOrAddVertex = (x: number, z: number, eps: number): number => {
    for (let idx = 0; idx < nodes2D.length; idx++) {
      const v = nodes2D[idx]!
      if (Math.hypot(v.x - x, v.z - z) <= eps) return idx
    }
    nodes2D.push({ x, z })
    return nodes2D.length - 1
  }

  for (let i = 0; i < wallGeom.length; i++) {
    const g = wallGeom[i]!
    for (const t of splits[i]!) {
      findOrAddVertex(g.w.start[0] + g.dx * t, g.w.start[1] + g.dz * t, 0.2)
    }
  }

  const adj: CachedWallGraphEdge[][] = Array.from({ length: nodes2D.length }, () => [])
  const addEdge = (
    u: number,
    v: number,
    weight: number,
    isWall: boolean,
    wallIdx?: number,
    t0?: number,
    t1?: number,
  ) => {
    if (u === v) return
    adj[u]!.push({ to: v, weight, isWall, wallIdx, t0, t1 })
    adj[v]!.push({ to: u, weight, isWall, wallIdx, t0: t1, t1: t0 })
  }

  const wallChains: Array<Array<{ t: number; vIdx: number }>> = wallGeom.map(() => [])
  for (let i = 0; i < wallGeom.length; i++) {
    const g = wallGeom[i]!
    const ts = [...splits[i]!].sort((a, b) => a - b)
    let prevV = -1
    let prevT = 0
    for (const t of ts) {
      const px = g.w.start[0] + g.dx * t
      const pz = g.w.start[1] + g.dz * t
      const vIdx = findOrAddVertex(px, pz, 0.2)
      const chain = wallChains[i]!
      if (chain.length === 0 || chain[chain.length - 1]!.vIdx !== vIdx) {
        chain.push({ t, vIdx })
      }
      if (prevV !== -1 && prevV !== vIdx) {
        const uNode = nodes2D[prevV]!
        const vNode = nodes2D[vIdx]!
        addEdge(prevV, vIdx, Math.hypot(vNode.x - uNode.x, vNode.z - uNode.z), true, i, prevT, t)
      }
      prevV = vIdx
      prevT = t
    }
  }

  // Pre-connect disconnected wall islands once per wall array via single-pass Kruskal MST (no 32-island truncation)
  const nVerts = nodes2D.length
  const comp = new Array<number>(nVerts).fill(-1)
  let compCount = 0
  for (let i = 0; i < nVerts; i++) {
    if (comp[i] !== -1) continue
    const q = [i]
    comp[i] = compCount
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!
      for (const e of adj[cur]!) {
        if (comp[e.to] === -1) {
          comp[e.to] = compCount
          q.push(e.to)
        }
      }
    }
    compCount += 1
  }

  if (compCount > 1) {
    // Single O(V^2) pass recording the shortest Manhattan bridge between each pair of wall components
    const bestPairEdge = new Map<number, { ca: number; cb: number; u: number; v: number; d: number }>()
    for (let u = 0; u < nVerts; u++) {
      const cu = comp[u]!
      const a = nodes2D[u]!
      for (let v = u + 1; v < nVerts; v++) {
        const cv = comp[v]!
        if (cu === cv) continue
        const ca = cu < cv ? cu : cv
        const cb = cu < cv ? cv : cu
        const key = ca * compCount + cb
        const b = nodes2D[v]!
        const md = Math.abs(b.x - a.x) + Math.abs(b.z - a.z)
        const existing = bestPairEdge.get(key)
        if (!existing || md < existing.d) {
          bestPairEdge.set(key, { ca, cb, u, v, d: md })
        }
      }
    }
    const candidateBridges = Array.from(bestPairEdge.values()).sort((a, b) => a.d - b.d)
    const ufParent = Array.from({ length: compCount }, (_, i) => i)
    const ufFind = (x: number): number => {
      let r = x
      while (ufParent[r] !== r) r = ufParent[r]!
      let cur = x
      while (ufParent[cur] !== r) {
        const next = ufParent[cur]!
        ufParent[cur] = r
        cur = next
      }
      return r
    }
    let merges = 0
    for (const edge of candidateBridges) {
      const ra = ufFind(edge.ca)
      const rb = ufFind(edge.cb)
      if (ra === rb) continue
      ufParent[ra] = rb
      addEdge(edge.u, edge.v, edge.d * 1.6 + 0.5, false)
      merges += 1
      if (merges >= compCount - 1) break
    }
  }

  const boundedFaces = extractBoundedWallFaces(nodes2D, adj)
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let totalWallLen = 0
  let coveredWallLen = 0
  for (const g of wallGeom) {
    for (const pt of [g.w.start, g.w.end]) {
      if (pt[0] < minX) minX = pt[0]
      if (pt[0] > maxX) maxX = pt[0]
      if (pt[1] < minZ) minZ = pt[1]
      if (pt[1] > maxZ) maxZ = pt[1]
    }
    if (g.len < 0.05) continue
    totalWallLen += g.len
    if (boundedFaces.length > 0) {
      const mx = (g.w.start[0] + g.w.end[0]) / 2
      const mz = (g.w.start[1] + g.w.end[1]) / 2
      const nx = -g.dz
      const nz = g.dx
      const probe = g.w.thickness / 2 + 0.2
      const touchesFace = boundedFaces.some(
        (face) =>
          pointInPolygon2D(mx + nx * probe, mz + nz * probe, face) ||
          pointInPolygon2D(mx - nx * probe, mz - nz * probe, face),
      )
      if (touchesFace) coveredWallLen += g.len
    }
  }
  const boundedFacesComplete =
    boundedFaces.length > 0 && totalWallLen > 0 && coveredWallLen / totalWallLen >= 0.72
  const aabb: XZBounds = Number.isFinite(minX)
    ? { minX, maxX, minZ, maxZ }
    : { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }
  const openingPrisms = extractWallOpeningPrisms(walls)
  const built: CachedWallNetworkBase = {
    wallGeom,
    nodes2D,
    adj,
    wallChains,
    boundedFaces,
    boundedFacesComplete,
    aabb,
    openingPrisms,
  }
  wallNetworkCache.set(walls, built)
  return built
}

/**
 * Determine whether 2D point `(px, pz)` lies inside the enclosed building wall/room footprint
 * (or concealed within a wall's thickness + `wallToleranceBonus`).
 * Combines closed wall-graph faces (`boundedFaces`) with `interiorPolygons` (so open-sided rooms
 * like lanais/covered porches stay interior), and falls back to the tight wall AABB when hand-drawn
 * walls have open corners (`!boundedFacesComplete`) without interior zones.
 */
export function isPointInsideWallFootprint(
  px: number,
  pz: number,
  walls: readonly RoutingWallSegment[],
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
  wallToleranceBonus = 0.025,
): boolean {
  if (walls.length === 0) return true
  const proj = projectPointToWalls(px, pz, walls)
  if (proj && proj.dist <= proj.wall.thickness / 2 + wallToleranceBonus) {
    return true
  }
  if (outdoorPolygons && outdoorPolygons.some((poly) => poly.length >= 3 && pointInPolygon2D(px, pz, poly))) {
    return false
  }
  if (interiorPolygons && interiorPolygons.some((poly) => poly.length >= 3 && pointInPolygon2D(px, pz, poly))) {
    return true
  }
  const base = getCachedWallNetworkBase(walls)
  if (base.boundedFacesComplete) {
    return base.boundedFaces.some((face) => pointInPolygon2D(px, pz, face))
  }
  if (base.boundedFaces.length > 0 && base.boundedFaces.some((face) => pointInPolygon2D(px, pz, face))) {
    return true
  }
  if (interiorPolygons && interiorPolygons.length > 0) {
    // Interior zone polygons were provided; if wall loops are incomplete, only treat points inside tight AABB as inside
    // when walls are open, while rejecting points strictly outside the building AABB (e.g., outdoor condensers / yard bulges).
    return (
      px >= base.aabb.minX - wallToleranceBonus &&
      px <= base.aabb.maxX + wallToleranceBonus &&
      pz >= base.aabb.minZ - wallToleranceBonus &&
      pz <= base.aabb.maxZ + wallToleranceBonus
    )
  }
  return (
    px >= base.aabb.minX - wallToleranceBonus &&
    px <= base.aabb.maxX + wallToleranceBonus &&
    pz >= base.aabb.minZ - wallToleranceBonus &&
    pz <= base.aabb.maxZ + wallToleranceBonus
  )
}

/**
 * Determine whether every sampled point along the horizontal projection of segment `[a, b]`
 * stays inside the enclosed building wall/room footprint.
 */
export function isSegmentInsideWallFootprint(
  a: Vec3,
  b: Vec3,
  walls: readonly RoutingWallSegment[],
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
  wallToleranceBonus = 0.025,
): boolean {
  if (walls.length === 0) return true
  const segLenXZ = Math.hypot(b[0] - a[0], b[2] - a[2])
  if (segLenXZ < 0.02) {
    return isPointInsideWallFootprint(a[0], a[2], walls, interiorPolygons, outdoorPolygons, wallToleranceBonus)
  }
  const steps = Math.max(2, Math.min(24, Math.ceil(segLenXZ / 0.35)))
  for (let s = 0; s <= steps; s++) {
    const f = s / steps
    const px = a[0] + (b[0] - a[0]) * f
    const pz = a[2] + (b[2] - a[2]) * f
    if (!isPointInsideWallFootprint(px, pz, walls, interiorPolygons, outdoorPolygons, wallToleranceBonus)) {
      return false
    }
  }
  return true
}

/**
 * Clamp a point `(px, pz)` that fell outside the enclosed wall footprint back inset `insetM` (default 0.12 m)
 * inside the nearest interior wall face rather than allowing outward exterior bulges.
 */
export function clampPointInsetToWallFootprint(
  px: number,
  pz: number,
  walls: readonly RoutingWallSegment[],
  insetM = 0.12,
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
): [number, number] {
  if (walls.length === 0) return [round3(px), round3(pz)]
  if (isPointInsideWallFootprint(px, pz, walls, interiorPolygons, outdoorPolygons, 0.025)) {
    return [round3(px), round3(pz)]
  }
  const proj = projectPointToWalls(px, pz, walls)
  if (!proj) return [round3(px), round3(pz)]
  const nx = -proj.dz
  const nz = proj.dx
  const stepOff = proj.wall.thickness / 2 + Math.max(0.04, insetM)
  const posCand: [number, number] = [round3(proj.x + nx * stepOff), round3(proj.z + nz * stepOff)]
  const negCand: [number, number] = [round3(proj.x - nx * stepOff), round3(proj.z - nz * stepOff)]
  const posIn = isPointInsideWallFootprint(posCand[0], posCand[1], walls, interiorPolygons, outdoorPolygons, 0)
  const negIn = isPointInsideWallFootprint(negCand[0], negCand[1], walls, interiorPolygons, outdoorPolygons, 0)
  if (posIn && !negIn) return posCand
  if (negIn && !posIn) return negCand
  return [round3(proj.x), round3(proj.z)]
}

function spliceWallEndpoint(
  base: CachedWallNetworkBase,
  wallIdx: number,
  t: number,
  x: number,
  z: number,
  extraNodes: Array<{ x: number; z: number }>,
  extraEdges: Map<number, CachedWallGraphEdge[]>,
): number {
  const baseCount = base.nodes2D.length
  const chain = base.wallChains[wallIdx] ?? []
  // Snap if practically on top of an existing wall vertex (<= 0.04 m)
  for (const item of chain) {
    const v = base.nodes2D[item.vIdx]!
    if (Math.hypot(v.x - x, v.z - z) <= 0.04) return item.vIdx
  }
  for (let i = 0; i < extraNodes.length; i++) {
    const v = extraNodes[i]!
    if (Math.hypot(v.x - x, v.z - z) <= 0.04) return baseCount + i
  }

  const newIdx = baseCount + extraNodes.length
  extraNodes.push({ x, z })
  const addTemp = (u: number, v: number, weight: number, tA: number, tB: number) => {
    if (u === v) return
    let eu = extraEdges.get(u)
    if (!eu) {
      eu = []
      extraEdges.set(u, eu)
    }
    eu.push({ to: v, weight, isWall: true, wallIdx, t0: tA, t1: tB })
    let ev = extraEdges.get(v)
    if (!ev) {
      ev = []
      extraEdges.set(v, ev)
    }
    ev.push({ to: u, weight, isWall: true, wallIdx, t0: tB, t1: tA })
  }

  // Connect to immediate left & right split vertices on this wall
  let left: { t: number; vIdx: number } | null = null
  let right: { t: number; vIdx: number } | null = null
  for (const item of chain) {
    if (item.t <= t) left = item
    if (item.t >= t && !right) right = item
  }
  if (left) {
    const v = base.nodes2D[left.vIdx]!
    addTemp(newIdx, left.vIdx, Math.hypot(v.x - x, v.z - z), t, left.t)
  }
  if (right && right.vIdx !== left?.vIdx) {
    const v = base.nodes2D[right.vIdx]!
    addTemp(newIdx, right.vIdx, Math.hypot(v.x - x, v.z - z), t, right.t)
  }
  return newIdx
}

/**
 * Build a wall-following route between start and end using the cached 2D wall centerline graph,
 * avoiding door/window opening spans at `chaseY` and jogging under-sill endpoints to solid king-stud piers.
 */
function routeViaWallNetwork(
  start: Vec3,
  end: Vec3,
  chaseY: number,
  walls: readonly RoutingWallSegment[],
  sProj: WallProjection,
  eProj: WallProjection,
  isStartWall: boolean,
  isEndWall: boolean,
  startPt: Vec3,
  endPt: Vec3,
  concealed: boolean,
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
): Vec3[] | null {
  const base = getCachedWallNetworkBase(walls)
  const baseCount = base.nodes2D.length
  const extraNodes: Array<{ x: number; z: number }> = []
  const extraEdges = new Map<number, CachedWallGraphEdge[]>()

  const startPier = isStartWall ? resolveWallRiserPier(sProj, startPt, chaseY) : null
  const endPier = isEndWall ? resolveWallRiserPier(eProj, endPt, chaseY) : null
  const sT = startPier ? startPier.pierT : sProj.t
  const sX = startPier ? startPier.pierX : sProj.x
  const sZ = startPier ? startPier.pierZ : sProj.z
  const eT = endPier ? endPier.pierT : eProj.t
  const eX = endPier ? endPier.pierX : eProj.x
  const eZ = endPier ? endPier.pierZ : eProj.z

  const startV = spliceWallEndpoint(base, sProj.wallIdx, sT, sX, sZ, extraNodes, extraEdges)
  const endV = spliceWallEndpoint(base, eProj.wallIdx, eT, eX, eZ, extraNodes, extraEdges)

  // If both endpoints landed on the same wall, add direct wall edge between them as well
  if (sProj.wallIdx === eProj.wallIdx && startV !== endV) {
    const d = Math.hypot(eX - sX, eZ - sZ)
    let eu = extraEdges.get(startV)
    if (!eu) {
      eu = []
      extraEdges.set(startV, eu)
    }
    eu.push({ to: endV, weight: d, isWall: true, wallIdx: sProj.wallIdx, t0: sT, t1: eT })
    let ev = extraEdges.get(endV)
    if (!ev) {
      ev = []
      extraEdges.set(endV, ev)
    }
    ev.push({ to: startV, weight: d, isWall: true, wallIdx: sProj.wallIdx, t0: eT, t1: sT })
  }

  const nVerts = baseCount + extraNodes.length
  const getNode = (idx: number) => (idx < baseCount ? base.nodes2D[idx]! : extraNodes[idx - baseCount]!)

  const edgeWeightAtY = (e: CachedWallGraphEdge): number => {
    if (e.isWall && e.wallIdx !== undefined && e.t0 !== undefined && e.t1 !== undefined) {
      const w = walls[e.wallIdx]
      if (w && wallSpanHitsOpeningAtY(w, e.t0, e.t1, chaseY)) {
        return e.weight + 200
      }
    }
    return e.weight
  }

  // Dijkstra shortest wall-following path from startV to endV (preferring solid walls over opening-blocked spans)
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
    const baseAdj = u < baseCount ? base.adj[u]! : undefined
    if (baseAdj) {
      for (let ei = 0; ei < baseAdj.length; ei++) {
        const e = baseAdj[ei]!
        if (visited[e.to]) continue
        const nd = distArr[u]! + edgeWeightAtY(e)
        if (nd < distArr[e.to]!) {
          distArr[e.to] = nd
          prevArr[e.to] = u
          prevIsWall[e.to] = e.isWall
        }
      }
    }
    const tempAdj = extraEdges.get(u)
    if (tempAdj) {
      for (let ei = 0; ei < tempAdj.length; ei++) {
        const e = tempAdj[ei]!
        if (visited[e.to]) continue
        const nd = distArr[u]! + edgeWeightAtY(e)
        if (nd < distArr[e.to]!) {
          distArr[e.to] = nd
          prevArr[e.to] = u
          prevIsWall[e.to] = e.isWall
        }
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
    const v = getNode(revNodes[i]!)
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

  return finalizeWallNetworkPath(
    pts2D,
    edgeWall,
    start,
    end,
    chaseY,
    isStartWall,
    isEndWall,
    startPt,
    endPt,
    concealed,
    walls,
    interiorPolygons,
    outdoorPolygons,
    startPier,
    endPier,
  )
}

function finalizeWallNetworkPath(
  pts2D: Array<[number, number]>,
  edgeWall: boolean[],
  start: Vec3,
  end: Vec3,
  chaseY: number,
  isStartWall: boolean,
  isEndWall: boolean,
  startPt: Vec3,
  endPt: Vec3,
  concealed: boolean,
  walls?: readonly RoutingWallSegment[],
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[],
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[],
  startPier?: WallRiserPier | null,
  endPier?: WallRiserPier | null,
): Vec3[] {
  const chooseInsideElbow = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    defaultElbow: [number, number],
    altElbow: [number, number],
  ): [number, number] => {
    if (!walls || walls.length === 0) return defaultElbow
    const a3: Vec3 = [ax, chaseY, az]
    const b3: Vec3 = [bx, chaseY, bz]
    const d3: Vec3 = [defaultElbow[0], chaseY, defaultElbow[1]]
    const al3: Vec3 = [altElbow[0], chaseY, altElbow[1]]
    const defOk =
      isSegmentInsideWallFootprint(a3, d3, walls, interiorPolygons, outdoorPolygons) &&
      isSegmentInsideWallFootprint(d3, b3, walls, interiorPolygons, outdoorPolygons)
    if (defOk) return defaultElbow
    const altOk =
      isSegmentInsideWallFootprint(a3, al3, walls, interiorPolygons, outdoorPolygons) &&
      isSegmentInsideWallFootprint(al3, b3, walls, interiorPolygons, outdoorPolygons)
    if (altOk) return altElbow
    return defaultElbow
  }
  // In surface-mounted mode, corner-align flush wall offsets at start & end to eliminate 6cm micro-jogs.
  // In concealed ('in-wall') mode, keep every vertex dead-center on the 2D wall centerline between drywall faces!
  if (!concealed && isStartWall && !startPier && pts2D.length >= 3 && edgeWall[0] && edgeWall[1]) {
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
  if (!concealed && isEndWall && !endPier && pts2D.length >= 3) {
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
  const pts3D: Vec3[] = startPier
    ? [
        startPt,
        [startPt[0], startPier.jogY, startPt[2]],
        [startPier.pierX, startPier.jogY, startPier.pierZ],
        [startPier.pierX, chaseY, startPier.pierZ],
      ]
    : [startPt, [startPt[0], chaseY, startPt[2]]]
  const first2D = pts2D[0]!
  const startTopX = startPier ? startPier.pierX : startPt[0]
  const startTopZ = startPier ? startPier.pierZ : startPt[2]
  if (!isStartWall) {
    if (Math.abs(startTopX - first2D[0]) > 0.01 && Math.abs(startTopZ - first2D[1]) > 0.01) {
      const elbow = chooseInsideElbow(
        startTopX,
        startTopZ,
        first2D[0],
        first2D[1],
        [first2D[0], startTopZ],
        [startTopX, first2D[1]],
      )
      pts3D.push([elbow[0], chaseY, elbow[1]])
    }
    pts3D.push([first2D[0], chaseY, first2D[1]])
  } else if (Math.hypot(startTopX - first2D[0], startTopZ - first2D[1]) > 0.01) {
    pts3D.push([first2D[0], chaseY, first2D[1]])
  }

  for (let i = 0; i < pts2D.length - 1; i++) {
    const a = pts2D[i]!
    const b = pts2D[i + 1]!
    if (!edgeWall[i] && Math.abs(b[0] - a[0]) > 0.01 && Math.abs(b[1] - a[1]) > 0.01) {
      const elbow = chooseInsideElbow(a[0], a[1], b[0], b[1], [b[0], a[1]], [a[0], b[1]])
      pts3D.push([elbow[0], chaseY, elbow[1]])
    }
    pts3D.push([b[0], chaseY, b[1]])
  }

  const last2D = pts2D[pts2D.length - 1]!
  const endTopX = endPier ? endPier.pierX : endPt[0]
  const endTopZ = endPier ? endPier.pierZ : endPt[2]
  if (!isEndWall) {
    if (Math.abs(endTopX - last2D[0]) > 0.01 && Math.abs(endTopZ - last2D[1]) > 0.01) {
      const elbow = chooseInsideElbow(
        last2D[0],
        last2D[1],
        endTopX,
        endTopZ,
        [last2D[0], endTopZ],
        [endTopX, last2D[1]],
      )
      pts3D.push([elbow[0], chaseY, elbow[1]])
    }
    pts3D.push([endTopX, chaseY, endTopZ])
  } else if (Math.hypot(endTopX - last2D[0], endTopZ - last2D[1]) > 0.01) {
    pts3D.push([endTopX, chaseY, endTopZ])
  }
  if (endPier) {
    pts3D.push(
      [endPier.pierX, endPier.jogY, endPier.pierZ],
      [endPt[0], endPier.jogY, endPt[2]],
    )
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
  allowSameWall = false,
  roofEnv: PitchedRoofEnvelope | null = null,
  roofMarginM = 0.08,
): Vec3[] | null {
  if (walls.length === 0) return null
  const sProj = projectPointToWalls(start[0], start[2], walls)
  const eProj = projectPointToWalls(end[0], end[2], walls)
  if (!sProj || !eProj) return null

  const isStartWall = isEndpointWallMounted(start, sProj)
  const isEndWall = isEndpointWallMounted(end, eProj)
  const concealed = wallPlacement === 'in-wall'

  // Same wall, same height band, no door or window between -> keep horizontal in-wall stud bore (never bore plates needlessly)
  const midY = round3((start[1] + end[1]) / 2)
  if (
    !allowSameWall &&
    isStartWall &&
    isEndWall &&
    sProj.wallIdx === eProj.wallIdx &&
    Math.abs(start[1] - end[1]) < 0.25 &&
    !hasInterveningDoor(sProj.wall, sProj.t, eProj.t) &&
    !hasInterveningWindow(sProj.wall, sProj.t, eProj.t, midY)
  ) {
    return null
  }

  const rawStartPt: Vec3 =
    concealed && isStartWall ? [round3(sProj.x), start[1], round3(sProj.z)] : start
  const rawEndPt: Vec3 =
    concealed && isEndWall ? [round3(eProj.x), end[1], round3(eProj.z)] : end

  const startPier = isStartWall ? resolveWallRiserPier(sProj, rawStartPt, cavityY) : null
  const endPier = isEndWall ? resolveWallRiserPier(eProj, rawEndPt, cavityY) : null
  const startPt: Vec3 = startPier ? [startPier.pierX, startPier.jogY, startPier.pierZ] : rawStartPt
  const endPt: Vec3 = endPier ? [endPier.pierX, endPier.jogY, endPier.pierZ] : rawEndPt
  const wrapPier = (pts: Vec3[] | null): Vec3[] | null => {
    if (!pts) return null
    if (!startPier && !endPier) return pts
    const out: Vec3[] = []
    if (startPier) out.push(rawStartPt, [rawStartPt[0], startPier.jogY, rawStartPt[2]])
    out.push(...pts)
    if (endPier) out.push([rawEndPt[0], endPier.jogY, rawEndPt[2]], rawEndPt)
    return simplifyOrthogonalPath(out)
  }

  // VIS-05 + R2-ELC-01: Under a pitched gable or explicit `roof-segment` roof, NEVER climb above
  // `roofYAt(px, pz, roofEnv) - roofMarginM`. Travel inward at `eaveSafeY <= wallH - 0.08` until
  // safely beneath the sloped roof plane before rising to `cavityY`, and reject any attic candidate
  // whose sampled points would protrude through flat/shed/narrow explicit `roof-segment`s.
  if (roofEnv && cavityY > roofEnv.wallH - 0.04) {
    const isPathUnderRoof = (pts: readonly Vec3[]): boolean => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!
        const b = pts[i + 1]!
        if (a[1] <= roofEnv.wallH - 0.04 && b[1] <= roofEnv.wallH - 0.04) continue
        const segLenXZ = Math.hypot(b[0] - a[0], b[2] - a[2])
        const steps = Math.max(4, Math.min(24, Math.ceil(segLenXZ / 0.45)))
        for (let s = 0; s <= steps; s++) {
          const f = s / steps
          const px = a[0] + (b[0] - a[0]) * f
          const py = a[1] + (b[1] - a[1]) * f
          const pz = a[2] + (b[2] - a[2]) * f
          if (py <= roofEnv.wallH - 0.04) continue
          if (py > roofYAt(px, pz, roofEnv) - roofMarginM + 1e-3) return false
        }
      }
      return true
    }

    const directAttic = simplifyOrthogonalPath([
      startPt,
      [round3(startPt[0]), round3(cavityY), round3(startPt[2])],
      [round3(endPt[0]), round3(cavityY), round3(endPt[2])],
      endPt,
    ])
    if (isPathUnderRoof(directAttic)) {
      return wrapPier(directAttic)
    }

    const eaveSafeY = round3(Math.max(0.2, roofEnv.wallH - 0.08))
    const slope = roofEnv.pitchRiseOver12 / 12
    const maxDistFromRidge = roofEnv.halfSpan - (cavityY + roofMarginM - roofEnv.wallH) / slope
    if (maxDistFromRidge <= 0.05) return null
    const uMinSafe = roofEnv.ridgeCenter - maxDistFromRidge
    const uMaxSafe = roofEnv.ridgeCenter + maxDistFromRidge
    const uStart = roofEnv.ridgeAlongX ? startPt[2] : startPt[0]
    const uEnd = roofEnv.ridgeAlongX ? endPt[2] : endPt[0]

    if (roofEnv.explicitSegs && roofEnv.explicitSegs.length > 0) {
      // Sample along the straight 2D line from startPt -> endPt to find the longest contiguous roof-safe interval
      const N = 24
      const safeAtT = (t: number): boolean => {
        const px = startPt[0] + (endPt[0] - startPt[0]) * t
        const pz = startPt[2] + (endPt[2] - startPt[2]) * t
        return cavityY <= roofYAt(px, pz, roofEnv) - roofMarginM + 1e-3
      }
      let bestStart = -1
      let bestEnd = -1
      let curStart = -1
      for (let i = 0; i <= N; i++) {
        const t = i / N
        if (safeAtT(t)) {
          if (curStart < 0) curStart = i
          if (i - curStart > bestEnd - bestStart) {
            bestStart = curStart
            bestEnd = i
          }
        } else {
          curStart = -1
        }
      }
      if (bestStart >= 0 && bestEnd >= bestStart) {
        let tIn = bestStart / N
        let tOut = bestEnd / N
        if (bestStart > 0) {
          let lo = (bestStart - 1) / N
          let hi = tIn
          for (let it = 0; it < 5; it++) {
            const mid = (lo + hi) / 2
            if (safeAtT(mid)) hi = mid
            else lo = mid
          }
          tIn = hi
        }
        if (bestEnd < N) {
          let lo = tOut
          let hi = (bestEnd + 1) / N
          for (let it = 0; it < 5; it++) {
            const mid = (lo + hi) / 2
            if (safeAtT(mid)) lo = mid
            else hi = mid
          }
          tOut = lo
        }
        const entryX = round3(startPt[0] + (endPt[0] - startPt[0]) * tIn)
        const entryZ = round3(startPt[2] + (endPt[2] - startPt[2]) * tIn)
        const exitX = round3(startPt[0] + (endPt[0] - startPt[0]) * tOut)
        const exitZ = round3(startPt[2] + (endPt[2] - startPt[2]) * tOut)
        const pts: Vec3[] = [startPt]
        if (tIn > 1e-3) {
          pts.push([round3(startPt[0]), eaveSafeY, round3(startPt[2])])
        }
        pts.push([entryX, round3(cavityY), entryZ])
        pts.push([exitX, round3(cavityY), exitZ])
        if (tOut < 1 - 1e-3) {
          pts.push([round3(endPt[0]), eaveSafeY, round3(endPt[2])])
        }
        pts.push(endPt)
        const cand = simplifyOrthogonalPath(pts)
        if (isPathUnderRoof(cand)) return wrapPier(cand)
      }

      // Try ridge-tucked fallback shifted inward toward the gable ridge or explicit roof peak
      const uSafe = round3(Math.max(uMinSafe, Math.min(uMaxSafe, (uStart + uEnd) / 2)))
      const ridgeEntryX = roofEnv.ridgeAlongX ? round3(startPt[0]) : uSafe
      const ridgeEntryZ = roofEnv.ridgeAlongX ? uSafe : round3(startPt[2])
      const ridgeExitX = roofEnv.ridgeAlongX ? round3(endPt[0]) : uSafe
      const ridgeExitZ = roofEnv.ridgeAlongX ? uSafe : round3(endPt[2])
      const ridgeCand = simplifyOrthogonalPath([
        startPt,
        [round3(startPt[0]), eaveSafeY, round3(startPt[2])],
        [ridgeEntryX, round3(cavityY), ridgeEntryZ],
        [ridgeExitX, round3(cavityY), ridgeExitZ],
        [round3(endPt[0]), eaveSafeY, round3(endPt[2])],
        endPt,
      ])
      if (isPathUnderRoof(ridgeCand)) return wrapPier(ridgeCand)

      for (const seg of roofEnv.explicitSegs) {
        if (seg.slopeTan <= 0.01) continue
        const highLz = seg.roofType === 'shed' ? -seg.halfD * 0.65 : 0
        const wx = round3(seg.cx + highLz * seg.sinR)
        const wz = round3(seg.cz + highLz * seg.cosR)
        if (cavityY > roofYAt(wx, wz, roofEnv) - roofMarginM + 1e-3) continue
        const segCand = simplifyOrthogonalPath([
          startPt,
          [round3(startPt[0]), eaveSafeY, round3(startPt[2])],
          [wx, round3(cavityY), wz],
          [round3(endPt[0]), eaveSafeY, round3(endPt[2])],
          endPt,
        ])
        if (isPathUnderRoof(segCand)) return wrapPier(segCand)
      }
      return null
    }

    const du = uEnd - uStart
    const overlapsSafeBand =
      Math.abs(du) > 1e-4 &&
      Math.max(uStart, uEnd) >= uMinSafe &&
      Math.min(uStart, uEnd) <= uMaxSafe
    if (overlapsSafeBand) {
      const tA = (uMinSafe - uStart) / du
      const tB = (uMaxSafe - uStart) / du
      const tIn = Math.max(0, Math.min(1, Math.min(tA, tB)))
      const tOut = Math.max(0, Math.min(1, Math.max(tA, tB)))
      const entryX = round3(startPt[0] + (endPt[0] - startPt[0]) * tIn)
      const entryZ = round3(startPt[2] + (endPt[2] - startPt[2]) * tIn)
      const exitX = round3(startPt[0] + (endPt[0] - startPt[0]) * tOut)
      const exitZ = round3(startPt[2] + (endPt[2] - startPt[2]) * tOut)
      const pts: Vec3[] = [startPt]
      if (tIn > 1e-3) {
        // Rise through wall top plate to eaveSafeY, then follow underside of sloped roof rafter to (entryX, cavityY, entryZ)
        pts.push([round3(startPt[0]), eaveSafeY, round3(startPt[2])])
      }
      pts.push([entryX, round3(cavityY), entryZ])
      pts.push([exitX, round3(cavityY), exitZ])
      if (tOut < 1 - 1e-3) {
        pts.push([round3(endPt[0]), eaveSafeY, round3(endPt[2])])
      }
      pts.push(endPt)
      const cand = simplifyOrthogonalPath(pts)
      return isPathUnderRoof(cand) ? wrapPier(cand) : null
    }
    const uSafe = round3(Math.max(uMinSafe, Math.min(uMaxSafe, (uStart + uEnd) / 2)))
    const entryX = roofEnv.ridgeAlongX ? round3(startPt[0]) : uSafe
    const entryZ = roofEnv.ridgeAlongX ? uSafe : round3(startPt[2])
    const exitX = roofEnv.ridgeAlongX ? round3(endPt[0]) : uSafe
    const exitZ = roofEnv.ridgeAlongX ? uSafe : round3(endPt[2])
    const fallbackCand = simplifyOrthogonalPath([
      startPt,
      [round3(startPt[0]), eaveSafeY, round3(startPt[2])],
      [entryX, round3(cavityY), entryZ],
      [exitX, round3(cavityY), exitZ],
      [round3(endPt[0]), eaveSafeY, round3(endPt[2])],
      endPt,
    ])
    return isPathUnderRoof(fallbackCand) ? wrapPier(fallbackCand) : null
  }

  return wrapPier(
    simplifyOrthogonalPath([
      startPt,
      [round3(startPt[0]), round3(cavityY), round3(startPt[2])],
      [round3(endPt[0]), round3(cavityY), round3(endPt[2])],
      endPt,
    ]),
  )
}

type XZBounds = {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

/**
 * Given a single axis-aligned or horizontal-diagonal segment [a, b] that hits obstacle `obs`,
 * generate clean saddle/jog detours (over, under, left, right, plus wider structural column bypasses) around `obs`.
 */
function buildSegmentDetours(
  a: Vec3,
  b: Vec3,
  expanded: Aabb3,
  minY: number,
  maxY: number,
  obs?: TradeObstacle,
  envBounds: XZBounds | null = null,
  isPathInFootprint?: (p: readonly Vec3[]) => boolean,
): Vec3[][] {
  const stepPad = 0.03
  const dx = Math.abs(b[0] - a[0])
  const dy = Math.abs(b[1] - a[1])
  const dz = Math.abs(b[2] - a[2])
  const detours: Vec3[][] = []
  const isWideDetourCandidate = obs !== undefined
  const rawBox = obs?.box ?? expanded
  const obsCenterX = (rawBox.min[0] + rawBox.max[0]) / 2
  const obsCenterZ = (rawBox.min[2] + rawBox.max[2]) / 2
  const halfExtentX = (rawBox.max[0] - rawBox.min[0]) / 2
  const halfExtentZ = (rawBox.max[2] - rawBox.min[2]) / 2
  const wideXPlus = round3(Math.max(expanded.max[0] + stepPad, obsCenterX + halfExtentX + 0.16))
  const wideXMinus = round3(Math.min(expanded.min[0] - stepPad, obsCenterX - (halfExtentX + 0.16)))
  const wideZPlus = round3(Math.max(expanded.max[2] + stepPad, obsCenterZ + halfExtentZ + 0.16))
  const wideZMinus = round3(Math.min(expanded.min[2] - stepPad, obsCenterZ - (halfExtentZ + 0.16)))

  const filterByEnv = (paths: Vec3[][]): Vec3[][] => {
    const simplified = paths.map((d) => simplifyOrthogonalPath(d))
    return simplified.filter((p) => {
      if (envBounds) {
        const insideBox = p.every(
          (pt) =>
            pt[0] >= envBounds.minX &&
            pt[0] <= envBounds.maxX &&
            pt[2] >= envBounds.minZ &&
            pt[2] <= envBounds.maxZ,
        )
        if (!insideBox) return false
      }
      if (isPathInFootprint && !isPathInFootprint(p)) return false
      return true
    })
  }

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
    const xLo = round3(expanded.min[0] - stepPad)
    const xHi = round3(expanded.max[0] + stepPad)
    const zLo = round3(expanded.min[2] - stepPad)
    const zHi = round3(expanded.max[2] + stepPad)
    const corners: Array<[number, number]> = [
      [xLo, zLo],
      [xHi, zLo],
      [xLo, zHi],
      [xHi, zHi],
    ]
    for (const [cx, cz] of corners) {
      detours.push([a, [cx, a[1], cz], b])
    }
    // 2-corner box-bypass paths so diagonal pulls crossing directly through a column/duct/beam center never clip adjacent corners
    const zFirst = a[2] <= b[2] ? zLo : zHi
    const zSecond = a[2] <= b[2] ? zHi : zLo
    const xFirst = a[0] <= b[0] ? xLo : xHi
    const xSecond = a[0] <= b[0] ? xHi : xLo
    for (const xSide of isWideDetourCandidate ? [xHi, xLo, wideXPlus, wideXMinus] : [xHi, xLo]) {
      detours.push([a, [xSide, a[1], zFirst], [xSide, a[1], zSecond], b])
    }
    for (const zSide of isWideDetourCandidate ? [zHi, zLo, wideZPlus, wideZMinus] : [zHi, zLo]) {
      detours.push([a, [xFirst, a[1], zSide], [xSecond, a[1], zSide], b])
    }
    return filterByEnv(detours)
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
    if (isWideDetourCandidate) {
      for (const zLat of [wideZPlus, wideZMinus]) {
        detours.push([a, [xBefore, a[1], a[2]], [xBefore, a[1], zLat], [xAfter, a[1], zLat], [xAfter, b[1], b[2]], b])
        detours.push([a, [a[0], a[1], zLat], [b[0], b[1], zLat], b])
        if (yOver <= maxY) {
          detours.push([a, [xBefore, a[1], a[2]], [xBefore, yOver, zLat], [xAfter, yOver, zLat], [xAfter, b[1], b[2]], b])
        }
        if (yUnder >= minY) {
          detours.push([a, [xBefore, a[1], a[2]], [xBefore, yUnder, zLat], [xAfter, yUnder, zLat], [xAfter, b[1], b[2]], b])
        }
      }
    }
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
    if (isWideDetourCandidate) {
      for (const xLat of [wideXPlus, wideXMinus]) {
        detours.push([a, [a[0], a[1], zBefore], [xLat, a[1], zBefore], [xLat, a[1], zAfter], [b[0], b[1], zAfter], b])
        detours.push([a, [xLat, a[1], a[2]], [xLat, b[1], b[2]], b])
        if (yOver <= maxY) {
          detours.push([a, [a[0], a[1], zBefore], [xLat, yOver, zBefore], [xLat, yOver, zAfter], [b[0], b[1], zAfter], b])
        }
        if (yUnder >= minY) {
          detours.push([a, [a[0], a[1], zBefore], [xLat, yUnder, zBefore], [xLat, yUnder, zAfter], [b[0], b[1], zAfter], b])
        }
      }
    }
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
    if (isWideDetourCandidate) {
      for (const xLat of [wideXPlus, wideXMinus]) {
        detours.push([a, [a[0], yBefore, a[2]], [xLat, yBefore, a[2]], [xLat, yAfter, a[2]], [b[0], yAfter, b[2]], b])
      }
      for (const zLat of [wideZPlus, wideZMinus]) {
        detours.push([a, [a[0], yBefore, a[2]], [a[0], yBefore, zLat], [a[0], yAfter, zLat], [b[0], yAfter, b[2]], b])
      }
    }
  }

  return filterByEnv(detours)
}

/**
 * Apply a small deterministic orthogonal lateral offset (`<= 0.018 m`) to parallel wall/ceiling chase
 * segments without adding extra bends or tilting vertical risers (eliminates coplanar conduit Z-fighting).
 */
function applyLateralLaneOffset(path: readonly Vec3[], offsetM: number): Vec3[] {
  if (path.length < 2 || Math.abs(offsetM) < 1e-4) return [...path]
  const shiftX = new Array<boolean>(path.length).fill(false)
  const shiftZ = new Array<boolean>(path.length).fill(false)

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const dx = Math.abs(b[0] - a[0])
    const dy = Math.abs(b[1] - a[1])
    const dz = Math.abs(b[2] - a[2])
    if (dy < 0.02 && dx < 0.02 && dz > 0.05) {
      shiftX[i] = true
      shiftX[i + 1] = true
    } else if (dy < 0.02 && dz < 0.02 && dx > 0.05) {
      shiftZ[i] = true
      shiftZ[i + 1] = true
    }
  }

  // Propagate X/Z shift along strictly vertical steps/risers (closing the 0.02..0.05m deadband so risers stay plumb)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!
      const b = path[i + 1]!
      if (Math.abs(b[0] - a[0]) < 0.02 && Math.abs(b[2] - a[2]) < 0.02 && Math.abs(b[1] - a[1]) >= 0.015) {
        if (shiftX[i] || shiftX[i + 1]) {
          shiftX[i] = true
          shiftX[i + 1] = true
        }
        if (shiftZ[i] || shiftZ[i + 1]) {
          shiftZ[i] = true
          shiftZ[i + 1] = true
        }
      }
    }
  }

  return path.map((pt, i) => [
    shiftX[i] ? round3(pt[0] + offsetM) : pt[0],
    pt[1],
    shiftZ[i] ? round3(pt[2] + offsetM) : pt[2],
  ])
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
  if (walls) {
    const base = getCachedWallNetworkBase(walls)
    const hasEnclosedFootprint =
      base.boundedFaces.length > 0 || (options.interiorPolygons !== undefined && options.interiorPolygons.length > 0)
    const wallMountTol = 0.14
    const startInside =
      !hasEnclosedFootprint ||
      isPointInsideWallFootprint(
        start[0],
        start[2],
        walls,
        options.interiorPolygons,
        options.outdoorPolygons,
        wallMountTol,
      )
    const endInside =
      !hasEnclosedFootprint ||
      isPointInsideWallFootprint(
        end[0],
        end[2],
        walls,
        options.interiorPolygons,
        options.outdoorPolygons,
        wallMountTol,
      )
    const isGroundedExteriorDrop = end[1] < -0.05 && start[1] >= 0
    // Only split through exterior wall penetration for grounded lower drops (y < -0.05) or genuine
    // outdoor equipment/disconnects (y <= 1.85 outside footprint) — never hijack ceiling luminaires!
    const shouldUseExteriorWallExit =
      startInside && (isGroundedExteriorDrop || (!endInside && end[1] <= 1.85))
    if (shouldUseExteriorWallExit) {
      const eProj = projectPointToWalls(end[0], end[2], walls)
      if (eProj) {
        const leftNx = -eProj.dz
        const leftNz = eProj.dx
        let outSign: 1 | -1 = eProj.signedDist >= 0 ? 1 : -1
        if (Math.abs(eProj.signedDist) < 1e-3 && hasEnclosedFootprint) {
          const probeOff = eProj.wall.thickness / 2 + 0.25
          const posIn = isPointInsideWallFootprint(
            round3(eProj.x) + leftNx * probeOff,
            round3(eProj.z) + leftNz * probeOff,
            walls,
            options.interiorPolygons,
            options.outdoorPolygons,
            0,
          )
          const negIn = isPointInsideWallFootprint(
            round3(eProj.x) - leftNx * probeOff,
            round3(eProj.z) - leftNz * probeOff,
            walls,
            options.interiorPolygons,
            options.outdoorPolygons,
            0,
          )
          if (posIn && !negIn) outSign = -1
          else if (negIn && !posIn) outSign = 1
        }
        const outNx = leftNx * outSign
        const outNz = leftNz * outSign
        const extFaceOff = eProj.wall.thickness / 2 + 0.03
        // If `end` is already mounted flush on the exterior face of this wall, drop straight onto `end`'s XZ
        // to avoid a tiny 2cm U-jog bend at the disconnect box entry!
        const endFlushOnExteriorFace =
          eProj.dist >= eProj.wall.thickness / 2 - 0.01 && eProj.dist <= eProj.wall.thickness / 2 + 0.08

        const fullHeightWalls = walls.filter((w) => w.height >= 1.8)
        const wallCeilingH =
          typeof options.cavities?.levelHeight === 'number' &&
          options.cavities.levelHeight >= 1.8 &&
          options.cavities.levelHeight <= 12
            ? options.cavities.levelHeight
            : fullHeightWalls.length > 0
              ? Math.max(...fullHeightWalls.map((w) => w.height))
              : Math.max(...walls.map((w) => w.height))
        const rawPrefChaseY = options.preferredChaseY ?? 2.55
        const prefChaseY =
          wallCeilingH > 0
            ? round3(
                Math.min(
                  rawPrefChaseY,
                  (options.wallPlacement ?? 'in-wall') === 'in-wall'
                    ? wallCeilingH - 0.06
                    : wallCeilingH + 0.012,
                ),
              )
            : rawPrefChaseY
        const minYOpt = options.minY ?? 0.15
        const racewayOpt: RacewayType = options.racewayType ?? 'nm-b'
        const isFlexOpt = racewayOpt === 'nm-b' || racewayOpt === 'mc'
        const maxBendOpt = options.maxBendDegrees ?? 360
        const clearOpt = options.clearanceM ?? DEFAULT_CLEARANCE_M
        const radOpt = options.conduitRadiusM ?? 0.015

        // Try clean low exterior wall penetration first, plus chase-level & mid-wall exits for obstacle/bend relief
        const penYs: number[] =
          end[1] < minYOpt
            ? Array.from(
                new Set([
                  round3(Math.max(0.3, Math.min(0.45, prefChaseY))),
                  prefChaseY,
                  round3(Math.max(minYOpt, prefChaseY - 0.55)),
                ]),
              )
            : Array.from(
                new Set([
                  round3(Math.min(prefChaseY, Math.max(minYOpt, end[1]))),
                  prefChaseY,
                  round3(Math.max(minYOpt, prefChaseY - 0.55)),
                ]),
              )

        const sProj0 = projectPointToWalls(start[0], start[2], walls)
        const sAnchor: Vec3 =
          (options.wallPlacement ?? 'in-wall') === 'in-wall' &&
          sProj0 &&
          isEndpointWallMounted(start, sProj0)
            ? [round3(sProj0.x), start[1], round3(sProj0.z)]
            : start

        type ExtCandidateResult = {
          path: Vec3[]
          score: number
          indoorRes: ElectricalRouteResult
          clashes: TradeClashFinding[]
          openingHits: number
        }
        const extState: { best: ExtCandidateResult | null } = { best: null }
        const extOpeningPrisms = base.openingPrisms

        const evalWallShift = (tShift: number) => {
          const tClamped = Math.max(0.12, Math.min(eProj.len - 0.12, eProj.t + tShift))
          const wallX = round3(eProj.wall.start[0] + eProj.dx * tClamped)
          const wallZ = round3(eProj.wall.start[1] + eProj.dz * tClamped)
          const wallExtX =
            tShift === 0 && endFlushOnExteriorFace ? round3(end[0]) : round3(wallX + outNx * extFaceOff)
          const wallExtZ =
            tShift === 0 && endFlushOnExteriorFace ? round3(end[2]) : round3(wallZ + outNz * extFaceOff)

          for (const penY of penYs) {
            const indoorTarget: Vec3 = [wallX, penY, wallZ]
            const indoorCandidates: Array<{ path: Vec3[]; res: ElectricalRouteResult }> = []
            const primaryIndoor = routeElectricalRunCore(start, indoorTarget, obstacles, options)
            indoorCandidates.push({ path: primaryIndoor.path, res: primaryIndoor })
            if (!isFlexOpt) {
              const tightIndoor = routeElectricalRunCore(start, indoorTarget, obstacles, {
                ...options,
                maxBendDegrees: Math.max(180, maxBendOpt - 180),
              })
              indoorCandidates.push({ path: tightIndoor.path, res: tightIndoor })
              // Test perpendicular indoor L-elbow approaches across ceiling & mid elevations so rigid conduit
              // enters the exterior wall straight (0° extra bend) and avoids ducts/beams cleanly!
              const chaseTries = Array.from(
                new Set([
                  penY,
                  prefChaseY,
                  round3(Math.max(minYOpt, prefChaseY - 0.35)),
                  round3(Math.max(minYOpt, prefChaseY - 0.7)),
                ]),
              )
              for (const cy of chaseTries) {
                for (const order of ['xz', 'zx'] as const) {
                  const cand = buildManhattanCandidate(sAnchor, indoorTarget, cy, order)
                  let allIn = true
                  for (let i = 0; i < cand.length - 1; i++) {
                    const segA = cand[i]!
                    const segB = cand[i + 1]!
                    if (
                      Math.hypot(segB[0] - segA[0], segB[2] - segA[2]) > 0.03 &&
                      !isSegmentInsideWallFootprint(
                        segA,
                        segB,
                        walls,
                        options.interiorPolygons,
                        options.outdoorPolygons,
                      )
                    ) {
                      allIn = false
                      break
                    }
                  }
                  if (allIn) {
                    indoorCandidates.push({ path: cand, res: primaryIndoor })
                  }
                }
              }
            }
            for (const { path: indoorPath, res: indoorRes } of indoorCandidates) {
              const extTail: Vec3[] = [
                [wallX, penY, wallZ],
                [wallExtX, penY, wallExtZ],
              ]
              const endY = round3(end[1])
              if (Math.abs(endY - penY) > 0.01) {
                extTail.push([wallExtX, endY, wallExtZ])
              }
              if (Math.hypot(end[0] - wallExtX, end[2] - wallExtZ) > 0.02) {
                if (Math.abs(end[0] - wallExtX) > 0.01 && Math.abs(end[2] - wallExtZ) > 0.01) {
                  const elbowA: Vec3 = [end[0], endY, wallExtZ]
                  const elbowB: Vec3 = [wallExtX, endY, end[2]]
                  const aClashes = detectRunTradeClashes(
                    [[wallExtX, endY, wallExtZ], elbowA, end],
                    obstacles,
                    clearOpt,
                    radOpt,
                  ).length
                  const bClashes = detectRunTradeClashes(
                    [[wallExtX, endY, wallExtZ], elbowB, end],
                    obstacles,
                    clearOpt,
                    radOpt,
                  ).length
                  extTail.push(aClashes <= bClashes ? elbowA : elbowB)
                }
                extTail.push(end)
              }
              const combined = simplifyOrthogonalPath([...indoorPath, ...extTail])
              const combinedClashes = detectRunTradeClashes(combined, obstacles, clearOpt, radOpt)
              const combinedOpeningHits = countPathOpeningHits(combined, extOpeningPrisms)
              const { totalBendDegrees } = countPathBendDegrees(combined)
              const bendPenalty =
                totalBendDegrees > maxBendOpt ? (isFlexOpt ? 50 : 400) : totalBendDegrees * 0.004
              // Prefer low penetration (minimal exposed exterior vertical drop) when clash-free & bend-compliant
              const exposedDropPenalty = Math.max(0, penY - Math.max(0.35, endY)) * 0.6
              const score =
                combinedClashes.length * 2000 +
                combinedOpeningHits * 2500 +
                polylineLengthM(combined) +
                bendPenalty +
                exposedDropPenalty +
                Math.abs(tShift) * 0.5
              if (!extState.best || score < extState.best.score) {
                extState.best = {
                  path: combined,
                  score,
                  indoorRes,
                  clashes: combinedClashes,
                  openingHits: combinedOpeningHits,
                }
              }
            }
          }
        }

        evalWallShift(0)
        // If the direct behind-condenser penetration hits a window/door opening, LVL header, plumbing stack,
        // or HVAC duct/plenum, shift cleanly along the same exterior wall to find a 0-clash, 0-opening penetration!
        if (!extState.best || extState.best.clashes.length > 0 || extState.best.openingHits > 0) {
          for (const dt of [0.55, -0.55, 1.1, -1.1, 1.8, -1.8, 2.5, -2.5]) {
            evalWallShift(dt)
            if (
              extState.best &&
              extState.best.clashes.length === 0 &&
              extState.best.openingHits === 0 &&
              extState.best.score < 400
            ) {
              break
            }
          }
        }

        if (extState.best) {
          const bestExtResult = extState.best
          // Never return a clashing outdoor-split path if the direct obstacle-avoiding router finds fewer clashes
          if (bestExtResult.clashes.length > 0 && !isGroundedExteriorDrop) {
            const directFallback = routeElectricalRunCore(start, end, obstacles, options)
            if (directFallback.remainingClashes.length < bestExtResult.clashes.length) {
              return directFallback
            }
          }
          const finalPath = bestExtResult.path
          const routedLengthM = polylineLengthM(finalPath)
          const routedLengthFt = round2(routedLengthM * METERS_TO_FEET)
          const directLengthM = polylineLengthM(
            simplifyOrthogonalPath([start, [start[0], prefChaseY, start[2]], [end[0], prefChaseY, end[2]], end]),
          )
          const detourAddedM = round2(Math.max(0, routedLengthM - directLengthM))
          const { totalBendDegrees, bendCount90, pullBoxIndex } = countPathBendDegrees(finalPath)
          const exceedsMaxBends = totalBendDegrees > maxBendOpt
          const recommendedPullBoxAt =
            exceedsMaxBends && pullBoxIndex !== null ? finalPath[pullBoxIndex] ?? null : null
          return {
            path: finalPath,
            directLengthM,
            routedLengthM,
            routedLengthFt,
            detourAddedM,
            totalBendDegrees,
            bendCount90,
            exceedsMaxBends,
            recommendedPullBoxAt,
            avoidedObstacles: bestExtResult.indoorRes.avoidedObstacles,
            remainingClashes: bestExtResult.clashes,
            routingMode: bestExtResult.indoorRes.routingMode,
            necNotes: bestExtResult.indoorRes.necNotes,
          }
        }
      }
    }
  }
  return routeElectricalRunCore(start, end, obstacles, options)
}

function routeElectricalRunCore(
  start: Vec3,
  end: Vec3,
  obstacles: readonly TradeObstacle[],
  options: RouteElectricalOptions = {},
): ElectricalRouteResult {
  const walls = options.walls && options.walls.length > 0 ? options.walls : null
  const wallPlacement = options.wallPlacement ?? 'in-wall'
  const interiorPolygons = options.interiorPolygons
  const outdoorPolygons = options.outdoorPolygons
  const cavities = options.cavities
  const fullHeightWalls = walls ? walls.filter((w) => w.height >= 1.8) : []
  const wallCeilingH =
    typeof cavities?.levelHeight === 'number' &&
    cavities.levelHeight >= 1.8 &&
    cavities.levelHeight <= 12
      ? cavities.levelHeight
      : fullHeightWalls.length > 0
        ? Math.max(...fullHeightWalls.map((w) => w.height))
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

  const resolvedAtticY =
    cavities?.atticY ?? round3((wallCeilingH > 0 ? wallCeilingH : 2.5) + 0.12)
  const hasUpperFloorAbove = Boolean(cavities?.sources?.includes('upper-floor-joists'))
  const hasTrueRoofAttic = Boolean(
    cavities?.hasAttic &&
      !hasUpperFloorAbove &&
      (cavities.sources === undefined ||
        cavities.sources.length === 0 ||
        cavities.sources.some((s) => s === 'roof' || s === 'attic-zone')),
  )
  const roofEnv =
    walls && wallCeilingH > 0
      ? computeRoofEnvelopeFromWalls(
          walls,
          wallCeilingH,
          cavities?.roofPitchRise ?? 6,
          options.nodes,
          options.levelId,
          cavities?.explicitRoofSegs,
        )
      : null
  const roofMarginM = conduitRadiusM + 0.065
  const ridgeMaxY = roofEnv
    ? round3(
        roofEnv.wallH + roofEnv.halfSpan * (roofEnv.pitchRiseOver12 / 12) - roofMarginM,
      )
    : round3(resolvedAtticY + 0.65)
  const maxCavityY = hasTrueRoofAttic
    ? round3(Math.min(resolvedAtticY + 0.65, ridgeMaxY))
    : round3(resolvedAtticY + 0.16)

  const wallBase = walls ? getCachedWallNetworkBase(walls) : null
  const hasEnclosedFootprint = Boolean(
    wallBase &&
      (wallBase.boundedFaces.length > 0 || (interiorPolygons !== undefined && interiorPolygons.length > 0)),
  )
  const footprintWallTol = wallPlacement === 'surface' ? 0.07 : 0.025
  const maxWallHalfThick = walls ? Math.max(...walls.map((w) => w.thickness / 2), 0.07) : 0.07

  const isPointTrappedInAnyObstacle = (pt: Vec3): boolean =>
    obstacles.some((obs) => {
      const m = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
      return (
        pt[0] >= obs.box.min[0] - m &&
        pt[0] <= obs.box.max[0] + m &&
        pt[1] >= obs.box.min[1] - m &&
        pt[1] <= obs.box.max[1] + m &&
        pt[2] >= obs.box.min[2] - m &&
        pt[2] <= obs.box.max[2] + m
      )
    })

  const sProjAnchor = walls ? projectPointToWalls(start[0], start[2], walls) : null
  const eProjAnchor = walls ? projectPointToWalls(end[0], end[2], walls) : null
  const sAnchorSnapped: Vec3 | null = sProjAnchor ? [round3(sProjAnchor.x), start[1], round3(sProjAnchor.z)] : null
  const eAnchorSnapped: Vec3 | null = eProjAnchor ? [round3(eProjAnchor.x), end[1], round3(eProjAnchor.z)] : null
  const isStartWallAnchor = Boolean(
    sProjAnchor &&
      isEndpointWallMounted(start, sProjAnchor) &&
      !(wallPlacement === 'in-wall' && sAnchorSnapped && !isPointTrappedInAnyObstacle(start) && isPointTrappedInAnyObstacle(sAnchorSnapped)),
  )
  const isEndWallAnchor = Boolean(
    eProjAnchor &&
      isEndpointWallMounted(end, eProjAnchor) &&
      !(wallPlacement === 'in-wall' && eAnchorSnapped && !isPointTrappedInAnyObstacle(end) && isPointTrappedInAnyObstacle(eAnchorSnapped)),
  )
  const startAnchor: Vec3 =
    wallPlacement === 'in-wall' && isStartWallAnchor && sAnchorSnapped ? sAnchorSnapped : start
  const endAnchor: Vec3 =
    wallPlacement === 'in-wall' && isEndWallAnchor && eAnchorSnapped ? eAnchorSnapped : end

  const endpointsInsideWalls =
    roofEnv !== null &&
    startAnchor[0] >= roofEnv.minX - maxWallHalfThick - 0.15 &&
    startAnchor[0] <= roofEnv.maxX + maxWallHalfThick + 0.15 &&
    startAnchor[2] >= roofEnv.minZ - maxWallHalfThick - 0.15 &&
    startAnchor[2] <= roofEnv.maxZ + maxWallHalfThick + 0.15 &&
    endAnchor[0] >= roofEnv.minX - maxWallHalfThick - 0.15 &&
    endAnchor[0] <= roofEnv.maxX + maxWallHalfThick + 0.15 &&
    endAnchor[2] >= roofEnv.minZ - maxWallHalfThick - 0.15 &&
    endAnchor[2] <= roofEnv.maxZ + maxWallHalfThick + 0.15
  const envBounds: XZBounds | null =
    endpointsInsideWalls && roofEnv
      ? {
          minX: round3(roofEnv.minX),
          maxX: round3(roofEnv.maxX),
          minZ: round3(roofEnv.minZ),
          maxZ: round3(roofEnv.maxZ),
        }
      : null

  const pathViolatesRoof = (p: readonly Vec3[]): boolean => {
    if (!hasTrueRoofAttic || !roofEnv) return false
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!
      const b = p[i + 1]!
      if (a[1] <= roofEnv.wallH - 0.04 && b[1] <= roofEnv.wallH - 0.04) continue
      const segLenXZ = Math.hypot(b[0] - a[0], b[2] - a[2])
      const steps = Math.max(4, Math.min(24, Math.ceil(segLenXZ / 0.45)))
      for (let s = 0; s <= steps; s++) {
        const f = s / steps
        const px = a[0] + (b[0] - a[0]) * f
        const py = a[1] + (b[1] - a[1]) * f
        const pz = a[2] + (b[2] - a[2]) * f
        if (py <= roofEnv.wallH - 0.04) continue
        if (
          px < roofEnv.minX - 0.1 ||
          px > roofEnv.maxX + 0.1 ||
          pz < roofEnv.minZ - 0.1 ||
          pz > roofEnv.maxZ + 0.1
        ) {
          continue
        }
        if (py > roofYAt(px, pz, roofEnv) - roofMarginM + 1e-3) {
          return true
        }
      }
    }
    return false
  }

  const pathExceedsWallEnvelope = (p: readonly Vec3[]): boolean => {
    if (!walls || !endpointsInsideWalls) return false
    if (hasEnclosedFootprint) {
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i]!
        const b = p[i + 1]!
        const segLenXZ = Math.hypot(b[0] - a[0], b[2] - a[2])
        if (segLenXZ < 0.03) {
          // Only check non-terminal vertical segments (allow wall-mounted endpoint stubs within wall thickness)
          if (i > 0 && i < p.length - 2) {
            if (!isPointInsideWallFootprint(a[0], a[2], walls, interiorPolygons, outdoorPolygons, footprintWallTol)) {
              return true
            }
          }
          continue
        }
        if (!isSegmentInsideWallFootprint(a, b, walls, interiorPolygons, outdoorPolygons, footprintWallTol)) {
          return true
        }
      }
      return false
    }
    if (!envBounds) return false
    const aabbTol = maxWallHalfThick + footprintWallTol
    for (const pt of p) {
      if (
        pt[0] < envBounds.minX - aabbTol ||
        pt[0] > envBounds.maxX + aabbTol ||
        pt[2] < envBounds.minZ - aabbTol ||
        pt[2] > envBounds.maxZ + aabbTol
      ) {
        return true
      }
    }
    return false
  }

  const isPathInFootprint = (p: readonly Vec3[]): boolean => !pathExceedsWallEnvelope(p)

  const isEndpointTrappedInObstacle = (pt: Vec3, obs: TradeObstacle): boolean => {
    const m = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
    return (
      pt[0] >= obs.box.min[0] - m &&
      pt[0] <= obs.box.max[0] + m &&
      pt[1] >= obs.box.min[1] - m &&
      pt[1] <= obs.box.max[1] + m &&
      pt[2] >= obs.box.min[2] - m &&
      pt[2] <= obs.box.max[2] + m
    )
  }

  const allClashesAtImmovableEndpoint = (clashes: readonly TradeClashFinding[]): boolean => {
    if (clashes.length === 0) return false
    return clashes.every((c) => {
      const obs =
        obstacles.find((o) => o.id === c.obstacleId) ??
        obstacles.find((o) => o.nodeId === c.obstacleNodeId)
      if (!obs) return false
      return isEndpointTrappedInObstacle(start, obs) || isEndpointTrappedInObstacle(end, obs)
    })
  }

  // Baseline route (wall-guided Manhattan when building walls are supplied, else open Manhattan)
  const fallbackXZ = buildManhattanCandidate(startAnchor, endAnchor, preferredChaseY, 'xz')
  const fallbackZX = buildManhattanCandidate(startAnchor, endAnchor, preferredChaseY, 'zx')
  const fallbackXZIn = isPathInFootprint(fallbackXZ)
  const fallbackZXIn = isPathInFootprint(fallbackZX)
  const fallbackManhattan =
    fallbackXZIn && !fallbackZXIn
      ? fallbackXZ
      : fallbackZXIn && !fallbackXZIn
        ? fallbackZX
        : polylineLengthM(fallbackXZ) <= polylineLengthM(fallbackZX)
          ? fallbackXZ
          : fallbackZX
  const baseline =
    (walls
      ? buildWallGuidedManhattanPath(
          start,
          end,
          preferredChaseY,
          walls,
          wallPlacement,
          false,
          interiorPolygons,
          outdoorPolygons,
          isPointTrappedInAnyObstacle,
        )
      : null) ?? fallbackManhattan
  const directLengthM = polylineLengthM(baseline)
  const baselineClashes = detectRunTradeClashes(baseline, obstacles, clearanceM, conduitRadiusM)

  const openingPrisms: readonly WallOpeningPrism[] = wallBase ? wallBase.openingPrisms : []

  // Candidate chase elevations stay in the overhead ceiling/top-plate zone above window/door heads.
  // In concealed ('in-wall') mode, NEVER climb above the wall top plate into empty air; duck inside the stud cavity instead.
  let maxOpeningHeadY = 0
  let minRaisedWindowSillY = Number.POSITIVE_INFINITY
  for (const op of openingPrisms) {
    if (op.yMax > maxOpeningHeadY) maxOpeningHeadY = op.yMax
    if (op.kind === 'window' && op.yMin >= 0.5 && op.yMin < minRaisedWindowSillY) {
      minRaisedWindowSillY = op.yMin
    }
  }
  const aboveOpeningY =
    maxOpeningHeadY > 0 && maxOpeningHeadY + 0.08 <= inWallMaxY
      ? round3(maxOpeningHeadY + 0.08)
      : null
  const topPlateY =
    walls && wallCeilingH > 0 && wallPlacement === 'in-wall'
      ? Math.min(inWallMaxY, round3(wallCeilingH - 0.05))
      : null
  const rawCeilingElevations =
    walls && wallCeilingH > 0 && wallPlacement === 'in-wall'
      ? [
          preferredChaseY,
          ...(topPlateY !== null ? [topPlateY] : []),
          ...(aboveOpeningY !== null ? [aboveOpeningY] : []),
          Math.min(inWallMaxY, round3(preferredChaseY + 0.02)),
          Math.max(minY, round3(preferredChaseY - 0.16)),
          Math.max(minY, round3(preferredChaseY - 0.34)),
        ]
      : [
          preferredChaseY,
          ...(aboveOpeningY !== null ? [aboveOpeningY] : []),
          Math.min(maxY, preferredChaseY + 0.25),
          Math.min(maxY, preferredChaseY + 0.45),
          Math.max(Math.min(preferredChaseY, 2.2), preferredChaseY - 0.25),
        ]
  const underSillElevations: number[] =
    Math.max(start[1], end[1]) <= 0.45 && Number.isFinite(minRaisedWindowSillY)
      ? Array.from(
          new Set([
            round3(Math.max(minY, Math.min(0.32, minRaisedWindowSillY - 0.12))),
            round3(Math.max(minY, Math.min(0.24, minRaisedWindowSillY - 0.16))),
          ]),
        )
      : []
  const rawLowFallbackElevations =
    walls && wallCeilingH > 0 && wallPlacement === 'in-wall'
      ? [
          ...underSillElevations,
          Math.max(minY, round3(preferredChaseY - 0.65)),
          Math.max(minY, round3(preferredChaseY - 1.1)),
        ]
      : [
          ...underSillElevations,
          Math.max(minY, round3(preferredChaseY - 0.65)),
          Math.max(minY, round3(preferredChaseY - 1.05)),
        ]
  const ceilingElevations = Array.from(new Set(rawCeilingElevations))
  const lowFallbackElevations = Array.from(
    new Set(rawLowFallbackElevations.filter((y) => !ceilingElevations.includes(y))),
  )

  const scorePath = (
    p: Vec3[],
  ): { score: number; clashes: TradeClashFinding[]; openingHits: number } => {
    const clashes = detectRunTradeClashes(p, obstacles, clearanceM, conduitRadiusM)
    const openingHits = countPathOpeningHits(p, openingPrisms)
    const len = polylineLengthM(p)
    const { totalBendDegrees } = countPathBendDegrees(p)
    // Strongly prioritize 0 clashes & 0 door/window opening cuts, roof & wall envelope containment,
    // NEC 358.26 (<= 360° bends for conduit), then shorter length.
    const bendPenalty =
      totalBendDegrees > maxBendDegrees ? (isFlexibleCable ? 50 : 400) : totalBendDegrees * 0.004
    const roofPenalty = pathViolatesRoof(p) ? 5000 : 0
    // Strongly prefer staying inside the enclosed wall footprint (800 >> any path length or bend delta),
    // while NEVER preferring a Priority #1 Structural / Opening / Plumbing clash (2000-2500) over a clash-free detour!
    const envPenalty = pathExceedsWallEnvelope(p) ? 800 : 0
    return {
      score: clashes.length * 2000 + openingHits * 2500 + roofPenalty + envPenalty + len + bendPenalty,
      clashes,
      openingHits,
    }
  }

  const resolveDetours = (
    initialPath: Vec3[],
    detourMinY: number,
    detourMaxY: number,
    lockTerminalWallRisers = false,
  ): { path: Vec3[]; score: number; clashes: TradeClashFinding[]; openingHits: number } => {
    let cur = initialPath
    let curEval = scorePath(cur)
    const maxIterations = 8
    for (let iter = 0; iter < maxIterations; iter++) {
      if (curEval.clashes.length === 0 && curEval.openingHits === 0) break

      let segIdx = -1
      let obs: TradeObstacle | undefined
      let hitPrism: WallOpeningPrism | null = null
      if (curEval.clashes.length > 0) {
        const firstClash = curEval.clashes[0]!
        obs =
          obstacles.find((o) => o.id === firstClash.obstacleId) ??
          obstacles.find((o) => o.nodeId === firstClash.obstacleNodeId)
        segIdx = firstClash.segmentIndex
      } else {
        const opHit = findFirstOpeningHit(cur, openingPrisms)
        if (opHit) {
          hitPrism = opHit.prism
          segIdx = opHit.segmentIndex
          obs = {
            id: opHit.prism.id,
            nodeId: opHit.prism.wallId,
            nodeType: 'architectural:opening',
            trade: 'structural',
            priorityRank: 1,
            box: opHit.prism.aabb,
            requiredClearanceM: 0.04,
            label: `${opHit.prism.kind} opening`,
          }
        }
      }
      if (!obs || segIdx < 0) break

      // R6-BUG-04: On attic/crawlspace cavity candidates, never laterally kick the first or last
      // vertical wall-cavity riser out of its stud bay into open room air.
      if (lockTerminalWallRisers && (segIdx === 0 || segIdx === cur.length - 2)) {
        break
      }
      const segA = cur[segIdx]!
      const segB = cur[segIdx + 1]!
      let segDetourMaxY = detourMaxY
      if (hasTrueRoofAttic && roofEnv && segDetourMaxY > roofEnv.wallH - 0.04) {
        const localRoofCap =
          Math.min(
            roofYAt(segA[0], segA[2], roofEnv),
            roofYAt((segA[0] + segB[0]) / 2, (segA[2] + segB[2]) / 2, roofEnv),
            roofYAt(segB[0], segB[2], roofEnv),
          ) - roofMarginM
        segDetourMaxY = Math.min(segDetourMaxY, Math.max(detourMinY, round3(localRoofCap)))
      }
      const margin = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
      const expanded = expandAabb(obs.box, margin)
      const detours = buildSegmentDetours(
        segA,
        segB,
        expanded,
        detourMinY,
        segDetourMaxY,
        obs,
        envBounds,
        walls && endpointsInsideWalls ? isPathInFootprint : undefined,
      )
      // For architectural openings (especially diagonal walls), also try exact over-header, under-sill,
      // and wall-normal interior-room bypasses!
      if (hitPrism) {
        const yOver = round3(hitPrism.yMax + 0.08)
        if (yOver <= segDetourMaxY) {
          detours.push(
            simplifyOrthogonalPath([segA, [segA[0], yOver, segA[2]], [segB[0], yOver, segB[2]], segB]),
          )
        }
        if (hitPrism.kind === 'window' && hitPrism.yMin >= 0.3) {
          const yUnder = round3(hitPrism.yMin - 0.12)
          if (yUnder >= detourMinY) {
            detours.push(
              simplifyOrthogonalPath([segA, [segA[0], yUnder, segA[2]], [segB[0], yUnder, segB[2]], segB]),
            )
          }
        }
        const latOff = hitPrism.halfPerp + 0.14
        for (const sign of [1, -1] as const) {
          const ox = round3(hitPrism.nx * sign * latOff)
          const oz = round3(hitPrism.nz * sign * latOff)
          const latCand = simplifyOrthogonalPath([
            segA,
            [round3(segA[0] + ox), segA[1], round3(segA[2] + oz)],
            [round3(segB[0] + ox), segB[1], round3(segB[2] + oz)],
            segB,
          ])
          if (!walls || !endpointsInsideWalls || isPathInFootprint(latCand)) {
            detours.push(latCand)
          }
        }
      }

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
    return { path: cur, score: curEval.score, clashes: curEval.clashes, openingHits: curEval.openingHits }
  }

  let bestPath: Vec3[] = baseline
  let bestScore = Number.POSITIVE_INFINITY
  let bestMode: RoutingMode = walls ? 'wall-manhattan' : 'open-manhattan'
  let bestNecNotes: string[] = []

  // Step 1: Evaluate Wall-Guided (or Open) Manhattan candidates across overhead ceiling chase elevations first;
  // only try cavity/under-sill/lower fallback elevations if overhead ceiling chases still have clashes or opening cuts.
  const evalElevationList = (elevations: readonly number[], bypassHorizontal = false) => {
    if (walls) {
      for (const y of elevations) {
        const wallCand = buildWallGuidedManhattanPath(
          start,
          end,
          y,
          walls,
          wallPlacement,
          bypassHorizontal,
          interiorPolygons,
          outdoorPolygons,
          isPointTrappedInAnyObstacle,
        )
        const cands: Vec3[][] = wallCand
          ? [wallCand]
          : [
              buildManhattanCandidate(startAnchor, endAnchor, y, 'xz'),
              buildManhattanCandidate(startAnchor, endAnchor, y, 'zx'),
            ]
        for (const candidate of cands) {
          const { score, clashes, openingHits } = scorePath(candidate)
          if (score < bestScore) {
            bestScore = score
            bestPath = candidate
            bestMode = wallCand ? 'wall-manhattan' : 'open-manhattan'
          }
          if (clashes.length === 0 && openingHits === 0 && score < 400 && y === preferredChaseY) return
        }
      }
    } else {
      for (const y of elevations) {
        for (const order of ['xz', 'zx'] as const) {
          const candidate = buildManhattanCandidate(start, end, y, order)
          const { score, clashes, openingHits } = scorePath(candidate)
          if (score < bestScore) {
            bestScore = score
            bestPath = candidate
            bestMode = 'open-manhattan'
          }
          if (clashes.length === 0 && openingHits === 0 && score < 400 && y === preferredChaseY) break
        }
      }
    }
  }
  const crawlAllowedForCable = !(cavities?.crawlSpaceWet === true && racewayType === 'nm-b')
  evalElevationList(ceilingElevations, false)
  // If same-wall horizontal shortcut collided with a plumbing/HVAC riser or opening, retry over chase elevation
  if (bestScore >= 1000 && walls) {
    evalElevationList(ceilingElevations, true)
  }
  // If in-wall chases still hit structural LVL headers above floor-to-ceiling windows, evaluate
  // wall-following Manhattan runs inside the overhead joist/attic cavity or dry crawlspace cavity!
  if (bestScore >= 1000 && walls && cavities) {
    const cavityWallElevs: number[] = []
    if (cavities.hasAttic && (!hasTrueRoofAttic || !roofEnv || maxCavityY > roofEnv.wallH + 0.02)) {
      const atticY = Math.min(resolvedAtticY, maxCavityY)
      cavityWallElevs.push(atticY)
      if (!hasTrueRoofAttic && atticY + 0.12 <= maxCavityY) {
        cavityWallElevs.push(round3(atticY + 0.12))
      }
    }
    if (cavities.hasCrawlSpace && crawlAllowedForCable && start[1] < 1.9 && end[1] < 1.9) {
      cavityWallElevs.push(cavities.crawlSpaceY ?? -0.18)
    }
    if (cavityWallElevs.length > 0) {
      evalElevationList(cavityWallElevs, true)
    }
  }
  if (bestScore >= 1000 && lowFallbackElevations.length > 0) {
    evalElevationList(lowFallbackElevations, true)
  }

  // Step 2: Splice orthogonal saddle/jog detours on the Manhattan candidate if clashes or opening hits remain
  const step2MaxY =
    cavities?.hasAttic && bestPath.some((pt) => pt[1] > inWallMaxY + 0.01) ? maxCavityY : inWallMaxY
  const step2MinY =
    cavities?.hasCrawlSpace && bestPath.some((pt) => pt[1] < minY - 0.01)
      ? Math.min(minY, (cavities.crawlSpaceY ?? -0.18) - 0.4)
      : minY
  const resolvedManhattan = resolveDetours(bestPath, step2MinY, step2MaxY)
  bestPath = resolvedManhattan.path
  bestScore = resolvedManhattan.score
  let currentClashes = resolvedManhattan.clashes
  let currentOpeningHits = resolvedManhattan.openingHits

  const filterXInEnv = (xs: number[]): number[] => {
    const out: number[] = []
    for (const rawX of xs) {
      if (envBounds && (rawX < envBounds.minX || rawX > envBounds.maxX)) {
        // Clamp inset -0.12 m inside exterior wall face rather than bulging outside
        const clamped = round3(Math.max(envBounds.minX + 0.12, Math.min(envBounds.maxX - 0.12, rawX)))
        if (!out.includes(clamped)) out.push(clamped)
        continue
      }
      if (!out.includes(rawX)) out.push(rawX)
    }
    return out
  }
  const filterZInEnv = (zs: number[]): number[] => {
    const out: number[] = []
    for (const rawZ of zs) {
      if (envBounds && (rawZ < envBounds.minZ || rawZ > envBounds.maxZ)) {
        const clamped = round3(Math.max(envBounds.minZ + 0.12, Math.min(envBounds.maxZ - 0.12, rawZ)))
        if (!out.includes(clamped)) out.push(clamped)
        continue
      }
      if (!out.includes(rawZ)) out.push(rawZ)
    }
    return out
  }

  // Step 2a: Explicit lateral box-bypass fallback around ANY clashing higher-priority obstacle
  // (`structural` columns/beams, door/window openings, `plumbing` equipment/stacks/manifolds, or `hvac` equipment/ducts/plenums/terminals)
  if (currentClashes.length > 0 || currentOpeningHits > 0) {
    const clashingTargets: Array<{ id: string; nodeId: string; syntheticObs?: TradeObstacle }> = []
    const seenTargetKeys = new Set<string>()
    let hasMepEquipDuctOrTermClash = false
    for (const c of currentClashes) {
      if (
        c.obstacleNodeType === 'plumbing:equipment' ||
        c.obstacleNodeType === 'plumbing:manifold' ||
        c.obstacleNodeType === 'hvac:equipment' ||
        c.obstacleNodeType === 'hvac-equipment' ||
        c.obstacleNodeType === 'hvac:plenum' ||
        c.obstacleNodeType === 'hvac:duct-run' ||
        c.obstacleNodeType === 'duct-segment' ||
        c.obstacleNodeType === 'hvac:terminal'
      ) {
        hasMepEquipDuctOrTermClash = true
      }
      const k = `${c.obstacleId}::${c.obstacleNodeId}`
      if (clashingTargets.length < 3 && !seenTargetKeys.has(k)) {
        seenTargetKeys.add(k)
        clashingTargets.push({ id: c.obstacleId, nodeId: c.obstacleNodeId })
      }
    }
    if (currentOpeningHits > 0 && clashingTargets.length < 3) {
      const opHit = findFirstOpeningHit(bestPath, openingPrisms)
      if (opHit) {
        clashingTargets.push({
          id: opHit.prism.id,
          nodeId: opHit.prism.wallId,
          syntheticObs: {
            id: opHit.prism.id,
            nodeId: opHit.prism.wallId,
            nodeType: 'architectural:opening',
            trade: 'structural',
            priorityRank: 1,
            box: opHit.prism.aabb,
            requiredClearanceM: 0.04,
            label: `${opHit.prism.kind} opening`,
          },
        })
      }
    }
    const detourBudget = { remaining: 6 }
    const tryBypassCand = (cand: Vec3[], detourMaxYOverride?: number) => {
      const ev = scorePath(cand)
      if (ev.score < bestScore) {
        bestScore = ev.score
        bestPath = cand
        bestMode = 'open-manhattan'
        currentClashes = ev.clashes
        currentOpeningHits = ev.openingHits
      }
      if (
        (ev.clashes.length > 0 || ev.openingHits > 0) &&
        (currentClashes.length > 0 || currentOpeningHits > 0) &&
        detourBudget.remaining > 0 &&
        ev.clashes.length + ev.openingHits <= Math.min(currentClashes.length + currentOpeningHits, 3)
      ) {
        detourBudget.remaining -= 1
        const det = resolveDetours(cand, minY, detourMaxYOverride ?? inWallMaxY)
        if (det.score < bestScore) {
          bestScore = det.score
          bestPath = det.path
          bestMode = 'open-manhattan'
          currentClashes = det.clashes
          currentOpeningHits = det.openingHits
        }
      }
    }
    const soffitLowElevs = hasMepEquipDuctOrTermClash
      ? [
          Math.max(minY, round3(preferredChaseY - 0.55)),
          Math.max(minY, round3(preferredChaseY - 0.95)),
          Math.max(minY, round3(Math.min(start[1], end[1]) - 0.25)),
        ]
      : []
    const candidateYs = Array.from(
      new Set([
        ...(Math.abs(start[1] - end[1]) < 0.25 ? [round3((start[1] + end[1]) / 2)] : []),
        preferredChaseY,
        ...ceilingElevations,
        ...lowFallbackElevations,
        ...soffitLowElevs,
      ]),
    )
    outerBypass: for (const target of clashingTargets) {
      const obs =
        target.syntheticObs ??
        obstacles.find((o) => o.id === target.id) ??
        obstacles.find((o) => o.nodeId === target.nodeId)
      if (!obs) continue
      const margin = Math.max(obs.requiredClearanceM, clearanceM) + conduitRadiusM
      const pad = Math.max(0.16, margin + 0.06)
      const cx = (obs.box.min[0] + obs.box.max[0]) / 2
      const cz = (obs.box.min[2] + obs.box.max[2]) / 2
      const halfX = (obs.box.max[0] - obs.box.min[0]) / 2
      const halfZ = (obs.box.max[2] - obs.box.min[2]) / 2
      const rawXOffs = [round3(cx + halfX + pad), round3(cx - (halfX + pad))]
      const rawZOffs = [round3(cz + halfZ + pad), round3(cz - (halfZ + pad))]
      const xOffs = filterXInEnv(
        walls && hasEnclosedFootprint
          ? rawXOffs.map((rx) =>
              isPointInsideWallFootprint(rx, cz, walls, interiorPolygons, outdoorPolygons, footprintWallTol)
                ? rx
                : clampPointInsetToWallFootprint(rx, cz, walls, 0.12, interiorPolygons, outdoorPolygons)[0],
            )
          : rawXOffs,
      )
      const zOffs = filterZInEnv(
        walls && hasEnclosedFootprint
          ? rawZOffs.map((rz) =>
              isPointInsideWallFootprint(cx, rz, walls, interiorPolygons, outdoorPolygons, footprintWallTol)
                ? rz
                : clampPointInsetToWallFootprint(cx, rz, walls, 0.12, interiorPolygons, outdoorPolygons)[1],
            )
          : rawZOffs,
      )
      for (const y of candidateYs) {
        const yMax = y > inWallMaxY ? Math.min(maxCavityY, round3(y + 0.2)) : inWallMaxY
        for (const xOff of xOffs) {
          tryBypassCand(
            simplifyOrthogonalPath([
              startAnchor,
              [startAnchor[0], y, startAnchor[2]],
              [xOff, y, startAnchor[2]],
              [xOff, y, endAnchor[2]],
              [endAnchor[0], y, endAnchor[2]],
              endAnchor,
            ]),
            yMax,
          )
          if (currentClashes.length === 0 && bestScore < 400) break outerBypass
        }
        for (const zOff of zOffs) {
          tryBypassCand(
            simplifyOrthogonalPath([
              startAnchor,
              [startAnchor[0], y, startAnchor[2]],
              [startAnchor[0], y, zOff],
              [endAnchor[0], y, zOff],
              [endAnchor[0], y, endAnchor[2]],
              endAnchor,
            ]),
            yMax,
          )
          if (currentClashes.length === 0 && bestScore < 400) break outerBypass
        }
      }
    }

    // REAL-ELC-04: If clashes against mechanical equipment, HVAC ducts, or HVAC terminals STILL remain,
    // test open-ceiling / low-chase lateral offsets (+/- 0.6 m, +/- 1.2 m, +/- 1.8 m) inside the building wall envelope.
    if (
      currentClashes.length > 0 &&
      hasMepEquipDuctOrTermClash &&
      !allClashesAtImmovableEndpoint(currentClashes)
    ) {
      const midX = round3((startAnchor[0] + endAnchor[0]) / 2)
      const midZ = round3((startAnchor[2] + endAnchor[2]) / 2)
      const lateralDeltas = [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]
      const xChannels = filterXInEnv(
        Array.from(
          new Set([
            midX,
            ...lateralDeltas.map((d) => round3(midX + d)),
            ...lateralDeltas.map((d) => round3(startAnchor[0] + d)),
            ...lateralDeltas.map((d) => round3(endAnchor[0] + d)),
          ]),
        ),
      )
      const zChannels = filterZInEnv(
        Array.from(
          new Set([
            midZ,
            ...lateralDeltas.map((d) => round3(midZ + d)),
            ...lateralDeltas.map((d) => round3(startAnchor[2] + d)),
            ...lateralDeltas.map((d) => round3(endAnchor[2] + d)),
          ]),
        ),
      )
      const mechElevs = Array.from(
        new Set([
          preferredChaseY,
          ...soffitLowElevs,
          ...lowFallbackElevations,
        ]),
      )
      outerMechLateral: for (const y of mechElevs) {
        const yMax = y > inWallMaxY ? Math.min(maxCavityY, round3(y + 0.2)) : inWallMaxY
        for (const order of ['xz', 'zx'] as const) {
          tryBypassCand(buildManhattanCandidate(startAnchor, endAnchor, y, order), yMax)
          if (currentClashes.length === 0 && bestScore < 400) break outerMechLateral
        }
        for (const sx of xChannels) {
          tryBypassCand(
            simplifyOrthogonalPath([
              startAnchor,
              [startAnchor[0], y, startAnchor[2]],
              [sx, y, startAnchor[2]],
              [sx, y, endAnchor[2]],
              [endAnchor[0], y, endAnchor[2]],
              endAnchor,
            ]),
            yMax,
          )
          if (currentClashes.length === 0 && bestScore < 400) break outerMechLateral
        }
        for (const sz of zChannels) {
          tryBypassCand(
            simplifyOrthogonalPath([
              startAnchor,
              [startAnchor[0], y, startAnchor[2]],
              [startAnchor[0], y, sz],
              [endAnchor[0], y, sz],
              [endAnchor[0], y, endAnchor[2]],
              endAnchor,
            ]),
            yMax,
          )
          if (currentClashes.length === 0 && bestScore < 400) break outerMechLateral
        }
      }
    }
  }

  // Step 2b: Commercial / Rigid Conduit overhead ceiling-plenum Manhattan fallback (NEC 358.26 <= 360° bends)
  // Wall-perimeter walks + U-detours can exceed 360° total bends; direct orthogonal ceiling-plenum EMT (`xz`/`zx`)
  // and offset-axis ceiling channels stay strictly orthogonal with <= 360° bends and avoid wet-wall risers & openings.
  if (walls && !isFlexibleCable && (currentClashes.length > 0 || currentOpeningHits > 0 || bestScore >= 400)) {
    const plenumElevs = [...ceilingElevations, ...lowFallbackElevations]
    const conduitDetourBudget = { remaining: 8 }
    const tryConduitCand = (cand: Vec3[]) => {
      const directEv = scorePath(cand)
      if (directEv.score < bestScore) {
        bestScore = directEv.score
        bestPath = cand
        bestMode = 'open-manhattan'
        currentClashes = directEv.clashes
        currentOpeningHits = directEv.openingHits
      }
      if (
        (directEv.clashes.length > 0 || directEv.openingHits > 0) &&
        (currentClashes.length > 0 || currentOpeningHits > 0) &&
        conduitDetourBudget.remaining > 0 &&
        directEv.clashes.length + directEv.openingHits <= Math.min(currentClashes.length + currentOpeningHits, 3)
      ) {
        conduitDetourBudget.remaining -= 1
        const det = resolveDetours(cand, minY, inWallMaxY)
        if (det.score < bestScore) {
          bestScore = det.score
          bestPath = det.path
          bestMode = 'open-manhattan'
          currentClashes = det.clashes
          currentOpeningHits = det.openingHits
        }
      }
    }
    outerConduit: for (const y of plenumElevs) {
      for (const order of ['xz', 'zx'] as const) {
        tryConduitCand(buildManhattanCandidate(startAnchor, endAnchor, y, order))
        if (currentClashes.length === 0 && bestScore < 400) break outerConduit
      }
      // Offset-axis ceiling plenum paths (4 x 90° = 360° max, cleanly dodging wet-wall risers without U-detours)
      const midX = round3((startAnchor[0] + endAnchor[0]) / 2)
      const midZ = round3((startAnchor[2] + endAnchor[2]) / 2)
      const xChannels = filterXInEnv(
        Array.from(
          new Set([
            round3(startAnchor[0] + 0.45),
            round3(startAnchor[0] - 0.45),
            round3(startAnchor[0] + 0.9),
            round3(startAnchor[0] - 0.9),
            midX,
            round3(endAnchor[0] + 0.9),
            round3(endAnchor[0] - 0.9),
            round3(endAnchor[0] + 1.6),
            round3(endAnchor[0] - 1.6),
          ]),
        ),
      )
      const zChannels = filterZInEnv(
        Array.from(
          new Set([
            round3(startAnchor[2] + 0.45),
            round3(startAnchor[2] - 0.45),
            round3(startAnchor[2] + 0.9),
            round3(startAnchor[2] - 0.9),
            midZ,
            round3(endAnchor[2] + 0.9),
            round3(endAnchor[2] - 0.9),
            round3(endAnchor[2] + 1.6),
            round3(endAnchor[2] - 1.6),
          ]),
        ),
      )
      for (const sx of xChannels) {
        tryConduitCand(
          simplifyOrthogonalPath([
            startAnchor,
            [startAnchor[0], y, startAnchor[2]],
            [sx, y, startAnchor[2]],
            [sx, y, endAnchor[2]],
            [endAnchor[0], y, endAnchor[2]],
            endAnchor,
          ]),
        )
        if (currentClashes.length === 0 && bestScore < 400) break outerConduit
      }
      for (const sz of zChannels) {
        tryConduitCand(
          simplifyOrthogonalPath([
            startAnchor,
            [startAnchor[0], y, startAnchor[2]],
            [startAnchor[0], y, sz],
            [endAnchor[0], y, sz],
            [endAnchor[0], y, endAnchor[2]],
            endAnchor,
          ]),
        )
        if (currentClashes.length === 0 && bestScore < 400) break outerConduit
      }
    }
  }

  // Step 3: Hybrid Manhattan-in-Wall <-> Euclidean-in-Attic / Crawlspace evaluation
  // Only activated when `routingStrategy === 'auto'`, flexible cable (`NM-B` / `MC`, preserving orthogonal
  // `EMT`/`RMC`/`PVC` per NEC 110.12 / 358.30), and an accessible attic or dry crawl space is present!
  const CAVITY_MIN_SAVINGS_M = 0.35
  if (walls && cavities && routingStrategy === 'auto' && isFlexibleCable) {
    let bestHardViolations = currentClashes.length + currentOpeningHits

    // 3a. Wall-Vertical -> Attic Euclidean -> Wall-Vertical (NEC 334.23 / 320.23)
    if (cavities.hasAttic && (!hasTrueRoofAttic || !roofEnv || maxCavityY > roofEnv.wallH + 0.02)) {
      const atticY = Math.min(resolvedAtticY, maxCavityY)
      const activeRoofEnv = hasTrueRoofAttic ? roofEnv : null
      const rawAttic = buildCavityEuclideanPath(
        start,
        end,
        atticY,
        walls,
        wallPlacement,
        bestHardViolations > 0,
        activeRoofEnv,
        roofMarginM,
      )
      if (rawAttic) {
        const rawAtticClashes = detectRunTradeClashes(rawAttic, obstacles, clearanceM, conduitRadiusM)
        let bestAttic = resolveDetours(
          rawAttic,
          Math.max(minY, atticY - 0.1),
          maxCavityY,
          true,
        )

        // REAL-ELC-04 + ELC-R-BUG-01 + VIS-05: When attic-euclidean at base `atticY` clashes
        // with an attic HVAC trunk, try bounded elevated attic planes (capped at `maxCavityY` so
        // `upper-floor-joists` never shoot into Level 2 rooms and roof attics stay strictly below
        // `roofYAt(x, z) - roofMarginM`) AND lateral shifted attic paths inside the building wall envelope.
        if (bestAttic.clashes.length > 0 || (rawAtticClashes.length > 0 && bestAttic.score >= bestScore)) {
          const atticStart = rawAttic[0]!
          const atticEnd = rawAttic[rawAttic.length - 1]!
          const sX = atticStart[0]
          const sZ = atticStart[2]
          const eX = atticEnd[0]
          const eZ = atticEnd[2]
          const runDx = eX - sX
          const runDz = eZ - sZ
          const runLen = Math.hypot(runDx, runDz)
          const perpX = runLen > 1e-4 ? -runDz / runLen : 1
          const perpZ = runLen > 1e-4 ? runDx / runLen : 0
          const midX = (sX + eX) / 2
          const midZ = (sZ + eZ) / 2

          const rawElevated = hasTrueRoofAttic
            ? [round3(atticY + 0.35), round3(atticY + 0.65)]
            : [round3(atticY + 0.12)]
          const elevatedPlanes = Array.from(
            new Set(
              rawElevated
                .map((py) => Math.min(maxCavityY, py))
                .filter((py) => py > atticY + 0.02),
            ),
          )
          for (const planeY of elevatedPlanes) {
            const elevRaw = buildCavityEuclideanPath(
              start,
              end,
              planeY,
              walls,
              wallPlacement,
              bestHardViolations > 0,
              activeRoofEnv,
              roofMarginM,
            )
            if (!elevRaw) continue
            const elevRes = resolveDetours(
              elevRaw,
              Math.max(minY, planeY - 0.1),
              Math.min(maxCavityY, round3(planeY + 0.25)),
              true,
            )
            const elevViol = elevRes.clashes.length + elevRes.openingHits
            const bestAtticViol = bestAttic.clashes.length + bestAttic.openingHits
            if (
              !pathViolatesRoof(elevRes.path) &&
              (elevViol < bestAtticViol ||
                (elevViol === bestAtticViol && elevRes.score < bestAttic.score))
            ) {
              bestAttic = elevRes
            }
            if (bestAttic.clashes.length === 0 && bestAttic.openingHits === 0 && !pathViolatesRoof(bestAttic.path)) {
              break
            }
          }

          if (bestAttic.clashes.length > 0 && !allClashesAtImmovableEndpoint(bestAttic.clashes)) {
            const shiftPlanes = [atticY, ...elevatedPlanes]
            const lateralShifts = [0.8, -0.8, 1.5, -1.5]
            const clampPtToEnvAndRoof = (
              px: number,
              pz: number,
              planeY: number,
            ): [number, number] | null => {
              let cx = round3(px)
              let cz = round3(pz)
              if (envBounds) {
                cx = Math.max(envBounds.minX, Math.min(envBounds.maxX, cx))
                cz = Math.max(envBounds.minZ, Math.min(envBounds.maxZ, cz))
              }
              if (activeRoofEnv && planeY > activeRoofEnv.wallH - 0.04) {
                const slope = activeRoofEnv.pitchRiseOver12 / 12
                const maxDist =
                  activeRoofEnv.halfSpan - (planeY + roofMarginM - activeRoofEnv.wallH) / slope
                if (maxDist <= 0.05) return null
                const uMin = activeRoofEnv.ridgeCenter - maxDist
                const uMax = activeRoofEnv.ridgeCenter + maxDist
                if (activeRoofEnv.ridgeAlongX) {
                  cz = round3(Math.max(uMin, Math.min(uMax, cz)))
                } else {
                  cx = round3(Math.max(uMin, Math.min(uMax, cx)))
                }
                if (planeY > roofYAt(cx, cz, activeRoofEnv) - roofMarginM + 1e-3) {
                  return null
                }
              }
              return [cx, cz]
            }
            const buildRoofSafeShiftedPath = (
              planeY: number,
              midPtsXZ: ReadonlyArray<readonly [number, number]>,
            ): Vec3[] | null => {
              const clampedPts: Array<[number, number]> = []
              for (const [mx, mz] of midPtsXZ) {
                const c = clampPtToEnvAndRoof(mx, mz, planeY)
                if (!c) return null
                clampedPts.push(c)
              }
              const sClamped = clampPtToEnvAndRoof(sX, sZ, planeY)
              const eClamped = clampPtToEnvAndRoof(eX, eZ, planeY)
              if (!sClamped || !eClamped) return null
              const eaveSafeY = activeRoofEnv
                ? round3(Math.max(0.2, activeRoofEnv.wallH - 0.08))
                : planeY
              const needStartEave =
                activeRoofEnv !== null &&
                planeY > activeRoofEnv.wallH - 0.04 &&
                Math.hypot(sClamped[0] - sX, sClamped[1] - sZ) > 0.02
              const needEndEave =
                activeRoofEnv !== null &&
                planeY > activeRoofEnv.wallH - 0.04 &&
                Math.hypot(eClamped[0] - eX, eClamped[1] - eZ) > 0.02
              const pts: Vec3[] = [atticStart]
              if (needStartEave) {
                pts.push([round3(sX), eaveSafeY, round3(sZ)])
              }
              pts.push([sClamped[0], planeY, sClamped[1]])
              for (const [mx, mz] of clampedPts) {
                pts.push([mx, planeY, mz])
              }
              pts.push([eClamped[0], planeY, eClamped[1]])
              if (needEndEave) {
                pts.push([round3(eX), eaveSafeY, round3(eZ)])
              }
              pts.push(atticEnd)
              const simplified = simplifyOrthogonalPath(pts)
              if (activeRoofEnv && pathViolatesRoof(simplified)) return null
              return simplified
            }

            outerAtticShift: for (const planeY of shiftPlanes) {
              for (const shift of lateralShifts) {
                const dogleg = buildRoofSafeShiftedPath(planeY, [
                  [midX + perpX * shift, midZ + perpZ * shift],
                ])
                if (dogleg) {
                  const dogEv = scorePath(dogleg)
                  const dogViol = dogEv.clashes.length + dogEv.openingHits
                  const curViol = bestAttic.clashes.length + bestAttic.openingHits
                  if (
                    dogViol < curViol ||
                    (dogViol === curViol && dogEv.score < bestAttic.score)
                  ) {
                    bestAttic = {
                      path: dogleg,
                      score: dogEv.score,
                      clashes: dogEv.clashes,
                      openingHits: dogEv.openingHits,
                    }
                  }
                  if (bestAttic.clashes.length === 0 && bestAttic.openingHits === 0) break outerAtticShift
                }

                const parallelShift = buildRoofSafeShiftedPath(planeY, [
                  [sX + perpX * shift, sZ + perpZ * shift],
                  [eX + perpX * shift, eZ + perpZ * shift],
                ])
                if (parallelShift) {
                  const parEv = scorePath(parallelShift)
                  const parViol = parEv.clashes.length + parEv.openingHits
                  const curViol = bestAttic.clashes.length + bestAttic.openingHits
                  if (
                    parViol < curViol ||
                    (parViol === curViol && parEv.score < bestAttic.score)
                  ) {
                    bestAttic = {
                      path: parallelShift,
                      score: parEv.score,
                      clashes: parEv.clashes,
                      openingHits: parEv.openingHits,
                    }
                  }
                  if (bestAttic.clashes.length === 0 && bestAttic.openingHits === 0) break outerAtticShift
                }
              }
            }
          }
        }

        const atticEnvelopeSafe =
          !pathViolatesRoof(bestAttic.path) && !pathExceedsWallEnvelope(bestAttic.path)
        const atticHardViol = bestAttic.clashes.length + bestAttic.openingHits
        const resolvesClash = atticEnvelopeSafe && atticHardViol < bestHardViolations
        const strictlyShorter =
          atticEnvelopeSafe &&
          atticHardViol <= bestHardViolations &&
          bestAttic.score + CAVITY_MIN_SAVINGS_M < bestScore
        if (resolvesClash || strictlyShorter) {
          bestPath = bestAttic.path
          bestScore = bestAttic.score
          bestHardViolations = atticHardViol
          currentClashes = bestAttic.clashes
          currentOpeningHits = bestAttic.openingHits
          bestMode = 'attic-euclidean'
          bestNecNotes = [
            'NEC 334.23 / 320.23: Vertical wall-cavity riser through bored top plate into attic Euclidean run; protect cable with guard strips within 6 ft of attic access.',
          ]
        }
      }
    }

    // 3b. Wall-Vertical -> Crawl Space / Unfinished Basement Euclidean -> Wall-Vertical (NEC 334.15(C) / 334.12(B)(4))
    const endpointsNearFloorOrWall = start[1] < 1.9 && end[1] < 1.9
    if (cavities.hasCrawlSpace && crawlAllowedForCable && endpointsNearFloorOrWall) {
      const crawlY = cavities.crawlSpaceY ?? -0.18
      const rawCrawl = buildCavityEuclideanPath(start, end, crawlY, walls, wallPlacement, bestHardViolations > 0)
      if (rawCrawl) {
        const crawlDetour = resolveDetours(rawCrawl, crawlY - 0.45, Math.min(-0.04, crawlY + 0.12), true)
        const crawlEnvelopeSafe = !pathExceedsWallEnvelope(crawlDetour.path)
        const crawlHardViol = crawlDetour.clashes.length + crawlDetour.openingHits
        const resolvesClash = crawlEnvelopeSafe && crawlHardViol < bestHardViolations
        const strictlyShorter =
          crawlEnvelopeSafe &&
          crawlHardViol <= bestHardViolations &&
          crawlDetour.score + CAVITY_MIN_SAVINGS_M < bestScore
        if (resolvesClash || strictlyShorter) {
          bestPath = crawlDetour.path
          bestScore = crawlDetour.score
          bestHardViolations = crawlHardViol
          currentClashes = crawlDetour.clashes
          currentOpeningHits = crawlDetour.openingHits
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

  // Optional small deterministic lateral wall-chase stagger (VIS-02) when zero-clash, zero-opening-hit, and bend-safe
  const rawLateralOff =
    typeof options.laneOffsetLateralM === 'number' && Number.isFinite(options.laneOffsetLateralM)
      ? Math.max(-0.018, Math.min(0.018, options.laneOffsetLateralM))
      : 0
  if (
    Math.abs(rawLateralOff) >= 1e-4 &&
    (bestMode === 'wall-manhattan' || bestMode === 'open-manhattan') &&
    detectRunTradeClashes(bestPath, obstacles, clearanceM, conduitRadiusM).length === 0 &&
    countPathOpeningHits(bestPath, openingPrisms) === 0
  ) {
    const baseBends = countPathBendDegrees(bestPath).totalBendDegrees
    for (const candidateOff of [rawLateralOff, -rawLateralOff]) {
      const shifted = simplifyOrthogonalPath(applyLateralLaneOffset(bestPath, candidateOff))
      if (
        !pathExceedsWallEnvelope(shifted) &&
        detectRunTradeClashes(shifted, obstacles, clearanceM, conduitRadiusM).length === 0 &&
        countPathOpeningHits(shifted, openingPrisms) === 0 &&
        countPathBendDegrees(shifted).totalBendDegrees <= baseBends + 2
      ) {
        bestPath = shifted
        break
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
