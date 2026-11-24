/**
 * Clean-Room MIT Extended Electrical Materials 3D CAD Builders (Expansion Pack).
 * Covers Type 2 SPD, Commercial VFD, Smart Dimmer, USB-C Duplex, Weatherproof In-Use Bubble Cover,
 * Brass Floor Box, Hardwired Smoke/CO Alarm, LL/LR/T Conduit Bodies, 4x4 Wireway Gutter,
 * Commercial Ladder Cable Tray, Copper-Clad Ground Rod + Acorn Clamp, Ceiling Fan w/ Light,
 * and Under-Cabinet LED Task Bar.
 * Zero React or `@pascal-app/editor` imports.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
} from 'three'
import { buildElectricalBoxCad, buildWeatherproofBellBoxCad } from './boxes'
import { type CadMaterialPool, createCadMaterialPool } from './materials'

/**
 * 1. Type 2 Whole-Home Surge Protective Device (SPD, NEC 230.67) —
 * NEMA-4X gray enclosure with side 1/2" close-nipple + locknut & twin green L1/L2 LEDs.
 */
export function buildType2SpdCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-spd-type2-panel'

  const w = 0.095
  const h = 0.145
  const d = 0.072

  const body = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  body.castShadow = true
  const frontBezel = new Mesh(new BoxGeometry(w - 0.014, h - 0.018, 0.008), mats.darkSteel)
  frontBezel.position.set(0, 0, d / 2 + 0.004)
  const label = new Mesh(new BoxGeometry(w - 0.026, 0.056, 0.003), mats.whiteNylon)
  label.position.set(0, 0.022, d / 2 + 0.009)
  const header = new Mesh(new BoxGeometry(w - 0.026, 0.016, 0.002), mats.accentBlue)
  header.position.set(0, 0.042, d / 2 + 0.011)
  group.add(body, frontBezel, label, header)

  // Twin bright green diagnostic protection LEDs (L1 / L2 active)
  const ledGeo = new CylinderGeometry(0.0055, 0.0055, 0.006, 12)
  for (const lx of [-0.016, 0.016]) {
    const led = new Mesh(ledGeo, mats.ledGreen)
    led.rotation.x = Math.PI / 2
    led.position.set(lx, -0.032, d / 2 + 0.01)
    group.add(led)
  }

  // Side threaded 1/2" chase nipple + galvanized locknut for direct panel KO mounting
  const nipple = new Mesh(new CylinderGeometry(0.011, 0.011, 0.032, 14), mats.castAluminum)
  nipple.rotation.z = Math.PI / 2
  nipple.position.set(-w / 2 - 0.016, 0.018, 0)
  const locknut = new Mesh(new CylinderGeometry(0.016, 0.016, 0.007, 6), mats.galvanizedSteel)
  locknut.rotation.z = Math.PI / 2
  locknut.position.set(-w / 2 - 0.024, 0.018, 0)
  group.add(nipple, locknut)

  // Color-coded pigtail leads emerging from the nipple (Black, Red, White, Green)
  const leadMats = [mats.blackPolymer, mats.accentRed, mats.whiteNylon, mats.groundGreen]
  for (let i = 0; i < leadMats.length; i++) {
    const lead = new Mesh(new CylinderGeometry(0.0022, 0.0022, 0.042, 8), leadMats[i])
    lead.rotation.z = Math.PI / 2
    lead.position.set(-w / 2 - 0.048, 0.01 + i * 0.005, (i - 1.5) * 0.004)
    group.add(lead)
  }

  return group
}

/**
 * 2. Commercial 3-Phase Variable Frequency Drive (VFD, NEC 430.122) —
 * deep rear aluminum heatsink fin array, top fan grille, front keypad + cyan Hz readout, and conduit plate.
 */
