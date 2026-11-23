/**
 * Live Pascal Scene NEC & Cross-Trade Compliance Auditor.
 *
 * Audits every `electrical:*` node against the live Pascal scene graph (`wall`, `zone`,
 * `item`, `cabinet`, `pipe-*`, `duct-*`, `hvac-equipment`, `beam`, `column`):
 * - NEC 110.26(A) Panel / Transformer Working Space 3D Clearance
 * - NEC 110.26(E) Dedicated Electrical Space (no plumbing pipes / ducts directly over panels)
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
  const dims: Vec3 = toVec3(node.dimensions) ??
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

export function auditSceneElectrical(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): NecSceneAuditReport {
  const all = Object.values(nodes)
  const panels = all.filter((n) => n.type === 'electrical:panel')
  const devices = all.filter((n) => n.type === 'electrical:device')
  const runs = all.filter((n) => n.type === 'electrical:conduit-run')
  const transformers = all.filter((n) => n.type === 'electrical:transformer')
  const obstacles = extractTradeObstacles(nodes)

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

  // 1. Audit Panels: NEC 110.26(A) working clearance, 110.26(E) dedicated overhead space, bus load, phase balance, solar 120%
  for (const panel of panels) {
    const panelName = (typeof panel.name === 'string' && panel.name) || panel.id
    auditEquipmentClearances(panel, 'panel')

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

  // 1d. Audit Step-Down Transformers: NEC 110.26(A) working space & 110.26(E) overhead foreign piping/ducting
  for (const tx of transformers) {
    auditEquipmentClearances(tx, 'transformer')
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
        dev.deviceKind === 'duplex' || dev.deviceKind === 'gfci' || dev.deviceKind === 'afci'

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
        message: `${runName} (segment ${clash.segmentIndex + 1}) intrudes on ${clash.label}. Electrical must route around ${clash.trade} — do not move ${clash.trade}.`,
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
