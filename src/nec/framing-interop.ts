/**
 * Pure TypeScript interoperability helpers for Pascal's `@pascal-app/plugin-bones`
 * framing plugin (`bones:framing` and `bones:service` scene-graph nodes).
 *
 * Zero hard dependency on `@pascal-app/plugin-bones`, React, Three.js, or `@pascal-app/*`.
 * When `bones:framing` is present on a level, electrical wall boxes snap flush against
 * the exact side face of the nearest real wood/steel stud (16" OC or 24" OC) and panels
 * center cleanly inside a stud bay (and honor any authoritative `bones:service` panel node).
 * Even without `bones:framing`, framed residential walls default to standard 16" OC stud layout.
 */

import type { SceneNodeLike } from './load-calc'
import { belongsToLevel } from './routing'

export type BonesWallConstruction = 'framed' | 'lgs' | 'cmu' | 'skip'

export type BonesWallRule = {
  construction: BonesWallConstruction
  spacingIn: 16 | 24
  studThicknessM: number
}

export type BonesServicePanelAnchor = {
  nodeId: string
  wallId?: string
  wallT?: number
  heightAff?: number
  position?: readonly [number, number, number]
}

export type BonesDeviceKind =
  | 'receptacle'
  | 'receptacle-gfci'
  | 'receptacle-wr-gfci'
  | 'switch'

export type BonesServiceType =
  | 'panel'
  | 'water-heater'
  | 'water-entry'
  | 'sewer-exit'
  | 'power-entry'
  | 'thermostat'
  | 'heat-pump'
  | 'electric-meter'

export type BonesDeviceAnchor = {
  nodeId: string
  deviceId: string
  deviceKind: BonesDeviceKind
  wallId?: string
  wallT?: number
  heightAff?: number
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
  /** Parsed from Bones deterministic deviceId suffix (`-p` => +1, `-m` => -1). */
  faceSideHint: 1 | -1 | null
  /** True when the user dragged or overrode the device relative to its Bones seed anchor. */
  userMoved: boolean
  isCountertop: boolean
  isBasin: boolean
  isOutdoor: boolean
}

export type BonesServiceAnchor = {
  nodeId: string
  serviceType: BonesServiceType
  wallId?: string
  wallT?: number
  heightAff?: number
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
  yawOverride?: number | null
}

export type BonesSchematicSnapshot = {
  framing: BonesFramingContext
  devices: BonesDeviceAnchor[]
  services: BonesServiceAnchor[]
  /** True when persisted `bones:device` or electrical `bones:service` anchors exist on the level. */
  hasElectricalSchematic: boolean
  /** Count of persisted `bones:device` nodes whose live anchor differs from their `seed*` derivation. */
  userMovedDeviceCount: number
}

export type BonesFramingContext = {
  /** True when a `bones:framing` node exists on the active level. */
  present: boolean
  /** Default on-center stud spacing in inches (16 or 24). */
  defaultSpacingIn: 16 | 24
  /** Framing system ('lumber' or 'lgs'). */
  framingSystem: 'lumber' | 'lgs'
  /** Per-wall framing overrides from `bones:framing.wallOverrides`. */
  wallRules: ReadonlyMap<string, BonesWallRule>
  /** Optional authoritative `bones:service` (serviceType: 'panel') anchor on this level. */
  servicePanel: BonesServicePanelAnchor | null
}

/** Standard dressed 2x4 / 2x6 wood stud thickness (1.5" = 0.0381 m). */
export const DRESSED_STUD_THICKNESS_M = 0.0381
export const DRESSED_STUD_HALF_M = DRESSED_STUD_THICKNESS_M / 2
const INCH_TO_M = 0.0254
const EPS = 1e-4

/**
 * Extract framing stud spacing, per-wall overrides, and any authoritative `bones:service`
 * electric panel point from Pascal's scene graph.
 */