export function buildCommercialVfdCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-vfd-drive-commercial'

  const w = 0.22
  const h = 0.38
  const d = 0.2

  // Deep rear extruded aluminum heatsink fins
  const hsBase = new Mesh(new BoxGeometry(w, h, 0.024), mats.castAluminum)
  hsBase.position.set(0, 0, -d / 2 + 0.045)
  group.add(hsBase)
  const finGeo = new BoxGeometry(0.006, h - 0.01, 0.048)
  for (let i = 0; i < 10; i++) {
    const fx = -w * 0.45 + (i / 9) * (w * 0.9)
    const fin = new Mesh(finGeo, mats.castAluminum)
    fin.position.set(fx, 0, -d / 2 + 0.015)
    group.add(fin)
  }

  // Main industrial dark-slate & gray drive chassis
  const body = new Mesh(new BoxGeometry(w, h, d - 0.06), mats.darkSteel)
  body.position.set(0, 0, 0.03)
  body.castShadow = true
  const frontCover = new Mesh(new BoxGeometry(w - 0.012, h - 0.016, 0.018), mats.nemaGray)
  frontCover.position.set(0, 0, d / 2 - 0.004)
  group.add(body, frontCover)

  // Keypad bezel + glowing cyan 60.0 Hz LED display + Run/Stop buttons + rotary speed pot
  const keypad = new Mesh(new BoxGeometry(0.145, 0.165, 0.014), mats.blackPolymer)
  keypad.position.set(0, 0.055, d / 2 + 0.008)
  const display = new Mesh(new BoxGeometry(0.11, 0.042, 0.004), mats.accentCyan)
  display.position.set(0, 0.1, d / 2 + 0.016)
  const runBtn = new Mesh(new BoxGeometry(0.032, 0.02, 0.006), mats.ledGreen)
  runBtn.position.set(-0.038, 0.012, d / 2 + 0.017)
  const stopBtn = new Mesh(new BoxGeometry(0.032, 0.02, 0.006), mats.accentRed)
  stopBtn.position.set(0.038, 0.012, d / 2 + 0.017)
  const potDial = new Mesh(new CylinderGeometry(0.014, 0.016, 0.018, 16), mats.stainlessSteel)
  potDial.rotation.x = Math.PI / 2
  potDial.position.set(0, 0.048, d / 2 + 0.02)
  group.add(keypad, display, runBtn, stopBtn, potDial)

  // Lower ventilation louvers + warning band
  const warnStrip = new Mesh(new BoxGeometry(w - 0.028, 0.022, 0.003), mats.accentOrange)
  warnStrip.position.set(0, -0.055, d / 2 + 0.007)
  group.add(warnStrip)
  for (let i = 0; i < 4; i++) {
    const slot = new Mesh(new BoxGeometry(w - 0.044, 0.008, 0.005), mats.blackPolymer)
    slot.position.set(0, -0.092 - i * 0.018, d / 2 + 0.007)
    group.add(slot)
  }

  // Bottom conduit knockout plate + 2 EMT hubs (Line In / Motor Out)
  const botPlate = new Mesh(new BoxGeometry(w, 0.008, d - 0.06), mats.galvanizedSteel)
  botPlate.position.set(0, -h / 2 - 0.004, 0.03)
  group.add(botPlate)
  for (const hx of [-0.055, 0.055]) {
    const hub = new Mesh(new CylinderGeometry(0.016, 0.018, 0.026, 14), mats.castAluminum)
    hub.position.set(hx, -h / 2 - 0.018, 0.04)
    group.add(hub)
  }

  return group
}

/**
 * 3. Smart Decora Slide Dimmer Switch (NEC 404.2) —
 * 1-gang PVC rough-in box + Decora wallplate + flat rocker paddle + side dimming slider & 5 LED level dots.
 */
