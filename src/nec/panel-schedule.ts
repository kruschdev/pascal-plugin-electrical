/**
 * Deterministic Panelboard Schedule (1-Phase L1/L2 & 3-Phase A/B/C) & Electrical Material Takeoff.
 * Pure TypeScript — zero React, Three.js, or LLM dependencies.
 */

import type { SceneNodeLike } from './load-calc'
import { polylineLengthM, type Vec3 } from './routing'
import {
  type ConduitTradeSize,
  METERS_TO_FEET,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  getVoltageLineToLine,
  getVoltageLineToNeutral,
  isThreePhaseSystem,
  round2,
} from './tables'

export type PanelSlotEntry = {
  circuitNumber: number
  description: string
  poles: 1 | 2 | 3
  breakerAmps: number
  wireGauge: WireGauge
  loadVa: number
  continuous: boolean
  protection: ('AFCI' | 'GFCI')[]
  deviceIds: string[]
  isContinuation?: boolean
}

export type PanelScheduleRow = {
  leftCircuit: number
  left: PanelSlotEntry | null
  phaseLabel: 'L1' | 'L2' | 'A' | 'B' | 'C'
  right: PanelSlotEntry | null
  rightCircuit: number
}

export type PanelSlotConflict = {
  slot: number
  existingDeviceIds: string[]
  conflictingDeviceIds: string[]
}

export type PanelOverflowCircuit = {
  circuitNumber: number
  poles: 1 | 2 | 3
  deviceIds: string[]
}

export type PanelSchedule = {
  panelId: string
  panelName: string
  occupancy: OccupancyType
  voltageSystem: VoltageSystem
  busRatingAmps: number
  mainBreakerAmps: number
  mainType: 'main-breaker' | 'mlo'
  spaces: number
  usedSpaces: number
  spareSpaces: number
  rows: PanelScheduleRow[]
  phaseVa: { A: number; B: number; C?: number }
  phaseAmps: { A: number; B: number; C?: number }
  totalConnectedVa: number
  totalLineAmps: number
  utilizationPct: number
  imbalancePct: number
  slotConflicts: PanelSlotConflict[]
  overflowCircuits: PanelOverflowCircuit[]
}

export type ElectricalTakeoff = {
  wireByGauge: Record<string, { feet: number; rolls: number; rollSizeFt: number }>
  conduitByTypeAndSize: Record<string, { feet: number; sticks10Ft: number }>
  boxesByType: Record<string, number>
  breakersBySpec: Record<string, number>
  panelCount: number
  transformerCount: number
  deviceCount: number
  totalWireFt: number
  stapleBoxes: number
  wireNutBags: number
}

const WIRE_ROLL_SIZES: Partial<Record<WireGauge, number>> = {
  '14': 250,
  '12': 250,
  '10': 125,
  '8': 125,
  '6': 125,
}

function phaseForRowIndex(rowIndex: number, threePhase: boolean): 'L1' | 'L2' | 'A' | 'B' | 'C' {
  if (threePhase) {
    const phases = ['A', 'B', 'C'] as const
    return phases[rowIndex % 3]!
  }
  return rowIndex % 2 === 0 ? 'L1' : 'L2'
}

function occupiedSlotsOf(
  devices: readonly SceneNodeLike[],
  panelId?: string,
): Set<number> {
  const occupied = new Set<number>()
  for (const dev of devices) {
    if (panelId && dev.panelId !== panelId) continue
    const rawCkt =
      typeof dev.circuitNumber === 'number' && dev.circuitNumber >= 1
        ? Math.floor(dev.circuitNumber)
        : 0
    if (rawCkt <= 0) continue
    const poles: 1 | 2 | 3 = dev.poles === 3 ? 3 : dev.poles === 2 ? 2 : 1
    for (let p = 0; p < poles; p++) {
      occupied.add(rawCkt + p * 2)
    }
  }
  return occupied
}

/**
 * Find the lowest free starting slot (`1..spaces`) on `panel` whose full multi-pole span
 * (`ckt, ckt+2, ..., ckt+(poles-1)*2`) does not collide with any existing circuit or exceed `spaces`.
 */
