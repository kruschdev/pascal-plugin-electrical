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

import type { SceneNodeLike } from './load-calc'
import { findNextFreePanelCircuit } from './panel-schedule'
import {
  extractRoutingWalls,
  extractTradeObstacles,
  resolveLevelHeightM,
  routeElectricalRun,
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
  getVoltageLineToLine,
  getVoltageLineToNeutral,
  isThreePhaseSystem,
} from './tables'

export type ProtectionMode = 'hybrid' | 'gfci-breakers' | 'gfci-receptacles'

export type AutoPopulateOptions = {
  levelId?: string | null
  occupancy?: OccupancyType
  protectionMode?: ProtectionMode
  racewayType?: RacewayType
  preferredChaseY?: number
  includeLighting?: boolean
  includeWiring?: boolean
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
    | 'switch-1p'
    | 'switch-3way'
    | 'luminaire'
  occupancy: OccupancyType
  circuitGroup: string
  necRef: string
  requiresGfci: boolean
  requiresAfci: boolean
  breakerAmps: number
  poles: 1 | 2
  loadVa: number
  continuous: boolean
  boxType: BoxType
  wireGauge: WireGauge
  conductorCount: number
  isExterior?: boolean
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
  const raw =
    (typeof zone.category === 'string' && zone.category) ||
    (typeof zone.name === 'string' && zone.name) ||
    'general'
  return raw.toLowerCase()
}

