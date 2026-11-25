/**
 * Deterministic NEC Reference Tables (Residential & Commercial).
 * Pure TypeScript engineering constants — zero React, Three.js, or LLM dependencies.
 *
 * Basis: NEC 2023 (NFPA 70) / IEEE & AWG conductor specifications.
 * Drafting & engineering aid — verify local AHJ amendments before construction.
 */

export type OccupancyType = 'residential' | 'commercial'

export type VoltageSystem = '120/240V-1P' | '120/208V-3P' | '277/480V-3P'

export type ConductorMaterial = 'cu' | 'al'

export type InsulationRating = '60C' | '75C' | '90C'

export type RacewayType = 'nm-b' | 'mc' | 'emt' | 'pvc-40' | 'rmc'

export type ConduitTradeSize =
  | '1/2"'
  | '3/4"'
  | '1"'
  | '1-1/4"'
  | '1-1/2"'
  | '2"'
  | '2-1/2"'
  | '3"'
  | '4"'

export type WireGauge =
  | '14'
  | '12'
  | '10'
  | '8'
  | '6'
  | '4'
  | '3'
  | '2'
  | '1'
  | '1/0'
  | '2/0'
  | '3/0'
  | '4/0'
  | '250kcmil'
  | '300kcmil'
  | '350kcmil'
  | '400kcmil'
  | '500kcmil'
  | '600kcmil'
  | '750kcmil'

export type BoxFillGauge = '18' | '16' | '14' | '12' | '10' | '8' | '6'

export type BoxType =
  | 'single-gang-shallow'
  | 'single-gang-standard'
  | 'single-gang-deep'
  | 'two-gang-standard'
  | 'two-gang-deep'
  | 'three-gang-standard'
  | '4-sq-1.25'
  | '4-sq-1.5'
  | '4-sq-2.125'
  | '4-11-16-1.5'
  | '4-11-16-2.125'
  | '4-oct-1.5'
  | '4-oct-2.125'

export type CommercialOccupancy =
  | 'office'
  | 'retail'
  | 'warehouse'
  | 'restaurant'
  | 'school'
  | 'healthcare'
  | 'industrial'
  | 'garage'

export type WorkingSpaceCondition = 1 | 2 | 3

export const METERS_TO_FEET = 3.280839895013123
export const FEET_TO_METERS = 0.3048
export const INCHES_TO_METERS = 0.0254
export const SQM_TO_SQFT = 10.763910416709722

export const WIRE_GAUGE_ORDER: readonly WireGauge[] = [
  '14',
  '12',
  '10',
  '8',
  '6',
  '4',
  '3',
  '2',
  '1',
  '1/0',
  '2/0',
  '3/0',
  '4/0',
  '250kcmil',
  '300kcmil',
  '350kcmil',
  '400kcmil',
  '500kcmil',
  '600kcmil',
  '750kcmil',
]

export const CONDUIT_SIZE_ORDER: readonly ConduitTradeSize[] = [
  '1/2"',
  '3/4"',
  '1"',
  '1-1/4"',
  '1-1/2"',
  '2"',
  '2-1/2"',
  '3"',
  '4"',
]

export const STANDARD_OCPD_RATINGS: readonly number[] = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200,
  225, 250, 300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200,
]

export const STANDARD_SERVICE_SIZES: readonly number[] = [
  100, 125, 150, 200, 225, 300, 400, 600, 800, 1000, 1200,
]

/**
 * Conductor electrical properties (AWG/kcmil).
 * - cmil: cross-sectional area in circular mils
 * - ohmsPerKftCu: NEC Chapter 9 Table 8 DC resistance at 75°C (Ohms per 1000 ft, Cu)
 * - ohmsPerKftAl: NEC Chapter 9 Table 8 DC resistance at 75°C (Ohms per 1000 ft, Al)
 * - thhnAreaSqIn: NEC Chapter 9 Table 5 THHN/THWN-2 approximate area (sq in)
 */
export type ConductorSpec = {
  readonly cmil: number
  readonly ohmsPerKftCu: number
  readonly ohmsPerKftAl: number
  readonly thhnAreaSqIn: number
}

