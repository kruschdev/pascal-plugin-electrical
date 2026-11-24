/**
 * Clean-Room MIT Solar PV, Battery Storage (ESS) & Backup Power 3D CAD Builders.
 * Zero React or `@pascal-app/editor` imports.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  TorusGeometry,
} from 'three'
import {
  buildPanelNameplatePlacards,
  type CadMaterialPool,
  createCadMaterialPool,
} from './materials'

/**
 * 1. String Solar PV Inverter (NEC 690) — wall-mounted chassis with rear aluminum heatsink fins,
 * front status visor + OLED display, rotary DC isolator switch, MC4 PV string connectors & AC gland.
 */
export function buildSolarStringInverterCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-solar-inverter-string'

  const w = 0.42
  const h = 0.54
  const d = 0.16

  // Rear extruded aluminum heatsink backplate + vertical cooling fins
  const backplate = new Mesh(new BoxGeometry(w + 0.014, h + 0.01, 0.022), mats.darkSteel)
  backplate.position.set(0, 0, -d / 2 + 0.011)
  group.add(backplate)

  const finGeo = new BoxGeometry(0.008, h - 0.02, 0.032)
  for (let i = 0; i < 11; i++) {
    const fx = -w * 0.46 + (i / 10) * (w * 0.92)
    const fin = new Mesh(finGeo, mats.castAluminum)
    fin.position.set(fx, 0, -d / 2 - 0.014)
    group.add(fin)
  }

  // Main powder-coated white/slate inverter chassis
  const body = new Mesh(new BoxGeometry(w, h, d - 0.022), mats.whiteNylon)
  body.position.set(0, 0, 0.011)
  body.castShadow = true
  group.add(body)

  // Sculpted upper charcoal display visor + glowing cyan OLED readout + status LEDs
  const visor = new Mesh(new BoxGeometry(w * 0.88, 0.145, 0.014), mats.blackPolymer)
  visor.position.set(0, h * 0.24, d / 2 + 0.007)
  const screenBezel = new Mesh(new BoxGeometry(0.14, 0.072, 0.004), mats.darkSteel)
  screenBezel.position.set(-0.07, h * 0.24, d / 2 + 0.015)
  const oled = new Mesh(new BoxGeometry(0.124, 0.056, 0.003), mats.accentCyan)
  oled.position.set(-0.07, h * 0.24, d / 2 + 0.017)
  const ledOk = new Mesh(new CylinderGeometry(0.006, 0.006, 0.005, 12), mats.ledGreen)
  ledOk.rotation.x = Math.PI / 2
  ledOk.position.set(0.08, h * 0.265, d / 2 + 0.016)
  const ledGrid = new Mesh(new CylinderGeometry(0.006, 0.006, 0.005, 12), mats.accentBlue)
  ledGrid.rotation.x = Math.PI / 2
  ledGrid.position.set(0.11, h * 0.265, d / 2 + 0.016)
  // PV solar accent trim bar under visor
  const pvBar = new Mesh(new BoxGeometry(w * 0.88, 0.014, 0.008), mats.accentAmber)
  pvBar.position.set(0, h * 0.085, d / 2 + 0.006)
  group.add(visor, screenBezel, oled, ledOk, ledGrid, pvBar)

  // Lower wiring compartment seam + integrated Rotary DC Disconnect Switch (NEC 690.15)
  const wireBay = new Mesh(new BoxGeometry(w * 0.94, 0.145, 0.012), mats.nemaGray)
  wireBay.position.set(0, -h * 0.32, d / 2 + 0.006)
  const dcBase = new Mesh(new BoxGeometry(0.072, 0.072, 0.016), mats.blackPolymer)
  dcBase.position.set(-0.1, -h * 0.32, d / 2 + 0.018)
  const dcKnob = new Mesh(new BoxGeometry(0.054, 0.016, 0.024), mats.accentRed)
  dcKnob.position.set(-0.1, -h * 0.32, d / 2 + 0.032)
  dcKnob.rotation.z = Math.PI / 4
  // NEC 690.31 red PV DC warning placard on wiring bay
  const pvWarn = new Mesh(new BoxGeometry(0.11, 0.042, 0.003), mats.accentRed)
  pvWarn.position.set(0.085, -h * 0.32, d / 2 + 0.013)
  const pvWarnText = new Mesh(new BoxGeometry(0.086, 0.005, 0.002), mats.whiteNylon)
  pvWarnText.position.set(0.085, -h * 0.32, d / 2 + 0.015)
  group.add(wireBay, dcBase, dcKnob, pvWarn, pvWarnText)

  // Bottom MC4 PV DC string connectors (4 pairs) + AC output conduit gland
  const mc4Geo = new CylinderGeometry(0.009, 0.01, 0.036, 10)
  for (let i = 0; i < 4; i++) {
    const mc4 = new Mesh(mc4Geo, i % 2 === 0 ? mats.accentRed : mats.blackPolymer)
    mc4.position.set(-0.15 + i * 0.034, -h / 2 - 0.016, 0.01)
    group.add(mc4)
  }
  const acHub = new Mesh(new CylinderGeometry(0.018, 0.02, 0.036, 14), mats.castAluminum)
  acHub.position.set(0.12, -h / 2 - 0.016, 0.01)
  group.add(acHub)

  return group
}

