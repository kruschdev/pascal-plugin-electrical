/**
 * Interactive Zoomed-In 3D Panel Interior Viewer (`PanelInteriorView`).
 * Lets users inspect the cover-off electrical panelboard, exposed copper busbars,
 * main & branch circuit breakers, neutral/ground bars, and EVERY individual wire
 * routed through the gutters into its exact terminal lug.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Material,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import {
  buildWiredPanelInteriorCad,
  type PanelInteriorViewMode,
  type PanelWireMetadata,
} from '../cad/panel-interior'
import type { PanelSchedule } from '../nec/panel-schedule'

type CameraPreset = 'full' | 'breakers' | 'main-bus' | 'left-gutter' | 'right-gutter'

const PRESET_VIEWS: Record<
  CameraPreset,
  { label: string; theta: number; phi: number; distFactor: number; targetYRatio: number; targetXRatio: number }
> = {
  full: { label: 'Full Open Panel', theta: 0.18, phi: 0.06, distFactor: 1.42, targetYRatio: 0.0, targetXRatio: 0 },
  breakers: { label: 'Zoom: Breakers & Lugs', theta: 0.24, phi: 0.04, distFactor: 0.72, targetYRatio: -0.06, targetXRatio: 0 },
  'main-bus': { label: 'Zoom: Main & Busbars', theta: -0.2, phi: 0.14, distFactor: 0.68, targetYRatio: 0.26, targetXRatio: 0 },
  'left-gutter': { label: 'Zoom: Left Gutter', theta: -0.58, phi: 0.04, distFactor: 0.68, targetYRatio: -0.04, targetXRatio: -0.26 },
  'right-gutter': { label: 'Zoom: Right Gutter', theta: 0.58, phi: 0.04, distFactor: 0.68, targetYRatio: -0.04, targetXRatio: 0.26 },
}

function disposeObjectTree(root: Object3D): void {
  const geometries = new Set<{ dispose: () => void }>()
  const materials = new Set<Material>()
  root.traverse((obj) => {
    const mesh = obj as { geometry?: { dispose?: () => void }; material?: Material | Material[] }
    if (mesh.geometry && typeof mesh.geometry.dispose === 'function') {
      geometries.add(mesh.geometry as { dispose: () => void })
    }
    if (Array.isArray(mesh.material)) {
      for (const m of mesh.material) materials.add(m)
    } else if (mesh.material) {
      materials.add(mesh.material)
    }
  })
  for (const g of geometries) g.dispose()
  for (const m of materials) m.dispose()
}

type ViewerRuntime = {
  scene: Scene
  camera: PerspectiveCamera
  renderer: WebGLRenderer
  holder: Group
  renderFrame: () => void
}

export default function PanelInteriorView({
  schedule,
  nemaRating,
  onSelectDeviceIds,
}: {
  schedule: PanelSchedule
  nemaRating?: 'NEMA-1' | 'NEMA-3R' | 'NEMA-4X'
  onSelectDeviceIds?: (ids: string[]) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<ViewerRuntime | null>(null)
  const boundsRef = useRef({
    size: new Vector3(0.45, 0.92, 0.15),
    center: new Vector3(0, 0, 0),
    maxDim: 0.92,
    populatedCenterY: null as number | null,
  })

  const [viewMode, setViewMode] = useState<PanelInteriorViewMode>('cover-off')
  const [preset, setPreset] = useState<CameraPreset>('breakers')
  const [presetTick, setPresetTick] = useState(0)
  const [showHots, setShowHots] = useState(true)
  const [showNeutrals, setShowNeutrals] = useState(true)
  const [showGrounds, setShowGrounds] = useState(true)
  const [showFeeders, setShowFeeders] = useState(true)
  const [selectedCircuit, setSelectedCircuit] = useState<number | null>(null)
  const [pickedMeta, setPickedMeta] = useState<PanelWireMetadata | null>(null)

  const orbitRef = useRef({
    theta: PRESET_VIEWS.breakers.theta,
    phi: PRESET_VIEWS.breakers.phi,
    dist: 0.72,
    target: new Vector3(0, -0.05, 0.02),
    dragging: false,
    lastX: 0,
    lastY: 0,
    moved: false,
  })

  // Reset picked circuit metadata when user switches panels
  useEffect(() => {
    setSelectedCircuit(null)
    setPickedMeta(null)
  }, [schedule.panelId])

  // 1. Mount-only WebGLRenderer + ResizeObserver + Orbit/Raycaster lifecycle (zero context thrashing)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = Math.max(320, container.clientWidth || 680)
    const height = Math.max(360, container.clientHeight || 480)

    const scene = new Scene()
    scene.background = new Color(0x0b1220)
    scene.add(new HemisphereLight(0xf8fafc, 0x334155, 1.35))
    scene.add(new AmbientLight(0xffffff, 0.35))
    const keyLight = new DirectionalLight(0xffffff, 1.75)
    keyLight.position.set(1.6, 2.2, 2.8)
    scene.add(keyLight)
    const fillLight = new DirectionalLight(0x93c5fd, 0.75)
    fillLight.position.set(-2.0, 0.6, 1.8)
    scene.add(fillLight)

    const holder = new Group()
    holder.name = 'panel-interior-holder'
    scene.add(holder)

    const camera = new PerspectiveCamera(38, width / height, 0.01, 20)
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    const renderFrame = () => {
      const o = orbitRef.current
      const cosPhi = Math.cos(o.phi)
      camera.position.set(
        o.target.x + o.dist * Math.sin(o.theta) * cosPhi,
        o.target.y + o.dist * Math.sin(o.phi),
        o.target.z + o.dist * Math.cos(o.theta) * cosPhi,
      )
      camera.lookAt(o.target)
      renderer.render(scene, camera)
    }

    runtimeRef.current = { scene, camera, renderer, holder, renderFrame }

    const raycaster = new Raycaster()
    const pointer = new Vector2()

    const onPointerDown = (e: PointerEvent) => {
      orbitRef.current.dragging = true
      orbitRef.current.moved = false
      orbitRef.current.lastX = e.clientX
      orbitRef.current.lastY = e.clientY
      renderer.domElement.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!orbitRef.current.dragging) return
      const dx = e.clientX - orbitRef.current.lastX
      const dy = e.clientY - orbitRef.current.lastY
      if (Math.abs(dx) + Math.abs(dy) > 2) orbitRef.current.moved = true
      orbitRef.current.lastX = e.clientX
      orbitRef.current.lastY = e.clientY
      orbitRef.current.theta = Math.max(-1.4, Math.min(1.4, orbitRef.current.theta - dx * 0.007))
      orbitRef.current.phi = Math.max(-0.9, Math.min(0.9, orbitRef.current.phi + dy * 0.007))
      renderFrame()
    }

    const onPointerCancel = (e: PointerEvent) => {
      orbitRef.current.dragging = false
      orbitRef.current.moved = false
      if (renderer.domElement.hasPointerCapture(e.pointerId)) {
        renderer.domElement.releasePointerCapture(e.pointerId)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const wasClick = !orbitRef.current.moved
      orbitRef.current.dragging = false
      if (renderer.domElement.hasPointerCapture(e.pointerId)) {
        renderer.domElement.releasePointerCapture(e.pointerId)
      }
      if (!wasClick) return

      const rect = renderer.domElement.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(holder.children, true)
      const firstOpaqueHit = hits.find((h) => {
        const mat = (h.object as { material?: Material | Material[] }).material
        if (!mat) return true
        const mats = Array.isArray(mat) ? mat : [mat]
        return mats.some((m) => !m.transparent || m.opacity >= 0.95)
      })
      const meta = firstOpaqueHit?.object.userData as Partial<PanelWireMetadata> | undefined
      if (meta?.kind) {
        setPickedMeta(meta as PanelWireMetadata)
        setSelectedCircuit(typeof meta.circuitNumber === 'number' ? meta.circuitNumber : null)
      } else {
        setPickedMeta(null)
        setSelectedCircuit(null)
      }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1.1 : 0.91
      orbitRef.current.dist = Math.max(0.22, Math.min(3.0, orbitRef.current.dist * factor))
      renderFrame()
    }

    const syncSize = () => {
      const wNew = Math.max(320, container.clientWidth || 680)
      const hNew = Math.max(360, container.clientHeight || 480)
      camera.aspect = wNew / hNew
      camera.updateProjectionMatrix()
      renderer.setSize(wNew, hNew)
      renderFrame()
    }

    const el = renderer.domElement
    el.style.cursor = 'grab'
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('wheel', onWheel, { passive: false })

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(syncSize)
      ro.observe(container)
    }
    window.addEventListener('resize', syncSize)

    return () => {
      runtimeRef.current = null
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', syncSize)
      ro?.disconnect()
      disposeObjectTree(holder)
      holder.clear()
      renderer.dispose()
    }
  }, [])

  // 2. Rebuild ONLY the panel CAD group when schedule, layers, cover mode, or selection changes (preserves camera!)
  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt) return

    disposeObjectTree(rt.holder)
    rt.holder.clear()

    const panelGroup = buildWiredPanelInteriorCad({
      schedule,
      nemaRating,
      viewMode,
      wires: { showHots, showNeutrals, showGrounds, showFeeders },
      highlightCircuit: selectedCircuit,
    })
    rt.holder.add(panelGroup)

    const box = new Box3().setFromObject(panelGroup)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)

    // Compute vertical centroid of actually populated breakers so "Zoom: Breakers & Lugs" frames them cleanly even on tall 42-space panels
    const populatedBox = new Box3()
    let hasPopulatedBreaker = false
    panelGroup.traverse((obj) => {
      const meta = obj.userData as Partial<PanelWireMetadata> | undefined
      if (meta?.kind === 'breaker') {
        populatedBox.expandByObject(obj)
        hasPopulatedBreaker = true
      }
    })
    const populatedCenterY = hasPopulatedBreaker
      ? (populatedBox.min.y + populatedBox.max.y) / 2
      : null

    boundsRef.current = {
      size,
      center,
      maxDim: Math.max(size.x, size.y, size.z, 0.5),
      populatedCenterY,
    }

    rt.renderFrame()
  }, [schedule, nemaRating, viewMode, showHots, showNeutrals, showGrounds, showFeeders, selectedCircuit])

  // 3. Apply camera preset ONLY when preset button is clicked or user switches to a different panel
  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt) return
    const { size, center, maxDim, populatedCenterY } = boundsRef.current
    const pConf = PRESET_VIEWS[preset]
    orbitRef.current.theta = pConf.theta
    orbitRef.current.phi = pConf.phi
    orbitRef.current.dist = maxDim * pConf.distFactor
    const usePopulatedY =
      populatedCenterY !== null &&
      (preset === 'breakers' || preset === 'left-gutter' || preset === 'right-gutter')
    orbitRef.current.target.set(
      center.x + size.x * pConf.targetXRatio,
      usePopulatedY ? populatedCenterY : center.y + size.y * pConf.targetYRatio,
      center.z + 0.02,
    )
    rt.renderFrame()
  }, [preset, presetTick, schedule.panelId, schedule.usedSpaces])

  const phaseLegend =
    schedule.voltageSystem === '277/480V-3P'
      ? [
          { label: 'Phase A', color: '#78350f' },
          { label: 'Phase B', color: '#ea580c' },
          { label: 'Phase C', color: '#eab308' },
          { label: 'Neutral', color: '#94a3b8' },
          { label: 'Ground', color: '#16a34a' },
        ]
      : schedule.voltageSystem === '120/208V-3P'
        ? [
            { label: 'Phase A', color: '#18181b' },
            { label: 'Phase B', color: '#dc2626' },
            { label: 'Phase C', color: '#2563eb' },
            { label: 'Neutral', color: '#f8fafc' },
            { label: 'Ground', color: '#16a34a' },
          ]
        : [
            { label: 'Leg L1', color: '#18181b' },
            { label: 'Leg L2', color: '#dc2626' },
            { label: 'Neutral', color: '#f8fafc' },
            { label: 'Ground (Cu)', color: '#c87533' },
          ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Top Toolbar: Cover Mode + Camera Zoom Presets */}
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {(
            [
              ['cover-off', 'Cover Off (Wired)'],
              ['panel-cover-on', 'Panel Cover On'],
              ['closed', 'Cover Closed'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              style={pillBtn(viewMode === mode, 'rgba(245,158,11,0.25)')}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {(Object.keys(PRESET_VIEWS) as CameraPreset[]).map((pKey) => (
            <button
              key={pKey}
              type="button"
              onClick={() => {
                setPreset(pKey)
                setPresetTick((t) => t + 1)
              }}
              style={pillBtn(preset === pKey, 'rgba(56,189,248,0.22)')}
            >
              {PRESET_VIEWS[pKey].label}
            </button>
          ))}
        </div>
      </div>

      {/* Conductor Layer Visibility + NEC Phase Color Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 11 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={chkStyle}>
            <input type="checkbox" checked={showHots} onChange={(e) => setShowHots(e.target.checked)} />
            Hots
          </label>
          <label style={chkStyle}>
            <input type="checkbox" checked={showNeutrals} onChange={(e) => setShowNeutrals(e.target.checked)} />
            Neutrals
          </label>
          <label style={chkStyle}>
            <input type="checkbox" checked={showGrounds} onChange={(e) => setShowGrounds(e.target.checked)} />
            Grounds
          </label>
          <label style={chkStyle}>
            <input type="checkbox" checked={showFeeders} onChange={(e) => setShowFeeders(e.target.checked)} />
            Service Feeders
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {phaseLegend.map((item) => (
            <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 99,
                  background: item.color,
                  border: '1px solid rgba(255,255,255,0.45)',
                  display: 'inline-block',
                }}
              />
              {item.label}
            </span>
          ))}
        </div>
      </div>

      {/* Interactive 3D WebGL Viewport */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 490,
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid rgba(148,163,184,0.24)',
          background: '#0b1220',
        }}
      />

      {/* Live Picked Wire / Breaker Inspector Banner */}
      <div
        style={{
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid rgba(148,163,184,0.2)',
          background: 'rgba(255,255,255,0.04)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          fontSize: 11,
        }}
      >
        {pickedMeta ? (
          <>
            <div>
              <strong>
                {pickedMeta.circuitNumber ? `CKT-${pickedMeta.circuitNumber} · ` : ''}
                {pickedMeta.description ?? pickedMeta.kind}
              </strong>
              {pickedMeta.breakerAmps ? ` · ${pickedMeta.poles ?? 1}P-${pickedMeta.breakerAmps}A` : ''}
              {pickedMeta.wireGauge ? ` · #${pickedMeta.wireGauge} AWG Cu` : ''}
              {pickedMeta.loadVa !== undefined ? ` · ${pickedMeta.loadVa} VA` : ''}
              {pickedMeta.conductorLabel ? ` · ${pickedMeta.conductorLabel}` : ''}
            </div>
            {pickedMeta.deviceIds && pickedMeta.deviceIds.length > 0 && onSelectDeviceIds && (
              <button
                type="button"
                onClick={() => onSelectDeviceIds(pickedMeta.deviceIds!)}
                style={pillBtn(true, 'rgba(56,189,248,0.22)')}
              >
                Select Devices in 3D Scene
              </button>
            )}
          </>
        ) : (
          <div style={{ opacity: 0.78 }}>
            Drag to orbit, scroll to zoom, or click any individual wire, breaker, or copper busbar to inspect its NEC circuit details.
          </div>
        )}
      </div>
    </div>
  )
}

function pillBtn(active: boolean, activeBg: string): React.CSSProperties {
  return {
    padding: '4px 9px',
    borderRadius: 6,
    border: '1px solid var(--border, rgba(255,255,255,0.16))',
    background: active ? activeBg : 'transparent',
    color: 'inherit',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  }
}

const chkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  cursor: 'pointer',
}
