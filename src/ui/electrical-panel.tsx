/**
 * Left-rail EditorHostPanel for `krusch:electrical`.
 * Uses Pascal host CSS variables and scoped inline layout so zero global CSS leaks.
 */

import { type AnyNode, runAsSingleSceneHistoryStep } from '@pascal-app/core'
import { openEditorView, useScene, useViewer } from '@pascal-app/editor'
import { useMemo, useState } from 'react'
import { electricalAgentOperations } from '../agent-operations'
import { auditSceneElectrical } from '../nec/audit'
import type { SceneNodeLike } from '../nec/load-calc'
import { findNextFreePanelCircuit } from '../nec/panel-schedule'
import { extractTradeObstacles, routeElectricalRun, type Vec3 } from '../nec/routing'
import { useElectricalUi } from './store'

export const ELECTRICAL_SCHEDULE_VIEW_ID = 'krusch:electrical:schedule'

function activeLevelOf(nodes: Readonly<Record<string, AnyNode>>, selectedLevelId: string | null): string | null {
  if (selectedLevelId && nodes[selectedLevelId]) return selectedLevelId
  for (const n of Object.values(nodes)) {
    if (n.type === 'level') return n.id
  }
  return null
}

export default function ElectricalRailPanel() {
  const nodes = useScene((s) => s.nodes)
  const createNode = useScene((s) => s.createNode)
  const updateNode = useScene((s) => s.updateNode)
  const selectedLevelId = useViewer((s) => s.selection.levelId)
  const { occupancy, setOccupancy, setActiveTab, setSelectedPanelId } = useElectricalUi()
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
  const audit = useMemo(() => auditSceneElectrical(record), [record])
  const obstacles = useMemo(() => extractTradeObstacles(record), [record])

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
  const transformers = useMemo(
    () => Object.values(record).filter((n) => n.type === 'electrical:transformer'),
    [record],
  )

  const placeTransformer = () => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level first before placing electrical equipment.')
      return
    }
    const idx = transformers.length + 1
    const outcome = electricalAgentOperations.electrical_place_transformer(
      nodes,
      {
        levelId,
        name: `TX-${idx} (75 kVA)`,
        position: [idx * 1.4, 0, -1.2],
        kvaRating: 75,
        primaryVoltage: 480,
        secondaryVoltage: 208,
        fedFromPanelId: panels[0]?.id,
      },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create?.[0]
    if (created) {
      createNode(created.node, created.parentId as never)
      setStatusMsg(`Placed ${outcome.result.name} (480V -> 208V 3Φ).`)
    }
  }

  const placePanel = () => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level first before placing electrical equipment.')
      return
    }
    const idx = panels.length + 1
    const outcome = electricalAgentOperations.electrical_place_panel(
      nodes,
      {
        levelId,
        name: occupancy === 'commercial' ? `LP-${idx}` : `MDP-${idx}`,
        position: [idx * 1.2 - 1.2, 1.52, 0],
        occupancy,
        voltageSystem: occupancy === 'commercial' ? '120/208V-3P' : '120/240V-1P',
        busRatingAmps: occupancy === 'commercial' ? 400 : 200,
        mainBreakerAmps: occupancy === 'commercial' ? 400 : 200,
      },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create?.[0]
    if (created) {
      createNode(created.node, created.parentId as never)
      setStatusMsg(`Placed ${outcome.result.name} (${outcome.result.voltageSystem}).`)
    }
  }

  const placeDevice = (deviceKind: 'duplex' | 'gfci' | 'evse' | 'junction-box' | 'motor-load') => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level first before placing electrical equipment.')
      return
    }
    const primaryPanel = panels[0]
    const idx = devices.length + 1
    const isHeavy = deviceKind === 'evse' || deviceKind === 'motor-load'
    const poles: 1 | 2 | 3 =
      deviceKind === 'motor-load' && occupancy === 'commercial' ? 3 : isHeavy ? 2 : 1
    const nextCircuit = findNextFreePanelCircuit(primaryPanel, devices, poles)
    const outcome = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        levelId,
        name: `${deviceKind.toUpperCase()}-${idx}`,
        position: [1.5 + idx * 0.8, deviceKind === 'junction-box' ? 2.45 : 0.4, 1.5],
        deviceKind,
        occupancy,
        panelId: primaryPanel?.id,
        circuitNumber: nextCircuit,
        poles,
        breakerAmps: deviceKind === 'evse' ? 50 : deviceKind === 'motor-load' ? 30 : 20,
        loadVa: deviceKind === 'evse' ? 9600 : deviceKind === 'motor-load' ? 4800 : 180,
        continuous: deviceKind === 'evse',
        gfciProtected: deviceKind === 'gfci',
      },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create?.[0]
    if (created) {
      createNode(created.node, created.parentId as never)
      setStatusMsg(`Placed ${deviceKind} on CKT-${outcome.result.circuitNumber}.`)
    }
  }

  const autoRouteAll = () => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level first before routing circuits.')
      return
    }
    const primaryPanel = panels[0]
    if (!primaryPanel) {
      setStatusMsg('Place an electrical panel first before routing circuits.')
      return
    }
    let routedCount = 0
    let avoidedCount = 0
    let skippedCount = 0

    runAsSingleSceneHistoryStep(useScene, () => {
      // 1. Reroute any existing clashing runs around higher-priority trades
      for (const run of runs) {
        const path = Array.isArray(run.path) ? (run.path as Vec3[]) : []
        if (path.length < 2) continue
        const res = routeElectricalRun(path[0]!, path[path.length - 1]!, obstacles)
        if (res.avoidedObstacles.length > 0 || res.remainingClashes.length === 0) {
          updateNode(run.id as never, { path: res.path } as Partial<AnyNode>)
          avoidedCount += res.avoidedObstacles.length
          routedCount += 1
        }
      }

      // 2. Route any devices attached to a panel that don't have a run yet
      const routedDevices = new Set(runs.map((r) => r.targetDeviceId).filter(Boolean))
      for (const dev of devices) {
        if (routedDevices.has(dev.id)) continue
        const pid = (typeof dev.panelId === 'string' && dev.panelId) || primaryPanel.id
        try {
          const liveNodes = useScene.getState().nodes
          const outcome = electricalAgentOperations.electrical_route_circuit(
            liveNodes,
            { panelId: pid, targetDeviceId: dev.id, occupancy },
            { activeLevelId: levelId },
          )
          const created = outcome.changes?.create?.[0]
          if (created) {
            createNode(created.node, created.parentId as never)
            routedDevices.add(dev.id)
            routedCount += 1
            avoidedCount += (outcome.result.avoidedObstacles as unknown[]).length
          }
        } catch (err) {
          skippedCount += 1
          console.warn(`[pascal-plugin-electrical] Skipped routing device "${dev.id}":`, err)
        }
      }
    })

    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped)` : ''
    setStatusMsg(
      routedCount > 0
        ? `Routed ${routedCount} run(s); yielded around ${avoidedCount} plumbing/HVAC/structural obstacle(s)${skippedSuffix}.`
        : skippedCount > 0
          ? `No circuits routed (${skippedCount} device(s) skipped due to missing panel reference).`
          : 'All assigned devices are already routed.',
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        fontSize: 12,
        color: 'var(--foreground, #e5e7eb)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>Electrical (NEC)</strong>
        <span
          style={{
            padding: '2px 7px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            background: audit.passed ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.2)',
            color: audit.passed ? '#34d399' : '#f87171',
          }}
        >
          {audit.passed ? 'NEC PASS' : `${audit.errorCount} ERR / ${audit.warningCount} WARN`}
        </span>
      </div>

      {/* Residential / Commercial Mode Toggle */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {(['residential', 'commercial'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setOccupancy(mode)}
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border, rgba(255,255,255,0.14))',
              background: occupancy === mode ? 'rgba(245,158,11,0.2)' : 'transparent',
              color: 'inherit',
              fontWeight: occupancy === mode ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {mode}
          </button>
        ))}
      </div>

      {/* Placement Palette */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, opacity: 0.7 }}>Place Electrical Equipment</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button type="button" onClick={placePanel} style={btnStyle}>
            + Panelboard
          </button>
          <button type="button" onClick={() => placeDevice('duplex')} style={btnStyle}>
            + Receptacle
          </button>
          <button type="button" onClick={() => placeDevice('gfci')} style={btnStyle}>
            + GFCI Outlet
          </button>
          <button
            type="button"
            onClick={() => placeDevice(occupancy === 'commercial' ? 'motor-load' : 'evse')}
            style={btnStyle}
          >
            {occupancy === 'commercial' ? '+ 3Φ Motor Load' : '+ EVSE / 240V'}
          </button>
          <button type="button" onClick={() => placeDevice('junction-box')} style={btnStyle}>
            + Pull / J-Box
          </button>
          {occupancy === 'commercial' && (
            <button type="button" onClick={placeTransformer} style={btnStyle}>
              + Transformer
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setActiveTab('schedule')
              openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
            }}
            style={{
              ...btnStyle,
              borderColor: 'rgba(245,158,11,0.5)',
            }}
          >
            Open Schedule
          </button>
          <button
            type="button"
            onClick={() => {
              if (panels[0]) setSelectedPanelId(panels[0].id)
              setActiveTab('panel-interior')
              openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
            }}
            style={{
              ...btnStyle,
              borderColor: 'rgba(56,189,248,0.55)',
              background: 'rgba(56,189,248,0.14)',
              gridColumn: occupancy === 'commercial' ? '1 / -1' : '1 / -1',
              fontWeight: 600,
            }}
          >
            Inspect Panel Wiring (3D Cover Off)
          </button>
        </div>
      </div>

      {/* Trade-Priority Routing Action */}
      <div
        style={{
          padding: 10,
          borderRadius: 8,
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ fontWeight: 600 }}>Trade-Priority Routing</div>
        <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.4 }}>
          Electrical yields to Structural ({obstacles.filter((o) => o.trade === 'structural').length}),
          Plumbing ({obstacles.filter((o) => o.trade === 'plumbing').length}), and HVAC (
          {obstacles.filter((o) => o.trade === 'hvac').length}) obstacles in this scene.
        </div>
        <button
          type="button"
          onClick={autoRouteAll}
          style={{
            ...btnStyle,
            background: 'rgba(56,189,248,0.18)',
            borderColor: 'rgba(56,189,248,0.45)',
            fontWeight: 600,
          }}
        >
          Auto-Route Around Trades
        </button>
      </div>

      {/* Live Scene Counters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, textAlign: 'center' }}>
        <StatCard label="Panels" value={panels.length} />
        <StatCard label="Devices" value={devices.length} />
        <StatCard label="Runs" value={runs.length} />
      </div>

      {statusMsg && (
        <div style={{ fontSize: 11, opacity: 0.85, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.06)' }}>
          {statusMsg}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: 6,
        borderRadius: 6,
        border: '1px solid var(--border, rgba(255,255,255,0.12))',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>{label}</div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border, rgba(255,255,255,0.14))',
  background: 'rgba(255,255,255,0.04)',
  color: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  textAlign: 'center',
}