/**
 * 2. Wall-Mounted Home Battery Energy Storage System (ESS, NEC 706) — 13.5 kWh architectural wall pack
 * with beveled white fascia, recessed dark aluminum perimeter frame, glowing side LED bar, and conduit entry.
 */
export function buildWallBatteryEssCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-battery-wall-ess'

  const w = 0.74
  const h = 1.12
  const d = 0.155

  // Rear dark aluminum structural chassis + cooling channel
  const chassis = new Mesh(new BoxGeometry(w, h, d * 0.65), mats.darkSteel)
  chassis.position.set(0, 0, -d * 0.175)
  chassis.castShadow = true
  group.add(chassis)

  // Architectural beveled matte-white front fascia plate
  const fascia = new Mesh(new BoxGeometry(w - 0.028, h - 0.028, d * 0.36), mats.whiteNylon)
  fascia.position.set(0, 0, d * 0.31)
  fascia.castShadow = true
  group.add(fascia)

  // Subtle recessed dark perimeter accent trim + vertical brand shadow line
  const accentLine = new Mesh(new BoxGeometry(0.006, h * 0.82, 0.004), mats.nemaGray)
  accentLine.position.set(-w * 0.36, 0, d * 0.492)
  // Glowing vertical cyan charge-status LED lightpipe on right edge
  const statusLed = new Mesh(new BoxGeometry(0.012, 0.24, 0.008), mats.accentCyan)
  statusLed.position.set(w / 2 - 0.004, h * 0.16, d * 0.18)
  // Integrated NEC 706.15 side enable/shutoff toggle switch
  const switchBezel = new Mesh(new BoxGeometry(0.014, 0.072, 0.044), mats.blackPolymer)
  switchBezel.position.set(w / 2 + 0.005, -h * 0.12, 0.01)
  const switchToggle = new Mesh(new BoxGeometry(0.018, 0.032, 0.018), mats.accentRed)
  switchToggle.position.set(w / 2 + 0.013, -h * 0.12, 0.01)
  group.add(accentLine, statusLed, switchBezel, switchToggle)

  // Top exhaust vent louver grille
  const ventGeo = new BoxGeometry(w * 0.76, 0.006, 0.014)
  for (let i = 0; i < 4; i++) {
    const v = new Mesh(ventGeo, mats.blackPolymer)
    v.position.set(0, h / 2 + 0.002, -0.04 + i * 0.022)
    group.add(v)
  }

  // Lower right conduit wiring hub + compact ESS NEC 706 placard
  const hub = new Mesh(new CylinderGeometry(0.018, 0.02, 0.034, 14), mats.castAluminum)
  hub.position.set(w * 0.32, -h / 2 - 0.015, -0.01)
  const placard = new Mesh(new BoxGeometry(0.09, 0.032, 0.003), mats.darkSteel)
  placard.position.set(0, -h * 0.38, d * 0.492)
  const placardLine = new Mesh(new BoxGeometry(0.06, 0.003, 0.002), mats.stainlessSteel)
  placardLine.position.set(0, -h * 0.38, d * 0.494)
  group.add(hub, placard, placardLine)

  return group
}

/**
 * 3. 200A Automatic Transfer Switch (ATS, NEC 702) — NEMA-3R service-entrance rated enclosure
 * with sloped rain hood, utility/generator status indicators, manual override handle & feeder hubs.
 */
export function buildAutomaticTransferSwitchCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-transfer-switch-200a'

  const w = 0.42
  const h = 0.68
  const d = 0.18

  // NEMA-3R gray steel enclosure + sloped raintight roof hood
  const box = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  box.castShadow = true
  const hood = new Mesh(new BoxGeometry(w + 0.032, 0.028, d + 0.04), mats.nemaGray)
  hood.position.set(0, h / 2 + 0.014, 0.014)
  hood.rotation.x = 0.08
  const topHub = new Mesh(new CylinderGeometry(0.032, 0.034, 0.03, 16), mats.castAluminum)
  topHub.position.set(0, h / 2 + 0.038, 0)
  group.add(box, hood, topHub)

  // Hinged front door + stainless latch + engraved nameplate / arc-flash placard
  const door = new Mesh(new BoxGeometry(w - 0.026, h - 0.04, 0.012), mats.galvanizedSteel)
  door.position.set(0, -0.008, d / 2 + 0.006)
  const placards = buildPanelNameplatePlacards({
    panelWidth: w,
    yCenter: h * 0.33,
    zFront: d / 2 + 0.012,
    voltageSystem: '120/240V-1P',
    mats,
  })
  group.add(door, placards)

  // Transfer controller status bezel (Utility Green + Generator Amber + Load Cyan LEDs)
  const ctrlPanel = new Mesh(new BoxGeometry(0.18, 0.088, 0.01), mats.blackPolymer)
  ctrlPanel.position.set(0, h * 0.06, d / 2 + 0.016)
  const utilLed = new Mesh(new CylinderGeometry(0.009, 0.009, 0.006, 12), mats.ledGreen)
  utilLed.rotation.x = Math.PI / 2
  utilLed.position.set(-0.052, h * 0.075, d / 2 + 0.022)
  const genLed = new Mesh(new CylinderGeometry(0.009, 0.009, 0.006, 12), mats.accentAmber)
  genLed.rotation.x = Math.PI / 2
  genLed.position.set(0, h * 0.075, d / 2 + 0.022)
  const loadLed = new Mesh(new CylinderGeometry(0.009, 0.009, 0.006, 12), mats.accentCyan)
  loadLed.rotation.x = Math.PI / 2
  loadLed.position.set(0.052, h * 0.075, d / 2 + 0.022)
  const ledLabels = new Mesh(new BoxGeometry(0.14, 0.006, 0.002), mats.stainlessSteel)
  ledLabels.position.set(0, h * 0.036, d / 2 + 0.022)
  group.add(ctrlPanel, utilLed, genLed, loadLed, ledLabels)

  // Service disconnect / manual transfer throw handle + padlockable latch
  const latch = new Mesh(new BoxGeometry(0.026, 0.08, 0.016), mats.darkSteel)
  latch.position.set(w * 0.4, -0.02, d / 2 + 0.016)
  const throwBase = new Mesh(new BoxGeometry(0.036, 0.14, 0.034), mats.darkSteel)
  throwBase.position.set(w / 2 + 0.018, h * 0.1, 0.02)
  const throwGrip = new Mesh(new CylinderGeometry(0.013, 0.013, 0.11, 12), mats.accentRed)
  throwGrip.rotation.z = Math.PI / 2
  throwGrip.position.set(w / 2 + 0.056, h * 0.15, 0.02)
  group.add(latch, throwBase, throwGrip)

  // Bottom feeder knockouts / hubs (Utility / Load / Generator)
  for (const bx of [-0.12, 0, 0.12]) {
    const bHub = new Mesh(new CylinderGeometry(0.022, 0.024, 0.024, 14), mats.castAluminum)
    bHub.position.set(bx, -h / 2 - 0.01, 0)
    group.add(bHub)
  }

  return group
}

/**
 * 4. 50A NEMA SS2-50P Weatherproof Generator Power Inlet Box (NEC 702.7) —
 * raintight outdoor box with hinged spring-flip lid & recessed 50A twist-lock male prongs.
 */
export function buildGeneratorInletBoxCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-generator-inlet-50a'

  const w = 0.115
  const h = 0.175
  const d = 0.105

  // Heavy-duty powder-coated NEMA-3R steel housing
  const body = new Mesh(new BoxGeometry(w, h, d), mats.nemaGray)
  body.castShadow = true
  // Top sloped weather shield lip
  const roof = new Mesh(new BoxGeometry(w + 0.014, 0.014, d + 0.02), mats.nemaGray)
  roof.position.set(0, h / 2 + 0.004, 0.006)
  roof.rotation.x = 0.12
  group.add(body, roof)

  // Recessed circular SS2-50P flanged male twist-lock inlet on lower front face
  const flange = new Mesh(new CylinderGeometry(0.038, 0.04, 0.018, 20), mats.blackPolymer)
  flange.rotation.x = Math.PI / 2
  flange.position.set(0, -0.015, d / 2 + 0.008)
  const collar = new Mesh(new TorusGeometry(0.032, 0.005, 10, 20), mats.stainlessSteel)
  collar.position.set(0, -0.015, d / 2 + 0.018)
  group.add(flange, collar)

  // 3 curved brass 50A twist-lock male blades + center locking ground pin
  const prongGeo = new BoxGeometry(0.005, 0.012, 0.016)
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 + Math.PI / 6
    const prong = new Mesh(prongGeo, mats.brass)
    prong.position.set(Math.cos(a) * 0.018, -0.015 + Math.sin(a) * 0.018, d / 2 + 0.018)
    prong.rotation.z = a
    group.add(prong)
  }
  const centerPin = new Mesh(new CylinderGeometry(0.004, 0.004, 0.018, 10), mats.brass)
  centerPin.rotation.x = Math.PI / 2
  centerPin.position.set(0, -0.015, d / 2 + 0.018)
  group.add(centerPin)

  // Hinged spring-flip weather lid tilted slightly open so the 50A inlet is clearly recognizable
  const lid = new Mesh(new BoxGeometry(w - 0.01, 0.095, 0.008), mats.darkSteel)
  lid.position.set(0, 0.042, d / 2 + 0.036)
  lid.rotation.x = -0.82
  const lidStripe = new Mesh(new BoxGeometry(0.068, 0.018, 0.003), mats.accentAmber)
  lidStripe.position.set(0, 0.056, d / 2 + 0.042)
  lidStripe.rotation.x = -0.82
  group.add(lid, lidStripe)

  // Side 1" conduit knockout hub
  const ko = new Mesh(new CylinderGeometry(0.014, 0.014, 0.014, 14), mats.castAluminum)
  ko.rotation.z = Math.PI / 2
  ko.position.set(w / 2 + 0.006, 0.02, 0)
  group.add(ko)

  return group
}

/**
 * 5. NEC 690.12 PV Rapid Shutdown / Emergency AC Disconnect Switch —
 * NEMA-4X polycarbonate housing with high-visibility yellow escutcheon & red padlockable rotary handle.
 */
export function buildPvRapidShutdownCad(matsInput?: CadMaterialPool): Group {
  const mats = matsInput ?? createCadMaterialPool()
  const group = new Group()
  group.name = 'cad-ac-rapid-shutdown'

  const w = 0.155
  const h = 0.205
  const d = 0.105

  // NEMA-4X polycarbonate enclosure with 4 corner cover screws
  const body = new Mesh(new BoxGeometry(w, h, d), mats.pvcGray)
  body.castShadow = true
  const lid = new Mesh(new BoxGeometry(w + 0.006, h + 0.006, 0.022), mats.nemaGray)
  lid.position.set(0, 0, d / 2 + 0.006)
  group.add(body, lid)

  const screwGeo = new CylinderGeometry(0.0045, 0.0045, 0.006, 8)
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const s = new Mesh(screwGeo, mats.stainlessSteel)
      s.rotation.x = Math.PI / 2
      s.position.set(sx * (w / 2 - 0.016), sy * (h / 2 - 0.016), d / 2 + 0.018)
      group.add(s)
    }
  }

  // High-visibility yellow safety escutcheon + chunky red rotary emergency handle (LOTO)
  const yellowPlate = new Mesh(new BoxGeometry(0.094, 0.094, 0.01), mats.accentAmber)
  yellowPlate.position.set(0, 0.016, d / 2 + 0.02)
  const dialRing = new Mesh(new CylinderGeometry(0.03, 0.032, 0.014, 20), mats.blackPolymer)
  dialRing.rotation.x = Math.PI / 2
  dialRing.position.set(0, 0.016, d / 2 + 0.028)
  const redHandle = new Mesh(new BoxGeometry(0.068, 0.02, 0.026), mats.accentRed)
  redHandle.position.set(0, 0.016, d / 2 + 0.042)
  redHandle.rotation.z = -Math.PI / 4
  group.add(yellowPlate, dialRing, redHandle)

  // Red NEC 690.12 Rapid Shutdown identification placard below handle
  const badge = new Mesh(new BoxGeometry(0.118, 0.036, 0.003), mats.accentRed)
  badge.position.set(0, -0.064, d / 2 + 0.018)
  const badgeLine = new Mesh(new BoxGeometry(0.092, 0.004, 0.002), mats.whiteNylon)
  badgeLine.position.set(0, -0.064, d / 2 + 0.02)
  group.add(badge, badgeLine)

  // Top & bottom 3/4" watertight conduit glands
  const glandGeo = new CylinderGeometry(0.015, 0.017, 0.028, 14)
  const topG = new Mesh(glandGeo, mats.blackPolymer)
  topG.position.set(0, h / 2 + 0.014, 0)
  const botG = new Mesh(glandGeo, mats.blackPolymer)
  botG.position.set(0, -h / 2 - 0.014, 0)
  group.add(topG, botG)

  return group
}
