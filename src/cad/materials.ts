/**
 * Render-safe PBR material factory for clean-room NEC/NEMA electrical CAD models.
 * Fresh material pools are allocated per build call so host geometry disposal
 * never invalidates materials held by other nodes in a Pascal scene.
 */

import { DoubleSide, MeshStandardMaterial } from 'three'
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