export function extractBonesFramingContext(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): BonesFramingContext {
  const all = Object.values(nodes)
  const framingNode = all.find(
    (n) => n.type === 'bones:framing' && belongsToLevel(nodes, n, levelId),
  )

  const defaultSpacingIn: 16 | 24 = framingNode?.studSpacingIn === 24 ? 24 : 16
  const framingSystem: 'lumber' | 'lgs' = framingNode?.framingSystem === 'lgs' ? 'lgs' : 'lumber'
  const wallRules = new Map<string, BonesWallRule>()

  const rawOverrides = framingNode?.wallOverrides
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    for (const [wallId, raw] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        if (raw === 'framed' || raw === 'lgs' || raw === 'cmu' || raw === 'skip') {
          wallRules.set(wallId, {
            construction: raw,
            spacingIn: defaultSpacingIn,
            studThicknessM: DRESSED_STUD_THICKNESS_M,
          })
        }
      } else if (raw && typeof raw === 'object') {
        const rec = raw as Record<string, unknown>
        const cRaw = rec.construction
        const construction: BonesWallConstruction =
          cRaw === 'framed' || cRaw === 'lgs' || cRaw === 'cmu' || cRaw === 'skip'
            ? cRaw
            : framingSystem === 'lgs'
              ? 'lgs'
              : 'framed'
        const spacingIn: 16 | 24 = rec.spacingIn === 24 ? 24 : rec.spacingIn === 16 ? 16 : defaultSpacingIn
        wallRules.set(wallId, {
          construction,
          spacingIn,
          studThicknessM: DRESSED_STUD_THICKNESS_M,
        })
      }
    }
  }

  let servicePanel: BonesServicePanelAnchor | null = null
  const panelSvc = all.find(
    (n) =>
      n.type === 'bones:service' &&
      n.serviceType === 'panel' &&
      belongsToLevel(nodes, n, levelId),
  )
  if (panelSvc) {
    const pos =
      Array.isArray(panelSvc.position) && panelSvc.position.length >= 3
        ? ([Number(panelSvc.position[0]), Number(panelSvc.position[1]), Number(panelSvc.position[2])] as const)
        : undefined
    const hasExplicitPos = Boolean(
      pos && (Math.abs(pos[0]) > 1e-4 || Math.abs(pos[1]) > 1e-4 || Math.abs(pos[2]) > 1e-4),
    )
    servicePanel = {
      nodeId: panelSvc.id,
      wallId: typeof panelSvc.wallId === 'string' ? panelSvc.wallId : undefined,
      wallT: typeof panelSvc.wallT === 'number' ? panelSvc.wallT : undefined,
      heightAff: typeof panelSvc.heightAff === 'number' ? panelSvc.heightAff : undefined,
      position: hasExplicitPos ? pos : undefined,
    }
  }

  return {
    present: Boolean(framingNode),
    defaultSpacingIn,
    framingSystem,
    wallRules,
    servicePanel,
  }
}

const VALID_BONES_DEVICE_KINDS: ReadonlySet<string> = new Set([
  'receptacle',
  'receptacle-gfci',
  'receptacle-wr-gfci',
  'switch',
])

const VALID_BONES_SERVICE_TYPES: ReadonlySet<string> = new Set([
  'panel',
  'water-heater',
  'water-entry',
  'sewer-exit',
  'power-entry',
  'thermostat',
  'heat-pump',
  'electric-meter',
])

const ELECTRICAL_BONES_SERVICES: ReadonlySet<BonesServiceType> = new Set([
  'panel',
  'water-heater',
  'power-entry',
  'heat-pump',
  'electric-meter',
])

function readOptionalVec3(raw: unknown): readonly [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined
  const x = Number(raw[0])
  const y = Number(raw[1])
  const z = Number(raw[2])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return [x, y, z] as const
}

function isNonZeroVec3(pos: readonly [number, number, number] | undefined): boolean {
  return Boolean(pos && (Math.abs(pos[0]) > 1e-4 || Math.abs(pos[1]) > 1e-4 || Math.abs(pos[2]) > 1e-4))
}

function parseBonesFaceSideHint(deviceId: string): 1 | -1 | null {
  if (deviceId.endsWith('-p')) return 1
  if (deviceId.endsWith('-m')) return -1
  return null
}

/**
 * Extract the full persisted `@pascal-app/plugin-bones` schematic snapshot on a level:
 * - `bones:framing` stud spacing & wall overrides
 * - `bones:device` wall-mounted receptacles, GFCIs, outdoor WR GFCIs, and switches (preserving user drag overrides)
 * - `bones:service` anchors (`panel`, `electric-meter`, `power-entry`, `water-heater`, `heat-pump`, etc.)
 *
 * Pure TypeScript with zero hard dependency on `@pascal-app/plugin-bones`.
 */