export const CONDUCTOR_SPECS: Readonly<Record<WireGauge, ConductorSpec>> = {
  '14': { cmil: 4110, ohmsPerKftCu: 3.07, ohmsPerKftAl: 5.06, thhnAreaSqIn: 0.0097 },
  '12': { cmil: 6530, ohmsPerKftCu: 1.93, ohmsPerKftAl: 3.18, thhnAreaSqIn: 0.0133 },
  '10': { cmil: 10380, ohmsPerKftCu: 1.21, ohmsPerKftAl: 2.0, thhnAreaSqIn: 0.0211 },
  '8': { cmil: 16510, ohmsPerKftCu: 0.764, ohmsPerKftAl: 1.26, thhnAreaSqIn: 0.0366 },
  '6': { cmil: 26240, ohmsPerKftCu: 0.491, ohmsPerKftAl: 0.808, thhnAreaSqIn: 0.0507 },
  '4': { cmil: 41740, ohmsPerKftCu: 0.308, ohmsPerKftAl: 0.508, thhnAreaSqIn: 0.0824 },
  '3': { cmil: 52620, ohmsPerKftCu: 0.245, ohmsPerKftAl: 0.403, thhnAreaSqIn: 0.0973 },
  '2': { cmil: 66360, ohmsPerKftCu: 0.194, ohmsPerKftAl: 0.319, thhnAreaSqIn: 0.1158 },
  '1': { cmil: 83690, ohmsPerKftCu: 0.154, ohmsPerKftAl: 0.253, thhnAreaSqIn: 0.1562 },
  '1/0': { cmil: 105600, ohmsPerKftCu: 0.122, ohmsPerKftAl: 0.201, thhnAreaSqIn: 0.1855 },
  '2/0': { cmil: 133100, ohmsPerKftCu: 0.0967, ohmsPerKftAl: 0.159, thhnAreaSqIn: 0.2223 },
  '3/0': { cmil: 167800, ohmsPerKftCu: 0.0766, ohmsPerKftAl: 0.126, thhnAreaSqIn: 0.2679 },
  '4/0': { cmil: 211600, ohmsPerKftCu: 0.0608, ohmsPerKftAl: 0.1, thhnAreaSqIn: 0.3237 },
  '250kcmil': { cmil: 250000, ohmsPerKftCu: 0.0515, ohmsPerKftAl: 0.0847, thhnAreaSqIn: 0.397 },
  '300kcmil': { cmil: 300000, ohmsPerKftCu: 0.0429, ohmsPerKftAl: 0.0707, thhnAreaSqIn: 0.4608 },
  '350kcmil': { cmil: 350000, ohmsPerKftCu: 0.0367, ohmsPerKftAl: 0.0605, thhnAreaSqIn: 0.5242 },
  '400kcmil': { cmil: 400000, ohmsPerKftCu: 0.0321, ohmsPerKftAl: 0.0529, thhnAreaSqIn: 0.5863 },
  '500kcmil': { cmil: 500000, ohmsPerKftCu: 0.0258, ohmsPerKftAl: 0.0424, thhnAreaSqIn: 0.7073 },
  '600kcmil': { cmil: 600000, ohmsPerKftCu: 0.0214, ohmsPerKftAl: 0.0353, thhnAreaSqIn: 0.8676 },
  '750kcmil': { cmil: 750000, ohmsPerKftCu: 0.0171, ohmsPerKftAl: 0.0282, thhnAreaSqIn: 1.0496 },
}

/**
 * NEC Table 310.16 — Allowable Ampacities of Insulated Conductors
 * (<= 3 current-carrying conductors in raceway/cable, 30°C / 86°F ambient).
 */
export const AMPACITY_TABLE_310_16: Readonly<
  Record<ConductorMaterial, Readonly<Record<WireGauge, Readonly<Record<InsulationRating, number>>>>>