export function findNextFreePanelCircuit(
  panel: SceneNodeLike | null | undefined,
  existingDevices: readonly SceneNodeLike[],
  poles: 1 | 2 | 3 = 1,
): number {
  const maxSpaces = Math.min(
    84,
    Math.max(4, Math.ceil((typeof panel?.spaces === 'number' ? panel.spaces : 40) / 2) * 2),
  )
  const occupied = occupiedSlotsOf(existingDevices, panel?.id)
  for (let ckt = 1; ckt <= maxSpaces; ckt++) {
    let fits = true
    for (let p = 0; p < poles; p++) {
      const slot = ckt + p * 2
      if (slot > maxSpaces || occupied.has(slot)) {
        fits = false
        break
      }
    }
    if (fits) return ckt
  }
  return Math.min(84, maxSpaces)
}

export function buildPanelSchedule(
  panel: SceneNodeLike,
  devices: readonly SceneNodeLike[],
  runs: readonly SceneNodeLike[] = [],
): PanelSchedule {
  const occupancy: OccupancyType = panel.occupancy === 'commercial' ? 'commercial' : 'residential'
  const voltageSystem: VoltageSystem =
    panel.voltageSystem === '120/208V-3P' || panel.voltageSystem === '277/480V-3P'
      ? panel.voltageSystem
      : '120/240V-1P'
  const threePhase = isThreePhaseSystem(voltageSystem)
  const busRatingAmps = typeof panel.busRatingAmps === 'number' ? panel.busRatingAmps : 200
  const mainBreakerAmps = typeof panel.mainBreakerAmps === 'number' ? panel.mainBreakerAmps : busRatingAmps
  const mainType = panel.mainType === 'mlo' ? 'mlo' : 'main-breaker'
  const spaces = Math.max(4, Math.ceil((typeof panel.spaces === 'number' ? panel.spaces : 40) / 2) * 2)

  const panelDevices = devices.filter((d) => d.panelId === panel.id)
  const panelRuns = runs.filter((r) => r.panelId === panel.id)

  // Group explicit circuits first; assign unassigned devices (`circuitNumber <= 0`) to non-colliding slots
  const grouped = new Map<number, SceneNodeLike[]>()
  const explicitOccupied = occupiedSlotsOf(panelDevices, panel.id)
  let autoCursor = 1
  const allocateFreeSlot = (poles: 1 | 2 | 3): number => {
    while (autoCursor <= 200) {
      const candidate = autoCursor++
      let free = true
      for (let p = 0; p < poles; p++) {
        if (explicitOccupied.has(candidate + p * 2)) {
          free = false
          break
        }
      }
      if (free) {
        for (let p = 0; p < poles; p++) explicitOccupied.add(candidate + p * 2)
        return candidate
      }
    }
    return autoCursor
  }

  for (const dev of panelDevices) {
    const rawCkt =
      typeof dev.circuitNumber === 'number' && dev.circuitNumber >= 1
        ? Math.floor(dev.circuitNumber)
        : 0
    const poles: 1 | 2 | 3 = dev.poles === 3 ? 3 : dev.poles === 2 ? 2 : 1
    const ckt = rawCkt > 0 ? rawCkt : allocateFreeSlot(poles)
    const list = grouped.get(ckt) ?? []
    list.push(dev)
    grouped.set(ckt, list)
  }

  const slotMap = new Map<number, PanelSlotEntry>()
  const slotConflicts: PanelSlotConflict[] = []
  const overflowCircuits: PanelOverflowCircuit[] = []

  const sortedCircuits = Array.from(grouped.entries()).sort((a, b) => a[0] - b[0])

  for (const [ckt, devs] of sortedCircuits) {
    const first = devs[0]!
    const poles: 1 | 2 | 3 =
      first.poles === 3 ? 3 : first.poles === 2 ? 2 : 1
    const breakerAmps = typeof first.breakerAmps === 'number' ? first.breakerAmps : 20
    const runMatch = panelRuns.find((r) => r.circuitNumber === ckt)
    const wireGauge: WireGauge =
      (typeof runMatch?.wireGauge === 'string' ? (runMatch.wireGauge as WireGauge) : undefined) ??
      (typeof first.wireGauge === 'string' ? (first.wireGauge as WireGauge) : breakerAmps <= 15 ? '14' : breakerAmps <= 20 ? '12' : '10')

    const totalVa = devs.reduce((sum, d) => sum + (typeof d.loadVa === 'number' ? d.loadVa : 180), 0)
    const continuous = devs.some((d) => d.continuous === true)
    const protectionSet = new Set<'AFCI' | 'GFCI'>()
    for (const d of devs) {
      if (d.afciProtected === true || d.deviceKind === 'afci') protectionSet.add('AFCI')
      if (d.gfciProtected === true || d.deviceKind === 'gfci') protectionSet.add('GFCI')
    }
    const label =
      devs.length === 1
        ? (typeof first.name === 'string' && first.name) || String(first.deviceKind ?? 'Circuit')
        : `${String(first.name ?? first.deviceKind ?? 'Branch')} (${devs.length} devices)`

    const devIds = devs.map((d) => d.id)
    const maxPoleSlot = ckt + (poles - 1) * 2
    if (maxPoleSlot > spaces) {
      overflowCircuits.push({ circuitNumber: ckt, poles, deviceIds: devIds })
    }

    const entry: PanelSlotEntry = {
      circuitNumber: ckt,
      description: label,
      poles,
      breakerAmps,
      wireGauge,
      loadVa: Math.round(totalVa),
      continuous,
      protection: Array.from(protectionSet),
      deviceIds: devIds,
    }

    const existingPrimary = slotMap.get(ckt)
    if (existingPrimary) {
      slotConflicts.push({
        slot: ckt,
        existingDeviceIds: existingPrimary.deviceIds,
        conflictingDeviceIds: devIds,
      })
      continue
    }

    if (ckt <= spaces) {
      slotMap.set(ckt, entry)
    }

    // Multi-pole breakers occupy consecutive odd or even slots (+2 per additional pole)
    for (let p = 1; p < poles; p++) {
      const contCkt = ckt + p * 2
      if (contCkt > spaces) continue
      const existingCont = slotMap.get(contCkt)
      if (existingCont) {
        slotConflicts.push({
          slot: contCkt,
          existingDeviceIds: existingCont.deviceIds,
          conflictingDeviceIds: devIds,
        })
        continue
      }
      slotMap.set(contCkt, {
        ...entry,
        circuitNumber: contCkt,
        description: `↳ ${label} (Pole ${p + 1}/${poles})`,
        loadVa: 0,
        isContinuation: true,
      })
    }
  }

  const vLN = getVoltageLineToNeutral(voltageSystem)
  const vLL = getVoltageLineToLine(voltageSystem)

  const phaseVa = { A: 0, B: 0, C: threePhase ? 0 : undefined as number | undefined }
  const rawPhaseAmps = { A: 0, B: 0, C: threePhase ? 0 : undefined as number | undefined }
  const rows: PanelScheduleRow[] = []
  const rowCount = spaces / 2

  const addLoadToPhases = (slot: PanelSlotEntry, startRowIdx: number) => {
    if (slot.isContinuation || slot.loadVa <= 0) return
    const vaPerPole = slot.loadVa / slot.poles
    // Exact line current per pole:
    // - 1-pole: VA / V_LN
    // - 2-pole line-to-line (240V 1Φ or 208V/480V 3Φ wye): VA / V_LL on each of the 2 connected phases
    // - 3-pole balanced 3Φ: VA / (V_LL * sqrt(3)) on each of phases A, B, C
    const ampsPerPole =
      slot.poles === 1
        ? slot.loadVa / vLN
        : slot.poles === 2
          ? slot.loadVa / vLL
          : slot.loadVa / (vLL * Math.sqrt(3))

    for (let p = 0; p < slot.poles; p++) {
      const ph = phaseForRowIndex(startRowIdx + p, threePhase)
      if (ph === 'L1' || ph === 'A') {
        phaseVa.A += vaPerPole
        rawPhaseAmps.A += ampsPerPole
      } else if (ph === 'L2' || ph === 'B') {
        phaseVa.B += vaPerPole
        rawPhaseAmps.B += ampsPerPole
      } else if (ph === 'C' && phaseVa.C !== undefined && rawPhaseAmps.C !== undefined) {
        phaseVa.C += vaPerPole
        rawPhaseAmps.C += ampsPerPole
      }
    }
  }

  for (let r = 0; r < rowCount; r++) {
    const leftCkt = r * 2 + 1
    const rightCkt = r * 2 + 2
    const left = slotMap.get(leftCkt) ?? null
    const right = slotMap.get(rightCkt) ?? null
    if (left) addLoadToPhases(left, r)
    if (right) addLoadToPhases(right, r)

    rows.push({
      leftCircuit: leftCkt,
      left,
      phaseLabel: phaseForRowIndex(r, threePhase),
      right,
      rightCircuit: rightCkt,
    })
  }

  const phaseAmps = {
    A: round2(rawPhaseAmps.A),
    B: round2(rawPhaseAmps.B),
    C: rawPhaseAmps.C !== undefined ? round2(rawPhaseAmps.C) : undefined,
  }

  const totalConnectedVa = Math.round(phaseVa.A + phaseVa.B + (phaseVa.C ?? 0))
  const totalLineAmps = round2(
    threePhase ? totalConnectedVa / (vLL * Math.sqrt(3)) : totalConnectedVa / vLL,
  )
  const effectiveRating = mainType === 'main-breaker' ? Math.min(busRatingAmps, mainBreakerAmps) : busRatingAmps
  const utilizationPct = effectiveRating > 0 ? round2((totalLineAmps / effectiveRating) * 100) : 0

  const phaseValues = threePhase ? [phaseVa.A, phaseVa.B, phaseVa.C ?? 0] : [phaseVa.A, phaseVa.B]
  const maxPh = Math.max(...phaseValues)
  const minPh = Math.min(...phaseValues)
  const imbalancePct = maxPh > 0 ? round2(((maxPh - minPh) / maxPh) * 100) : 0

  const usedSpaces = Array.from(slotMap.keys()).filter((k) => k <= spaces).length
  return {
    panelId: panel.id,
    panelName: (typeof panel.name === 'string' && panel.name) || panel.id,
    occupancy,
    voltageSystem,
    busRatingAmps,
    mainBreakerAmps,
    mainType,
    spaces,
    usedSpaces,
    spareSpaces: Math.max(0, spaces - usedSpaces),
    rows,
    phaseVa: {
      A: Math.round(phaseVa.A),
      B: Math.round(phaseVa.B),
      ...(phaseVa.C !== undefined ? { C: Math.round(phaseVa.C) } : {}),
    },
    phaseAmps,
    totalConnectedVa,
    totalLineAmps,
    utilizationPct,
    imbalancePct,
    slotConflicts,
    overflowCircuits,
  }
}

