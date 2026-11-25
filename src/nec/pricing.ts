/**
 * Deterministic Electrical Material Takeoff & Reference Cost Estimator (US 2026 Supply-House Baseline).
 * Pure TypeScript (zero React/Three.js). Supports contractor price-book overrides and labor rate tuning.
 */

import { type ConduitTradeSize, type WireGauge, round2, sanitizeCsvCell } from './tables'

export type ElectricalBomCategory =
  | 'panels-gear'
  | 'solar-backup'
  | 'breakers'
  | 'outlet-boxes'
  | 'wiring-devices'
  | 'light-fixtures'
  | 'conduit-fittings'
  | 'wire-cable'
  | 'consumables'

export type ElectricalBomLineItem = {
  category: ElectricalBomCategory
  sku: string
  description: string
  cadSlug?: string
  quantity: number
  unit: 'ea' | 'stick (10ft)' | 'ft' | 'box' | 'bag'
  unitPriceUsd: number
  extendedMaterialUsd: number
  laborHoursPerUnit: number
  extendedLaborHours: number
  extendedLaborUsd: number
}

export type ElectricalPricingOptions = {
  laborRatePerHourUsd?: number
  materialMarkupPct?: number
  priceOverrides?: Readonly<Record<string, number>>
}

export type ElectricalPricingSummary = {
  currency: 'USD'
  laborRatePerHourUsd: number
  materialMarkupPct: number
  materialSubtotalUsd: number
  laborHoursTotal: number
  laborSubtotalUsd: number
  estimatedTotalUsd: number
  lineItems: ElectricalBomLineItem[]
  disclaimer: string
}

export const DEFAULT_LABOR_RATE_USD = 115

export const BOX_UNIT_PRICES_USD: Record<string, { label: string; usd: number; hrs: number; cadSlug: string }> = {
  'single-gang-shallow': { label: '1-Gang Shallow PVC Box (14 cu in)', usd: 1.15, hrs: 0.15, cadSlug: 'box-1gang-pvc' },
  'single-gang-standard': { label: '1-Gang Standard PVC Box (18 cu in)', usd: 1.35, hrs: 0.16, cadSlug: 'box-1gang-pvc' },
  'single-gang-deep': { label: '1-Gang Deep PVC Box (22.5 cu in)', usd: 1.85, hrs: 0.18, cadSlug: 'box-1gang-pvc' },
  'two-gang-standard': { label: '2-Gang PVC Box (32 cu in)', usd: 2.65, hrs: 0.22, cadSlug: 'box-2gang-pvc' },
  'two-gang-deep': { label: '2-Gang Deep PVC Box (42 cu in)', usd: 3.15, hrs: 0.24, cadSlug: 'box-2gang-pvc' },
  'three-gang-standard': { label: '3-Gang PVC Box (48 cu in)', usd: 3.95, hrs: 0.28, cadSlug: 'box-3gang-pvc' },
  '4-sq-1.25': { label: '4" Square x 1-1/4" Steel Box (18 cu in)', usd: 2.35, hrs: 0.25, cadSlug: 'box-4sq-steel-deep' },
  '4-sq-1.5': { label: '4" Square x 1-1/2" Steel Box (21 cu in)', usd: 2.55, hrs: 0.26, cadSlug: 'box-4sq-steel-deep' },
  '4-sq-2.125': { label: '4" Square x 2-1/8" Deep Steel Box (30.3 cu in)', usd: 3.4, hrs: 0.28, cadSlug: 'box-4sq-steel-deep' },
  '4-11-16-1.5': { label: '4-11/16" x 1-1/2" Steel Box (29.5 cu in)', usd: 4.85, hrs: 0.3, cadSlug: 'box-4-11-16-steel' },
  '4-11-16-2.125': { label: '4-11/16" x 2-1/8" Deep Steel Box (42 cu in)', usd: 5.8, hrs: 0.32, cadSlug: 'box-4-11-16-steel' },
  '4-oct-1.5': { label: '4" Octagon x 1-1/2" Ceiling Box (15.5 cu in)', usd: 2.6, hrs: 0.25, cadSlug: 'box-4oct-ceiling' },
  '4-oct-2.125': { label: '4" Octagon x 2-1/8" Ceiling Box (21.5 cu in)', usd: 3.1, hrs: 0.28, cadSlug: 'box-4oct-ceiling' },
}

export const DEVICE_UNIT_PRICES_USD: Record<
  string,
  { label: string; category: ElectricalBomCategory; usd: number; hrs: number; cadSlug: string }