> = {
  cu: {
    '14': { '60C': 15, '75C': 20, '90C': 25 },
    '12': { '60C': 20, '75C': 25, '90C': 30 },
    '10': { '60C': 30, '75C': 35, '90C': 40 },
    '8': { '60C': 40, '75C': 50, '90C': 55 },
    '6': { '60C': 55, '75C': 65, '90C': 75 },
    '4': { '60C': 70, '75C': 85, '90C': 95 },
    '3': { '60C': 85, '75C': 100, '90C': 115 },
    '2': { '60C': 95, '75C': 115, '90C': 130 },
    '1': { '60C': 110, '75C': 130, '90C': 145 },
    '1/0': { '60C': 125, '75C': 150, '90C': 170 },
    '2/0': { '60C': 145, '75C': 175, '90C': 195 },
    '3/0': { '60C': 165, '75C': 200, '90C': 225 },
    '4/0': { '60C': 195, '75C': 230, '90C': 260 },
    '250kcmil': { '60C': 215, '75C': 255, '90C': 290 },
    '300kcmil': { '60C': 240, '75C': 285, '90C': 320 },
    '350kcmil': { '60C': 260, '75C': 310, '90C': 350 },
    '400kcmil': { '60C': 280, '75C': 335, '90C': 380 },
    '500kcmil': { '60C': 320, '75C': 380, '90C': 430 },
    '600kcmil': { '60C': 350, '75C': 420, '90C': 475 },
    '750kcmil': { '60C': 400, '75C': 475, '90C': 535 },
  },
  al: {
    '14': { '60C': 0, '75C': 0, '90C': 0 }, // Not permitted for Al branch wiring
    '12': { '60C': 15, '75C': 20, '90C': 25 },
    '10': { '60C': 25, '75C': 30, '90C': 35 },
    '8': { '60C': 35, '75C': 40, '90C': 45 },
    '6': { '60C': 40, '75C': 50, '90C': 55 },
    '4': { '60C': 55, '75C': 65, '90C': 75 },
    '3': { '60C': 65, '75C': 75, '90C': 85 },
    '2': { '60C': 75, '75C': 90, '90C': 100 },
    '1': { '60C': 85, '75C': 100, '90C': 115 },
    '1/0': { '60C': 100, '75C': 120, '90C': 135 },
    '2/0': { '60C': 115, '75C': 135, '90C': 150 },
    '3/0': { '60C': 130, '75C': 155, '90C': 175 },
    '4/0': { '60C': 150, '75C': 180, '90C': 205 },
    '250kcmil': { '60C': 170, '75C': 205, '90C': 230 },
    '300kcmil': { '60C': 195, '75C': 230, '90C': 260 },
    '350kcmil': { '60C': 210, '75C': 250, '90C': 280 },
    '400kcmil': { '60C': 225, '75C': 270, '90C': 305 },
    '500kcmil': { '60C': 260, '75C': 310, '90C': 350 },
    '600kcmil': { '60C': 285, '75C': 340, '90C': 385 },
    '750kcmil': { '60C': 320, '75C': 385, '90C': 435 },
  },
}

/** NEC 240.4(D) Small-Conductor Overcurrent Protection Limits */
export const SMALL_CONDUCTOR_OCPD_MAX: Readonly<
  Record<ConductorMaterial, Partial<Record<WireGauge, number>>>
> = {
  cu: { '14': 15, '12': 20, '10': 30 },
  al: { '12': 15, '10': 25 },
}

/** NEC Table 310.15(B)(1) Ambient Temperature Correction Factors (base 30°C) */
export type AmbientTempBand = {
  readonly maxTempC: number
  readonly '60C': number
  readonly '75C': number
  readonly '90C': number
}

export const AMBIENT_TEMP_CORRECTION_310_15: readonly AmbientTempBand[] = [
  { maxTempC: 10, '60C': 1.29, '75C': 1.2, '90C': 1.15 },
  { maxTempC: 15, '60C': 1.22, '75C': 1.15, '90C': 1.12 },
  { maxTempC: 20, '60C': 1.15, '75C': 1.11, '90C': 1.08 },
  { maxTempC: 25, '60C': 1.08, '75C': 1.05, '90C': 1.04 },
  { maxTempC: 30, '60C': 1.0, '75C': 1.0, '90C': 1.0 },
  { maxTempC: 35, '60C': 0.91, '75C': 0.94, '90C': 0.96 },
  { maxTempC: 40, '60C': 0.82, '75C': 0.88, '90C': 0.91 },
  { maxTempC: 45, '60C': 0.71, '75C': 0.82, '90C': 0.87 },
  { maxTempC: 50, '60C': 0.58, '75C': 0.75, '90C': 0.82 },
  { maxTempC: 55, '60C': 0.41, '75C': 0.67, '90C': 0.76 },
  { maxTempC: 60, '60C': 0, '75C': 0.58, '90C': 0.71 },
  { maxTempC: 65, '60C': 0, '75C': 0.47, '90C': 0.65 },
  { maxTempC: 70, '60C': 0, '75C': 0.33, '90C': 0.58 },
  { maxTempC: 80, '60C': 0, '75C': 0, '90C': 0.41 },
]

