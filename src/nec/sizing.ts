/**
 * Deterministic NEC Sizing Calculators:
 * - Table 310.16 Ampacity + 310.15(B)/(C) Temperature & Bundling Derating + 240.4(D) OCPD Caps
 * - Chapter 9 Conduit Fill (EMT, PVC Sch 40, RMC + 60% Nipple Exception)
 * - Article 314.16 Box Fill (Conductors, 2x Yokes, Clamps, Grounds, Support Fittings)
 * - Article 210.19 / 215.2 Voltage Drop (Single-Phase & Three-Phase)
 * - Article 450.3(B) Commercial Dry-Type Transformer Sizing
 */

import {
  AMBIENT_TEMP_CORRECTION_310_15,
  AMPACITY_TABLE_310_16,
  BOX_FILL_VOLUME_PER_CONDUCTOR,
  type BoxFillGauge,
  type BoxType,
  CONDUIT_INTERNAL_AREA_SQIN,
  CONDUIT_SIZE_ORDER,
  CONDUCTOR_SPECS,
  type ConduitTradeSize,
  type ConductorMaterial,
  type InsulationRating,
  type RacewayType,
  SMALL_CONDUCTOR_OCPD_MAX,
  STANDARD_BOX_VOLUMES_CUIN,
  WIRE_GAUGE_ORDER,
  type WireGauge,
  getBundlingAdjustmentFactor,
  nextStandardOcpd,
  round2,
} from './tables'

// ─── Ampacity & Derating (NEC 310.16 / 310.15 / 240.4(D)) ───────────────────

export type AmpacityInput = {
  wireGauge: WireGauge
  material?: ConductorMaterial
  insulationRating?: InsulationRating
  terminalRating?: '60C' | '75C'
  racewayType?: RacewayType
  ambientTempC?: number
  rooftopExposed?: boolean
  currentCarryingCount?: number
  loadAmps?: number
  continuousLoad?: boolean
}

export type AmpacityResult = {
  baseAmpacity90OrRated: number
  terminalCapAmpacity: number
  effectiveAmbientTempC: number
  tempCorrectionFactor: number
  bundlingFactor: number
  deratedAmpacity: number
  finalAllowableAmpacity: number
  maxBreakerAmps: number
  smallConductorCapApplied: boolean
  requiredAmpacity: number
  compliant: boolean
  recommendedGauge: WireGauge
  notes: string[]
}

export function getAmbientTempFactor(
  tempC: number,
  insulationRating: InsulationRating,
): number {
  for (const band of AMBIENT_TEMP_CORRECTION_310_15) {
    if (tempC <= band.maxTempC) return band[insulationRating]
  }
  return 0
}