export function buildSmartDimmerCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-device-dimmer-smart'

  const box = buildElectricalBoxCad('single-gang-standard', { mats })
  box.position.set(0, 0, -0.038)
  group.add(box)

  // Beveled white Decora wallplate
  const plate = new Mesh(new BoxGeometry(0.074, 0.118, 0.007), mats.whiteNylon)
  plate.position.set(0, 0, 0.004)
  plate.castShadow = true
  // Decora rectangular aperture bezel
  const frame = new Mesh(new BoxGeometry(0.036, 0.068, 0.008), mats.whiteNylon)
  frame.position.set(0, 0, 0.009)
  // Wide flat dimmer rocker paddle (left 75% of Decora opening)
  const paddle = new Mesh(new BoxGeometry(0.022, 0.06, 0.009), mats.whiteNylon)
  paddle.position.set(-0.004, 0, 0.015)
  paddle.rotation.x = 0.06
  // Vertical side dimming slider track + thumb slider bar
  const track = new Mesh(new BoxGeometry(0.005, 0.054, 0.006), mats.darkSteel)
  track.position.set(0.012, 0, 0.013)
  const sliderTab = new Mesh(new BoxGeometry(0.009, 0.01, 0.012), mats.stainlessSteel)
  sliderTab.position.set(0.012, 0.012, 0.018)
  group.add(plate, frame, paddle, track, sliderTab)

  // 5 vertical cyan LED brightness-level indicators on left edge of paddle
  const dotGeo = new BoxGeometry(0.003, 0.003, 0.003)
  for (let i = 0; i < 5; i++) {
    const dot = new Mesh(dotGeo, i < 4 ? mats.accentCyan : mats.darkSteel)
    dot.position.set(-0.017, -0.02 + i * 0.01, 0.015)
    group.add(dot)
  }

  return group
}

/**
 * 4. 20A Tamper-Resistant USB-A / USB-C Duplex Receptacle (NEC 406.12) —
 * 1-gang box + Decora wallplate + dual 20A T-slot outlets + center metallic USB-A & USB-C ports.
 */
export function buildUsbDuplexReceptacleCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-device-usb-duplex-20a'

  const box = buildElectricalBoxCad('single-gang-deep', { mats })
  box.position.set(0, 0, -0.044)
  group.add(box)

  const plate = new Mesh(new BoxGeometry(0.074, 0.118, 0.007), mats.whiteNylon)
  plate.position.set(0, 0, 0.004)
  const face = new Mesh(new BoxGeometry(0.036, 0.072, 0.009), mats.whiteNylon)
  face.position.set(0, 0, 0.01)
  group.add(plate, face)

  // Top & Bottom 20A T-slot outlets
  for (const oy of [0.022, -0.022]) {
    const hot = new Mesh(new BoxGeometry(0.0024, 0.008, 0.003), mats.blackPolymer)
    hot.position.set(0.008, oy + 0.002, 0.015)
    const neutV = new Mesh(new BoxGeometry(0.0024, 0.0095, 0.003), mats.blackPolymer)
    neutV.position.set(-0.008, oy + 0.002, 0.015)
    const neutH = new Mesh(new BoxGeometry(0.0055, 0.0022, 0.003), mats.blackPolymer)
    neutH.position.set(-0.006, oy + 0.002, 0.015)
    const gnd = new Mesh(new CylinderGeometry(0.0026, 0.0026, 0.003, 10), mats.blackPolymer)
    gnd.rotation.x = Math.PI / 2
    gnd.position.set(0, oy - 0.006, 0.015)
    group.add(hot, neutV, neutH, gnd)
  }

  // Center USB-A (rectangular metallic port) & USB-C (slim oval metallic port) + charging LED
  const usbAShell = new Mesh(new BoxGeometry(0.013, 0.006, 0.004), mats.stainlessSteel)
  usbAShell.position.set(-0.006, 0.002, 0.015)
  const usbATongue = new Mesh(new BoxGeometry(0.01, 0.0022, 0.0045), mats.accentBlue)
  usbATongue.position.set(-0.006, 0.0025, 0.0155)
  const usbCShell = new Mesh(new BoxGeometry(0.0095, 0.004, 0.004), mats.stainlessSteel)
  usbCShell.position.set(0.008, 0.002, 0.015)
  const usbCInner = new Mesh(new BoxGeometry(0.007, 0.0018, 0.0045), mats.blackPolymer)
  usbCInner.position.set(0.008, 0.002, 0.0155)
  const chgLed = new Mesh(new CylinderGeometry(0.0018, 0.0018, 0.003, 8), mats.ledGreen)
  chgLed.rotation.x = Math.PI / 2
  chgLed.position.set(0, -0.0045, 0.015)
  group.add(usbAShell, usbATongue, usbCShell, usbCInner, chgLed)

  return group
}

