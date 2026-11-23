/**
 * Clean-room NEC Article 314.16 / NEMA OS-1 / OS-2 Electrical Box 3D CAD Builders.
 * All dimensions are standard trade dimensions in meters (1 in = 0.0254 m).
 * Origin convention: front opening lies on z = 0, box extends into -Z (wall cavity).
 */

import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import type { BoxType } from '../nec/tables'
import { type CadMaterialPool, createCadMaterialPool } from './materials'

const IN = 0.0254

type BoxDimensionsSpec = {
  kind: 'pvc-gang' | 'steel-square' | 'steel-oct'
  widthIn: number
  heightIn: number
  depthIn: number
  gangs?: 1 | 2 | 3
}

export const BOX_DIMENSIONS_IN: Record<BoxType, BoxDimensionsSpec> = {
  'single-gang-shallow': { kind: 'pvc-gang', widthIn: 2.25, heightIn: 3.75, depthIn: 2.25, gangs: 1 },
  'single-gang-standard': { kind: 'pvc-gang', widthIn: 2.25, heightIn: 3.75, depthIn: 2.75, gangs: 1 },
  'single-gang-deep': { kind: 'pvc-gang', widthIn: 2.25, heightIn: 3.75, depthIn: 3.5, gangs: 1 },
  'two-gang-standard': { kind: 'pvc-gang', widthIn: 4.0, heightIn: 3.75, depthIn: 2.75, gangs: 2 },
  'two-gang-deep': { kind: 'pvc-gang', widthIn: 4.0, heightIn: 3.75, depthIn: 3.25, gangs: 2 },
  'three-gang-standard': { kind: 'pvc-gang', widthIn: 5.75, heightIn: 3.75, depthIn: 2.75, gangs: 3 },
  '4-sq-1.25': { kind: 'steel-square', widthIn: 4.0, heightIn: 4.0, depthIn: 1.25 },
  '4-sq-1.5': { kind: 'steel-square', widthIn: 4.0, heightIn: 4.0, depthIn: 1.5 },
  '4-sq-2.125': { kind: 'steel-square', widthIn: 4.0, heightIn: 4.0, depthIn: 2.125 },
  '4-11-16-1.5': { kind: 'steel-square', widthIn: 4.6875, heightIn: 4.6875, depthIn: 1.5 },
  '4-11-16-2.125': { kind: 'steel-square', widthIn: 4.6875, heightIn: 4.6875, depthIn: 2.125 },
  '4-oct-1.5': { kind: 'steel-oct', widthIn: 4.0, heightIn: 4.0, depthIn: 1.5 },
  '4-oct-2.125': { kind: 'steel-oct', widthIn: 4.0, heightIn: 4.0, depthIn: 2.125 },
}

function addHollowRectShell(
  group: Group,
  w: number,
  h: number,
  d: number,
  wall: number,
  mat: CadMaterialPool['carlonBluePvc'] | CadMaterialPool['galvanizedSteel'],
): void {
  // Back plate at z = -d + wall/2
  const back = new Mesh(new BoxGeometry(w, h, wall), mat)
  back.position.set(0, 0, -d + wall / 2)
  back.castShadow = true
  back.receiveShadow = true
  group.add(back)

  // Top & bottom walls
  const horizGeo = new BoxGeometry(w, wall, d)
  const top = new Mesh(horizGeo, mat)
  top.position.set(0, h / 2 - wall / 2, -d / 2)
  top.castShadow = true
  const bottom = new Mesh(horizGeo, mat)
  bottom.position.set(0, -h / 2 + wall / 2, -d / 2)
  bottom.castShadow = true
  group.add(top, bottom)

  // Left & right walls
  const sideGeo = new BoxGeometry(wall, h - 2 * wall, d)
  const left = new Mesh(sideGeo, mat)
  left.position.set(-w / 2 + wall / 2, 0, -d / 2)
  left.castShadow = true
  const right = new Mesh(sideGeo, mat)
  right.position.set(w / 2 - wall / 2, 0, -d / 2)
  right.castShadow = true
  group.add(left, right)
}

function addKnockout(
  group: Group,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z',
  radius: number,
  mats: CadMaterialPool,
): void {
  const outer = new Mesh(new CylinderGeometry(radius, radius, 0.0022, 16), mats.darkSteel)
  const inner = new Mesh(new CylinderGeometry(radius * 0.72, radius * 0.72, 0.0026, 16), mats.galvanizedSteel)
  if (axis === 'x') {
    outer.rotation.z = Math.PI / 2
    inner.rotation.z = Math.PI / 2
  } else if (axis === 'z') {
    outer.rotation.x = Math.PI / 2
    inner.rotation.x = Math.PI / 2
  }
  outer.position.set(x, y, z)
  inner.position.set(x, y, z)
  group.add(outer, inner)
}

