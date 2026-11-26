/**
 * Deterministic NEC Article 220 Service & Feeder Load Calculations.
 * Covers BOTH:
 * - Residential Dwelling Units: Standard Method (220.42-220.60) & Optional Method (220.82) + Solar PV 120% Busbar (705.12)
 * - Commercial Occupancies: Table 220.12 lighting (125% continuous), Table 220.44 receptacles (180 VA/yoke, 10kVA@100%/rem@50%),
 *   Article 430.24 motors, 220.60 non-coincident HVAC, 1-phase & 3-phase (120/208V, 277/480V) service sizing.
 */

import {
  COMMERCIAL_LIGHTING_VA_PER_SQFT,
  type CommercialOccupancy,
  type ConductorMaterial,
  NEC_220_RESIDENTIAL,
  RESIDENTIAL_SERVICE_WIRE,
  SQM_TO_SQFT,
  type VoltageSystem,
  type WireGauge,
  getVoltageLineToLine,
  isThreePhaseSystem,
  nextStandardService,
  round2,
} from './tables'
import { recommendWireGauge } from './sizing'

// ─── Residential NEC Article 220 ────────────────────────────────────────────

export type ResidentialApplianceLoad = {
  name: string
  watts: number
  isMotor?: boolean
  category?: 'range' | 'dryer' | 'hvac-heating' | 'hvac-cooling' | 'heat-pump' | 'evse' | 'fixed'
}

export type ResidentialLoadInput = {
  squareFootage: number
  method?: 'standard' | 'optional'
  smallApplianceCircuits?: number // Min 2 per NEC 220.52(A)
  includeLaundryCircuit?: boolean // NEC 220.52(B)
  appliances?: readonly ResidentialApplianceLoad[]
  solarBackfeedAmps?: number
  panelBusRatingAmps?: number
  mainBreakerAmps?: number
  conductorMaterial?: ConductorMaterial
}

export type ResidentialLoadResult = {
  occupancy: 'residential'
  method: 'standard' | 'optional'
  squareFootage: number
  generalLightingVa: number
  smallApplianceVa: number
  laundryVa: number
  generalSubtotalVa: number
  demandedGeneralVa: number
  applianceDetails: Array<{
    name: string
    ratedVa: number
    demandedVa: number
    note?: string
  }>
  applianceTotalVa: number
  motorAdderVa: number
  hvacOmitVa: number
  evseLoadVa: number
  totalDemandVa: number
  totalAmpsAt240V: number
  minimumServiceAmps: number
  recommendedWireGauge: WireGauge
  recommendedConduit: string
  solarBusbarCheck?: {
    busRatingAmps: number
    mainBreakerAmps: number
    maxAllowedSolarBackfeedAmps: number
    proposedSolarBackfeedAmps: number
    compliant: boolean
    codeRef: string
  }
}

function classifyAppliance(app: ResidentialApplianceLoad): NonNullable<ResidentialApplianceLoad['category']> {
  if (app.category) return app.category
  if (/evse|ev.?charger|tesla|chargepoint/i.test(app.name)) return 'evse'
  if (/range|oven|cooktop/i.test(app.name)) return 'range'
  if (/dryer/i.test(app.name)) return 'dryer'
  // Water heaters (including Heat Pump Water Heaters / tankless) are fixed appliances, NOT non-coincident HVAC
  if (/water.?heat|hpwh|tankless/i.test(app.name)) return 'fixed'
  // Check heat pump BEFORE generic /heat/ so "Heat Pump" is never misclassified as 65% strip heat
  if (/heat.?pump/i.test(app.name)) return 'heat-pump'
  if (/heat|furnace|boiler|baseboard/i.test(app.name)) return 'hvac-heating'
  if (/\ba\/?c\b|air.?cond|cooling|condenser|compressor/i.test(app.name)) return 'hvac-cooling'
  return 'fixed'
}