> = {
  duplex: { label: '20A Commercial/Spec Duplex Receptacle + Plate', category: 'wiring-devices', usd: 4.25, hrs: 0.2, cadSlug: 'device-duplex-20a' },
  gfci: { label: '20A GFCI Receptacle + Decora Plate', category: 'wiring-devices', usd: 21.5, hrs: 0.28, cadSlug: 'device-gfci-20a' },
  afci: { label: '20A AFCI Receptacle + Decora Plate', category: 'wiring-devices', usd: 28.0, hrs: 0.28, cadSlug: 'device-gfci-20a' },
  'dedicated-240v': { label: '50A NEMA 14-50R Receptacle + Stainless Plate', category: 'wiring-devices', usd: 24.5, hrs: 0.45, cadSlug: 'device-nema-14-50r' },
  evse: { label: 'Level 2 48A Wall-Mount EVSE Charger', category: 'wiring-devices', usd: 495.0, hrs: 1.75, cadSlug: 'device-evse-level2' },
  'switch-1p': { label: 'Single-Pole Decora Rocker Switch + Plate', category: 'wiring-devices', usd: 3.45, hrs: 0.2, cadSlug: 'device-switch-decora' },
  'switch-3way': { label: '3-Way Decora Rocker Switch + Plate', category: 'wiring-devices', usd: 5.15, hrs: 0.25, cadSlug: 'device-switch-decora' },
  luminaire: { label: 'LED Luminaire Fixture (Flush / 2x4 Troffer)', category: 'light-fixtures', usd: 68.0, hrs: 0.65, cadSlug: 'fixture-troffer-2x4' },
  'exit-sign': { label: 'Commercial LED EXIT Sign w/ Battery & Floods', category: 'light-fixtures', usd: 54.0, hrs: 0.6, cadSlug: 'fixture-exit-sign' },
  'motor-load': { label: '3-Phase Motor Disconnect & Liquidtight Whip', category: 'wiring-devices', usd: 185.0, hrs: 1.5, cadSlug: 'device-motor-3p-tefc' },
  'junction-box': { label: 'Steel Junction Box Cover + Clamps/Connectors', category: 'outlet-boxes', usd: 4.5, hrs: 0.2, cadSlug: 'box-4-11-16-steel' },
  'solar-inverter': { label: 'String Solar PV Inverter (7.6 kW, NEC 690)', category: 'solar-backup', usd: 1850.0, hrs: 3.5, cadSlug: 'solar-inverter-string' },
  'battery-ess': { label: 'Wall-Mounted Home Battery ESS (13.5 kWh, NEC 706)', category: 'solar-backup', usd: 7800.0, hrs: 5.0, cadSlug: 'battery-wall-ess' },
  'transfer-switch': { label: '200A NEMA-3R Automatic Transfer Switch (ATS)', category: 'solar-backup', usd: 1150.0, hrs: 4.5, cadSlug: 'transfer-switch-200a' },
  'generator-inlet': { label: '50A NEMA SS2-50P Weatherproof Generator Inlet Box', category: 'solar-backup', usd: 92.0, hrs: 1.1, cadSlug: 'generator-inlet-50a' },
  'rapid-shutdown': { label: 'NEC 690.12 PV Rapid Shutdown / AC Disconnect Switch', category: 'solar-backup', usd: 135.0, hrs: 0.9, cadSlug: 'ac-rapid-shutdown' },
  spd: { label: 'Type 2 Whole-Home Surge Protective Device (NEC 230.67)', category: 'panels-gear', usd: 128.0, hrs: 0.75, cadSlug: 'spd-type2-panel' },
  vfd: { label: 'Commercial 3-Phase Variable Frequency Drive (NEC 430.122)', category: 'panels-gear', usd: 1420.0, hrs: 3.25, cadSlug: 'vfd-drive-commercial' },
  dimmer: { label: 'Smart Decora Slide Dimmer Switch + Plate', category: 'wiring-devices', usd: 34.0, hrs: 0.25, cadSlug: 'device-dimmer-smart' },
  'usb-duplex': { label: '20A TR USB-A / USB-C Duplex Receptacle + Plate', category: 'wiring-devices', usd: 29.5, hrs: 0.25, cadSlug: 'device-usb-duplex-20a' },
  'weatherproof-gfci': { label: '20A WR GFCI + Cast FS Box + Extra-Duty In-Use Bubble Cover', category: 'wiring-devices', usd: 46.0, hrs: 0.55, cadSlug: 'device-weatherproof-inuse' },
  'floor-box': { label: 'Recessed Solid-Brass Floor Outlet Box Assembly', category: 'wiring-devices', usd: 118.0, hrs: 1.25, cadSlug: 'device-floor-box-brass' },
  'smoke-co': { label: 'Hardwired 120V Interconnected Smoke/CO Detector', category: 'wiring-devices', usd: 58.0, hrs: 0.35, cadSlug: 'device-smoke-co-alarm' },
  'ceiling-fan': { label: '52" Ceiling Fan w/ Integrated LED Kit + Fan-Rated Brace', category: 'light-fixtures', usd: 215.0, hrs: 1.4, cadSlug: 'fixture-ceiling-fan-light' },
  'under-cabinet-led': { label: '24" Hardwired Kitchen Under-Cabinet LED Task Bar', category: 'light-fixtures', usd: 64.0, hrs: 0.65, cadSlug: 'fixture-under-cabinet-led' },
}

