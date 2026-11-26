/**
 * Deterministic NEC Minimum Auto-Population & Circuit / Home-Run / Daisy-Chain Wiring Planner.
 * Pure TypeScript (zero React, Three.js, or `@pascal-app/*` imports).
 *
 * Implements minimum NEC layout & circuiting rules from live Pascal geometry (`wall`, `door`,
 * `window`, `stair`, `zone`):
 * - NEC 210.52(A): Habitable wall-perimeter receptacles (<= 6 ft from openings, <= 12 ft spacing)
 * - NEC 210.52(C) & 210.11(C)(1): Kitchen countertop GFCI (<= 4 ft spacing) split across 2x 20A SAB circuits
 * - NEC 210.52(D) & 210.11(C)(3): Dedicated 20A Bathroom GFCI receptacle
 * - NEC 210.52(E) & 210.8(A)(3): Exterior grade-accessible Outdoor WR GFCI near front/back doors & patios
 * - NEC 210.52(F)/(G) & 210.11(C)(2)/(4): Dedicated 20A Laundry, Garage & Basement GFCI circuits
 * - NEC 210.52(H): Hallway receptacle
 * - NEC 210.70(A)(1)/(2): Room luminaires + entry switches, Front-door interior switch + exterior light,
 *   and Stairway 3-way switches (top & bottom) + stairwell light + landing receptacle
 * - NEC 210.8 & 210.12: Hybrid GFCI-outlet / AFCI-breaker or GFCI-breaker protection modes
 * - Automatic Circuit Grouping -> Home Run (Panel -> First Device) -> Outlet-to-Outlet Daisy Chain
 *   (Device 1 -> Device 2 -> ... -> Device N), yielding around Plumbing, HVAC, and Structural obstacles.
 */

import {
  extractBonesFramingContext,
  extractBonesSchematic,
  resolveWallFramingRule,
  snapPanelOffsetToStudBay,
  snapWallOffsetToStud,
} from './framing-interop'
import type { SceneNodeLike } from './load-calc'
import { findNextFreePanelCircuit } from './panel-schedule'
import {
  type Aabb3,
  belongsToLevel,
  extractRoutingCavities,
  extractRoutingWalls,
  extractTradeObstacles,
  getHvacEquipmentBox,
  getPlumbingFixtureBox,
  polylineLengthM,
  resolveLevelHeightM,
  routeElectricalRun,
  type RoutingMode,
  type Vec3,
} from './routing'
import { calculateBoxFill, calculateConduitFill, calculateVoltageDrop, recommendWireGauge } from './sizing'
import {
  type BoxFillGauge,
  type BoxType,
  type ConduitTradeSize,
  METERS_TO_FEET,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  WIRE_GAUGE_ORDER,
  type WireGauge,
  clampToBoxFillGauge,
  clampToBranchWireGauge,
  getVoltageLineToLine,
  getVoltageLineToNeutral,
  getWorkingClearance110_26,
  isThreePhaseSystem,
  isZeroYokeDeviceKind,
} from './tables'

export type ProtectionMode = 'hybrid' | 'gfci-breakers' | 'gfci-receptacles'

export type BonesIngestionMode = 'auto' | 'import-only' | 'ignore'

export type AutoPopulateOptions = {
  levelId?: string | null
  occupancy?: OccupancyType
  protectionMode?: ProtectionMode
  racewayType?: RacewayType
  preferredChaseY?: number
  includeLighting?: boolean
  includeSmokeAlarms?: boolean
  includeWiring?: boolean
  routingStrategy?: 'auto' | 'wall-only'
  /**
   * Controls how persisted `@pascal-app/plugin-bones` nodes (`bones:device` and electrical `bones:service`)
   * are ingested:
   * - `'auto'` (default): import persisted Bones devices & services first (preserving user drags), then fill remaining NEC gaps.
   * - `'import-only'`: import and wire only the persisted Bones schematic without generating additional devices.
   * - `'ignore'`: skip `bones:device` / equipment service import (still honors `bones:framing` stud spacing).
   */
  bonesMode?: BonesIngestionMode
}

export type PlannedDeviceSpec = {
  tempId: string
  name: string
  position: Vec3
  rotation: number
  deviceKind:
    | 'duplex'
    | 'gfci'
    | 'afci'
    | 'weatherproof-gfci'
    | 'dedicated-240v'
    | 'switch-1p'
    | 'switch-3way'
    | 'luminaire'
    | 'smoke-co'
  occupancy: OccupancyType
  circuitGroup: string
  necRef: string
  requiresGfci: boolean
  requiresAfci: boolean
  breakerAmps: number
  poles: 1 | 2 | 3
  loadVa: number
  continuous: boolean
  isMotor?: boolean
  loadCategory?: 'fixed' | 'appliance' | 'motor' | 'hvac-heating' | 'hvac-cooling' | 'heat-pump'
  boxType: BoxType
  wireGauge: WireGauge
  conductorCount: number
  isExterior?: boolean
  bonesSourceId?: string
  bonesDeviceId?: string
  bonesServiceType?: string
  bonesUserMoved?: boolean
  mepSourceNodeId?: string
  panelId: string
  circuitNumber: number
  gfciProtected: boolean
  afciProtected: boolean
}

export type PlannedRunSpec = {
  tempId: string
  name: string
  runKind: 'home-run' | 'daisy-chain'
  panelId: string
  fromNodeId: string
  targetDeviceId: string
  circuitNumber: number
  occupancy: OccupancyType
  racewayType: RacewayType
  tradeSize: ConduitTradeSize
  wireGauge: WireGauge
  currentCarryingCount: number
  totalConductorCount: number
  loadAmps: number
  continuous: boolean
  voltage: number
  phases: 1 | 3
  path: Vec3[]
  avoidedObstaclesCount: number
  routingMode?: RoutingMode
  necNotes?: string[]
  preferredChaseY?: number
  laneOffsetLateralM?: number
  atticY?: number
  crawlSpaceY?: number
  wallPlacement?: 'in-wall' | 'surface'
}

export type AutoPopulatePlan = {
  panelId: string
  createdPanel: {
    id: string
    name: string
    position: Vec3
    rotation: number
    occupancy: OccupancyType
    voltageSystem: VoltageSystem
    busRatingAmps: number
    mainBreakerAmps: number
    spaces: number
  } | null
  devices: PlannedDeviceSpec[]
  runs: PlannedRunSpec[]
  circuitSummary: Array<{
    circuitNumber: number
    groupName: string
    breakerSpec: string
    wireGauge: WireGauge
    deviceCount: number
    homeRunCount: number
    daisyChainCount: number
  }>
  summary: {
    panelCreated: boolean
    devicesPlanned: number
    circuitsCreated: number
    homeRunsPlanned: number
    daisyChainRunsPlanned: number
    obstaclesAvoided: number
    bonesDevicesImported: number
    bonesServicesImported: number
    bonesUserMovedPreserved: number
  }
}

type WallSeg = {
  id: string
  start: [number, number]
  end: [number, number]
  length: number
  dx: number
  dz: number
  nx: number
  nz: number
  yaw: number
  thickness: number
  openings: Array<{ tMin: number; tMax: number; kind: 'door' | 'window'; node: SceneNodeLike }>
}

type ZoneInfo = {
  id: string
  name: string
  category: string
  polygon: [number, number][]
  centroid: [number, number]
  areaM2: number
  widthM: number
  depthM: number
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

function polygonStats(poly: readonly [number, number][]): {
  centroid: [number, number]
  areaM2: number
  widthM: number
  depthM: number
} {
  let area2 = 0
  let cx = 0
  let cz = 0
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i]!
    const [x2, z2] = poly[(i + 1) % poly.length]!
    area2 += x1 * z2 - x2 * z1
    cx += x1
    cz += z1
    if (x1 < minX) minX = x1
    if (x1 > maxX) maxX = x1
    if (z1 < minZ) minZ = z1
    if (z1 > maxZ) maxZ = z1
  }
  const n = Math.max(1, poly.length)
  return {
    centroid: [cx / n, cz / n],
    areaM2: Math.abs(area2) / 2,
    widthM: maxX - minX,
    depthM: maxZ - minZ,
  }
}

function normalizeCategory(zone: SceneNodeLike): string {
  const parts: string[] = []
  if (typeof zone.category === 'string' && zone.category.trim()) {
    parts.push(zone.category.trim())
  }
  if (typeof zone.name === 'string' && zone.name.trim()) {
    parts.push(zone.name.trim())
  }
  return parts.length > 0 ? parts.join(' ').toLowerCase() : 'general'
}

function isOutdoorCategory(cat: string): boolean {
  return /outdoor|patio|deck|porch|balcony|yard|terrace|exterior|rooftop/.test(cat)
}

function isKitchen(cat: string): boolean {
  return /kitchen|pantry/.test(cat)
}

function isBathroom(cat: string): boolean {
  return /bath|restroom|powder|washroom|wc/.test(cat)
}

function isLaundry(cat: string): boolean {
  return /laundry|mudroom/.test(cat)
}

function isGarage(cat: string): boolean {
  return /garage|carport/.test(cat)
}

function isBasementOrUtility(cat: string): boolean {
  return /basement|utility|mechanical|crawl/.test(cat)
}

function isHallway(cat: string): boolean {
  return /hall|corridor|foyer|entry/.test(cat) && !isBathroom(cat) && !/closet|wardrobe/.test(cat)
}

function isBedroom(cat: string): boolean {
  return /bed|sleeping|master|guest|nursery/.test(cat) && !isBathroom(cat) && !/closet|wardrobe/.test(cat)
}

function isPrimaryCommonZone(cat: string): boolean {
  return /living|great|family|foyer|entry|dining/.test(cat)
}

function isHabitableAfci(cat: string): boolean {
  return /bed|living|dining|kitchen|hall|closet|laundry|family|office|study|den|foyer|great/.test(cat)
}

