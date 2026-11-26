'use client'

/**
 * InspectorExtension card for `electrical:*` nodes:
 * Shows live NEC 314.16 Box Fill, NEC 310.16/310.15 Ampacity, Ch. 9 Conduit Fill,
 * Voltage Drop %, Trade Clashes, NEC 110.26 Clearance, and NEC 450.3(B) Transformer FLA.
 */

import type { AnyNode } from '@pascal-app/core'
import { openEditorView, useScene } from '@pascal-app/editor'
import { useMemo } from 'react'
import { auditSceneElectrical, type NecAuditFinding } from '../nec/audit'
import type { SceneNodeLike } from '../nec/load-calc'
import { ELECTRICAL_SCHEDULE_VIEW_ID } from '../render'
import { useElectricalUi } from './store'
import { buildPanelSchedule } from '../nec/panel-schedule'
import {
  countPathBendDegrees,
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
  type BoxType,
  type ConduitTradeSize,
  type ConductorMaterial,
  type InsulationRating,
  METERS_TO_FEET,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
  type WorkingSpaceCondition,
  clampToBoxFillGauge,
  getWorkingClearance110_26,
  round2,
  usesSeparateRoughInBox,
} from '../nec/tables'

export default function ElectricalInspectorCard({ node }: { node?: AnyNode }) {
  const nodes = useScene((s) => s.nodes) as unknown as Readonly<Record<string, SceneNodeLike>>
  const setActiveTab = useElectricalUi((s) => s.setActiveTab)
  const setSelectedPanelId = useElectricalUi((s) => s.setSelectedPanelId)
  const audit = useMemo(() => auditSceneElectrical(nodes), [nodes])
  const raw = node as unknown as SceneNodeLike | undefined
  const nodeFindings = useMemo(
    () => (raw ? audit.findings.filter((f) => f.nodeIds.includes(raw.id)) : []),
    [audit, raw],
  )
  const panelSchedule = useMemo(() => {
    if (!raw || raw.type !== 'electrical:panel') return null
    const all = Object.values(nodes)
    return buildPanelSchedule(
      raw,
      all.filter((n) => n.type === 'electrical:device'),
      all.filter((n) => n.type === 'electrical:conduit-run'),
    )
  }, [nodes, raw])
  const resolvedConduitBreakerAmps = useMemo(() => {
    if (!raw || raw.type !== 'electrical:conduit-run') return undefined
    if (typeof raw.breakerAmps === 'number') return raw.breakerAmps
    const targetNode = typeof raw.targetDeviceId === 'string' ? nodes[raw.targetDeviceId] : undefined
    if (typeof targetNode?.breakerAmps === 'number') return targetNode.breakerAmps
    if (typeof raw.panelId === 'string' && typeof raw.circuitNumber === 'number') {
      return Object.values(nodes).reduce<number | undefined>((maxA, n) => {
        if (
          n.type === 'electrical:device' &&
          n.panelId === raw.panelId &&
          n.circuitNumber === raw.circuitNumber &&
          typeof n.breakerAmps === 'number'
        ) {
          return maxA === undefined ? n.breakerAmps : Math.max(maxA, n.breakerAmps)
        }
        return maxA
      }, undefined)
    }
    return undefined
  }, [nodes, raw])
  if (!raw) return null

  const openFullAudit = () => {
    setActiveTab('audit')
    openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
  }

  if (raw.type === 'electrical:panel' && panelSchedule) {
    const schedule = panelSchedule
    const clear = getWorkingClearance110_26(
      schedule.voltageSystem,
      (raw.condition110_26 === 1 || raw.condition110_26 === 3 ? raw.condition110_26 : 2) as WorkingSpaceCondition,
    )
    return (
      <div style={cardStyle}>
        <NodeViolationBanner findings={nodeFindings} onOpenAudit={openFullAudit} />
        <Row label="NEC 110.26 Working Space" value={`30"W × ${clear.depthIn}"D × 78"H`} />
        <Row label="Connected Load" value={`${schedule.totalConnectedVa} VA (${schedule.totalLineAmps} A)`} />
        <Row label="Utilization" value={`${schedule.utilizationPct}%`} warn={schedule.utilizationPct > 80} />
        <Row label="Phase Imbalance" value={`${schedule.imbalancePct}%`} warn={schedule.imbalancePct > 20} />
        <Row label="Spaces Used" value={`${schedule.usedSpaces} / ${schedule.spaces}`} />
        <button
          type="button"
          onClick={() => {
            setSelectedPanelId(raw.id)
            setActiveTab('panel-interior')
            openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
          }}
          style={{
            marginTop: 4,
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid rgba(56,189,248,0.5)',
            background: 'rgba(56,189,248,0.16)',
            color: 'inherit',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Zoom Into Panel Wiring (Cover Off)
        </button>
      </div>
    )
  }

  if (raw.type === 'electrical:device') {
    const devKind = typeof raw.deviceKind === 'string' ? raw.deviceKind : 'duplex'
    if (!usesSeparateRoughInBox(devKind)) {
      return (
        <div style={cardStyle}>
          <NodeViolationBanner findings={nodeFindings} onOpenAudit={openFullAudit} />
          <Row label="Enclosure" value="Integral / Self-Contained" />
          <Row label="Conductor Size" value={`#${typeof raw.wireGauge === 'string' ? raw.wireGauge : '12'} AWG`} />
        </div>
      )
    }
    const boxType = (typeof raw.boxType === 'string' ? raw.boxType : 'single-gang-standard') as BoxType
    const wireGauge = clampToBoxFillGauge(typeof raw.wireGauge === 'string' ? raw.wireGauge : undefined)
    const fill = calculateBoxFill({
      boxType,
      conductors: [{ gauge: wireGauge, count: typeof raw.conductorCount === 'number' ? raw.conductorCount : 4 }],
      deviceYokeCount: typeof raw.yokeCount === 'number' ? raw.yokeCount : 1,
      internalClampCount: typeof raw.clampCount === 'number' ? raw.clampCount : 1,
      equipmentGroundCount: 1,
    })
    return (
      <div style={cardStyle}>
        <NodeViolationBanner findings={nodeFindings} onOpenAudit={openFullAudit} />
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
    const clashCount = nodeFindings.filter((f) => f.category === 'trade-clash').length
    const racewayType = (typeof raw.racewayType === 'string' ? raw.racewayType : 'emt') as RacewayType
    const wireGauge = (typeof raw.wireGauge === 'string' ? raw.wireGauge : '12') as WireGauge
    const material = (raw.conductorMaterial === 'al' ? 'al' : 'cu') as ConductorMaterial
    const resolvedBreakerAmps = resolvedConduitBreakerAmps
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
      breakerAmps: resolvedBreakerAmps,
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

    const meta = (raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}) as Record<string, unknown>
    const routingMode = typeof meta.routingMode === 'string' ? meta.routingMode : null
    const routingLabel =
      routingMode === 'attic-euclidean'
        ? 'Attic Euclidean (NEC 334.23)'
        : routingMode === 'crawlspace-euclidean'
          ? 'Crawl Space Euclidean (334.15(C))'
          : routingMode === 'wall-manhattan'
            ? 'Wall-Cavity Manhattan'
            : null

    return (
      <div style={cardStyle}>
        <NodeViolationBanner findings={nodeFindings} onOpenAudit={openFullAudit} />
        {routingLabel && <Row label="Routing Mode" value={routingLabel} />}
        <Row label="Routed Length" value={`${lenFt} ft`} />
        <Row label="Total Bends (358.26)" value={`${totalBendDegrees}° / 360°`} warn={totalBendDegrees > 360} />
        <Row
          label="Derated Ampacity"
          value={
            resolvedBreakerAmps
              ? `${amp.finalAllowableAmpacity} A (${resolvedBreakerAmps}A OCPD)`
              : `${amp.finalAllowableAmpacity} A`
          }
          warn={!amp.compliant || !amp.breakerCompliant}
        />
        <Row label="Voltage Drop" value={`${vd.voltageDropPct}% (${vd.voltageDropVolts}V)`} warn={!vd.compliant} />
        {fill && <Row label="Ch. 9 Conduit Fill" value={`${fill.actualFillPct}% / ${fill.maxAllowedFillPct}%`} warn={!fill.compliant} />}
        <Row label="Trade Clashes" value={clashCount === 0 ? 'Clear' : `${clashCount} clash(es)`} warn={clashCount > 0} />
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
        <NodeViolationBanner findings={nodeFindings} onOpenAudit={openFullAudit} />
        <Row label={`Primary (${primV}V 3Φ)`} value={`${tx.primaryFla}A FLA · ${tx.maxPrimaryOcpdAmps}A OCPD (#${tx.recommendedPrimaryCuGauge})`} />
        <Row label={`Secondary (${secV}V 3Φ)`} value={`${tx.secondaryFla}A FLA · ${tx.maxSecondaryOcpdAmps}A OCPD (#${tx.recommendedSecondaryCuGauge})`} />
      </div>
    )
  }

  return null
}

function NodeViolationBanner({
  findings,
  onOpenAudit,
}: {
  findings: NecAuditFinding[]
  onOpenAudit: () => void
}) {
  if (findings.length === 0) {
    return (
      <div
        style={{
          padding: '4px 7px',
          borderRadius: 6,
          background: 'rgba(16,185,129,0.14)',
          border: '1px solid rgba(16,185,129,0.35)',
          color: '#34d399',
          fontSize: 10,
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>NEC Code Check: Compliant</span>
        <span>PASS</span>
      </div>
    )
  }

  const hasError = findings.some((f) => f.severity === 'error')
  return (
    <div
      style={{
        padding: 7,
        borderRadius: 6,
        background: hasError ? 'rgba(239,68,68,0.14)' : 'rgba(245,158,11,0.14)',
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.48)' : 'rgba(245,158,11,0.48)'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: hasError ? '#f87171' : '#fbbf24',
          fontWeight: 700,
          fontSize: 10,
        }}
      >
        <span>{hasError ? 'NOT TO CODE' : 'NEC WARNING'} ({findings.length})</span>
        <button
          type="button"
          onClick={onOpenAudit}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            textDecoration: 'underline',
            cursor: 'pointer',
            fontSize: 10,
            padding: 0,
          }}
        >
          Full Audit
        </button>
      </div>
      {findings.map((f) => (
        <div
          key={f.id}
          style={{
            borderTop: '1px solid rgba(255,255,255,0.1)',
            paddingTop: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{ fontWeight: 600, color: f.severity === 'error' ? '#fca5a5' : '#fde68a' }}>
            [{f.codeRef}] {f.title}
          </div>
          {f.suggestedFix && (
            <div style={{ fontSize: 10, opacity: 0.85 }}>Fix: {f.suggestedFix}</div>
          )}
        </div>
      ))}
    </div>
  )
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