/**
 * 5. Extra-Duty Weatherproof In-Use Bubble Cover (NEC 406.9(B)(1)) —
 * Cast-aluminum FS outdoor bell box + WR GFCI receptacle behind a clear hinged polycarbonate dome hood.
 */
export function buildWeatherproofInUseCoverCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-device-weatherproof-inuse'

  const bellBox = buildWeatherproofBellBoxCad(mats)
  bellBox.position.set(0, 0, -0.028)
  group.add(bellBox)

  // Neoprene gasket + gray mounting collar
  const collar = new Mesh(new BoxGeometry(0.092, 0.142, 0.014), mats.pvcGray)
  collar.position.set(0, 0, 0.008)
  group.add(collar)

  // Visible WR GFCI face inside the translucent cover
  const gfciFace = new Mesh(new BoxGeometry(0.036, 0.072, 0.008), mats.whiteNylon)
  gfciFace.position.set(0, 0, 0.015)
  const testBtn = new Mesh(new BoxGeometry(0.01, 0.006, 0.005), mats.blackPolymer)
  testBtn.position.set(-0.007, 0, 0.02)
  const resetBtn = new Mesh(new BoxGeometry(0.01, 0.006, 0.005), mats.accentRed)
  resetBtn.position.set(0.007, 0, 0.02)
  const led = new Mesh(new CylinderGeometry(0.0022, 0.0022, 0.004, 8), mats.ledGreen)
  led.rotation.x = Math.PI / 2
  led.position.set(0.013, 0.014, 0.02)
  group.add(gfciFace, testBtn, resetBtn, led)

  // Deep translucent extra-duty polycarbonate bubble hood (open bottom cord notches + top hinge + padlock tab)
  const hoodDepth = 0.068
  const hoodBack = new Mesh(new BoxGeometry(0.096, 0.146, hoodDepth), mats.glassDome)
  hoodBack.position.set(0, 0, 0.015 + hoodDepth / 2)
  const hinge = new Mesh(new CylinderGeometry(0.006, 0.006, 0.088, 12), mats.darkSteel)
  hinge.rotation.z = Math.PI / 2
  hinge.position.set(0, 0.074, 0.018)
  const latchTab = new Mesh(new BoxGeometry(0.024, 0.014, 0.016), mats.darkSteel)
  latchTab.position.set(0, -0.074, 0.038)
  group.add(hoodBack, hinge, latchTab)

  return group
}

/**
 * 6. Recessed Solid-Brass Floor Outlet Box (NEC 314.27(B)) —
 * galvanized under-floor rough-in enclosure, thick beveled brushed-brass flush flange,
 * and dual hinged/threaded brass access covers with recessed receptacle.
 */
export function buildBrassFloorBoxCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-device-floor-box-brass'

  // Galvanized under-floor steel box body
  const subBox = new Mesh(new BoxGeometry(0.118, 0.082, 0.118), mats.galvanizedSteel)
  subBox.position.set(0, -0.044, 0)
  group.add(subBox)

  // Side 3/4" conduit entry hubs
  for (const sx of [-1, 1]) {
    const hub = new Mesh(new CylinderGeometry(0.014, 0.014, 0.016, 14), mats.castAluminum)
    hub.rotation.z = Math.PI / 2
    hub.position.set(sx * 0.066, -0.048, 0)
    group.add(hub)
  }

  // Thick beveled solid-brass flush carpet flange
  const flange = new Mesh(new BoxGeometry(0.146, 0.008, 0.146), mats.brass)
  flange.position.set(0, 0.002, 0)
  flange.castShadow = true
  const innerTrim = new Mesh(new BoxGeometry(0.122, 0.004, 0.122), mats.darkSteel)
  innerTrim.position.set(0, 0.005, 0)
  group.add(flange, innerTrim)

  // Dual solid-brass access covers (left closed coin-slot plug, right hinged flap tilted open showing outlet!)
  const leftCap = new Mesh(new CylinderGeometry(0.022, 0.022, 0.005, 20), mats.brass)
  leftCap.position.set(-0.028, 0.008, 0)
  const leftSlot = new Mesh(new BoxGeometry(0.018, 0.002, 0.003), mats.darkSteel)
  leftSlot.position.set(-0.028, 0.011, 0)

  const rightSocket = new Mesh(new BoxGeometry(0.036, 0.005, 0.046), mats.whiteNylon)
  rightSocket.position.set(0.028, 0.007, 0)
  const rightFlap = new Mesh(new BoxGeometry(0.044, 0.004, 0.052), mats.brass)
  rightFlap.position.set(0.046, 0.024, 0)
  rightFlap.rotation.z = -1.05
  group.add(leftCap, leftSlot, rightSocket, rightFlap)

  // 4 corner brass countersunk screws
  const screwGeo = new CylinderGeometry(0.003, 0.003, 0.004, 8)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const sc = new Mesh(screwGeo, mats.stainlessSteel)
      sc.position.set(sx * 0.062, 0.006, sz * 0.062)
      group.add(sc)
    }
  }

  return group
}