function dist2D(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function dist3D(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function largerGauge(a: WireGauge, b: WireGauge): WireGauge {
  const safeA = clampToBranchWireGauge(a)
  const safeB = clampToBranchWireGauge(b)
  return WIRE_GAUGE_ORDER.indexOf(safeA) >= WIRE_GAUGE_ORDER.indexOf(safeB) ? safeA : safeB
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

type TubBox = { minX: number; maxX: number; minZ: number; maxZ: number }

function extractTubBoxes(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null,
): TubBox[] {
  const tubBoxes: TubBox[] = []
  for (const n of Object.values(nodes)) {
    if (!belongsToLevel(nodes, n, levelId)) continue
    if (n.type === 'plumbing:fixture') {
      const fKind = typeof n.fixtureKind === 'string' ? n.fixtureKind : ''
      const fName = typeof n.name === 'string' ? n.name.toLowerCase() : ''
      if (
        fKind === 'bathtub' ||
        fKind === 'shower' ||
        fKind === 'tub-shower-combo' ||
        (!fKind && /bath.?tub|\btub\b|shower/.test(fName))
      ) {
        const box = getPlumbingFixtureBox(n)
        if (box) {
          tubBoxes.push({ minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2] })
        }
      }
      continue
    }
    if (n.type !== 'item' && n.type !== 'procedural-item') continue
    const asset = n.asset && typeof n.asset === 'object' ? (n.asset as Record<string, unknown>) : null
    const txt = [n.name, n.category, asset?.id, asset?.name, asset?.category]
      .filter((s): s is string => typeof s === 'string')
      .join(' ')
      .toLowerCase()
    if (!/bath.?tub|\btub\b|shower/.test(txt)) continue
    if (!Array.isArray(n.position) || n.position.length < 3) continue
    const [px, , pz] = n.position as number[]
    const dims = Array.isArray(asset?.dimensions)
      ? (asset.dimensions as number[])
      : Array.isArray(n.dimensions)
        ? (n.dimensions as number[])
        : [1.6, 0.6, 0.8]
    const hw = (dims[0] ?? 1.6) / 2
    const hd = (dims[2] ?? 0.8) / 2
    tubBoxes.push({ minX: px! - hw, maxX: px! + hw, minZ: pz! - hd, maxZ: pz! + hd })
  }
  return tubBoxes
}

function minDistToTubBoxes(tubBoxes: readonly TubBox[], x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY
  for (const b of tubBoxes) {
    const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0
    const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0
    const d = Math.hypot(dx, dz)
    if (d < best) best = d
  }
  return best
}

function extractZones(nodes: Readonly<Record<string, SceneNodeLike>>, levelId: string | null): ZoneInfo[] {
  const zones: ZoneInfo[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'zone') continue
    if (levelId && n.parentId && n.parentId !== levelId) continue
    if (!Array.isArray(n.polygon) || n.polygon.length < 3) continue
    const poly = (n.polygon as unknown[])
      .filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    if (poly.length < 3) continue
    const stats = polygonStats(poly)
    zones.push({
      id: n.id,
      name: (typeof n.name === 'string' && n.name) || n.id,
      category: normalizeCategory(n),
      polygon: poly,
      ...stats,
    })
  }
  return zones
}

function extractWalls(nodes: Readonly<Record<string, SceneNodeLike>>, levelId: string | null): WallSeg[] {
  const all = Object.values(nodes)
  const walls: WallSeg[] = []

  for (const n of all) {
    if (n.type !== 'wall') continue
    if (levelId && n.parentId && n.parentId !== levelId) continue
    if (!Array.isArray(n.start) || !Array.isArray(n.end)) continue
    const start: [number, number] = [Number(n.start[0]), Number(n.start[1])]
    const end: [number, number] = [Number(n.end[0]), Number(n.end[1])]
    const len = dist2D(start, end)
    if (len < 0.25) continue

    const dx = (end[0] - start[0]) / len
    const dz = (end[1] - start[1]) / len
    // Left normal in XZ plane
    const nx = -dz
    const nz = dx
    const yaw = Math.atan2(nx, nz)
    const thickness = typeof n.thickness === 'number' ? n.thickness : 0.14

    const openings: WallSeg['openings'] = []
    for (const child of all) {
      if (child.parentId !== n.id) continue
      if (child.type !== 'door' && child.type !== 'window') continue
      const openW = typeof child.width === 'number' ? child.width : 0.9
      let tCenter = len / 2
      if (Array.isArray(child.position) && typeof child.position[0] === 'number') {
        const px = child.position[0] as number
        const pz = typeof child.position[2] === 'number' ? (child.position[2] as number) : 0
        // Handle both wall-local X offset (Pascal default) and world XZ coordinates
        if (Math.abs(pz) < 0.4 && px >= -0.2 && px <= len + 0.2) {
          tCenter = px
        } else {
          tCenter = (px - start[0]) * dx + (pz - start[1]) * dz
        }
      }
      openings.push({
        tMin: Math.max(0, tCenter - openW / 2 - 0.12),
        tMax: Math.min(len, tCenter + openW / 2 + 0.12),
        kind: child.type,
        node: child,
      })
    }
    openings.sort((a, b) => a.tMin - b.tMin)

    walls.push({ id: n.id, start, end, length: len, dx, dz, nx, nz, yaw, thickness, openings })
  }

  return walls
}

function zoneAtPoint(zones: readonly ZoneInfo[], x: number, z: number): ZoneInfo | null {
  for (const zInfo of zones) {
    if (pointInPolygon2D(x, z, zInfo.polygon)) return zInfo
  }
  return null
}

function unbrokenWallSpans(wall: WallSeg, avoidWindows = false): Array<[number, number]> {
  const blocked = wall.openings.filter((o) => o.kind === 'door' || (avoidWindows && o.kind === 'window'))
  const spans: Array<[number, number]> = []
  let cursor = 0
  for (const op of blocked) {
    if (op.tMin > cursor + 0.05) {
      spans.push([cursor, op.tMin])
    }
    cursor = Math.max(cursor, op.tMax)
  }
  if (wall.length > cursor + 0.05) {
    spans.push([cursor, wall.length])
  }
  return spans
}

/**
 * Split unbroken wall spans at interior T-junctions where perpendicular partition walls
 * meet `wall` so multi-room exterior walls (e.g., spanning Bedroom 1 / Bath / Bedroom 2)
 * evaluate each room segment independently and never place boxes on top of a T-junction.
 */
function wallRoomSpans(
  wall: WallSeg,
  allWalls: readonly WallSeg[],
  avoidWindows = false,
): Array<[number, number]> {
  const baseSpans = unbrokenWallSpans(wall, avoidWindows)
  const cuts: number[] = []
  for (const other of allWalls) {
    if (other.id === wall.id) continue
    for (const ep of [other.start, other.end]) {
      const t = (ep[0] - wall.start[0]) * wall.dx + (ep[1] - wall.start[1]) * wall.dz
      if (t <= 0.2 || t >= wall.length - 0.2) continue
      const px = wall.start[0] + wall.dx * t
      const pz = wall.start[1] + wall.dz * t
      if (Math.hypot(ep[0] - px, ep[1] - pz) <= Math.max(0.22, wall.thickness + other.thickness)) {
        cuts.push(t)
      }
    }
  }
  if (cuts.length === 0) return baseSpans
  cuts.sort((a, b) => a - b)
  const out: Array<[number, number]> = []
  for (const [s0, s1] of baseSpans) {
    let cur = s0
    for (const c of cuts) {
      if (c > cur + 0.15 && c < s1 - 0.15) {
        out.push([cur, c - 0.08])
        cur = c + 0.08
      }
    }
    if (s1 > cur + 0.08) out.push([cur, s1])
  }
  return out
}

export function planNecAutoPopulate(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: AutoPopulateOptions = {},
): AutoPopulatePlan {
  const all = Object.values(nodes)
  const levelId =
    options.levelId ??
    all.find((n) => n.type === 'level')?.id ??
    null
  const allPanels = all.filter((n) => n.type === 'electrical:panel')
  const levelPanels = allPanels.filter((n) => belongsToLevel(nodes, n, levelId))
  const existingPanels = levelPanels.length > 0 ? levelPanels : allPanels
  const existingDevices = all.filter(
    (n) => n.type === 'electrical:device' && belongsToLevel(nodes, n, levelId),
  )
  const occupancy: OccupancyType =
    options.occupancy ??
    (existingPanels[0]?.occupancy === 'commercial' ? 'commercial' : 'residential')
  const protectionMode: ProtectionMode = options.protectionMode ?? 'hybrid'
  const racewayType: RacewayType =
    options.racewayType ?? (occupancy === 'commercial' ? 'emt' : 'nm-b')
  const includeLighting = options.includeLighting !== false
  const includeSmokeAlarms = options.includeSmokeAlarms ?? occupancy === 'residential'
  const includeWiring = options.includeWiring !== false
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const ceilingLightY = round3(Math.max(2.1, levelHeight - 0.04))
  const ceilingSmokeY = round3(Math.max(2.1, levelHeight - 0.03))
  const preferredChaseY = options.preferredChaseY ?? 2.55
  const effectiveChaseY = round3(Math.min(preferredChaseY, levelHeight - 0.06))

  const zones = extractZones(nodes, levelId)
  const walls = extractWalls(nodes, levelId)
  const routingWalls = extractRoutingWalls(nodes, levelId)
  const cavities = extractRoutingCavities(nodes, levelId)
  const routingStrategy = options.routingStrategy ?? 'auto'
  const stairs = all.filter(
    (n) => n.type === 'stair' && belongsToLevel(nodes, n, levelId),
  )
  const obstacles = extractTradeObstacles(nodes, levelId)

  // Extract bathtub/shower fixture footprints on this level so auto-populate keeps outlets >= 3 ft (0.95 m) clear (NEC 406.9(C))
  const tubBoxes = extractTubBoxes(nodes, levelId)
  const distToNearestTub = (x: number, z: number): number => minDistToTubBoxes(tubBoxes, x, z)
  const bonesMode: BonesIngestionMode = options.bonesMode ?? 'auto'
  const bonesSchematic = extractBonesSchematic(nodes, levelId)
  const bonesCtx = bonesSchematic.framing

  // 1. Resolve or plan Panelboard (honoring authoritative `bones:service` panel or back-to-back meter/entry
  //    anchor if present, centering cleanly inside a stud bay, and strictly respecting NEC 240.24(D)/(E))
  let panelNode: SceneNodeLike | null = existingPanels[0] ?? null
  let createdPanel: AutoPopulatePlan['createdPanel'] = null
  if (!panelNode) {
    const voltageSystem: VoltageSystem = occupancy === 'commercial' ? '120/208V-3P' : '120/240V-1P'
    let panelPos: Vec3 = [0.5, 1.52, 0.1]
    let panelRot = 0
    let bestPanelScore = -Infinity

    const plumbingPipeObs = obstacles.filter(
      (o) => o.trade === 'plumbing' || o.trade === 'hvac',
    )
    const WORKING_SPACE_OBSTACLE_TYPES = new Set([
      'hvac:equipment',
      'hvac-equipment',
      'hvac:plenum',
      'plumbing:equipment',
      'plumbing:manifold',
      'plumbing:fixture',
      'structural:column',
      'column',
    ])
    const workingSpaceObstructionBoxes: Aabb3[] = obstacles
      .filter((o) => WORKING_SPACE_OBSTACLE_TYPES.has(o.nodeType))
      .map((o) => o.box)
    for (const n of all) {
      if (!belongsToLevel(nodes, n, levelId)) continue
      if (n.type === 'plumbing:fixture') {
        const fixBox = getPlumbingFixtureBox(n)
        if (fixBox) workingSpaceObstructionBoxes.push(fixBox)
        continue
      }
      if (
        n.type !== 'item' &&
        n.type !== 'procedural-item' &&
        n.type !== 'cabinet' &&
        n.type !== 'electrical:transformer'
      ) {
        continue
      }
      if (!Array.isArray(n.position) || n.position.length < 3) continue
      const [ox, oy, oz] = n.position as number[]
      const asset = n.asset && typeof n.asset === 'object' ? (n.asset as Record<string, unknown>) : null
      const explicitDims = Array.isArray(n.dimensions)
        ? (n.dimensions as number[])
        : Array.isArray(asset?.dimensions)
          ? (asset.dimensions as number[])
          : Array.isArray(n.size)
            ? (n.size as number[])
            : null
      const w = explicitDims?.[0] ?? (typeof n.width === 'number' ? n.width : n.type === 'electrical:transformer' ? 0.76 : 0.6)
      const h = explicitDims?.[1] ?? (typeof n.height === 'number' ? n.height : n.type === 'electrical:transformer' ? 0.95 : 0.9)
      const d = explicitDims?.[2] ?? (typeof n.depth === 'number' ? n.depth : n.type === 'electrical:transformer' ? 0.64 : 0.6)
      const rot = typeof n.rotation === 'number' && Number.isFinite(n.rotation) ? n.rotation : 0
      const hw = (w * Math.abs(Math.cos(rot)) + d * Math.abs(Math.sin(rot))) / 2
      const hd = (w * Math.abs(Math.sin(rot)) + d * Math.abs(Math.cos(rot))) / 2
      workingSpaceObstructionBoxes.push({
        min: [ox! - hw, oy!, oz! - hd],
        max: [ox! + hw, oy! + h, oz! + hd],
      })
    }

    const panelW = occupancy === 'commercial' ? 0.51 : 0.38
    const panelD = 0.14
    const panelH = occupancy === 'commercial' ? 1.2 : 0.92
    const clearance110 = getWorkingClearance110_26(voltageSystem, 2)
    const clearW = Math.max(clearance110.widthM, panelW)
    const clearD = clearance110.depthM
    const clearH = Math.max(clearance110.heightM, panelH)

    const hasWorkingSpaceConflict = (cx: number, cy: number, cz: number, rotY: number): boolean => {
      const cos = Math.cos(rotY)
      const sin = Math.sin(rotY)
      const baseY = Math.max(0, cy - 1.52)
      const yMax = baseY + clearH
      const lxMin = -clearW / 2
      const lxMax = clearW / 2
      // Check both panel enclosure depth behind face and full NEC 110.26(A) front working space
      const lzMin = -panelD / 2 - 0.04
      const lzMax = panelD / 2 + 0.02 + clearD

      const prismCorners: [number, number][] = [
        [lxMin, lzMin],
        [lxMax, lzMin],
        [lxMax, lzMax],
        [lxMin, lzMax],
      ]
      let pMinWx = Number.POSITIVE_INFINITY
      let pMaxWx = Number.NEGATIVE_INFINITY
      let pMinWz = Number.POSITIVE_INFINITY
      let pMaxWz = Number.NEGATIVE_INFINITY
      for (const [lx, lz] of prismCorners) {
        const wx = cx + lx * cos + lz * sin
        const wz = cz - lx * sin + lz * cos
        if (wx < pMinWx) pMinWx = wx
        if (wx > pMaxWx) pMaxWx = wx
        if (wz < pMinWz) pMinWz = wz
        if (wz > pMaxWz) pMaxWz = wz
      }

      for (const box of workingSpaceObstructionBoxes) {
        if (box.max[1] < baseY || box.min[1] > yMax) continue
        if (pMaxWx < box.min[0] || pMinWx > box.max[0]) continue
        if (pMaxWz < box.min[2] || pMinWz > box.max[2]) continue
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
          const dx = wx - cx
          const dz = wz - cz
          const lx = dx * cos - dz * sin
          const lz = dx * sin + dz * cos
          if (lx < minLx) minLx = lx
          if (lx > maxLx) maxLx = lx
          if (lz < minLz) minLz = lz
          if (lz > maxLz) maxLz = lz
        }
        if (maxLx < lxMin || minLx > lxMax) continue
        if (maxLz < lzMin || minLz > lzMax) continue
        return true
      }

      // NEC 240.24(F): Keep panels clear of stairway footprints
      for (const stair of stairs) {
        if (!Array.isArray(stair.position) || stair.position.length < 3) continue
        const sx = Number(stair.position[0])
        const sz = Number(stair.position[2])
        const sRot = typeof stair.rotation === 'number' ? stair.rotation : 0
        const sw = typeof stair.width === 'number' ? stair.width : 1.0
        const sLen = typeof stair.length === 'number' ? stair.length : 2.8
        const sc = Math.cos(sRot)
        const ss = Math.sin(sRot)
        const scx = [
          sx - (sw / 2) * sc,
          sx + (sw / 2) * sc,
          sx + (sw / 2) * sc + sLen * ss,
          sx - (sw / 2) * sc + sLen * ss,
        ]
        const scz = [
          sz + (sw / 2) * ss,
          sz - (sw / 2) * ss,
          sz - (sw / 2) * ss + sLen * sc,
          sz + (sw / 2) * ss + sLen * sc,
        ]
        const sMinX = Math.min(...scx) - 0.25
        const sMaxX = Math.max(...scx) + 0.25
        const sMinZ = Math.min(...scz) - 0.25
        const sMaxZ = Math.max(...scz) + 0.25
        if (cx >= sMinX && cx <= sMaxX && cz >= sMinZ && cz <= sMaxZ) return true
      }

      return false
    }

    const hasPlumbingPipeInPanelColumn = (
      cx: number,
      cz: number,
      wallDx: number,
      wallDz: number,
      wallNx: number,
      wallNz: number,
    ): boolean => {
      // NEC 110.26(E)(1)(a): Dedicated electrical space equals panel width (~0.42 m) x depth (~0.18 m)
      // from floor (0) to structural ceiling / 6 ft above panel (including overhead attic HVAC trunks).
      const halfAlong = Math.max(0.26, panelW / 2 + 0.04)
      const halfPerp = 0.16
      const halfX = Math.abs(wallDx) * halfAlong + Math.abs(wallNx) * halfPerp
      const halfZ = Math.abs(wallDz) * halfAlong + Math.abs(wallNz) * halfPerp
      for (const obs of plumbingPipeObs) {
        const b = obs.box
        if (b.max[1] < 0 || b.min[1] > Math.max(levelHeight + 0.65, 3.6)) continue
        if (b.max[0] < cx - halfX || b.min[0] > cx + halfX) continue
        if (b.max[2] < cz - halfZ || b.min[2] > cz + halfZ) continue
        return true
      }
      return false
    }

    // 1a. Honor an explicit `bones:service` (`serviceType: 'panel'`), or back-to-back `electric-meter` / `power-entry`
    const panelAnchor =
      bonesCtx.servicePanel ??
      bonesSchematic.services.find(
        (s) => s.serviceType === 'electric-meter' || s.serviceType === 'power-entry',
      ) ??
      null
    if (panelAnchor) {
      const sp = panelAnchor
      const hostWall = sp.wallId ? walls.find((w) => w.id === sp.wallId) : undefined
      if (hostWall && typeof sp.wallT === 'number') {
        const baseRawT = Math.max(0.25, Math.min(hostWall.length - 0.25, sp.wallT * hostWall.length))
        const spans = wallRoomSpans(hostWall, walls, true)
        const candY = round3(sp.heightAff ?? 1.52)
        for (const shift of [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65]) {
          const rawT = baseRawT + shift
          if (rawT < 0.25 || rawT > hostWall.length - 0.25) continue
          const enclosing = spans.find(([a, b]) => rawT >= a && rawT <= b)
          if (!enclosing && shift !== 0) continue
          const spanBounds = enclosing ?? [0, hostWall.length]
          const bayT = snapPanelOffsetToStudBay(hostWall.length, rawT, {
            spanMin: spanBounds[0],
            spanMax: spanBounds[1],
            rule: resolveWallFramingRule(bonesCtx, hostWall.id),
          })
          const px = hostWall.start[0] + hostWall.dx * bayT
          const pz = hostWall.start[1] + hostWall.dz * bayT
          let foundCleanAnchor = false
          for (const side of [1, -1] as const) {
            const nx = hostWall.nx * side
            const nz = hostWall.nz * side
            const zProbe = zoneAtPoint(zones, px + nx * 0.45, pz + nz * 0.45)
            if (!zProbe) continue
            if (isBathroom(zProbe.category) || /closet|wardrobe/.test(zProbe.category) || isOutdoorCategory(zProbe.category)) {
              continue
            }
            const candX = round3(px + nx * (hostWall.thickness / 2 + 0.072))
            const candZ = round3(pz + nz * (hostWall.thickness / 2 + 0.072))
            const candRot = side === 1 ? hostWall.yaw : hostWall.yaw + Math.PI
            const pipeConflict = hasPlumbingPipeInPanelColumn(candX, candZ, hostWall.dx, hostWall.dz, nx, nz)
            const wsConflict = hasWorkingSpaceConflict(candX, candY, candZ, candRot)
            const candScore =
              500 -
              Math.abs(shift) * 5 -
              (wsConflict ? 450 : 0) -
              (pipeConflict ? 250 : 0)
            if (candScore > bestPanelScore) {
              bestPanelScore = candScore
              panelPos = [candX, candY, candZ]
              panelRot = candRot
            }
            if (!pipeConflict && !wsConflict) {
              foundCleanAnchor = true
              break
            }
          }
          if (foundCleanAnchor) break
        }
      } else if (sp.position && bonesCtx.servicePanel) {
        bestPanelScore = 500
        panelPos = [round3(sp.position[0]), round3(sp.position[1] || 1.52), round3(sp.position[2])]
        panelRot = 0
      }
    }

    if (bestPanelScore < 450) {
      for (const w of walls) {
        const wRule = resolveWallFramingRule(bonesCtx, w.id)
        const wSpans = wallRoomSpans(w, walls, true)
        const candidateTs: Array<{ t: number; span: [number, number] }> = []
        for (const frac of [0.5, 0.25, 0.75]) {
          const rawT = w.length * frac
          const enclosing = wSpans.find(([a, b]) => rawT >= a && rawT <= b) ?? [0, w.length]
          candidateTs.push({ t: rawT, span: enclosing })
        }
        for (const span of wSpans) {
          const spanLen = span[1] - span[0]
          if (spanLen < 0.45) continue
          for (const frac of [0.5, 0.25, 0.75, 0.15, 0.85]) {
            candidateTs.push({ t: span[0] + spanLen * frac, span })
          }
        }
        const triedBayTs = new Set<number>()
        for (const { t: rawT, span } of candidateTs) {
          const bayT = snapPanelOffsetToStudBay(w.length, rawT, {
            spanMin: span[0],
            spanMax: span[1],
            rule: wRule,
          })
          const keyT = Math.round(bayT * 20)
          if (triedBayTs.has(keyT)) continue
          triedBayTs.add(keyT)
          const px = w.start[0] + w.dx * bayT
          const pz = w.start[1] + w.dz * bayT
          for (const side of [1, -1] as const) {
            const nx = w.nx * side
            const nz = w.nz * side
            const probeX = px + nx * 0.45
            const probeZ = pz + nz * 0.45
            const zProbe = zoneAtPoint(zones, probeX, probeZ)
            if (!zProbe) continue
            const cat = zProbe.category
            if (isBathroom(cat) || /closet|wardrobe/.test(cat) || isOutdoorCategory(cat)) continue
            const candX = round3(px + nx * (w.thickness / 2 + 0.072))
            const candZ = round3(pz + nz * (w.thickness / 2 + 0.072))
            const candRot = side === 1 ? w.yaw : w.yaw + Math.PI
            const pipeConflict = hasPlumbingPipeInPanelColumn(candX, candZ, w.dx, w.dz, nx, nz)
            const wsConflict = hasWorkingSpaceConflict(candX, 1.52, candZ, candRot)
            const baseScore =
              isGarage(cat) || isBasementOrUtility(cat)
                ? 100
                : isHallway(cat)
                  ? 80
                  : /living|family|dining|bed|office|study|den/.test(cat)
                    ? 65
                    : 40
            const score = baseScore - (wsConflict ? 400 : 0) - (pipeConflict ? 200 : 0)
            if (score > bestPanelScore) {
              bestPanelScore = score
              panelPos = [candX, 1.52, candZ]
              panelRot = candRot
            }
          }
        }
      }
    }
    if (bestPanelScore === -Infinity && walls[0]) {
      const w = walls[0]
      const mx = (w.start[0] + w.end[0]) / 2
      const mz = (w.start[1] + w.end[1]) / 2
      panelPos = [round3(mx + w.nx * (w.thickness / 2 + 0.08)), 1.52, round3(mz + w.nz * (w.thickness / 2 + 0.08))]
      panelRot = w.yaw
    }

    const panelId = 'elecpanel_auto_1'
    createdPanel = {
      id: panelId,
      name: occupancy === 'commercial' ? 'LP-1' : 'MDP-1',
      position: panelPos,
      rotation: panelRot,
      occupancy,
      voltageSystem,
      busRatingAmps: occupancy === 'commercial' ? 400 : 200,
      mainBreakerAmps: occupancy === 'commercial' ? 400 : 200,
      spaces: occupancy === 'commercial' ? 42 : 40,
    }
    panelNode = {
      type: 'electrical:panel',
      ...createdPanel,
      height: occupancy === 'commercial' ? 1.2 : 0.92,
    }
  }

  const panelVoltageSystem: VoltageSystem =
    panelNode.voltageSystem === '120/208V-3P' || panelNode.voltageSystem === '277/480V-3P'
      ? panelNode.voltageSystem
      : '120/240V-1P'
  const panelPos: Vec3 = Array.isArray(panelNode.position)
    ? [Number(panelNode.position[0]), Number(panelNode.position[1]), Number(panelNode.position[2])]
    : [0, 1.52, 0]
  const panelHeight = typeof panelNode.height === 'number' ? panelNode.height : 0.92

  // Helper to avoid stacking duplicate devices on top of existing or already-planned points
  const planned: Array<Omit<PlannedDeviceSpec, 'panelId' | 'circuitNumber' | 'gfciProtected' | 'afciProtected' | 'conductorCount'>> = []
  let devSeq = 1

  const isNearExisting = (pos: Vec3, rotation: number, minDist = 0.45): boolean => {
    for (const d of existingDevices) {
      if (Array.isArray(d.position)) {
        const ep: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
        const eRot = typeof d.rotation === 'number' ? d.rotation : 0
        if (dist3D(ep, pos) < minDist && Math.cos(eRot - rotation) > 0.25) return true
      }
    }
    for (const p of planned) {
      if (dist3D(p.position, pos) < minDist && Math.cos(p.rotation - rotation) > 0.25) return true
    }
    return false
  }

  const addPlanned = (
    spec: Omit<
      PlannedDeviceSpec,
      | 'tempId'
      | 'panelId'
      | 'circuitNumber'
      | 'gfciProtected'
      | 'afciProtected'
      | 'conductorCount'
      | 'occupancy'
      | 'poles'
      | 'continuous'
    > & { poles?: 1 | 2 | 3; continuous?: boolean },
  ): boolean => {
    if (
      isNearExisting(
        spec.position,
        spec.rotation,
        spec.deviceKind === 'switch-1p' || spec.deviceKind === 'switch-3way' ? 0.3 : 0.48,
      )
    ) {
      return false
    }
    const resolved = { ...spec }
    const hitsTradeObstacle = (
      px: number,
      py: number,
      pz: number,
      padXZ = 0.24,
      padY = 0.28,
      onlyEquipment = false,
    ): boolean => {
      for (const obs of obstacles) {
        if (
          onlyEquipment &&
          obs.nodeType !== 'hvac:equipment' &&
          obs.nodeType !== 'hvac-equipment' &&
          obs.nodeType !== 'hvac:plenum' &&
          obs.nodeType !== 'plumbing:equipment' &&
          obs.nodeType !== 'plumbing:manifold' &&
          obs.nodeType !== 'structural:column' &&
          obs.nodeType !== 'column'
        ) {
          continue
        }
        const b = obs.box
        const pad = Math.max(padXZ, obs.requiredClearanceM + 0.08)
        if (
          px >= b.min[0] - pad &&
          px <= b.max[0] + pad &&
          pz >= b.min[2] - pad &&
          pz <= b.max[2] + pad &&
          py >= b.min[1] - padY &&
          py <= b.max[1] + padY
        ) {
          return true
        }
      }
      return false
    }
    // Keep non-MEP wall outlets/switches out from behind HVAC/Plumbing equipment or inside wall-embedded structural columns
    if (
      !resolved.mepSourceNodeId &&
      !resolved.bonesSourceId &&
      (resolved.deviceKind === 'duplex' ||
        resolved.deviceKind === 'gfci' ||
        resolved.deviceKind === 'afci' ||
        resolved.deviceKind === 'weatherproof-gfci' ||
        resolved.deviceKind === 'switch-1p' ||
        resolved.deviceKind === 'switch-3way') &&
      hitsTradeObstacle(resolved.position[0], resolved.position[1], resolved.position[2], 0.22, 0.25, true)
    ) {
      const hostW = walls.find((w) => {
        const dx = resolved.position[0] - w.start[0]
        const dz = resolved.position[2] - w.start[1]
        const along = dx * w.dx + dz * w.dz
        const perp = Math.abs(dx * w.nx + dz * w.nz)
        return along >= -0.2 && along <= w.length + 0.2 && perp <= w.thickness / 2 + 0.25
      })
      if (hostW) {
        const curAlong = (resolved.position[0] - hostW.start[0]) * hostW.dx + (resolved.position[2] - hostW.start[1]) * hostW.dz
        for (const shift of [0.45, -0.45, 0.75, -0.75, 1.15, -1.15, 1.55, -1.55]) {
          const na = curAlong + shift
          if (na < 0.28 || na > hostW.length - 0.28) continue
          const hitsOpening = hostW.openings.some((o) => o.kind === 'door' && na > o.tMin && na < o.tMax)
          if (hitsOpening) continue
          const nx = round3(resolved.position[0] + hostW.dx * shift)
          const nz = round3(resolved.position[2] + hostW.dz * shift)
          if (
            !hitsTradeObstacle(nx, resolved.position[1], nz, 0.22, 0.25, true) &&
            !isNearExisting([nx, resolved.position[1], nz], resolved.rotation, 0.35)
          ) {
            resolved.position = [nx, resolved.position[1], nz]
            break
          }
        }
      }
    }
    const isRecept =
      resolved.deviceKind === 'duplex' ||
      resolved.deviceKind === 'gfci' ||
      resolved.deviceKind === 'afci'
    if (isRecept && !resolved.isExterior && !resolved.bonesSourceId && !resolved.mepSourceNodeId) {
      const actualZone = zoneAtPoint(zones, resolved.position[0], resolved.position[2])
      if (actualZone && isKitchen(actualZone.category)) {
        resolved.requiresGfci = true
        resolved.breakerAmps = 20
        resolved.wireGauge = '12'
        resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
        if (protectionMode === 'gfci-receptacles') resolved.deviceKind = 'gfci'
        if (!resolved.circuitGroup.startsWith('Kitchen SAB')) {
          resolved.circuitGroup = 'Kitchen SAB-1 (20A)'
        }
      } else if (actualZone && isBathroom(actualZone.category)) {
        resolved.requiresGfci = true
        resolved.requiresAfci = false
        resolved.breakerAmps = 20
        resolved.wireGauge = '12'
        resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
        if (protectionMode === 'gfci-receptacles') resolved.deviceKind = 'gfci'
        resolved.circuitGroup = 'Bathroom GFCI (20A)'
      } else if (actualZone && resolved.circuitGroup.startsWith('Kitchen SAB')) {
        const isGar = isGarage(actualZone.category)
        const isLaun = isLaundry(actualZone.category)
        const isBsmt = isBasementOrUtility(actualZone.category)
        const isOut = isOutdoorCategory(actualZone.category)
        const wet = isGar || isLaun || isBsmt || isOut
        if (wet) {
          resolved.circuitGroup = isGar
            ? 'Garage GFCI (20A)'
            : isLaun
              ? 'Laundry GFCI (20A)'
              : isBsmt
                ? 'Basement/Utility GFCI (20A)'
                : 'Exterior GFCI (20A)'
          resolved.requiresGfci = true
          resolved.breakerAmps = 20
          resolved.wireGauge = '12'
          resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
          if (protectionMode === 'gfci-receptacles') resolved.deviceKind = 'gfci'
        } else {
          resolved.circuitGroup = 'General Receptacles'
          resolved.requiresGfci = false
          resolved.deviceKind = 'duplex'
          resolved.breakerAmps = occupancy === 'commercial' ? 20 : 15
          resolved.wireGauge = occupancy === 'commercial' ? '12' : '14'
          resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard'
        }
      } else if (
        actualZone &&
        (isGarage(actualZone.category) ||
          isLaundry(actualZone.category) ||
          isBasementOrUtility(actualZone.category) ||
          isOutdoorCategory(actualZone.category))
      ) {
        resolved.requiresGfci = true
        if (protectionMode === 'gfci-receptacles') resolved.deviceKind = 'gfci'
        if (resolved.circuitGroup === 'General Receptacles') {
          const isGar = isGarage(actualZone.category)
          const isLaun = isLaundry(actualZone.category)
          const isBsmt = isBasementOrUtility(actualZone.category)
          resolved.circuitGroup = isGar
            ? 'Garage GFCI (20A)'
            : isLaun
              ? 'Laundry GFCI (20A)'
              : isBsmt
                ? 'Basement/Utility GFCI (20A)'
                : 'Exterior GFCI (20A)'
          resolved.breakerAmps = 20
          resolved.wireGauge = '12'
          resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
        }
      }
    }
    planned.push({
      tempId: `auto_dev_${devSeq++}`,
      occupancy,
      ...resolved,
      poles: resolved.poles ?? 1,
      continuous: resolved.continuous ?? (resolved.deviceKind === 'luminaire' && occupancy === 'commercial'),
    })
    return true
  }

  // Helper: snap any room-level wall-mounted device (Switch, Bathroom Vanity GFCI, Hallway Outlet, Outdoor WR GFCI)
  // flush onto an actual bordering Pascal wall face (zero floating devices in mid-air!)
  const WALL_DEVICE_OFFSET_M = 0.008
  const snapToZoneWall = (
    z: ZoneInfo,
    opts: {
      mountY: number
      preferNearDoor?: boolean
      preferExterior?: boolean
      minTubDistM?: number
      avoidWindows?: boolean
    },
  ): { position: Vec3; rotation: number } => {
    const avoidWin = opts.avoidWindows ?? opts.mountY >= 0.95
    const minTub = opts.minTubDistM ?? 0
    const isWallSpotClearOfEquipment = (wx: number, wy: number, wz: number): boolean => {
      for (const obs of obstacles) {
        if (
          obs.nodeType !== 'hvac:equipment' &&
          obs.nodeType !== 'hvac-equipment' &&
          obs.nodeType !== 'hvac:plenum' &&
          obs.nodeType !== 'plumbing:equipment' &&
          obs.nodeType !== 'plumbing:manifold' &&
          obs.nodeType !== 'structural:column' &&
          obs.nodeType !== 'column'
        ) {
          continue
        }
        const b = obs.box
        const pad = Math.max(0.24, obs.requiredClearanceM + 0.08)
        if (
          wx >= b.min[0] - pad &&
          wx <= b.max[0] + pad &&
          wz >= b.min[2] - pad &&
          wz <= b.max[2] + pad &&
          wy >= b.min[1] - 0.28 &&
          wy <= b.max[1] + 0.28
        ) {
          return false
        }
      }
      return true
    }

    // Pass 1: For room entry switches, snap flush beside a door jamb opening into this room
    if (opts.preferNearDoor) {
      let bestDoorSpot: { pos: Vec3; rot: number; score: number } | null = null
      for (const wall of walls) {
        const faceOff = wall.thickness / 2 + WALL_DEVICE_OFFSET_M
        const probeOff = wall.thickness / 2 + 0.32
        for (const op of wall.openings) {
          if (op.kind !== 'door') continue
          const doorMidT = (op.tMin + op.tMax) / 2
          const dmx = wall.start[0] + wall.dx * doorMidT
          const dmz = wall.start[1] + wall.dz * doorMidT
          for (const sign of [1, -1] as const) {
            const pZone = zoneAtPoint(zones, dmx + wall.nx * sign * probeOff, dmz + wall.nz * sign * probeOff)
            if (pZone?.id !== z.id) continue
            const candidateTs = [op.tMax + 0.2, op.tMin - 0.2, op.tMax + 0.55, op.tMin - 0.55]
            for (const rawT of candidateTs) {
              if (rawT < 0.16 || rawT > wall.length - 0.16) continue
              // Skip if inside another opening on this wall
              const hitsOpening = wall.openings.some(
                (o) => (o.kind === 'door' || avoidWin) && rawT > o.tMin - 0.04 && rawT < o.tMax + 0.04,
              )
              if (hitsOpening) continue
              const wx = round3(wall.start[0] + wall.dx * rawT + wall.nx * sign * faceOff)
              const wz = round3(wall.start[1] + wall.dz * rawT + wall.nz * sign * faceOff)
              if (minTub > 0 && distToNearestTub(wx, wz) < minTub) continue
              const rot = sign === 1 ? wall.yaw : wall.yaw + Math.PI
              const pos: Vec3 = [wx, opts.mountY, wz]
              const clearOfExisting = !isNearExisting(pos, rot, 0.32)
              const clearOfEquip = isWallSpotClearOfEquipment(wx, opts.mountY, wz)
              const score = (clearOfEquip ? 250 : 0) + (clearOfExisting ? 100 : 0) - Math.abs(rawT - doorMidT)
              if (!bestDoorSpot || score > bestDoorSpot.score) {
                bestDoorSpot = { pos, rot, score }
              }
            }
          }
        }
      }
      if (bestDoorSpot && bestDoorSpot.score >= 50) {
        return { position: bestDoorSpot.pos, rotation: bestDoorSpot.rot }
      }
    }

    // Pass 2: Sample unbroken wall spans bordering this zone (flush on wall face, avoiding openings & tubs)
    let bestWallSpot: { pos: Vec3; rot: number; score: number } | null = null
    for (const wall of walls) {
      const faceOff = wall.thickness / 2 + WALL_DEVICE_OFFSET_M
      const probeOff = wall.thickness / 2 + 0.3
      const spans = wallRoomSpans(wall, walls, avoidWin)
      for (const [s0, s1] of spans) {
        const spanLen = s1 - s0
        if (spanLen < 0.28) continue
        for (const frac of [0.5, 0.25, 0.75, 0.15, 0.85]) {
          const rawT = s0 + spanLen * frac
          const t = snapWallOffsetToStud(wall.length, rawT, {
            spanMin: s0,
            spanMax: s1,
            rule: resolveWallFramingRule(bonesCtx, wall.id),
          }).offsetM
          const cxW = wall.start[0] + wall.dx * t
          const czW = wall.start[1] + wall.dz * t
          for (const sign of [1, -1] as const) {
            const pZone = zoneAtPoint(zones, cxW + wall.nx * sign * probeOff, czW + wall.nz * sign * probeOff)
            const oppZone = zoneAtPoint(zones, cxW - wall.nx * sign * probeOff, czW - wall.nz * sign * probeOff)
            const matchesZone = pZone?.id === z.id
            const matchesExteriorAdjacent =
              opts.preferExterior &&
              (pZone === null || isOutdoorCategory(pZone.category)) &&
              oppZone !== null &&
              !isOutdoorCategory(oppZone.category)
            if (!matchesZone && !matchesExteriorAdjacent) continue

            const wx = round3(cxW + wall.nx * sign * faceOff)
            const wz = round3(czW + wall.nz * sign * faceOff)
            const tubDist = distToNearestTub(wx, wz)
            if (minTub > 0 && tubDist < minTub) continue

            const rot = sign === 1 ? wall.yaw : wall.yaw + Math.PI
            const pos: Vec3 = [wx, opts.mountY, wz]
            const clearOfExisting = !isNearExisting(pos, rot, 0.35)
            const clearOfEquip = isWallSpotClearOfEquipment(wx, opts.mountY, wz)
            const score =
              (clearOfEquip ? 250 : 0) +
              (clearOfExisting ? 120 : 0) +
              (matchesZone ? 60 : 20) +
              (minTub > 0 ? Math.min(5, tubDist) * 12 : 0) -
              dist2D([wx, wz], z.centroid) * 0.4
            if (!bestWallSpot || score > bestWallSpot.score) {
              bestWallSpot = { pos, rot, score }
            }
          }
        }
      }
    }
    if (bestWallSpot) {
      return { position: bestWallSpot.pos, rotation: bestWallSpot.rot }
    }

    // Pass 3: Fallback for synthetic minimal scenes without wall nodes bordering `z` -> snap onto zone perimeter edge
    const poly = z.polygon
    let bestPoly: { pos: Vec3; rot: number; score: number } | null = null
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!
      const b = poly[(i + 1) % poly.length]!
      const len = dist2D(a, b)
      if (len < 0.25) continue
      const dx = (b[0] - a[0]) / len
      const dz = (b[1] - a[1]) / len
      const nx = -dz
      const nz = dx
      for (const frac of [0.5, 0.25, 0.75]) {
        const mx = a[0] + dx * len * frac
        const mz = a[1] + dz * len * frac
        const inSign = pointInPolygon2D(mx + nx * 0.12, mz + nz * 0.12, poly) ? 1 : -1
        const wx = round3(mx + nx * inSign * 0.06)
        const wz = round3(mz + nz * inSign * 0.06)
        const tubDist = distToNearestTub(wx, wz)
        const rot = Math.atan2(nx * inSign, nz * inSign)
        const pos: Vec3 = [wx, opts.mountY, wz]
        const score =
          (minTub > 0 && tubDist < minTub ? -1000 : 0) +
          (minTub > 0 ? Math.min(5, tubDist) * 15 : 0) +
          (!isNearExisting(pos, rot, 0.35) ? 50 : 0)
        if (!bestPoly || score > bestPoly.score) {
          bestPoly = { pos, rot, score }
        }
      }
    }
    if (bestPoly) {
      return { position: bestPoly.pos, rotation: bestPoly.rot }
    }
    return { position: [round3(z.centroid[0]), opts.mountY, round3(z.centroid[1])], rotation: 0 }
  }

  // Helper: snap an arbitrary point (e.g. stair landing device) to the nearest wall within `maxDistM` if available
  const snapPointToNearbyWall = (
    px: number,
    pz: number,
    mountY: number,
    fallbackRot: number,
    maxDistM = 1.2,
  ): { position: Vec3; rotation: number } => {
    let best: { pos: Vec3; rot: number; score: number } | null = null
    for (const wall of walls) {
      const baseT = Math.max(
        0.18,
        Math.min(wall.length - 0.18, (px - wall.start[0]) * wall.dx + (pz - wall.start[1]) * wall.dz),
      )
      const faceOff = wall.thickness / 2 + WALL_DEVICE_OFFSET_M
      for (const dt of [0, 0.55, -0.55, 1.1, -1.1]) {
        const t = baseT + dt
        if (t < 0.18 || t > wall.length - 0.18) continue
        const hitsDoor = wall.openings.some((o) => o.kind === 'door' && t > o.tMin && t < o.tMax)
        if (hitsDoor) continue
        const cxW = wall.start[0] + wall.dx * t
        const czW = wall.start[1] + wall.dz * t
        const d = Math.hypot(px - cxW, pz - czW)
        if (d > maxDistM + Math.abs(dt)) continue
        const side: 1 | -1 = (px - cxW) * wall.nx + (pz - czW) * wall.nz >= 0 ? 1 : -1
        const wx = round3(cxW + wall.nx * side * faceOff)
        const wz = round3(czW + wall.nz * side * faceOff)
        const rot = side === 1 ? wall.yaw : wall.yaw + Math.PI
        const pos: Vec3 = [wx, mountY, wz]
        if (isNearExisting(pos, rot, 0.52)) continue
        const score = -(d + Math.abs(dt) * 0.4)
        if (!best || score > best.score) {
          best = { pos, rot, score }
        }
      }
    }
    if (best) return { position: best.pos, rotation: best.rot }
    return { position: [round3(px), mountY, round3(pz)], rotation: fallbackRot }
  }

  // Pre-compute interior zones & NFPA 72 A.29.9.4 pilot lighting zone so both Bones switch
  // ingestion (Step 1c) and Step 3 room lighting share the exact same Smoke/CO pilot circuit.
  const interiorZones = zones.filter((z) => !isOutdoorCategory(z.category))
  const pilotLightZone: ZoneInfo | null = includeSmokeAlarms
    ? interiorZones.find((z) => isHallway(z.category)) ??
      interiorZones.find((z) => isPrimaryCommonZone(z.category)) ??
      interiorZones.find(
        (z) => !isBathroom(z.category) && !isKitchen(z.category) && !/closet/.test(z.category) && !isBedroom(z.category),
      ) ??
      interiorZones.find((z) => !isBathroom(z.category) && !isKitchen(z.category) && !/closet/.test(z.category)) ??
      null
    : null
  const smokeCircuitGroup =
    includeLighting && pilotLightZone ? 'Smoke/CO & Lighting' : 'Smoke/CO Alarms'
  const bonesSwitchZoneIds = new Set<string>()
  const lineToLineVolts = getVoltageLineToLine(panelVoltageSystem)
  const dedicatedGroupCounts = new Map<string, number>()
  const peekDedicatedGroupName = (baseName: string): { name: string; count: number } => {
    const count = (dedicatedGroupCounts.get(baseName) ?? 0) + 1
    return { name: count === 1 ? baseName : `${baseName} #${count}`, count }
  }

  // 1c. Bones Schematic Ingestion (`bones:device` and electrical `bones:service` nodes):
  //     When `@pascal-app/plugin-bones` has persisted wall receptacles, GFCIs, switches, or major
  //     service anchors (`water-heater`, `heat-pump`), promote them directly into engineered
  //     `electrical:device` specs (preserving user-dragged anchors and preventing duplicates on re-run).
  let kitchenCounterIdx = 0
  let exteriorDoorCount = 0
  let bonesDevicesImported = 0
  let bonesServicesImported = 0
  let bonesUserMovedPreserved = 0

  if (bonesMode !== 'ignore' && bonesSchematic.hasElectricalSchematic) {
    const importedBonesSourceIds = new Set<string>()
    for (const d of existingDevices) {
      const meta = d.metadata as Record<string, unknown> | undefined
      if (meta && typeof meta.bonesSourceId === 'string' && meta.bonesSourceId.length > 0) {
        importedBonesSourceIds.add(meta.bonesSourceId)
      }
    }

    const resolveBonesWallPoint = (anchor: {
      wallId?: string
      wallT?: number
      heightAff?: number
      position?: readonly [number, number, number]
      rotation?: readonly [number, number, number]
      faceSideHint?: 1 | -1 | null
      preferExterior?: boolean
      defaultHeightM: number
    }): { position: Vec3; rotation: number; roomZone: ZoneInfo | null } | null => {
      if (anchor.position) {
        const pos: Vec3 = [
          round3(anchor.position[0]),
          round3(anchor.position[1] > 0.01 ? anchor.position[1] : anchor.defaultHeightM),
          round3(anchor.position[2]),
        ]
        const rot = anchor.rotation ? anchor.rotation[1] : 0
        const roomZone =
          zoneAtPoint(zones, pos[0] + Math.sin(rot) * 0.35, pos[2] + Math.cos(rot) * 0.35) ??
          zoneAtPoint(zones, pos[0], pos[2])
        return { position: pos, rotation: rot, roomZone }
      }
      const hostWall = anchor.wallId ? walls.find((w) => w.id === anchor.wallId) : undefined
      if (!hostWall || typeof anchor.wallT !== 'number') return null
      const u = Math.max(0.08, Math.min(hostWall.length - 0.08, anchor.wallT * hostWall.length))
      const mountY = round3(
        anchor.heightAff !== undefined && anchor.heightAff > 0.01
          ? anchor.heightAff
          : anchor.defaultHeightM,
      )
      const cx = hostWall.start[0] + hostWall.dx * u
      const cz = hostWall.start[1] + hostWall.dz * u
      const probeOff = hostWall.thickness / 2 + 0.35
      const zPos = zoneAtPoint(zones, cx + hostWall.nx * probeOff, cz + hostWall.nz * probeOff)
      const zNeg = zoneAtPoint(zones, cx - hostWall.nx * probeOff, cz - hostWall.nz * probeOff)

      let side: 1 | -1 = 1
      if (anchor.faceSideHint === 1 || anchor.faceSideHint === -1) {
        side = anchor.faceSideHint
      } else if (anchor.preferExterior) {
        const posIsOut = zPos === null || isOutdoorCategory(zPos.category)
        const negIsOut = zNeg === null || isOutdoorCategory(zNeg.category)
        side = posIsOut && !negIsOut ? 1 : negIsOut && !posIsOut ? -1 : -1
      } else {
        const posIsIn = zPos !== null && !isOutdoorCategory(zPos.category)
        const negIsIn = zNeg !== null && !isOutdoorCategory(zNeg.category)
        side = posIsIn ? 1 : negIsIn ? -1 : 1
      }

      const faceOff = hostWall.thickness / 2 + WALL_DEVICE_OFFSET_M
      const pos: Vec3 = [
        round3(cx + hostWall.nx * side * faceOff),
        mountY,
        round3(cz + hostWall.nz * side * faceOff),
      ]
      const rotation = side === 1 ? hostWall.yaw : hostWall.yaw + Math.PI
      const roomZone = side === 1 ? zPos : zNeg
      return { position: pos, rotation, roomZone }
    }

    for (const bDev of bonesSchematic.devices) {
      if (importedBonesSourceIds.has(bDev.nodeId)) continue
      const resolved = resolveBonesWallPoint({
        wallId: bDev.wallId,
        wallT: bDev.wallT,
        heightAff: bDev.heightAff,
        position: bDev.position,
        rotation: bDev.rotation,
        faceSideHint: bDev.faceSideHint,
        preferExterior: bDev.isOutdoor,
        defaultHeightM:
          bDev.deviceKind === 'switch' ? 1.22 : bDev.isCountertop ? 1.12 : bDev.isOutdoor ? 0.45 : 0.38,
      })
      if (!resolved) continue

      const z = resolved.roomZone
      const zName = z?.name ?? 'General'
      const zCat = z?.category ?? ''
      let added = false

      if (bDev.deviceKind === 'switch') {
        const isPilotSwitch = Boolean(
          includeLighting && includeSmokeAlarms && pilotLightZone && z && z.id === pilotLightZone.id,
        )
        added = addPlanned({
          name: `${zName} Switch (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: 'switch-1p',
          circuitGroup: isPilotSwitch ? smokeCircuitGroup : 'Lighting & Entries',
          necRef: isPilotSwitch
            ? 'NEC 210.70(A) / NFPA 72 A.29.9.4 (Imported from Bones)'
            : 'NEC 210.70(A) (Imported from Bones)',
          requiresGfci: false,
          requiresAfci: occupancy === 'residential',
          breakerAmps: occupancy === 'commercial' ? 20 : 15,
          loadVa: 0,
          boxType: occupancy === 'commercial' ? '4-sq-1.5' : 'single-gang-standard',
          wireGauge: occupancy === 'commercial' ? '12' : '14',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
        if (added && z) bonesSwitchZoneIds.add(z.id)
      } else if (bDev.deviceKind === 'receptacle-wr-gfci' || bDev.isOutdoor) {
        // NEC 406.9(B)(1): Outdoor wet-location receptacles always retain weatherproof extra-duty in-use enclosures
        added = addPlanned({
          name: 'Outdoor WR GFCI (Bones)',
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: 'weatherproof-gfci',
          circuitGroup: 'Outdoor GFCI',
          necRef: 'NEC 210.52(E) / 210.8(A)(3) / 406.9(B)(1) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: 'single-gang-deep',
          wireGauge: '12',
          isExterior: true,
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else if (bDev.isCountertop || (z && isKitchen(zCat))) {
        kitchenCounterIdx += 1
        const sabNum = kitchenCounterIdx % 2 === 1 ? 1 : 2
        added = addPlanned({
          name: `${zName} Counter GFCI #${kitchenCounterIdx} (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: `Kitchen SAB-${sabNum} (20A)`,
          necRef: 'NEC 210.52(C) / 210.11(C)(1) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: occupancy === 'residential',
          breakerAmps: 20,
          loadVa: 180,
          boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep',
          wireGauge: '12',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else if (bDev.isBasin || (z && isBathroom(zCat))) {
        added = addPlanned({
          name: `${zName} Vanity GFCI (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: 'Bathroom GFCI (20A)',
          necRef: 'NEC 210.52(D) / 210.11(C)(3) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep',
          wireGauge: '12',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else if (z && isLaundry(zCat)) {
        added = addPlanned({
          name: `${zName} Laundry GFCI (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: 'Laundry GFCI (20A)',
          necRef: 'NEC 210.52(F) / 210.11(C)(2) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: occupancy === 'residential',
          breakerAmps: 20,
          loadVa: 180,
          boxType: 'single-gang-deep',
          wireGauge: '12',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else if (z && isGarage(zCat)) {
        added = addPlanned({
          name: `${zName} Garage GFCI (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: 'Garage GFCI (20A)',
          necRef: 'NEC 210.52(G)(1) / 210.11(C)(4) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: 'single-gang-deep',
          wireGauge: '12',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else if (bDev.deviceKind === 'receptacle-gfci' || (z && isBasementOrUtility(zCat))) {
        added = addPlanned({
          name: `${zName} GFCI Receptacle (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: 'General GFCI (20A)',
          necRef: 'NEC 210.8(A) (Imported from Bones)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: 'single-gang-deep',
          wireGauge: '12',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      } else {
        added = addPlanned({
          name: `${zName} Receptacle (Bones)`,
          position: resolved.position,
          rotation: resolved.rotation,
          deviceKind: 'duplex',
          circuitGroup: `${zName} Receptacles`,
          necRef: 'NEC 210.52(A) (Imported from Bones)',
          requiresGfci: false,
          requiresAfci: occupancy === 'residential',
          breakerAmps: occupancy === 'commercial' ? 20 : 15,
          loadVa: 180,
          boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard',
          wireGauge: occupancy === 'commercial' ? '12' : '14',
          bonesSourceId: bDev.nodeId,
          bonesDeviceId: bDev.deviceId,
          bonesUserMoved: bDev.userMoved,
        })
      }

      if (added) {
        bonesDevicesImported += 1
        if (bDev.userMoved) bonesUserMovedPreserved += 1
      }
    }

    for (const bSvc of bonesSchematic.services) {
      if (importedBonesSourceIds.has(bSvc.nodeId)) continue
      if (bSvc.serviceType !== 'water-heater' && bSvc.serviceType !== 'heat-pump') continue

      const isHeatPump = bSvc.serviceType === 'heat-pump'
      const resolved = resolveBonesWallPoint({
        wallId: bSvc.wallId,
        wallT: bSvc.wallT,
        heightAff: bSvc.heightAff,
        position: bSvc.position,
        rotation: bSvc.rotation,
        preferExterior: isHeatPump,
        defaultHeightM: isHeatPump ? 0.6 : 1.0,
      })
      if (!resolved) continue

      const baseGroupName = isHeatPump
        ? `Heat Pump HVAC (${lineToLineVolts}V 30A)`
        : `Water Heater (${lineToLineVolts}V 30A)`
      const dedicated = peekDedicatedGroupName(baseGroupName)

      const added = addPlanned(
        isHeatPump
          ? {
              name: 'Heat Pump Condenser (Bones)',
              position: resolved.position,
              rotation: bSvc.yawOverride ?? resolved.rotation,
              deviceKind: 'dedicated-240v',
              circuitGroup: dedicated.name,
              necRef: 'NEC 440.32 / 210.8(F) / 220.82(C)(2) (Imported from Bones)',
              requiresGfci: true,
              requiresAfci: false,
              poles: 2,
              breakerAmps: 30,
              loadVa: 4800,
              continuous: false,
              isMotor: true,
              loadCategory: 'heat-pump',
              boxType: '4-sq-2.125',
              wireGauge: '10',
              isExterior: true,
              bonesSourceId: bSvc.nodeId,
              bonesServiceType: bSvc.serviceType,
            }
          : {
              name: 'Electric Water Heater (Bones)',
              position: resolved.position,
              rotation: resolved.rotation,
              deviceKind: 'dedicated-240v',
              circuitGroup: dedicated.name,
              necRef: 'NEC 422.13 / 210.8(A) / 220.53 (Imported from Bones)',
              requiresGfci: true,
              requiresAfci: false,
              poles: 2,
              breakerAmps: 30,
              loadVa: 4500,
              continuous: false,
              loadCategory: 'fixed',
              boxType: '4-sq-2.125',
              wireGauge: '10',
              bonesSourceId: bSvc.nodeId,
              bonesServiceType: bSvc.serviceType,
            },
      )
      if (added) {
        dedicatedGroupCounts.set(baseGroupName, dedicated.count)
        bonesServicesImported += 1
      }
    }
  }

  const minWireGaugeForBreakerAmps = (amps: number): WireGauge => {
    if (amps >= 100) return '1'
    if (amps >= 70) return '4'
    if (amps >= 50) return '6'
    if (amps >= 40) return '8'
    if (amps >= 30) return '10'
    if (amps >= 20) return '12'
    return '14'
  }

  // 1b. Cross-Trade MEP Power Demand Ingestion (`plumbing:equipment`, `plumbing:fixture`, `hvac:equipment`, `hvac-equipment`)
  // Automatically provisions dedicated/GFCI breakers & 3D power runs for any powered plumbing or HVAC node publishing `electricalDemand`.
  if (bonesMode !== 'import-only') {
  const wiredMepSourceIds = new Set<string>()
  for (const existing of existingDevices) {
    const meta = existing.metadata as { mepSourceNodeId?: string } | undefined
    if (typeof meta?.mepSourceNodeId === 'string') wiredMepSourceIds.add(meta.mepSourceNodeId)
  }

  // Collect already-imported Bones water-heater / heat-pump positions so 'auto' mode skips duplicate MEP units within 1.2 m
  const importedBonesServices: Array<{ serviceType: 'water-heater' | 'heat-pump'; position: Vec3 }> = []
  if (bonesMode === 'auto') {
    for (const p of planned) {
      if (p.bonesServiceType === 'water-heater' || p.bonesServiceType === 'heat-pump') {
        importedBonesServices.push({ serviceType: p.bonesServiceType, position: p.position })
      }
    }
    for (const d of existingDevices) {
      const meta = d.metadata as { bonesServiceType?: string } | undefined
      if (
        (meta?.bonesServiceType === 'water-heater' || meta?.bonesServiceType === 'heat-pump') &&
        Array.isArray(d.position) &&
        d.position.length >= 3
      ) {
        importedBonesServices.push({
          serviceType: meta.bonesServiceType,
          position: [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])],
        })
      }
    }
  }

  type RawMepDemand = {
    required?: boolean
    voltage?: number
    poles?: number
    breakerAmps?: number
    loadVa?: number
    continuous?: boolean
    dedicatedCircuit?: boolean
    gfciRequired?: boolean
    afciRequired?: boolean
    loadCategory?: 'fixed' | 'appliance' | 'motor' | 'hvac-heating' | 'hvac-cooling' | 'heat-pump'
    label?: string
  }

  const PASSIVE_PLUMBING_EQUIPMENT_KINDS = new Set([
    'water-heater-tank-gas',
    'expansion-tank',
    'gas-meter',
    'main-shutoff-prv',
    'backwater-valve',
  ])
  const PLUMBING_120V_ONLY_KINDS = new Set([
    'water-heater-tankless-gas',
    'recirc-pump',
    'sump-pump',
    'sewage-ejector',
    'water-softener',
    'boiler-hydronic',
  ])
  const PASSIVE_HVAC_EQUIPMENT_KINDS = new Set(['mini-split-indoor'])
  const HVAC_120V_ONLY_KINDS = new Set([
    'gas-furnace-96',
    'gas-furnace-80',
    'erv-ventilator',
    'dehumidifier-whole-house',
    'range-hood',
    'bath-exhaust-fan',
  ])
  const HVAC_HIGH_VOLT_ONLY_KINDS = new Set([
    'heat-pump-condenser',
    'ac-condenser',
    'rooftop-package-unit',
    'mini-split-outdoor',
  ])

  const nextStdBreaker = (minAmps: number): number => {
    for (const std of [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200]) {
      if (std >= minAmps) return std
    }
    return 200
  }

  const fallbackMepDemandForNode = (mepNode: SceneNodeLike): RawMepDemand | null => {
    if (mepNode.type === 'plumbing:equipment') {
      const kind = typeof mepNode.equipmentKind === 'string' ? mepNode.equipmentKind : ''
      if (PASSIVE_PLUMBING_EQUIPMENT_KINDS.has(kind)) return null
      const watts = typeof mepNode.watts === 'number' && mepNode.watts > 0 ? mepNode.watts : 4500
      const calc240Breaker = (w: number): number => nextStdBreaker(Math.max(30, (w / 240) * 1.25))
      switch (kind) {
        case 'water-heater-tank-electric':
          return { required: true, voltage: 240, poles: 2, breakerAmps: calc240Breaker(watts), loadVa: watts, continuous: true, dedicatedCircuit: true, loadCategory: 'fixed', label: 'Electric Water Heater' }
        case 'water-heater-hpwh':
          return { required: true, voltage: 240, poles: 2, breakerAmps: calc240Breaker(watts), loadVa: watts, continuous: true, dedicatedCircuit: true, loadCategory: 'fixed', label: 'Heat-Pump Water Heater' }
        case 'water-heater-tankless-gas':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 300, continuous: false, dedicatedCircuit: false, gfciRequired: true, loadCategory: 'fixed', label: 'Tankless Gas WH Ignition' }
        case 'recirc-pump':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 180, continuous: true, dedicatedCircuit: false, gfciRequired: true, loadCategory: 'motor', label: 'DHW Recirculation Pump' }
        case 'sump-pump':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1200, continuous: false, dedicatedCircuit: true, gfciRequired: true, loadCategory: 'motor', label: 'Sump Pump' }
        case 'sewage-ejector':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1500, continuous: false, dedicatedCircuit: true, gfciRequired: true, loadCategory: 'motor', label: 'Sewage Ejector Pump' }
        case 'water-softener':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 150, continuous: false, dedicatedCircuit: false, gfciRequired: true, loadCategory: 'fixed', label: 'Water Softener' }
        case 'pressure-tank':
          return { required: true, voltage: 240, poles: 2, breakerAmps: 20, loadVa: 1800, continuous: false, dedicatedCircuit: true, loadCategory: 'motor', label: 'Well Booster Pump' }
        case 'boiler-hydronic':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1200, continuous: true, dedicatedCircuit: true, loadCategory: 'fixed', label: 'Hydronic Boiler' }
        default:
          return null
      }
    }
    if (mepNode.type === 'plumbing:fixture') {
      const kind = typeof mepNode.fixtureKind === 'string' ? mepNode.fixtureKind : ''
      switch (kind) {
        case 'dishwasher':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1200, continuous: false, dedicatedCircuit: true, gfciRequired: true, afciRequired: true, loadCategory: 'appliance', label: 'Dishwasher' }
        case 'garbage-disposal':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1000, continuous: false, dedicatedCircuit: true, gfciRequired: true, afciRequired: true, loadCategory: 'appliance', label: 'Garbage Disposal' }
        case 'clothes-washer':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 20, loadVa: 1200, continuous: false, dedicatedCircuit: true, gfciRequired: true, afciRequired: true, loadCategory: 'appliance', label: 'Clothes Washer' }
        case 'bidet':
          return { required: true, voltage: 120, poles: 1, breakerAmps: 15, loadVa: 1200, continuous: false, dedicatedCircuit: true, gfciRequired: true, loadCategory: 'appliance', label: 'Heated Bidet Seat' }
        default:
          return null
      }
    }
    if (mepNode.type === 'hvac:equipment' || mepNode.type === 'hvac-equipment') {
      const kind = typeof mepNode.equipmentKind === 'string' ? mepNode.equipmentKind : ''
      if (PASSIVE_HVAC_EQUIPMENT_KINDS.has(kind)) return null
      const coolingTons =
        typeof mepNode.coolingTons === 'number' && mepNode.coolingTons > 0 ? mepNode.coolingTons : 3
      const isCommercial3P = occupancy === 'commercial' && isThreePhaseSystem(panelVoltageSystem)
      switch (kind) {
        case 'air-handler': {
          const heatStripKw =
            typeof mepNode.heatStripKw === 'number' && mepNode.heatStripKw >= 0 ? mepNode.heatStripKw : 10
          if (heatStripKw <= 0) {
            return {
              required: true,
              voltage: 120,
              poles: 1,
              breakerAmps: 15,
              loadVa: 600,
              continuous: false,
              dedicatedCircuit: true,
              loadCategory: 'motor',
              label: 'Air Handler Blower',
            }
          }
          const loadVa = Math.round(heatStripKw * 1000 + 600)
          return {
            required: true,
            voltage: 240,
            poles: 2,
            breakerAmps: Math.max(30, nextStdBreaker((loadVa / 240) * 1.25)),
            loadVa,
            continuous: true,
            dedicatedCircuit: true,
            loadCategory: 'hvac-heating',
            label: `Air Handler (${heatStripKw} kW Aux Heat)`,
          }
        }
        case 'heat-pump-condenser': {
          const loadVa = Math.round(coolingTons * 1450)
          const use3P = isCommercial3P && coolingTons >= 4
          const voltage = use3P ? 208 : 240
          const poles: 1 | 2 | 3 = use3P ? 3 : 2
          const breakerAmps = use3P
            ? nextStdBreaker(Math.max(20, (loadVa / (208 * Math.sqrt(3))) * 1.45))
            : coolingTons <= 2
              ? 25
              : coolingTons <= 3
                ? 35
                : coolingTons <= 4
                  ? 45
                  : 60
          return {
            required: true,
            voltage,
            poles,
            breakerAmps,
            loadVa,
            continuous: true,
            dedicatedCircuit: true,
            loadCategory: 'heat-pump',
            label: `${coolingTons}-Ton Heat Pump Condenser`,
          }
        }
        case 'ac-condenser': {
          const loadVa = Math.round(coolingTons * 1350)
          const use3P = isCommercial3P && coolingTons >= 4
          const voltage = use3P ? 208 : 240
          const poles: 1 | 2 | 3 = use3P ? 3 : 2
          const breakerAmps = use3P
            ? nextStdBreaker(Math.max(20, (loadVa / (208 * Math.sqrt(3))) * 1.45))
            : coolingTons <= 2
              ? 25
              : coolingTons <= 3
                ? 30
                : coolingTons <= 4
                  ? 40
                  : 50
          return {
            required: true,
            voltage,
            poles,
            breakerAmps,
            loadVa,
            continuous: true,
            dedicatedCircuit: true,
            loadCategory: 'hvac-cooling',
            label: `${coolingTons}-Ton AC Condenser`,
          }
        }
        case 'rooftop-package-unit': {
          const rtuTons =
            typeof mepNode.coolingTons === 'number' && mepNode.coolingTons > 0
              ? mepNode.coolingTons
              : occupancy === 'commercial'
                ? 5
                : 3
          const loadVa = Math.round(rtuTons * 1850)
          const voltage = isCommercial3P ? 208 : 240
          const poles: 1 | 2 | 3 = isCommercial3P ? 3 : 2
          const breakerAmps = Math.max(
            30,
            nextStdBreaker((loadVa / (poles === 3 ? voltage * Math.sqrt(3) : voltage)) * 1.35),
          )
          return {
            required: true,
            voltage,
            poles,
            breakerAmps,
            loadVa,
            continuous: true,
            dedicatedCircuit: true,
            loadCategory: 'heat-pump',
            label: `${rtuTons}-Ton Packaged RTU`,
          }
        }
        case 'gas-furnace-96':
        case 'gas-furnace-80':
          return {
            required: true,
            voltage: 120,
            poles: 1,
            breakerAmps: 15,
            loadVa: 850,
            continuous: false,
            dedicatedCircuit: true,
            loadCategory: 'hvac-heating',
            label: kind === 'gas-furnace-96' ? '96% Gas Furnace Blower/Controls' : '80% Gas Furnace Blower/Controls',
          }
        case 'erv-ventilator':
          return {
            required: true,
            voltage: 120,
            poles: 1,
            breakerAmps: 15,
            loadVa: 180,
            continuous: true,
            dedicatedCircuit: false,
            loadCategory: 'motor',
            label: 'Energy Recovery Ventilator (ERV)',
          }
        case 'dehumidifier-whole-house':
          return {
            required: true,
            voltage: 120,
            poles: 1,
            breakerAmps: 15,
            loadVa: 750,
            continuous: true,
            dedicatedCircuit: false,
            gfciRequired: true,
            loadCategory: 'appliance',
            label: 'Whole-House Dehumidifier',
          }
        case 'range-hood':
          return {
            required: true,
            voltage: 120,
            poles: 1,
            breakerAmps: 15,
            loadVa: 300,
            continuous: false,
            dedicatedCircuit: false,
            afciRequired: true,
            loadCategory: 'appliance',
            label: 'Kitchen Range Exhaust Hood',
          }
        case 'bath-exhaust-fan':
          return {
            required: true,
            voltage: 120,
            poles: 1,
            breakerAmps: 15,
            loadVa: 50,
            continuous: false,
            dedicatedCircuit: false,
            gfciRequired: true,
            loadCategory: 'motor',
            label: 'Bath Exhaust Fan',
          }
        case 'mini-split-outdoor': {
          const loadVa = Math.round(Math.max(1.5, coolingTons) * 1250)
          const breakerAmps = coolingTons <= 2 ? 20 : coolingTons <= 3 ? 30 : 40
          return {
            required: true,
            voltage: 240,
            poles: 2,
            breakerAmps,
            loadVa,
            continuous: true,
            dedicatedCircuit: true,
            loadCategory: 'heat-pump',
            label: `Inverter Mini-Split Outdoor (${coolingTons}-Ton)`,
          }
        }
        default:
          return null
      }
    }
    return null
  }

  const isExplicitDemandKindMismatched = (mepNode: SceneNodeLike, demand: RawMepDemand): boolean => {
    const eqKind = typeof mepNode.equipmentKind === 'string' ? mepNode.equipmentKind : ''
    if (!eqKind) return false
    const v = demand.voltage ?? 120
    const p = demand.poles ?? (v >= 208 ? 2 : 1)
    const a = demand.breakerAmps ?? 15
    const va = demand.loadVa ?? 0
    if (mepNode.type === 'hvac:equipment' || mepNode.type === 'hvac-equipment') {
      if (HVAC_120V_ONLY_KINDS.has(eqKind)) {
        return v >= 208 || p >= 2 || a > 20 || va > 2400
      }
      if (HVAC_HIGH_VOLT_ONLY_KINDS.has(eqKind)) {
        return v < 200 || p < 2
      }
    }
    if (mepNode.type === 'plumbing:equipment' && PLUMBING_120V_ONLY_KINDS.has(eqKind)) {
      return v >= 208 || p >= 2 || a > 20
    }
    return false
  }

  const auxCircuitLoadState = new Map<number, { index: number; usedVa: number }>()

  for (const mepNode of Object.values(nodes)) {
    if (!belongsToLevel(nodes, mepNode, levelId)) continue
    if (
      mepNode.type !== 'plumbing:equipment' &&
      mepNode.type !== 'plumbing:fixture' &&
      mepNode.type !== 'hvac:equipment' &&
      mepNode.type !== 'hvac-equipment'
    ) {
      continue
    }
    if (wiredMepSourceIds.has(mepNode.id)) continue
    const eqKind = typeof mepNode.equipmentKind === 'string' ? mepNode.equipmentKind : ''
    if (
      (mepNode.type === 'plumbing:equipment' && PASSIVE_PLUMBING_EQUIPMENT_KINDS.has(eqKind)) ||
      ((mepNode.type === 'hvac:equipment' || mepNode.type === 'hvac-equipment') &&
        PASSIVE_HVAC_EQUIPMENT_KINDS.has(eqKind))
    ) {
      continue
    }
    const explicitDemand = mepNode.electricalDemand as RawMepDemand | null | undefined
    const rawDemand: RawMepDemand | null =
      explicitDemand === undefined
        ? fallbackMepDemandForNode(mepNode)
        : explicitDemand && isExplicitDemandKindMismatched(mepNode, explicitDemand)
          ? fallbackMepDemandForNode(mepNode)
          : explicitDemand
    if (!rawDemand || rawDemand.required !== true) continue
    if (!Array.isArray(mepNode.position) || mepNode.position.length < 3) continue

    const mepRot = typeof mepNode.rotation === 'number' ? mepNode.rotation : 0
    const label =
      rawDemand.label || (typeof mepNode.name === 'string' && mepNode.name ? mepNode.name : mepNode.id)
    const isHvacEquip = mepNode.type === 'hvac:equipment' || mepNode.type === 'hvac-equipment'
    const mepRawY = Number(mepNode.position[1]) || 0
    const isCeilingHardwiredExhaust =
      isHvacEquip &&
      (eqKind === 'bath-exhaust-fan' ||
        (/bath.*exhaust|exhaust.*fan/i.test(`${eqKind} ${String(mepNode.name ?? '')} ${label}`) &&
          mepRawY >= 2.2))

    // Offset power receptacle/disconnect cleanly outside equipment footprint + clearance so wires never self-clash.
    // Derive radial offset dynamically from the actual equipment AABB half-extents + clearance (so wide units like
    // rooftop-package-unit 1.55m x 1.05m or heat-pump-condenser 0.85m never bury their disconnect inside the cabinet).
    // For HVAC/Plumbing equipment, pick a face (+/-X, +/-Z, or rotated local faces) whose terminal point AND
    // vertical riser do NOT land inside an adjacent side-return duct (`hvac:duct-run`) or plenum (`hvac:plenum`).
    // For plumbing fixtures (dishwasher/disposal/washer), place the outlet laterally in the adjacent under-sink bay.
    const selfMepObs = obstacles.find((o) => o.nodeId === mepNode.id)
    const selfEqBox = selfMepObs?.box ?? (isHvacEquip ? getHvacEquipmentBox(mepNode) : null)
    const selfEqHalfX = selfEqBox ? (selfEqBox.max[0] - selfEqBox.min[0]) / 2 : 0
    const selfEqHalfZ = selfEqBox ? (selfEqBox.max[2] - selfEqBox.min[2]) / 2 : 0
    const selfEqClearance = selfMepObs?.requiredClearanceM ?? (isHvacEquip ? 0.15 : 0.05)
    const radialOffsetForDir = (ux: number, uz: number): number => {
      if (isCeilingHardwiredExhaust) return 0.22
      const baseFloor = isHvacEquip ? 0.56 : mepNode.type === 'plumbing:equipment' ? 0.42 : 0
      if (baseFloor === 0) return 0
      if (!selfEqBox) return baseFloor
      const dirHalfExtent = Math.abs(ux) * selfEqHalfX + Math.abs(uz) * selfEqHalfZ
      return round3(Math.max(baseFloor, dirHalfExtent + selfEqClearance + 0.12))
    }
    const radialOffsetM = radialOffsetForDir(Math.sin(mepRot), Math.cos(mepRot))
    const lateralOffsetM = mepNode.type === 'plumbing:fixture' ? 0.36 : 0
    const targetY = isCeilingHardwiredExhaust
      ? round3(Math.max(2.44, Math.min(levelHeight - 0.03, mepRawY >= 2.2 ? mepRawY : ceilingLightY)))
      : Math.max(0.38, Math.min(1.5, mepRawY || 0.9))

    const basePos: Vec3 = [
      round3(Number(mepNode.position[0]) + Math.sin(mepRot) * radialOffsetM + Math.cos(mepRot) * lateralOffsetM),
      targetY,
      round3(Number(mepNode.position[2]) + Math.cos(mepRot) * radialOffsetM - Math.sin(mepRot) * lateralOffsetM),
    ]
    let pos: Vec3 = basePos

    if ((isHvacEquip || mepNode.type === 'plumbing:equipment') && !isCeilingHardwiredExhaust) {
      const mepOriginX = Number(mepNode.position[0])
      const mepOriginZ = Number(mepNode.position[2])
      const mepOriginZone = zoneAtPoint(zones, mepOriginX, mepOriginZ)
      const otherObstacles = obstacles.filter((o) => o.nodeId !== mepNode.id)
      const pointOrRiserHitsObstacle = (cx: number, cy: number, cz: number): boolean => {
        const yLo = Math.min(cy, effectiveChaseY)
        const yHi = Math.max(cy, effectiveChaseY)
        for (const obs of otherObstacles) {
          const pad = Math.max(obs.requiredClearanceM, 0.05) + 0.04
          const b = obs.box
          if (cx < b.min[0] - pad || cx > b.max[0] + pad) continue
          if (cz < b.min[2] - pad || cz > b.max[2] + pad) continue
          if (yHi >= b.min[1] - 0.05 && yLo <= b.max[1] + 0.05) return true
        }
        return false
      }
      const pointOnlyHitsObstacle = (cx: number, cy: number, cz: number): boolean => {
        for (const obs of otherObstacles) {
          const pad = Math.max(obs.requiredClearanceM, 0.05) + 0.04
          const b = obs.box
          if (cx < b.min[0] - pad || cx > b.max[0] + pad) continue
          if (cz < b.min[2] - pad || cz > b.max[2] + pad) continue
          if (cy >= b.min[1] - 0.08 && cy <= b.max[1] + 0.08) return true
        }
        return false
      }
      if (pointOrRiserHitsObstacle(basePos[0], basePos[1], basePos[2])) {
        const dirCandidates: Array<[number, number]> = [
          [Math.sin(mepRot), Math.cos(mepRot)],
          [Math.cos(mepRot), -Math.sin(mepRot)],
          [-Math.cos(mepRot), Math.sin(mepRot)],
          [-Math.sin(mepRot), -Math.cos(mepRot)],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
        let bestFace: { p: Vec3; score: number } | null = null
        for (const extraOff of [0, 0.22]) {
          for (let di = 0; di < dirCandidates.length; di++) {
            const [ux, uz] = dirCandidates[di]!
            const baseFaceOff = radialOffsetForDir(ux, uz)
            const distOff = round3(baseFaceOff + extraOff)
            const cx = round3(mepOriginX + ux * distOff)
            const cz = round3(mepOriginZ + uz * distOff)
            const hitsPoint = pointOnlyHitsObstacle(cx, targetY, cz)
            const hitsRiser = pointOrRiserHitsObstacle(cx, targetY, cz)
            const candZone = zoneAtPoint(zones, cx, cz)
            const sameRoom = !mepOriginZone || candZone?.id === mepOriginZone.id
            const score =
              (hitsPoint ? -500 : 0) +
              (hitsRiser ? -200 : 0) +
              (sameRoom ? 40 : 0) -
              extraOff * 25 -
              di * 0.5
            if (!bestFace || score > bestFace.score) {
              bestFace = { p: [cx, targetY, cz], score }
            }
          }
        }
        if (bestFace) {
          pos = bestFace.p
        }
      }
    }

    if (importedBonesServices.length > 0) {
      const mepDescriptor = `${String(mepNode.equipmentKind ?? '')} ${String(mepNode.name ?? '')} ${label}`.toLowerCase()
      const isMepWaterHeater =
        mepNode.type === 'plumbing:equipment' && /water.?heater|hpwh|\bwh\b/.test(mepDescriptor)
      const isMepHeatPump =
        !isMepWaterHeater &&
        (mepNode.type === 'hvac:equipment' ||
          mepNode.type === 'hvac-equipment' ||
          rawDemand.loadCategory === 'heat-pump' ||
          /heat.?pump|condenser/.test(mepDescriptor))
      const mepXZ: [number, number] = [Number(mepNode.position[0]), Number(mepNode.position[2])]
      const duplicateOfBones = importedBonesServices.some((bs) => {
        const matchesKind =
          (bs.serviceType === 'water-heater' && isMepWaterHeater) ||
          (bs.serviceType === 'heat-pump' && isMepHeatPump)
        if (!matchesKind) return false
        const bXZ: [number, number] = [bs.position[0], bs.position[2]]
        return dist2D(mepXZ, bXZ) <= 1.2 || dist2D([pos[0], pos[2]], bXZ) <= 1.2
      })
      if (duplicateOfBones) continue
    }

    const rawPoles =
      typeof rawDemand.poles === 'number'
        ? rawDemand.poles
        : (rawDemand.voltage ?? 120) >= 208
          ? 2
          : 1
    const poles: 1 | 2 | 3 =
      rawPoles >= 3
        ? isThreePhaseSystem(panelVoltageSystem)
          ? 3
          : 2
        : rawPoles >= 2 || (rawDemand.voltage ?? 120) >= 208
          ? 2
          : 1
    const breakerAmps =
      typeof rawDemand.breakerAmps === 'number' ? rawDemand.breakerAmps : poles >= 2 ? 30 : 20
    const loadVa =
      typeof rawDemand.loadVa === 'number' ? rawDemand.loadVa : poles >= 2 ? 4500 : 1200
    const wireGauge: WireGauge = minWireGaugeForBreakerAmps(breakerAmps)
    const mepZone =
      zoneAtPoint(zones, pos[0], pos[2]) ??
      zoneAtPoint(zones, Number(mepNode.position[0]), Number(mepNode.position[2]))
    const mepZoneCat = mepZone ? mepZone.category.toLowerCase() : ''
    const isMepInBathroom = Boolean(mepZone && isBathroom(mepZoneCat))
    const isMepInKitchen = Boolean(mepZone && isKitchen(mepZoneCat))
    const isDedicated =
      rawDemand.dedicatedCircuit === true ||
      poles >= 2 ||
      loadVa > Math.floor(120 * breakerAmps * 0.5)
    let circuitGroup: string
    let dedicatedCommit: { base: string; count: number } | null = null
    if (isDedicated) {
      const voltLabel = poles >= 2 ? `${rawDemand.voltage ?? lineToLineVolts}V` : '120V'
      const poleTag = poles === 3 ? ' 3P' : ''
      const baseGroupName = `${label} (${voltLabel}${poleTag} ${breakerAmps}A)`
      const dedicated = peekDedicatedGroupName(baseGroupName)
      circuitGroup = dedicated.name
      dedicatedCommit = { base: baseGroupName, count: dedicated.count }
    } else if (isMepInBathroom) {
      // NEC 210.11(C)(3): Never mix bathroom MEP outlets onto a shared general MEP aux circuit with other rooms
      circuitGroup = `Bathroom MEP Aux (120V ${breakerAmps}A)`
    } else if (isMepInKitchen) {
      // NEC 210.11(C)(1): Never mix kitchen MEP outlets (e.g. range hood) onto a shared general MEP aux circuit with other rooms
      circuitGroup = `Kitchen MEP Aux (120V ${breakerAmps}A)`
    } else {
      const maxAuxVa = Math.floor(120 * breakerAmps * 0.8)
      const st = auxCircuitLoadState.get(breakerAmps) ?? { index: 1, usedVa: 0 }
      if (st.usedVa > 0 && st.usedVa + loadVa > maxAuxVa) {
        st.index += 1
        st.usedVa = loadVa
      } else {
        st.usedVa += loadVa
      }
      auxCircuitLoadState.set(breakerAmps, st)
      circuitGroup =
        st.index === 1
          ? `MEP Aux Loads (120V ${breakerAmps}A)`
          : `MEP Aux Loads (120V ${breakerAmps}A) #${st.index}`
    }
    const devKind: PlannedDeviceSpec['deviceKind'] = isCeilingHardwiredExhaust
      ? 'luminaire'
      : poles >= 2
        ? 'dedicated-240v'
        : rawDemand.gfciRequired
          ? 'gfci'
          : 'duplex'
    const isMep120v15Or20 = poles === 1 && breakerAmps <= 20
    const isMepResidentialHabitable =
      occupancy === 'residential' &&
      isMep120v15Or20 &&
      Boolean(
        mepZone &&
          !isBathroom(mepZoneCat) &&
          /(bedroom|living|dining|kitchen|hallway|closet|laundry|family|office|study|den)/.test(mepZoneCat),
      )
    const isMepWet120v =
      isMep120v15Or20 &&
      Boolean(
        mepZone &&
          (isBathroom(mepZoneCat) ||
            isKitchen(mepZoneCat) ||
            isGarage(mepZoneCat) ||
            isLaundry(mepZoneCat) ||
            isBasementOrUtility(mepZoneCat) ||
            isOutdoorCategory(mepZoneCat)),
      )

    const addedMep = addPlanned({
      name: `${label} Power`,
      position: pos,
      rotation: mepRot,
      deviceKind: devKind,
      circuitGroup,
      necRef: `Cross-Trade MEP Power (${mepNode.type} ${mepNode.id})`,
      requiresGfci: rawDemand.gfciRequired === true || isMepWet120v,
      requiresAfci: rawDemand.afciRequired === true || isMepResidentialHabitable,
      poles,
      breakerAmps,
      loadVa,
      continuous: rawDemand.continuous === true,
      isMotor:
        rawDemand.loadCategory === 'motor' ||
        rawDemand.loadCategory === 'heat-pump' ||
        rawDemand.loadCategory === 'hvac-cooling',
      loadCategory: rawDemand.loadCategory,
      boxType: isCeilingHardwiredExhaust
        ? '4-oct-2.125'
        : poles >= 2
          ? '4-sq-2.125'
          : 'single-gang-deep',
      wireGauge,
      mepSourceNodeId: mepNode.id,
    })
    if (addedMep && dedicatedCommit) {
      dedicatedGroupCounts.set(dedicatedCommit.base, dedicatedCommit.count)
    }
  }
  }

  // 2. Walk Walls: NEC 210.52(A)/(C) Wall-Perimeter & Kitchen Countertop Receptacles + Exterior Door Front/Back Rules
  if (bonesMode !== 'import-only') {
  for (const wall of walls) {
    const probeOffset = wall.thickness / 2 + 0.35
    const faceOff = wall.thickness / 2 + WALL_DEVICE_OFFSET_M

    // 2a. Check Doors on this Wall: Front/Exterior Door Entry Switch, Exterior Light, Entry Receptacle, & NEC 210.52(E)(1) Outdoor WR GFCI!
    for (const op of wall.openings) {
      if (op.kind !== 'door') continue
      const doorCenterT = (op.tMin + op.tMax) / 2
      const cx = wall.start[0] + wall.dx * doorCenterT
      const cz = wall.start[1] + wall.dz * doorCenterT
      const zPosSide = zoneAtPoint(zones, cx + wall.nx * probeOffset, cz + wall.nz * probeOffset)
      const zNegSide = zoneAtPoint(zones, cx - wall.nx * probeOffset, cz - wall.nz * probeOffset)
      const doorName = (typeof op.node.name === 'string' ? op.node.name : '').toLowerCase()
      const isExteriorWall =
        (zPosSide !== null && !isOutdoorCategory(zPosSide.category) && (zNegSide === null || isOutdoorCategory(zNegSide.category))) ||
        (zNegSide !== null && !isOutdoorCategory(zNegSide.category) && (zPosSide === null || isOutdoorCategory(zPosSide.category)))
      const isNamedExterior = /front|entry|main|exterior|back|patio|porch/.test(doorName)

      if (isExteriorWall || isNamedExterior) {
        exteriorDoorCount += 1
        const insideSign: 1 | -1 = zPosSide && !isOutdoorCategory(zPosSide.category) ? 1 : -1
        const outsideSign: 1 | -1 = insideSign === 1 ? -1 : 1
        // Pick a latch-side stud bay whose vertical riser stays clear of structural door/window LVL headers
        const headerObstacles = obstacles.filter(
          (o) => o.trade === 'structural' && o.nodeType === 'structural:beam' && o.box.max[1] >= 1.5,
        )
        const hitsHeaderAtT = (tCand: number): boolean => {
          const cxT = wall.start[0] + wall.dx * tCand
          const czT = wall.start[1] + wall.dz * tCand
          for (const h of headerObstacles) {
            const pad = Math.max(0.12, h.requiredClearanceM + 0.08)
            if (
              cxT >= h.box.min[0] - pad &&
              cxT <= h.box.max[0] + pad &&
              czT >= h.box.min[2] - pad &&
              czT <= h.box.max[2] + pad
            ) {
              return true
            }
          }
          return false
        }
        const latchCandidates: number[] = []
        for (let step = 0; step < 14; step++) {
          const d = 0.26 + step * 0.16
          if (op.tMax + d <= wall.length - 0.22) latchCandidates.push(op.tMax + d)
          if (op.tMin - d >= 0.22) latchCandidates.push(op.tMin - d)
        }
        const clearLatchT = latchCandidates.find((tCand) => !hitsHeaderAtT(tCand))
        const latchT =
          clearLatchT ??
          Math.min(
            wall.length - 0.25,
            Math.max(0.25, op.tMax + 0.26 <= wall.length - 0.2 ? op.tMax + 0.26 : op.tMin - 0.26),
          )
        const px = wall.start[0] + wall.dx * latchT
        const pz = wall.start[1] + wall.dz * latchT
        const doorLabel = exteriorDoorCount === 1 ? 'Front Door' : `Exterior Door ${exteriorDoorCount}`

        // NEC 210.52(E)(1): Outdoor grade-accessible WR GFCI receptacle beside front/back entrance
        addPlanned({
          name: `${doorLabel} Outdoor WR GFCI`,
          position: [round3(px + wall.nx * outsideSign * faceOff), 0.45, round3(pz + wall.nz * outsideSign * faceOff)],
          rotation: outsideSign === 1 ? wall.yaw : wall.yaw + Math.PI,
          deviceKind: 'weatherproof-gfci',
          circuitGroup: 'Outdoor GFCI',
          necRef: 'NEC 210.52(E)(1) / 210.8(A)(3)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: 'single-gang-deep',
          wireGauge: '12',
          isExterior: true,
        })

        // Interior entry wall receptacle right near front door
        addPlanned({
          name: `${doorLabel} Entry Receptacle`,
          position: [round3(px + wall.nx * insideSign * faceOff), 0.38, round3(pz + wall.nz * insideSign * faceOff)],
          rotation: insideSign === 1 ? wall.yaw : wall.yaw + Math.PI,
          deviceKind: 'duplex',
          circuitGroup: 'General Receptacles',
          necRef: 'NEC 210.52(A)',
          requiresGfci: false,
          requiresAfci: occupancy === 'residential',
          breakerAmps: occupancy === 'commercial' ? 20 : 15,
          loadVa: 180,
          boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard',
          wireGauge: occupancy === 'commercial' ? '12' : '14',
        })

        if (includeLighting) {
          // NEC 210.70(A)(2)(b): Interior wall switch controlling exterior entrance luminaire
          addPlanned({
            name: `${doorLabel} Entry Switch`,
            position: [round3(px + wall.nx * insideSign * faceOff), 1.22, round3(pz + wall.nz * insideSign * faceOff)],
            rotation: insideSign === 1 ? wall.yaw : wall.yaw + Math.PI,
            deviceKind: 'switch-1p',
            circuitGroup: 'Lighting & Entries',
            necRef: 'NEC 210.70(A)(2)(b)',
            requiresGfci: false,
            requiresAfci: occupancy === 'residential',
            breakerAmps: occupancy === 'commercial' ? 20 : 15,
            loadVa: 0,
            boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard',
            wireGauge: occupancy === 'commercial' ? '12' : '14',
          })

          addPlanned({
            name: `${doorLabel} Exterior Light`,
            // Mount exterior sconce beside door jamb (back-to-back with entry switch, clear of structural LVL door header)
            position: [
              round3(px + wall.nx * outsideSign * (faceOff + 0.04)),
              Math.min(1.92, round3(levelHeight - 0.55)),
              round3(pz + wall.nz * outsideSign * (faceOff + 0.04)),
            ],
            rotation: outsideSign === 1 ? wall.yaw : wall.yaw + Math.PI,
            deviceKind: 'luminaire',
            circuitGroup: 'Lighting & Entries',
            necRef: 'NEC 210.70(A)(2)(b)',
            requiresGfci: false,
            requiresAfci: occupancy === 'residential',
            breakerAmps: occupancy === 'commercial' ? 20 : 15,
            loadVa: 60,
            boxType: '4-oct-2.125',
            wireGauge: occupancy === 'commercial' ? '12' : '14',
            isExterior: true,
          })
        }
      }
    }

    // 2b. Walk T-junction-split unbroken wall segments for NEC 210.52(A) 6ft/12ft & 210.52(C) Kitchen 4ft rules
    const spans = wallRoomSpans(wall, walls)
    for (const [s0, s1] of spans) {
      const spanLen = s1 - s0
      const spanMidT = (s0 + s1) / 2
      const smx = wall.start[0] + wall.dx * spanMidT
      const smz = wall.start[1] + wall.dz * spanMidT

      for (const sign of [1, -1] as const) {
        const z = zoneAtPoint(zones, smx + wall.nx * sign * probeOffset, smz + wall.nz * sign * probeOffset)
        if (!z || isOutdoorCategory(z.category)) continue
        const cat = z.category
        // Bathrooms, hallways, & closets don't use 6ft/12ft wall-perimeter spacing (handled per-room below)
        if (isBathroom(cat) || isHallway(cat) || /closet/.test(cat)) continue

        const oppZone = zoneAtPoint(zones, smx - wall.nx * sign * probeOffset, smz - wall.nz * sign * probeOffset)
        const isInteriorPartition = oppZone !== null && !isOutdoorCategory(oppZone.category)
        const isOpenPlanLivingKitchen = isKitchen(cat) && /living|great|family|dining/.test(cat)
        const kit = isKitchen(cat)
        const isCountertopWall = kit && (!isOpenPlanLivingKitchen || isInteriorPartition)
        const gar = isGarage(cat)
        const laun = isLaundry(cat)
        const bsmt = isBasementOrUtility(cat)
        const maxSpacingM = isCountertopWall ? 1.22 : 3.66 // 4 ft kitchen countertop (210.52(C)) vs 12 ft habitable (210.52(A))
        const minWallM = isCountertopWall ? 0.45 : 0.61 // 24" (0.61m) wall rule
        if (spanLen < minWallM) continue
        const mountY = isCountertopWall ? 1.12 : gar ? 1.22 : 0.38
        // For garage/laundry/basement, place at most 1 receptacle per wall span (min 1 required by NEC)
        const count = gar || laun || bsmt ? 1 : Math.max(1, Math.ceil(spanLen / maxSpacingM))
        const wRule = resolveWallFramingRule(bonesCtx, wall.id)
        // Clamp stud-snap shift strictly within remaining NEC 210.52(A) 6ft/12ft or 210.52(C) 2ft/4ft slack
        const necSlackM =
          gar || laun || bsmt
            ? wRule.spacingIn * 0.0254 * 0.75
            : Math.max(0, (maxSpacingM - spanLen / count) / 2 - 0.01)
        for (let i = 0; i < count; i++) {
          const rawT = s0 + ((i + 0.5) / count) * spanLen
          const t = snapWallOffsetToStud(wall.length, rawT, {
            spanMin: s0,
            spanMax: s1,
            rule: wRule,
            maxShiftM: necSlackM,
          }).offsetM
          const wx = round3(wall.start[0] + wall.dx * t + wall.nx * sign * faceOff)
          const wz = round3(wall.start[1] + wall.dz * t + wall.nz * sign * faceOff)
          const rot = sign === 1 ? wall.yaw : wall.yaw + Math.PI

          let circuitGroup = `${z.name} Receptacles`
          let necRef = 'NEC 210.52(A)'
          let requiresGfci = false
          let requiresAfci = occupancy === 'residential' && isHabitableAfci(cat)
          let breakerAmps = occupancy === 'commercial' ? 20 : 15

          if (kit) {
            kitchenCounterIdx += 1
            // NEC 210.11(C)(1): Split kitchen countertop outlets across 2x dedicated 20A SAB circuits
            circuitGroup = kitchenCounterIdx % 2 === 1 ? 'Kitchen SAB-1 (20A)' : 'Kitchen SAB-2 (20A)'
            necRef = 'NEC 210.52(C) / 210.11(C)(1)'
            requiresGfci = true
            requiresAfci = occupancy === 'residential'
            breakerAmps = 20
          } else if (gar) {
            circuitGroup = 'Garage GFCI (20A)'
            necRef = 'NEC 210.52(G)(1) / 210.11(C)(4)'
            requiresGfci = true
            requiresAfci = false
            breakerAmps = 20
          } else if (laun) {
            circuitGroup = 'Laundry GFCI (20A)'
            necRef = 'NEC 210.52(F) / 210.11(C)(2)'
            requiresGfci = true
            requiresAfci = occupancy === 'residential'
            breakerAmps = 20
          } else if (bsmt) {
            circuitGroup = 'Basement GFCI (20A)'
            necRef = 'NEC 210.52(G)(3) / 210.8(A)(5)'
            requiresGfci = true
            requiresAfci = false
            breakerAmps = 20
          }

          addPlanned({
            name: `${z.name} ${requiresGfci ? 'GFCI' : 'Outlet'} ${i + 1}`,
            position: [wx, mountY, wz],
            rotation: rot,
            deviceKind: requiresGfci && protectionMode === 'gfci-receptacles' ? 'gfci' : 'duplex',
            circuitGroup,
            necRef,
            requiresGfci,
            requiresAfci,
            breakerAmps,
            loadVa: 180,
            boxType:
              occupancy === 'commercial'
                ? '4-sq-2.125'
                : requiresGfci
                  ? 'single-gang-deep'
                  : 'single-gang-standard',
            wireGauge: breakerAmps >= 20 ? '12' : '14',
          })
        }
      }
    }
  }

  // 3. Per-Zone Guaranteed NEC Minimums (Wall-Snapped Bathroom GFCI, Hallway Outlet, Outdoor Patio GFCI, & Room Luminaires/Switches)
  for (const z of zones) {
    const [cx, cz] = z.centroid
    const cat = z.category

    if (isOutdoorCategory(cat)) {
      // NEC 210.52(E)(3): Balcony / Deck / Patio accessible Outdoor WR GFCI mounted flush on exterior wall
      const spot = snapToZoneWall(z, { mountY: 0.45, preferExterior: true, avoidWindows: false })
      addPlanned({
        name: `${z.name} Outdoor WR GFCI`,
        position: spot.position,
        rotation: spot.rotation,
        deviceKind: 'weatherproof-gfci',
        circuitGroup: 'Outdoor GFCI',
        necRef: 'NEC 210.52(E)(3) / 210.8(A)(3)',
        requiresGfci: true,
        requiresAfci: false,
        breakerAmps: 20,
        loadVa: 180,
        boxType: 'single-gang-deep',
        wireGauge: '12',
        isExterior: true,
      })
      continue
    }

    if (isBathroom(cat)) {
      // NEC 210.52(D) & 210.11(C)(3): Dedicated 20A Bathroom GFCI receptacle mounted flush on bathroom wall (>= 3 ft clear of tub/shower per NEC 406.9(C))
      const hasExistingBathGfci = existingDevices.some((d) => {
        if (d.deviceKind !== 'gfci' && d.gfciProtected !== true) return false
        if (typeof d.name === 'string' && d.name === `${z.name} Vanity GFCI`) return true
        if (!Array.isArray(d.position) || d.position.length < 3) return false
        return pointInPolygon2D(Number(d.position[0]), Number(d.position[2]), z.polygon)
      })
      if (!hasExistingBathGfci) {
        const spot = snapToZoneWall(z, { mountY: 1.12, minTubDistM: 0.96, avoidWindows: true })
        addPlanned({
          name: `${z.name} Vanity GFCI`,
          position: spot.position,
          rotation: spot.rotation,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
          circuitGroup: 'Bathroom GFCI (20A)',
          necRef: 'NEC 210.52(D) / 210.11(C)(3)',
          requiresGfci: true,
          requiresAfci: false,
          breakerAmps: 20,
          loadVa: 180,
          boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep',
          wireGauge: '12',
        })
      }
    } else if (isHallway(cat) && Math.max(z.widthM, z.depthM) >= 2.5) {
      // NEC 210.52(H): Hallways >= 10 ft require at least one wall-mounted receptacle
      const spot = snapToZoneWall(z, { mountY: 0.38, avoidWindows: false })
      addPlanned({
        name: `${z.name} Receptacle`,
        position: spot.position,
        rotation: spot.rotation,
        deviceKind: 'duplex',
        circuitGroup: 'General Receptacles',
        necRef: 'NEC 210.52(H)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: 180,
        boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })
    }

    // NEC 210.70(A)(1): Wall-switched ceiling luminaire in every interior room (switch snapped flush to room wall beside door!)
    // Tie the primary Hallway/Living pilot light onto the Smoke/CO 15A AFCI circuit so a tripped breaker is noticed immediately (NFPA 72 A.29.9.4).
    if (includeLighting) {
      const lightingGroup =
        includeSmokeAlarms && pilotLightZone && z.id === pilotLightZone.id
          ? smokeCircuitGroup
          : 'Lighting & Entries'
      const ceilingSpotBlocked = (px: number, pz: number, y: number): boolean => {
        for (const obs of obstacles) {
          const b = obs.box
          const pad = Math.max(0.24, obs.requiredClearanceM + 0.1)
          if (
            px >= b.min[0] - pad &&
            px <= b.max[0] + pad &&
            pz >= b.min[2] - pad &&
            pz <= b.max[2] + pad &&
            b.max[1] >= Math.min(effectiveChaseY - 0.15, y - 0.35) &&
            b.min[1] <= Math.max(levelHeight + 0.15, y + 0.18)
          ) {
            return true
          }
        }
        return false
      }
      let lumX = round3(cx)
      let lumZ = round3(cz)
      if (ceilingSpotBlocked(lumX, lumZ, ceilingLightY)) {
        const lumOffsets: Array<readonly [number, number]> = [
          [0.55, 0],
          [-0.55, 0],
          [0, 0.55],
          [0, -0.55],
          [0.75, 0.55],
          [-0.75, 0.55],
          [0.75, -0.55],
          [-0.75, -0.55],
          [1.05, 0],
          [-1.05, 0],
          [0, 1.05],
          [0, -1.05],
          [1.2, 0.9],
          [-1.2, 0.9],
          [1.2, -0.9],
          [-1.2, -0.9],
          [1.75, 0],
          [-1.75, 0],
          [0, 1.75],
          [0, -1.75],
          [1.75, 1.35],
          [-1.75, 1.35],
          [1.75, -1.35],
          [-1.75, -1.35],
          [2.4, 0],
          [-2.4, 0],
          [0, 2.4],
          [0, -2.4],
          [2.4, 1.8],
          [-2.4, 1.8],
          [2.4, -1.8],
          [-2.4, -1.8],
        ]
        for (const [ox, oz] of lumOffsets) {
          const tx = round3(cx + ox)
          const tz = round3(cz + oz)
          if (!pointInPolygon2D(tx, tz, z.polygon)) continue
          if (!ceilingSpotBlocked(tx, tz, ceilingLightY)) {
            lumX = tx
            lumZ = tz
            break
          }
        }
      }
      addPlanned({
        name: `${z.name} Ceiling Light`,
        position: [lumX, ceilingLightY, lumZ],
        rotation: 0,
        deviceKind: 'luminaire',
        circuitGroup: lightingGroup,
        necRef:
          lightingGroup === smokeCircuitGroup
            ? 'NEC 210.70(A)(1) / NFPA 72 A.29.9.4'
            : 'NEC 210.70(A)(1)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: occupancy === 'commercial' ? 120 : 60,
        boxType: occupancy === 'commercial' ? '4-sq-2.125' : '4-oct-2.125',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })

      const hasExistingZoneSwitch = existingDevices.some((d) => {
        if (d.deviceKind !== 'switch-1p' && d.deviceKind !== 'switch-3way' && d.deviceKind !== 'dimmer') return false
        if (typeof d.name === 'string' && d.name === `${z.name} Wall Switch`) return true
        if (!Array.isArray(d.position) || d.position.length < 3) return false
        return pointInPolygon2D(Number(d.position[0]), Number(d.position[2]), z.polygon)
      })
      if (!bonesSwitchZoneIds.has(z.id) && !hasExistingZoneSwitch) {
        const switchSpot = snapToZoneWall(z, {
          mountY: 1.22,
          preferNearDoor: true,
          minTubDistM: isBathroom(cat) ? 0.96 : undefined,
          avoidWindows: true,
        })
        addPlanned({
          name: `${z.name} Wall Switch`,
          position: switchSpot.position,
          rotation: switchSpot.rotation,
          deviceKind: 'switch-1p',
          circuitGroup: lightingGroup,
          necRef:
            lightingGroup === smokeCircuitGroup
              ? 'NEC 210.70(A)(1) / NFPA 72 A.29.9.4'
              : 'NEC 210.70(A)(1)',
          requiresGfci: false,
          requiresAfci: occupancy === 'residential',
          breakerAmps: occupancy === 'commercial' ? 20 : 15,
          loadVa: 0,
          boxType: occupancy === 'commercial' ? '4-sq-1.5' : 'single-gang-standard',
          wireGauge: occupancy === 'commercial' ? '12' : '14',
        })
      }
    }
  }

  // 4. Stairway NEC 210.70(A)(2)(c) 3-Way Switches + Stairwell Light + Landing Receptacle
  for (let sIdx = 0; sIdx < stairs.length; sIdx++) {
    const st = stairs[sIdx]!
    const stPos: Vec3 = Array.isArray(st.position)
      ? [Number(st.position[0]), Number(st.position[1]), Number(st.position[2])]
      : [0, 0, 0]
    const stRot = typeof st.rotation === 'number' ? st.rotation : 0
    const stWidth = typeof st.width === 'number' ? st.width : 1.0
    const runLen = 2.8
    const cos = Math.cos(stRot)
    const sin = Math.sin(stRot)
    const sideOff = stWidth / 2 + 0.14
    const label = stairs.length > 1 ? `Stair ${sIdx + 1}` : 'Stairway'

    const baseWallSpot = snapPointToNearbyWall(
      stPos[0] + sideOff * cos,
      stPos[2] - sideOff * sin,
      0.38,
      stRot,
    )
    // Landing receptacle at stairway base
    addPlanned({
      name: `${label} Landing Receptacle`,
      position: baseWallSpot.position,
      rotation: baseWallSpot.rotation,
      deviceKind: 'duplex',
      circuitGroup: 'General Receptacles',
      necRef: 'NEC 210.52(A) / Stair Landing',
      requiresGfci: false,
      requiresAfci: occupancy === 'residential',
      breakerAmps: occupancy === 'commercial' ? 20 : 15,
      loadVa: 180,
      boxType: occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-standard',
      wireGauge: occupancy === 'commercial' ? '12' : '14',
    })

    if (includeLighting) {
      const botSwitchSpot = snapPointToNearbyWall(
        stPos[0] + sideOff * cos,
        stPos[2] - sideOff * sin,
        1.22,
        stRot,
      )
      // Bottom 3-way switch
      addPlanned({
        name: `${label} Bottom 3-Way Switch`,
        position: botSwitchSpot.position,
        rotation: botSwitchSpot.rotation,
        deviceKind: 'switch-3way',
        circuitGroup: 'Stairway & Hall Lighting',
        necRef: 'NEC 210.70(A)(2)(c)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: 0,
        boxType: occupancy === 'commercial' ? '4-sq-1.5' : 'single-gang-standard',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })

      const topSwitchSpot = snapPointToNearbyWall(
        stPos[0] + sideOff * cos + runLen * sin,
        stPos[2] - sideOff * sin + runLen * cos,
        1.22,
        stRot,
      )
      // Top 3-way switch
      addPlanned({
        name: `${label} Top 3-Way Switch`,
        position: topSwitchSpot.position,
        rotation: topSwitchSpot.rotation,
        deviceKind: 'switch-3way',
        circuitGroup: 'Stairway & Hall Lighting',
        necRef: 'NEC 210.70(A)(2)(c)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: 0,
        boxType: occupancy === 'commercial' ? '4-sq-1.5' : 'single-gang-standard',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })

      // Stairwell overhead light fixture
      addPlanned({
        name: `${label} Overhead Light`,
        position: [
          round3(stPos[0] + (runLen / 2) * sin),
          ceilingLightY,
          round3(stPos[2] + (runLen / 2) * cos),
        ],
        rotation: stRot,
        deviceKind: 'luminaire',
        circuitGroup: 'Stairway & Hall Lighting',
        necRef: 'NEC 210.70(A)(2)(c)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: 60,
        boxType: occupancy === 'commercial' ? '4-sq-2.125' : '4-oct-2.125',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })
    }
  }

  // 4b. IRC R314.3 / R314.4 / R315.3 & NFPA 72: Hardwired 120V Interconnected Smoke/CO Alarms
  // Placed inside every bedroom, outside sleeping areas (hallway/living), and at least 1 per residential story,
  // wired with 14/3 interconnect on a single non-GFCI 15A AFCI circuit shared with a frequently-used pilot light.
  if (includeSmokeAlarms) {
    const findCleanCeilingPoint = (z: ZoneInfo): Vec3 => {
      const smokeBlocked = (px: number, pz: number): boolean => {
        for (const obs of obstacles) {
          const b = obs.box
          const pad = Math.max(0.26, obs.requiredClearanceM + 0.1)
          if (
            px >= b.min[0] - pad &&
            px <= b.max[0] + pad &&
            pz >= b.min[2] - pad &&
            pz <= b.max[2] + pad &&
            b.max[1] >= Math.min(effectiveChaseY - 0.15, ceilingSmokeY - 0.35) &&
            b.min[1] <= Math.max(levelHeight + 0.25, ceilingSmokeY + 0.25)
          ) {
            return true
          }
        }
        return false
      }
      const offsets: Array<[number, number]> = [
        [0.65, 0],
        [-0.65, 0],
        [0, 0.65],
        [0, -0.65],
        [0.48, 0.48],
        [-0.48, -0.48],
        [1.05, 0.55],
        [-1.05, 0.55],
        [1.05, -0.55],
        [-1.05, -0.55],
        [0, 0],
      ]
      for (const [ox, oz] of offsets) {
        const px = round3(z.centroid[0] + ox)
        const pz = round3(z.centroid[1] + oz)
        if (!pointInPolygon2D(px, pz, z.polygon)) continue
        const pos: Vec3 = [px, ceilingSmokeY, pz]
        if (!isNearExisting(pos, 0, 0.45) && !smokeBlocked(px, pz)) return pos
      }
      return [round3(z.centroid[0] + 0.55), ceilingSmokeY, round3(z.centroid[1])]
    }

    const existingSmokeAlarms = existingDevices.filter((d) => d.deviceKind === 'smoke-co')
    const zoneHasExistingSmoke = (z: ZoneInfo): boolean =>
      existingSmokeAlarms.some((d) => {
        if (!Array.isArray(d.position) || d.position.length < 3) return false
        return pointInPolygon2D(Number(d.position[0]), Number(d.position[2]), z.polygon)
      })

    const smokeTargetZones: Array<{ zone: ZoneInfo; label: string; necRef: string }> = []
    const addedZoneIds = new Set<string>()

    // 1. Inside every bedroom / sleeping room (IRC R314.3(1))
    for (const z of interiorZones) {
      if (!isBedroom(z.category)) continue
      if (zoneHasExistingSmoke(z)) continue
      smokeTargetZones.push({
        zone: z,
        label: `${z.name} Smoke/CO Alarm`,
        necRef: 'IRC R314.3(1) / R314.4 / NEC 210.12(A)',
      })
      addedZoneIds.add(z.id)
    }

    // 2. Outside sleeping area in immediate vicinity (Hallway / Living / Common pilot zone, IRC R314.3(2) & R315.3)
    if (pilotLightZone && !addedZoneIds.has(pilotLightZone.id) && !zoneHasExistingSmoke(pilotLightZone)) {
      smokeTargetZones.push({
        zone: pilotLightZone,
        label: `${pilotLightZone.name} Smoke/CO Alarm`,
        necRef: 'IRC R314.3(2) / R315.3 / NFPA 72 A.29.9.4',
      })
      addedZoneIds.add(pilotLightZone.id)
    }

    // 3. Story-minimum guarantee (IRC R314.3(3)): at least 1 hardwired smoke/CO alarm per residential level
    if (smokeTargetZones.length === 0 && existingSmokeAlarms.length === 0) {
      const fallbackZone = [...interiorZones]
        .filter((z) => !isBathroom(z.category) && !isKitchen(z.category) && !/closet/.test(z.category))
        .sort((a, b) => b.areaM2 - a.areaM2)[0]
      if (fallbackZone) {
        smokeTargetZones.push({
          zone: fallbackZone,
          label: `${fallbackZone.name} Smoke/CO Alarm`,
          necRef: 'IRC R314.3(3) / R315.3 / NEC 210.12(A)',
        })
      }
    }

    for (const target of smokeTargetZones) {
      addPlanned({
        name: target.label,
        position: findCleanCeilingPoint(target.zone),
        rotation: 0,
        deviceKind: 'smoke-co',
        circuitGroup: smokeCircuitGroup,
        necRef: target.necRef,
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: 15,
        loadVa: 25,
        boxType: '4-oct-2.125',
        wireGauge: '14',
      })
    }
  }

  // Guarantee at least 1 Outdoor WR GFCI even if a minimal floorplan has no exterior doors/patio zones tagged yet
  if (exteriorDoorCount === 0 && !planned.some((p) => p.circuitGroup === 'Outdoor GFCI') && walls.length > 0) {
    const w0 = walls[0]!
    const extOff = w0.thickness / 2 + WALL_DEVICE_OFFSET_M
    let outX = round3((w0.start[0] + w0.end[0]) / 2 - w0.nx * extOff)
    let outZ = round3((w0.start[1] + w0.end[1]) / 2 - w0.nz * extOff)
    // Stay clear of exterior Plumbing hose-bibb vertical supply risers (typically placed at wall midpoint)
    const exteriorSpotBlocked = (px: number, pz: number): boolean =>
      obstacles.some((obs) => {
        if (obs.trade !== 'plumbing' && obs.trade !== 'hvac') return false
        const b = obs.box
        const pad = Math.max(0.28, obs.requiredClearanceM + 0.12)
        return (
          px >= b.min[0] - pad &&
          px <= b.max[0] + pad &&
          pz >= b.min[2] - pad &&
          pz <= b.max[2] + pad &&
          b.max[1] >= 0 &&
          b.min[1] <= effectiveChaseY + 0.2
        )
      })
    if (exteriorSpotBlocked(outX, outZ)) {
      const midAlong = w0.length / 2
      for (const shift of [0.75, -0.75, 1.35, -1.35, 2.0, -2.0]) {
        const a = midAlong + shift
        if (a < 0.4 || a > w0.length - 0.4) continue
        const tx = round3(w0.start[0] + w0.dx * a - w0.nx * extOff)
        const tz = round3(w0.start[1] + w0.dz * a - w0.nz * extOff)
        if (!exteriorSpotBlocked(tx, tz)) {
          outX = tx
          outZ = tz
          break
        }
      }
    }
    addPlanned({
      name: 'Front Exterior WR GFCI',
      position: [outX, 0.45, outZ],
      rotation: w0.yaw + Math.PI,
      deviceKind: 'weatherproof-gfci',
      circuitGroup: 'Outdoor GFCI',
      necRef: 'NEC 210.52(E)(1) / 210.8(A)(3)',
      requiresGfci: true,
      requiresAfci: false,
      breakerAmps: 20,
      loadVa: 180,
      boxType: 'single-gang-deep',
      wireGauge: '12',
      isExterior: true,
    })
  }
  }

  // 5. Group Devices into NEC Branch Circuits (<= 10 devices per circuit), Order Nearest-Neighbor Chain,
  //    Assign Balanced Panel Circuits, & Route Home Runs + Outlet-to-Outlet Daisy-Chain Runs!
  const rawGroups = new Map<string, typeof planned>()
  for (const dev of planned) {
    const list = rawGroups.get(dev.circuitGroup) ?? []
    list.push(dev)
    rawGroups.set(dev.circuitGroup, list)
  }

  // Split large groups > 10 devices into sub-circuits (e.g., Living Room Receptacles #1, #2).
  // Never split interconnected Smoke/CO alarm circuits so all alarms stay interconnected on one 15A AFCI circuit (IRC R314.4).
  const circuitBuckets: Array<{ groupName: string; items: typeof planned }> = []
  for (const [groupName, items] of rawGroups.entries()) {
    const isSmokeBucket = groupName.startsWith('Smoke/CO')
    const maxPerCircuit = isSmokeBucket ? Math.max(12, items.length) : 10
    for (let i = 0; i < items.length; i += maxPerCircuit) {
      const chunk = items.slice(i, i + maxPerCircuit)
      const suffix = items.length > maxPerCircuit ? ` (${Math.floor(i / maxPerCircuit) + 1})` : ''
      circuitBuckets.push({ groupName: `${groupName}${suffix}`, items: chunk })
    }
  }

  const assignedDevices: PlannedDeviceSpec[] = []
  const plannedRuns: PlannedRunSpec[] = []
  const circuitSummary: AutoPopulatePlan['circuitSummary'] = []
  // Include ALL devices across every level assigned to `panelNode.id` so multi-level panels
  // never collide on existing circuit slots or distort phase balance (NEC 220.61).
  const panelAllDevices = all.filter(
    (n) => n.type === 'electrical:device' && n.panelId === panelNode!.id,
  )
  const seenDeviceIds = new Set(panelAllDevices.map((d) => d.id))
  const virtualDeviceList: SceneNodeLike[] = [
    ...panelAllDevices,
    ...existingDevices.filter((d) => !seenDeviceIds.has(d.id)),
  ]
  const panelTopPt: Vec3 = [panelPos[0], panelPos[1] + panelHeight / 2, panelPos[2]]
  const vLN = getVoltageLineToNeutral(panelVoltageSystem)
  const isThreePhasePanel = panelVoltageSystem !== '120/240V-1P'
  const phaseCount = isThreePhasePanel ? 3 : 2
  const maxPanelSpaces = Math.min(
    84,
    Math.max(4, Math.ceil((typeof panelNode.spaces === 'number' ? panelNode.spaces : 40) / 2) * 2),
  )

  // Seed phase load accumulator from ALL existing devices on this panel across every level (NEC 220.61)
  const phaseLoadVa = new Array<number>(phaseCount).fill(0)
  for (const d of panelAllDevices) {
    if (d.panelId !== panelNode.id) continue
    const ckt = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
    if (ckt <= 0) continue
    const poles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
    const vaPerPole = (typeof d.loadVa === 'number' ? d.loadVa : 180) / poles
    for (let p = 0; p < poles; p++) {
      const rowIdx = Math.floor((ckt + p * 2 - 1) / 2)
      phaseLoadVa[rowIdx % phaseCount] = (phaseLoadVa[rowIdx % phaseCount] ?? 0) + vaPerPole
    }
  }

  const pickBalancedFreeCircuit = (loadVa: number, poles: 1 | 2 | 3 = 1): number => {
    const occupied = new Set<number>()
    for (const d of virtualDeviceList) {
      if (d.panelId !== panelNode!.id) continue
      const c = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
      if (c <= 0) continue
      const dPoles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
      for (let p = 0; p < dPoles; p++) occupied.add(c + p * 2)
    }

    if (poles === 3) {
      for (let slot = 1; slot + 4 <= maxPanelSpaces; slot++) {
        if (occupied.has(slot) || occupied.has(slot + 2) || occupied.has(slot + 4)) continue
        for (let p = 0; p < 3; p++) {
          const ph = (Math.floor((slot - 1) / 2) + p) % phaseCount
          phaseLoadVa[ph] = (phaseLoadVa[ph] ?? 0) + loadVa / 3
        }
        return slot
      }
      const fallback = findNextFreePanelCircuit(panelNode, virtualDeviceList, 3)
      for (let p = 0; p < 3; p++) {
        const ph = (Math.floor((fallback - 1) / 2) + p) % phaseCount
        phaseLoadVa[ph] = (phaseLoadVa[ph] ?? 0) + loadVa / 3
      }
      return fallback
    }

    if (poles === 2) {
      let bestSlot: number | null = null
      let bestScore = Infinity
      for (let slot = 1; slot + 2 <= maxPanelSpaces; slot++) {
        if (occupied.has(slot) || occupied.has(slot + 2)) continue
        const p0 = Math.floor((slot - 1) / 2) % phaseCount
        const p1 = (p0 + 1) % phaseCount
        const score = (phaseLoadVa[p0] ?? 0) + (phaseLoadVa[p1] ?? 0)
        if (score < bestScore) {
          bestScore = score
          bestSlot = slot
        }
      }
      if (bestSlot !== null) {
        const p0 = Math.floor((bestSlot - 1) / 2) % phaseCount
        const p1 = (p0 + 1) % phaseCount
        phaseLoadVa[p0] = (phaseLoadVa[p0] ?? 0) + loadVa / 2
        phaseLoadVa[p1] = (phaseLoadVa[p1] ?? 0) + loadVa / 2
        return bestSlot
      }
      const fallback = findNextFreePanelCircuit(panelNode, virtualDeviceList, 2)
      const fb0 = Math.floor((fallback - 1) / 2) % phaseCount
      const fb1 = (fb0 + 1) % phaseCount
      phaseLoadVa[fb0] = (phaseLoadVa[fb0] ?? 0) + loadVa / 2
      phaseLoadVa[fb1] = (phaseLoadVa[fb1] ?? 0) + loadVa / 2
      return fallback
    }

    // Order phases lightest-first
    const phaseOrder = Array.from({ length: phaseCount }, (_, i) => i).sort(
      (a, b) => (phaseLoadVa[a] ?? 0) - (phaseLoadVa[b] ?? 0),
    )
    for (const targetPhase of phaseOrder) {
      for (let slot = 1; slot <= maxPanelSpaces; slot++) {
        if (occupied.has(slot)) continue
        const rowIdx = Math.floor((slot - 1) / 2)
        if (rowIdx % phaseCount === targetPhase) {
          phaseLoadVa[targetPhase] = (phaseLoadVa[targetPhase] ?? 0) + loadVa
          return slot
        }
      }
    }
    const fallback = findNextFreePanelCircuit(panelNode, virtualDeviceList, 1)
    const fbPhase = Math.floor((fallback - 1) / 2) % phaseCount
    phaseLoadVa[fbPhase] = (phaseLoadVa[fbPhase] ?? 0) + loadVa
    return fallback
  }

  // Sort buckets descending by VA (LPT heuristic) for tight phase balance across L1/L2 or A/B/C
  circuitBuckets.sort(
    (a, b) =>
      b.items.reduce((s, d) => s + d.loadVa, 0) - a.items.reduce((s, d) => s + d.loadVa, 0),
  )

  let runSeq = 1
  let totalAvoided = 0
  let circuitIndex = 0
  const panelRotY = typeof panelNode.rotation === 'number' && Number.isFinite(panelNode.rotation) ? panelNode.rotation : 0
  const chaseBandTop = round3(Math.min(effectiveChaseY, levelHeight - 0.12))
  const chaseBandBot = round3(Math.max(1.85, Math.min(chaseBandTop - 0.1, levelHeight - 0.34)))
  const laneBaseChaseY = round3(chaseBandTop - 0.048)

  for (const bucket of circuitBuckets) {
    if (bucket.items.length === 0) continue

    // VIS-02: Deterministic per-circuit vertical + lateral lane offsets so parallel conduit runs sit cleanly
    // side-by-side without coplanar barber-pole Z-fighting, while staying inside safe ceiling & wall-cavity bounds.
    const laneOffsetY = round3(((circuitIndex % 5) - 2) * 0.022)
    const circuitChaseY = round3(
      Math.max(chaseBandBot, Math.min(chaseBandTop, laneBaseChaseY + laneOffsetY)),
    )
    const lateralBucket = Math.floor(circuitIndex / 5) % 3
    // Keep lateral wall-chase stagger <= 0.014 m so even outer wall corners (sqrt(2) * 0.014 = 0.0198 m) stay inside stud wall cavity (<= 0.02 m)
    const circuitLaneLateralM = lateralBucket === 0 ? 0 : lateralBucket === 1 ? 0.014 : -0.014
    const circuitCavities = {
      ...cavities,
      atticY: round3(cavities.atticY + (circuitIndex % 5) * 0.022),
      crawlSpaceY: round3(cavities.crawlSpaceY - (circuitIndex % 5) * 0.022),
    }
    const knockoutOffM = round3((((circuitIndex % 7) - 3) / 3) * 0.12)
    const panelStartPt: Vec3 = [
      round3(panelTopPt[0] + Math.cos(panelRotY) * knockoutOffM),
      panelTopPt[1],
      round3(panelTopPt[2] - Math.sin(panelRotY) * knockoutOffM),
    ]
    circuitIndex += 1

    const circuitPoles: 1 | 2 | 3 = bucket.items.some((d) => d.poles === 3)
      ? 3
      : bucket.items.some((d) => d.poles === 2)
        ? 2
        : 1
    const breakerAmps = Math.max(...bucket.items.map((d) => d.breakerAmps))
    const anyGfci = bucket.items.some((d) => d.requiresGfci)
    const anyAfci = bucket.items.some((d) => d.requiresAfci)
    const totalLoadVa = bucket.items.reduce((s, d) => s + d.loadVa, 0)
    const voltage = circuitPoles >= 2 ? getVoltageLineToLine(panelVoltageSystem) : vLN
    const circuitLoadAmps = Math.max(
      1,
      Math.round((totalLoadVa / (circuitPoles === 3 ? voltage * Math.sqrt(3) : voltage)) * 100) / 100,
    )
    const ckt = pickBalancedFreeCircuit(totalLoadVa, circuitPoles)

    // Order chain: start with device closest to panel, then greedy nearest-neighbor outlet-to-outlet!
    // For Smoke/CO & Lighting circuits, route constant hot through the pilot switch/light first,
    // then chain all Smoke/CO alarms consecutively via 14/3 interconnect cable (IRC R314.4).
    const hasSmokeInBucket = bucket.items.some((d) => d.deviceKind === 'smoke-co')
    const orderNearest = (list: typeof planned, startPt: Vec3): typeof planned => {
      if (list.length === 0) return []
      const pool = [...list]
      pool.sort((a, b) => dist3D(startPt, a.position) - dist3D(startPt, b.position))
      const out: typeof planned = [pool.shift()!]
      while (pool.length > 0) {
        const tail = out[out.length - 1]!
        let bestIdx = 0
        let bestDist = Infinity
        for (let i = 0; i < pool.length; i++) {
          const d = dist3D(tail.position, pool[i]!.position)
          if (d < bestDist) {
            bestDist = d
            bestIdx = i
          }
        }
        out.push(pool.splice(bestIdx, 1)[0]!)
      }
      return out
    }
    const ordered: typeof planned = hasSmokeInBucket
      ? (() => {
          const pilotLighting = bucket.items.filter((d) => d.deviceKind !== 'smoke-co')
          const smokeAlarms = bucket.items.filter((d) => d.deviceKind === 'smoke-co')
          const orderedPilot = orderNearest(pilotLighting, panelTopPt)
          const smokeStart =
            orderedPilot.length > 0 ? orderedPilot[orderedPilot.length - 1]!.position : panelTopPt
          return [...orderedPilot, ...orderNearest(smokeAlarms, smokeStart)]
        })()
      : orderNearest(bucket.items, panelTopPt)

    // Pre-route Home Run & Daisy-Chain Hops so final voltage-drop / ampacity wireGauge propagates to EVERY device box!
    const anyContinuous = ordered.some((d) => d.continuous)
    const phases: 1 | 3 = circuitPoles === 3 ? 3 : 1
    let circuitWireGauge: WireGauge = minWireGaugeForBreakerAmps(breakerAmps)
    let tradeSize: ConduitTradeSize = '3/4"'

    const obstaclesForTarget = (ignoreIds: readonly (string | undefined)[]) => {
      const skip = new Set(ignoreIds.filter((v): v is string => typeof v === 'string' && v.length > 0))
      return skip.size > 0 ? obstacles.filter((o) => !skip.has(o.nodeId)) : obstacles
    }

    const hrRoute = (() => {
      if (!includeWiring || ordered.length === 0) return null
      const hrObs = obstaclesForTarget([ordered[0]!.mepSourceNodeId])
      const hrOpts = {
        preferredChaseY: circuitChaseY,
        clearanceM: 0.05,
        walls: routingWalls,
        racewayType,
        wireGauge: circuitWireGauge,
        cavities: circuitCavities,
        routingStrategy,
        laneOffsetLateralM: circuitLaneLateralM,
      }
      const koRoute = routeElectricalRun(panelStartPt, ordered[0]!.position, hrObs, hrOpts)
      if (koRoute.remainingClashes.length === 0 || knockoutOffM === 0) return koRoute
      const centerRoute = routeElectricalRun(panelTopPt, ordered[0]!.position, hrObs, hrOpts)
      return centerRoute.remainingClashes.length < koRoute.remainingClashes.length ? centerRoute : koRoute
    })()
    const hopRoutes: Array<ReturnType<typeof routeElectricalRun>> = []
    if (includeWiring && ordered.length > 1) {
      for (let i = 0; i < ordered.length - 1; i++) {
        const fromDev = ordered[i]!
        const toDev = ordered[i + 1]!
        hopRoutes.push(
          routeElectricalRun(
            fromDev.position,
            toDev.position,
            obstaclesForTarget([fromDev.mepSourceNodeId, toDev.mepSourceNodeId]),
            {
              preferredChaseY: circuitChaseY,
              clearanceM: 0.05,
              walls: routingWalls,
              racewayType,
              wireGauge: circuitWireGauge,
              cavities: circuitCavities,
              routingStrategy,
              laneOffsetLateralM: circuitLaneLateralM,
            },
          ),
        )
      }
    }

    if (hrRoute) {
      // Distributed-load voltage drop centroid: full home-run distance plus half of the daisy-chain span
      const effectiveDropFt =
        hrRoute.routedLengthFt + 0.5 * hopRoutes.reduce((sum, r) => sum + r.routedLengthFt, 0)
      const ampGauge = recommendWireGauge({
        material: 'cu',
        insulationRating: '90C',
        racewayType,
        ambientTempC: 30,
        currentCarryingCount: circuitPoles === 3 ? 3 : 2,
        loadAmps: circuitLoadAmps,
        continuousLoad: anyContinuous,
        breakerAmps,
      })
      const vdCheck = calculateVoltageDrop({
        wireGauge: ampGauge,
        material: 'cu',
        loadAmps: circuitLoadAmps,
        oneWayLengthFt: effectiveDropFt,
        voltage,
        phases,
        maxDropPct: 3.0,
      })
      circuitWireGauge = largerGauge(largerGauge(circuitWireGauge, ampGauge), vdCheck.recommendedGauge)

      if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
        const fill = calculateConduitFill({
          conduitType: racewayType,
          tradeSize: '3/4"',
          conductors: [{ gauge: circuitWireGauge, count: circuitPoles === 3 ? 4 : 3 }],
          lengthInches: hrRoute.routedLengthM * METERS_TO_FEET * 12,
        })
        if (!fill.compliant) tradeSize = fill.recommendedTradeSize
      }
    }

    // Materialize finalized PlannedDeviceSpecs using final circuitWireGauge & NEC 314.16 box-fill check
    const boxFillGauge: BoxFillGauge = clampToBoxFillGauge(circuitWireGauge)
    const circuitDevices: PlannedDeviceSpec[] = ordered.map((item, idx) => {
      const isFirstInChain = idx === 0
      const isLastInChain = idx === ordered.length - 1
      // Hybrid mode: first receptacle on a wet circuit is a physical GFCI outlet protecting downstream LOAD outlets!
      const makePhysicalGfci =
        anyGfci &&
        (item.deviceKind === 'duplex' || item.deviceKind === 'gfci') &&
        (protectionMode === 'gfci-receptacles' || (protectionMode === 'hybrid' && isFirstInChain))
      const deviceKind = makePhysicalGfci ? 'gfci' : item.deviceKind
      const isSmoke = deviceKind === 'smoke-co'
      const prevIsSmoke = idx > 0 && ordered[idx - 1]!.deviceKind === 'smoke-co'
      const nextIsSmoke = !isLastInChain && ordered[idx + 1]!.deviceKind === 'smoke-co'
      // 14/3 interconnect cables between smoke alarms carry 3 insulated conductors (Hot + Neutral + Red Interconnect)
      const incomingCond = isSmoke && prevIsSmoke ? 3 : item.poles === 3 ? 3 : 2
      const outgoingCond = isLastInChain ? 0 : isSmoke && nextIsSmoke ? 3 : item.poles === 3 ? 3 : 2
      const conductorCount = incomingCond + outgoingCond
      let boxType: BoxType = item.boxType
      if (
        makePhysicalGfci &&
        (boxType === 'single-gang-shallow' || boxType === 'single-gang-standard')
      ) {
        boxType = 'single-gang-deep'
      } else if (conductorCount >= 4 && boxType === 'single-gang-shallow') {
        boxType = 'single-gang-standard'
      }
      const boxCheck = calculateBoxFill({
        boxType,
        conductors: [{ gauge: boxFillGauge, count: conductorCount }],
        deviceYokeCount: isZeroYokeDeviceKind(deviceKind) ? 0 : 1,
        internalClampCount: 1,
        equipmentGroundCount: 1,
      })
      if (!boxCheck.compliant) {
        boxType = boxCheck.recommendedBoxType
      }

      const spec: PlannedDeviceSpec = {
        ...item,
        deviceKind,
        breakerAmps,
        wireGauge: circuitWireGauge,
        boxType,
        conductorCount,
        panelId: panelNode!.id,
        circuitNumber: ckt,
        gfciProtected: anyGfci,
        afciProtected: anyAfci,
      }
      assignedDevices.push(spec)
      virtualDeviceList.push({
        id: spec.tempId,
        type: 'electrical:device',
        panelId: spec.panelId,
        circuitNumber: spec.circuitNumber,
        poles: spec.poles,
        breakerAmps: spec.breakerAmps,
        loadVa: spec.loadVa,
      })
      return spec
    })

    let homeRunCount = 0
    let daisyChainCount = 0

    if (includeWiring && hrRoute && circuitDevices.length > 0) {
      const firstDev = circuitDevices[0]!
      totalAvoided += hrRoute.avoidedObstacles.length

      // A. HOME RUN: Panel -> First Device on circuit (yielding around all Plumbing, HVAC, Structural)
      plannedRuns.push({
        tempId: `auto_run_${runSeq++}`,
        name: `CKT-${ckt} Home Run (${bucket.groupName})`,
        runKind: 'home-run',
        panelId: panelNode!.id,
        fromNodeId: panelNode!.id,
        targetDeviceId: firstDev.tempId,
        circuitNumber: ckt,
        occupancy,
        racewayType,
        tradeSize,
        wireGauge: circuitWireGauge,
        currentCarryingCount: circuitPoles === 3 ? 3 : 2,
        totalConductorCount: circuitPoles === 3 ? 4 : 3,
        loadAmps: circuitLoadAmps,
        continuous: anyContinuous,
        voltage,
        phases,
        path: hrRoute.path,
        avoidedObstaclesCount: hrRoute.avoidedObstacles.length,
        routingMode: hrRoute.routingMode,
        necNotes: hrRoute.necNotes,
        preferredChaseY: circuitChaseY,
        laneOffsetLateralM: circuitLaneLateralM,
        atticY: circuitCavities.atticY,
        crawlSpaceY: circuitCavities.crawlSpaceY,
        wallPlacement: 'in-wall',
      })
      homeRunCount = 1

      // B. DAISY-CHAIN BRANCH RUNS: Device 1 -> Device 2 -> ... -> Device N (outlet-to-outlet / 14/3 smoke interconnect!)
      for (let i = 0; i < circuitDevices.length - 1; i++) {
        const fromDev = circuitDevices[i]!
        const toDev = circuitDevices[i + 1]!
        const hopRoute = hopRoutes[i]!
        totalAvoided += hopRoute.avoidedObstacles.length
        const isSmokeInterconnect =
          fromDev.deviceKind === 'smoke-co' && toDev.deviceKind === 'smoke-co'

        plannedRuns.push({
          tempId: `auto_run_${runSeq++}`,
          name: isSmokeInterconnect
            ? `CKT-${ckt} Interconnect ${circuitWireGauge}/3 (${fromDev.name} -> ${toDev.name})`
            : `CKT-${ckt} Branch (${fromDev.name} -> ${toDev.name})`,
          runKind: 'daisy-chain',
          panelId: panelNode!.id,
          fromNodeId: fromDev.tempId,
          targetDeviceId: toDev.tempId,
          circuitNumber: ckt,
          occupancy,
          racewayType,
          tradeSize,
          wireGauge: circuitWireGauge,
          currentCarryingCount: circuitPoles === 3 ? 3 : 2,
          totalConductorCount: isSmokeInterconnect ? 4 : circuitPoles === 3 ? 4 : 3,
          loadAmps: Math.max(1, Math.round(((circuitLoadAmps * (circuitDevices.length - i - 1)) / circuitDevices.length) * 100) / 100),
          continuous: anyContinuous,
          voltage,
          phases,
          path: hopRoute.path,
          avoidedObstaclesCount: hopRoute.avoidedObstacles.length,
          routingMode: hopRoute.routingMode,
          necNotes: hopRoute.necNotes,
          preferredChaseY: circuitChaseY,
          laneOffsetLateralM: circuitLaneLateralM,
          atticY: circuitCavities.atticY,
          crawlSpaceY: circuitCavities.crawlSpaceY,
          wallPlacement: 'in-wall',
        })
        daisyChainCount += 1
      }
    }

    const protLabel = [
      anyAfci ? 'AFCI' : '',
      anyGfci && (protectionMode === 'gfci-breakers' || circuitPoles >= 2) ? 'GFCI' : '',
    ]
      .filter(Boolean)
      .join('/')

    circuitSummary.push({
      circuitNumber: ckt,
      groupName: bucket.groupName,
      breakerSpec: `${circuitPoles}P-${breakerAmps}A${protLabel ? ` ${protLabel}` : ''}`,
      wireGauge: circuitWireGauge,
      deviceCount: circuitDevices.length,
      homeRunCount,
      daisyChainCount,
    })
  }

  return {
    panelId: panelNode.id,
    createdPanel,
    devices: assignedDevices,
    runs: plannedRuns,
    circuitSummary,
    summary: {
      panelCreated: createdPanel !== null,
      devicesPlanned: assignedDevices.length,
      circuitsCreated: circuitSummary.length,
      homeRunsPlanned: plannedRuns.filter((r) => r.runKind === 'home-run').length,
      daisyChainRunsPlanned: plannedRuns.filter((r) => r.runKind === 'daisy-chain').length,
      obstaclesAvoided: totalAvoided,
      bonesDevicesImported,
      bonesServicesImported,
      bonesUserMovedPreserved,
    },
  }
}