export type ElectricalBoxCadOptions = {
  includeCover?: boolean
  includeMudRing?: boolean
  includeEmtConnectors?: boolean
  mats?: CadMaterialPool
}

export function buildElectricalBoxCad(
  boxType: BoxType,
  opts: ElectricalBoxCadOptions = {},
): Group {
  const mats = opts.mats ?? createCadMaterialPool()
  const spec = BOX_DIMENSIONS_IN[boxType]
  const group = new Group()
  group.name = `cad-box-${boxType}`

  const w = spec.widthIn * IN
  const h = spec.heightIn * IN
  const d = spec.depthIn * IN

  if (spec.kind === 'pvc-gang') {
    const wall = 0.0032
    addHollowRectShell(group, w, h, d, wall, mats.carlonBluePvc)

    // Top & bottom angled stud-mount nail bosses + galvanized nails on right stud face
    const nailGeo = new CylinderGeometry(0.0018, 0.0018, 0.055, 8)
    const headGeo = new CylinderGeometry(0.0042, 0.0042, 0.002, 10)
    const sleeveGeo = new BoxGeometry(0.016, 0.014, 0.016)
    for (const signY of [1, -1]) {
      const sleeve = new Mesh(sleeveGeo, mats.carlonBluePvc)
      sleeve.position.set(w / 2 - 0.006, signY * (h / 2 + 0.007), -d * 0.35)
      group.add(sleeve)

      const nail = new Mesh(nailGeo, mats.galvanizedSteel)
      nail.rotation.z = Math.PI / 2 - signY * 0.22
      nail.position.set(w / 2 + 0.015, signY * (h / 2 + 0.011), -d * 0.35)
      group.add(nail)

      const head = new Mesh(headGeo, mats.galvanizedSteel)
      head.rotation.z = Math.PI / 2 - signY * 0.22
      head.position.set(w / 2 - 0.012, signY * (h / 2 + 0.005), -d * 0.35)
      group.add(head)
    }

    // Internal brass 6-32 mounting ears per gang
    const gangs = spec.gangs ?? 1
    const bossGeo = new CylinderGeometry(0.004, 0.004, 0.01, 10)
    const screwGeo = new CylinderGeometry(0.002, 0.002, 0.012, 8)
    for (let g = 0; g < gangs; g++) {
      const gx = (g - (gangs - 1) / 2) * (1.8125 * IN)
      for (const signY of [1, -1]) {
        const boss = new Mesh(bossGeo, mats.carlonBluePvc)
        boss.rotation.x = Math.PI / 2
        boss.position.set(gx, signY * (h / 2 - 0.007), -0.006)
        const screw = new Mesh(screwGeo, mats.brass)
        screw.rotation.x = Math.PI / 2
        screw.position.set(gx, signY * (h / 2 - 0.007), -0.005)
        group.add(boss, screw)
      }
      // Molded rear NM-B cable entry clamp flaps
      const flap = new Mesh(new BoxGeometry(0.022, 0.014, 0.003), mats.carlonBluePvc)
      flap.position.set(gx, h * 0.26, -d + 0.004)
      group.add(flap)
    }

    // Depth positioning stop tabs on front flange
    const tabGeo = new BoxGeometry(0.008, 0.018, 0.003)
    for (const signY of [1, -1]) {
      const tab = new Mesh(tabGeo, mats.carlonBluePvc)
      tab.position.set(w / 2 + 0.003, signY * (h * 0.3), -0.013)
      group.add(tab)
    }
    return group
  }

  if (spec.kind === 'steel-oct') {
    const outerR = w / 2
    const wall = 0.0018
    // 8-sided outer wall shell (built from 8 flat side panels + octagonal back)
    const back = new Mesh(new CylinderGeometry(outerR, outerR, wall, 8), mats.galvanizedSteel)
    back.rotation.x = Math.PI / 2
    back.rotation.z = Math.PI / 8
    back.position.set(0, 0, -d + wall / 2)
    group.add(back)

    const sideWidth = 2 * outerR * Math.sin(Math.PI / 8)
    const apothem = outerR * Math.cos(Math.PI / 8)
    const panelGeo = new BoxGeometry(sideWidth + 0.001, wall, d)
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4
      const side = new Mesh(panelGeo, mats.galvanizedSteel)
      side.position.set(Math.sin(angle) * (apothem - wall / 2), Math.cos(angle) * (apothem - wall / 2), -d / 2)
      side.rotation.z = -angle
      group.add(side)
    }

    // 4 cardinal concentric knockouts + back knockouts
    const koR = 0.011
    addKnockout(group, 0, apothem, -d * 0.52, 'y', koR, mats)
    addKnockout(group, 0, -apothem, -d * 0.52, 'y', koR, mats)
    addKnockout(group, apothem, 0, -d * 0.52, 'x', koR, mats)
    addKnockout(group, -apothem, 0, -d * 0.52, 'x', koR, mats)
    addKnockout(group, 0, 0, -d + wall, 'z', koR, mats)

    // Mounting ears + green ground screw
    const earGeo = new BoxGeometry(0.016, 0.014, 0.002)
    for (const signX of [-1, 1]) {
      const ear = new Mesh(earGeo, mats.galvanizedSteel)
      ear.position.set(signX * (apothem - 0.007), 0, -0.002)
      group.add(ear)
    }
    const gndScrew = new Mesh(new CylinderGeometry(0.004, 0.004, 0.007, 6), mats.groundGreen)
    gndScrew.rotation.x = Math.PI / 2
    gndScrew.position.set(outerR * 0.35, -outerR * 0.35, -d + 0.005)
    group.add(gndScrew)
    return group
  }

  // Drawn galvanized steel 4" square (1900) or 4-11/16" commercial box
  const wall = 0.0018
  addHollowRectShell(group, w, h, d, wall, mats.galvanizedSteel)

  // Concentric 1/2" & 3/4" knockouts (2 per side + 3 on back)
  const koR = 0.0125
  const koOff = w * 0.26
  const koZ = -d * 0.55
  for (const s of [-1, 1]) {
    addKnockout(group, s * koOff, h / 2, koZ, 'y', koR, mats)
    addKnockout(group, s * koOff, -h / 2, koZ, 'y', koR, mats)
    addKnockout(group, w / 2, s * koOff, koZ, 'x', koR, mats)
    addKnockout(group, -w / 2, s * koOff, koZ, 'x', koR, mats)
  }
  addKnockout(group, -koOff, 0, -d + wall, 'z', koR, mats)
  addKnockout(group, koOff, 0, -d + wall, 'z', koR, mats)
  addKnockout(group, 0, -koOff, -d + wall, 'z', koR * 0.85, mats)

  // Green 10-32 hex ground screw inside back wall
  const gndScrew = new Mesh(new CylinderGeometry(0.0042, 0.0042, 0.008, 6), mats.groundGreen)
  gndScrew.rotation.x = Math.PI / 2
  gndScrew.position.set(0, h * 0.24, -d + 0.0055)
  group.add(gndScrew)

  // Diagonal corner cover mounting tabs
  const tabGeo = new BoxGeometry(0.014, 0.014, 0.0022)
  for (const [sx, sy] of [
    [-1, 1],
    [1, -1],
  ] as const) {
    const tab = new Mesh(tabGeo, mats.galvanizedSteel)
    tab.position.set(sx * (w / 2 - 0.008), sy * (h / 2 - 0.008), -0.0015)
    group.add(tab)
  }

  // Raised galvanized plaster / mud ring (1/2" raise, open center throat) when hosting a device
  if (opts.includeMudRing) {
    const ringDepth = 0.0127
    const collarW = 0.056
    const collarH = 0.088
    const sideW = (w - collarW) / 2
    const topH = (h - collarH) / 2
    const fTop = new Mesh(new BoxGeometry(w + 0.003, topH + 0.0015, 0.002), mats.galvanizedSteel)
    fTop.position.set(0, h / 2 - topH / 2, 0.001)
    const fBot = new Mesh(new BoxGeometry(w + 0.003, topH + 0.0015, 0.002), mats.galvanizedSteel)
    fBot.position.set(0, -h / 2 + topH / 2, 0.001)
    const fLeft = new Mesh(new BoxGeometry(sideW + 0.0015, collarH, 0.002), mats.galvanizedSteel)
    fLeft.position.set(-w / 2 + sideW / 2, 0, 0.001)
    const fRight = new Mesh(new BoxGeometry(sideW + 0.0015, collarH, 0.002), mats.galvanizedSteel)
    fRight.position.set(w / 2 - sideW / 2, 0, 0.001)
    group.add(fTop, fBot, fLeft, fRight)

    // 4-sided hollow mud-ring collar protruding into +Z
    const cWall = 0.002
    const cTop = new Mesh(new BoxGeometry(collarW, cWall, ringDepth), mats.galvanizedSteel)
    cTop.position.set(0, collarH / 2 - cWall / 2, ringDepth / 2 + 0.001)
    const cBot = new Mesh(new BoxGeometry(collarW, cWall, ringDepth), mats.galvanizedSteel)
    cBot.position.set(0, -collarH / 2 + cWall / 2, ringDepth / 2 + 0.001)
    const cLeft = new Mesh(new BoxGeometry(cWall, collarH, ringDepth), mats.galvanizedSteel)
    cLeft.position.set(-collarW / 2 + cWall / 2, 0, ringDepth / 2 + 0.001)
    const cRight = new Mesh(new BoxGeometry(cWall, collarH, ringDepth), mats.galvanizedSteel)
    cRight.position.set(collarW / 2 - cWall / 2, 0, ringDepth / 2 + 0.001)
    group.add(cTop, cBot, cLeft, cRight)
  }

  // Galvanized flat blank cover with 4 corner screws (for junction/pull boxes)
  if (opts.includeCover) {
    const cover = new Mesh(new BoxGeometry(w + 0.004, h + 0.004, 0.0024), mats.stainlessSteel)
    cover.position.set(0, 0, 0.0014)
    cover.castShadow = true
    group.add(cover)

    const screwGeo = new CylinderGeometry(0.003, 0.003, 0.003, 10)
    for (const [sx, sy] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const sc = new Mesh(screwGeo, mats.darkSteel)
      sc.rotation.x = Math.PI / 2
      sc.position.set(sx * (w / 2 - 0.009), sy * (h / 2 - 0.009), 0.003)
      group.add(sc)
    }
  }

  // Optional 3/4" EMT set-screw connectors on top & side knockouts
  if (opts.includeEmtConnectors) {
    for (const pos of [
      { x: -koOff, y: h / 2 + 0.012, z: koZ, rotZ: 0 },
      { x: w / 2 + 0.012, y: koOff, z: koZ, rotZ: -Math.PI / 2 },
    ]) {
      const body = new Mesh(new CylinderGeometry(0.014, 0.015, 0.026, 14), mats.castAluminum)
      body.position.set(pos.x, pos.y, pos.z)
      body.rotation.z = pos.rotZ
      const locknut = new Mesh(new CylinderGeometry(0.0175, 0.0175, 0.004, 6), mats.galvanizedSteel)
      locknut.position.set(
        pos.rotZ === 0 ? pos.x : w / 2 - 0.004,
        pos.rotZ === 0 ? h / 2 - 0.004 : pos.y,
        pos.z,
      )
      locknut.rotation.z = pos.rotZ
      const setScrew = new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.01, 8), mats.brass)
      setScrew.rotation.x = Math.PI / 2
      setScrew.position.set(pos.x, pos.y, pos.z + 0.014)
      group.add(body, locknut, setScrew)
    }
  }

  return group
}