export function calculateDeratedAmpacity(input: AmpacityInput): AmpacityResult {
  const material = input.material ?? 'cu'
  const racewayType = input.racewayType ?? 'emt'
  const insulationRating: InsulationRating =
    input.insulationRating ?? (racewayType === 'nm-b' ? '90C' : '90C')
  // NEC 334.80: NM-B uses 90°C for derating but final ampacity cannot exceed 60°C column
  const terminalRating: '60C' | '75C' =
    racewayType === 'nm-b' ? '60C' : (input.terminalRating ?? '75C')
  const ambientBase = input.ambientTempC ?? 30
  // Practical NEC rooftop conduit adder (+33°C / +60°F within 7/8" of roof)
  const effectiveAmbientTempC = input.rooftopExposed ? ambientBase + 33 : ambientBase
  const ccc = Math.max(1, input.currentCarryingCount ?? 3)
  const loadAmps = Math.max(0, input.loadAmps ?? 0)
  const requiredAmpacity = round2(input.continuousLoad ? loadAmps * 1.25 : loadAmps)

  const row = AMPACITY_TABLE_310_16[material][input.wireGauge]
  const baseAmpacity = row[insulationRating]
  const terminalCap = row[terminalRating]
  const tempFactor = getAmbientTempFactor(effectiveAmbientTempC, insulationRating)
  const bundlingFactor = getBundlingAdjustmentFactor(ccc)
  const derated = round2(baseAmpacity * tempFactor * bundlingFactor)
  const finalAllowable = round2(Math.min(derated, terminalCap))

  const smallCap = SMALL_CONDUCTOR_OCPD_MAX[material][input.wireGauge]
  let maxBreaker = smallCap !== undefined ? Math.min(smallCap, Math.floor(finalAllowable)) : 0
  let smallConductorCapApplied = false
  if (smallCap !== undefined) {
    smallConductorCapApplied = true
    // NEC 240.4(D) hard cap
    maxBreaker = finalAllowable >= smallCap ? smallCap : nextStandardOcpdFloor(finalAllowable)
  } else {
    // NEC 240.4(B) next-size-up rule for <= 800A non-small conductors
    maxBreaker =
      finalAllowable <= 800
        ? nextStandardOcpd(finalAllowable)
        : nextStandardOcpdFloor(finalAllowable)
  }

  const notes: string[] = []
  if (racewayType === 'nm-b') {
    notes.push('NEC 334.80: NM-B derated from 90°C column, capped at 60°C ampacity.')
  }
  if (input.rooftopExposed) {
    notes.push('Rooftop ambient adder (+33°C / +60°F) applied for exposed roof raceway.')
  }
  if (bundlingFactor < 1) {
    notes.push(`NEC Table 310.15(C)(1): ${ccc} current-carrying conductors -> ${Math.round(bundlingFactor * 100)}% adjustment.`)
  }
  if (smallConductorCapApplied) {
    notes.push(`NEC 240.4(D): ${input.wireGauge} AWG ${material.toUpperCase()} OCPD capped at ${smallCap}A.`)
  }
  if (derated > terminalCap) {
    notes.push(`NEC 110.14(C): ${terminalRating} terminal rating (${terminalCap}A) governs over derated ${derated}A.`)
  }

  const compliant = finalAllowable > 0 && finalAllowable >= requiredAmpacity
  const recommendedGauge = recommendWireGauge({
    ...input,
    loadAmps,
  })

  return {
    baseAmpacity90OrRated: baseAmpacity,
    terminalCapAmpacity: terminalCap,
    effectiveAmbientTempC,
    tempCorrectionFactor: tempFactor,
    bundlingFactor,
    deratedAmpacity: derated,
    finalAllowableAmpacity: finalAllowable,
    maxBreakerAmps: maxBreaker,
    smallConductorCapApplied,
    requiredAmpacity,
    compliant,
    recommendedGauge,
    notes,
  }
}

function nextStandardOcpdFloor(amps: number): number {
  const standards = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 500, 600, 800, 1000, 1200]
  let best = 0
  for (const r of standards) {
    if (r <= amps) best = r
  }
  return best
}

export function recommendWireGauge(
  input: Omit<AmpacityInput, 'wireGauge'>,
): WireGauge {
  const material = input.material ?? 'cu'
  const racewayType = input.racewayType ?? 'emt'
  const insulationRating: InsulationRating = input.insulationRating ?? '90C'
  const terminalRating: '60C' | '75C' =
    racewayType === 'nm-b' ? '60C' : (input.terminalRating ?? '75C')
  const ambientTempC = (input.ambientTempC ?? 30) + (input.rooftopExposed ? 33 : 0)
  const ccc = Math.max(1, input.currentCarryingCount ?? 3)
  const required = (input.loadAmps ?? 0) * (input.continuousLoad ? 1.25 : 1)
  const tempFactor = getAmbientTempFactor(ambientTempC, insulationRating)
  const bundlingFactor = getBundlingAdjustmentFactor(ccc)

  for (const gauge of WIRE_GAUGE_ORDER) {
    const row = AMPACITY_TABLE_310_16[material][gauge]
    if (row[insulationRating] <= 0) continue
    const allowable = Math.min(row[insulationRating] * tempFactor * bundlingFactor, row[terminalRating])
    if (allowable >= required) return gauge
  }
  return '750kcmil'
}