function calculateSingleRangeDemand(watts: number): { demanded: number; note: string } {
  if (watts < 3500) {
    return {
      demanded: Math.round(watts * 0.8),
      note: 'NEC Table 220.55 Col. A (< 3.5 kW @ 80%)',
    }
  }
  if (watts < 8750) {
    return {
      demanded: Math.round(watts * 0.8),
      note: 'NEC Table 220.55 Col. B (3.5-8.75 kW @ 80%)',
    }
  }
  if (watts <= 12000) {
    return {
      demanded: NEC_220_RESIDENTIAL.rangeColumnCMaxVa,
      note: 'NEC Table 220.55 Col. C (8.75-12 kW -> 8,000 VA)',
    }
  }
  const extraKw = Math.ceil((Math.min(watts, 27000) - 12000) / 1000)
  return {
    demanded: Math.round(NEC_220_RESIDENTIAL.rangeColumnCMaxVa * (1 + 0.05 * extraKw)),
    note: `NEC Table 220.55 Note 1 (+5%/kW over 12 kW -> +${extraKw * 5}%)`,
  }
}

export function calculateResidentialLoad(input: ResidentialLoadInput): ResidentialLoadResult {
  if (!Number.isFinite(input.squareFootage) || input.squareFootage <= 0) {
    throw new Error('squareFootage must be a positive finite number')
  }
  const smallApplianceCircuits = input.smallApplianceCircuits ?? 2
  if (smallApplianceCircuits < 2) {
    throw new Error('Minimum 2 small-appliance branch circuits required per NEC 220.52(A)')
  }
  const includeLaundry = input.includeLaundryCircuit ?? true
  const method = input.method ?? 'standard'
  const appliances = input.appliances ?? []

  const generalLightingVa = Math.round(input.squareFootage * NEC_220_RESIDENTIAL.generalLightingVaPerSqFt)
  const smallApplianceVa = smallApplianceCircuits * NEC_220_RESIDENTIAL.smallApplianceVa
  const laundryVa = includeLaundry ? NEC_220_RESIDENTIAL.laundryVa : 0
  const generalSubtotalVa = generalLightingVa + smallApplianceVa + laundryVa

  const applianceDetails: ResidentialLoadResult['applianceDetails'] = []
  let applianceTotalVa = 0
  let largestMotorVa = 0
  let heatingTotalVa = 0
  let coolingTotalVa = 0
  let evseLoadVa = 0
  let demandedGeneralVa = 0
  let motorAdderVa = 0
  let hvacOmitVa = 0
  let totalDemandVa = 0

  if (method === 'standard') {
    // NEC Table 220.42: 100% first 3,000 VA, 35% from 3,001 to 120,000 VA, 25% above 120,000 VA
    const firstTier = Math.min(generalSubtotalVa, NEC_220_RESIDENTIAL.standardFirstTierVa)
    const secondTier = Math.min(
      Math.max(0, generalSubtotalVa - NEC_220_RESIDENTIAL.standardFirstTierVa),
      120000 - NEC_220_RESIDENTIAL.standardFirstTierVa,
    )
    const thirdTier = Math.max(0, generalSubtotalVa - 120000)
    demandedGeneralVa =
      firstTier +
      Math.round(secondTier * NEC_220_RESIDENTIAL.standardRemainderFactor) +
      Math.round(thirdTier * 0.25)

    // NEC 220.53: 75% demand factor when 4 or more fixed-in-place appliances are fastened in place
    const fixedApplianceCount = appliances.filter((a) => classifyAppliance(a) === 'fixed').length
    const applyFixed75Pct = fixedApplianceCount >= 4

    for (const app of appliances) {
      const cat = classifyAppliance(app)
      let demanded = Math.max(0, app.watts)
      let note: string | undefined

      if (cat === 'range') {
        const rangeCalc = calculateSingleRangeDemand(demanded)
        demanded = rangeCalc.demanded
        note = rangeCalc.note
      } else if (cat === 'dryer') {
        if (demanded < NEC_220_RESIDENTIAL.dryerMinVa) {
          demanded = NEC_220_RESIDENTIAL.dryerMinVa
          note = 'Minimum 5,000 VA per NEC Table 220.54'
        }
      } else if (cat === 'evse') {
        const scaled = Math.round(demanded * NEC_220_RESIDENTIAL.evseContinuousFactor)
        evseLoadVa += scaled
        applianceDetails.push({
          name: app.name,
          ratedVa: app.watts,
          demandedVa: scaled,
          note: '125% continuous EVSE load per NEC 625.41 / 220.57',
        })
        continue
      } else if (cat === 'fixed' && applyFixed75Pct) {
        demanded = Math.round(demanded * 0.75)
        note = `NEC 220.53: 75% demand factor (${fixedApplianceCount} fixed-in-place appliances)`
      }

      if (cat === 'hvac-heating') heatingTotalVa += demanded
      if (cat === 'hvac-cooling' || cat === 'heat-pump') coolingTotalVa += demanded
      // NEC 220.50 / 430.24: +25% of largest motor nameplate rating
      const motorNameplate = Math.max(0, app.watts)
      if ((app.isMotor || cat === 'heat-pump') && motorNameplate > largestMotorVa) {
        largestMotorVa = motorNameplate
      }

      applianceTotalVa += demanded
      applianceDetails.push({ name: app.name, ratedVa: app.watts, demandedVa: demanded, note })
    }

    motorAdderVa = Math.round(largestMotorVa * NEC_220_RESIDENTIAL.largestMotorAdderFactor)
    if (heatingTotalVa > 0 && coolingTotalVa > 0) {
      hvacOmitVa = Math.min(heatingTotalVa, coolingTotalVa)
    }
    totalDemandVa = demandedGeneralVa + applianceTotalVa + motorAdderVa + evseLoadVa - hvacOmitVa
  } else {
    // NEC 220.82 Optional Calculation for Dwelling Units
    let generalAndAppliances = generalSubtotalVa
    let heatPumpTotalVa = 0
    const separateSpaceHeaters = appliances.filter(
      (a) => classifyAppliance(a) === 'hvac-heating' && !/furnace|central|boiler/i.test(a.name),
    )
    const separateHeatFactor = separateSpaceHeaters.length >= 4 ? 0.4 : 0.65
    let heatingDemand = 0

    for (const app of appliances) {
      const cat = classifyAppliance(app)
      const watts = Math.max(0, app.watts)
      if (cat === 'hvac-heating') {
        heatingTotalVa += watts
        const isCentral = /furnace|central|boiler/i.test(app.name)
        const factor = isCentral ? 0.65 : separateHeatFactor
        const demanded = Math.round(watts * factor)
        heatingDemand += demanded
        applianceDetails.push({
          name: app.name,
          ratedVa: watts,
          demandedVa: demanded,
          note: isCentral
            ? 'NEC 220.82(C)(6) central electric space heating (65%)'
            : separateSpaceHeaters.length >= 4
              ? `NEC 220.82(C)(5) ${separateSpaceHeaters.length} separately controlled electric space heaters (40%)`
              : 'NEC 220.82(C)(4) < 4 separately controlled electric space heaters (65%)',
        })
      } else if (cat === 'heat-pump') {
        heatPumpTotalVa += watts
        applianceDetails.push({
          name: app.name,
          ratedVa: watts,
          demandedVa: watts,
          note: 'NEC 220.82(C)(2) 100% heat-pump compressor rating',
        })
      } else if (cat === 'hvac-cooling') {
        coolingTotalVa += watts
        applianceDetails.push({
          name: app.name,
          ratedVa: watts,
          demandedVa: watts,
          note: 'NEC 220.82(C)(1) 100% A/C load',
        })
      } else if (cat === 'evse') {
        const scaled = Math.round(watts * NEC_220_RESIDENTIAL.evseContinuousFactor)
        evseLoadVa += scaled
        applianceDetails.push({
          name: app.name,
          ratedVa: watts,
          demandedVa: scaled,
          note: '125% continuous EVSE load per NEC 625.41',
        })
      } else {
        generalAndAppliances += watts
        applianceTotalVa += watts
        applianceDetails.push({ name: app.name, ratedVa: watts, demandedVa: watts })
      }
    }

    const first10k = Math.min(generalAndAppliances, NEC_220_RESIDENTIAL.optionalFirstTierVa)
    const over10k = Math.max(0, generalAndAppliances - NEC_220_RESIDENTIAL.optionalFirstTierVa)
    demandedGeneralVa = first10k + Math.round(over10k * NEC_220_RESIDENTIAL.optionalRemainderFactor)

    const coolingOrHpDemand = Math.max(coolingTotalVa, heatPumpTotalVa)
    const hvacDemand = Math.max(coolingOrHpDemand, heatingDemand)
    hvacOmitVa =
      coolingOrHpDemand > 0 && heatingDemand > 0
        ? Math.min(coolingOrHpDemand, heatingDemand)
        : 0
    totalDemandVa = demandedGeneralVa + hvacDemand + evseLoadVa
  }

  const totalAmpsAt240V = round2(totalDemandVa / 240)
  const minimumServiceAmps = nextStandardService(totalAmpsAt240V)
  const material = input.conductorMaterial ?? 'cu'
  const resSpec = RESIDENTIAL_SERVICE_WIRE[minimumServiceAmps]
  const recommendedWireGauge =
    resSpec !== undefined
      ? resSpec[material]
      : recommendWireGauge({ material, loadAmps: totalAmpsAt240V, terminalRating: '75C' })
  const recommendedConduit = resSpec?.conduit ?? '3"'

  let solarBusbarCheck: ResidentialLoadResult['solarBusbarCheck']
  if (input.solarBackfeedAmps !== undefined && input.solarBackfeedAmps > 0) {
    const bus = input.panelBusRatingAmps ?? minimumServiceAmps
    const main = input.mainBreakerAmps ?? minimumServiceAmps
    const maxAllowed = round2(bus * NEC_220_RESIDENTIAL.solarBusbarRuleFactor - main)
    solarBusbarCheck = {
      busRatingAmps: bus,
      mainBreakerAmps: main,
      maxAllowedSolarBackfeedAmps: Math.max(0, maxAllowed),
      proposedSolarBackfeedAmps: input.solarBackfeedAmps,
      compliant: input.solarBackfeedAmps <= maxAllowed,
      codeRef: 'NEC 705.12(B)(3)(2)',
    }
  }

  return {
    occupancy: 'residential',
    method,
    squareFootage: round2(input.squareFootage),
    generalLightingVa,
    smallApplianceVa,
    laundryVa,
    generalSubtotalVa,
    demandedGeneralVa,
    applianceDetails,
    applianceTotalVa,
    motorAdderVa,
    hvacOmitVa,
    evseLoadVa,
    totalDemandVa,
    totalAmpsAt240V,
    minimumServiceAmps,
    recommendedWireGauge,
    recommendedConduit,
    solarBusbarCheck,
  }
}