export function extractBonesSchematic(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): BonesSchematicSnapshot {
  const framing = extractBonesFramingContext(nodes, levelId)
  const all = Object.values(nodes)
  const devices: BonesDeviceAnchor[] = []
  const services: BonesServiceAnchor[] = []
  let userMovedDeviceCount = 0

  for (const n of all) {
    if (!belongsToLevel(nodes, n, levelId)) continue

    if (n.type === 'bones:device') {
      const rawKind = typeof n.deviceKind === 'string' ? n.deviceKind : ''
      if (!VALID_BONES_DEVICE_KINDS.has(rawKind)) continue
      const deviceKind = rawKind as BonesDeviceKind
      const deviceId = typeof n.deviceId === 'string' && n.deviceId.length > 0 ? n.deviceId : n.id
      const wallId = typeof n.wallId === 'string' ? n.wallId : undefined
      const wallT = typeof n.wallT === 'number' && Number.isFinite(n.wallT) ? n.wallT : undefined
      const heightAff =
        typeof n.heightAff === 'number' && Number.isFinite(n.heightAff) ? n.heightAff : undefined
      const rawPos = readOptionalVec3(n.position)
      const position = isNonZeroVec3(rawPos) ? rawPos : undefined
      const rotation = readOptionalVec3(n.rotation)

      const seedWallId = typeof n.seedWallId === 'string' ? n.seedWallId : undefined
      const seedWallT =
        typeof n.seedWallT === 'number' && Number.isFinite(n.seedWallT) ? n.seedWallT : undefined
      const seedHeightAff =
        typeof n.seedHeightAff === 'number' && Number.isFinite(n.seedHeightAff)
          ? n.seedHeightAff
          : undefined

      const movedWall = Boolean(seedWallId && wallId && seedWallId !== wallId)
      const movedT = Boolean(
        seedWallT !== undefined && wallT !== undefined && Math.abs(wallT - seedWallT) > 1e-3,
      )
      const movedH = Boolean(
        seedHeightAff !== undefined &&
          heightAff !== undefined &&
          Math.abs(heightAff - seedHeightAff) > 1e-3,
      )
      const userMoved = Boolean(position || movedWall || movedT || movedH)
      if (userMoved) userMovedDeviceCount += 1

      const isOutdoor = deviceKind === 'receptacle-wr-gfci' || deviceId.includes('-out-')
      const isCountertop = deviceId.includes('-ctr-')
      const isBasin = deviceId.includes('-basin-')

      devices.push({
        nodeId: n.id,
        deviceId,
        deviceKind,
        wallId,
        wallT,
        heightAff,
        position,
        rotation,
        faceSideHint: parseBonesFaceSideHint(deviceId),
        userMoved,
        isCountertop,
        isBasin,
        isOutdoor,
      })
    } else if (n.type === 'bones:service') {
      const rawSvc = typeof n.serviceType === 'string' ? n.serviceType : ''
      if (!VALID_BONES_SERVICE_TYPES.has(rawSvc)) continue
      const serviceType = rawSvc as BonesServiceType
      const rawPos = readOptionalVec3(n.position)
      services.push({
        nodeId: n.id,
        serviceType,
        wallId: typeof n.wallId === 'string' ? n.wallId : undefined,
        wallT: typeof n.wallT === 'number' && Number.isFinite(n.wallT) ? n.wallT : undefined,
        heightAff:
          typeof n.heightAff === 'number' && Number.isFinite(n.heightAff) ? n.heightAff : undefined,
        position: isNonZeroVec3(rawPos) ? rawPos : undefined,
        rotation: readOptionalVec3(n.rotation),
        yawOverride: typeof n.yawOverride === 'number' ? n.yawOverride : null,
      })
    }
  }

  const hasElectricalService = services.some((s) => ELECTRICAL_BONES_SERVICES.has(s.serviceType))
  return {
    framing,
    devices,
    services,
    hasElectricalSchematic: devices.length > 0 || hasElectricalService,
    userMovedDeviceCount,
  }
}

export type PendingBonesImportSummary = {
  totalImportable: number
  pendingDevices: number
  pendingServices: number
  pendingUserMoved: number
  alreadyImported: number
  label: string
}