// ─── Conduit Fill (NEC Chapter 9 Tables 1, 4, 5) ────────────────────────────

export type ConduitFillInput = {
  conduitType: 'emt' | 'pvc-40' | 'rmc'
  tradeSize: ConduitTradeSize
  conductors: ReadonlyArray<{ gauge: WireGauge; count: number }>
  lengthInches?: number // <= 24" triggers Chapter 9 Note (4) 60% nipple exception
}

export type ConduitFillResult = {
  conduitType: 'emt' | 'pvc-40' | 'rmc'
  tradeSize: ConduitTradeSize
  totalConductorCount: number
  conductorAreaSqIn: number
  conduitInternalAreaSqIn: number
  maxAllowedFillPct: number
  actualFillPct: number
  nippleExceptionApplied: boolean
  compliant: boolean
  recommendedTradeSize: ConduitTradeSize
}

export function calculateConduitFill(input: ConduitFillInput): ConduitFillResult {
  const totalConductorCount = input.conductors.reduce((sum, c) => sum + Math.max(0, c.count), 0)
  const conductorAreaSqIn = round2(
    input.conductors.reduce(
      (sum, c) => sum + Math.max(0, c.count) * CONDUCTOR_SPECS[c.gauge].thhnAreaSqIn,
      0,
    ) * 100,
  ) / 100

  const nippleExceptionApplied =
    input.lengthInches !== undefined && input.lengthInches > 0 && input.lengthInches <= 24

  let maxAllowedFillPct: number
  if (nippleExceptionApplied) {
    maxAllowedFillPct = 60
  } else if (totalConductorCount <= 1) {
    maxAllowedFillPct = 53
  } else if (totalConductorCount === 2) {
    maxAllowedFillPct = 31
  } else {
    maxAllowedFillPct = 40
  }

  const areaTable = CONDUIT_INTERNAL_AREA_SQIN[input.conduitType]
  const conduitInternalAreaSqIn = areaTable[input.tradeSize]
  const actualFillPct =
    conduitInternalAreaSqIn > 0
      ? round2((conductorAreaSqIn / conduitInternalAreaSqIn) * 100)
      : 0

  let recommendedTradeSize: ConduitTradeSize = '4"'
  for (const size of CONDUIT_SIZE_ORDER) {
    const fill = (conductorAreaSqIn / areaTable[size]) * 100
    if (fill <= maxAllowedFillPct) {
      recommendedTradeSize = size
      break
    }
  }

  return {
    conduitType: input.conduitType,
    tradeSize: input.tradeSize,
    totalConductorCount,
    conductorAreaSqIn: Number(conductorAreaSqIn.toFixed(4)),
    conduitInternalAreaSqIn,
    maxAllowedFillPct,
    actualFillPct,
    nippleExceptionApplied,
    compliant: actualFillPct <= maxAllowedFillPct,
    recommendedTradeSize,
  }
}

// ─── Box Fill (NEC Article 314.16) ──────────────────────────────────────────

export type BoxFillInput = {
  boxType?: BoxType
  customBoxVolumeCuIn?: number
  conductors: ReadonlyArray<{ gauge: BoxFillGauge; count: number }>
  deviceYokeCount?: number // 2 volume allowances per yoke based on largest connected conductor
  internalClampCount?: number // 1 allowance total if >= 1 internal clamp
  supportFittingCount?: number // 1 allowance per stud/hickey
  equipmentGroundCount?: number // 1 allowance for up to 4 EGCs + 0.25 per additional EGC (NEC 2020/2023 314.16(B)(5))
  largestGroundGauge?: BoxFillGauge
}

export type BoxFillResult = {
  boxLabel: string
  boxVolumeCuIn: number
  conductorVolumeCuIn: number
  deviceVolumeCuIn: number
  clampVolumeCuIn: number
  fittingVolumeCuIn: number
  groundVolumeCuIn: number
  totalRequiredCuIn: number
  utilizationPct: number
  compliant: boolean
  recommendedBoxType: BoxType
}