// ─── Commercial NEC Article 220 ─────────────────────────────────────────────

export type CommercialLoadInput = {
  squareFootage: number
  buildingType: CommercialOccupancy
  voltageSystem?: VoltageSystem // default '120/208V-3P'
  receptacleCount?: number // 180 VA per yoke per NEC 220.14(I)
  continuousLighting?: boolean // default true -> 125% per NEC 210.19 / 215.2
  signCircuits?: number // 1200 VA min per commercial occupancy per NEC 220.14(F)
  showWindowFeet?: number // 200 VA per linear foot per NEC 220.14(G)
  hvacHeatingVa?: number
  hvacCoolingVa?: number
  motors?: ReadonlyArray<{ name: string; va: number }>
  dedicatedLoads?: ReadonlyArray<{ name: string; va: number; continuous?: boolean }>
  conductorMaterial?: ConductorMaterial
}

export type CommercialLoadResult = {
  occupancy: 'commercial'
  buildingType: CommercialOccupancy
  buildingLabel: string
  voltageSystem: VoltageSystem
  squareFootage: number
  lightingBaseVa: number
  lightingDemandVa: number
  receptacleRawVa: number
  receptacleDemandVa: number
  signVa: number
  showWindowVa: number
  hvacDemandVa: number
  hvacOmitVa: number
  motorTotalVa: number
  largestMotorAdderVa: number
  dedicatedTotalVa: number
  totalDemandVa: number
  lineCurrentAmps: number
  minimumServiceAmps: number
  recommendedFeederGauge: WireGauge
}

