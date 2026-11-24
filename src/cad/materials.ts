/**
 * Render-safe PBR material factory for clean-room NEC/NEMA electrical CAD models.
 * Fresh material pools are allocated per build call so host geometry disposal
 * never invalidates materials held by other nodes in a Pascal scene.
 */

import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial } from 'three'
import type { VoltageSystem, WireGauge } from '../nec/tables'

export type CadMaterialPool = {
  galvanizedSteel: MeshStandardMaterial
  nemaGray: MeshStandardMaterial
  darkSteel: MeshStandardMaterial
  stainlessSteel: MeshStandardMaterial
  castAluminum: MeshStandardMaterial
  carlonBluePvc: MeshStandardMaterial
  pvcGray: MeshStandardMaterial
  whiteNylon: MeshStandardMaterial
  blackPolymer: MeshStandardMaterial
  copper: MeshStandardMaterial
  brass: MeshStandardMaterial
  groundGreen: MeshStandardMaterial
  accentRed: MeshStandardMaterial
  accentBlue: MeshStandardMaterial
  accentAmber: MeshStandardMaterial
  accentCyan: MeshStandardMaterial
  accentOrange: MeshStandardMaterial
  ledGreen: MeshStandardMaterial
  diffuserWhite: MeshStandardMaterial
  glassDome: MeshStandardMaterial
}

export function createCadMaterialPool(): CadMaterialPool {
  return {
    galvanizedSteel: new MeshStandardMaterial({
      color: 0xb8c2cc,
      metalness: 0.72,
      roughness: 0.36,
      side: DoubleSide,
    }),
    nemaGray: new MeshStandardMaterial({
      color: 0x6b7480,
      metalness: 0.25,
      roughness: 0.55,
    }),
    darkSteel: new MeshStandardMaterial({
      color: 0x374151,
      metalness: 0.45,
      roughness: 0.48,
    }),
    stainlessSteel: new MeshStandardMaterial({
      color: 0xd1d8e0,
      metalness: 0.85,
      roughness: 0.22,
    }),
    castAluminum: new MeshStandardMaterial({
      color: 0x9aa5b1,
      metalness: 0.65,
      roughness: 0.44,
    }),
    carlonBluePvc: new MeshStandardMaterial({
      color: 0x1d6fd6,
      metalness: 0.04,
      roughness: 0.46,
      side: DoubleSide,
    }),
    pvcGray: new MeshStandardMaterial({
      color: 0x64748b,
      metalness: 0.05,
      roughness: 0.52,
    }),
    whiteNylon: new MeshStandardMaterial({
      color: 0xf1f5f9,
      metalness: 0.02,
      roughness: 0.42,
    }),
    blackPolymer: new MeshStandardMaterial({
      color: 0x1e242c,
      metalness: 0.06,
      roughness: 0.55,
    }),
    copper: new MeshStandardMaterial({
      color: 0xc87533,
      metalness: 0.88,
      roughness: 0.28,
    }),
    brass: new MeshStandardMaterial({
      color: 0xd4a63a,
      metalness: 0.84,
      roughness: 0.3,
    }),
    groundGreen: new MeshStandardMaterial({
      color: 0x16a34a,
      metalness: 0.4,
      roughness: 0.38,
    }),
    accentRed: new MeshStandardMaterial({
      color: 0xdc2626,
      metalness: 0.15,
      roughness: 0.4,
    }),
    accentBlue: new MeshStandardMaterial({
      color: 0x2563eb,
      metalness: 0.15,
      roughness: 0.4,
    }),
    accentAmber: new MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.15,
      roughness: 0.42,
    }),
    accentCyan: new MeshStandardMaterial({
      color: 0x06b6d4,
      metalness: 0.2,
      roughness: 0.35,
      emissive: 0x0891b2,
      emissiveIntensity: 0.35,
    }),
    accentOrange: new MeshStandardMaterial({
      color: 0xea580c,
      metalness: 0.15,
      roughness: 0.42,
    }),
    ledGreen: new MeshStandardMaterial({
      color: 0x22c55e,
      emissive: 0x16a34a,
      emissiveIntensity: 0.6,
      roughness: 0.25,
    }),
    diffuserWhite: new MeshStandardMaterial({
      color: 0xfefce8,
      emissive: 0xfef08a,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    }),
    glassDome: new MeshStandardMaterial({
      color: 0xdbeafe,
      metalness: 0.1,
      roughness: 0.08,
      transparent: true,
      opacity: 0.45,
    }),
  }
}

export function voltageAccentMaterial(
  mats: CadMaterialPool,
  voltageSystem: VoltageSystem,
): MeshStandardMaterial {
  if (voltageSystem === '277/480V-3P') return mats.accentRed
  if (voltageSystem === '120/208V-3P') return mats.accentBlue
  return mats.accentAmber
}

