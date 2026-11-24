/**
 * Left-rail EditorHostPanel for `krusch:electrical`.
 * Uses Pascal host CSS variables and scoped inline layout so zero global CSS leaks.
 */

import { type AnyNode, runAsSingleSceneHistoryStep } from '@pascal-app/core'
import { openEditorView, useScene, useViewer } from '@pascal-app/editor'
import { useMemo, useState } from 'react'
import { electricalAgentOperations } from '../agent-operations'
import { circuitRunColor } from '../cad/materials'
import { auditSceneElectrical } from '../nec/audit'
import { findNextWallPlacement, type ProtectionMode } from '../nec/autopopulate'
import { extractBonesFramingContext } from '../nec/framing-interop'
import type { SceneNodeLike } from '../nec/load-calc'
import {
  detectRunTradeClashes,
  extractRoutingWalls,
  extractTradeObstacles,
  resolveLevelHeightM,
  routeElectricalRun,
  type Vec3,
} from '../nec/routing'
import { useElectricalUi } from './store'

export const ELECTRICAL_SCHEDULE_VIEW_ID = 'krusch:electrical:schedule'

function activeLevelOf(nodes: Readonly<Record<string, AnyNode>>, selectedLevelId: string | null): string | null {
  if (selectedLevelId && nodes[selectedLevelId]) return selectedLevelId
  for (const n of Object.values(nodes)) {
    if (n.type === 'level') return n.id
  }
  return null
}

function belongsToLevel(
  record: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
  levelId: string | null,
): boolean {
  if (!levelId) return true
  let cur: SceneNodeLike | undefined = node
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.id === levelId || cur.parentId === levelId) return true
    cur = cur.parentId ? record[cur.parentId] : undefined
  }
  return node.parentId == null
}

function pathsNearlyEqual(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!
    const q = b[i]!
    if (Math.abs(p[0] - q[0]) > 0.005 || Math.abs(p[1] - q[1]) > 0.005 || Math.abs(p[2] - q[2]) > 0.005) {
      return false
    }
  }
  return true
}

type CatalogQuickItem = {
  kind:
    | 'solar-inverter'
    | 'battery-ess'
    | 'transfer-switch'
    | 'generator-inlet'
    | 'rapid-shutdown'
    | 'spd'
    | 'vfd'
    | 'dimmer'
    | 'usb-duplex'
    | 'weatherproof-gfci'
    | 'floor-box'
    | 'smoke-co'
    | 'ceiling-fan'
    | 'under-cabinet-led'
  label: string
  poles: 1 | 2 | 3
  breakerAmps: number
  loadVa: number
  continuous?: boolean
  gfciProtected?: boolean
}

const CATALOG_QUICK_ITEMS: readonly CatalogQuickItem[] = [
  { kind: 'solar-inverter', label: 'Solar PV Inverter (NEC 690, 40A)', poles: 2, breakerAmps: 40, loadVa: 7600, continuous: true },
  { kind: 'battery-ess', label: 'Wall Battery ESS 13.5 kWh (60A)', poles: 2, breakerAmps: 60, loadVa: 11500, continuous: true },
  { kind: 'transfer-switch', label: '200A Auto Transfer Switch (ATS)', poles: 2, breakerAmps: 200, loadVa: 0 },
  { kind: 'generator-inlet', label: '50A Generator Inlet Box (SS2-50P)', poles: 2, breakerAmps: 50, loadVa: 12000 },
  { kind: 'rapid-shutdown', label: 'PV Rapid Shutdown Switch (690.12)', poles: 2, breakerAmps: 40, loadVa: 0 },
  { kind: 'spd', label: 'Type 2 Surge Protector (NEC 230.67)', poles: 2, breakerAmps: 20, loadVa: 0 },
  { kind: 'vfd', label: 'Commercial 3Φ VFD Drive (40A)', poles: 3, breakerAmps: 40, loadVa: 12000, continuous: true },
  { kind: 'dimmer', label: 'Smart Decora Slide Dimmer', poles: 1, breakerAmps: 15, loadVa: 150 },
  { kind: 'usb-duplex', label: '20A USB-A / USB-C Duplex Outlet', poles: 1, breakerAmps: 20, loadVa: 180 },
  { kind: 'weatherproof-gfci', label: 'Weatherproof In-Use Bubble GFCI', poles: 1, breakerAmps: 20, loadVa: 180, gfciProtected: true },
  { kind: 'floor-box', label: 'Recessed Brass Floor Outlet Box', poles: 1, breakerAmps: 20, loadVa: 180 },
  { kind: 'smoke-co', label: 'Hardwired 120V Smoke/CO Alarm', poles: 1, breakerAmps: 15, loadVa: 25 },
  { kind: 'ceiling-fan', label: '52" Ceiling Fan w/ LED Kit', poles: 1, breakerAmps: 15, loadVa: 120 },
  { kind: 'under-cabinet-led', label: '24" Under-Cabinet LED Task Bar', poles: 1, breakerAmps: 15, loadVa: 30 },
]