/** NEC Table 310.15(C)(1) Bundling Adjustment Factors (> 3 current-carrying conductors) */
export function getBundlingAdjustmentFactor(currentCarryingCount: number): number {
  if (currentCarryingCount <= 3) return 1.0
  if (currentCarryingCount <= 6) return 0.8
  if (currentCarryingCount <= 9) return 0.7
  if (currentCarryingCount <= 20) return 0.5
  if (currentCarryingCount <= 30) return 0.45
  if (currentCarryingCount <= 40) return 0.4
  return 0.35
}

/**
 * NEC Chapter 9 Table 4 — Internal Cross-Sectional Area (sq in) for EMT, PVC Sch 40, RMC.
 */
export const CONDUIT_INTERNAL_AREA_SQIN: Readonly<
  Record<'emt' | 'pvc-40' | 'rmc', Readonly<Record<ConduitTradeSize, number>>>
> = {
  emt: {
    '1/2"': 0.304,
    '3/4"': 0.533,
    '1"': 0.864,
    '1-1/4"': 1.496,
    '1-1/2"': 2.036,
    '2"': 3.356,
    '2-1/2"': 5.858,
    '3"': 8.846,
    '4"': 15.901,
  },
  'pvc-40': {
    '1/2"': 0.285,
    '3/4"': 0.508,
    '1"': 0.832,
    '1-1/4"': 1.453,
    '1-1/2"': 1.986,
    '2"': 3.291,
    '2-1/2"': 4.695,
    '3"': 7.268,
    '4"': 12.554,
  },
  rmc: {
    '1/2"': 0.314,
    '3/4"': 0.549,
    '1"': 0.887,
    '1-1/4"': 1.526,
    '1-1/2"': 2.071,
    '2"': 3.408,
    '2-1/2"': 4.866,
    '3"': 7.499,
    '4"': 12.882,
  },
}

/** Outer diameter in meters for 3D rendering & obstacle clearances */
export const CONDUIT_OUTER_DIAMETER_M: Readonly<Record<ConduitTradeSize, number>> = {
  '1/2"': 0.018,
  '3/4"': 0.023,
  '1"': 0.03,
  '1-1/4"': 0.038,
  '1-1/2"': 0.044,
  '2"': 0.056,
  '2-1/2"': 0.073,
  '3"': 0.089,
  '4"': 0.114,
}

/** NEC Table 314.16(B) — Volume Allowance Required per Conductor (cu in) */
export const BOX_FILL_VOLUME_PER_CONDUCTOR: Readonly<Record<BoxFillGauge, number>> = {
  '18': 1.5,
  '16': 1.75,
  '14': 2.0,
  '12': 2.25,
  '10': 2.5,
  '8': 3.0,
  '6': 5.0,
}

/** Standard Metal & Nonmetallic Box Volumes (cu in) per NEC 314.16(A) / standard markings */
export const STANDARD_BOX_VOLUMES_CUIN: Readonly<
  Record<BoxType, { readonly label: string; readonly volumeCuIn: number }>