const BOX_GAUGE_ORDER: readonly BoxFillGauge[] = ['18', '16', '14', '12', '10', '8', '6']

function largestGaugeOf(gauges: readonly BoxFillGauge[]): BoxFillGauge {
  let maxIdx = 2 // default 14 AWG
  for (const g of gauges) {
    const idx = BOX_GAUGE_ORDER.indexOf(g)
    if (idx > maxIdx) maxIdx = idx
  }
  return BOX_GAUGE_ORDER[maxIdx]!
}

export function calculateBoxFill(input: BoxFillInput): BoxFillResult {
  const boxEntry = input.boxType ? STANDARD_BOX_VOLUMES_CUIN[input.boxType] : undefined
  const boxVolumeCuIn = input.customBoxVolumeCuIn ?? boxEntry?.volumeCuIn ?? 18.0
  const boxLabel =
    input.customBoxVolumeCuIn !== undefined
      ? `Custom Box (${input.customBoxVolumeCuIn} cu in)`
      : (boxEntry?.label ?? 'Single-Gang Standard (18 cu in)')

  let conductorVolume = 0
  const presentGauges: BoxFillGauge[] = []
  for (const c of input.conductors) {
    if (c.count <= 0) continue
    presentGauges.push(c.gauge)
    conductorVolume += c.count * BOX_FILL_VOLUME_PER_CONDUCTOR[c.gauge]
  }

  const largest = largestGaugeOf(presentGauges)
  const largestVol = BOX_FILL_VOLUME_PER_CONDUCTOR[largest]

  // NEC 314.16(B)(4): 2 volume allowances per device yoke
  const deviceVolume = Math.max(0, input.deviceYokeCount ?? 0) * 2 * largestVol
  // NEC 314.16(B)(2): 1 volume allowance total for all internal cable clamps
  const clampVolume = (input.internalClampCount ?? 0) > 0 ? largestVol : 0
  // NEC 314.16(B)(3): 1 volume allowance per luminaire stud or hickey
  const fittingVolume = Math.max(0, input.supportFittingCount ?? 0) * largestVol
  // NEC 2020/2023 314.16(B)(5): 1 allowance for up to 4 EGCs + 0.25 per additional EGC
  const egcCount = Math.max(0, input.equipmentGroundCount ?? 0)
  const egcVolUnit = BOX_FILL_VOLUME_PER_CONDUCTOR[input.largestGroundGauge ?? largest]
  const groundVolume =
    egcCount === 0 ? 0 : egcCount <= 4 ? egcVolUnit : egcVolUnit * (1 + (egcCount - 4) * 0.25)

  const totalRequired = round2(
    conductorVolume + deviceVolume + clampVolume + fittingVolume + groundVolume,
  )
  const utilizationPct = boxVolumeCuIn > 0 ? round2((totalRequired / boxVolumeCuIn) * 100) : 0

  let recommendedBoxType: BoxType = 'three-gang-standard'
  const sortedBoxes = (Object.entries(STANDARD_BOX_VOLUMES_CUIN) as [BoxType, { volumeCuIn: number }][]).sort(
    (a, b) => a[1].volumeCuIn - b[1].volumeCuIn,
  )
  for (const [bType, spec] of sortedBoxes) {
    if (spec.volumeCuIn >= totalRequired) {
      recommendedBoxType = bType
      break
    }
  }

  return {
    boxLabel,
    boxVolumeCuIn,
    conductorVolumeCuIn: round2(conductorVolume),
    deviceVolumeCuIn: round2(deviceVolume),
    clampVolumeCuIn: round2(clampVolume),
    fittingVolumeCuIn: round2(fittingVolume),
    groundVolumeCuIn: round2(groundVolume),
    totalRequiredCuIn: totalRequired,
    utilizationPct,
    compliant: totalRequired <= boxVolumeCuIn,
    recommendedBoxType,
  }
}