export default function ElectricalRailPanel() {
  const nodes = useScene((s) => s.nodes)
  const createNode = useScene((s) => s.createNode)
  const updateNode = useScene((s) => s.updateNode)
  const selectedLevelId = useViewer((s) => s.selection.levelId)
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const wallMode = useViewer((s) => s.wallMode)
  const setWallMode = useViewer((s) => s.setWallMode)
  const xrayFamily = useViewer((s) => s.xrayFamily)
  const setXrayFamily = useViewer((s) => s.setXrayFamily)
  const { occupancy, setOccupancy, setActiveTab, setSelectedPanelId } = useElectricalUi()
  const [protectionMode, setProtectionMode] = useState<ProtectionMode>('hybrid')
  const [catalogKind, setCatalogKind] = useState<CatalogQuickItem['kind']>('solar-inverter')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
  const activeLevelId = useMemo(() => activeLevelOf(nodes, selectedLevelId), [nodes, selectedLevelId])
  const audit = useMemo(() => auditSceneElectrical(record), [record])
  const obstacles = useMemo(
    () => extractTradeObstacles(record, activeLevelId),
    [record, activeLevelId],
  )
  const bonesCtx = useMemo(
    () => extractBonesFramingContext(record, activeLevelId),
    [record, activeLevelId],
  )

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

  const placeDevice = (
    deviceKind:
      | 'duplex'
      | 'gfci'
      | 'evse'
      | 'junction-box'
      | 'motor-load'
      | CatalogQuickItem['kind'],
  ) => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level first before placing electrical equipment.')
      return
    }
    const primaryPanel = panels[0]
    const idx = devices.length + 1
    const catalogSpec = CATALOG_QUICK_ITEMS.find((item) => item.kind === deviceKind)
    const isHeavy = deviceKind === 'evse' || deviceKind === 'motor-load'
    const poles: 1 | 2 | 3 = catalogSpec
      ? catalogSpec.poles
      : deviceKind === 'motor-load' && occupancy === 'commercial'
        ? 3
        : isHeavy
          ? 2
          : 1
    const selectedZoneId =
      selectedIds.find((sid) => record[sid]?.type === 'zone') ?? null
    const placement = findNextWallPlacement(record, levelId, {
      deviceKind,
      preferredZoneId: selectedZoneId,
    })

    const outcome = electricalAgentOperations.electrical_place_device(
      nodes,
      {
        levelId,
        name: `${deviceKind.toUpperCase()}-${idx}`,
        position: [...placement.position] as [number, number, number],
        rotation: placement.rotation,
        deviceKind,
        occupancy,
        panelId: primaryPanel?.id,
        poles,
        breakerAmps: catalogSpec
          ? catalogSpec.breakerAmps
          : deviceKind === 'evse'
            ? 50
            : deviceKind === 'motor-load'
              ? 30
              : deviceKind === 'gfci'
                ? 20
                : occupancy === 'commercial'
                  ? 20
                  : 15,
        loadVa: catalogSpec
          ? catalogSpec.loadVa
          : deviceKind === 'evse'
            ? 9600
            : deviceKind === 'motor-load'
              ? 4800
              : 180,
        continuous: catalogSpec ? Boolean(catalogSpec.continuous) : deviceKind === 'evse',
        gfciProtected: catalogSpec ? Boolean(catalogSpec.gfciProtected) : deviceKind === 'gfci',
        autoWire: true,
      },
      { activeLevelId: levelId },
    )
    const createdList = outcome.changes?.create ?? []
    const updateList = outcome.changes?.update ?? []
    if (createdList.length > 0) {
      runAsSingleSceneHistoryStep(useScene, () => {
        for (const item of createdList) {
          createNode(item.node, item.parentId as never)
        }
        for (const upd of updateList) {
          updateNode(upd.id as never, upd.data as Partial<AnyNode>)
        }
      })
      const roomLabel = outcome.result.roomName ? ` in ${outcome.result.roomName}` : ''
      if (outcome.result.connectionMode === 'joined-existing-run') {
        setStatusMsg(
          `Placed ${deviceKind}${roomLabel} on existing CKT-${outcome.result.circuitNumber} (added wall-following run from ${outcome.result.connectedFromName}).`,
        )
      } else if (outcome.result.connectionMode === 'new-home-run') {
        setStatusMsg(
          `Placed ${deviceKind}${roomLabel} on new CKT-${outcome.result.circuitNumber} (created wall-following home run from ${outcome.result.connectedFromName}).`,
        )
      } else {
        setStatusMsg(`Placed ${deviceKind}${roomLabel} (place a panel to auto-wire runs).`)
      }
    }
  }

  const autoPopulateNec = () => {
    const levelId = activeLevelOf(nodes, selectedLevelId)
    if (!levelId) {
      setStatusMsg('Create a building level with walls/rooms first before auto-populating NEC electrical.')
      return
    }
    const outcome = electricalAgentOperations.electrical_autopopulate_nec(
      nodes,
      {
        levelId,
        occupancy,
        protectionMode,
        includeLighting: true,
        includeWiring: true,
      },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create ?? []
    if (created.length === 0) {
      setStatusMsg('No additional NEC minimum outlets or circuits needed for the current walls/zones.')
      return
    }
    runAsSingleSceneHistoryStep(useScene, () => {
      for (const item of created) {
        createNode(item.node, item.parentId as never)
      }
    })
    setStatusMsg(
      `NEC Auto-Populated ${outcome.result.devicesPlanned} devices across ${outcome.result.circuitsCreated} circuits (${outcome.result.homeRunsPlanned} home runs + ${outcome.result.daisyChainRunsPlanned} outlet-to-outlet runs).`,
    )
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
      const levelObstacles = extractTradeObstacles(record, levelId)
      const walls = extractRoutingWalls(record, levelId)
      const levelHeight = resolveLevelHeightM(record, levelId)
      const defaultChaseY = Math.round(Math.min(2.55, levelHeight - 0.06) * 1000) / 1000
      const levelRuns = runs.filter((r) => belongsToLevel(record, r, levelId))
      const levelDevices = devices.filter((d) => belongsToLevel(record, d, levelId))
      // 1. Reroute existing runs on this level only when they clash or improve onto walls
      for (const run of levelRuns) {
        const path = Array.isArray(run.path) ? (run.path as Vec3[]) : []
        if (path.length < 2) continue
        const existingClashes = detectRunTradeClashes(path, levelObstacles)
        const res = routeElectricalRun(path[0]!, path[path.length - 1]!, levelObstacles, {
          preferredChaseY: defaultChaseY,
          walls,
        })
        const pathChanged = !pathsNearlyEqual(path, res.path)
        const improvesClashes = existingClashes.length > 0 && res.remainingClashes.length < existingClashes.length
        if ((improvesClashes || (pathChanged && res.remainingClashes.length <= existingClashes.length))) {
          const prevMeta =
            run.metadata && typeof run.metadata === 'object'
              ? (run.metadata as Record<string, unknown>)
              : {}
          updateNode(run.id as never, {
            path: res.path,
            metadata: {
              ...prevMeta,
              avoidedObstaclesCount: res.avoidedObstacles.length,
            },
          } as Partial<AnyNode>)
          avoidedCount += res.avoidedObstacles.length
          routedCount += 1
        }
      }

      // 2. Route any devices on this level attached to a panel that don't have a run yet
      const routedDevices = new Set(runs.map((r) => r.targetDeviceId).filter(Boolean))
      for (const dev of levelDevices) {
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
        <button
          type="button"
          onClick={() => {
            setActiveTab('audit')
            openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
          }}
          title="Open full NEC Compliance Audit"
          style={{
            padding: '2px 7px',
            borderRadius: 999,
            border: 'none',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: audit.passed ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.2)',
            color: audit.passed ? '#34d399' : '#f87171',
          }}
        >
          {audit.passed ? 'NEC PASS' : `${audit.errorCount} ERR / ${audit.warningCount} WARN`}
        </button>
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
              gridColumn: '1 / -1',
              fontWeight: 600,
            }}
          >
            Inspect Panel Wiring (3D Cover Off)
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <select
            aria-label="Catalog Equipment Model"
            value={catalogKind}
            onChange={(e) => setCatalogKind(e.target.value as CatalogQuickItem['kind'])}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '5px 7px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.06)',
              color: 'inherit',
              border: '1px solid var(--border, rgba(255,255,255,0.18))',
              fontSize: 11,
            }}
          >
            {CATALOG_QUICK_ITEMS.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => placeDevice(catalogKind)}
            style={{
              ...btnStyle,
              padding: '5px 10px',
              whiteSpace: 'nowrap',
              borderColor: 'rgba(16,185,129,0.5)',
              background: 'rgba(16,185,129,0.15)',
              fontWeight: 600,
            }}
          >
            + Place
          </button>
        </div>
      </div>

      {/* One-Click NEC Minimum Auto-Populate (Outlets, GFCIs, Stairway/Door/Outdoor, Circuits, Home Runs & Daisy Chains) */}
      <div
        style={{
          padding: 10,
          borderRadius: 8,
          border: '1px solid rgba(245,158,11,0.35)',
          background: 'rgba(245,158,11,0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ fontWeight: 600 }}>NEC Minimum Auto-Populate</div>
        <div style={{ fontSize: 11, opacity: 0.78, lineHeight: 1.35 }}>
          Places 6ft/12ft wall outlets, 2x20A kitchen GFCIs, bath/garage/outdoor WR GFCIs, front-door &amp; stairway 3-way lights/outlets, balanced circuits, home runs &amp; daisy-chain runs.
        </div>
        <select
          value={protectionMode}
          onChange={(e) => setProtectionMode(e.target.value as ProtectionMode)}
          style={{
            padding: '5px 7px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.06)',
            color: 'inherit',
            border: '1px solid var(--border, rgba(255,255,255,0.18))',
            fontSize: 11,
          }}
        >
          <option value="hybrid">Hybrid: GFCI Outlets + AFCI Breakers</option>
          <option value="gfci-breakers">Panel Breakers: GFCI / AFCI Breakers</option>
          <option value="gfci-receptacles">Point-of-Use: GFCI Outlets Everywhere</option>
        </select>
        <button
          type="button"
          onClick={autoPopulateNec}
          style={{
            ...btnStyle,
            background: 'rgba(245,158,11,0.22)',
            borderColor: 'rgba(245,158,11,0.55)',
            fontWeight: 600,
          }}
        >
          Auto-Populate NEC Layout &amp; Wiring
        </button>
      </div>

      {/* Native Pascal useViewer In-Wall Inspection Controls */}
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
        <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>In-Wall Wiring View</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 999,
              background: bonesCtx.present ? 'rgba(16,185,129,0.18)' : 'rgba(148,163,184,0.14)',
              color: bonesCtx.present ? '#34d399' : '#94a3b8',
            }}
          >
            {bonesCtx.present
              ? `Bones ${bonesCtx.defaultSpacingIn}" OC`
              : `${bonesCtx.defaultSpacingIn}" OC Stud-Snap`}
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.35 }}>
          Cables route concealed inside wall cavities. Use Pascal&apos;s native viewer modes to inspect in-wall runs:
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              setXrayFamily(null)
              setWallMode('up')
            }}
            style={{
              ...btnStyle,
              background: xrayFamily === null && wallMode === 'up' ? 'rgba(245,158,11,0.2)' : 'transparent',
              borderColor:
                xrayFamily === null && wallMode === 'up'
                  ? 'rgba(245,158,11,0.5)'
                  : 'var(--border, rgba(255,255,255,0.16))',
              fontWeight: xrayFamily === null && wallMode === 'up' ? 600 : 400,
            }}
          >
            Full Walls
          </button>
          <button
            type="button"
            onClick={() => {
              setXrayFamily(null)
              setWallMode('cutaway')
            }}
            style={{
              ...btnStyle,
              background: xrayFamily === null && wallMode === 'cutaway' ? 'rgba(56,189,248,0.2)' : 'transparent',
              borderColor:
                xrayFamily === null && wallMode === 'cutaway'
                  ? 'rgba(56,189,248,0.55)'
                  : 'var(--border, rgba(255,255,255,0.16))',
              fontWeight: xrayFamily === null && wallMode === 'cutaway' ? 600 : 400,
            }}
          >
            Cutaway
          </button>
          <button
            type="button"
            onClick={() => {
              setXrayFamily(null)
              setWallMode('down')
            }}
            style={{
              ...btnStyle,
              background: xrayFamily === null && wallMode === 'down' ? 'rgba(56,189,248,0.2)' : 'transparent',
              borderColor:
                xrayFamily === null && wallMode === 'down'
                  ? 'rgba(56,189,248,0.55)'
                  : 'var(--border, rgba(255,255,255,0.16))',
              fontWeight: xrayFamily === null && wallMode === 'down' ? 600 : 400,
            }}
          >
            Low Walls
          </button>
          <button
            type="button"
            onClick={() => setXrayFamily(xrayFamily === 'other' ? null : 'other')}
            style={{
              ...btnStyle,
              background: xrayFamily === 'other' ? 'rgba(16,185,129,0.22)' : 'transparent',
              borderColor:
                xrayFamily === 'other'
                  ? 'rgba(16,185,129,0.55)'
                  : 'var(--border, rgba(255,255,255,0.16))',
              fontWeight: xrayFamily === 'other' ? 600 : 400,
            }}
          >
            X-Ray Wiring
          </button>
        </div>
        {runs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
            {Array.from(
              new Set(
                runs
                  .map((r) => Number((r as Record<string, unknown>).circuitNumber ?? 1))
                  .filter((n) => Number.isFinite(n) && n > 0),
              ),
            )
              .sort((a, b) => a - b)
              .map((ckt) => {
                const c = circuitRunColor(ckt)
                return (
                  <span
                    key={ckt}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.06)',
                      border: `1px solid ${c.hex}66`,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: c.hex,
                        display: 'inline-block',
                      }}
                    />
                    CKT-{ckt}
                  </span>
                )
              })}
          </div>
        )}
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

      {/* Live NEC Code Violations (clickable to jump to offending node in 3D viewport) */}
      {audit.findings.length > 0 && (
        <div
          style={{
            padding: 9,
            borderRadius: 8,
            border: `1px solid ${audit.errorCount > 0 ? 'rgba(239,68,68,0.48)' : 'rgba(245,158,11,0.45)'}`,
            background: audit.errorCount > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              style={{
                fontWeight: 700,
                fontSize: 11,
                color: audit.errorCount > 0 ? '#f87171' : '#fbbf24',
              }}
            >
              Live NEC Flags ({audit.findings.length})
            </span>
            <button
              type="button"
              onClick={() => {
                setActiveTab('audit')
                openEditorView(ELECTRICAL_SCHEDULE_VIEW_ID, { beside: true })
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#38bdf8',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              View All in NEC Audit
            </button>
          </div>
          {audit.findings.slice(0, 4).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                if (f.nodeIds.length > 0) {
                  useViewer.getState().setSelection({ selectedIds: f.nodeIds.slice(0, 1) as never })
                }
              }}
              title={f.suggestedFix ? `${f.message} Fix: ${f.suggestedFix}` : f.message}
              style={{
                textAlign: 'left',
                padding: '5px 7px',
                borderRadius: 6,
                border: `1px solid ${f.severity === 'error' ? 'rgba(239,68,68,0.35)' : 'rgba(245,158,11,0.3)'}`,
                background: 'rgba(15,23,42,0.45)',
                color: 'inherit',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: f.severity === 'error' ? '#fca5a5' : '#fde68a',
                }}
              >
                [{f.codeRef}] {f.title}
              </span>
              {f.suggestedFix && (
                <span style={{ fontSize: 10, opacity: 0.78 }}>{f.suggestedFix}</span>
              )}
            </button>
          ))}
        </div>
      )}

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