> = {
  'single-gang-shallow': { label: 'Single-Gang Shallow (14 cu in)', volumeCuIn: 14.0 },
  'single-gang-standard': { label: 'Single-Gang Standard (18 cu in)', volumeCuIn: 18.0 },
  'single-gang-deep': { label: 'Single-Gang Deep (22.5 cu in)', volumeCuIn: 22.5 },
  'two-gang-standard': { label: 'Two-Gang Standard (32 cu in)', volumeCuIn: 32.0 },
  'two-gang-deep': { label: 'Two-Gang Deep (42 cu in)', volumeCuIn: 42.0 },
  'three-gang-standard': { label: 'Three-Gang Standard (48 cu in)', volumeCuIn: 48.0 },
  '4-sq-1.25': { label: '4" Square x 1-1/4" (18.0 cu in)', volumeCuIn: 18.0 },
  '4-sq-1.5': { label: '4" Square x 1-1/2" (21.0 cu in)', volumeCuIn: 21.0 },
  '4-sq-2.125': { label: '4" Square x 2-1/8" (30.3 cu in)', volumeCuIn: 30.3 },
  '4-11-16-1.5': { label: '4-11/16" Square x 1-1/2" (29.5 cu in)', volumeCuIn: 29.5 },
  '4-11-16-2.125': { label: '4-11/16" Square x 2-1/8" (42.0 cu in)', volumeCuIn: 42.0 },
  '4-oct-1.5': { label: '4" Octagonal x 1-1/2" (15.5 cu in)', volumeCuIn: 15.5 },
  '4-oct-2.125': { label: '4" Octagonal x 2-1/8" (21.5 cu in)', volumeCuIn: 21.5 },
}

/**
 * NEC 2023 Table 220.12 — Commercial General Lighting Unit Loads (VA / sq ft).
 * Note: NEC 2020/2023 updated commercial unit loads to reflect LED efficiency
 * (the 125% continuous multiplier is already reflected or applied explicitly per 210.19/215.2).
 */
export const COMMERCIAL_LIGHTING_VA_PER_SQFT: Readonly<
  Record<CommercialOccupancy, { readonly label: string; readonly vaPerSqFt: number }>
> = {
  office: { label: 'Office Building', vaPerSqFt: 1.3 },
  retail: { label: 'Retail / Mercantile', vaPerSqFt: 1.9 },
  warehouse: { label: 'Warehouse / Storage', vaPerSqFt: 0.25 },
  restaurant: { label: 'Restaurant / Dining', vaPerSqFt: 1.5 },
  school: { label: 'School / Educational', vaPerSqFt: 1.4 },
  healthcare: { label: 'Healthcare / Clinic', vaPerSqFt: 1.6 },
  industrial: { label: 'Industrial / Commercial Loft', vaPerSqFt: 1.5 },
  garage: { label: 'Commercial Garage / Parking', vaPerSqFt: 0.3 },
}

/** Residential NEC 220 Standard & Optional Constants */
export const NEC_220_RESIDENTIAL = {
  generalLightingVaPerSqFt: 3, // NEC 220.14(J) / Table 220.12 dwelling unit
  smallApplianceVa: 1500, // NEC 220.52(A) (min 2 circuits)
  laundryVa: 1500, // NEC 220.52(B)
  standardFirstTierVa: 3000, // Table 220.42 first 3000 VA @ 100%
  standardRemainderFactor: 0.35, // Table 220.42 3001-120000 VA @ 35%
  optionalFirstTierVa: 10000, // NEC 220.82(B) first 10 kVA @ 100%
  optionalRemainderFactor: 0.4, // NEC 220.82(B) remainder @ 40%
  dryerMinVa: 5000, // Table 220.54
  rangeColumnCMaxVa: 8000, // Table 220.55 Col C (single range <= 12 kW)
  largestMotorAdderFactor: 0.25, // NEC 220.50 / 430.24 (+25% of largest motor)
  evseContinuousFactor: 1.25, // NEC 625.41 / 220.57
  solarBusbarRuleFactor: 1.2, // NEC 705.12(B)(3)(2) 120% rule
} as const

/** Residential Service Entrance Conductor Sizing (Table 310.12 83% dwelling rating) */
export const RESIDENTIAL_SERVICE_WIRE: Readonly<
  Record<number, { readonly cu: WireGauge; readonly al: WireGauge; readonly conduit: ConduitTradeSize }>
> = {
  100: { cu: '4', al: '2', conduit: '1-1/4"' },
  125: { cu: '2', al: '1/0', conduit: '1-1/2"' },
  150: { cu: '1', al: '2/0', conduit: '1-1/2"' },
  200: { cu: '2/0', al: '4/0', conduit: '2"' },
  225: { cu: '3/0', al: '250kcmil', conduit: '2"' },
  300: { cu: '250kcmil', al: '350kcmil', conduit: '2-1/2"' },
  400: { cu: '400kcmil', al: '600kcmil', conduit: '3"' },
}