// ─── Voltage Drop (NEC 210.19 / 215.2 Informational Notes) ──────────────────

export type VoltageDropInput = {
  wireGauge: WireGauge
  material?: ConductorMaterial
  loadAmps: number
  oneWayLengthFt: number
  voltage: number // e.g., 120, 208, 240, 277, 480
  phases: 1 | 3
  maxDropPct?: number // default 3% branch (use 5% combined)
}

export type VoltageDropResult = {
  voltageDropVolts: number
  voltageDropPct: number
  maxAllowedPct: number
  compliant: boolean
  recommendedGauge: WireGauge
}

export function calculateVoltageDrop(input: VoltageDropInput): VoltageDropResult {
  const material = input.material ?? 'cu'
  const maxDropPct = input.maxDropPct ?? 3.0
  const phaseMultiplier = input.phases === 3 ? Math.SQRT2 * 1.224744871391589 : 2 // sqrt(3) vs 2
  const kFactor = input.phases === 3 ? Math.sqrt(3) : 2
  void phaseMultiplier

  const computeDropFor = (gauge: WireGauge): { volts: number; pct: number } => {
    const spec = CONDUCTOR_SPECS[gauge]
    const rPerKft = material === 'cu' ? spec.ohmsPerKftCu : spec.ohmsPerKftAl
    const volts = (kFactor * rPerKft * input.loadAmps * input.oneWayLengthFt) / 1000
    const pct = input.voltage > 0 ? (volts / input.voltage) * 100 : 0
    return { volts: round2(volts), pct: round2(pct) }
  }

  const current = computeDropFor(input.wireGauge)
  let recommendedGauge: WireGauge = '750kcmil'
  for (const gauge of WIRE_GAUGE_ORDER) {
    if (material === 'al' && gauge === '14') continue
    if (computeDropFor(gauge).pct <= maxDropPct) {
      recommendedGauge = gauge
      break
    }
  }

  return {
    voltageDropVolts: current.volts,
    voltageDropPct: current.pct,
    maxAllowedPct: maxDropPct,
    compliant: current.pct <= maxDropPct,
    recommendedGauge,
  }
}

// ─── Commercial Dry-Type Transformer Sizing (NEC Article 450.3(B)) ──────────

export type TransformerSizingResult = {
  kvaRating: number
  primaryVoltage: number
  secondaryVoltage: number
  primaryFla: number
  secondaryFla: number
  maxPrimaryOcpdAmps: number
  maxSecondaryOcpdAmps: number
  recommendedPrimaryCuGauge: WireGauge
  recommendedSecondaryCuGauge: WireGauge
}

export function calculateTransformerSizing(
  kvaRating: number,
  primaryVoltage = 480,
  secondaryVoltage = 208,
): TransformerSizingResult {
  const primaryFla = round2((kvaRating * 1000) / (primaryVoltage * Math.sqrt(3)))
  const secondaryFla = round2((kvaRating * 1000) / (secondaryVoltage * Math.sqrt(3)))
  // NEC Table 450.3(B) <= 1000V with primary & secondary protection: 125% primary (next standard size), 125% secondary
  const maxPrimaryOcpdAmps = nextStandardOcpd(primaryFla * 1.25)
  const maxSecondaryOcpdAmps = nextStandardOcpd(secondaryFla * 1.25)
  const recommendedPrimaryCuGauge = recommendWireGauge({
    material: 'cu',
    loadAmps: primaryFla,
    continuousLoad: true,
    terminalRating: '75C',
  })
  const recommendedSecondaryCuGauge = recommendWireGauge({
    material: 'cu',
    loadAmps: secondaryFla,
    continuousLoad: true,
    terminalRating: '75C',
  })

  return {
    kvaRating,
    primaryVoltage,
    secondaryVoltage,
    primaryFla,
    secondaryFla,
    maxPrimaryOcpdAmps,
    maxSecondaryOcpdAmps,
    recommendedPrimaryCuGauge,
    recommendedSecondaryCuGauge,
  }
}