// ─── Single-Device Wall Placement & Auto-Connect (Join Room Run OR New Home Run) ─

export type AutoConnectDeviceDraft = {
  id: string
  name: string
  position: Vec3
  rotation?: number
  deviceKind: string
  occupancy: OccupancyType
  panelId?: string
  circuitNumber?: number
  poles: 1 | 2 | 3
  breakerAmps: number
  loadVa: number
  continuous: boolean
  gfciProtected: boolean
  afciProtected: boolean
  boxType: BoxType
  wireGauge: WireGauge
  conductorCount: number
}

export type PlannedDeviceConnectionRun = {
  name: string
  runKind: 'home-run' | 'daisy-chain'
  panelId: string
  fromNodeId: string
  targetDeviceId: string
  circuitNumber: number
  occupancy: OccupancyType
  racewayType: RacewayType
  tradeSize: ConduitTradeSize
  wireGauge: WireGauge
  currentCarryingCount: number
  totalConductorCount: number
  loadAmps: number
  continuous: boolean
  voltage: number
  phases: 1 | 3
  path: Vec3[]
  avoidedObstaclesCount: number
  routingMode?: RoutingMode
  necNotes?: string[]
  preferredChaseY?: number
  laneOffsetLateralM?: number
  atticY?: number
  crawlSpaceY?: number
  wallPlacement?: 'in-wall' | 'surface'
}