export function calculateCommercialLoad(input: CommercialLoadInput): CommercialLoadResult {
  if (!Number.isFinite(input.squareFootage) || input.squareFootage <= 0) {
    throw new Error('squareFootage must be a positive finite number')
  }
  const occSpec = COMMERCIAL_LIGHTING_VA_PER_SQFT[input.buildingType]
  const voltageSystem: VoltageSystem = input.voltageSystem ?? '120/208V-3P'
  const continuousLighting = input.continuousLighting ?? true

  // NEC Table 220.12 + 125% continuous feeder factor (NEC 215.2(A)(1))
  const lightingBaseVa = Math.round(input.squareFootage * occSpec.vaPerSqFt)
  const lightingDemandVa = continuousLighting ? Math.round(lightingBaseVa * 1.25) : lightingBaseVa

  // NEC 220.14(I) (180 VA per receptacle yoke) + Table 220.44 (first 10 kVA @ 100%, remainder @ 50%)
  const receptacleRawVa = Math.max(0, input.receptacleCount ?? 0) * 180
  const receptacleDemandVa =
    receptacleRawVa <= 10000
      ? receptacleRawVa
      : 10000 + Math.round((receptacleRawVa - 10000) * 0.5)

  // NEC 220.14(F) signs (min 1200 VA continuous) & 220.14(G) show windows (200 VA/ft)
  const signVa = Math.round(Math.max(0, input.signCircuits ?? 0) * 1200 * 1.25)
  const showWindowVa = Math.round(Math.max(0, input.showWindowFeet ?? 0) * 200 * 1.25)

  // NEC 220.60 non-coincident HVAC
  const heat = Math.max(0, input.hvacHeatingVa ?? 0)
  const cool = Math.max(0, input.hvacCoolingVa ?? 0)
  const hvacDemandVa = Math.max(heat, cool)
  const hvacOmitVa = Math.min(heat, cool)

  // NEC 430.24 motors: 125% largest + 100% remaining
  const motors = input.motors ?? []
  let motorTotalVa = 0
  let largestMotorVa = 0
  for (const m of motors) {
    const va = Math.max(0, m.va)
    motorTotalVa += va
    if (va > largestMotorVa) largestMotorVa = va
  }
  const largestMotorAdderVa = Math.round(largestMotorVa * 0.25)

  // Dedicated / special loads (kitchen equipment, EVSE, server racks, etc.)
  const dedicatedTotalVa = (input.dedicatedLoads ?? []).reduce((sum, item) => {
    const va = Math.max(0, item.va)
    return sum + Math.round(item.continuous ? va * 1.25 : va)
  }, 0)

  const totalDemandVa =
    lightingDemandVa +
    receptacleDemandVa +
    signVa +
    showWindowVa +
    hvacDemandVa +
    motorTotalVa +
    largestMotorAdderVa +
    dedicatedTotalVa

  const vLL = getVoltageLineToLine(voltageSystem)
  const divisor = isThreePhaseSystem(voltageSystem) ? vLL * Math.sqrt(3) : vLL
  const lineCurrentAmps = round2(totalDemandVa / divisor)
  const minimumServiceAmps = nextStandardService(lineCurrentAmps)
  const recommendedFeederGauge = recommendWireGauge({
    material: input.conductorMaterial ?? 'cu',
    loadAmps: lineCurrentAmps,
    terminalRating: '75C',
  })

  return {
    occupancy: 'commercial',
    buildingType: input.buildingType,
    buildingLabel: occSpec.label,
    voltageSystem,
    squareFootage: round2(input.squareFootage),
    lightingBaseVa,
    lightingDemandVa,
    receptacleRawVa,
    receptacleDemandVa,
    signVa,
    showWindowVa,
    hvacDemandVa,
    hvacOmitVa,
    motorTotalVa,
    largestMotorAdderVa,
    dedicatedTotalVa,
    totalDemandVa,
    lineCurrentAmps,
    minimumServiceAmps,
    recommendedFeederGauge,
  }
}