export const CONDUIT_STICK_PRICES_USD: Record<'EMT' | 'PVC-40' | 'RMC', Record<ConduitTradeSize, number>> = {
  EMT: {
    '1/2"': 7.2,
    '3/4"': 11.4,
    '1"': 18.8,
    '1-1/4"': 28.5,
    '1-1/2"': 35.0,
    '2"': 44.5,
    '2-1/2"': 68.0,
    '3"': 84.0,
    '4"': 112.0,
  },
  'PVC-40': {
    '1/2"': 5.4,
    '3/4"': 7.6,
    '1"': 11.8,
    '1-1/4"': 16.5,
    '1-1/2"': 20.0,
    '2"': 26.5,
    '2-1/2"': 42.0,
    '3"': 52.0,
    '4"': 74.0,
  },
  RMC: {
    '1/2"': 22.0,
    '3/4"': 29.5,
    '1"': 43.0,
    '1-1/4"': 59.0,
    '1-1/2"': 72.0,
    '2"': 94.0,
    '2-1/2"': 142.0,
    '3"': 185.0,
    '4"': 248.0,
  },
}

export const THHN_PRICE_PER_FT_USD: Record<WireGauge, number> = {
  '14': 0.22,
  '12': 0.32,
  '10': 0.49,
  '8': 0.88,
  '6': 1.38,
  '4': 2.15,
  '3': 2.65,
  '2': 3.25,
  '1': 4.1,
  '1/0': 4.95,
  '2/0': 6.1,
  '3/0': 7.45,
  '4/0': 9.1,
  '250kcmil': 10.6,
  '300kcmil': 12.4,
  '350kcmil': 14.2,
  '400kcmil': 16.1,
  '500kcmil': 19.5,
  '600kcmil': 23.4,
  '750kcmil': 28.8,
}

export function estimatePanelPriceUsd(
  occupancy: string,
  voltageSystem: string,
  busRatingAmps: number,
  nemaRating: string,
): { usd: number; hrs: number; cadSlug: string } {
  const outdoorAdder = nemaRating === 'NEMA-3R' || nemaRating === 'NEMA-4X' ? 95 : 0
  if (occupancy === 'commercial' || voltageSystem !== '120/240V-1P') {
    const base =
      busRatingAmps >= 400 ? 2650 : busRatingAmps >= 225 ? 1650 : 1250
    const hvAdder = voltageSystem === '277/480V-3P' ? 350 : 0
    return {
      usd: base + hvAdder + outdoorAdder,
      hrs: busRatingAmps >= 400 ? 8.5 : 6.0,
      cadSlug: 'panel-comm-400a-3p',
    }
  }
  const base = busRatingAmps >= 200 ? 315 : 195
  return {
    usd: base + outdoorAdder,
    hrs: busRatingAmps >= 200 ? 4.5 : 3.5,
    cadSlug: outdoorAdder > 0 ? 'panel-nema3r-outdoor' : 'panel-res-200a-closed',
  }
}

export function estimateTransformerPriceUsd(kvaRating: number): { usd: number; hrs: number } {
  if (kvaRating <= 15) return { usd: 1850, hrs: 4.5 }
  if (kvaRating <= 30) return { usd: 2650, hrs: 5.5 }
  if (kvaRating <= 45) return { usd: 3400, hrs: 6.5 }
  if (kvaRating <= 75) return { usd: 4900, hrs: 8.0 }
  if (kvaRating <= 112.5) return { usd: 6800, hrs: 10.0 }
  return { usd: round2(6800 + (kvaRating - 112.5) * 42), hrs: 12.0 }
}