function isOutdoorCategory(cat: string): boolean {
  return /outdoor|patio|deck|porch|balcony|yard|terrace/.test(cat)
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
  return /hall|corridor|foyer|entry/.test(cat)
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
  return WIRE_GAUGE_ORDER.indexOf(a) >= WIRE_GAUGE_ORDER.indexOf(b) ? a : b
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
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
  const existingPanels = all.filter((n) => n.type === 'electrical:panel')
  const existingDevices = all.filter((n) => n.type === 'electrical:device')
  const occupancy: OccupancyType =
    options.occupancy ??
    (existingPanels[0]?.occupancy === 'commercial' ? 'commercial' : 'residential')
  const protectionMode: ProtectionMode = options.protectionMode ?? 'hybrid'
  const racewayType: RacewayType =
    options.racewayType ?? (occupancy === 'commercial' ? 'emt' : 'nm-b')
  const includeLighting = options.includeLighting !== false
  const includeWiring = options.includeWiring !== false
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const ceilingLightY = round3(Math.max(2.1, levelHeight - 0.04))
  const preferredChaseY = options.preferredChaseY ?? 2.55
  const effectiveChaseY = round3(Math.min(preferredChaseY, levelHeight + 0.012))

  const zones = extractZones(nodes, levelId)
  const walls = extractWalls(nodes, levelId)
  const routingWalls = extractRoutingWalls(nodes, levelId)
  const stairs = all.filter(
    (n) => n.type === 'stair' && (!levelId || !n.parentId || n.parentId === levelId),
  )
  const obstacles = extractTradeObstacles(nodes, levelId)

  // Extract bathtub/shower fixture footprints so auto-populate keeps outlets >= 3 ft (0.95 m) clear (NEC 406.9(C))
  const tubBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = []
  for (const n of all) {
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
  const distToNearestTub = (x: number, z: number): number => {
    let best = Number.POSITIVE_INFINITY
    for (const b of tubBoxes) {
      const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0
      const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0
      const d = Math.hypot(dx, dz)
      if (d < best) best = d
    }
    return best
  }

  // 1. Resolve or plan Panelboard (strictly respecting NEC 240.24(D)/(E) — never inside bathrooms, closets, or outdoors)
  let panelNode: SceneNodeLike | null = existingPanels[0] ?? null
  let createdPanel: AutoPopulatePlan['createdPanel'] = null
  if (!panelNode) {
    const voltageSystem: VoltageSystem = occupancy === 'commercial' ? '120/208V-3P' : '120/240V-1P'
    let panelPos: Vec3 = [0.5, 1.52, 0.1]
    let panelRot = 0
    let bestPanelScore = -Infinity

    for (const w of walls) {
      for (const frac of [0.5, 0.25, 0.75]) {
        const px = w.start[0] + (w.end[0] - w.start[0]) * frac
        const pz = w.start[1] + (w.end[1] - w.start[1]) * frac
        for (const side of [1, -1] as const) {
          const nx = w.nx * side
          const nz = w.nz * side
          const probeX = px + nx * 0.45
          const probeZ = pz + nz * 0.45
          const zProbe = zoneAtPoint(zones, probeX, probeZ)
          if (!zProbe) continue
          const cat = zProbe.category
          if (isBathroom(cat) || /closet|wardrobe/.test(cat) || isOutdoorCategory(cat)) continue
          const score =
            isGarage(cat) || isBasementOrUtility(cat)
              ? 100
              : isHallway(cat)
                ? 80
                : /living|family|dining|bed|office|study|den/.test(cat)
                  ? 65
                  : 40
          if (score > bestPanelScore) {
            bestPanelScore = score
            panelPos = [
              round3(px + nx * (w.thickness / 2 + 0.072)),
              1.52,
              round3(pz + nz * (w.thickness / 2 + 0.072)),
            ]
            panelRot = side === 1 ? w.yaw : w.yaw + Math.PI
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
    spec: Omit<PlannedDeviceSpec, 'tempId' | 'panelId' | 'circuitNumber' | 'gfciProtected' | 'afciProtected' | 'conductorCount' | 'occupancy' | 'poles' | 'continuous'>,
  ) => {
    if (
      isNearExisting(
        spec.position,
        spec.rotation,
        spec.deviceKind === 'switch-1p' || spec.deviceKind === 'switch-3way' ? 0.3 : 0.48,
      )
    ) {
      return
    }
    const resolved = { ...spec }
    const isRecept =
      resolved.deviceKind === 'duplex' ||
      resolved.deviceKind === 'gfci' ||
      resolved.deviceKind === 'afci'
    if (isRecept && !resolved.isExterior) {
      const actualZone = zoneAtPoint(zones, resolved.position[0], resolved.position[2])
      if (actualZone && isKitchen(actualZone.category)) {
        resolved.requiresGfci = true
        resolved.breakerAmps = 20
        resolved.wireGauge = '12'
        resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
        if (protectionMode !== 'gfci-breakers') resolved.deviceKind = 'gfci'
        if (!resolved.circuitGroup.startsWith('Kitchen SAB')) {
          resolved.circuitGroup = 'Kitchen SAB-1 (20A)'
        }
      } else if (actualZone && isBathroom(actualZone.category)) {
        resolved.requiresGfci = true
        resolved.requiresAfci = false
        resolved.breakerAmps = 20
        resolved.wireGauge = '12'
        resolved.boxType = occupancy === 'commercial' ? '4-sq-2.125' : 'single-gang-deep'
        if (protectionMode !== 'gfci-breakers') resolved.deviceKind = 'gfci'
        resolved.circuitGroup = 'Bathroom GFCI (20A)'
      } else if (actualZone && resolved.circuitGroup.startsWith('Kitchen SAB')) {
        const wet =
          isGarage(actualZone.category) ||
          isLaundry(actualZone.category) ||
          isBasementOrUtility(actualZone.category) ||
          isOutdoorCategory(actualZone.category)
        resolved.circuitGroup = 'General Receptacles'
        resolved.requiresGfci = wet
        if (!wet) resolved.deviceKind = 'duplex'
      } else if (
        actualZone &&
        (isGarage(actualZone.category) ||
          isLaundry(actualZone.category) ||
          isBasementOrUtility(actualZone.category) ||
          isOutdoorCategory(actualZone.category))
      ) {
        resolved.requiresGfci = true
        if (protectionMode !== 'gfci-breakers') resolved.deviceKind = 'gfci'
      }
    }
    planned.push({
      tempId: `auto_dev_${devSeq++}`,
      occupancy,
      poles: 1,
      continuous: resolved.deviceKind === 'luminaire' && occupancy === 'commercial',
      ...resolved,
    })
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
              const score = (clearOfExisting ? 100 : 0) - Math.abs(rawT - doorMidT)
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
          const t = s0 + spanLen * frac
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
            const score =
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

  // 2. Walk Walls: NEC 210.52(A)/(C) Wall-Perimeter & Kitchen Countertop Receptacles + Exterior Door Front/Back Rules
  let kitchenCounterIdx = 0
  let exteriorDoorCount = 0

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
        const latchT = Math.min(wall.length - 0.25, Math.max(0.25, op.tMax + 0.22 <= wall.length - 0.2 ? op.tMax + 0.22 : op.tMin - 0.22))
        const px = wall.start[0] + wall.dx * latchT
        const pz = wall.start[1] + wall.dz * latchT
        const doorLabel = exteriorDoorCount === 1 ? 'Front Door' : `Exterior Door ${exteriorDoorCount}`

        // NEC 210.52(E)(1): Outdoor grade-accessible WR GFCI receptacle beside front/back entrance
        addPlanned({
          name: `${doorLabel} Outdoor WR GFCI`,
          position: [round3(px + wall.nx * outsideSign * faceOff), 0.45, round3(pz + wall.nz * outsideSign * faceOff)],
          rotation: outsideSign === 1 ? wall.yaw : wall.yaw + Math.PI,
          deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
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
            position: [round3(cx + wall.nx * outsideSign * (faceOff + 0.04)), Math.min(2.15, round3(levelHeight - 0.35)), round3(cz + wall.nz * outsideSign * (faceOff + 0.04))],
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
        for (let i = 0; i < count; i++) {
          const t = s0 + ((i + 0.5) / count) * spanLen
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
        deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
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
    if (includeLighting) {
      addPlanned({
        name: `${z.name} Ceiling Light`,
        position: [round3(cx), ceilingLightY, round3(cz)],
        rotation: 0,
        deviceKind: 'luminaire',
        circuitGroup: 'Lighting & Entries',
        necRef: 'NEC 210.70(A)(1)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: occupancy === 'commercial' ? 120 : 60,
        boxType: occupancy === 'commercial' ? '4-sq-2.125' : '4-oct-2.125',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })

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
        circuitGroup: 'Lighting & Entries',
        necRef: 'NEC 210.70(A)(1)',
        requiresGfci: false,
        requiresAfci: occupancy === 'residential',
        breakerAmps: occupancy === 'commercial' ? 20 : 15,
        loadVa: 0,
        boxType: occupancy === 'commercial' ? '4-sq-1.5' : 'single-gang-standard',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })
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

  // Guarantee at least 1 Outdoor WR GFCI even if a minimal floorplan has no exterior doors/patio zones tagged yet
  if (exteriorDoorCount === 0 && !planned.some((p) => p.circuitGroup === 'Outdoor GFCI') && walls.length > 0) {
    const w0 = walls[0]!
    const mx = (w0.start[0] + w0.end[0]) / 2
    const mz = (w0.start[1] + w0.end[1]) / 2
    const extOff = w0.thickness / 2 + WALL_DEVICE_OFFSET_M
    addPlanned({
      name: 'Front Exterior WR GFCI',
      position: [round3(mx - w0.nx * extOff), 0.45, round3(mz - w0.nz * extOff)],
      rotation: w0.yaw + Math.PI,
      deviceKind: protectionMode === 'gfci-breakers' ? 'duplex' : 'gfci',
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

  // 5. Group Devices into NEC Branch Circuits (<= 10 devices per circuit), Order Nearest-Neighbor Chain,
  //    Assign Balanced Panel Circuits, & Route Home Runs + Outlet-to-Outlet Daisy-Chain Runs!
  const rawGroups = new Map<string, typeof planned>()
  for (const dev of planned) {
    const list = rawGroups.get(dev.circuitGroup) ?? []
    list.push(dev)
    rawGroups.set(dev.circuitGroup, list)
  }

  // Split large groups > 10 devices into sub-circuits (e.g., Living Room Receptacles #1, #2)
  const circuitBuckets: Array<{ groupName: string; items: typeof planned }> = []
  for (const [groupName, items] of rawGroups.entries()) {
    const maxPerCircuit = 10
    for (let i = 0; i < items.length; i += maxPerCircuit) {
      const chunk = items.slice(i, i + maxPerCircuit)
      const suffix = items.length > maxPerCircuit ? ` (${Math.floor(i / maxPerCircuit) + 1})` : ''
      circuitBuckets.push({ groupName: `${groupName}${suffix}`, items: chunk })
    }
  }

  const assignedDevices: PlannedDeviceSpec[] = []
  const plannedRuns: PlannedRunSpec[] = []
  const circuitSummary: AutoPopulatePlan['circuitSummary'] = []
  const virtualDeviceList: SceneNodeLike[] = [...existingDevices]
  const panelTopPt: Vec3 = [panelPos[0], panelPos[1] + panelHeight / 2, panelPos[2]]
  const vLN = getVoltageLineToNeutral(panelVoltageSystem)
  const isThreePhasePanel = panelVoltageSystem !== '120/240V-1P'
  const phaseCount = isThreePhasePanel ? 3 : 2
  const maxPanelSpaces = Math.min(
    84,
    Math.max(4, Math.ceil((typeof panelNode.spaces === 'number' ? panelNode.spaces : 40) / 2) * 2),
  )

  // Seed phase load accumulator from existing devices on this panel so new circuits balance cleanly (NEC 220.61)
  const phaseLoadVa = new Array<number>(phaseCount).fill(0)
  for (const d of existingDevices) {
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

  const pickBalancedFreeCircuit = (loadVa: number): number => {
    const occupied = new Set<number>()
    for (const d of virtualDeviceList) {
      if (d.panelId !== panelNode!.id) continue
      const c = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
      if (c <= 0) continue
      const poles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
      for (let p = 0; p < poles; p++) occupied.add(c + p * 2)
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

  for (const bucket of circuitBuckets) {
    if (bucket.items.length === 0) continue

    const breakerAmps = Math.max(...bucket.items.map((d) => d.breakerAmps))
    const anyGfci = bucket.items.some((d) => d.requiresGfci)
    const anyAfci = bucket.items.some((d) => d.requiresAfci)
    const totalLoadVa = bucket.items.reduce((s, d) => s + d.loadVa, 0)
    const circuitLoadAmps = Math.max(1, Math.round((totalLoadVa / vLN) * 100) / 100)
    const ckt = pickBalancedFreeCircuit(totalLoadVa)

    // Order chain: start with device closest to panel, then greedy nearest-neighbor outlet-to-outlet!
    const remaining = [...bucket.items]
    remaining.sort((a, b) => dist3D(panelTopPt, a.position) - dist3D(panelTopPt, b.position))
    const ordered: typeof planned = [remaining.shift()!]
    while (remaining.length > 0) {
      const tail = ordered[ordered.length - 1]!
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const d = dist3D(tail.position, remaining[i]!.position)
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]!)
    }

    // Pre-route Home Run & Daisy-Chain Hops so final voltage-drop / ampacity wireGauge propagates to EVERY device box!
    const anyContinuous = ordered.some((d) => d.continuous)
    const voltage = vLN
    const phases: 1 | 3 = 1
    let circuitWireGauge: WireGauge = breakerAmps >= 20 ? '12' : '14'
    let tradeSize: ConduitTradeSize = '3/4"'

    const hrRoute =
      includeWiring && ordered.length > 0
        ? routeElectricalRun(panelTopPt, ordered[0]!.position, obstacles, {
            preferredChaseY: effectiveChaseY,
            clearanceM: 0.05,
            walls: routingWalls,
          })
        : null
    const hopRoutes: Array<ReturnType<typeof routeElectricalRun>> = []
    if (includeWiring && ordered.length > 1) {
      for (let i = 0; i < ordered.length - 1; i++) {
        const fromDev = ordered[i]!
        const toDev = ordered[i + 1]!
        hopRoutes.push(
          routeElectricalRun(fromDev.position, toDev.position, obstacles, {
            preferredChaseY: effectiveChaseY,
            clearanceM: 0.05,
            walls: routingWalls,
          }),
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
        currentCarryingCount: 2,
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
      circuitWireGauge = largerGauge(ampGauge, vdCheck.recommendedGauge)

      if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
        const fill = calculateConduitFill({
          conduitType: racewayType,
          tradeSize: '3/4"',
          conductors: [{ gauge: circuitWireGauge, count: 3 }],
          lengthInches: hrRoute.routedLengthM * METERS_TO_FEET * 12,
        })
        if (!fill.compliant) tradeSize = fill.recommendedTradeSize
      }
    }

    // Materialize finalized PlannedDeviceSpecs using final circuitWireGauge & NEC 314.16 box-fill check
    const boxFillGauge: BoxFillGauge = (
      ['18', '16', '14', '12', '10', '8', '6'].includes(circuitWireGauge) ? circuitWireGauge : '12'
    ) as BoxFillGauge
    const circuitDevices: PlannedDeviceSpec[] = ordered.map((item, idx) => {
      const isFirstInChain = idx === 0
      const isLastInChain = idx === ordered.length - 1
      // Hybrid mode: first receptacle on a wet circuit is a physical GFCI outlet protecting downstream LOAD outlets!
      const makePhysicalGfci =
        anyGfci &&
        (item.deviceKind === 'duplex' || item.deviceKind === 'gfci') &&
        (protectionMode === 'gfci-receptacles' || (protectionMode === 'hybrid' && isFirstInChain))
      const deviceKind = makePhysicalGfci ? 'gfci' : item.deviceKind
      const conductorCount = isLastInChain ? 2 : 4 // 2 wires (end-of-line) vs 4 wires (feed-in + feed-thru)
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
        deviceYokeCount: deviceKind === 'luminaire' ? 0 : 1,
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
        currentCarryingCount: 2,
        totalConductorCount: 3,
        loadAmps: circuitLoadAmps,
        continuous: anyContinuous,
        voltage,
        phases,
        path: hrRoute.path,
        avoidedObstaclesCount: hrRoute.avoidedObstacles.length,
      })
      homeRunCount = 1

      // B. DAISY-CHAIN BRANCH RUNS: Device 1 -> Device 2 -> ... -> Device N (outlet-to-outlet!)
      for (let i = 0; i < circuitDevices.length - 1; i++) {
        const fromDev = circuitDevices[i]!
        const toDev = circuitDevices[i + 1]!
        const hopRoute = hopRoutes[i]!
        totalAvoided += hopRoute.avoidedObstacles.length

        plannedRuns.push({
          tempId: `auto_run_${runSeq++}`,
          name: `CKT-${ckt} Branch (${fromDev.name} -> ${toDev.name})`,
          runKind: 'daisy-chain',
          panelId: panelNode!.id,
          fromNodeId: fromDev.tempId,
          targetDeviceId: toDev.tempId,
          circuitNumber: ckt,
          occupancy,
          racewayType,
          tradeSize,
          wireGauge: circuitWireGauge,
          currentCarryingCount: 2,
          totalConductorCount: 3,
          loadAmps: Math.max(1, Math.round(((circuitLoadAmps * (circuitDevices.length - i - 1)) / circuitDevices.length) * 100) / 100),
          continuous: anyContinuous,
          voltage,
          phases,
          path: hopRoute.path,
          avoidedObstaclesCount: hopRoute.avoidedObstacles.length,
        })
        daisyChainCount += 1
      }
    }

    const protLabel = [
      anyAfci ? 'AFCI' : '',
      anyGfci && protectionMode === 'gfci-breakers' ? 'GFCI' : '',
    ]
      .filter(Boolean)
      .join('/')

    circuitSummary.push({
      circuitNumber: ckt,
      groupName: bucket.groupName,
      breakerSpec: `1P-${breakerAmps}A${protLabel ? ` ${protLabel}` : ''}`,
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
  run: {
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
  } | null
  anchorDevicePatch: {
    id: string
    patch: {
      conductorCount: number
      boxType: BoxType
    }
  } | null
}

function deviceFamilyOf(kind: string): 'receptacle' | 'lighting' | 'junction' | 'dedicated' {
  if (kind === 'duplex' || kind === 'gfci' || kind === 'afci') return 'receptacle'
  if (kind === 'switch-1p' || kind === 'switch-3way' || kind === 'luminaire' || kind === 'exit-sign') {
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
  const existingDevices = all.filter((n) => n.type === 'electrical:device')
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const kind = options.deviceKind ?? 'duplex'
  const mountY =
    kind === 'junction-box'
      ? round3(Math.min(2.45, levelHeight - 0.1))
      : kind === 'evse' || kind === 'gfci'
        ? 1.12
        : kind === 'switch-1p' || kind === 'switch-3way'
          ? 1.22
          : 0.38

  const isOccupied = (pos: Vec3, rot: number): boolean => {
    for (const d of existingDevices) {
      if (!Array.isArray(d.position) || d.position.length < 3) continue
      const ep: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
      const eRot = typeof d.rotation === 'number' ? d.rotation : 0
      if (dist3D(ep, pos) < 0.52 && Math.cos(eRot - rot) > 0.25) return true
    }
    return false
  }

  let best: { pos: Vec3; rot: number; zoneName: string | null; score: number } | null = null
  for (const wall of walls) {
    const faceOff = wall.thickness / 2 + 0.008
    const probeOff = wall.thickness / 2 + 0.3
    const spans = wallRoomSpans(wall, walls, mountY >= 0.95)
    for (const [s0, s1] of spans) {
      const spanLen = s1 - s0
      if (spanLen < 0.35) continue
      for (const frac of [0.3, 0.7, 0.5, 0.18, 0.82]) {
        const t = s0 + spanLen * frac
        const cx = wall.start[0] + wall.dx * t
        const cz = wall.start[1] + wall.dz * t
        for (const sign of [1, -1] as const) {
          const z = zoneAtPoint(zones, cx + wall.nx * sign * probeOff, cz + wall.nz * sign * probeOff)
          if (!z || isOutdoorCategory(z.category)) continue
          const wx = round3(cx + wall.nx * sign * faceOff)
          const wz = round3(cz + wall.nz * sign * faceOff)
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
      wireGauge: draft.wireGauge,
      gfciProtected: draft.gfciProtected || isWet,
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
  const obstacles = extractTradeObstacles(nodes, levelId)
  const levelHeight = resolveLevelHeightM(nodes, levelId)
  const effectiveChaseY = round3(Math.min(options.preferredChaseY ?? 2.55, levelHeight + 0.012))

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

  // Try to join an existing compatible circuit run in the SAME room (or explicitly specified circuitNumber)
  let anchorDevice: SceneNodeLike | null = null
  if (!isDedicated) {
    const candidates: Array<{ dev: SceneNodeLike; dist: number; ckt: number }> = []
    for (const d of panelDevices) {
      if (!Array.isArray(d.position) || d.position.length < 3) continue
      const dCkt = typeof d.circuitNumber === 'number' && d.circuitNumber >= 1 ? Math.floor(d.circuitNumber) : 0
      if (dCkt <= 0) continue
      const dPoles = d.poles === 3 ? 3 : d.poles === 2 ? 2 : 1
      if (dPoles !== 1) continue

      if (draft.circuitNumber !== undefined) {
        if (dCkt !== draft.circuitNumber) continue
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

        // NEC 210.11(C)(1)/(3) circuit isolation: never mix bath/kitchen circuits with other rooms
        const cktPeers = panelDevices.filter((p) => p.circuitNumber === dCkt)
        if (cktPeers.length >= 10) continue
        const cktBreakerAmps = Math.max(
          typeof d.breakerAmps === 'number' ? d.breakerAmps : 15,
          ...cktPeers.map((p) => (typeof p.breakerAmps === 'number' ? p.breakerAmps : 15)),
        )
        const cktTotalVa = cktPeers.reduce(
          (sum, p) => sum + (typeof p.loadVa === 'number' ? p.loadVa : 180),
          0,
        )
        if (cktTotalVa + draft.loadVa > cktBreakerAmps * vLN * 0.85) continue

        const cktHasBath = cktPeers.some((p) => {
          if (!Array.isArray(p.position)) return false
          const pz = resolveZoneNearPoint(
            zones,
            [Number(p.position[0]), Number(p.position[1]), Number(p.position[2])],
            typeof p.rotation === 'number' ? p.rotation : 0,
          )
          return Boolean(pz && isBathroom(pz.category))
        })
        const cktHasKitchen = cktPeers.some((p) => {
          if (!Array.isArray(p.position)) return false
          const pz = resolveZoneNearPoint(
            zones,
            [Number(p.position[0]), Number(p.position[1]), Number(p.position[2])],
            typeof p.rotation === 'number' ? p.rotation : 0,
          )
          return Boolean(pz && isKitchen(pz.category))
        })
        if (targetIsBath !== cktHasBath) continue
        if (targetIsKitchen !== cktHasKitchen) continue
      }

      const dPos: Vec3 = [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])]
      candidates.push({ dev: d, dist: dist3D(dPos, draft.position), ckt: dCkt })
    }

    candidates.sort((a, b) => a.dist - b.dist)
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
    const wireGauge = largerGauge(anchorGauge, minAmpGauge)
    const route = routeElectricalRun(anchorPos, draft.position, obstacles, {
      preferredChaseY: effectiveChaseY,
      clearanceM: 0.05,
      walls: routingWalls,
    })

    const boxFillGauge: BoxFillGauge = (
      ['18', '16', '14', '12', '10', '8', '6'].includes(wireGauge) ? wireGauge : '12'
    ) as BoxFillGauge
    const newConductorCount = 2 // new end-of-line outlet on the daisy chain
    let newBoxType = draft.boxType
    const newBoxCheck = calculateBoxFill({
      boxType: newBoxType,
      conductors: [{ gauge: boxFillGauge, count: newConductorCount }],
      deviceYokeCount: draft.deviceKind === 'junction-box' || draft.deviceKind === 'luminaire' ? 0 : 1,
      internalClampCount: 1,
      equipmentGroundCount: 1,
    })
    if (!newBoxCheck.compliant) newBoxType = newBoxCheck.recommendedBoxType

    // If anchor device was end-of-line (< 4 conductors), bump it to 4 (feed-in + feed-thru) and check NEC 314.16 box fill
    let anchorDevicePatch: DeviceAutoConnectionPlan['anchorDevicePatch'] = null
    const prevAnchorCond = typeof anchorDevice.conductorCount === 'number' ? anchorDevice.conductorCount : 4
    if (prevAnchorCond < 4) {
      const nextCond = 4
      let nextAnchorBox = (typeof anchorDevice.boxType === 'string'
        ? anchorDevice.boxType
        : 'single-gang-standard') as BoxType
      const anchorBoxCheck = calculateBoxFill({
        boxType: nextAnchorBox,
        conductors: [{ gauge: boxFillGauge, count: nextCond }],
        deviceYokeCount:
          anchorDevice.deviceKind === 'junction-box' || anchorDevice.deviceKind === 'luminaire' ? 0 : 1,
        internalClampCount: typeof anchorDevice.clampCount === 'number' ? anchorDevice.clampCount : 1,
        equipmentGroundCount: 1,
      })
      if (!anchorBoxCheck.compliant) nextAnchorBox = anchorBoxCheck.recommendedBoxType
      anchorDevicePatch = {
        id: anchorDevice.id,
        patch: { conductorCount: nextCond, boxType: nextAnchorBox },
      }
    }

    let tradeSize: ConduitTradeSize = '3/4"'
    if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
      const fill = calculateConduitFill({
        conduitType: racewayType,
        tradeSize: '3/4"',
        conductors: [{ gauge: wireGauge, count: 3 }],
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
      gfciProtected: draft.gfciProtected || anchorDevice.gfciProtected === true || targetIsWet,
      afciProtected: draft.afciProtected || anchorDevice.afciProtected === true || targetIsAfci,
      boxType: newBoxType,
      conductorCount: newConductorCount,
      roomName: targetZone?.name ?? null,
      connectedFromNodeId: anchorDevice.id,
      connectedFromName: anchorName,
      run: {
        name: `CKT-${ckt} Branch (${anchorName} -> ${draft.name})`,
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
        totalConductorCount: 3,
        loadAmps: Math.max(1, Math.round((draft.loadVa / voltage) * 100) / 100),
        continuous: draft.continuous,
        voltage,
        phases: 1,
        path: route.path,
        avoidedObstaclesCount: route.avoidedObstacles.length,
      },
      anchorDevicePatch,
    }
  }

  // Case 2: New room (no compatible existing circuit) OR dedicated load -> allocate balanced circuit & create Home Run!
  const breakerAmps = Math.max(
    draft.breakerAmps,
    targetIsBath || targetIsKitchen || occupancy === 'commercial' ? 20 : 15,
  )
  const ckt =
    draft.circuitNumber !== undefined
      ? draft.circuitNumber
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

  const boxFillGauge: BoxFillGauge = (
    ['18', '16', '14', '12', '10', '8', '6'].includes(wireGauge) ? wireGauge : '12'
  ) as BoxFillGauge
  const newConductorCount = draft.poles === 3 ? 3 : draft.poles === 2 ? 3 : 2
  let newBoxType = draft.boxType
  const newBoxCheck = calculateBoxFill({
    boxType: newBoxType,
    conductors: [{ gauge: boxFillGauge, count: newConductorCount }],
    deviceYokeCount: draft.deviceKind === 'junction-box' || draft.deviceKind === 'luminaire' ? 0 : 1,
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
    gfciProtected: draft.gfciProtected || targetIsWet,
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
    },
    anchorDevicePatch: null,
  }
}