/**
 * 7. Hardwired Interconnected 120V Smoke & CO Detector —
 * ceiling mounting ring, sculpted low-profile matte-white housing, radial louver ring,
 * center Test/Hush button & power/status LEDs.
 */
export function buildSmokeCoAlarmCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-device-smoke-co-alarm'

  // Ceiling twist-lock mounting base ring
  const baseRing = new Mesh(new CylinderGeometry(0.072, 0.074, 0.012, 32), mats.whiteNylon)
  baseRing.position.set(0, 0.016, 0)
  // Dark perimeter optical/CO intake louver recess
  const louver = new Mesh(new CylinderGeometry(0.068, 0.068, 0.01, 32), mats.darkSteel)
  louver.position.set(0, 0.006, 0)
  // Main sculpted low-profile white cover dome
  const dome = new Mesh(new CylinderGeometry(0.064, 0.072, 0.024, 32), mats.whiteNylon)
  dome.position.set(0, -0.01, 0)
  dome.castShadow = true
  // Center recessed Test / Hush button + subtle circular groove
  const groove = new Mesh(new TorusGeometry(0.022, 0.0016, 8, 24), mats.nemaGray)
  groove.rotation.x = Math.PI / 2
  groove.position.set(0, -0.022, 0)
  const testBtn = new Mesh(new CylinderGeometry(0.018, 0.019, 0.005, 20), mats.whiteNylon)
  testBtn.position.set(0, -0.023, 0)
  // 120V AC Power green LED + Fault/Alarm amber LED
  const pwrLed = new Mesh(new CylinderGeometry(0.003, 0.003, 0.004, 10), mats.ledGreen)
  pwrLed.position.set(-0.036, -0.022, 0.01)
  const coLed = new Mesh(new CylinderGeometry(0.003, 0.003, 0.004, 10), mats.accentAmber)
  coLed.position.set(0.036, -0.022, 0.01)
  group.add(baseRing, louver, dome, groove, testBtn, pwrLed, coLed)

  return group
}

/**
 * 8. 3/4" Type LL, LR & T Cast-Aluminum Conduit Body Trio (NEC 314.16(C)(2)) —
 * displayed side-by-side with stamped covers, neoprene gaskets, screws, and threaded hubs.
 */
