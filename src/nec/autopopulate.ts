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
import { extractTradeObstacles, routeElectricalRun, type Vec3 } from './routing'
import { calculateConduitFill, calculateVoltageDrop, recommendWireGauge } from './sizing'
import {
  type BoxType,
  type ConduitTradeSize,
  METERS_TO_FEET,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  WIRE_GAUGE_ORDER,
  type WireGauge,
  getVoltageLineToNeutral,
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

function unbrokenWallSpans(wall: WallSeg): Array<[number, number]> {
  const blocked = wall.openings.filter((o) => o.kind === 'door')
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
  const preferredChaseY = options.preferredChaseY ?? 2.55

  const zones = extractZones(nodes, levelId)
  const walls = extractWalls(nodes, levelId)
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
              round3(px + nx * (w.thickness / 2 + 0.08)),
              1.52,
              round3(pz + nz * (w.thickness / 2 + 0.08)),
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

  // 2. Walk Walls: NEC 210.52(A)/(C) Wall-Perimeter & Kitchen Countertop Receptacles + Exterior Door Front/Back Rules
  let kitchenCounterIdx = 0
  let exteriorDoorCount = 0

  for (const wall of walls) {
    const midX = (wall.start[0] + wall.end[0]) / 2
    const midZ = (wall.start[1] + wall.end[1]) / 2
    const probeOffset = wall.thickness / 2 + 0.35
    const zPosSide = zoneAtPoint(zones, midX + wall.nx * probeOffset, midZ + wall.nz * probeOffset)
    const zNegSide = zoneAtPoint(zones, midX - wall.nx * probeOffset, midZ - wall.nz * probeOffset)

    const sideConfigs: Array<{ sign: 1 | -1; zone: ZoneInfo | null; opposite: ZoneInfo | null }> = [
      { sign: 1, zone: zPosSide, opposite: zNegSide },
      { sign: -1, zone: zNegSide, opposite: zPosSide },
    ]

    // 2a. Check Doors on this Wall: Front/Exterior Door Entry Switch, Exterior Light, Entry Receptacle, & NEC 210.52(E)(1) Outdoor WR GFCI!
    for (const op of wall.openings) {
      if (op.kind !== 'door') continue
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
        const doorCenterT = (op.tMin + op.tMax) / 2
        const px = wall.start[0] + wall.dx * latchT
        const pz = wall.start[1] + wall.dz * latchT
        const cx = wall.start[0] + wall.dx * doorCenterT
        const cz = wall.start[1] + wall.dz * doorCenterT
        const faceOff = wall.thickness / 2 + 0.04
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
            position: [round3(cx + wall.nx * outsideSign * (faceOff + 0.04)), 2.15, round3(cz + wall.nz * outsideSign * (faceOff + 0.04))],
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

    // 2b. Walk unbroken wall segments for NEC 210.52(A) 6ft/12ft & 210.52(C) Kitchen 4ft rules
    const spans = unbrokenWallSpans(wall)
    for (const sc of sideConfigs) {
      const z = sc.zone
      if (!z || isOutdoorCategory(z.category)) continue
      const cat = z.category
      // Bathrooms, hallways, & closets don't use 6ft/12ft wall-perimeter spacing (handled per-room below)
      if (isBathroom(cat) || isHallway(cat) || /closet/.test(cat)) continue

      const kit = isKitchen(cat)
      const gar = isGarage(cat)
      const laun = isLaundry(cat)
      const bsmt = isBasementOrUtility(cat)
      const maxSpacingM = kit ? 1.22 : 3.66 // 4 ft kitchen countertop (210.52(C)) vs 12 ft habitable (210.52(A))
      const minWallM = kit ? 0.45 : 0.61 // 24" (0.61m) wall rule
      const mountY = kit ? 1.12 : gar ? 1.22 : 0.38
      const faceOff = wall.thickness / 2 + 0.04

      for (const [s0, s1] of spans) {
        const spanLen = s1 - s0
        if (spanLen < minWallM) continue
        // For garage/laundry/basement, place at most 1 receptacle per wall span (min 1 required by NEC)
        const count = gar || laun || bsmt ? 1 : Math.max(1, Math.ceil(spanLen / maxSpacingM))
        for (let i = 0; i < count; i++) {
          const t = s0 + ((i + 0.5) / count) * spanLen
          const wx = round3(wall.start[0] + wall.dx * t + wall.nx * sc.sign * faceOff)
          const wz = round3(wall.start[1] + wall.dz * t + wall.nz * sc.sign * faceOff)
          const rot = sc.sign === 1 ? wall.yaw : wall.yaw + Math.PI

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

  // 3. Per-Zone Guaranteed NEC Minimums (Bathroom GFCI, Hallway Outlet, Outdoor Patio GFCI, & Room Luminaires/Switches)
  for (const z of zones) {
    const [cx, cz] = z.centroid
    const cat = z.category

    if (isOutdoorCategory(cat)) {
      // NEC 210.52(E)(3): Balcony / Deck / Patio accessible Outdoor WR GFCI
      addPlanned({
        name: `${z.name} Outdoor WR GFCI`,
        position: [round3(cx), 0.45, round3(cz)],
        rotation: 0,
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
      // NEC 210.52(D) & 210.11(C)(3): Dedicated 20A Bathroom GFCI receptacle (>= 3 ft clear of tub/shower per NEC 406.9(C))
      const dxOff = Math.min(0.65, z.widthM * 0.36)
      const dzOff = Math.min(0.65, z.depthM * 0.36)
      const candidates: [number, number][] = [
        [cx, cz - dzOff],
        [cx, cz + dzOff],
        [cx - dxOff, cz + dzOff],
        [cx + dxOff, cz + dzOff],
        [cx - dxOff, cz - dzOff],
        [cx + dxOff, cz - dzOff],
      ]
      let bestSpot: [number, number] = candidates[0]!
      let bestDist = -1
      for (const c of candidates) {
        const d = distToNearestTub(c[0], c[1])
        if (d > bestDist) {
          bestDist = d
          bestSpot = c
        }
      }
      addPlanned({
        name: `${z.name} Vanity GFCI`,
        position: [round3(bestSpot[0]), 1.12, round3(bestSpot[1])],
        rotation: 0,
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
      // NEC 210.52(H): Hallways >= 10 ft require at least one receptacle
      addPlanned({
        name: `${z.name} Receptacle`,
        position: [round3(cx), 0.38, round3(cz - Math.min(0.45, z.depthM * 0.35))],
        rotation: 0,
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

    // NEC 210.70(A)(1): Wall-switched ceiling luminaire in every interior room
    if (includeLighting) {
      addPlanned({
        name: `${z.name} Ceiling Light`,
        position: [round3(cx), 2.68, round3(cz)],
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

      addPlanned({
        name: `${z.name} Wall Switch`,
        position: [round3(cx - Math.min(0.8, z.widthM * 0.38)), 1.22, round3(cz)],
        rotation: 0,
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

    // Landing receptacle at stairway base
    addPlanned({
      name: `${label} Landing Receptacle`,
      position: [round3(stPos[0] + sideOff * cos), 0.38, round3(stPos[2] - sideOff * sin)],
      rotation: stRot,
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
      // Bottom 3-way switch
      addPlanned({
        name: `${label} Bottom 3-Way Switch`,
        position: [round3(stPos[0] + sideOff * cos), 1.22, round3(stPos[2] - sideOff * sin)],
        rotation: stRot,
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

      // Top 3-way switch
      addPlanned({
        name: `${label} Top 3-Way Switch`,
        position: [
          round3(stPos[0] + sideOff * cos + runLen * sin),
          1.22,
          round3(stPos[2] - sideOff * sin + runLen * cos),
        ],
        rotation: stRot,
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
          2.68,
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
        boxType: '4-oct-1.5',
        wireGauge: occupancy === 'commercial' ? '12' : '14',
      })
    }
  }

  // Guarantee at least 1 Outdoor WR GFCI even if a minimal floorplan has no exterior doors/patio zones tagged yet
  if (exteriorDoorCount === 0 && !planned.some((p) => p.circuitGroup === 'Outdoor GFCI') && walls.length > 0) {
    const w0 = walls[0]!
    const mx = (w0.start[0] + w0.end[0]) / 2
    const mz = (w0.start[1] + w0.end[1]) / 2
    addPlanned({
      name: 'Front Exterior WR GFCI',
      position: [round3(mx - w0.nx * (w0.thickness / 2 + 0.04)), 0.45, round3(mz - w0.nz * (w0.thickness / 2 + 0.04))],
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
  let runSeq = 1
  let totalAvoided = 0

  for (const bucket of circuitBuckets) {
    if (bucket.items.length === 0) continue

    // Assign next free panel circuit slot (balancing across odd/even slots)
    const ckt = findNextFreePanelCircuit(panelNode, virtualDeviceList, 1)
    const breakerAmps = Math.max(...bucket.items.map((d) => d.breakerAmps))
    const anyGfci = bucket.items.some((d) => d.requiresGfci)
    const anyAfci = bucket.items.some((d) => d.requiresAfci)
    const totalLoadVa = bucket.items.reduce((s, d) => s + d.loadVa, 0)
    const circuitLoadAmps = Math.max(1, Math.round((totalLoadVa / vLN) * 100) / 100)

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

    // Materialize finalized PlannedDeviceSpecs for this circuit
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
      const wireGauge: WireGauge = breakerAmps >= 20 ? '12' : '14'
      const boxType: BoxType =
        conductorCount >= 4 && item.boxType === 'single-gang-shallow'
          ? 'single-gang-standard'
          : makePhysicalGfci && item.boxType === 'single-gang-standard'
            ? 'single-gang-deep'
            : item.boxType

      const spec: PlannedDeviceSpec = {
        ...item,
        deviceKind,
        breakerAmps,
        wireGauge,
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
    let circuitWireGauge: WireGauge = breakerAmps >= 20 ? '12' : '14'

    if (includeWiring && circuitDevices.length > 0) {
      const firstDev = circuitDevices[0]!
      const anyContinuous = circuitDevices.some((d) => d.continuous)
      const voltage = vLN
      const phases: 1 | 3 = 1

      // A. HOME RUN: Panel -> First Device on circuit (yielding around all Plumbing, HVAC, Structural)
      const hrRoute = routeElectricalRun(panelTopPt, firstDev.position, obstacles, {
        preferredChaseY,
        clearanceM: 0.05,
      })
      totalAvoided += hrRoute.avoidedObstacles.length

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
        oneWayLengthFt: hrRoute.routedLengthFt,
        voltage,
        phases,
        maxDropPct: 3.0,
      })
      circuitWireGauge = largerGauge(ampGauge, vdCheck.recommendedGauge)

      let tradeSize: ConduitTradeSize = '3/4"'
      if (racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc') {
        const fill = calculateConduitFill({
          conduitType: racewayType,
          tradeSize: '3/4"',
          conductors: [{ gauge: circuitWireGauge, count: 3 }],
          lengthInches: hrRoute.routedLengthM * METERS_TO_FEET * 12,
        })
        if (!fill.compliant) tradeSize = fill.recommendedTradeSize
      }

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
        // Same-height nearby wall outlets stay cleanly at wall chase height; cross-room jumps go overhead
        const horizDist = Math.hypot(toDev.position[0] - fromDev.position[0], toDev.position[2] - fromDev.position[2])
        const sameBand = Math.abs(toDev.position[1] - fromDev.position[1]) < 0.25 && horizDist <= 4.0
        const chaseY = sameBand ? fromDev.position[1] : preferredChaseY
        const hopRoute = routeElectricalRun(fromDev.position, toDev.position, obstacles, {
          preferredChaseY: chaseY,
          clearanceM: 0.05,
        })
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