/**
 * Summarize remaining un-imported Bones electrical devices (`bones:device`) and load-bearing
 * equipment services (`water-heater`, `heat-pump`) against already-imported `electrical:device`
 * nodes (`metadata.bonesSourceId`) for clean UI labels and button state.
 */
export function summarizePendingBonesImport(
  schematic: BonesSchematicSnapshot,
  existingElectricalDevices: readonly SceneNodeLike[],
): PendingBonesImportSummary {
  const importedIds = new Set<string>()
  for (const d of existingElectricalDevices) {
    const meta = d.metadata as Record<string, unknown> | undefined
    if (meta && typeof meta.bonesSourceId === 'string' && meta.bonesSourceId.length > 0) {
      importedIds.add(meta.bonesSourceId)
    }
  }

  const importableServices = schematic.services.filter(
    (s) => s.serviceType === 'water-heater' || s.serviceType === 'heat-pump',
  )
  const pendingDevs = schematic.devices.filter((d) => !importedIds.has(d.nodeId))
  const pendingSvcs = importableServices.filter((s) => !importedIds.has(s.nodeId))
  const pendingUserMoved = pendingDevs.filter((d) => d.userMoved).length
  const totalImportable = schematic.devices.length + importableServices.length
  const remaining = pendingDevs.length + pendingSvcs.length
  const alreadyImported = totalImportable - remaining

  if (totalImportable === 0) {
    return {
      totalImportable: 0,
      pendingDevices: 0,
      pendingServices: 0,
      pendingUserMoved: 0,
      alreadyImported: 0,
      label: '',
    }
  }

  if (remaining === 0) {
    return {
      totalImportable,
      pendingDevices: 0,
      pendingServices: 0,
      pendingUserMoved: 0,
      alreadyImported,
      label: `Bones Schematic Imported (${alreadyImported}/${totalImportable})`,
    }
  }

  const parts = [
    pendingDevs.length > 0 ? `${pendingDevs.length} dev` : '',
    pendingSvcs.length > 0 ? `${pendingSvcs.length} svc` : '',
    pendingUserMoved > 0 ? `${pendingUserMoved} moved` : '',
  ].filter(Boolean)

  return {
    totalImportable,
    pendingDevices: pendingDevs.length,
    pendingServices: pendingSvcs.length,
    pendingUserMoved,
    alreadyImported,
    label: `Import & Wire Bones Schematic (${parts.join(', ')})`,
  }
}

export function resolveWallFramingRule(
  ctx: BonesFramingContext,
  wallId: string,
): BonesWallRule {
  const override = ctx.wallRules.get(wallId)
  if (override) return override
  return {
    construction: ctx.framingSystem === 'lgs' ? 'lgs' : 'framed',
    spacingIn: ctx.defaultSpacingIn,
    studThicknessM: DRESSED_STUD_THICKNESS_M,
  }
}

/**
 * Compute exact stud center distances along a wall from `start` to `end` (in meters),
 * matching `@pascal-app/plugin-bones`'s `studPositions(length, spacing, halfT)` layout.
 */
export function computeWallStudPositions(
  wallLengthM: number,
  spacingIn: 16 | 24 = 16,
  studThicknessM = DRESSED_STUD_THICKNESS_M,
): number[] {
  const halfT = studThicknessM / 2
  const spacingM = spacingIn * INCH_TO_M
  if (wallLengthM <= studThicknessM + EPS) return [wallLengthM / 2]

  const out: number[] = []
  const endU = wallLengthM - halfT
  for (let u = halfT; u < endU - EPS; u += spacingM) {
    out.push(u)
  }
  out.push(endU)

  // Mirror Bones's end-stud collision snugging so bays stay <= spacing
  if (out.length >= 2) {
    const last = out[out.length - 1]!
    const prev = out[out.length - 2]!
    if (last - prev <= 2 * halfT + EPS) {
      const snug = last - 2 * halfT
      const before = out.length >= 3 ? out[out.length - 3]! : Number.NEGATIVE_INFINITY
      if (snug - before > 2 * halfT) out[out.length - 2] = snug
      else out.splice(out.length - 2, 1)
    }
  }
  return out
}

