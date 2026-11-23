import { describe, expect, test } from 'bun:test'
import {
  calculateBoxFill,
  calculateConduitFill,
  calculateDeratedAmpacity,
  calculateVoltageDrop,
} from '../nec/sizing'

describe('NEC Sizing Calculators (310.16/310.15, Ch. 9, 314.16, Voltage Drop)', () => {
  test('Table 310.16 + 310.15 derating matches Spark reference example (6x #12 THHN Cu @ 40°C)', () => {
    const res = calculateDeratedAmpacity({
      wireGauge: '12',
      material: 'cu',
      insulationRating: '90C',
      terminalRating: '75C',
      racewayType: 'emt',
      ambientTempC: 40,
      currentCarryingCount: 6,
      loadAmps: 20,
    })
    // 30A * 0.91 * 0.80 = 21.84A <= 25A terminal cap; NEC 240.4(D) caps breaker at 20A
    expect(res.baseAmpacity90OrRated).toBe(30)
    expect(res.tempCorrectionFactor).toBe(0.91)
    expect(res.bundlingFactor).toBe(0.8)
    expect(res.deratedAmpacity).toBeCloseTo(21.84, 2)
    expect(res.finalAllowableAmpacity).toBeCloseTo(21.84, 2)
    expect(res.maxBreakerAmps).toBe(20)
    expect(res.compliant).toBe(true)
  })

  test('NM-B applies NEC 334.80 60°C terminal cap even though derating starts at 90°C', () => {
    const res = calculateDeratedAmpacity({
      wireGauge: '12',
      racewayType: 'nm-b',
      loadAmps: 22,
    })
    expect(res.terminalCapAmpacity).toBe(20)
    expect(res.finalAllowableAmpacity).toBe(20)
    expect(res.compliant).toBe(false)
    expect(res.recommendedGauge).toBe('10')
  })

  test('Rooftop exposed conduit applies +33°C ambient adder', () => {
    const res = calculateDeratedAmpacity({
      wireGauge: '10',
      racewayType: 'emt',
      ambientTempC: 35,
      rooftopExposed: true, // effective 68°C -> 70°C band = 0.58
      loadAmps: 25,
    })
    expect(res.effectiveAmbientTempC).toBe(68)
    expect(res.tempCorrectionFactor).toBe(0.58)
    expect(res.finalAllowableAmpacity).toBeCloseTo(23.2, 1)
    expect(res.compliant).toBe(false)
  })

  test('Chapter 9 Conduit Fill enforces 40% for 3+ wires and 60% nipple exception <= 24"', () => {
    const overfilled = calculateConduitFill({
      conduitType: 'emt',
      tradeSize: '1/2"',
      conductors: [{ gauge: '12', count: 12 }], // 12 * 0.0133 = 0.1596 / 0.304 = 52.5% > 40%
    })
    expect(overfilled.maxAllowedFillPct).toBe(40)
    expect(overfilled.compliant).toBe(false)
    expect(overfilled.recommendedTradeSize).toBe('3/4"')

    const nipple = calculateConduitFill({
      conduitType: 'emt',
      tradeSize: '1/2"',
      conductors: [{ gauge: '12', count: 12 }],
      lengthInches: 18, // <= 24" nipple -> 60% allowed!
    })
    expect(nipple.nippleExceptionApplied).toBe(true)
    expect(nipple.maxAllowedFillPct).toBe(60)
    expect(nipple.compliant).toBe(true)
  })

  test('NEC 314.16 Box Fill counts conductors, 2x device yokes, clamps, and grounds accurately', () => {
    // 4x #12 (9.0) + 1 yoke (2*2.25=4.5) + 1 clamp (2.25) + 1 ground (2.25) = 18.0 cu in
    const exact = calculateBoxFill({
      boxType: 'single-gang-standard', // 18.0 cu in
      conductors: [{ gauge: '12', count: 4 }],
      deviceYokeCount: 1,
      internalClampCount: 1,
      equipmentGroundCount: 2, // <= 4 EGCs -> 1 volume allowance
    })
    expect(exact.totalRequiredCuIn).toBe(18)
    expect(exact.compliant).toBe(true)

    const crowded = calculateBoxFill({
      boxType: 'single-gang-standard',
      conductors: [{ gauge: '12', count: 6 }], // 13.5 + 4.5 + 2.25 + 2.25 = 22.5 cu in > 18
      deviceYokeCount: 1,
      internalClampCount: 1,
      equipmentGroundCount: 2,
    })
    expect(crowded.totalRequiredCuIn).toBe(22.5)
    expect(crowded.compliant).toBe(false)
    expect(crowded.recommendedBoxType).toBe('single-gang-deep')
  })

  test('Voltage Drop calculates 1-phase and 3-phase drop and recommends upsizing when > 3%', () => {
    const longBranch = calculateVoltageDrop({
      wireGauge: '14',
      material: 'cu',
      loadAmps: 12,
      oneWayLengthFt: 100,
      voltage: 120,
      phases: 1,
    })
    // 2 * 3.07 * 12 * 100 / 1000 = 7.37V -> 6.14% > 3%
    expect(longBranch.voltageDropPct).toBeGreaterThan(6)
    expect(longBranch.compliant).toBe(false)
    expect(longBranch.recommendedGauge).toBe('10')

    const commercial3P = calculateVoltageDrop({
      wireGauge: '6',
      material: 'cu',
      loadAmps: 50,
      oneWayLengthFt: 120,
      voltage: 480,
      phases: 3,
    })
    // sqrt(3) * 0.491 * 50 * 120 / 1000 = 5.10V -> 1.06% <= 3%
    expect(commercial3P.voltageDropPct).toBeLessThan(1.5)
    expect(commercial3P.compliant).toBe(true)
  })
})
