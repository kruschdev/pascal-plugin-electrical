/**
 * Full-pane EditorHostView (`krusch:electrical:schedule`) that opens beside the 3D/2D scene:
 * Tabs: Panel Schedule | NEC 220 Load Calc | NEC & Trade Audit | Material Takeoff.
 */

import { useScene, useViewer } from '@pascal-app/editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import { auditSceneElectrical } from '../nec/audit'
import { calculateSceneLoad, type SceneNodeLike } from '../nec/load-calc'
import {
  buildElectricalTakeoff,
  buildPanelSchedule,
  formatPanelScheduleCsv,
} from '../nec/panel-schedule'
import { formatElectricalBomCsv } from '../nec/pricing'
import { COMMERCIAL_LIGHTING_VA_PER_SQFT, type CommercialOccupancy } from '../nec/tables'
import PanelInteriorView from './panel-interior-view'
import { type ScheduleTab, useElectricalUi } from './store'

export default function ElectricalScheduleView() {
  const nodes = useScene((s) => s.nodes)
  const setSelection = useViewer((s) => s.setSelection)
  const {
    occupancy,
    setOccupancy,
    residentialMethod,
    setResidentialMethod,
    commercialBuildingType,
    setCommercialBuildingType,
    activeTab,
    setActiveTab,
    selectedPanelId,
    setSelectedPanelId,
  } = useElectricalUi()

  const [copiedCsv, setCopiedCsv] = useState(false)
  const [copiedBomCsv, setCopiedBomCsv] = useState(false)
  const [laborRateUsd, setLaborRateUsd] = useState(115)
  const [materialMarkupPct, setMaterialMarkupPct] = useState(0)
  const [salesTaxPct, setSalesTaxPct] = useState(0)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bomCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current)
      }
      if (bomCopyTimeoutRef.current !== null) {
        clearTimeout(bomCopyTimeoutRef.current)
      }
    }
  }, [])

  const panels = useMemo(
    () => Object.values(record).filter((n) => n.type === 'electrical:panel'),
    [record],
  )
  const devices = useMemo(
    () => Object.values(record).filter((n) => n.type === 'electrical:device'),
    [record],
  )
  const runs = useMemo(
    () => Object.values(record).filter((n) => n.type === 'electrical:conduit-run'),
    [record],
  )

  const activePanel = panels.find((p) => p.id === selectedPanelId) ?? panels[0] ?? null
  const schedule = useMemo(
    () => (activePanel ? buildPanelSchedule(activePanel, devices, runs) : null),
    [activePanel, devices, runs],
  )
  const loadCalc = useMemo(
    () =>
      calculateSceneLoad(record, {
        occupancy,
        residentialMethod,
        commercialBuildingType,
      }),
    [record, occupancy, residentialMethod, commercialBuildingType],
  )
  const audit = useMemo(() => auditSceneElectrical(record), [record])
  const takeoff = useMemo(
    () =>
      buildElectricalTakeoff(record, {
        laborRatePerHourUsd: laborRateUsd,
        materialMarkupPct,
      }),
    [record, laborRateUsd, materialMarkupPct],
  )
  const salesTaxUsd = Math.round(takeoff.pricing.materialSubtotalUsd * (salesTaxPct / 100) * 100) / 100
  const grandTotalWithTaxUsd = Math.round((takeoff.pricing.estimatedTotalUsd + salesTaxUsd) * 100) / 100

  const copyCsv = async () => {
    if (!schedule || typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(formatPanelScheduleCsv(schedule))
      setCopiedCsv(true)
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current)
      }
      copyTimeoutRef.current = setTimeout(() => {
        copyTimeoutRef.current = null
        setCopiedCsv(false)
      }, 1800)
    } catch {
      setCopiedCsv(false)
    }
  }

  const copyBomCsv = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(formatElectricalBomCsv(takeoff.pricing))
      setCopiedBomCsv(true)
      if (bomCopyTimeoutRef.current !== null) {
        clearTimeout(bomCopyTimeoutRef.current)
      }
      bomCopyTimeoutRef.current = setTimeout(() => {
        bomCopyTimeoutRef.current = null
        setCopiedBomCsv(false)
      }, 1800)
    } catch {
      setCopiedBomCsv(false)
    }
  }

  const tabs: { id: ScheduleTab; label: string }[] = [
    { id: 'schedule', label: 'Panel Schedule' },
    { id: 'panel-interior', label: 'Panel Interior (3D)' },
    { id: 'load-calc', label: 'NEC 220 Load Calc' },
    { id: 'audit', label: `NEC Audit (${audit.errorCount}/${audit.warningCount})` },
    { id: 'takeoff', label: 'Takeoff & Cost' },
  ]

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: 16,
        fontSize: 12,
        color: 'var(--foreground, #e5e7eb)',
        background: 'var(--background, #0f172a)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Electrical Engineering & NEC Schedule</h2>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            Drafting aid — verify all load calculations and clearances with local AHJ before construction.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border, rgba(255,255,255,0.14))',
                background: activeTab === t.id ? 'rgba(245,158,11,0.22)' : 'transparent',
                color: 'inherit',
                fontWeight: activeTab === t.id ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* TAB 1: Panel Schedule */}
      {activeTab === 'schedule' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!schedule ? (
            <div style={{ opacity: 0.75 }}>No electrical panels in the scene yet. Place a panelboard from the Electrical rail panel.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={schedule.panelId}
                    onChange={(e) => setSelectedPanelId(e.target.value)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.06)',
                      color: 'inherit',
                      border: '1px solid var(--border, rgba(255,255,255,0.18))',
                    }}
                  >
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>
                        {String(p.name ?? p.id)} ({String(p.voltageSystem ?? '120/240V-1P')})
                      </option>
                    ))}
                  </select>
                  <span>
                    {schedule.voltageSystem} · {schedule.busRatingAmps}A Bus / {schedule.mainBreakerAmps}A{' '}
                    {schedule.mainType.toUpperCase()} · {schedule.usedSpaces}/{schedule.spaces} spaces ·{' '}
                    {schedule.utilizationPct}% util · {schedule.imbalancePct}% phase imbalance
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void copyCsv()}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border, rgba(255,255,255,0.18))',
                    background: 'rgba(255,255,255,0.06)',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  {copiedCsv ? 'Copied CSV' : 'Copy CSV'}
                </button>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.18)', textAlign: 'left' }}>
                    <th style={thStyle}>Ckt</th>
                    <th style={thStyle}>Description</th>
                    <th style={thStyle}>Bkr</th>
                    <th style={thStyle}>VA</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Phase</th>
                    <th style={thStyle}>VA</th>
                    <th style={thStyle}>Bkr</th>
                    <th style={thStyle}>Description</th>
                    <th style={thStyle}>Ckt</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.rows.map((row) => (
                    <tr key={row.leftCircuit} style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      <td style={tdStyle}>{row.leftCircuit}</td>
                      <td style={tdStyle}>{row.left ? row.left.description : <span style={{ opacity: 0.45 }}>SPARE</span>}</td>
                      <td style={tdStyle}>{row.left ? `${row.left.poles}P-${row.left.breakerAmps}A` : '—'}</td>
                      <td style={tdStyle}>{row.left ? row.left.loadVa : 0}</td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700 }}>{row.phaseLabel}</td>
                      <td style={tdStyle}>{row.right ? row.right.loadVa : 0}</td>
                      <td style={tdStyle}>{row.right ? `${row.right.poles}P-${row.right.breakerAmps}A` : '—'}</td>
                      <td style={tdStyle}>{row.right ? row.right.description : <span style={{ opacity: 0.45 }}>SPARE</span>}</td>
                      <td style={tdStyle}>{row.rightCircuit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* TAB 2: Zoomed-In 3D Panel Interior (Cover Off — Live Wires, Breakers & Busbars) */}
      {activeTab === 'panel-interior' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!schedule || !activePanel ? (
            <div style={{ opacity: 0.75 }}>
              No electrical panels in the scene yet. Place a panelboard from the Electrical rail panel to inspect its live internal wiring.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={schedule.panelId}
                    onChange={(e) => setSelectedPanelId(e.target.value)}
                    style={selectStyle}
                  >
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>
                        {String(p.name ?? p.id)} ({String(p.voltageSystem ?? '120/240V-1P')})
                      </option>
                    ))}
                  </select>
                  <span>
                    {schedule.voltageSystem} · {schedule.busRatingAmps}A Bus / {schedule.mainBreakerAmps}A{' '}
                    {schedule.mainType.toUpperCase()} · {schedule.usedSpaces}/{schedule.spaces} breaker spaces wired
                  </span>
                </div>
              </div>
              <PanelInteriorView
                schedule={schedule}
                nemaRating={
                  activePanel.nemaRating === 'NEMA-3R' || activePanel.nemaRating === 'NEMA-4X'
                    ? activePanel.nemaRating
                    : 'NEMA-1'
                }
                onSelectDeviceIds={(ids) => setSelection({ selectedIds: ids as never })}
              />
            </>
          )}
        </div>
      )}

      {/* TAB 3: NEC 220 Load Calc */}
      {activeTab === 'load-calc' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={occupancy}
              onChange={(e) => setOccupancy(e.target.value as 'residential' | 'commercial')}
              style={selectStyle}
            >
              <option value="residential">Residential (Dwelling Unit)</option>
              <option value="commercial">Commercial Occupancy</option>
            </select>
            {occupancy === 'residential' ? (
              <select
                value={residentialMethod}
                onChange={(e) => setResidentialMethod(e.target.value as 'standard' | 'optional')}
                style={selectStyle}
              >
                <option value="standard">NEC 220 Standard Method</option>
                <option value="optional">NEC 220.82 Optional Method</option>
              </select>
            ) : (
              <select
                value={commercialBuildingType}
                onChange={(e) => setCommercialBuildingType(e.target.value as CommercialOccupancy)}
                style={selectStyle}
              >
                {(Object.keys(COMMERCIAL_LIGHTING_VA_PER_SQFT) as CommercialOccupancy[]).map((k) => (
                  <option key={k} value={k}>
                    {COMMERCIAL_LIGHTING_VA_PER_SQFT[k].label} ({COMMERCIAL_LIGHTING_VA_PER_SQFT[k].vaPerSqFt} VA/sq ft)
                  </option>
                ))}
              </select>
            )}
          </div>

          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.12)',
              overflow: 'auto',
              fontSize: 11,
            }}
          >
            {JSON.stringify(loadCalc, null, 2)}
          </pre>
        </div>
      )}

      {/* TAB 3: NEC & Trade-Priority Audit */}
      {activeTab === 'audit' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {audit.findings.length === 0 ? (
            <div style={{ color: '#34d399', fontWeight: 600 }}>
              All electrical panels, devices, conduit runs, and trade clearances pass NEC checks.
            </div>
          ) : (
            audit.findings.map((f) => (
              <div
                key={f.id}
                onClick={() => {
                  if (f.nodeIds.length > 0) {
                    setSelection({ selectedIds: f.nodeIds as never })
                  }
                }}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  cursor: 'pointer',
                  border: `1px solid ${f.severity === 'error' ? 'rgba(239,68,68,0.5)' : 'rgba(245,158,11,0.45)'}`,
                  background: f.severity === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>{f.title}</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{f.codeRef}</span>
                </div>
                <div style={{ marginTop: 4, opacity: 0.85 }}>{f.message}</div>
                {f.suggestedFix && (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#38bdf8' }}>Fix: {f.suggestedFix}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* TAB 4: Takeoff & Cost Estimate */}
      {activeTab === 'takeoff' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Live Editable Contractor Pricing Calculator Controls */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 11 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Labor ($/hr):
              <input
                type="number"
                min={0}
                max={500}
                step={5}
                value={laborRateUsd}
                onChange={(e) => setLaborRateUsd(Math.max(0, Number(e.target.value) || 0))}
                style={{ ...selectStyle, width: 72 }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Markup (%):
              <input
                type="number"
                min={0}
                max={200}
                step={1}
                value={materialMarkupPct}
                onChange={(e) => setMaterialMarkupPct(Math.max(0, Number(e.target.value) || 0))}
                style={{ ...selectStyle, width: 64 }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Material Tax (%):
              <input
                type="number"
                min={0}
                max={25}
                step={0.25}
                value={salesTaxPct}
                onChange={(e) => setSalesTaxPct(Math.max(0, Number(e.target.value) || 0))}
                style={{ ...selectStyle, width: 64 }}
              />
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
              <span>
                Materials: <strong>${takeoff.pricing.materialSubtotalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
              </span>
              {salesTaxPct > 0 && (
                <span>
                  Tax ({salesTaxPct}%): <strong>${salesTaxUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
                </span>
              )}
              <span>
                Est. Labor ({takeoff.pricing.laborHoursTotal} hrs @ ${takeoff.pricing.laborRatePerHourUsd}/hr):{' '}
                <strong>${takeoff.pricing.laborSubtotalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
              </span>
              <span>
                Est. Total:{' '}
                <strong style={{ color: '#34d399' }}>
                  ${grandTotalWithTaxUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </strong>
              </span>
            </div>
            <button
              type="button"
              onClick={() => void copyBomCsv()}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                border: '1px solid var(--border, rgba(255,255,255,0.18))',
                background: 'rgba(255,255,255,0.06)',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              {copiedBomCsv ? 'Copied BOM CSV' : 'Copy BOM CSV'}
            </button>
          </div>

          <div style={{ fontSize: 11, opacity: 0.7 }}>{takeoff.pricing.disclaimer}</div>

          {takeoff.pricing.lineItems.length === 0 ? (
            <div style={{ opacity: 0.75 }}>Place panels, devices, fixtures, or conduit runs to generate a priced material takeoff.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.18)', textAlign: 'left' }}>
                  <th style={thStyle}>Category</th>
                  <th style={thStyle}>Description</th>
                  <th style={thStyle}>Qty</th>
                  <th style={thStyle}>Unit</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Unit ($)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Material ($)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Labor (hrs)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Labor ($)</th>
                </tr>
              </thead>
              <tbody>
                {takeoff.pricing.lineItems.map((item, idx) => (
                  <tr key={`${item.sku}-${idx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <td style={tdStyle}>{item.category}</td>
                    <td style={tdStyle}>{item.description}</td>
                    <td style={tdStyle}>{item.quantity}</td>
                    <td style={tdStyle}>{item.unit}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>${item.unitPriceUsd.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>${item.extendedMaterialUsd.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{item.extendedLaborHours.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>${item.extendedLaborUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

const thStyle: React.CSSProperties = { padding: '5px 6px' }
const tdStyle: React.CSSProperties = { padding: '4px 6px' }
const selectStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.06)',
  color: 'inherit',
  border: '1px solid rgba(255,255,255,0.18)',
}
