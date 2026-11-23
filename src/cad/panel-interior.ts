/**
 * Live Data-Driven Open-Panel 3D CAD Builder (`buildWiredPanelInteriorCad`).
 * Renders a cover-off electrical panelboard showing:
 * - Hollow galvanized steel enclosure tub with side wiring gutters & top/bottom knockouts + connectors
 * - Exposed copper busbars (2-bus 120/240V 1Φ or 3-bus 120/208V / 277/480V 3Φ) & visible spare stabs
 * - Main breaker (or MLO lugs) + heavy service entrance feeder conductors & main bonding screw
 * - Neutral & Equipment Grounding bus bars with brass terminal screws
 * - Every populated 1P/2P/3P branch circuit breaker (with AFCI/GFCI test buttons & common-trip ties)
 * - Every individual Hot (NEC phase-colored), Neutral (White/Gray), and Ground (Bare Cu/Green) wire
 *   routed neatly through the side gutters with 90-degree bends into its exact breaker/bar terminal!
 */

import {
  BoxGeometry,
  CurvePath,
  CylinderGeometry,
  Group,
  LineCurve3,
  Mesh,
  MeshStandardMaterial,
  QuadraticBezierCurve3,
  TubeGeometry,
  Vector3,
} from 'three'
import type { PanelSchedule, PanelSlotEntry } from '../nec/panel-schedule'
import type { VoltageSystem, WireGauge } from '../nec/tables'
import { type CadMaterialPool, createCadMaterialPool, voltageAccentMaterial } from './materials'

export type PanelInteriorViewMode = 'cover-off' | 'deadfront-on' | 'closed'

export type PanelWireVisibility = {
  showHots?: boolean
  showNeutrals?: boolean
  showGrounds?: boolean
  showFeeders?: boolean
}

export type PanelWireMetadata = {
  kind: 'breaker' | 'wire-hot' | 'wire-neutral' | 'wire-ground' | 'feeder' | 'busbar'
  circuitNumber?: number
  description?: string
  poles?: number
  breakerAmps?: number
  wireGauge?: string
  loadVa?: number
  phaseLabel?: string
  deviceIds?: string[]
  conductorLabel?: string
}

export type WiredPanelInteriorOptions = {
  schedule: PanelSchedule
  nemaRating?: 'NEMA-1' | 'NEMA-3R' | 'NEMA-4X'
  viewMode?: PanelInteriorViewMode
  wires?: PanelWireVisibility
  highlightCircuit?: number | null
  mats?: CadMaterialPool
}

const GAUGE_VISUAL_RADIUS_M: Partial<Record<WireGauge, number>> = {
  '14': 0.0023,
  '12': 0.0027,
  '10': 0.0033,
  '8': 0.0041,
  '6': 0.0049,
  '4': 0.0058,
  '3': 0.0062,
  '2': 0.0067,
  '1': 0.0073,
  '1/0': 0.0079,
  '2/0': 0.0085,
  '3/0': 0.0092,
  '4/0': 0.0099,
}

function wireRadiusForGauge(gauge: WireGauge): number {
  return GAUGE_VISUAL_RADIUS_M[gauge] ?? 0.003
}

function createWireMaterial(colorHex: number, highlighted = false): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: colorHex,
    metalness: colorHex === 0xc87533 ? 0.86 : 0.06,
    roughness: colorHex === 0xc87533 ? 0.3 : 0.48,
    emissive: highlighted ? 0x38bdf8 : 0x000000,
    emissiveIntensity: highlighted ? 0.45 : 0,
  })
}

function phaseWireHex(
  voltageSystem: VoltageSystem,
  phaseLabel: 'L1' | 'L2' | 'A' | 'B' | 'C',
): { hex: number; name: string } {
  if (voltageSystem === '277/480V-3P') {
    if (phaseLabel === 'A') return { hex: 0x78350f, name: 'Phase A (Brown 277V)' }
    if (phaseLabel === 'B') return { hex: 0xea580c, name: 'Phase B (Orange 277V)' }
    return { hex: 0xeab308, name: 'Phase C (Yellow 277V)' }
  }
  if (voltageSystem === '120/208V-3P') {
    if (phaseLabel === 'A') return { hex: 0x18181b, name: 'Phase A (Black 120V)' }
    if (phaseLabel === 'B') return { hex: 0xdc2626, name: 'Phase B (Red 120V)' }
    return { hex: 0x2563eb, name: 'Phase C (Blue 120V)' }
  }
  // 120/240V-1P split phase
  if (phaseLabel === 'L1' || phaseLabel === 'A') {
    return { hex: 0x18181b, name: 'Leg L1 (Black 120V)' }
  }
  return { hex: 0xdc2626, name: 'Leg L2 (Red 120V)' }
}