/**
 * Cast-aluminum NEMA 3R weatherproof FS/Bell 1-gang outdoor outlet box with threaded hubs.
 */
export function buildWeatherproofBellBoxCad(mats = createCadMaterialPool()): Group {
  const group = new Group()
  group.name = 'cad-box-weatherproof-fs'
  const w = 2.8 * IN
  const h = 4.55 * IN
  const d = 2.05 * IN

  addHollowRectShell(group, w, h, d, 0.0045, mats.castAluminum)

  // Black neoprene weatherproof cover gasket around front perimeter
  const gTop = new Mesh(new BoxGeometry(w, 0.004, 0.003), mats.blackPolymer)
  gTop.position.set(0, h / 2 - 0.002, 0.0015)
  const gBot = new Mesh(new BoxGeometry(w, 0.004, 0.003), mats.blackPolymer)
  gBot.position.set(0, -h / 2 + 0.002, 0.0015)
  const gLeft = new Mesh(new BoxGeometry(0.004, h, 0.003), mats.blackPolymer)
  gLeft.position.set(-w / 2 + 0.002, 0, 0.0015)
  const gRight = new Mesh(new BoxGeometry(0.004, h, 0.003), mats.blackPolymer)
  gRight.position.set(w / 2 - 0.002, 0, 0.0015)
  group.add(gTop, gBot, gLeft, gRight)

  // Top & bottom 3/4" cast threaded conduit hubs + closure plugs
  const hubGeo = new CylinderGeometry(0.016, 0.017, 0.018, 16)
  const plugGeo = new CylinderGeometry(0.012, 0.012, 0.005, 8)
  for (const signY of [1, -1]) {
    const hub = new Mesh(hubGeo, mats.castAluminum)
    hub.position.set(0, signY * (h / 2 + 0.009), -d / 2)
    const plug = new Mesh(plugGeo, mats.darkSteel)
    plug.position.set(0, signY * (h / 2 + 0.019), -d / 2)
    group.add(hub, plug)
  }

  // External corner mounting lugs
  const lugGeo = new BoxGeometry(0.016, 0.016, 0.006)
  for (const signY of [1, -1]) {
    const lug = new Mesh(lugGeo, mats.castAluminum)
    lug.position.set(0, signY * (h / 2 + 0.008), -d + 0.004)
    group.add(lug)
  }

  return group
}