export function buildConduitBodyTrioCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-conduit-body-ll-lr-t-set'

  const makeBody = (kind: 'LL' | 'LR' | 'T'): Group => {
    const g = new Group()
    const body = new Mesh(new BoxGeometry(0.038, 0.128, 0.044), mats.castAluminum)
    const gasket = new Mesh(new BoxGeometry(0.034, 0.114, 0.003), mats.blackPolymer)
    gasket.position.set(0, 0, 0.023)
    const cover = new Mesh(new BoxGeometry(0.036, 0.118, 0.005), mats.galvanizedSteel)
    cover.position.set(0, 0, 0.026)
    g.add(body, gasket, cover)

    const scGeo = new CylinderGeometry(0.0025, 0.0025, 0.006, 8)
    for (const sy of [-0.048, 0.048]) {
      const sc = new Mesh(scGeo, mats.stainlessSteel)
      sc.rotation.x = Math.PI / 2
      sc.position.set(0, sy, 0.029)
      g.add(sc)
    }

    const hubGeo = new CylinderGeometry(0.016, 0.017, 0.028, 14)
    // Top hub on all three
    const topHub = new Mesh(hubGeo, mats.castAluminum)
    topHub.position.set(0, 0.076, 0)
    g.add(topHub)

    if (kind === 'LL' || kind === 'T') {
      const leftHub = new Mesh(hubGeo, mats.castAluminum)
      leftHub.rotation.z = Math.PI / 2
      leftHub.position.set(-0.031, kind === 'T' ? 0 : -0.032, 0)
      g.add(leftHub)
    }
    if (kind === 'LR') {
      const rightHub = new Mesh(hubGeo, mats.castAluminum)
      rightHub.rotation.z = Math.PI / 2
      rightHub.position.set(0.031, -0.032, 0)
      g.add(rightHub)
    }
    if (kind === 'T') {
      const botHub = new Mesh(hubGeo, mats.castAluminum)
      botHub.position.set(0, -0.076, 0)
      g.add(botHub)
    }
    return g
  }

  const ll = makeBody('LL')
  ll.position.set(-0.095, 0, 0)
  const lr = makeBody('LR')
  lr.position.set(0, 0, 0)
  const tee = makeBody('T')
  tee.position.set(0.105, 0, 0)
  group.add(ll, lr, tee)

  return group
}

/**
 * 9. 4"x4"x4ft NEMA-1 Hinged Auxiliary Wireway Gutter (NEC 376) —
 * ANSI-61 gray steel trough with top piano hinges, front quarter-turn latches & end flanges.
 */
export function buildWirewayGutter4x4Cad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-wireway-gutter-4x4'

  const len = 1.219 // 4 ft standard wireway section
  const s = 0.102 // 4 in square cross-section

  // Hollow-look steel trough body + hinged front cover slightly proud
  const trough = new Mesh(new BoxGeometry(len, s, s - 0.008), mats.nemaGray)
  trough.castShadow = true
  const cover = new Mesh(new BoxGeometry(len - 0.008, s - 0.006, 0.008), mats.galvanizedSteel)
  cover.position.set(0, 0, s / 2)
  group.add(trough, cover)

  // End coupling flanges with 4 bolt bosses each
  const flangeGeo = new BoxGeometry(0.012, s + 0.012, s + 0.012)
  for (const sx of [-1, 1]) {
    const fl = new Mesh(flangeGeo, mats.darkSteel)
    fl.position.set(sx * (len / 2 - 0.004), 0, 0)
    group.add(fl)
  }

  // Top hinge knuckles + front quarter-turn cover latches
  const hingeGeo = new CylinderGeometry(0.005, 0.005, 0.048, 8)
  const latchGeo = new CylinderGeometry(0.007, 0.007, 0.008, 12)
  for (const hx of [-0.42, 0, 0.42]) {
    const hinge = new Mesh(hingeGeo, mats.darkSteel)
    hinge.rotation.z = Math.PI / 2
    hinge.position.set(hx, s / 2 + 0.002, s / 2)
    const latch = new Mesh(latchGeo, mats.stainlessSteel)
    latch.rotation.x = Math.PI / 2
    latch.position.set(hx, -s / 2 + 0.018, s / 2 + 0.006)
    group.add(hinge, latch)
  }

  // Concentric knockouts stamped along top & bottom walls
  const koGeo = new CylinderGeometry(0.016, 0.016, 0.003, 14)
  for (let i = 0; i < 6; i++) {
    const kx = -0.48 + i * 0.192
    const ko = new Mesh(koGeo, mats.darkSteel)
    ko.position.set(kx, s / 2 + 0.001, -0.01)
    group.add(ko)
  }

  return group
}

/**
 * 10. 12" Commercial Aluminum Ladder Cable Tray Section (NEC 392) —
 * I-beam side rails, riveted cross rungs, splice plates with stainless bolts & neat commercial feeder bundle.
 */
