/**
 * Persisted ChatToolCard for `krusch:electrical` (`PluginChatExtension`).
 * Renders strictly from persisted tool call output across all 3 registered cards:
 * `electrical_audit_nec`, `electrical_generate_schedule`, and `electrical_route_circuit`.
 */

import type { ChatToolCardProps } from '@pascal-app/editor'
import { ELECTRICAL_SCHEDULE_VIEW_ID } from './electrical-panel'

type AuditFindingItem = {
  id: string
  category?: string
  title: string
  codeRef: string
  nodeIds?: string[]
}

type ScheduleSummaryItem = {
  panelId?: string
  panelName?: string
  totalConnectedVa?: number
  imbalancePct?: number
  utilizationPct?: number
}

type TakeoffPricingSummary = {
  pricing?: {
    estimatedTotalUsd?: number
  }
}

export default function ElectricalChatCard({ toolName, output, state, actions }: ChatToolCardProps) {
  const data = output?.data as Record<string, unknown> | undefined
  const findings = Array.isArray(data?.findings) ? (data.findings as AuditFindingItem[]) : []
  const schedules = Array.isArray(data?.schedules) ? (data.schedules as ScheduleSummaryItem[]) : null
  const takeoff =
    data?.takeoff && typeof data.takeoff === 'object' ? (data.takeoff as TakeoffPricingSummary) : null
  const conduitRunId = typeof data?.conduitRunId === 'string' ? data.conduitRunId : null

  const isScheduleResult = schedules !== null || takeoff !== null
  const isRouteResult = conduitRunId !== null

  const panelCount =
    typeof data?.panelCount === 'number' ? data.panelCount : schedules ? schedules.length : 0
  const totalConnectedVa = schedules
    ? schedules.reduce((sum, s) => sum + (typeof s.totalConnectedVa === 'number' ? s.totalConnectedVa : 0), 0)
    : 0
  const maxImbalancePct =
    schedules && schedules.length > 0
      ? Math.max(...schedules.map((s) => (typeof s.imbalancePct === 'number' ? s.imbalancePct : 0)))
      : 0
  const estimatedTotalUsd =
    typeof takeoff?.pricing?.estimatedTotalUsd === 'number' ? takeoff.pricing.estimatedTotalUsd : null

  const runName = typeof data?.name === 'string' && data.name ? data.name : conduitRunId ?? ''
  const wireGauge = typeof data?.wireGauge === 'string' ? data.wireGauge : null
  const tradeSize = typeof data?.tradeSize === 'string' ? data.tradeSize : null
  const routedLengthFt = typeof data?.routedLengthFt === 'number' ? data.routedLengthFt : null
  const voltageDropPct = typeof data?.voltageDropPct === 'number' ? data.voltageDropPct : null
  const voltageDropCompliant = data?.voltageDropCompliant !== false
  const totalBendDegrees = typeof data?.totalBendDegrees === 'number' ? data.totalBendDegrees : null
  const avoidedObstaclesCount = Array.isArray(data?.avoidedObstacles) ? data.avoidedObstacles.length : 0
  const remainingClashesCount = Array.isArray(data?.remainingClashes) ? data.remainingClashes.length : 0

  const hasAuditTradeClash = findings.some((f) => f.category === 'trade-clash')
  const showAutoFixClashes = (isRouteResult && remainingClashesCount > 0) || hasAuditTradeClash

  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--border, rgba(255,255,255,0.16))',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
        <span>{toolName}</span>
        <span style={{ fontSize: 11, opacity: 0.75 }}>{state}</span>
      </div>
      {output?.text && <div style={{ opacity: 0.85 }}>{output.text}</div>}

      {/* electrical_generate_schedule summary */}
      {isScheduleResult && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            fontSize: 11,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
          }}
        >
          <div>
            <strong>{panelCount}</strong> {panelCount === 1 ? 'panel' : 'panels'} ·{' '}
            <strong>{totalConnectedVa.toLocaleString('en-US')} VA</strong> connected ·{' '}
            <strong>{Math.round(maxImbalancePct * 10) / 10}%</strong> max phase imbalance
          </div>
          {estimatedTotalUsd !== null && (
            <div>
              Estimated BOM Total:{' '}
              <strong style={{ color: '#34d399' }}>
                ${estimatedTotalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </strong>
            </div>
          )}
        </div>
      )}

      {/* electrical_route_circuit summary */}
      {isRouteResult && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            fontSize: 11,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
          }}
        >
          <div style={{ fontWeight: 600 }}>{runName}</div>
          <div>
            {wireGauge ? (wireGauge.includes('kcmil') ? wireGauge : `#${wireGauge} AWG`) : 'Wire'}{' '}
            {tradeSize ? `· ${tradeSize}` : ''}
            {routedLengthFt !== null ? ` · ${routedLengthFt} ft` : ''}
            {totalBendDegrees !== null ? ` · ${totalBendDegrees} deg bends` : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {voltageDropPct !== null && (
              <span style={{ color: voltageDropCompliant ? '#34d399' : '#fbbf24', fontWeight: 600 }}>
                VD: {voltageDropPct}% ({voltageDropCompliant ? 'compliant' : 'warn'})
              </span>
            )}
            <span>Avoided: {avoidedObstaclesCount}</span>
            <span style={{ color: remainingClashesCount > 0 ? '#f87171' : '#34d399', fontWeight: 600 }}>
              Clashes: {remainingClashesCount}
            </span>
          </div>
        </div>
      )}

      {/* electrical_audit_nec findings */}
      {findings.slice(0, 4).map((f) => (
        <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>
            <strong>{f.codeRef}</strong>: {f.title}
          </span>
          {f.nodeIds && f.nodeIds.length > 0 && (
            <button
              type="button"
              onClick={() => actions.select(f.nodeIds!)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#38bdf8',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Select
            </button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => actions.openView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })}
          style={{
            padding: '4px 8px',
            borderRadius: 5,
            border: '1px solid rgba(245,158,11,0.45)',
            background: 'rgba(245,158,11,0.15)',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Open Electrical Schedule
        </button>
        {isRouteResult && conduitRunId && (
          <button
            type="button"
            onClick={() => actions.select([conduitRunId])}
            style={{
              padding: '4px 8px',
              borderRadius: 5,
              border: '1px solid rgba(16,185,129,0.45)',
              background: 'rgba(16,185,129,0.15)',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Select Run
          </button>
        )}
        {showAutoFixClashes && (
          <button
            type="button"
            onClick={() => actions.send('Reroute any clashing electrical conduit runs around plumbing and HVAC obstacles.')}
            style={{
              padding: '4px 8px',
              borderRadius: 5,
              border: '1px solid rgba(56,189,248,0.45)',
              background: 'rgba(56,189,248,0.15)',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Auto-Fix Clashes
          </button>
        )}
      </div>
    </div>
  )
}