function buildFilletedWireTube(
  rawPoints: Vector3[],
  radius: number,
  mat: MeshStandardMaterial,
  bendRadius = 0.014,
): Mesh | null {
  const points: Vector3[] = []
  for (const p of rawPoints) {
    const prev = points[points.length - 1]
    if (!prev || prev.distanceTo(p) >= 1e-4) {
      points.push(p)
    }
  }
  if (points.length < 2 || !Number.isFinite(radius) || radius <= 0) return null

  const curve = new CurvePath<Vector3>()
  if (points.length === 2) {
    curve.add(new LineCurve3(points[0]!, points[1]!))
  } else {
    let cursor = points[0]!.clone()
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1]!
      const curr = points[i]!
      const next = points[i + 1]!
      const vIn = new Vector3().subVectors(curr, prev)
      const vOut = new Vector3().subVectors(next, curr)
      const lenIn = vIn.length()
      const lenOut = vOut.length()
      if (lenIn < 1e-4 || lenOut < 1e-4) continue
      const r = Math.min(bendRadius, lenIn * 0.42, lenOut * 0.42)
      const pStart = curr.clone().addScaledVector(vIn.normalize(), -r)
      const pEnd = curr.clone().addScaledVector(vOut.normalize(), r)
      if (cursor.distanceTo(pStart) > 1e-4) {
        curve.add(new LineCurve3(cursor, pStart))
      }
      if (pStart.distanceTo(pEnd) > 1e-4) {
        curve.add(new QuadraticBezierCurve3(pStart, curr.clone(), pEnd))
        cursor = pEnd
      }
    }
    const last = points[points.length - 1]!
    if (cursor.distanceTo(last) > 1e-4) {
      curve.add(new LineCurve3(cursor, last))
    }
  }

  if (curve.curves.length === 0) return null
  const segs = Math.max(18, points.length * 10)
  const geo = new TubeGeometry(curve, segs, radius, 8, false)
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  return mesh
}

function addHollowTub(
  group: Group,
  w: number,
  h: number,
  d: number,
  wall: number,
  mat: MeshStandardMaterial,
): void {
  const back = new Mesh(new BoxGeometry(w, h, wall), mat)
  back.position.set(0, 0, -d / 2 + wall / 2)
  back.receiveShadow = true
  group.add(back)

  const topBotGeo = new BoxGeometry(w, wall, d)
  const top = new Mesh(topBotGeo, mat)
  top.position.set(0, h / 2 - wall / 2, 0)
  const bot = new Mesh(topBotGeo, mat)
  bot.position.set(0, -h / 2 + wall / 2, 0)

  const sideGeo = new BoxGeometry(wall, h - 2 * wall, d)
  const left = new Mesh(sideGeo, mat)
  left.position.set(-w / 2 + wall / 2, 0, 0)
  const right = new Mesh(sideGeo, mat)
  right.position.set(w / 2 - wall / 2, 0, 0)
  group.add(top, bot, left, right)
}