export type DeviceAutoConnectionPlan = {
  mode: 'joined-existing-run' | 'new-home-run' | 'none'
  panelId: string | null
  circuitNumber: number
  breakerAmps: number
  wireGauge: WireGauge
  gfciProtected: boolean
  afciProtected: boolean
  boxType: BoxType
  conductorCount: number
  roomName: string | null
  connectedFromNodeId: string | null
  connectedFromName: string | null
  run: PlannedDeviceConnectionRun | null
  anchorDevicePatch: {
    id: string
    patch: {
      conductorCount: number
      boxType: BoxType
    }
  } | null
}

function deviceFamilyOf(kind: string): 'receptacle' | 'lighting' | 'junction' | 'dedicated' {
  if (
    kind === 'duplex' ||
    kind === 'gfci' ||
    kind === 'afci' ||
    kind === 'usb-duplex' ||
    kind === 'weatherproof-gfci' ||
    kind === 'floor-box'
  ) {
    return 'receptacle'
  }
  if (
    kind === 'switch-1p' ||
    kind === 'switch-3way' ||
    kind === 'dimmer' ||
    kind === 'luminaire' ||
    kind === 'exit-sign' ||
    kind === 'ceiling-fan' ||
    kind === 'smoke-co' ||
    kind === 'under-cabinet-led'
  ) {
    return 'lighting'
  }
  if (kind === 'junction-box') return 'junction'
  return 'dedicated'
}

