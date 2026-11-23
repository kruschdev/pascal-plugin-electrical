import { describe, expect, test } from 'bun:test'
import {
  calculateCommercialLoad,
  calculateResidentialLoad,
  calculateSceneLoad,
  estimateSceneFloorAreaSqFt,
} from '../nec/load-calc'
import { calculateTransformerSizing } from '../nec/sizing'

describe('NEC Article 220 Residential & Commercial Load Calculations', () => {
  test('Residential Standard Method applies Table 220.42, 220.54, 220.55 Col C, 220.50, 220.60, EVSE 125%', () => {
    const res = calculateResidentialLoad({
      squareFootage: 2400,
      method: 'standard',
      smallApplianceCircuits: 2,
      includeLaundryCircuit: true,
      appliances: [
        { name: 'Electric Range', watts: 12000 }, // Col C -> 8000 VA
        { name: 'Electric Dryer', watts: 4500 }, // Min 5000 VA per Table 220.54
        { name: 'Disposal', watts: 1200, isMotor: true },
        { name: 'Central A/C', watts: 5000, isMotor: true },
        { name: 'Electric Furnace', watts: 10000 }, // Heating > Cooling -> omit 5000 VA cooling
        { name: 'Level 2 EVSE Charger', watts: 9600 }, // 125% continuous -> 12000 VA
      ],
      solarBackfeedAmps: 40,
      panelBusRatingAmps: 200,
      mainBreakerAmps: 200,
    })

    // General: 2400*3 (7200) + 2*1500 (3000) + 1500 = 11700 -> 3000 + 0.35*8700 = 6045 VA
    expect(res.generalSubtotalVa).toBe(11700)
    expect(res.demandedGeneralVa).toBe(6045)
    expect(res.hvacOmitVa).toBe(5000)
    expect(res.evseLoadVa).toBe(12000)
    // Largest motor = 5000 VA A/C -> 25% = 1250 VA
    expect(res.motorAdderVa).toBe(1250)
    // Appliances = 8000 + 5000 + 1200 + 5000 + 10000 = 29200
    expect(res.totalDemandVa).toBe(6045 + 29200 + 1250 + 12000 - 5000)
    expect(res.minimumServiceAmps).toBe(200)
    expect(res.recommendedWireGauge).toBe('2/0')
    // 200A * 1.2 - 200A = 40A max solar backfeed -> 40A passes
    expect(res.solarBusbarCheck?.compliant).toBe(true)
    expect(res.solarBusbarCheck?.maxAllowedSolarBackfeedAmps).toBe(40)
  })

  test('Residential Solar 120% busbar rule flags over-limit PV backfeed', () => {
    const res = calculateResidentialLoad({
      squareFootage: 1800,
      solarBackfeedAmps: 60,
      panelBusRatingAmps: 200,
      mainBreakerAmps: 200,
    })
    expect(res.solarBusbarCheck?.compliant).toBe(false)
    expect(res.solarBusbarCheck?.maxAllowedSolarBackfeedAmps).toBe(40)
  })

  test('Residential Optional Method (NEC 220.82) applies 10kVA @ 100% + remainder @ 40%', () => {
    const res = calculateResidentialLoad({
      squareFootage: 2000,
      method: 'optional',
      appliances: [
        { name: 'Range', watts: 12000 },
        { name: 'Dryer', watts: 5000 },
        { name: 'Central A/C', watts: 4800 },
      ],
    })
    // General + appliances = (6000 + 3000 + 1500) + 12000 + 5000 = 27500 -> 10000 + 0.4*17500 = 17000
    expect(res.demandedGeneralVa).toBe(17000)
    expect(res.totalDemandVa).toBe(17000 + 4800)
    expect(res.minimumServiceAmps).toBe(100)
  })

  test('Commercial 3-phase 120/208V Office applies Table 220.12 (125% cont), Table 220.44 receptacles, 430.24 motors', () => {
    const res = calculateCommercialLoad({
      squareFootage: 10000,
      buildingType: 'office', // 1.3 VA/sq ft -> 13000 VA * 1.25 = 16250 VA
      voltageSystem: '120/208V-3P',
      receptacleCount: 100, // 18000 VA -> 10000 + 0.5*8000 = 14000 VA
      signCircuits: 1, // 1200 * 1.25 = 1500 VA
      hvacCoolingVa: 24000,
      hvacHeatingVa: 18000, // non-coincident -> omit 18000
      motors: [
        { name: 'Elevator Motor', va: 12000 },
        { name: 'Booster Pump', va: 4000 },
      ],
    })

    expect(res.lightingBaseVa).toBe(13000)
    expect(res.lightingDemandVa).toBe(16250)
    expect(res.receptacleRawVa).toBe(18000)
    expect(res.receptacleDemandVa).toBe(14000)
    expect(res.hvacDemandVa).toBe(24000)
    expect(res.hvacOmitVa).toBe(18000)
    expect(res.largestMotorAdderVa).toBe(3000) // 25% of 12000
    expect(res.totalDemandVa).toBe(16250 + 14000 + 1500 + 24000 + 16000 + 3000)
    // 74,750 VA / (208 * sqrt(3)) = 207.48 A -> 225A service
    expect(res.lineCurrentAmps).toBeCloseTo(207.48, 1)
    expect(res.minimumServiceAmps).toBe(225)
  })

  test('Commercial 480V -> 208V 75 kVA dry-type transformer sizing per NEC 450.3(B)', () => {
    const tx = calculateTransformerSizing(75, 480, 208)
    expect(tx.primaryFla).toBeCloseTo(90.21, 1)
    expect(tx.secondaryFla).toBeCloseTo(208.18, 1)
    expect(tx.maxPrimaryOcpdAmps).toBe(125) // 90.21 * 1.25 = 112.76 -> next standard 125A
    expect(tx.maxSecondaryOcpdAmps).toBe(300) // 208.18 * 1.25 = 260.2 -> next standard 300A
  })

  test('Scene floor area extraction converts interior Pascal zones (m² -> sq ft) and ignores outdoor zones', () => {
    const nodes = {
      zone_1: {
        id: 'zone_1',
        type: 'zone',
        name: 'Office Suite',
        category: 'office',
        polygon: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ], // 100 m² = 1076.39 sq ft
      },
      zone_2: {
        id: 'zone_2',
        type: 'zone',
        name: 'Patio',
        category: 'outdoor',
        polygon: [
          [0, 10],
          [10, 10],
          [10, 20],
          [0, 20],
        ],
      },
      elecpanel_1: {
        id: 'elecpanel_1',
        type: 'electrical:panel',
        occupancy: 'commercial',
        voltageSystem: '120/208V-3P',
      },
    }

    expect(estimateSceneFloorAreaSqFt(nodes)).toBeCloseTo(1076.39, 1)
    const sceneLoad = calculateSceneLoad(nodes, { commercialBuildingType: 'office' })
    expect(sceneLoad.occupancy).toBe('commercial')
    expect(sceneLoad.squareFootage).toBeCloseTo(1076.39, 1)
  })
})