// ─── Scene Graph Area & Load Extraction ─────────────────────────────────────

export type SceneNodeLike = Record<string, unknown> & {
  id: string
  type: string
  parentId?: string | null
  name?: string
}

/** Shoelace polygon area for Pascal ZoneNode (`polygon: [x, z][]` in meters). */
export function polygonAreaSqM(polygon: ReadonlyArray<readonly [number, number]>): number {
  if (polygon.length < 3) return 0
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i]!
    const [x2, z2] = polygon[(i + 1) % polygon.length]!
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

const OUTDOOR_ZONE_PATTERN = /outdoor|patio|deck|porch|balcony|rooftop|exterior|yard|terrace/i

/** Derive conditioned floor area (sq ft) from Pascal `zone` nodes (excluding outdoor/porch/balcony zones per NEC 220.14(J)). */
export function estimateSceneFloorAreaSqFt(nodes: Readonly<Record<string, SceneNodeLike>>): number {
  let totalSqM = 0
  for (const node of Object.values(nodes)) {
    if (node.type !== 'zone') continue
    const category = typeof node.category === 'string' ? node.category : ''
    const name = typeof node.name === 'string' ? node.name : ''
    if (OUTDOOR_ZONE_PATTERN.test(`${category} ${name}`)) {
      continue
    }
    const poly = node.polygon
    if (Array.isArray(poly) && poly.length >= 3) {
      totalSqM += polygonAreaSqM(poly as [number, number][])
    }
  }
  return round2(totalSqM * SQM_TO_SQFT)
}