function resolveZoneNearPoint(
  zones: readonly ZoneInfo[],
  pos: Vec3,
  rotation = 0,
): ZoneInfo | null {
  const exact = zoneAtPoint(zones, pos[0], pos[2])
  if (exact) return exact
  // Wall-mounted devices can sit right on the polygon boundary; probe slightly inward along facing normal
  const fx = Math.sin(rotation)
  const fz = Math.cos(rotation)
  for (const dist of [0.22, -0.22, 0.4, -0.4]) {
    const probed = zoneAtPoint(zones, pos[0] + fx * dist, pos[2] + fz * dist)
    if (probed) return probed
  }
  for (const [dx, dz] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]] as const) {
    const probed = zoneAtPoint(zones, pos[0] + dx, pos[2] + dz)
    if (probed) return probed
  }
  return null
}

function pickPhaseBalancedCircuit(
  panelNode: SceneNodeLike,
  existingDevices: readonly SceneNodeLike[],
  poles: 1 | 2 | 3,
  loadVa: number,
): number {
  if (poles > 1) {
    return findNextFreePanelCircuit(panelNode, existingDevices, poles)
  }
  const voltageSystem: VoltageSystem =
    panelNode.voltageSystem === '120/208V-3P' || panelNode.voltageSystem === '277/480V-3P'
      ? panelNode.voltageSystem
      : '120/240V-1P'
  const phaseCount = voltageSystem !== '120/240V-1P' ? 3 : 2
  const maxSpaces = Math.min(
    84,
    Math.max(4, Math.ceil((typeof panelNode.spaces === 'number' ? panelNode.spaces : 40) / 2) * 2),
  )
  const occupied = new Set<number>()
  const phaseVa = new Array<number>(phaseCount).fill(0)

  for (const d of existingDevices) {
    if (d.panelId !== panelNode.id) continue
    const c = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
    if (c <= 0) continue
    const dPoles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
    const vaPerPole = (typeof d.loadVa === 'number' ? d.loadVa : 180) / dPoles
    for (let p = 0; p < dPoles; p++) {
      occupied.add(c + p * 2)
      const rowIdx = Math.floor((c + p * 2 - 1) / 2)
      phaseVa[rowIdx % phaseCount] = (phaseVa[rowIdx % phaseCount] ?? 0) + vaPerPole
    }
  }

  const phaseOrder = Array.from({ length: phaseCount }, (_, i) => i).sort(
    (a, b) => (phaseVa[a] ?? 0) - (phaseVa[b] ?? 0),
  )
  for (const targetPhase of phaseOrder) {
    for (let slot = 1; slot <= maxSpaces; slot++) {
      if (occupied.has(slot)) continue
      const rowIdx = Math.floor((slot - 1) / 2)
      if (rowIdx % phaseCount === targetPhase) {
        phaseVa[targetPhase] = (phaseVa[targetPhase] ?? 0) + loadVa
        return slot
      }
    }
  }
  return findNextFreePanelCircuit(panelNode, existingDevices, 1)
}