export function buildLadderCableTrayCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-cable-tray-ladder'

  const len = 1.2
  const w = 0.31 // 12" inside width
  const railH = 0.102 // 4" rail height

  // Left & Right extruded aluminum I-beam rails (web + top/bottom flanges)
  for (const sz of [-1, 1]) {
    const z = sz * (w / 2)
    const web = new Mesh(new BoxGeometry(len, railH, 0.008), mats.castAluminum)
    web.position.set(0, 0, z)
    const topFl = new Mesh(new BoxGeometry(len, 0.01, 0.024), mats.castAluminum)
    topFl.position.set(0, railH / 2 - 0.005, z - sz * 0.006)
    const botFl = new Mesh(new BoxGeometry(len, 0.01, 0.024), mats.castAluminum)
    botFl.position.set(0, -railH / 2 + 0.005, z - sz * 0.006)
    // End splice plates + stainless bolts
    const splice = new Mesh(new BoxGeometry(0.11, railH * 0.72, 0.006), mats.galvanizedSteel)
    splice.position.set(len / 2 - 0.055, 0, z + sz * 0.007)
    group.add(web, topFl, botFl, splice)
  }

  // 6 cross rungs spaced at 9" (225 mm)
  const rungGeo = new BoxGeometry(0.026, 0.016, w - 0.008)
  for (let i = 0; i < 6; i++) {
    const rx = -len / 2 + 0.1 + (i / 5) * (len - 0.2)
    const rung = new Mesh(rungGeo, mats.galvanizedSteel)
    rung.position.set(rx, -railH / 2 + 0.016, 0)
    group.add(rung)
  }

  // Representative bundle of commercial feeder cables (Black / Red / Blue / Orange MC/Tray Cable)
  const cableColors = [mats.blackPolymer, mats.accentRed, mats.accentBlue, mats.accentOrange, mats.groundGreen]
  for (let i = 0; i < cableColors.length; i++) {
    const cab = new Mesh(new CylinderGeometry(0.011, 0.011, len + 0.04, 12), cableColors[i])
    cab.rotation.z = Math.PI / 2
    cab.position.set(0, -railH / 2 + 0.036, -0.08 + i * 0.036)
    group.add(cab)
  }

  return group
}

/**
 * 11. 5/8" Copper-Clad Grounding Electrode Rod + Bronze Acorn Clamp & #6 Bare Copper GEC (NEC 250.52(A)(5)).
 */
export function buildGroundRodAcornClampCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-ground-rod-acorn-clamp'

  const rodH = 0.42 // cutaway top driving-head & clamp assembly proportion for clear CAD inspection
  const rodR = 0.011

  // Copper-clad steel ground rod shaft + pointed driving tip
  const shaft = new Mesh(new CylinderGeometry(rodR, rodR, rodH - 0.045, 16), mats.copper)
  shaft.position.set(0, 0.02, 0)
  const tip = new Mesh(new CylinderGeometry(rodR, 0.001, 0.045, 16), mats.copper)
  tip.position.set(0, -rodH / 2 + 0.018, 0)
  group.add(shaft, tip)

  // Solid bronze direct-burial Acorn Clamp near top of rod
  const clampY = rodH / 2 - 0.08
  const acornRing = new Mesh(new TorusGeometry(0.022, 0.007, 10, 18), mats.brass)
  acornRing.rotation.x = Math.PI / 2
  acornRing.position.set(0.007, clampY, 0)
  const boltBoss = new Mesh(new BoxGeometry(0.024, 0.032, 0.024), mats.brass)
  boltBoss.position.set(0.028, clampY, 0)
  const hexBolt = new Mesh(new CylinderGeometry(0.009, 0.009, 0.032, 6), mats.brass)
  hexBolt.rotation.z = Math.PI / 2
  hexBolt.position.set(0.044, clampY, 0)
  group.add(acornRing, boltBoss, hexBolt)

  // #6 AWG Bare Copper GEC conductor clamped under bolt and rising cleanly toward panel
  const gecVert = new Mesh(new CylinderGeometry(0.0045, 0.0045, 0.13, 10), mats.copper)
  gecVert.position.set(0.02, clampY + 0.045, 0)
  const gecBend = new Mesh(new TorusGeometry(0.028, 0.0045, 10, 16, Math.PI / 2), mats.copper)
  gecBend.position.set(0.048, clampY + 0.11, 0)
  gecBend.rotation.z = Math.PI / 2
  const gecLead = new Mesh(new CylinderGeometry(0.0045, 0.0045, 0.095, 10), mats.copper)
  gecLead.rotation.z = Math.PI / 2
  gecLead.position.set(0.095, clampY + 0.138, 0)
  group.add(gecVert, gecBend, gecLead)

  return group
}

