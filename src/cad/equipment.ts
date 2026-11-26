/**
 * Clean-room NEMA/UL/NEC Parametric 3D CAD Builders for Electrical Materials:
 * - Load Centers & Panelboards (Closed, Open-Deadfront w/ Breakers & Busbars, NEMA 3R)
 * - Molded-Case Circuit Breakers (1P / 2P / 3P)
 * - Commercial Dry-Type Step-Down Transformers (Louvered NEMA 2 / 3R)
 * - Heavy-Duty Safety Disconnect Switches & 200A Utility Meter Sockets
 * - Wiring Devices (Duplex 5-20R, GFCI, AFCI, NEMA 14-50R, Decora Switch, EVSE, 3Φ TEFC Motor)
 * - Residential & Commercial Light Fixtures (6" Recessed Can, 2x4 Troffer, UFO High-Bay, 4ft Strip, Wall Pack, Flush Drum, EXIT Sign)
 * - Raceways & Fittings (Swept Filleted EMT/RMC/PVC/MC/NM-B, Couplings, Straps, Type LB Conduit Body, Unistrut Clamp Kit)
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
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import {
  type BoxType,
  CONDUIT_OUTER_DIAMETER_M,
  type ConduitTradeSize,
  type OccupancyType,
  type RacewayType,
  type VoltageSystem,
  type WireGauge,
} from '../nec/tables'
import { buildElectricalBoxCad } from './boxes'
import {
  buildBrassFloorBoxCad,
  buildCeilingFanLightCad,
  buildCommercialVfdCad,
  buildSmartDimmerCad,
  buildSmokeCoAlarmCad,
  buildType2SpdCad,
  buildUnderCabinetLedCad,
  buildUsbDuplexReceptacleCad,
  buildWeatherproofInUseCoverCad,
} from './expansion'
import {
  buildPanelNameplatePlacards,
  type CadMaterialPool,
  circuitRunColor,
  createCadMaterialPool,
  nmbJacketColor,
  voltageAccentMaterial,
} from './materials'
import {
  buildAutomaticTransferSwitchCad,
  buildGeneratorInletBoxCad,
  buildPvRapidShutdownCad,
  buildSolarStringInverterCad,
  buildWallBatteryEssCad,
} from './solar-backup'

const IN = 0.0254

// ─── 1. Load Centers & Commercial Panelboards ───────────────────────────────

export type PanelCadOptions = {
  width?: number
  height?: number
  depth?: number
  voltageSystem?: VoltageSystem
  nemaRating?: 'NEMA-1' | 'NEMA-3R' | 'NEMA-4X'
  spaces?: number
  doorOpen?: boolean
  mats?: CadMaterialPool
}

export function buildPanelCad(opts: PanelCadOptions = {}): Group {
  const mats = opts.mats ?? createCadMaterialPool()
  const w = opts.width ?? 0.38
  const h = opts.height ?? 0.92
  const d = opts.depth ?? 0.14
  const voltageSystem = opts.voltageSystem ?? '120/240V-1P'
  const nemaRating = opts.nemaRating ?? 'NEMA-1'
  const spaces = Math.min(42, Math.max(8, opts.spaces ?? 24))
  const doorOpen = opts.doorOpen === true

  const group = new Group()
  group.name = 'cad-panelboard'

  // Galvanized NEMA enclosure tub
  const tub = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  tub.castShadow = true
  tub.receiveShadow = true
  group.add(tub)

  // Top & bottom concentric conduit knockouts
  const koCount = Math.max(3, Math.floor(w / 0.085))
  const koGeo = new CylinderGeometry(0.016, 0.016, 0.004, 14)
  for (let i = 0; i < koCount; i++) {
    const kx = ((i + 0.5) / koCount - 0.5) * (w * 0.78)
    for (const signY of [1, -1]) {
      const ko = new Mesh(koGeo, mats.darkSteel)
      ko.position.set(kx, signY * (h / 2 + 0.001), 0)
      group.add(ko)
    }
  }

  // NEMA 3R sloped weatherproof rain hood overhang
  if (nemaRating === 'NEMA-3R' || nemaRating === 'NEMA-4X') {
    const hood = new Mesh(new BoxGeometry(w + 0.03, 0.028, d + 0.04), mats.nemaGray)
    hood.position.set(0, h / 2 + 0.014, 0.012)
    hood.rotation.x = 0.08
    hood.castShadow = true
    group.add(hood)

    const hub = new Mesh(new CylinderGeometry(0.032, 0.034, 0.028, 16), mats.castAluminum)
    hub.position.set(0, h / 2 + 0.038, 0)
    group.add(hub)
  }

  // Front deadfront trim bezel
  const trim = new Mesh(new BoxGeometry(w + 0.024, h + 0.024, 0.012), mats.nemaGray)
  trim.position.set(0, 0, d / 2 + 0.006)
  trim.castShadow = true
  group.add(trim)

  // Engraved NEMA panelboard nameplate + compact NEC 110.16 arc-flash warning placard
  const placards = buildPanelNameplatePlacards({
    panelWidth: w,
    yCenter: h * 0.425,
    zFront: d / 2 + 0.012,
    voltageSystem,
    mats,
  })
  group.add(placards)

  if (!doorOpen) {
    // Closed hinged door panel with recessed latch & directory card window
    const door = new Mesh(new BoxGeometry(w * 0.86, h * 0.78, 0.008), mats.galvanizedSteel)
    door.position.set(0, -h * 0.03, d / 2 + 0.015)
    door.castShadow = true
    group.add(door)

    const latch = new Mesh(new BoxGeometry(0.022, 0.068, 0.012), mats.darkSteel)
    latch.position.set(w * 0.36, -h * 0.03, d / 2 + 0.021)
    group.add(latch)

    // Left vertical piano hinge knuckles
    const hingeGeo = new CylinderGeometry(0.005, 0.005, 0.045, 8)
    for (const hy of [-h * 0.3, 0, h * 0.28]) {
      const hinge = new Mesh(hingeGeo, mats.darkSteel)
      hinge.position.set(-w * 0.43, hy, d / 2 + 0.017)
      group.add(hinge)
    }

    // Circuit schedule nameplate / card window
    const label = new Mesh(new BoxGeometry(w * 0.38, 0.06, 0.003), mats.whiteNylon)
    label.position.set(0, h * 0.2, d / 2 + 0.02)
    group.add(label)
  } else {
    // Open-deadfront interior view: recessed cavity, copper busbars, neutral/ground bars, main & branch breakers
    const cavity = new Mesh(new BoxGeometry(w * 0.84, h * 0.82, 0.006), mats.darkSteel)
    cavity.position.set(0, -h * 0.02, d / 2 + 0.011)
    group.add(cavity)

    // Twin copper vertical busbars (3 bars for 3-phase)
    const busCount = voltageSystem === '120/240V-1P' ? 2 : 3
    const busGeo = new BoxGeometry(0.014, h * 0.6, 0.008)
    for (let b = 0; b < busCount; b++) {
      const bx = (b - (busCount - 1) / 2) * 0.022
      const bus = new Mesh(busGeo, mats.copper)
      bus.position.set(bx, -h * 0.06, d / 2 + 0.017)
      group.add(bus)
    }

    // Left & right aluminum neutral/ground lug bars with brass screws
    const barGeo = new BoxGeometry(0.018, h * 0.56, 0.014)
    for (const signX of [-1, 1]) {
      const bar = new Mesh(barGeo, mats.stainlessSteel)
      bar.position.set(signX * (w * 0.36), -h * 0.05, d / 2 + 0.019)
      group.add(bar)
    }

    // Main circuit breaker at top center
    const mainBody = new Mesh(new BoxGeometry(0.11, 0.075, 0.036), mats.blackPolymer)
    mainBody.position.set(0, h * 0.29, d / 2 + 0.028)
    const mainHandle = new Mesh(new BoxGeometry(0.045, 0.022, 0.022), mats.accentRed)
    mainHandle.position.set(0, h * 0.29, d / 2 + 0.052)
    group.add(mainBody, mainHandle)

    // Twin columns of 1-pole / 2-pole molded-case branch breakers
    const rows = Math.min(12, Math.floor(spaces / 2))
    const rowStep = (h * 0.58) / rows
    const bkrGeo = new BoxGeometry(w * 0.26, rowStep * 0.84, 0.028)
    const toggleGeo = new BoxGeometry(0.018, rowStep * 0.42, 0.018)
    for (let r = 0; r < rows; r++) {
      const by = h * 0.18 - r * rowStep
      for (const side of [-1, 1]) {
        const bkr = new Mesh(bkrGeo, mats.blackPolymer)
        bkr.position.set(side * (w * 0.16), by, d / 2 + 0.025)
        const handleMat =
          r < 2 ? mats.accentAmber : r === 2 && side === -1 ? mats.accentBlue : mats.blackPolymer
        const toggle = new Mesh(toggleGeo, handleMat)
        toggle.position.set(side * (w * 0.08), by, d / 2 + 0.044)
        group.add(bkr, toggle)
      }
    }

    // Open hinged door swung 115 degrees to the left
    const doorPivot = new Group()
    doorPivot.position.set(-w * 0.43, -h * 0.03, d / 2 + 0.015)
    doorPivot.rotation.y = -2.0
    const openDoor = new Mesh(new BoxGeometry(w * 0.86, h * 0.78, 0.008), mats.galvanizedSteel)
    openDoor.position.set(w * 0.43, 0, 0)
    const scheduleCard = new Mesh(new BoxGeometry(w * 0.65, h * 0.55, 0.002), mats.whiteNylon)
    scheduleCard.position.set(w * 0.43, 0, -0.005)
    doorPivot.add(openDoor, scheduleCard)
    group.add(doorPivot)
  }

  return group
}

// ─── 2. Molded-Case Circuit Breaker Trio (1P / 2P / 3P) ─────────────────────

export function buildBreakerTrioCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-breaker-trio'
  const poleW = 0.0254 // 1 inch per pole
  const bkrH = 0.076 // 3 in
  const bkrD = 0.068 // 2.7 in

  const specs: Array<{ poles: number; xOffset: number; handleMat: MeshStandardMaterial }> = [
    { poles: 1, xOffset: -0.085, handleMat: mats.accentAmber }, // 1P-20A
    { poles: 2, xOffset: -0.01, handleMat: mats.accentBlue }, // 2P-50A
    { poles: 3, xOffset: 0.09, handleMat: mats.accentRed }, // 3P-40A
  ]

  for (const s of specs) {
    const totalW = s.poles * poleW
    const body = new Mesh(new BoxGeometry(totalW - 0.001, bkrH, bkrD), mats.blackPolymer)
    body.position.set(s.xOffset, bkrH / 2, 0)
    body.castShadow = true
    group.add(body)

    // Individual pole seams, brass load lugs, and tied toggles
    for (let p = 0; p < s.poles; p++) {
      const px = s.xOffset + (p - (s.poles - 1) / 2) * poleW
      const lug = new Mesh(new CylinderGeometry(0.005, 0.005, 0.01, 10), mats.brass)
      lug.position.set(px, bkrH * 0.16, bkrD / 2 + 0.002)
      lug.rotation.x = Math.PI / 2
      group.add(lug)

      const toggle = new Mesh(new BoxGeometry(0.011, 0.018, 0.022), s.handleMat)
      toggle.position.set(px, bkrH * 0.62, bkrD / 2 + 0.01)
      toggle.rotation.x = -0.35
      group.add(toggle)
    }

    if (s.poles > 1) {
      // Common-trip handle tie bar across poles
      const tie = new Mesh(new BoxGeometry(totalW * 0.82, 0.008, 0.009), s.handleMat)
      tie.position.set(s.xOffset, bkrH * 0.65, bkrD / 2 + 0.019)
      group.add(tie)
    }
  }

  return group
}

// ─── 3. Commercial Dry-Type Step-Down Transformer (NEMA 2 / 3R) ─────────────

export type TransformerCadOptions = {
  width?: number
  height?: number
  depth?: number
  primaryVoltage?: number
  secondaryVoltage?: number
  nemaRating?: 'NEMA-1' | 'NEMA-2' | 'NEMA-3R'
  mats?: CadMaterialPool
}

export function buildTransformerCad(opts: TransformerCadOptions = {}): Group {
  const mats = opts.mats ?? createCadMaterialPool()
  const w = opts.width ?? 0.76
  const h = opts.height ?? 0.95
  const d = opts.depth ?? 0.64
  const isHighVoltage = (opts.primaryVoltage ?? 480) > 250 || (opts.secondaryVoltage ?? 208) > 250
  const accentMat = isHighVoltage ? mats.accentRed : mats.accentBlue

  const group = new Group()
  group.name = 'cad-transformer'

  // Floor vibration-isolation mounting rails + rubber pads
  const padH = 0.035
  const railGeo = new BoxGeometry(0.07, padH, d * 0.96)
  for (const signX of [-1, 1]) {
    const rail = new Mesh(railGeo, mats.darkSteel)
    rail.position.set(signX * (w * 0.36), padH / 2, 0)
    rail.castShadow = true
    group.add(rail)
  }

  // Main NEMA-2 heavy steel enclosure
  const bodyH = h - padH - 0.04
  const body = new Mesh(new BoxGeometry(w, bodyH, d), mats.nemaGray)
  body.position.set(0, padH + bodyH / 2, 0)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // Sloped top rain cap + voltage accent collar
  const cap = new Mesh(new BoxGeometry(w + 0.03, 0.04, d + 0.03), mats.darkSteel)
  cap.position.set(0, h - 0.02, 0)
  cap.castShadow = true
  const accentBand = new Mesh(new BoxGeometry(w + 0.034, 0.016, d + 0.034), accentMat)
  accentBand.position.set(0, h - 0.046, 0)
  group.add(cap, accentBand)

  // 4 top corner lifting lugs
  const lugGeo = new BoxGeometry(0.025, 0.05, 0.012)
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const lug = new Mesh(lugGeo, mats.darkSteel)
    lug.position.set(sx * (w * 0.42), h + 0.02, sz * (d * 0.42))
    group.add(lug)
  }

  // Upper cooling louver slats (front & rear)
  const louverGeo = new BoxGeometry(w * 0.78, 0.012, 0.022)
  for (const signZ of [1, -1]) {
    for (let i = 0; i < 6; i++) {
      const slat = new Mesh(louverGeo, mats.darkSteel)
      slat.position.set(0, padH + bodyH * (0.58 + i * 0.055), signZ * (d / 2 + 0.008))
      slat.rotation.x = signZ * 0.35
      group.add(slat)
    }
  }

  // Lower front recessed wiring compartment cover + 4 hex bolts + rating nameplate
  const frontCover = new Mesh(new BoxGeometry(w * 0.82, bodyH * 0.36, 0.012), mats.galvanizedSteel)
  frontCover.position.set(0, padH + bodyH * 0.22, d / 2 + 0.006)
  group.add(frontCover)

  const nameplate = new Mesh(new BoxGeometry(0.16, 0.09, 0.004), mats.stainlessSteel)
  nameplate.position.set(w * 0.22, padH + bodyH * 0.47, d / 2 + 0.004)
  group.add(nameplate)

  // NEMA-3R outdoor sloped rain-hood top & louver weather shields (omitted on default NEMA-2 / NEMA-1)
  if (opts.nemaRating === 'NEMA-3R') {
    const rainHood = new Mesh(new BoxGeometry(w + 0.08, 0.032, d + 0.12), mats.nemaGray)
    rainHood.name = 'nema3r-rain-hood'
    rainHood.position.set(0, h + 0.012, 0.01)
    rainHood.rotation.x = 0.07
    rainHood.castShadow = true
    group.add(rainHood)

    const frontShieldGeo = new BoxGeometry(w * 0.84, bodyH * 0.4, 0.045)
    for (const signZ of [1, -1]) {
      const shield = new Mesh(frontShieldGeo, mats.nemaGray)
      shield.name = 'nema3r-weather-shield'
      shield.position.set(0, padH + bodyH * 0.72, signZ * (d / 2 + 0.032))
      shield.rotation.x = signZ * 0.14
      shield.castShadow = true
      group.add(shield)
    }

    const sideShieldGeo = new BoxGeometry(0.036, bodyH * 0.4, d * 0.72)
    for (const signX of [-1, 1]) {
      const sideShield = new Mesh(sideShieldGeo, mats.nemaGray)
      sideShield.name = 'nema3r-side-weather-shield'
      sideShield.position.set(signX * (w / 2 + 0.022), padH + bodyH * 0.72, 0)
      sideShield.rotation.z = -signX * 0.14
      sideShield.castShadow = true
      group.add(sideShield)
    }
  }

  return group
}

// ─── 4. Safety Disconnect Switch & Utility Meter Socket ─────────────────────

export function buildSafetyDisconnectCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-safety-disconnect-100a'
  const w = 0.27
  const h = 0.56
  const d = 0.15

  const box = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  box.position.set(0, h / 2, 0)
  box.castShadow = true
  const door = new Mesh(new BoxGeometry(w * 0.94, h * 0.92, 0.01), mats.galvanizedSteel)
  door.position.set(0, h / 2, d / 2 + 0.005)
  const label = new Mesh(new BoxGeometry(0.11, 0.075, 0.004), mats.accentRed)
  label.position.set(0, h * 0.72, d / 2 + 0.011)
  group.add(box, door, label)

  // Heavy side red throw handle & ON/OFF lockout bracket
  const pivot = new Mesh(new BoxGeometry(0.03, 0.14, 0.05), mats.darkSteel)
  pivot.position.set(w / 2 + 0.015, h * 0.65, 0.01)
  const arm = new Mesh(new CylinderGeometry(0.008, 0.008, 0.14, 10), mats.stainlessSteel)
  arm.position.set(w / 2 + 0.032, h * 0.74, 0.035)
  arm.rotation.x = 0.45
  const grip = new Mesh(new CylinderGeometry(0.015, 0.015, 0.07, 12), mats.accentRed)
  grip.position.set(w / 2 + 0.032, h * 0.82, 0.068)
  grip.rotation.z = Math.PI / 2
  group.add(pivot, arm, grip)

  // Top & bottom weather hubs
  const hubGeo = new CylinderGeometry(0.025, 0.027, 0.026, 14)
  const topHub = new Mesh(hubGeo, mats.castAluminum)
  topHub.position.set(0, h + 0.013, 0)
  group.add(topHub)

  return group
}

export function buildMeterSocketCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-meter-socket-200a'
  const w = 0.28
  const h = 0.39
  const d = 0.125

  const tub = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  tub.position.set(0, h / 2, 0)
  tub.castShadow = true
  const cover = new Mesh(new BoxGeometry(w + 0.012, h * 0.94, 0.012), mats.nemaGray)
  cover.position.set(0, h * 0.48, d / 2 + 0.006)
  const topHub = new Mesh(new CylinderGeometry(0.032, 0.034, 0.032, 16), mats.castAluminum)
  topHub.position.set(0, h + 0.016, 0)
  group.add(tub, cover, topHub)

  // Ringless bezel + glass kWh meter dome + internal digital dial face
  const bezel = new Mesh(new CylinderGeometry(0.088, 0.092, 0.022, 24), mats.darkSteel)
  bezel.rotation.x = Math.PI / 2
  bezel.position.set(0, h * 0.56, d / 2 + 0.018)

  const facePlate = new Mesh(new CylinderGeometry(0.072, 0.072, 0.016, 24), mats.whiteNylon)
  facePlate.rotation.x = Math.PI / 2
  facePlate.position.set(0, h * 0.56, d / 2 + 0.038)

  const lcd = new Mesh(new BoxGeometry(0.068, 0.024, 0.005), mats.accentCyan)
  lcd.position.set(0, h * 0.59, d / 2 + 0.048)

  const dome = new Mesh(new CylinderGeometry(0.078, 0.082, 0.085, 24), mats.glassDome)
  dome.rotation.x = Math.PI / 2
  dome.position.set(0, h * 0.56, d / 2 + 0.058)
  group.add(bezel, facePlate, lcd, dome)

  return group
}

// ─── 5. Light Fixtures (7 Residential & Commercial Luminaires) ──────────────

export function buildRecessedCan6InCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-can-6in-recessed'

  // Galvanized IC-rated new-construction housing pan + junction box + hanger bars
  const pan = new Mesh(new BoxGeometry(0.24, 0.012, 0.32), mats.galvanizedSteel)
  pan.position.set(0, 0.012, 0)
  const can = new Mesh(new CylinderGeometry(0.082, 0.082, 0.16, 20), mats.galvanizedSteel)
  can.position.set(0, 0.095, -0.02)
  const jbox = new Mesh(new BoxGeometry(0.085, 0.065, 0.055), mats.galvanizedSteel)
  jbox.position.set(0, 0.05, 0.11)
  const barGeo = new BoxGeometry(0.46, 0.018, 0.008)
  for (const sz of [-0.14, 0.14]) {
    const bar = new Mesh(barGeo, mats.galvanizedSteel)
    bar.position.set(0, 0.024, sz)
    group.add(bar)
  }

  // White ceiling flange trim + luminous warm LED baffle lens
  const trim = new Mesh(new CylinderGeometry(0.098, 0.098, 0.008, 24), mats.whiteNylon)
  trim.position.set(0, 0.002, -0.02)
  const lens = new Mesh(new CylinderGeometry(0.072, 0.072, 0.012, 24), mats.diffuserWhite)
  lens.position.set(0, 0.001, -0.02)
  group.add(pan, can, jbox, trim, lens)

  return group
}

export function buildTroffer2x4Cad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-troffer-2x4'
  const len = 1.219 // 4 ft
  const wid = 0.61 // 2 ft

  const frame = new Mesh(new BoxGeometry(len, 0.022, wid), mats.whiteNylon)
  frame.position.set(0, 0.011, 0)
  const backPan = new Mesh(new BoxGeometry(len * 0.92, 0.055, wid * 0.88), mats.galvanizedSteel)
  backPan.position.set(0, 0.048, 0)
  const driverBox = new Mesh(new BoxGeometry(0.24, 0.032, 0.09), mats.darkSteel)
  driverBox.position.set(0, 0.088, 0)
  const lens = new Mesh(new BoxGeometry(len * 0.92, 0.014, wid * 0.88), mats.diffuserWhite)
  lens.position.set(0, 0.003, 0)
  group.add(frame, backPan, driverBox, lens)

  return group
}

export function buildHighBayUfoCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-highbay-ufo'

  // Die-cast radial finned heatsink disk
  const disk = new Mesh(new CylinderGeometry(0.175, 0.195, 0.055, 24), mats.darkSteel)
  disk.position.set(0, 0.035, 0)
  const finGeo = new BoxGeometry(0.36, 0.038, 0.008)
  for (let i = 0; i < 6; i++) {
    const fin = new Mesh(finGeo, mats.blackPolymer)
    fin.position.set(0, 0.068, 0)
    fin.rotation.y = (i * Math.PI) / 6
    group.add(fin)
  }

  // Top LED driver cylinder + forged hanging ring
  const driver = new Mesh(new CylinderGeometry(0.082, 0.092, 0.08, 18), mats.blackPolymer)
  driver.position.set(0, 0.12, 0)
  const ring = new Mesh(new TorusGeometry(0.024, 0.006, 10, 18), mats.galvanizedSteel)
  ring.position.set(0, 0.18, 0)

  // Bottom luminous LED optic lens
  const lens = new Mesh(new CylinderGeometry(0.165, 0.165, 0.012, 24), mats.diffuserWhite)
  lens.position.set(0, 0.006, 0)
  group.add(disk, driver, ring, lens)

  return group
}

export function buildShopStrip4FtCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-shop-4ft-strip'
  const len = 1.22

  const channel = new Mesh(new BoxGeometry(len, 0.042, 0.115), mats.whiteNylon)
  channel.position.set(0, 0.042, 0)
  const lens = new Mesh(new BoxGeometry(len - 0.02, 0.032, 0.105), mats.diffuserWhite)
  lens.position.set(0, 0.014, 0)
  const endCapGeo = new BoxGeometry(0.014, 0.068, 0.118)
  for (const sx of [-1, 1]) {
    const cap = new Mesh(endCapGeo, mats.galvanizedSteel)
    cap.position.set(sx * (len / 2 - 0.004), 0.032, 0)
    group.add(cap)
  }
  group.add(channel, lens)
  return group
}

export function buildExteriorWallPackCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-wall-pack'

  // Bronze/dark-gray cast aluminum rear backplate + full-cutoff upper hood
  const back = new Mesh(new BoxGeometry(0.36, 0.23, 0.045), mats.darkSteel)
  back.position.set(0, 0, -0.022)
  const hood = new Mesh(new BoxGeometry(0.37, 0.08, 0.19), mats.darkSteel)
  hood.position.set(0, 0.075, 0.075)
  hood.rotation.x = 0.12
  const lens = new Mesh(new BoxGeometry(0.32, 0.135, 0.12), mats.diffuserWhite)
  lens.position.set(0, -0.025, 0.055)
  lens.rotation.x = -0.22
  const hub = new Mesh(new CylinderGeometry(0.016, 0.016, 0.024, 14), mats.castAluminum)
  hub.position.set(0, 0.125, -0.01)
  group.add(back, hood, lens, hub)
  return group
}

export function buildFlushCeilingDrumCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-flush-drum'

  const base = new Mesh(new CylinderGeometry(0.17, 0.17, 0.024, 28), mats.stainlessSteel)
  base.position.set(0, 0.068, 0)
  const drum = new Mesh(new CylinderGeometry(0.155, 0.145, 0.06, 28), mats.diffuserWhite)
  drum.position.set(0, 0.03, 0)
  const finial = new Mesh(new CylinderGeometry(0.016, 0.012, 0.014, 14), mats.stainlessSteel)
  finial.position.set(0, -0.004, 0)
  group.add(base, drum, finial)
  return group
}

export function buildExitSignCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fixture-exit-sign'

  const body = new Mesh(new BoxGeometry(0.32, 0.19, 0.05), mats.whiteNylon)
  const face = new Mesh(new BoxGeometry(0.28, 0.14, 0.008), mats.accentRed)
  face.position.set(0, 0, 0.024)
  const backFace = new Mesh(new BoxGeometry(0.28, 0.14, 0.008), mats.accentRed)
  backFace.position.set(0, 0, -0.024)
  group.add(body, face, backFace)

  // Twin adjustable round emergency bug-eye floodlight heads
  const headGeo = new CylinderGeometry(0.042, 0.032, 0.058, 16)
  const lensGeo = new CylinderGeometry(0.038, 0.038, 0.008, 16)
  for (const sx of [-1, 1]) {
    const arm = new Mesh(new BoxGeometry(0.035, 0.02, 0.02), mats.whiteNylon)
    arm.position.set(sx * 0.175, 0.02, 0)
    const head = new Mesh(headGeo, mats.whiteNylon)
    head.rotation.x = Math.PI / 2 + 0.25
    head.position.set(sx * 0.21, 0.02, 0.018)
    const lens = new Mesh(lensGeo, mats.diffuserWhite)
    lens.rotation.x = Math.PI / 2 + 0.25
    lens.position.set(sx * 0.21, 0.013, 0.048)
    group.add(arm, head, lens)
  }

  return group
}

// ─── 6. Wiring Devices, EVSE, & Commercial 3Φ Motor ─────────────────────────

export type DeviceCadOptions = {
  deviceKind:
    | 'duplex'
    | 'gfci'
    | 'afci'
    | 'dedicated-240v'
    | 'evse'
    | 'switch-1p'
    | 'switch-3way'
    | 'luminaire'
    | 'exit-sign'
    | 'motor-load'
    | 'junction-box'
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
  boxType?: BoxType
  occupancy?: OccupancyType
  breakerAmps?: number
  mats?: CadMaterialPool
}

export function buildDeviceCad(opts: DeviceCadOptions): Group {
  const mats = opts.mats ?? createCadMaterialPool()
  const boxType: BoxType = opts.boxType ?? 'single-gang-standard'
  const group = new Group()
  group.name = `cad-device-${opts.deviceKind}`

  if (opts.deviceKind === 'solar-inverter') {
    group.add(buildSolarStringInverterCad(mats))
    return group
  }
  if (opts.deviceKind === 'battery-ess') {
    group.add(buildWallBatteryEssCad(mats))
    return group
  }
  if (opts.deviceKind === 'transfer-switch') {
    group.add(buildAutomaticTransferSwitchCad(mats))
    return group
  }
  if (opts.deviceKind === 'generator-inlet') {
    group.add(buildGeneratorInletBoxCad(mats))
    return group
  }
  if (opts.deviceKind === 'rapid-shutdown') {
    group.add(buildPvRapidShutdownCad(mats))
    return group
  }
  if (opts.deviceKind === 'spd') {
    group.add(buildType2SpdCad(mats))
    return group
  }
  if (opts.deviceKind === 'vfd') {
    group.add(buildCommercialVfdCad(mats))
    return group
  }
  if (opts.deviceKind === 'dimmer') {
    group.add(buildSmartDimmerCad(mats, opts.boxType))
    return group
  }
  if (opts.deviceKind === 'usb-duplex') {
    group.add(buildUsbDuplexReceptacleCad(mats, opts.boxType))
    return group
  }
  if (opts.deviceKind === 'weatherproof-gfci') {
    group.add(buildWeatherproofInUseCoverCad(mats))
    return group
  }
  if (opts.deviceKind === 'floor-box') {
    group.add(buildBrassFloorBoxCad(mats))
    return group
  }
  if (opts.deviceKind === 'smoke-co') {
    group.add(buildSmokeCoAlarmCad(mats))
    return group
  }
  if (opts.deviceKind === 'ceiling-fan') {
    group.add(buildCeilingFanLightCad(mats))
    return group
  }
  if (opts.deviceKind === 'under-cabinet-led') {
    group.add(buildUnderCabinetLedCad(mats))
    return group
  }

  if (opts.deviceKind === 'luminaire') {
    const fixture =
      opts.occupancy === 'commercial' ? buildTroffer2x4Cad(mats) : buildFlushCeilingDrumCad(mats)
    group.add(fixture)
    return group
  }

  if (opts.deviceKind === 'exit-sign') {
    group.add(buildExitSignCad(mats))
    return group
  }

  if (opts.deviceKind === 'junction-box') {
    const jboxType: BoxType = boxType.startsWith('4-') ? boxType : '4-sq-2.125'
    group.add(
      buildElectricalBoxCad(jboxType, {
        includeCover: true,
        includeEmtConnectors: true,
        mats,
      }),
    )
    return group
  }

  if (opts.deviceKind === 'evse') {
    // Wall-mounted Level 2 EVSE charger + glowing lightbar + side J1772/NACS holster + coiled whip
    const chassis = new Mesh(new BoxGeometry(0.24, 0.37, 0.115), mats.whiteNylon)
    chassis.castShadow = true
    const fascia = new Mesh(new BoxGeometry(0.21, 0.34, 0.012), mats.blackPolymer)
    fascia.position.set(0, 0, 0.058)
    const lightBar = new Mesh(new BoxGeometry(0.014, 0.14, 0.008), mats.accentCyan)
    lightBar.position.set(0, 0.04, 0.066)
    const holster = new Mesh(new BoxGeometry(0.052, 0.11, 0.075), mats.darkSteel)
    holster.position.set(0.145, -0.02, 0)
    const nozzle = new Mesh(new CylinderGeometry(0.022, 0.018, 0.09, 14), mats.blackPolymer)
    nozzle.position.set(0.155, -0.06, 0.02)
    nozzle.rotation.z = -0.35
    const whip = new Mesh(new TorusGeometry(0.095, 0.009, 10, 24), mats.blackPolymer)
    whip.position.set(0, -0.22, 0.02)
    group.add(chassis, fascia, lightBar, holster, nozzle, whip)
    return group
  }

  if (opts.deviceKind === 'motor-load') {
    // Commercial 3-phase TEFC finned electric motor + peckerhead j-box + baseplate
    const stator = new Mesh(new CylinderGeometry(0.155, 0.155, 0.34, 24), mats.accentBlue)
    stator.rotation.z = Math.PI / 2
    stator.position.set(0, 0.19, 0)
    stator.castShadow = true
    group.add(stator)

    // Radial stator cooling fins
    const finGeo = new BoxGeometry(0.26, 0.012, 0.34)
    for (let i = 0; i < 6; i++) {
      const fin = new Mesh(finGeo, mats.accentBlue)
      fin.position.set(0, 0.19, 0)
      fin.rotation.x = (i * Math.PI) / 6
      group.add(fin)
    }

    // End bells, fan cowl, drive shaft + keyway, mounting base, & top peckerhead conduit box
    const rearCowl = new Mesh(new CylinderGeometry(0.152, 0.14, 0.09, 20), mats.darkSteel)
    rearCowl.rotation.z = Math.PI / 2
    rearCowl.position.set(-0.21, 0.19, 0)
    const shaft = new Mesh(new CylinderGeometry(0.024, 0.024, 0.11, 16), mats.stainlessSteel)
    shaft.rotation.z = Math.PI / 2
    shaft.position.set(0.22, 0.19, 0)
    const base = new Mesh(new BoxGeometry(0.32, 0.032, 0.28), mats.darkSteel)
    base.position.set(0, 0.016, 0)
    const peckerhead = new Mesh(new BoxGeometry(0.11, 0.09, 0.11), mats.accentBlue)
    peckerhead.position.set(0.02, 0.37, 0)
    group.add(rearCowl, shaft, base, peckerhead)
    return group
  }

  // Wall-mounted rough-in box behind wall plane (z <= 0) + detailed trim/device on z > 0
  const isSteelBox = boxType.startsWith('4-')
  group.add(buildElectricalBoxCad(boxType, { includeMudRing: isSteelBox, mats }))
  const zFace = isSteelBox ? 0.013 : 0

  if (opts.deviceKind === 'dedicated-240v') {
    // 2-Gang Brushed Stainless Wallplate + Heavy NEMA 14-50R Range/EV Receptacle
    const plate = new Mesh(new BoxGeometry(4.56 * IN, 4.5 * IN, 0.005), mats.stainlessSteel)
    plate.position.set(0, 0, zFace + 0.003)
    const boss = new Mesh(new CylinderGeometry(1.06 * IN, 1.06 * IN, 0.018, 24), mats.blackPolymer)
    boss.rotation.x = Math.PI / 2
    boss.position.set(0, 0, zFace + 0.012)
    // 4-slot NEMA 14-50R pattern (top U-ground, left/right vertical hots, bottom vertical neutral)
    const slotGeo = new BoxGeometry(0.004, 0.016, 0.004)
    for (const [sx, sy] of [
      [-0.013, 0],
      [0.013, 0],
      [0, -0.013],
    ] as const) {
      const slot = new Mesh(slotGeo, mats.brass)
      slot.position.set(sx, sy, zFace + 0.021)
      group.add(slot)
    }
    const gnd = new Mesh(new CylinderGeometry(0.0045, 0.0045, 0.004, 12), mats.brass)
    gnd.rotation.x = Math.PI / 2
    gnd.position.set(0, 0.013, zFace + 0.021)
    group.add(plate, boss, gnd)
    return group
  }

  // Standard 1-Gang Wallplate (2.75" W x 4.5" H)
  const plateW = 2.75 * IN
  const plateH = 4.5 * IN
  const plate = new Mesh(new BoxGeometry(plateW, plateH, 0.006), mats.whiteNylon)
  plate.position.set(0, 0, zFace + 0.003)
  plate.castShadow = true
  group.add(plate)

  if (opts.deviceKind === 'switch-1p' || opts.deviceKind === 'switch-3way') {
    // Decora rocker switch insert + angled paddle
    const bezel = new Mesh(new BoxGeometry(0.034, 0.068, 0.008), mats.whiteNylon)
    bezel.position.set(0, 0, zFace + 0.008)
    const paddle = new Mesh(new BoxGeometry(0.028, 0.056, 0.012), mats.whiteNylon)
    paddle.position.set(0, 0, zFace + 0.013)
    paddle.rotation.x = -0.18
    group.add(bezel, paddle)
    return group
  }

  // Duplex / GFCI / AFCI Receptacle Face
  const isGfci = opts.deviceKind === 'gfci'
  const isAfci = opts.deviceKind === 'afci'
  const is20A = (opts.breakerAmps ?? 20) >= 20

  const insert = new Mesh(new BoxGeometry(0.035, 0.069, 0.008), mats.whiteNylon)
  insert.position.set(0, 0, zFace + 0.008)
  group.add(insert)

  // Upper & lower NEMA 5-15R / 5-20R outlet faces
  for (const oy of [0.02, -0.02]) {
    const hot = new Mesh(new BoxGeometry(0.0025, 0.009, 0.004), mats.blackPolymer)
    hot.position.set(0.0065, oy + 0.002, zFace + 0.0115)
    const neutral = new Mesh(new BoxGeometry(0.0025, 0.011, 0.004), mats.blackPolymer)
    neutral.position.set(-0.0065, oy + 0.002, zFace + 0.0115)
    const gnd = new Mesh(new CylinderGeometry(0.0026, 0.0026, 0.004, 10), mats.blackPolymer)
    gnd.rotation.x = Math.PI / 2
    gnd.position.set(0, oy - 0.006, zFace + 0.0115)
    group.add(hot, neutral, gnd)

    if (is20A) {
      // Horizontal T-slot on neutral side for NEMA 5-20R
      const tSlot = new Mesh(new BoxGeometry(0.006, 0.0025, 0.004), mats.blackPolymer)
      tSlot.position.set(-0.0045, oy + 0.002, zFace + 0.0115)
      group.add(tSlot)
    }
  }

  if (isGfci || isAfci) {
    // Center TEST / RESET buttons + green/blue status indicator LED
    const testBtn = new Mesh(
      new BoxGeometry(0.012, 0.0065, 0.006),
      isAfci ? mats.accentBlue : mats.blackPolymer,
    )
    testBtn.position.set(-0.007, 0, zFace + 0.013)
    const resetBtn = new Mesh(new BoxGeometry(0.012, 0.0065, 0.006), mats.accentRed)
    resetBtn.position.set(0.007, 0, zFace + 0.013)
    const led = new Mesh(
      new CylinderGeometry(0.0022, 0.0022, 0.005, 10),
      isAfci ? mats.accentCyan : mats.ledGreen,
    )
    led.rotation.x = Math.PI / 2
    led.position.set(0.011, 0.007, zFace + 0.012)
    group.add(testBtn, resetBtn, led)
  } else {
    // Center faceplate mounting screw
    const screw = new Mesh(new CylinderGeometry(0.0028, 0.0028, 0.003, 10), mats.brass)
    screw.rotation.x = Math.PI / 2
    screw.position.set(0, 0, zFace + 0.012)
    group.add(screw)
  }

  return group
}

// ─── 7. Type LB Conduit Body & EMT Fittings + Unistrut Kit ──────────────────

export function buildConduitBodyLbCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-conduit-body-lb-34'

  // Oval cast-aluminum body (3/4" trade size)
  const main = new Mesh(new BoxGeometry(0.044, 0.125, 0.042), mats.castAluminum)
  main.castShadow = true
  const topCap = new Mesh(new CylinderGeometry(0.022, 0.022, 0.042, 16), mats.castAluminum)
  topCap.rotation.x = Math.PI / 2
  topCap.position.set(0, 0.062, 0)
  const botCap = new Mesh(new CylinderGeometry(0.022, 0.022, 0.042, 16), mats.castAluminum)
  botCap.rotation.x = Math.PI / 2
  botCap.position.set(0, -0.062, 0)

  // Bottom vertical hub + rear 90° stub hub (LB = back entry)
  const botHub = new Mesh(new CylinderGeometry(0.0165, 0.0175, 0.032, 16), mats.castAluminum)
  botHub.position.set(0, -0.095, 0)
  const backHub = new Mesh(new CylinderGeometry(0.0165, 0.0175, 0.034, 16), mats.castAluminum)
  backHub.rotation.x = Math.PI / 2
  backHub.position.set(0, 0.042, -0.036)

  // Neoprene gasket + stamped aluminum cover plate + 2 stainless cover screws
  const gasket = new Mesh(new BoxGeometry(0.042, 0.132, 0.003), mats.blackPolymer)
  gasket.position.set(0, 0, 0.022)
  const cover = new Mesh(new BoxGeometry(0.04, 0.13, 0.005), mats.stainlessSteel)
  cover.position.set(0, 0, 0.026)
  const screwGeo = new CylinderGeometry(0.0032, 0.0032, 0.005, 10)
  for (const sy of [-0.052, 0.052]) {
    const sc = new Mesh(screwGeo, mats.darkSteel)
    sc.rotation.x = Math.PI / 2
    sc.position.set(0, sy, 0.029)
    group.add(sc)
  }

  group.add(main, topCap, botCap, botHub, backHub, gasket, cover)
  return group
}

export function buildEmtFittingsKitCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-fitting-emt-kit'

  // 1) 3/4" EMT Set-Screw Box Connector (left)
  const conn = new Mesh(new CylinderGeometry(0.0155, 0.0155, 0.046, 16), mats.castAluminum)
  conn.position.set(-0.085, 0.023, 0)
  const locknut = new Mesh(new CylinderGeometry(0.021, 0.021, 0.006, 6), mats.galvanizedSteel)
  locknut.position.set(-0.085, 0.008, 0)
  const throat = new Mesh(new CylinderGeometry(0.012, 0.012, 0.006, 14), mats.accentBlue)
  throat.position.set(-0.085, 0.002, 0)
  const screw1 = new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.014, 8), mats.brass)
  screw1.rotation.x = Math.PI / 2
  screw1.position.set(-0.085, 0.032, 0.018)
  group.add(conn, locknut, throat, screw1)

  // 2) 3/4" EMT Set-Screw Coupling (center-left)
  const cpl = new Mesh(new CylinderGeometry(0.0155, 0.0155, 0.056, 16), mats.castAluminum)
  cpl.position.set(-0.025, 0.028, 0)
  for (const sy of [0.014, 0.042]) {
    const sc = new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.014, 8), mats.brass)
    sc.rotation.x = Math.PI / 2
    sc.position.set(-0.025, sy, 0.018)
    group.add(sc)
  }
  group.add(cpl)

  // 3) 3/4" Stamped Steel 1-Hole Conduit Strap (center-right)
  const arc = new Mesh(new TorusGeometry(0.014, 0.0035, 8, 16, Math.PI * 1.15), mats.galvanizedSteel)
  arc.position.set(0.032, 0.016, 0)
  const foot = new Mesh(new BoxGeometry(0.022, 0.004, 0.016), mats.galvanizedSteel)
  foot.position.set(0.052, 0.003, 0)
  group.add(arc, foot)

  // 4) 1-5/8" Slotted Unistrut Channel + EMT Strut Clamp (right)
  const strut = new Mesh(new BoxGeometry(0.11, 0.041, 0.041), mats.galvanizedSteel)
  strut.position.set(0.115, 0.0205, 0)
  const clamp = new Mesh(new TorusGeometry(0.015, 0.004, 8, 16), mats.galvanizedSteel)
  clamp.position.set(0.115, 0.056, 0)
  const bolt = new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.022, 8), mats.brass)
  bolt.rotation.z = Math.PI / 2
  bolt.position.set(0.115, 0.072, 0)
  group.add(strut, clamp, bolt)

  return group
}

// ─── 8. Swept Filleted 3D Conduit & Cable Run with Couplings & Straps ───────

export type ConduitRunCadInput = {
  id: string
  path: ReadonlyArray<readonly [number, number, number]>
  racewayType: RacewayType
  tradeSize: ConduitTradeSize
  wireGauge: WireGauge
  voltage: number
  circuitNumber?: number
}

const UP = new Vector3(0, 1, 0)

function dedupeConsecutivePoints(points: Vector3[], eps = 1e-4): Vector3[] {
  const out: Vector3[] = []
  for (const p of points) {
    const prev = out[out.length - 1]
    if (!prev || prev.distanceTo(p) >= eps) {
      out.push(p)
    }
  }
  return out
}

function buildFilletedCurvePath(rawPoints: Vector3[], bendRadius: number): CurvePath<Vector3> {
  const curve = new CurvePath<Vector3>()
  const points = dedupeConsecutivePoints(rawPoints)
  if (points.length < 2) return curve
  if (points.length === 2) {
    curve.add(new LineCurve3(points[0]!, points[1]!))
    return curve
  }

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
    const startBend = curr.clone().addScaledVector(vIn.normalize(), -r)
    const endBend = curr.clone().addScaledVector(vOut.normalize(), r)

    if (cursor.distanceTo(startBend) > 1e-4) {
      curve.add(new LineCurve3(cursor, startBend))
    }
    if (startBend.distanceTo(endBend) > 1e-4) {
      curve.add(new QuadraticBezierCurve3(startBend, curr.clone(), endBend))
      cursor = endBend
    }
  }

  const last = points[points.length - 1]!
  if (cursor.distanceTo(last) > 1e-4) {
    curve.add(new LineCurve3(cursor, last))
  }
  return curve
}

export function buildConduitRunCad(
  node: ConduitRunCadInput,
  mats?: CadMaterialPool,
): Group {
  const group = new Group()
  group.name = `electrical-conduit-${node.id}`

  const pts = dedupeConsecutivePoints(node.path.map((p) => new Vector3(p[0], p[1], p[2])))
  if (pts.length < 2) return group

  // R6-OPT-01: Lazily instantiate the 21-material pool only when actually needed (skips allocation entirely for NM-B runs)
  let pool = mats
  const getMats = (): CadMaterialPool => {
    if (!pool) pool = createCadMaterialPool()
    return pool
  }

  const outerDiam =
    node.racewayType === 'nm-b'
      ? 0.036
      : Math.max(0.036, CONDUIT_OUTER_DIAMETER_M[node.tradeSize] ?? 0.036)
  const radius = outerDiam / 2
  // Concealed NM-B uses a tighter corner fillet so sweeps stay cleanly inside thin 70-90mm partition corners;
  // rigid conduits preserve full NEC Chapter 9 Table 2 minimum one-shot bend radii.
  const bendRadius =
    node.racewayType === 'nm-b' ? 0.045 : Math.max(0.065, outerDiam * 3.2)

  let runMat: MeshStandardMaterial
  if (node.circuitNumber && node.circuitNumber > 0) {
    const cktCol = circuitRunColor(node.circuitNumber)
    runMat = new MeshStandardMaterial({
      color: cktCol.num,
      emissive: cktCol.num,
      emissiveIntensity: 0.36,
      metalness: node.racewayType === 'nm-b' ? 0.08 : 0.35,
      roughness: node.racewayType === 'nm-b' ? 0.42 : 0.32,
    })
  } else if (node.voltage >= 277) {
    runMat = getMats().accentRed
  } else if (node.racewayType === 'nm-b') {
    runMat = new MeshStandardMaterial({
      color: nmbJacketColor(node.wireGauge),
      metalness: 0.04,
      roughness: 0.62,
    })
  } else if (node.racewayType === 'pvc-40') {
    runMat = getMats().pvcGray
  } else if (node.racewayType === 'mc') {
    runMat = getMats().castAluminum
  } else {
    runMat = getMats().galvanizedSteel
  }

  const curve = buildFilletedCurvePath(pts, bendRadius)
  if (curve.curves.length === 0) return group
  const tubularSegments = Math.max(16, Math.min(220, pts.length * 14))
  const tubeGeo = new TubeGeometry(curve, tubularSegments, radius, 12, false)
  const tube = new Mesh(tubeGeo, runMat)
  tube.name = 'conduit-tube'
  tube.castShadow = true
  group.add(tube)

  // Add set-screw box connectors at start/end and 10 ft couplings + 8 ft support straps for rigid/EMT/PVC raceways
  if (node.racewayType === 'emt' || node.racewayType === 'rmc' || node.racewayType === 'pvc-40') {
    const m = getMats()
    const couplingGeo = new CylinderGeometry(radius * 1.24, radius * 1.24, Math.max(0.045, outerDiam * 1.8), 12)
    const strapGeo = new CylinderGeometry(radius * 1.32, radius * 1.32, 0.018, 12)

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!
      const b = pts[i + 1]!
      const delta = new Vector3().subVectors(b, a)
      const segLen = delta.length()
      if (segLen < 0.08) continue
      const dir = delta.clone().normalize()

      // Box connectors at start & end terminals
      if (i === 0) {
        const startConn = new Mesh(couplingGeo, m.castAluminum)
        startConn.position.copy(a).addScaledVector(dir, 0.025)
        startConn.quaternion.setFromUnitVectors(UP, dir)
        group.add(startConn)
      }
      if (i === pts.length - 2) {
        const endConn = new Mesh(couplingGeo, m.castAluminum)
        endConn.position.copy(b).addScaledVector(dir, -0.025)
        endConn.quaternion.setFromUnitVectors(UP, dir)
        group.add(endConn)
      }

      // 10 ft (3.048 m) stick couplings
      for (let dist = 3.048; dist < segLen - 0.2; dist += 3.048) {
        const cpl = new Mesh(couplingGeo, m.castAluminum)
        cpl.position.copy(a).addScaledVector(dir, dist)
        cpl.quaternion.setFromUnitVectors(UP, dir)
        group.add(cpl)
      }

      // 1-hole support straps every 2.44 m (8 ft, compliant with NEC 358.30 <= 10 ft)
      for (let dist = 1.2; dist < segLen - 0.35; dist += 2.44) {
        const strap = new Mesh(strapGeo, m.darkSteel)
        strap.position.copy(a).addScaledVector(dir, dist)
        strap.quaternion.setFromUnitVectors(UP, dir)
        group.add(strap)
      }
    }
  }

  return group
}