/**
 * Find the next clean flush wall-mounted position for a manually placed electrical device
 * (prioritizing `preferredZoneId` when the user has selected a room in Pascal Editor).
 */
export function findNextWallPlacement(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null,
  options: {
    deviceKind?: string
    preferredZoneId?: string | null
  } = {},
): { position: Vec3; rotation: number; zoneName: string | null } {
  const all = Object.values(nodes)
  const walls = extractWalls(nodes, levelId)
  const zones = extractZones(nodes, levelId)
  const tubBoxes = extractTubBoxes(nodes, levelId)
  const existingDevices = all.filter(
    (n) => n.type === 'electrical:device' && belongsToLevel(nodes, n, levelId),
  )
  const rawLevelHeight = resolveLevelHeightM(nodes, levelId)
  const safeLevelHeight = Number.isFinite(rawLevelHeight) && rawLevelHeight > 0.5 ? rawLevelHeight : 2.5
  const kind = options.deviceKind ?? 'duplex'
  const mountY =
    kind === 'motor-load' || kind === 'floor-box'
      ? 0
      : kind === 'luminaire'
        ? round3(Math.max(2.1, safeLevelHeight - 0.04))
        : kind === 'smoke-co'
          ? round3(Math.max(2.1, safeLevelHeight - 0.03))
          : kind === 'ceiling-fan'
            ? round3(Math.max(2.1, safeLevelHeight - 0.16))
            : kind === 'junction-box'
              ? round3(Math.max(1.2, Math.min(2.45, safeLevelHeight - 0.1)))
              : kind === 'spd'
                ? 1.52
                : kind === 'solar-inverter' || kind === 'transfer-switch' || kind === 'rapid-shutdown' || kind === 'vfd'
                  ? 1.45
                  : kind === 'under-cabinet-led'
                    ? 1.32
                    : kind === 'switch-1p' || kind === 'switch-3way' || kind === 'dimmer'
                      ? 1.22
                      : kind === 'battery-ess'
                        ? 1.15
                        : kind === 'evse' || kind === 'gfci'
                          ? 1.12
                          : kind === 'generator-inlet'
                            ? 0.65
                            : kind === 'weatherproof-gfci'
                              ? 0.45
                              : 0.38
  const enforceTubClearance =
    kind !== 'luminaire' &&
    kind !== 'junction-box' &&
    kind !== 'ceiling-fan' &&
    kind !== 'smoke-co'

  const isOccupied = (pos: Vec3, rot: number): boolean => {
    for (const d of existingDevices) {
      if (!Array.isArray(d.position) || d.position.length < 3) continue
      const ep: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
      const eRot = typeof d.rotation === 'number' ? d.rotation : 0
      if (dist3D(ep, pos) < 0.52 && Math.cos(eRot - rot) > 0.25) return true
    }
    return false
  }

  // Room-interior placement for ceiling-centered fixtures (ceiling-fan, smoke-co, luminaire) & floor boxes
  if (kind === 'ceiling-fan' || kind === 'smoke-co' || kind === 'luminaire' || kind === 'floor-box') {
    const interiorZones = zones.filter((z) => !isOutdoorCategory(z.category))
    const prioritized = [...interiorZones].sort((a, b) => {
      const aPref = options.preferredZoneId && a.id === options.preferredZoneId ? 1 : 0
      const bPref = options.preferredZoneId && b.id === options.preferredZoneId ? 1 : 0
      if (aPref !== bPref) return bPref - aPref
      return b.areaM2 - a.areaM2
    })
    for (const z of prioritized) {
      const offsets: Array<[number, number]> = [
        [0, 0],
        [0.65, 0],
        [-0.65, 0],
        [0, 0.65],
        [0, -0.65],
      ]
      for (const [ox, oz] of offsets) {
        const px = round3(z.centroid[0] + ox)
        const pz = round3(z.centroid[1] + oz)
        if (!zoneAtPoint(zones, px, pz)) continue
        if (enforceTubClearance && minDistToTubBoxes(tubBoxes, px, pz) < 0.96) continue
        const pos: Vec3 = [px, mountY, pz]
        if (!isOccupied(pos, 0)) {
          return { position: pos, rotation: 0, zoneName: z.name }
        }
      }
    }
  }

  const bonesCtx = extractBonesFramingContext(nodes, levelId)
  let best: { pos: Vec3; rot: number; zoneName: string | null; score: number } | null = null
  for (const wall of walls) {
    const faceOff = wall.thickness / 2 + 0.008
    const probeOff = wall.thickness / 2 + 0.3
    const spans = wallRoomSpans(wall, walls, mountY >= 0.95)
    const wRule = resolveWallFramingRule(bonesCtx, wall.id)
    for (const [s0, s1] of spans) {
      const spanLen = s1 - s0
      if (spanLen < 0.35) continue
      for (const frac of [0.3, 0.7, 0.5, 0.18, 0.82]) {
        const rawT = s0 + spanLen * frac
        const t = snapWallOffsetToStud(wall.length, rawT, {
          spanMin: s0,
          spanMax: s1,
          rule: wRule,
        }).offsetM
        const cx = wall.start[0] + wall.dx * t
        const cz = wall.start[1] + wall.dz * t
        for (const sign of [1, -1] as const) {
          const z = zoneAtPoint(zones, cx + wall.nx * sign * probeOff, cz + wall.nz * sign * probeOff)
          if (!z || isOutdoorCategory(z.category)) continue
          const wx = round3(cx + wall.nx * sign * faceOff)
          const wz = round3(cz + wall.nz * sign * faceOff)
          // NEC 406.9(C): Keep receptacles/switches >= 3 ft (0.96 m) clear of bathtub & shower footprints
          if (enforceTubClearance && minDistToTubBoxes(tubBoxes, wx, wz) < 0.96) continue
          const rot = sign === 1 ? wall.yaw : wall.yaw + Math.PI
          const pos: Vec3 = [wx, mountY, wz]
          if (isOccupied(pos, rot)) continue
          const preferredBonus = options.preferredZoneId && z.id === options.preferredZoneId ? 200 : 0
          const wetBonus =
            kind === 'gfci' && (isKitchen(z.category) || isBathroom(z.category) || isGarage(z.category))
              ? 40
              : 0
          const score = preferredBonus + wetBonus + spanLen
          if (!best || score > best.score) {
            best = { pos, rot, zoneName: z.name, score }
          }
        }
      }
    }
  }

  if (best) {
    return { position: best.pos, rotation: best.rot, zoneName: best.zoneName }
  }
  for (let step = 0; step < 32; step++) {
    const idx = existingDevices.length + 1 + step
    const fallbackPos: Vec3 = [round3(1.5 + idx * 0.6), mountY, 1.5]
    if (!isOccupied(fallbackPos, 0)) {
      return { position: fallbackPos, rotation: 0, zoneName: null }
    }
  }
  const idx = existingDevices.length + 1
  return { position: [round3(1.5 + idx * 0.6), mountY, 1.5], rotation: 0, zoneName: null }
}