export function estimateBreakerPriceUsd(spec: string): { usd: number; hrs: number } {
  const isDual = spec.includes('AFCI/GFCI')
  const isAfciOrGfci = spec.includes('AFCI') || spec.includes('GFCI')
  const is3P = spec.startsWith('3P-')
  const is2P = spec.startsWith('2P-')
  const ampMatch = spec.match(/-(\d+)A/)
  const amps = ampMatch ? Number(ampMatch[1]) : 20

  if (is3P) return { usd: amps >= 100 ? 245 : amps >= 60 ? 155 : 118, hrs: 0.4 }
  if (is2P) {
    if (isAfciOrGfci) return { usd: 118, hrs: 0.3 }
    return { usd: amps >= 100 ? 88 : amps >= 50 ? 32 : 24, hrs: 0.25 }
  }
  if (isDual) return { usd: 68, hrs: 0.2 }
  if (isAfciOrGfci) return { usd: 58, hrs: 0.2 }
  return { usd: 9.5, hrs: 0.15 }
}

export function estimateWireUnitPricePerFtUsd(wireKey: string): { usd: number; hrsPerFt: number } {
  const gaugeMatch = wireKey.match(/#([0-9/]+(?:kcmil)?)/)
  const gauge = (gaugeMatch?.[1] as WireGauge | undefined) ?? '12'
  const isAluminum = /\bAL\b/i.test(wireKey)
  const baseCu = THHN_PRICE_PER_FT_USD[gauge] ?? 0.35
  const conductorBase = isAluminum ? round2(baseCu * 0.46) : baseCu

  if (wireKey.startsWith('NM-B')) {
    return { usd: round2(conductorBase * 2.45), hrsPerFt: 0.014 }
  }
  if (wireKey.startsWith('MC')) {
    return { usd: round2(conductorBase * 3.4), hrsPerFt: 0.018 }
  }
  return { usd: conductorBase, hrsPerFt: 0.008 }
}

export function formatElectricalBomCsv(
  pricing: ElectricalPricingSummary,
  salesTaxPct = 0,
): string {
  const header =
    'Category,SKU,Description,CAD Model,Qty,Unit,Unit Material ($),Extended Material ($),Labor (hrs),Extended Labor ($),Line Total ($)'
  const lines = [header]
  for (const item of pricing.lineItems) {
    const lineTotal = round2(item.extendedMaterialUsd + item.extendedLaborUsd)
    lines.push(
      [
        item.category,
        sanitizeCsvCell(item.sku),
        sanitizeCsvCell(item.description),
        item.cadSlug ?? '',
        item.quantity,
        item.unit,
        item.unitPriceUsd.toFixed(2),
        item.extendedMaterialUsd.toFixed(2),
        item.extendedLaborHours.toFixed(2),
        item.extendedLaborUsd.toFixed(2),
        lineTotal.toFixed(2),
      ].join(','),
    )
  }
  const cleanTaxPct = Math.min(25, Math.max(0, Number.isFinite(salesTaxPct) ? salesTaxPct : 0))
  const salesTaxUsd = cleanTaxPct > 0 ? round2(pricing.materialSubtotalUsd * (cleanTaxPct / 100)) : 0
  if (salesTaxUsd > 0) {
    lines.push(
      [
        'tax',
        'TAX-MAT',
        `Material Sales Tax (${cleanTaxPct}%)`,
        '',
        1,
        'ea',
        salesTaxUsd.toFixed(2),
        salesTaxUsd.toFixed(2),
        '0.00',
        '0.00',
        salesTaxUsd.toFixed(2),
      ].join(','),
    )
  }
  const grandTotalUsd = round2(pricing.estimatedTotalUsd + salesTaxUsd)
  lines.push(
    [
      'TOTAL',
      '',
      salesTaxUsd > 0 ? 'Estimated Material + Tax + Labor Total' : 'Estimated Material + Labor Subtotal',
      '',
      '',
      '',
      '',
      round2(pricing.materialSubtotalUsd + salesTaxUsd).toFixed(2),
      pricing.laborHoursTotal.toFixed(2),
      pricing.laborSubtotalUsd.toFixed(2),
      grandTotalUsd.toFixed(2),
    ].join(','),
  )
  return lines.join('\n')
}