export function buildWiredPanelInteriorCad(opts: WiredPanelInteriorOptions): Group {
  const { schedule } = opts
  const mats = opts.mats ?? createCadMaterialPool()
  const viewMode: PanelInteriorViewMode = opts.viewMode ?? 'cover-off'
  const showHots = opts.wires?.showHots !== false
  const showNeutrals = opts.wires?.showNeutrals !== false
  const showGrounds = opts.wires?.showGrounds !== false
  const showFeeders = opts.wires?.showFeeders !== false
  const highlightCkt = opts.highlightCircuit ?? null
  const isCommercial = schedule.occupancy === 'commercial' || schedule.voltageSystem !== '120/240V-1P'
  const isThreePhase = schedule.voltageSystem !== '120/240V-1P'
  const is480V = schedule.voltageSystem === '277/480V-3P'

  const w = isCommercial ? 0.52 : 0.42
  const visibleRows = Math.max(6, Math.min(21, schedule.rows.length))
  const rowPitch = 0.0285 // ~1.12" vertical breaker pitch
  const breakerBankH = visibleRows * rowPitch
  const h = Math.max(isCommercial ? 1.05 : 0.86, breakerBankH + 0.34)
  const d = 0.145
  const wall = 0.004
  const zBack = -d / 2 + wall

  const group = new Group()
  group.name = `panel-interior-${schedule.panelId}`

  // 1. Hollow Galvanized Steel Enclosure Tub (Cover OFF!)
  addHollowTub(group, w, h, d, wall, mats.galvanizedSteel)

  // Exterior powder-coated gray side/top rim shell
  const outerFrameTop = new Mesh(new BoxGeometry(w + 0.006, 0.006, d + 0.004), mats.nemaGray)
  outerFrameTop.position.set(0, h / 2 + 0.002, 0)
  const outerFrameBot = new Mesh(new BoxGeometry(w + 0.006, 0.006, d + 0.004), mats.nemaGray)
  outerFrameBot.position.set(0, -h / 2 - 0.002, 0)
  group.add(outerFrameTop, outerFrameBot)

  // NEMA 3R outdoor rain hood if applicable
  if (opts.nemaRating === 'NEMA-3R' || opts.nemaRating === 'NEMA-4X') {
    const hood = new Mesh(new BoxGeometry(w + 0.032, 0.026, d + 0.04), mats.nemaGray)
    hood.position.set(0, h / 2 + 0.015, 0.012)
    hood.rotation.x = 0.08
    group.add(hood)
  }

  // Top Service Entrance 2" Hub + Left/Right Branch Conduit Entry Connectors
  const serviceHub = new Mesh(new CylinderGeometry(0.03, 0.032, 0.034, 16), mats.castAluminum)
  serviceHub.position.set(0, h / 2 + 0.014, zBack + 0.055)
  const serviceBushing = new Mesh(new CylinderGeometry(0.026, 0.026, 0.012, 16), mats.accentBlue)
  serviceBushing.position.set(0, h / 2 - 0.008, zBack + 0.055)
  group.add(serviceHub, serviceBushing)

  const branchEntryXs = [-w * 0.37, -w * 0.27, w * 0.27, w * 0.37]
  const connGeo = new CylinderGeometry(0.014, 0.015, 0.026, 12)
  const bushingGeo = new CylinderGeometry(0.012, 0.012, 0.008, 12)
  for (const bx of branchEntryXs) {
    const conn = new Mesh(connGeo, mats.castAluminum)
    conn.position.set(bx, h / 2 + 0.01, zBack + 0.038)
    const bush = new Mesh(bushingGeo, mats.accentBlue)
    bush.position.set(bx, h / 2 - 0.007, zBack + 0.038)
    group.add(conn, bush)
  }

  // 2. Central Insulating Bus Pan + Copper Vertical Busbars + Stabs
  const busTopY = h / 2 - 0.21
  const busBotY = busTopY - breakerBankH - 0.02
  const busMidY = (busTopY + busBotY) / 2
  const busHeight = busTopY - busBotY

  const busPan = new Mesh(new BoxGeometry(w * 0.44, busHeight + 0.09, 0.014), mats.blackPolymer)
  busPan.position.set(0, busMidY + 0.035, zBack + 0.008)
  group.add(busPan)

  const busCount = isThreePhase ? 3 : 2
  const busBarGeo = new BoxGeometry(0.013, busHeight, 0.008)
  for (let b = 0; b < busCount; b++) {
    const bx = (b - (busCount - 1) / 2) * 0.021
    const busMesh = new Mesh(busBarGeo, mats.copper)
    busMesh.position.set(bx, busMidY, zBack + 0.02)
    busMesh.userData = {
      kind: 'busbar',
      description: `${schedule.busRatingAmps}A Copper Phase Busbar (${isThreePhase ? ['A', 'B', 'C'][b] : ['L1', 'L2'][b]})`,
    } satisfies PanelWireMetadata
    group.add(busMesh)
  }

  // Visible horizontal copper finger stabs at every row
  const stabGeo = new BoxGeometry(0.052, 0.006, 0.016)
  for (let r = 0; r < visibleRows; r++) {
    const ry = busTopY - (r + 0.5) * rowPitch
    const stab = new Mesh(stabGeo, mats.copper)
    stab.position.set(0, ry, zBack + 0.028)
    group.add(stab)
  }

  // 3. Neutral Bus Bars (Left & Right insulated) + Equipment Grounding Bars (Outer Backpan)
  const neutralBarX = w * 0.285
  const groundBarX = w * 0.415
  const barLen = Math.min(busHeight + 0.06, h * 0.62)
  const barY = busMidY + 0.02

  const neutralCrossTie = new Mesh(new BoxGeometry(neutralBarX * 2, 0.016, 0.006), mats.stainlessSteel)
  neutralCrossTie.position.set(0, busTopY + 0.025, zBack + 0.02)
  group.add(neutralCrossTie)

  const neutralScrewGeo = new CylinderGeometry(0.0032, 0.0032, 0.007, 8)
  for (const side of [-1, 1]) {
    // Insulated standoff + brushed aluminum neutral bar
    const standoff = new Mesh(new BoxGeometry(0.022, barLen + 0.01, 0.012), mats.blackPolymer)
    standoff.position.set(side * neutralBarX, barY, zBack + 0.008)
    const nBar = new Mesh(new BoxGeometry(0.016, barLen, 0.012), mats.stainlessSteel)
    nBar.position.set(side * neutralBarX, barY, zBack + 0.02)
    group.add(standoff, nBar)

    // Grounding bus bar bolted directly to galvanized steel backpan
    const gBar = new Mesh(new BoxGeometry(0.015, barLen * 0.85, 0.01), mats.stainlessSteel)
    gBar.position.set(side * groundBarX, barY - 0.02, zBack + 0.007)
    group.add(gBar)

    const screwCount = Math.min(18, visibleRows + 2)
    for (let s = 0; s < screwCount; s++) {
      const sy = barY + barLen / 2 - 0.018 - (s / Math.max(1, screwCount - 1)) * (barLen - 0.036)
      const nScrew = new Mesh(neutralScrewGeo, mats.brass)
      nScrew.rotation.x = Math.PI / 2
      nScrew.position.set(side * neutralBarX, sy, zBack + 0.028)
      const gScrew = new Mesh(neutralScrewGeo, mats.brass)
      gScrew.rotation.x = Math.PI / 2
      gScrew.position.set(side * groundBarX, sy * 0.88, zBack + 0.014)
      group.add(nScrew, gScrew)
    }
  }

  // Green NEC 250.28 Main Bonding Screw on service main-breaker panels (omitted on MLO subpanels)
  if (schedule.mainType === 'main-breaker') {
    const bondScrew = new Mesh(new CylinderGeometry(0.0055, 0.0055, 0.018, 6), mats.groundGreen)
    bondScrew.rotation.x = Math.PI / 2
    bondScrew.position.set(-neutralBarX, busTopY + 0.025, zBack + 0.024)
    group.add(bondScrew)
  }

  // 4. Main Circuit Breaker (or MLO Main Lugs) + Heavy Service Entrance Feeder Conductors
  const mainY = h / 2 - 0.125
  const mainW = isThreePhase ? 0.135 : 0.115
  const mainBody = new Mesh(new BoxGeometry(mainW, 0.082, 0.056), mats.blackPolymer)
  mainBody.position.set(0, mainY, zBack + 0.036)
  mainBody.castShadow = true
  mainBody.userData = {
    kind: 'breaker',
    description: `${schedule.mainBreakerAmps}A ${schedule.mainType === 'main-breaker' ? 'Main Circuit Breaker' : 'Main Lugs Only (MLO)'}`,
    breakerAmps: schedule.mainBreakerAmps,
    poles: isThreePhase ? 3 : 2,
  } satisfies PanelWireMetadata
  group.add(mainBody)

  if (schedule.mainType === 'main-breaker') {
    const mainHandle = new Mesh(new BoxGeometry(0.048, 0.022, 0.024), mats.accentRed)
    mainHandle.position.set(0, mainY, zBack + 0.072)
    group.add(mainHandle)
  }

  // Main feeder terminal lugs + Service Entrance Conductors
  const feederPoles = isThreePhase ? (['A', 'B', 'C'] as const) : (['L1', 'L2'] as const)
  const lugGeo = new BoxGeometry(0.022, 0.024, 0.026)
  for (let i = 0; i < feederPoles.length; i++) {
    const lx = (i - (feederPoles.length - 1) / 2) * 0.036
    const lug = new Mesh(lugGeo, mats.stainlessSteel)
    lug.position.set(lx, mainY + 0.044, zBack + 0.046)
    group.add(lug)

    if (showFeeders) {
      const ph = phaseWireHex(schedule.voltageSystem, feederPoles[i]!)
      const fMat = createWireMaterial(ph.hex, false)
      const fPts = [
        new Vector3(lx * 0.55, h / 2 + 0.02, zBack + 0.055),
        new Vector3(lx * 0.85, h / 2 - 0.032, zBack + 0.055),
        new Vector3(lx, mainY + 0.05, zBack + 0.046),
      ]
      const fMesh = buildFilletedWireTube(fPts, 0.0085, fMat, 0.022)
      if (fMesh) {
        fMesh.userData = {
          kind: 'feeder',
          description: `Service Entrance Feeder — ${ph.name}`,
          conductorLabel: ph.name,
        } satisfies PanelWireMetadata
        group.add(fMesh)
      }
    }
  }

  if (showFeeders) {
    // Heavy Neutral Feeder from top hub to upper-left main neutral lug
    const nLug = new Mesh(new BoxGeometry(0.024, 0.026, 0.024), mats.stainlessSteel)
    nLug.position.set(-neutralBarX, busTopY + 0.048, zBack + 0.026)
    group.add(nLug)

    const nFeederMat = createWireMaterial(is480V ? 0x94a3b8 : 0xf8fafc, false)
    const nFeeder = buildFilletedWireTube(
      [
        new Vector3(-0.024, h / 2 + 0.02, zBack + 0.046),
        new Vector3(-neutralBarX, h / 2 - 0.042, zBack + 0.042),
        new Vector3(-neutralBarX, busTopY + 0.052, zBack + 0.026),
      ],
      0.008,
      nFeederMat,
      0.026,
    )
    if (nFeeder) {
      nFeeder.userData = {
        kind: 'feeder',
        description: is480V ? 'Service Neutral Feeder (Gray)' : 'Service Neutral Feeder (White)',
      } satisfies PanelWireMetadata
      group.add(nFeeder)
    }

    // Grounding Electrode Conductor (GEC) entering bottom-right to ground bar
    const gecMat = createWireMaterial(isCommercial ? 0x16a34a : 0xc87533, false)
    const gec = buildFilletedWireTube(
      [
        new Vector3(groundBarX, -h / 2 - 0.01, zBack + 0.015),
        new Vector3(groundBarX, barY - barLen * 0.36, zBack + 0.015),
      ],
      0.0052,
      gecMat,
      0.014,
    )
    if (gec) {
      gec.userData = {
        kind: 'feeder',
        description: 'NEC 250.66 Grounding Electrode Conductor (GEC)',
      } satisfies PanelWireMetadata
      group.add(gec)
    }
  }

  // 5. Populate Branch Circuit Breakers & Route EVERY Individual Hot / Neutral / Ground Wire!
  const bkrWidth = w * 0.215
  const bkrDepth = 0.046
  const renderedMultiPoleRoots = new Set<number>()
  let leftWireLane = 0
  let rightWireLane = 0

  const renderSlot = (slot: PanelSlotEntry | null, side: -1 | 1, rowIdx: number) => {
    if (!slot || slot.isContinuation) return
    if (renderedMultiPoleRoots.has(slot.circuitNumber)) return
    renderedMultiPoleRoots.add(slot.circuitNumber)

    const isHighlighted = highlightCkt === slot.circuitNumber
    const poles = Math.min(slot.poles, visibleRows - rowIdx)
    const totalBkrH = poles * rowPitch - 0.0025
    const yTopSlot = busTopY - (rowIdx + 0.5) * rowPitch
    const yCenter = yTopSlot - ((poles - 1) * rowPitch) / 2
    const bkrCenterX = side * (bkrWidth / 2 + 0.014)
    const xLug = side * (bkrWidth + 0.014)
    const zLug = zBack + 0.042

    const bkrMat = isHighlighted
      ? new MeshStandardMaterial({
          color: 0x1e293b,
          emissive: 0x0284c7,
          emissiveIntensity: 0.45,
          roughness: 0.4,
        })
      : mats.blackPolymer

    const meta: PanelWireMetadata = {
      kind: 'breaker',
      circuitNumber: slot.circuitNumber,
      description: slot.description,
      poles: slot.poles,
      breakerAmps: slot.breakerAmps,
      wireGauge: slot.wireGauge,
      loadVa: slot.loadVa,
      phaseLabel: schedule.rows[rowIdx]?.phaseLabel,
      deviceIds: slot.deviceIds,
    }

    // Molded breaker case
    const body = new Mesh(new BoxGeometry(bkrWidth, totalBkrH, bkrDepth), bkrMat)
    body.position.set(bkrCenterX, yCenter, zBack + 0.038)
    body.castShadow = true
    body.userData = meta
    group.add(body)

    // Ampacity color-coded handle toggle(s) + handle tie on multi-pole
    const handleMat =
      slot.breakerAmps >= 50
        ? mats.accentRed
        : slot.breakerAmps >= 30
          ? mats.accentBlue
          : slot.breakerAmps >= 20
            ? mats.accentAmber
            : mats.whiteNylon
    for (let p = 0; p < poles; p++) {
      const py = yTopSlot - p * rowPitch
      const toggle = new Mesh(new BoxGeometry(0.022, 0.012, 0.022), handleMat)
      toggle.position.set(side * 0.036, py, zBack + 0.068)
      toggle.userData = meta
      group.add(toggle)

      // Brass breaker load terminal screw facing outward into gutter
      const lugScrew = new Mesh(new CylinderGeometry(0.004, 0.004, 0.008, 10), mats.brass)
      lugScrew.rotation.z = Math.PI / 2
      lugScrew.position.set(xLug + side * 0.002, py, zLug)
      lugScrew.userData = meta
      group.add(lugScrew)
    }

    if (poles > 1) {
      const tie = new Mesh(new BoxGeometry(0.01, (poles - 1) * rowPitch + 0.012, 0.008), handleMat)
      tie.position.set(side * 0.044, yCenter, zBack + 0.078)
      tie.userData = meta
      group.add(tie)
    }

    // AFCI / GFCI Test Button + coiled white pigtail to neutral bar
    const hasAfci = slot.protection.includes('AFCI')
    const hasGfci = slot.protection.includes('GFCI')
    if (hasAfci || hasGfci) {
      const testBtnMat = hasAfci && hasGfci ? mats.accentCyan : hasGfci ? mats.accentAmber : mats.accentBlue
      const testBtn = new Mesh(new BoxGeometry(0.012, 0.01, 0.012), testBtnMat)
      testBtn.position.set(side * 0.068, yTopSlot, zBack + 0.064)
      testBtn.userData = meta
      group.add(testBtn)
    }

    // Gutter lane index for clean, non-overlapping electrician bundle routing
    const lane = side === -1 ? leftWireLane++ : rightWireLane++
    const laneOffsetX = (lane % 4) * 0.0075
    const laneOffsetZ = Math.floor(lane / 4) * 0.0065
    const xGutterHot = side * (w * 0.345 + laneOffsetX)
    const xEntry = side * (lane % 2 === 0 ? w * 0.37 : w * 0.27)
    const wireR = wireRadiusForGauge(slot.wireGauge)

    // Route Hot Conductor(s) from top knockout -> side gutter -> 90° bend -> exact breaker terminal(s)
    if (showHots) {
      for (let p = 0; p < poles; p++) {
        const py = yTopSlot - p * rowPitch
        const rowPhase = schedule.rows[rowIdx + p]?.phaseLabel ?? 'L1'
        const ph = phaseWireHex(schedule.voltageSystem, rowPhase)
        const hotMat = createWireMaterial(ph.hex, isHighlighted)
        const zHot = zBack + 0.042 + laneOffsetZ + p * 0.0045
        const xPoleGutter = xGutterHot + side * p * 0.0055

        const hotPts = [
          new Vector3(xEntry, h / 2 - 0.004, zHot),
          new Vector3(xPoleGutter, h / 2 - 0.055 - p * 0.01, zHot),
          new Vector3(xPoleGutter, py, zHot),
          new Vector3(xLug + side * 0.004, py, zLug),
        ]
        const hotWire = buildFilletedWireTube(hotPts, wireR, hotMat, 0.016)
        if (hotWire) {
          hotWire.userData = {
            ...meta,
            kind: 'wire-hot',
            phaseLabel: rowPhase,
            conductorLabel: `${ph.name} (#${slot.wireGauge} AWG)`,
          } satisfies PanelWireMetadata
          group.add(hotWire)
        }
      }
    }

    // Route Neutral Conductor (White on 120/208/240V, Gray on 277/480V) to neutral bar (1-pole or AFCI/GFCI or 120/240V)
    const needsNeutral = slot.poles === 1 || hasAfci || hasGfci || (!isThreePhase && slot.poles === 2)
    if (showNeutrals && needsNeutral) {
      const neutralMat = createWireMaterial(is480V ? 0x94a3b8 : 0xf8fafc, isHighlighted)
      const nTargetY = Math.max(barY - barLen / 2 + 0.02, Math.min(barY + barLen / 2 - 0.02, yTopSlot))
      const zNeutral = zBack + 0.026 + (lane % 3) * 0.003
      const xGutterNeutral = side * (w * 0.325 + (lane % 3) * 0.005)
      const nPts = [
        new Vector3(xEntry, h / 2 - 0.004, zNeutral),
        new Vector3(xGutterNeutral, h / 2 - 0.048, zNeutral),
        new Vector3(xGutterNeutral, nTargetY, zNeutral),
        new Vector3(side * neutralBarX, nTargetY, zBack + 0.025),
      ]
      const nWire = buildFilletedWireTube(nPts, wireR * 0.92, neutralMat, 0.014)
      if (nWire) {
        nWire.userData = {
          ...meta,
          kind: 'wire-neutral',
          conductorLabel: `${is480V ? 'Gray' : 'White'} Neutral (#${slot.wireGauge} AWG)`,
        } satisfies PanelWireMetadata
        group.add(nWire)
      }
    }

    // Route Equipment Grounding Conductor (Bare Cu residential / Green THHN commercial) to outer ground bar
    if (showGrounds) {
      const gMat = createWireMaterial(isCommercial ? 0x16a34a : 0xc87533, isHighlighted)
      const gTargetY = Math.max(barY - barLen * 0.38, Math.min(barY + barLen * 0.38, yTopSlot * 0.9))
      const zGround = zBack + 0.011 + (lane % 2) * 0.0025
      const xGutterGnd = side * (w * 0.445)
      const gPts = [
        new Vector3(xEntry, h / 2 - 0.004, zGround),
        new Vector3(xGutterGnd, h / 2 - 0.038, zGround),
        new Vector3(xGutterGnd, gTargetY, zGround),
        new Vector3(side * groundBarX, gTargetY, zBack + 0.011),
      ]
      const gWire = buildFilletedWireTube(gPts, Math.max(0.0019, wireR * 0.8), gMat, 0.012)
      if (gWire) {
        gWire.userData = {
          ...meta,
          kind: 'wire-ground',
          conductorLabel: isCommercial ? 'Green Insulated EGC' : 'Bare Copper EGC',
        } satisfies PanelWireMetadata
        group.add(gWire)
      }
    }
  }

  for (let r = 0; r < visibleRows; r++) {
    const row = schedule.rows[r]
    if (!row) continue
    renderSlot(row.left, -1, r)
    renderSlot(row.right, 1, r)
  }

  // 6. Optional Deadfront / Closed Cover Layers
  if (viewMode === 'deadfront-on' || viewMode === 'closed') {
    const dfLeft = new Mesh(new BoxGeometry(w * 0.36, h * 0.96, 0.005), mats.darkSteel)
    dfLeft.position.set(-w * 0.31, 0, d / 2 - 0.006)
    const dfRight = new Mesh(new BoxGeometry(w * 0.36, h * 0.96, 0.005), mats.darkSteel)
    dfRight.position.set(w * 0.31, 0, d / 2 - 0.006)
    const dfTop = new Mesh(new BoxGeometry(w * 0.32, h * 0.14, 0.005), mats.darkSteel)
    dfTop.position.set(0, h * 0.41, d / 2 - 0.006)
    const dfBot = new Mesh(new BoxGeometry(w * 0.32, Math.max(0.08, h * 0.14), 0.005), mats.darkSteel)
    dfBot.position.set(0, -h * 0.41, d / 2 - 0.006)
    group.add(dfLeft, dfRight, dfTop, dfBot)
  }

  if (viewMode === 'closed') {
    const door = new Mesh(new BoxGeometry(w + 0.02, h + 0.02, 0.01), mats.nemaGray)
    door.position.set(0, 0, d / 2 + 0.006)
    const stripe = new Mesh(
      new BoxGeometry(w * 0.86, 0.036, 0.005),
      voltageAccentMaterial(mats, schedule.voltageSystem),
    )
    stripe.position.set(0, h * 0.43, d / 2 + 0.013)
    const latch = new Mesh(new BoxGeometry(0.022, 0.068, 0.012), mats.darkSteel)
    latch.position.set(w * 0.38, -h * 0.03, d / 2 + 0.014)
    group.add(door, stripe, latch)
  }

  return group
}