/**
 * Automatically connect a newly added outlet/device:
 * - If placed in a room that ALREADY has a compatible active circuit (within 10-device & 80% load cap),
 *   join that circuit and add a wall-following Manhattan daisy-chain hop from the nearest device in that room
 *   (also updating that anchor box's conductor count / box fill if it was previously end-of-line).
 * - If placed in a NEW room (no existing compatible circuit in that room), or for dedicated 240V/EVSE/3Φ loads,
 *   allocate a phase-balanced circuit and automatically create a wall-following Manhattan Home Run from the panel.
 */
export function planDeviceAutoConnection(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  draft: AutoConnectDeviceDraft,
  options: {
    levelId?: string | null
    racewayType?: RacewayType
    preferredChaseY?: number
  } = {},
): DeviceAutoConnectionPlan {
  const all = Object.values(nodes)
  const levelId = options.levelId ?? all.find((n) => n.type === 'level')?.id ?? null
  const panelNode =
    (draft.panelId ? nodes[draft.panelId] : undefined) ??
    all.find((n) => n.type === 'electrical:panel' && belongsToLevel(nodes, n, levelId)) ??
    all.find((n) => n.type === 'electrical:panel')

  if (!panelNode || panelNode.type !== 'electrical:panel') {
    const zonesNoPanel = extractZones(nodes, levelId)
    const tz = resolveZoneNearPoint(zonesNoPanel, draft.position, draft.rotation ?? 0)
    const tCat = tz?.category ?? ''
    const isWet = Boolean(
      tz &&
        (isBathroom(tCat) ||
          isKitchen(tCat) ||
          isGarage(tCat) ||
          isLaundry(tCat) ||
          isBasementOrUtility(tCat) ||
          isOutdoorCategory(tCat)),
    )
    const isAfci = Boolean(
      draft.occupancy === 'residential' && tz && isHabitableAfci(tCat) && !isBathroom(tCat),
    )
    return {
      mode: 'none',
      panelId: null,
      circuitNumber: draft.circuitNumber ?? 1,
      breakerAmps: draft.breakerAmps,
      wireGauge: clampToBranchWireGauge(draft.wireGauge),
      gfciProtected:
        draft.deviceKind === 'smoke-co' ? Boolean(draft.gfciProtected) : draft.gfciProtected || isWet,
      afciProtected: draft.afciProtected || isAfci,
      boxType: draft.boxType,
      conductorCount: draft.conductorCount,
      roomName: tz?.name ?? null,
      connectedFromNodeId: null,
      connectedFromName: null,
      run: null,
      anchorDevicePatch: null,
    }
  }

  const zones = extractZones(nodes, levelId)
  const routingWalls = extractRoutingWalls(nodes, levelId)
  const cavities = extractRoutingCavities(nodes, levelId)
  const obstacles = extractTradeObstacles(nodes, levelId)
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const effectiveChaseY = round3(Math.min(options.preferredChaseY ?? 2.55, levelHeight - 0.06))

  const existingDevices = all.filter((n) => n.type === 'electrical:device')
  const panelDevices = existingDevices.filter((d) => d.panelId === panelNode.id)
  const panelVoltageSystem: VoltageSystem =
    panelNode.voltageSystem === '120/208V-3P' || panelNode.voltageSystem === '277/480V-3P'
      ? panelNode.voltageSystem
      : '120/240V-1P'
  const occupancy: OccupancyType =
    draft.occupancy ?? (panelNode.occupancy === 'commercial' ? 'commercial' : 'residential')
  const racewayType: RacewayType =
    options.racewayType ?? (occupancy === 'commercial' ? 'emt' : 'nm-b')
  const vLN = getVoltageLineToNeutral(panelVoltageSystem)
  const phases: 1 | 3 = draft.poles === 3 && isThreePhaseSystem(panelVoltageSystem) ? 3 : 1
  const voltage = draft.poles === 1 ? vLN : getVoltageLineToLine(panelVoltageSystem)

  const targetZone = resolveZoneNearPoint(zones, draft.position, draft.rotation ?? 0)
  const targetCat = targetZone?.category ?? ''
  const targetIsBath = Boolean(targetZone && isBathroom(targetCat))
  const targetIsKitchen = Boolean(targetZone && isKitchen(targetCat))
  const targetIsWet = Boolean(
    targetZone &&
      (targetIsBath ||
        targetIsKitchen ||
        isGarage(targetCat) ||
        isLaundry(targetCat) ||
        isBasementOrUtility(targetCat) ||
        isOutdoorCategory(targetCat)),
  )
  const targetIsAfci = Boolean(
    occupancy === 'residential' && targetZone && isHabitableAfci(targetCat) && !targetIsBath,
  )

  const family = deviceFamilyOf(draft.deviceKind)
  const isDedicated =
    family === 'dedicated' || draft.poles >= 2 || draft.breakerAmps >= 30

  const isCircuitCompatible = (dCkt: number, peerBreakerHint: number): boolean => {
    const cktPeers = panelDevices.filter((p) => p.circuitNumber === dCkt)
    if (cktPeers.length >= 10) return false
    const cktBreakerAmps = Math.max(
      peerBreakerHint,
      ...cktPeers.map((p) => (typeof p.breakerAmps === 'number' ? p.breakerAmps : 15)),
    )
    if (draft.breakerAmps > cktBreakerAmps) return false
    const cktTotalVa = cktPeers.reduce(
      (sum, p) => sum + (typeof p.loadVa === 'number' ? p.loadVa : 180),
      0,
    )
    if (cktTotalVa + draft.loadVa > cktBreakerAmps * vLN * 0.85) return false

    // NFPA 72 29.9.4(5): Hardwired smoke/CO alarms must NEVER share a GFCI-protected circuit
    if (draft.deviceKind === 'smoke-co') {
      const cktHasGfci = cktPeers.some(
        (p) =>
          p.gfciProtected === true ||
          p.deviceKind === 'gfci' ||
          p.deviceKind === 'weatherproof-gfci',
      )
      if (cktHasGfci) return false
      return true
    }

    // NEC 210.11(C)(1)/(3) circuit isolation: never mix bath/kitchen circuits with other rooms
    const levelCktPeers = cktPeers.filter((p) => belongsToLevel(nodes, p, levelId))
    const cktHasBath = levelCktPeers.some((p) => {
      if (!Array.isArray(p.position)) return false
      const pz = resolveZoneNearPoint(
        zones,
        [Number(p.position[0]), Number(p.position[1]), Number(p.position[2])],
        typeof p.rotation === 'number' ? p.rotation : 0,
      )
      return Boolean(pz && isBathroom(pz.category))
    })
    const cktHasKitchen = levelCktPeers.some((p) => {
      if (!Array.isArray(p.position)) return false
      const pz = resolveZoneNearPoint(
        zones,
        [Number(p.position[0]), Number(p.position[1]), Number(p.position[2])],
        typeof p.rotation === 'number' ? p.rotation : 0,
      )
      return Boolean(pz && isKitchen(pz.category))
    })
    if (levelCktPeers.length > 0 && targetIsBath !== cktHasBath) return false
    if (levelCktPeers.length > 0 && targetIsKitchen !== cktHasKitchen) return false
    return true
  }

  // Try to join an existing compatible circuit run in the SAME room (or explicitly specified circuitNumber).
  // For hardwired smoke/CO alarms (`IRC R314.4`), prefer interconnecting across rooms onto any existing
  // `smoke-co` alarm on the same level (14/3 interconnect), or else tying into a non-GFCI lighting circuit!
  let anchorDevice: SceneNodeLike | null = null
  if (!isDedicated) {
    const candidates: Array<{ dev: SceneNodeLike; dist: number; ckt: number; priority: number }> = []
    for (const d of panelDevices) {
      // R6-BUG-01: Never bridge level-local [x,y,z] coordinates across different building floors!
      if (!belongsToLevel(nodes, d, levelId)) continue
      if (!Array.isArray(d.position) || d.position.length < 3) continue
      const dCkt = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
      if (dCkt <= 0) continue
      const dPoles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
      if (dPoles !== 1) continue

      const peerBreakerHint = typeof d.breakerAmps === 'number' ? d.breakerAmps : 15
      let priority = 0
      if (draft.circuitNumber !== undefined) {
        if (dCkt !== draft.circuitNumber) continue
        if (!isCircuitCompatible(dCkt, peerBreakerHint)) continue
      } else if (draft.deviceKind === 'smoke-co') {
        const dKind = String(d.deviceKind ?? 'duplex')
        if (dKind === 'smoke-co') {
          priority = 0 // Highest priority: interconnect directly with nearest existing smoke/CO alarm
        } else if (dKind === 'luminaire' || dKind === 'switch-1p' || dKind === 'switch-3way') {
          priority = 1 // Fallback: share a frequently-used non-GFCI lighting circuit (NFPA 72 A.29.9.4)
        } else {
          continue
        }
        if (!isCircuitCompatible(dCkt, peerBreakerHint)) continue
      } else {
        // Must be in the SAME room zone to join an existing run; a new room triggers a Home Run!
        if (!targetZone) continue
        const dPos: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
        const dRot = typeof d.rotation === 'number' ? d.rotation : 0
        const dZone = resolveZoneNearPoint(zones, dPos, dRot)
        if (!dZone || dZone.id !== targetZone.id) continue

        // Family compatibility (receptacles join receptacles; lighting joins lighting)
        const dFamily = deviceFamilyOf(String(d.deviceKind ?? 'duplex'))
        if (family !== 'junction' && dFamily !== 'junction' && dFamily !== family) continue

        if (!isCircuitCompatible(dCkt, peerBreakerHint)) continue
      }

      const dPos: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
      candidates.push({ dev: d, dist: dist3D(dPos, draft.position), ckt: dCkt, priority })
    }

    candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist)
    anchorDevice = candidates[0]?.dev ?? null
  }

  // Case 1: Join existing room circuit -> wall-following Manhattan daisy-chain from nearest room device
  if (anchorDevice && Array.isArray(anchorDevice.position)) {
    const anchorPos: Vec3 = [
      Number(anchorDevice.position[0]),
      Number(anchorDevice.position[1]),
      Number(anchorDevice.position[2]),
    ]
    const ckt = Math.floor(Number(anchorDevice.circuitNumber ?? 1))
    const cktPeers = panelDevices.filter((p) => p.circuitNumber === ckt)
    const cktBreakerAmps = Math.max(
      typeof anchorDevice.breakerAmps === 'number' ? anchorDevice.breakerAmps : draft.breakerAmps,
      targetIsBath || targetIsKitchen ? 20 : 15,
    )
    const anchorGauge = (
      typeof anchorDevice.wireGauge === 'string' && WIRE_GAUGE_ORDER.includes(anchorDevice.wireGauge as WireGauge)
        ? anchorDevice.wireGauge
        : cktBreakerAmps >= 20
          ? '12'
          : '14'
    ) as WireGauge
    const minAmpGauge: WireGauge = cktBreakerAmps >= 20 ? '12' : '14'
    const baseWireGauge = largerGauge(anchorGauge, minAmpGauge)
    const route = routeElectricalRun(anchorPos, draft.position, obstacles, {
      preferredChaseY: effectiveChaseY,
      clearanceM: 0.05,
      walls: routingWalls,
      racewayType,
      wireGauge: baseWireGauge,
      cavities,
    })

    // Check NEC 210.19(A) branch voltage drop across existing circuit upstream run + new daisy-chain hop
    const existingCircuitRuns = all.filter(
      (n) =>
        n.type === 'electrical:conduit-run' &&
        n.panelId === panelNode.id &&
        n.circuitNumber === ckt &&
        Array.isArray(n.path),
    )
    const existingCktLengthFt = existingCircuitRuns.reduce(
      (sum, r) => sum + polylineLengthM(r.path as Vec3[]) * METERS_TO_FEET,
      0,
    )
    const cktTotalVa =
      cktPeers.reduce((sum, p) => sum + (typeof p.loadVa === 'number' ? p.loadVa : 180), 0) +
      draft.loadVa
    const cktLoadAmps = Math.max(1, Math.round((cktTotalVa / voltage) * 100) / 100)
    const vdCheck = calculateVoltageDrop({
      wireGauge: baseWireGauge,
      material: 'cu',
      loadAmps: cktLoadAmps,
      oneWayLengthFt: existingCktLengthFt + route.routedLengthFt,
      voltage,
      phases: 1,
      maxDropPct: 3.0,
    })
    const wireGauge = largerGauge(baseWireGauge, vdCheck.recommendedGauge)

    const boxFillGauge: BoxFillGauge = clampToBoxFillGauge(wireGauge)
    const isSmokeInterconnect =
      draft.deviceKind === 'smoke-co' && anchorDevice.deviceKind === 'smoke-co'
    const newConductorCount = isSmokeInterconnect ? 3 : 2 // 14/3 interconnect vs 14/2 branch end-of-line
    let newBoxType = draft.boxType
    const newBoxCheck = calculateBoxFill({
      boxType: newBoxType,
      conductors: [{ gauge: boxFillGauge, count: newConductorCount }],
      deviceYokeCount: isZeroYokeDeviceKind(draft.deviceKind) ? 0 : 1,
      internalClampCount: 1,
      equipmentGroundCount: 1,
    })
    if (!newBoxCheck.compliant) newBoxType = newBoxCheck.recommendedBoxType

    // NEC 314.16: Each newly tapped outgoing branch cable adds +2 (or +3 for 14/3 smoke interconnect) insulated conductors to the anchor box!
    const prevAnchorCond = typeof anchorDevice.conductorCount === 'number' ? anchorDevice.conductorCount : 2
    const addedCond = isSmokeInterconnect ? 3 : 2
    const nextCond = Math.max(4, prevAnchorCond + addedCond)
    let nextAnchorBox = (typeof anchorDevice.boxType === 'string'
      ? anchorDevice.boxType
      : 'single-gang-standard') as BoxType
    const anchorBoxCheck = calculateBoxFill({
      boxType: nextAnchorBox,
      conductors: [{ gauge: boxFillGauge, count: nextCond }],
      deviceYokeCount: isZeroYokeDeviceKind(anchorDevice.deviceKind) ? 0 : 1,
      internalClampCount: typeof anchorDevice.clampCount === 'number' ? anchorDevice.clampCount : 1,
      equipmentGroundCount: 1,
    })
    if (!anchorBoxCheck.compliant) nextAnchorBox = anchorBoxCheck.recommendedBoxType
    const anchorDevicePatch: DeviceAutoConnectionPlan['anchorDevicePatch'] = {
      id: anchorDevice.id,
      patch: { conductorCount: nextCond, boxType: nextAnchorBox },
    }

    let tradeSize: ConduitTradeSize = '3/4"'
    if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
      const fill = calculateConduitFill({
        conduitType: racewayType,
        tradeSize: '3/4"',
        conductors: [{ gauge: wireGauge, count: isSmokeInterconnect ? 4 : 3 }],
        lengthInches: route.routedLengthM * METERS_TO_FEET * 12,
      })
      if (!fill.compliant) tradeSize = fill.recommendedTradeSize
    }

    const anchorName = (typeof anchorDevice.name === 'string' && anchorDevice.name) || anchorDevice.id
    return {
      mode: 'joined-existing-run',
      panelId: panelNode.id,
      circuitNumber: ckt,
      breakerAmps: cktBreakerAmps,
      wireGauge,
      gfciProtected:
        draft.deviceKind === 'smoke-co'
          ? false
          : draft.gfciProtected || anchorDevice.gfciProtected === true || targetIsWet,
      afciProtected: draft.afciProtected || anchorDevice.afciProtected === true || targetIsAfci,
      boxType: newBoxType,
      conductorCount: newConductorCount,
      roomName: targetZone?.name ?? null,
      connectedFromNodeId: anchorDevice.id,
      connectedFromName: anchorName,
      run: {
        name: isSmokeInterconnect
          ? `CKT-${ckt} Interconnect ${wireGauge}/3 (${anchorName} -> ${draft.name})`
          : `CKT-${ckt} Branch (${anchorName} -> ${draft.name})`,
        runKind: 'daisy-chain',
        panelId: panelNode.id,
        fromNodeId: anchorDevice.id,
        targetDeviceId: draft.id,
        circuitNumber: ckt,
        occupancy,
        racewayType,
        tradeSize,
        wireGauge,
        currentCarryingCount: 2,
        totalConductorCount: isSmokeInterconnect ? 4 : 3,
        loadAmps: Math.max(1, Math.round((draft.loadVa / voltage) * 100) / 100),
        continuous: draft.continuous,
        voltage,
        phases: 1,
        path: route.path,
        avoidedObstaclesCount: route.avoidedObstacles.length,
        routingMode: route.routingMode,
        necNotes: route.necNotes,
        preferredChaseY: effectiveChaseY,
        atticY: cavities.atticY,
        crawlSpaceY: cavities.crawlSpaceY,
        wallPlacement: 'in-wall',
      },
      anchorDevicePatch,
    }
  }

  // Case 2: New room (no compatible existing circuit) OR dedicated load -> allocate balanced circuit & create Home Run!
  const breakerAmps = Math.max(
    draft.breakerAmps,
    targetIsBath || targetIsKitchen || occupancy === 'commercial' ? 20 : 15,
  )
  const maxPanelSpaces = Math.min(
    84,
    Math.max(4, Math.ceil((typeof panelNode.spaces === 'number' ? panelNode.spaces : 40) / 2) * 2),
  )
  const occupiedSlots = new Set<number>()
  for (const p of panelDevices) {
    const c = typeof p.circuitNumber === 'number' && p.circuitNumber >= 1 ? Math.floor(p.circuitNumber) : 0
    if (c <= 0) continue
    const pPoles = p.poles === 3 ? 3 : p.poles === 2 ? 2 : 1
    for (let k = 0; k < pPoles; k++) occupiedSlots.add(c + k * 2)
  }
  let explicitCktSafe = false
  if (draft.circuitNumber !== undefined && draft.circuitNumber >= 1) {
    const reqCkt = Math.floor(draft.circuitNumber)
    explicitCktSafe = true
    for (let k = 0; k < draft.poles; k++) {
      const slot = reqCkt + k * 2
      if (slot > maxPanelSpaces || occupiedSlots.has(slot)) {
        explicitCktSafe = false
        break
      }
    }
  }
  const ckt = explicitCktSafe
    ? Math.floor(draft.circuitNumber!)
    : pickPhaseBalancedCircuit(panelNode, panelDevices, draft.poles, draft.loadVa)

  const panelPos: Vec3 = Array.isArray(panelNode.position)
    ? [Number(panelNode.position[0]), Number(panelNode.position[1]), Number(panelNode.position[2])]
    : [0, 1.52, 0]
  const panelHeight = typeof panelNode.height === 'number' ? panelNode.height : 0.92
  const panelTopPt: Vec3 = [panelPos[0], panelPos[1] + panelHeight / 2, panelPos[2]]

  const route = routeElectricalRun(panelTopPt, draft.position, obstacles, {
    preferredChaseY: effectiveChaseY,
    clearanceM: 0.05,
    walls: routingWalls,
    racewayType,
    wireGauge: breakerAmps >= 20 ? '12' : '14',
    cavities,
  })

  const ccc = draft.poles === 3 ? 3 : 2
  const totalConductors = draft.poles === 3 ? 4 : 3
  const loadAmps = Math.max(
    1,
    Math.round((phases === 3 ? draft.loadVa / (voltage * Math.sqrt(3)) : draft.loadVa / voltage) * 100) / 100,
  )
  const ampGauge = recommendWireGauge({
    material: 'cu',
    insulationRating: '90C',
    racewayType,
    ambientTempC: 30,
    currentCarryingCount: ccc,
    loadAmps,
    continuousLoad: draft.continuous,
    breakerAmps,
  })
  const vdCheck = calculateVoltageDrop({
    wireGauge: ampGauge,
    material: 'cu',
    loadAmps,
    oneWayLengthFt: route.routedLengthFt,
    voltage,
    phases,
    maxDropPct: 3.0,
  })
  const wireGauge = largerGauge(draft.wireGauge, largerGauge(ampGauge, vdCheck.recommendedGauge))

  let tradeSize: ConduitTradeSize = '3/4"'
  if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
    const fill = calculateConduitFill({
      conduitType: racewayType,
      tradeSize: '3/4"',
      conductors: [{ gauge: wireGauge, count: totalConductors }],
      lengthInches: route.routedLengthM * METERS_TO_FEET * 12,
    })
    if (!fill.compliant) tradeSize = fill.recommendedTradeSize
  }

  const boxFillGauge: BoxFillGauge = clampToBoxFillGauge(wireGauge)
  const newConductorCount = draft.poles === 3 ? 3 : draft.poles === 2 ? 3 : 2
  let newBoxType = draft.boxType
  const newBoxCheck = calculateBoxFill({
    boxType: newBoxType,
    conductors: [{ gauge: boxFillGauge, count: newConductorCount }],
    deviceYokeCount: isZeroYokeDeviceKind(draft.deviceKind) ? 0 : 1,
    internalClampCount: 1,
    equipmentGroundCount: 1,
  })
  if (!newBoxCheck.compliant) newBoxType = newBoxCheck.recommendedBoxType

  const panelName = (typeof panelNode.name === 'string' && panelNode.name) || panelNode.id
  const roomSuffix = targetZone ? ` (${targetZone.name})` : ''
  return {
    mode: 'new-home-run',
    panelId: panelNode.id,
    circuitNumber: ckt,
    breakerAmps,
    wireGauge,
    gfciProtected:
      draft.deviceKind === 'smoke-co'
        ? Boolean(draft.gfciProtected)
        : draft.gfciProtected || targetIsWet,
    afciProtected: draft.afciProtected || targetIsAfci,
    boxType: newBoxType,
    conductorCount: newConductorCount,
    roomName: targetZone?.name ?? null,
    connectedFromNodeId: panelNode.id,
    connectedFromName: panelName,
    run: {
      name: `CKT-${ckt} Home Run${roomSuffix}`,
      runKind: 'home-run',
      panelId: panelNode.id,
      fromNodeId: panelNode.id,
      targetDeviceId: draft.id,
      circuitNumber: ckt,
      occupancy,
      racewayType,
      tradeSize,
      wireGauge,
      currentCarryingCount: ccc,
      totalConductorCount: totalConductors,
      loadAmps,
      continuous: draft.continuous,
      voltage,
      phases,
      path: route.path,
      avoidedObstaclesCount: route.avoidedObstacles.length,
      routingMode: route.routingMode,
      necNotes: route.necNotes,
      preferredChaseY: effectiveChaseY,
      atticY: cavities.atticY,
      crawlSpaceY: cavities.crawlSpaceY,
      wallPlacement: 'in-wall',
    },
    anchorDevicePatch: null,
  }
}