export type SceneLoadOptions = {
  occupancy?: 'residential' | 'commercial'
  residentialMethod?: 'standard' | 'optional'
  commercialBuildingType?: CommercialOccupancy
  voltageSystem?: VoltageSystem
  fallbackSquareFootage?: number
  conductorMaterial?: ConductorMaterial
}

/**
 * Automatically compute a Residential or Commercial NEC 220 service load
 * directly from a Pascal scene graph (`zone`, `electrical:panel`, `electrical:device`).
 */
export function calculateSceneLoad(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: SceneLoadOptions = {},
): ResidentialLoadResult | CommercialLoadResult {
  const allNodes = Object.values(nodes)
  const panels = allNodes.filter((n) => n.type === 'electrical:panel')
  const devices = allNodes.filter((n) => n.type === 'electrical:device')

  const inferredOccupancy: 'residential' | 'commercial' =
    options.occupancy ??
    (panels.some((p) => p.occupancy === 'commercial') ? 'commercial' : 'residential')

  const detectedSqFt = estimateSceneFloorAreaSqFt(nodes)
  const squareFootage =
    detectedSqFt > 0 ? detectedSqFt : (options.fallbackSquareFootage ?? 2000)

  if (inferredOccupancy === 'commercial') {
    const primaryPanel = panels[0]
    const voltageSystem: VoltageSystem =
      options.voltageSystem ??
      (typeof primaryPanel?.voltageSystem === 'string'
        ? (primaryPanel.voltageSystem as VoltageSystem)
        : '120/208V-3P')

    const receptacles = devices.filter(
      (d) =>
        d.deviceKind === 'duplex' ||
        d.deviceKind === 'gfci' ||
        d.deviceKind === 'afci' ||
        d.deviceKind === 'usb-duplex' ||
        d.deviceKind === 'weatherproof-gfci' ||
        d.deviceKind === 'floor-box',
    )
    const motors = devices
      .filter((d) => d.deviceKind === 'motor-load' || d.deviceKind === 'vfd' || d.isMotor === true)
      .map((d) => ({
        name: (typeof d.name === 'string' && d.name) || d.id,
        va: typeof d.loadVa === 'number' ? d.loadVa : d.deviceKind === 'vfd' ? 12000 : 1500,
      }))
    const dedicatedLoads = devices
      .filter(
        (d) =>
          d.deviceKind === 'dedicated-240v' ||
          d.deviceKind === 'evse' ||
          d.deviceKind === 'exit-sign' ||
          d.deviceKind === 'battery-ess',
      )
      .map((d) => ({
        name: (typeof d.name === 'string' && d.name) || d.id,
        va: typeof d.loadVa === 'number' ? d.loadVa : d.deviceKind === 'battery-ess' ? 11500 : 0,
        continuous:
          d.continuous === true ||
          d.deviceKind === 'evse' ||
          d.deviceKind === 'exit-sign' ||
          d.deviceKind === 'battery-ess',
      }))

    return calculateCommercialLoad({
      squareFootage,
      buildingType: options.commercialBuildingType ?? 'office',
      voltageSystem,
      receptacleCount: receptacles.length,
      motors,
      dedicatedLoads,
      conductorMaterial: options.conductorMaterial,
    })
  }

  // Residential scene extraction
  const appliances: ResidentialApplianceLoad[] = []
  let inferredSolarBackfeedAmps = 0
  for (const d of devices) {
    const kind = typeof d.deviceKind === 'string' ? d.deviceKind : ''
    const loadVa = typeof d.loadVa === 'number' ? d.loadVa : 0
    const meta = d.metadata as { loadCategory?: string; mepSourceNodeId?: string } | undefined
    if (kind === 'solar-inverter') {
      const bAmps = typeof d.breakerAmps === 'number' && d.breakerAmps > 0 ? d.breakerAmps : 40
      inferredSolarBackfeedAmps += bAmps
      continue
    }
    const hasMepLoad = typeof meta?.mepSourceNodeId === 'string' && loadVa > 0
    if (
      kind === 'dedicated-240v' ||
      kind === 'evse' ||
      kind === 'motor-load' ||
      kind === 'vfd' ||
      kind === 'battery-ess' ||
      d.isMotor === true ||
      hasMepLoad
    ) {
      const metaCat = meta?.loadCategory
      const explicitCategory: ResidentialApplianceLoad['category'] | undefined =
        kind === 'evse'
          ? 'evse'
          : metaCat === 'hvac-heating' || metaCat === 'hvac-cooling' || metaCat === 'heat-pump'
            ? metaCat
            : metaCat === 'fixed' || metaCat === 'appliance' || metaCat === 'motor'
              ? 'fixed'
              : undefined
      appliances.push({
        name: (typeof d.name === 'string' && d.name) || kind,
        watts:
          loadVa > 0
            ? loadVa
            : kind === 'evse'
              ? 9600
              : kind === 'battery-ess'
                ? 11500
                : kind === 'vfd'
                  ? 12000
                  : 5000,
        isMotor:
          d.isMotor === true ||
          kind === 'motor-load' ||
          kind === 'vfd' ||
          metaCat === 'motor' ||
          metaCat === 'heat-pump' ||
          metaCat === 'hvac-cooling',
        category: explicitCategory,
      })
    }
  }

  const primaryPanel = panels[0]
  const panelSolarBackfeed =
    typeof primaryPanel?.solarBackfeedAmps === 'number' ? primaryPanel.solarBackfeedAmps : 0
  const solarBackfeedAmps = panelSolarBackfeed > 0 ? panelSolarBackfeed : inferredSolarBackfeedAmps
  const busRatingAmps =
    typeof primaryPanel?.busRatingAmps === 'number' ? primaryPanel.busRatingAmps : undefined
  const mainBreakerAmps =
    typeof primaryPanel?.mainBreakerAmps === 'number' ? primaryPanel.mainBreakerAmps : undefined

  return calculateResidentialLoad({
    squareFootage,
    method: options.residentialMethod ?? 'standard',
    appliances,
    solarBackfeedAmps: solarBackfeedAmps > 0 ? solarBackfeedAmps : undefined,
    panelBusRatingAmps: busRatingAmps,
    mainBreakerAmps,
    conductorMaterial: options.conductorMaterial,
  })
}