export type StudSnapResult = {
  offsetM: number
  snappedToStud: boolean
  studCenterM: number | null
  side: -1 | 0 | 1
}

/**
 * Snap a wall-mounted electrical box center (`targetOffsetM` along the wall) cleanly
 * flush against the side face of the nearest valid stud inside `[spanMin, spanMax]`.
 *
 * Clears masonry (`cmu`) / `skip` walls and avoids colliding with door/window king studs.
 */
export function snapWallOffsetToStud(
  wallLengthM: number,
  targetOffsetM: number,
  opts: {
    spanMin: number
    spanMax: number
    rule: BonesWallRule
    boxWidthM?: number
    maxShiftM?: number
  },
): StudSnapResult {
  const { spanMin, spanMax, rule } = opts
  const boxWidthM = opts.boxWidthM ?? 0.058 // standard 1-gang nail-on box width (~2.28")
  const halfBox = boxWidthM / 2
  const halfStud = rule.studThicknessM / 2
  const maxShift = opts.maxShiftM ?? rule.spacingIn * INCH_TO_M * 0.75

  if (rule.construction === 'cmu' || rule.construction === 'skip') {
    return { offsetM: targetOffsetM, snappedToStud: false, studCenterM: null, side: 0 }
  }

  const studs = computeWallStudPositions(wallLengthM, rule.spacingIn, rule.studThicknessM)
  const minValid = spanMin + halfBox + 0.025
  const maxValid = spanMax - halfBox - 0.025
  if (minValid >= maxValid) {
    return { offsetM: targetOffsetM, snappedToStud: false, studCenterM: null, side: 0 }
  }

  const boxCenterOffsetFromStud = halfStud + halfBox + 0.002 // 2mm nail-on bracket flange
  let best: StudSnapResult | null = null
  let bestDist = Infinity

  for (const uStud of studs) {
    for (const side of [-1, 1] as const) {
      const candidate = uStud + side * boxCenterOffsetFromStud
      if (candidate < minValid || candidate > maxValid) continue
      // Ensure box doesn't overlap the neighboring stud on the opposite side of the bay
      const overlapsNeighbor = studs.some(
        (other) => Math.abs(other - uStud) > EPS && Math.abs(candidate - other) < halfStud + halfBox - 0.001,
      )
      if (overlapsNeighbor) continue
      const d = Math.abs(candidate - targetOffsetM)
      if (d <= maxShift && d < bestDist) {
        bestDist = d
        best = {
          offsetM: Math.round(candidate * 1000) / 1000,
          snappedToStud: true,
          studCenterM: Math.round(uStud * 1000) / 1000,
          side,
        }
      }
    }
  }

  return best ?? { offsetM: targetOffsetM, snappedToStud: false, studCenterM: null, side: 0 }
}

/**
 * Center a flush panelboard (`14.5"` = 0.368 m cabinet) cleanly between two adjacent studs
 * inside `[spanMin, spanMax]` so the panel drops into a full stud bay without cutting a stud.
 */
export function snapPanelOffsetToStudBay(
  wallLengthM: number,
  targetOffsetM: number,
  opts: {
    spanMin: number
    spanMax: number
    rule: BonesWallRule
    panelWidthM?: number
  },
): number {
  const { spanMin, spanMax, rule } = opts
  const panelWidthM = opts.panelWidthM ?? 0.368 // 14.5" standard residential load center
  if (rule.construction === 'cmu' || rule.construction === 'skip') return targetOffsetM

  const studs = computeWallStudPositions(wallLengthM, rule.spacingIn, rule.studThicknessM)
  let bestCenter = targetOffsetM
  let bestDist = Infinity

  for (let i = 0; i < studs.length - 1; i++) {
    const leftStud = studs[i]!
    const rightStud = studs[i + 1]!
    const clearBay = rightStud - leftStud - rule.studThicknessM
    if (clearBay < panelWidthM - 0.015) continue
    const bayCenter = (leftStud + rightStud) / 2
    if (bayCenter - panelWidthM / 2 < spanMin || bayCenter + panelWidthM / 2 > spanMax) continue
    const d = Math.abs(bayCenter - targetOffsetM)
    if (d < bestDist) {
      bestDist = d
      bestCenter = Math.round(bayCenter * 1000) / 1000
    }
  }

  return bestCenter
}
