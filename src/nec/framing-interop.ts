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

function belongsToLevel(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
  levelId: string | null,
): boolean {
  if (!levelId) return true
  let cur: SceneNodeLike | undefined = node
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.id === levelId || cur.parentId === levelId) return true
    cur = cur.parentId ? nodes[cur.parentId] : undefined
  }
  return false
}

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