export function nmbJacketColor(gauge: WireGauge): number {
  if (gauge === '14') return 0xe2e8f0 // 14 AWG NM-B white
  if (gauge === '12') return 0xeab308 // 12 AWG NM-B yellow
  if (gauge === '10') return 0xf97316 // 10 AWG NM-B orange
  return 0x1e293b // 8/6 AWG NM-B black
}

/**
 * Build realistic engraved NEMA panelboard nameplate + compact NEC 110.16 arc-flash warning placard.
 * Replaces wide abstract color stripes with authentic phenolic nameplate & ANSI Z535 safety label geometry.
 */
export function buildPanelNameplatePlacards(opts: {
  panelWidth: number
  yCenter: number
  zFront: number
  voltageSystem: VoltageSystem
  mats: CadMaterialPool
}): Group {
  const { panelWidth, yCenter, zFront, voltageSystem, mats } = opts
  const g = new Group()
  g.name = 'panel-nameplate-placards'

  // 1. Engraved NEMA Phenolic Panelboard Nameplate (centered-left or centered)
  const npW = Math.min(0.128, panelWidth * 0.34)
  const npH = 0.03
  const hasRoomForSidePlacard = panelWidth >= 0.34
  const npX = hasRoomForSidePlacard ? -panelWidth * 0.14 : 0

  const npBorder = new Mesh(new BoxGeometry(npW, npH, 0.002), mats.stainlessSteel)
  npBorder.position.set(npX, yCenter, zFront + 0.001)
  const npFace = new Mesh(new BoxGeometry(npW - 0.006, npH - 0.006, 0.0016), mats.blackPolymer)
  npFace.position.set(npX, yCenter, zFront + 0.002)
  // Subtle left-edge voltage-class pip (Amber 120/240V, Blue 120/208V, Red 277/480V)
  const pipW = 0.008
  const npPip = new Mesh(
    new BoxGeometry(pipW, npH - 0.008, 0.0012),
    voltageAccentMaterial(mats, voltageSystem),
  )
  npPip.position.set(npX - (npW - 0.008) / 2 + pipW / 2, yCenter, zFront + 0.0026)
  // Engraved metallic rating text rules
  const line1 = new Mesh(new BoxGeometry(npW * 0.54, 0.0032, 0.001), mats.whiteNylon)
  line1.position.set(npX + 0.006, yCenter + 0.0045, zFront + 0.0028)
  const line2 = new Mesh(new BoxGeometry(npW * 0.4, 0.0022, 0.001), mats.stainlessSteel)
  line2.position.set(npX + 0.002, yCenter - 0.0045, zFront + 0.0028)
  g.add(npBorder, npFace, npPip, line1, line2)

  // Two tiny stainless nameplate rivets
  const rivetGeo = new CylinderGeometry(0.0016, 0.0016, 0.0016, 8)
  for (const sx of [-1, 1]) {
    const r = new Mesh(rivetGeo, mats.stainlessSteel)
    r.rotation.x = Math.PI / 2
    r.position.set(npX + sx * (npW / 2 - 0.0045), yCenter, zFront + 0.0026)
    g.add(r)
  }

  // 2. Compact NEC 110.16 Arc-Flash Warning Placard (ANSI Z535 orange WARNING / red DANGER on 480V)
  const afW = Math.min(0.074, panelWidth * 0.2)
  const afH = 0.044
  const afX = hasRoomForSidePlacard ? panelWidth * 0.22 : 0
  const afY = hasRoomForSidePlacard ? yCenter : yCenter - 0.044

  const afBack = new Mesh(new BoxGeometry(afW, afH, 0.0018), mats.whiteNylon)
  afBack.position.set(afX, afY, zFront + 0.001)
  const afHeaderMat = voltageSystem === '277/480V-3P' ? mats.accentRed : mats.accentOrange
  const afHeader = new Mesh(new BoxGeometry(afW - 0.004, afH * 0.3, 0.0012), afHeaderMat)
  afHeader.position.set(afX, afY + afH * 0.31, zFront + 0.0018)
  const afTitleBar = new Mesh(new BoxGeometry(afW * 0.52, 0.0026, 0.0008), mats.blackPolymer)
  afTitleBar.position.set(afX, afY + afH * 0.31, zFront + 0.0024)
  g.add(afBack, afHeader, afTitleBar)

  for (let i = 0; i < 3; i++) {
    const ruleW = afW * (i === 0 ? 0.78 : i === 1 ? 0.68 : 0.5)
    const rule = new Mesh(new BoxGeometry(ruleW, 0.002, 0.0008), mats.darkSteel)
    rule.position.set(afX - (afW * 0.78 - ruleW) / 2, afY + 0.002 - i * 0.0065, zFront + 0.0019)
    g.add(rule)
  }

  return g
}