/**
 * 12. 52" Ceiling Fan with Integrated LED Light Kit (NEC 314.27(C) fan-rated box mount) —
 * canopy, downrod, brushed motor housing, 5 angled blades with blade irons & frosted LED dome.
 */
export function buildCeilingFanLightCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-fixture-ceiling-fan-light'

  const bladeMat = new MeshStandardMaterial({
    color: 0x3b2f2f,
    metalness: 0.08,
    roughness: 0.55,
  })

  // Ceiling canopy + steel downrod
  const canopy = new Mesh(new CylinderGeometry(0.078, 0.065, 0.056, 24), mats.darkSteel)
  canopy.position.set(0, 0.15, 0)
  const downrod = new Mesh(new CylinderGeometry(0.013, 0.013, 0.16, 14), mats.stainlessSteel)
  downrod.position.set(0, 0.06, 0)
  // Motor housing
  const motor = new Mesh(new CylinderGeometry(0.145, 0.14, 0.086, 28), mats.darkSteel)
  motor.position.set(0, -0.045, 0)
  motor.castShadow = true
  const motorTrim = new Mesh(new TorusGeometry(0.144, 0.006, 8, 28), mats.stainlessSteel)
  motorTrim.rotation.x = Math.PI / 2
  motorTrim.position.set(0, -0.045, 0)
  group.add(canopy, downrod, motor, motorTrim)

  // 5 angled 52"-span fan blades with stainless blade mounting irons
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5
    const pivot = new Group()
    pivot.rotation.y = angle
    pivot.position.set(0, -0.048, 0)

    const iron = new Mesh(new BoxGeometry(0.11, 0.008, 0.042), mats.stainlessSteel)
    iron.position.set(0.16, 0, 0)
    const blade = new Mesh(new BoxGeometry(0.52, 0.009, 0.125), bladeMat)
    blade.position.set(0.4, 0, 0)
    blade.rotation.x = 0.18 // realistic 10° blade pitch
    blade.castShadow = true
    pivot.add(iron, blade)
    group.add(pivot)
  }

  // Integrated frosted-glass LED light kit dome at bottom center
  const kitRing = new Mesh(new CylinderGeometry(0.115, 0.118, 0.024, 24), mats.darkSteel)
  kitRing.position.set(0, -0.1, 0)
  const ledDome = new Mesh(new CylinderGeometry(0.104, 0.082, 0.046, 24), mats.diffuserWhite)
  ledDome.position.set(0, -0.132, 0)
  group.add(kitRing, ledDome)

  return group
}

/**
 * 13. 24" Hardwired Kitchen Under-Cabinet LED Task Bar (NEC 410) —
 * slim anodized aluminum extrusion, continuous frosted LED diffuser lens, rocker switch & rear KO.
 */
export function buildUnderCabinetLedCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-fixture-under-cabinet-led'

  const len = 0.61 // 24 in
  const h = 0.026
  const d = 0.09

  const housing = new Mesh(new BoxGeometry(len, h, d), mats.stainlessSteel)
  housing.castShadow = true
  // Continuous angled frosted LED diffuser lens underneath
  const diffuser = new Mesh(new BoxGeometry(len - 0.024, 0.008, d * 0.68), mats.diffuserWhite)
  diffuser.position.set(0, -h / 2 - 0.002, 0.006)
  // Front edge low-profile rocker power / CCT switch
  const sw = new Mesh(new BoxGeometry(0.024, 0.011, 0.006), mats.blackPolymer)
  sw.position.set(len / 2 - 0.055, -0.002, d / 2 + 0.002)
  // Rear 1/2" Romex clamp connector
  const romex = new Mesh(new CylinderGeometry(0.009, 0.009, 0.016, 12), mats.castAluminum)
  romex.rotation.x = Math.PI / 2
  romex.position.set(-len * 0.25, 0, -d / 2 - 0.008)
  group.add(housing, diffuser, sw, romex)

  return group
}
