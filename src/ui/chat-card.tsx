/**
 * Persisted ChatToolCard for `krusch:electrical` (`PluginChatExtension`).
 * Renders strictly from persisted tool call output; exposes host Open View & Select actions.
 */

import type { ChatToolCardProps } from '@pascal-app/editor'
import { ELECTRICAL_SCHEDULE_VIEW_ID } from './electrical-panel'

export default function ElectricalChatCard({ toolName, output, state, actions }: ChatToolCardProps) {
  const data = output?.data as Record<string, unknown> | undefined
  const errorCount = typeof data?.errorCount === 'number' ? data.errorCount : 0
  const findings = Array.isArray(data?.findings)
    ? (data.findings as Array<{ id: string; title: string; codeRef: string; nodeIds?: string[] }>)
    : []

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
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
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
        {errorCount > 0 && (
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