/**
 * NEC Table 110.26(A)(1) — Minimum Clear Working Space Depth in front of equipment (meters).
 * Width >= 30" (0.762 m) or equipment width; Height >= 78" (1.981 m) or equipment height.
 */
export function getWorkingClearance110_26(
  voltageSystem: VoltageSystem,
  condition: WorkingSpaceCondition = 2,
): { readonly widthM: number; readonly depthM: number; readonly heightM: number; readonly depthIn: number } {
  const nominalToGround = voltageSystem === '277/480V-3P' ? 277 : 120
  let depthIn: number
  if (nominalToGround <= 150) {
    depthIn = 36 // Condition 1, 2, 3 all 3 ft (36") for 0-150V to ground
  } else {
    // 151-600V to ground (e.g. 277/480V commercial)
    depthIn = condition === 1 ? 36 : condition === 2 ? 42 : 48
  }
  return {
    widthM: 30 * INCHES_TO_METERS,
    depthM: depthIn * INCHES_TO_METERS,
    heightM: 78 * INCHES_TO_METERS,
    depthIn,
  }
}

export function getVoltageLineToLine(system: VoltageSystem): number {
  switch (system) {
    case '120/240V-1P':
      return 240
    case '120/208V-3P':
      return 208
    case '277/480V-3P':
      return 480
  }
}

export function getVoltageLineToNeutral(system: VoltageSystem): number {
  switch (system) {
    case '120/240V-1P':
      return 120
    case '120/208V-3P':
      return 120
    case '277/480V-3P':
      return 277
  }
}

export function isThreePhaseSystem(system: VoltageSystem): boolean {
  return system === '120/208V-3P' || system === '277/480V-3P'
}

export function nextStandardOcpd(amps: number): number {
  for (const rating of STANDARD_OCPD_RATINGS) {
    if (rating >= amps) return rating
  }
  return STANDARD_OCPD_RATINGS[STANDARD_OCPD_RATINGS.length - 1]!
}

export function nextStandardService(amps: number): number {
  for (const rating of STANDARD_SERVICE_SIZES) {
    if (rating >= amps) return rating
  }
  return STANDARD_SERVICE_SIZES[STANDARD_SERVICE_SIZES.length - 1]!
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Equipment & wiring devices that ship with an integral enclosure or floor/weatherproof box
 * rather than mounting inside a separate wall gang rough-in box (NEC 314.16 & BOM takeoff).
 */
const INTEGRAL_ENCLOSURE_KINDS = new Set<string>([
  'evse',
  'motor-load',
  'exit-sign',
  'solar-inverter',
  'battery-ess',
  'transfer-switch',
  'generator-inlet',
  'rapid-shutdown',
  'spd',
  'vfd',
  'weatherproof-gfci',
  'floor-box',
  'under-cabinet-led',
])

export function usesSeparateRoughInBox(deviceKind: string): boolean {
  return !INTEGRAL_ENCLOSURE_KINDS.has(deviceKind)
}

const BOX_FILL_GAUGE_SET = new Set<string>(['18', '16', '14', '12', '10', '8', '6'])
const BRANCH_WIRE_GAUGE_SET = new Set<string>(WIRE_GAUGE_ORDER)

/** Clamp fixture/untyped wire gauges ('18', '16', or unknown) to a valid NEC Table 310.16 branch gauge (>= '#14'). */
export function clampToBranchWireGauge(gauge: string | undefined, fallback: WireGauge = '14'): WireGauge {
  if (gauge && BRANCH_WIRE_GAUGE_SET.has(gauge)) return gauge as WireGauge
  if (gauge === '18' || gauge === '16') return '14'
  return fallback
}

/** Clamp feeder gauges (#4..750kcmil) to a valid NEC Table 314.16(B) box-fill gauge ('6'). */
export function clampToBoxFillGauge(gauge: string | undefined): BoxFillGauge {
  if (gauge && BOX_FILL_GAUGE_SET.has(gauge)) return gauge as BoxFillGauge
  if (gauge && BRANCH_WIRE_GAUGE_SET.has(gauge)) return '6'
  return '12'
}

/**
 * RFC-4180 CSV cell escaping with spreadsheet formula-injection neutralization
 * (prefixes leading =, +, -, @, tab, or CR triggers with a single quote).
 */
export function sanitizeCsvCell(raw: string): string {
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
