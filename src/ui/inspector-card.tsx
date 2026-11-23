/**
 * InspectorExtension card for `electrical:*` nodes:
 * Shows live NEC 314.16 Box Fill, NEC 310.16/310.15 Ampacity, Ch. 9 Conduit Fill,
 * Voltage Drop %, Trade Clashes, NEC 110.26 Clearance, and NEC 450.3(B) Transformer FLA.
 */

import type { AnyNode } from '@pascal-app/core'
import { useScene } from '@pascal-app/editor'
import type { SceneNodeLike } from '../nec/load-calc'
import { buildPanelSchedule } from '../nec/panel-schedule'
import {
  countPathBendDegrees,
  detectRunTradeClashes,
  extractTradeObstacles,
  polylineLengthM,
  type Vec3,
} from '../nec/routing'
import {
  calculateBoxFill,
  calculateConduitFill,
  calculateDeratedAmpacity,
  calculateTransformerSizing,
  calculateVoltageDrop,
} from '../nec/sizing'
import {
  type BoxFillGauge,
  type BoxType,
  type ConduitTradeSize,
  type ConductorMaterial,
  type InsulationRating,
  METERS_TO_FEET,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  type WorkingSpaceCondition,
  getWorkingClearance110_26,
  round2,
} from '../nec/tables'