export function formatPanelScheduleCsv(schedule: PanelSchedule): string {
  const header =
    'Left Ckt,Left Description,Left Poles,Left Breaker (A),Left Wire,Left VA,Phase,Right VA,Right Wire,Right Breaker (A),Right Poles,Right Description,Right Ckt'
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [header]
  for (const row of schedule.rows) {
    const l = row.left
    const r = row.right
    lines.push(
      [
        row.leftCircuit,
        l ? esc(l.description) : 'SPARE',
        l ? l.poles : '',
        l ? l.breakerAmps : '',
        l ? `#${l.wireGauge}` : '',
        l ? l.loadVa : 0,
        row.phaseLabel,
        r ? r.loadVa : 0,
        r ? `#${r.wireGauge}` : '',
        r ? r.breakerAmps : '',
        r ? r.poles : '',
        r ? esc(r.description) : 'SPARE',
        row.rightCircuit,
      ].join(','),
    )
  }
  return lines.join('\n')
}

export function buildElectricalTakeoff(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): ElectricalTakeoff {
  const all = Object.values(nodes)
  const panels = all.filter((n) => n.type === 'electrical:panel')
  const devices = all.filter((n) => n.type === 'electrical:device')
  const runs = all.filter((n) => n.type === 'electrical:conduit-run')
  const transformers = all.filter((n) => n.type === 'electrical:transformer')

  const wireFeetByGauge: Record<string, number> = {}
  const conduitFeet: Record<string, number> = {}
  const boxesByType: Record<string, number> = {}
  const breakersBySpec: Record<string, number> = {}

  for (const run of runs) {
    const path = Array.isArray(run.path) ? (run.path as Vec3[]) : []
    const lenFt = polylineLengthM(path) * METERS_TO_FEET
    if (lenFt <= 0) continue

    const raceway: RacewayType =
      typeof run.racewayType === 'string' ? (run.racewayType as RacewayType) : 'emt'
    const tradeSize: ConduitTradeSize =
      typeof run.tradeSize === 'string' ? (run.tradeSize as ConduitTradeSize) : '3/4"'
    const gauge: WireGauge =
      typeof run.wireGauge === 'string' ? (run.wireGauge as WireGauge) : '12'
    const conductors = typeof run.totalConductorCount === 'number' ? Math.max(2, run.totalConductorCount) : 3

    // For cables (NM-B/MC) footage is cable length; for conduit (EMT/PVC/RMC) conductor footage is length * conductor count
    const isCable = raceway === 'nm-b' || raceway === 'mc'
    const wireKey = isCable ? `${raceway.toUpperCase()} #${gauge}` : `THHN #${gauge} AWG`
    wireFeetByGauge[wireKey] = (wireFeetByGauge[wireKey] ?? 0) + (isCable ? lenFt : lenFt * conductors)

    if (!isCable) {
      const cKey = `${tradeSize} ${raceway.toUpperCase()}`
      conduitFeet[cKey] = (conduitFeet[cKey] ?? 0) + lenFt
    }
  }

  const seenCircuitBreakers = new Set<string>()
  for (const dev of devices) {
    const bType = typeof dev.boxType === 'string' ? dev.boxType : 'single-gang-standard'
    boxesByType[bType] = (boxesByType[bType] ?? 0) + 1

    const panelId = typeof dev.panelId === 'string' ? dev.panelId : 'unassigned'
    const ckt = typeof dev.circuitNumber === 'number' ? dev.circuitNumber : 0
    const bKey = `${panelId}:${ckt}`
    if (ckt > 0 && !seenCircuitBreakers.has(bKey)) {
      seenCircuitBreakers.add(bKey)
      const poles = dev.poles === 3 ? 3 : dev.poles === 2 ? 2 : 1
      const amps = typeof dev.breakerAmps === 'number' ? dev.breakerAmps : 20
      const prot = [
        dev.afciProtected || dev.deviceKind === 'afci' ? 'AFCI' : '',
        dev.gfciProtected || dev.deviceKind === 'gfci' ? 'GFCI' : '',
      ]
        .filter(Boolean)
        .join('/')
      const spec = `${poles}P-${amps}A${prot ? ` ${prot}` : ''}`
      breakersBySpec[spec] = (breakersBySpec[spec] ?? 0) + 1
    }
  }

  const wireByGauge: ElectricalTakeoff['wireByGauge'] = {}
  let totalWireFt = 0
  for (const [key, rawFt] of Object.entries(wireFeetByGauge)) {
    const withWaste = Math.ceil(rawFt * 1.1)
    const gaugeMatch = key.match(/#([0-9/]+(?:kcmil)?)/)
    const rollSizeFt = (gaugeMatch?.[1] && WIRE_ROLL_SIZES[gaugeMatch[1] as WireGauge]) || 250
    wireByGauge[key] = {
      feet: withWaste,
      rolls: Math.ceil(withWaste / rollSizeFt),
      rollSizeFt,
    }
    totalWireFt += withWaste
  }

  const conduitByTypeAndSize: ElectricalTakeoff['conduitByTypeAndSize'] = {}
  for (const [key, rawFt] of Object.entries(conduitFeet)) {
    const withWaste = Math.ceil(rawFt * 1.1)
    conduitByTypeAndSize[key] = {
      feet: withWaste,
      sticks10Ft: Math.ceil(withWaste / 10),
    }
  }

  return {
    wireByGauge,
    conduitByTypeAndSize,
    boxesByType,
    breakersBySpec,
    panelCount: panels.length,
    transformerCount: transformers.length,
    deviceCount: devices.length,
    totalWireFt,
    stapleBoxes: totalWireFt > 0 ? Math.ceil(totalWireFt / 4.5 / 200) : 0,
    wireNutBags: devices.length > 0 ? Math.ceil((devices.length * 3) / 100) : 0,
  }
}