export default function ElectricalInspectorCard({ node }: { node?: AnyNode }) {
  const nodes = useScene((s) => s.nodes) as unknown as Readonly<Record<string, SceneNodeLike>>
  if (!node) return null
  const raw = node as unknown as SceneNodeLike

  if (raw.type === 'electrical:panel') {
    const all = Object.values(nodes)
    const schedule = buildPanelSchedule(
      raw,
      all.filter((n) => n.type === 'electrical:device'),
      all.filter((n) => n.type === 'electrical:conduit-run'),
    )
    const clear = getWorkingClearance110_26(
      schedule.voltageSystem,
      (raw.condition110_26 === 1 || raw.condition110_26 === 3 ? raw.condition110_26 : 2) as WorkingSpaceCondition,
    )
    return (
      <div style={cardStyle}>
        <Row label="NEC 110.26 Working Space" value={`30"W × ${clear.depthIn}"D × 78"H`} />
        <Row label="Connected Load" value={`${schedule.totalConnectedVa} VA (${schedule.totalLineAmps} A)`} />
        <Row label="Utilization" value={`${schedule.utilizationPct}%`} warn={schedule.utilizationPct > 80} />
        <Row label="Phase Imbalance" value={`${schedule.imbalancePct}%`} warn={schedule.imbalancePct > 20} />
        <Row label="Spaces Used" value={`${schedule.usedSpaces} / ${schedule.spaces}`} />
      </div>
    )
  }

  if (raw.type === 'electrical:device') {
    const boxType = (typeof raw.boxType === 'string' ? raw.boxType : 'single-gang-standard') as BoxType
    const wireGauge = (typeof raw.wireGauge === 'string' ? raw.wireGauge : '12') as BoxFillGauge
    const fill = calculateBoxFill({
      boxType,
      conductors: [{ gauge: wireGauge, count: typeof raw.conductorCount === 'number' ? raw.conductorCount : 4 }],
      deviceYokeCount: typeof raw.yokeCount === 'number' ? raw.yokeCount : 1,
      internalClampCount: typeof raw.clampCount === 'number' ? raw.clampCount : 1,
      equipmentGroundCount: 1,
    })
    return (
      <div style={cardStyle}>
        <Row
          label="NEC 314.16 Box Fill"
          value={`${fill.totalRequiredCuIn} / ${fill.boxVolumeCuIn} cu in (${fill.utilizationPct}%)`}
          warn={!fill.compliant}
        />
        {!fill.compliant && <Row label="Recommended Box" value={fill.recommendedBoxType} warn />}
      </div>
    )
  }

  if (raw.type === 'electrical:conduit-run') {
    const path = Array.isArray(raw.path) ? (raw.path as Vec3[]) : []
    const lenFt = round2(polylineLengthM(path) * METERS_TO_FEET)
    const { totalBendDegrees } = countPathBendDegrees(path)
    const obstacles = extractTradeObstacles(nodes)
    const clashes = detectRunTradeClashes(path, obstacles)
    const racewayType = (typeof raw.racewayType === 'string' ? raw.racewayType : 'emt') as RacewayType
    const wireGauge = (typeof raw.wireGauge === 'string' ? raw.wireGauge : '12') as WireGauge
    const material = (raw.conductorMaterial === 'al' ? 'al' : 'cu') as ConductorMaterial
    const amp = calculateDeratedAmpacity({
      wireGauge,
      material,
      insulationRating: (raw.insulationRating as InsulationRating) ?? '90C',
      racewayType,
      ambientTempC: typeof raw.ambientTempC === 'number' ? raw.ambientTempC : 30,
      rooftopExposed: raw.rooftopExposed === true,
      currentCarryingCount: typeof raw.currentCarryingCount === 'number' ? raw.currentCarryingCount : 2,
      loadAmps: typeof raw.loadAmps === 'number' ? raw.loadAmps : 16,
      continuousLoad: raw.continuous === true,
    })
    const vd = calculateVoltageDrop({
      wireGauge,
      material,
      loadAmps: typeof raw.loadAmps === 'number' ? raw.loadAmps : 16,
      oneWayLengthFt: lenFt,
      voltage: typeof raw.voltage === 'number' ? raw.voltage : 120,
      phases: raw.phases === 3 ? 3 : 1,
    })
    const fill =
      racewayType === 'emt' || racewayType === 'pvc-40' || racewayType === 'rmc'
        ? calculateConduitFill({
            conduitType: racewayType,
            tradeSize: (raw.tradeSize as ConduitTradeSize) ?? '3/4"',
            conductors: [{ gauge: wireGauge, count: typeof raw.totalConductorCount === 'number' ? raw.totalConductorCount : 3 }],
            lengthInches: lenFt * 12,
          })
        : null

    return (
      <div style={cardStyle}>
        <Row label="Routed Length" value={`${lenFt} ft`} />
        <Row label="Total Bends (358.26)" value={`${totalBendDegrees}° / 360°`} warn={totalBendDegrees > 360} />
        <Row label="Derated Ampacity" value={`${amp.finalAllowableAmpacity} A`} warn={!amp.compliant} />
        <Row label="Voltage Drop" value={`${vd.voltageDropPct}% (${vd.voltageDropVolts}V)`} warn={!vd.compliant} />
        {fill && <Row label="Ch. 9 Conduit Fill" value={`${fill.actualFillPct}% / ${fill.maxAllowedFillPct}%`} warn={!fill.compliant} />}
        <Row label="Trade Clashes" value={clashes.length === 0 ? 'Clear' : `${clashes.length} clash(es)`} warn={clashes.length > 0} />
      </div>
    )
  }

  if (raw.type === 'electrical:transformer') {
    const kva = typeof raw.kvaRating === 'number' ? raw.kvaRating : 75
    const primV = typeof raw.primaryVoltage === 'number' ? raw.primaryVoltage : 480
    const secV = typeof raw.secondaryVoltage === 'number' ? raw.secondaryVoltage : 208
    const tx = calculateTransformerSizing(kva, primV, secV)
    return (
      <div style={cardStyle}>
        <Row label={`Primary (${primV}V 3Φ)`} value={`${tx.primaryFla}A FLA · ${tx.maxPrimaryOcpdAmps}A OCPD (#${tx.recommendedPrimaryCuGauge})`} />
        <Row label={`Secondary (${secV}V 3Φ)`} value={`${tx.secondaryFla}A FLA · ${tx.maxSecondaryOcpdAmps}A OCPD (#${tx.recommendedSecondaryCuGauge})`} />
      </div>
    )
  }

  return null
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ opacity: 0.72 }}>{label}</span>
      <span style={{ fontWeight: 600, color: warn ? '#f87171' : 'inherit' }}>{value}</span>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  fontSize: 11,
  padding: '6px 0',
}
