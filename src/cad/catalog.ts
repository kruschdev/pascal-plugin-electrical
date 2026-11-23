/**
 * 30-Item Clean-Room MIT Electrical Materials 3D CAD Catalog.
 * Covers Panels, Breakers, Transformers, Disconnects, Meter Sockets,
 * NEC 314.16 Outlet & Junction Boxes, Wiring Devices, Light Fixtures,
 * and Conduit/Fittings — ready for live Pascal rendering or `.glb` export.
 */

import { Box3, type Group, Vector3 } from 'three'
import { buildElectricalBoxCad, buildWeatherproofBellBoxCad } from './boxes'
import {
  buildBreakerTrioCad,
  buildConduitBodyLbCad,
  buildConduitRunCad,
  buildDeviceCad,
  buildEmtFittingsKitCad,
  buildExitSignCad,
  buildExteriorWallPackCad,
  buildFlushCeilingDrumCad,
  buildHighBayUfoCad,
  buildMeterSocketCad,
  buildPanelCad,
  buildRecessedCan6InCad,
  buildSafetyDisconnectCad,
  buildShopStrip4FtCad,
  buildTransformerCad,
  buildTroffer2x4Cad,
} from './equipment'

export type ElectricalCadCategory =
  | 'panels-gear'
  | 'outlet-boxes'
  | 'wiring-devices'
  | 'light-fixtures'
  | 'conduit-fittings'

export type ElectricalCadEntry = {
  slug: string
  name: string
  category: ElectricalCadCategory
  necRef: string
  description: string
  build: () => Group
}

export const ELECTRICAL_CAD_CATALOG: readonly ElectricalCadEntry[] = [
  // ─── Panels, Breakers & Distribution Gear (7) ────────────────────────────
  {
    slug: 'panel-res-200a-closed',
    name: '200A Residential Load Center (Closed)',
    category: 'panels-gear',
    necRef: 'NEC 408 / 110.26',
    description: '120/240V 1-phase 40-space NEMA-1 recessed steel load center with knockouts and hinged door.',
    build: () =>
      buildPanelCad({
        width: 0.38,
        height: 0.92,
        depth: 0.14,
        voltageSystem: '120/240V-1P',
        nemaRating: 'NEMA-1',
        spaces: 40,
        doorOpen: false,
      }),
  },
  {
    slug: 'panel-res-200a-open',
    name: '200A Load Center (Open Deadfront)',
    category: 'panels-gear',
    necRef: 'NEC 408.36 / 408.54',
    description: 'Open-door residential panelboard showing copper busbars, neutral/ground bars, main breaker, and twin breaker columns.',
    build: () =>
      buildPanelCad({
        width: 0.38,
        height: 0.92,
        depth: 0.14,
        voltageSystem: '120/240V-1P',
        nemaRating: 'NEMA-1',
        spaces: 24,
        doorOpen: true,
      }),
  },
  {
    slug: 'panel-comm-400a-3p',
    name: '400A 277/480V 3P Panelboard',
    category: 'panels-gear',
    necRef: 'NEC 408 / 277-480V',
    description: 'Commercial 20"W 42-space 277/480V 3-phase wye distribution panelboard with HV header stripe and 3-bus interior.',
    build: () =>
      buildPanelCad({
        width: 0.51,
        height: 1.24,
        depth: 0.15,
        voltageSystem: '277/480V-3P',
        nemaRating: 'NEMA-1',
        spaces: 42,
        doorOpen: true,
      }),
  },
  {
    slug: 'panel-nema3r-outdoor',
    name: 'NEMA-3R Outdoor Load Center',
    category: 'panels-gear',
    necRef: 'NEC 312.2 / NEMA 3R',
    description: 'Raintight outdoor load center with sloped drip hood and top bolt-on conduit hub.',
    build: () =>
      buildPanelCad({
        width: 0.38,
        height: 0.78,
        depth: 0.14,
        voltageSystem: '120/240V-1P',
        nemaRating: 'NEMA-3R',
        spaces: 20,
        doorOpen: false,
      }),
  },
  {
    slug: 'breaker-1p-2p-3p-set',
    name: 'Circuit Breaker Trio (1P / 2P / 3P)',
    category: 'panels-gear',
    necRef: 'NEC 240.6 / 240.15',
    description: '1-pole 20A, 2-pole 50A common-trip, and 3-pole 40A molded-case circuit breakers with brass lugs.',
    build: () => buildBreakerTrioCad(),
  },
  {
    slug: 'transformer-75kva-480v',
    name: '75 kVA Dry-Type Transformer',
    category: 'panels-gear',
    necRef: 'NEC 450.3(B) / 110.26',
    description: '480V to 208Y/120V commercial step-down ventilated NEMA-2 transformer with louvers, lifting lugs, and floor pads.',
    build: () => buildTransformerCad({ primaryVoltage: 480, secondaryVoltage: 208 }),
  },
  {
    slug: 'safety-disconnect-100a',
    name: '100A Heavy-Duty Safety Disconnect',
    category: 'panels-gear',
    necRef: 'NEC 430.102',
    description: 'Commercial 3-pole fused/non-fused NEMA safety switch with side red-grip throw handle and lockout bracket.',
    build: () => buildSafetyDisconnectCad(),
  },
  {
    slug: 'meter-socket-200a',
    name: '200A Ringless Utility Meter Base',
    category: 'panels-gear',
    necRef: 'NEC 230.66',
    description: '200A NEMA-3R service meter socket with top hub, glass kWh meter dome, and digital register face.',
    build: () => buildMeterSocketCad(),
  },

  // ─── NEC 314.16 Outlet & Junction Boxes (7) ──────────────────────────────
  {
    slug: 'box-1gang-pvc',
    name: '1-Gang Blue PVC Nail-On Box (18 cu in)',
    category: 'outlet-boxes',
    necRef: 'NEC 314.16(A)',
    description: 'Standard residential single-gang PVC wall box with stud-mount nails, brass 6-32 ears, and Romex clamp flaps.',
    build: () => buildElectricalBoxCad('single-gang-standard'),
  },
  {
    slug: 'box-2gang-pvc',
    name: '2-Gang Blue PVC Nail-On Box (32 cu in)',
    category: 'outlet-boxes',
    necRef: 'NEC 314.16(A)',
    description: 'Double-gang residential PVC switch/receptacle box with dual mounting ears and stud nails.',
    build: () => buildElectricalBoxCad('two-gang-standard'),
  },
  {
    slug: 'box-3gang-pvc',
    name: '3-Gang Blue PVC Nail-On Box (44 cu in)',
    category: 'outlet-boxes',
    necRef: 'NEC 314.16(A)',
    description: 'Triple-gang PVC wall switch box for multi-circuit lighting banks.',
    build: () => buildElectricalBoxCad('three-gang-standard'),
  },
  {
    slug: 'box-4sq-steel-deep',
    name: '4" Square x 2-1/8" Steel Box (1900)',
    category: 'outlet-boxes',
    necRef: 'NEC Table 314.16(A)',
    description: 'Drawn galvanized steel 4" square commercial box (30.3 cu in) with concentric knockouts, green ground screw, and raised mud ring.',
    build: () => buildElectricalBoxCad('4-sq-2.125', { includeMudRing: true }),
  },
  {
    slug: 'box-4-11-16-steel',
    name: '4-11/16" Commercial Junction Box',
    category: 'outlet-boxes',
    necRef: 'NEC Table 314.16(A)',
    description: '42.0 cu in deep commercial pull/junction box with blank steel cover, corner screws, and 3/4" EMT set-screw connectors.',
    build: () =>
      buildElectricalBoxCad('4-11-16-2.125', {
        includeCover: true,
        includeEmtConnectors: true,
      }),
  },
  {
    slug: 'box-4oct-ceiling',
    name: '4" Octagon Ceiling Steel Box',
    category: 'outlet-boxes',
    necRef: 'NEC 314.27',
    description: 'Octagonal galvanized ceiling box (21.5 cu in) with cardinal knockouts, mounting ears, and green ground screw.',
    build: () => buildElectricalBoxCad('4-oct-2.125'),
  },
  {
    slug: 'box-weatherproof-fs',
    name: 'NEMA-3R Cast Weatherproof Bell Box',
    category: 'outlet-boxes',
    necRef: 'NEC 314.15',
    description: 'Cast-aluminum 1-gang FS outdoor box with threaded 3/4" conduit hubs, closure plugs, and neoprene gasket.',
    build: () => buildWeatherproofBellBoxCad(),
  },

  // ─── Wiring Devices & Heavy Loads (6) ────────────────────────────────────
  {
    slug: 'device-duplex-20a',
    name: '20A Duplex Receptacle (NEMA 5-20R)',
    category: 'wiring-devices',
    necRef: 'NEC 210.52',
    description: 'NEMA 5-20R T-slot duplex outlet mounted on a 1-gang PVC rough-in box with beveled wallplate.',
    build: () =>
      buildDeviceCad({
        deviceKind: 'duplex',
        boxType: 'single-gang-standard',
        breakerAmps: 20,
      }),
  },
  {
    slug: 'device-gfci-20a',
    name: '20A GFCI Receptacle (TEST/RESET)',
    category: 'wiring-devices',
    necRef: 'NEC 210.8(A)/(B)',
    description: 'Decora 20A GFCI outlet with TEST/RESET buttons, status LED, wallplate, and rough-in box.',
    build: () =>
      buildDeviceCad({
        deviceKind: 'gfci',
        boxType: 'single-gang-deep',
        breakerAmps: 20,
      }),
  },
  {
    slug: 'device-nema-14-50r',
    name: '50A NEMA 14-50R Range/EV Outlet',
    category: 'wiring-devices',
    necRef: 'NEC 210.21 / 625',
    description: 'Heavy-duty 125/250V 50A 4-wire receptacle on brushed stainless 2-gang wallplate and 4-11/16" steel box.',
    build: () =>
      buildDeviceCad({
        deviceKind: 'dedicated-240v',
        boxType: '4-11-16-2.125',
        breakerAmps: 50,
      }),
  },
  {
    slug: 'device-switch-decora',
    name: 'Decora Rocker Wall Switch (1P/3-Way)',
    category: 'wiring-devices',
    necRef: 'NEC 404.2',
    description: 'Standard residential/commercial rocker wall switch with beveled wallplate and rough-in box.',
    build: () =>
      buildDeviceCad({
        deviceKind: 'switch-1p',
        boxType: 'single-gang-standard',
        breakerAmps: 15,
      }),
  },
  {
    slug: 'device-evse-level2',
    name: 'Level 2 Wall EVSE Charger (48A)',
    category: 'wiring-devices',
    necRef: 'NEC 625.41',
    description: 'Wall-mounted EV charging station with status lightbar, J1772/NACS nozzle holster, and coiled cable.',
    build: () => buildDeviceCad({ deviceKind: 'evse', breakerAmps: 60 }),
  },
  {
    slug: 'device-motor-3p-tefc',
    name: 'Commercial 3-Phase TEFC Motor',
    category: 'wiring-devices',
    necRef: 'NEC 430.24',
    description: 'Industrial 3-phase finned cast-iron TEFC electric motor with drive shaft, mounting base, and conduit peckerhead box.',
    build: () =>
      buildDeviceCad({
        deviceKind: 'motor-load',
        occupancy: 'commercial',
        breakerAmps: 40,
      }),
  },

  // ─── Residential & Commercial Light Fixtures (7) ─────────────────────────
  {
    slug: 'fixture-can-6in-recessed',
    name: '6" IC Recessed Can Downlight',
    category: 'light-fixtures',
    necRef: 'NEC 410.116',
    description: '6-inch new-construction IC-rated recessed housing with bar hangers, integral j-box, white baffle trim, and LED lens.',
    build: () => buildRecessedCan6InCad(),
  },
  {
    slug: 'fixture-troffer-2x4',
    name: 'Commercial 2x4 LED Recessed Troffer',
    category: 'light-fixtures',
    necRef: 'NEC 410.36',
    description: 'Drop-ceiling 2 ft x 4 ft lay-in commercial LED troffer with steel back pan, driver enclosure, and frosted diffuser.',
    build: () => buildTroffer2x4Cad(),
  },
  {
    slug: 'fixture-highbay-ufo',
    name: 'Warehouse UFO LED High-Bay',
    category: 'light-fixtures',
    necRef: 'NEC 410.30',
    description: 'Industrial die-cast aluminum finned UFO high-bay luminaire with driver cylinder, hanging eye ring, and optic lens.',
    build: () => buildHighBayUfoCad(),
  },
  {
    slug: 'fixture-shop-4ft-strip',
    name: '4 ft Commercial LED Strip Light',
    category: 'light-fixtures',
    necRef: 'NEC 410',
    description: 'Surface- or chain-mounted 4-foot commercial/garage LED wraparound strip luminaire with steel channel.',
    build: () => buildShopStrip4FtCad(),
  },
  {
    slug: 'fixture-wall-sconce-pack',
    name: 'Exterior Commercial LED Wall Pack',
    category: 'light-fixtures',
    necRef: 'NEC 410.10(A)',
    description: 'Wet-location die-cast exterior full-cutoff LED wall pack with weatherproof top conduit hub and refractor lens.',
    build: () => buildExteriorWallPackCad(),
  },
  {
    slug: 'fixture-flush-ceiling-drum',
    name: 'Residential Flush LED Ceiling Drum',
    category: 'light-fixtures',
    necRef: 'NEC 410',
    description: 'Brushed-nickel residential flush-mount ceiling luminaire with frosted glass diffuser drum.',
    build: () => buildFlushCeilingDrumCad(),
  },
  {
    slug: 'fixture-exit-sign',
    name: 'Emergency EXIT Sign + Twin Floods',
    category: 'light-fixtures',
    necRef: 'NEC 700.12',
    description: 'Commercial double-face illuminated EXIT sign with twin swivel emergency bug-eye floodlight heads.',
    build: () => buildExitSignCad(),
  },

  // ─── Conduit Bodies, Fittings & Raceway Assemblies (2) ───────────────────
  {
    slug: 'conduit-body-lb-34',
    name: '3/4" Type LB Conduit Body',
    category: 'conduit-fittings',
    necRef: 'NEC 314.16(C)(2)',
    description: 'Cast-aluminum 3/4" Type LB condulet with rear/bottom threaded hubs, neoprene gasket, and removable cover.',
    build: () => buildConduitBodyLbCad(),
  },
  {
    slug: 'fitting-emt-connector-coupling',
    name: '3/4" EMT Fittings & Unistrut Clamp Kit',
    category: 'conduit-fittings',
    necRef: 'NEC 358.30 / 358.42',
    description: 'Set-screw EMT box connector with insulated throat & locknut, set-screw coupling, 1-hole strap, and 1-5/8" Unistrut clamp.',
    build: () => buildEmtFittingsKitCad(),
  },
]

export function buildElectricalCadPart(slug: string): Group {
  const entry = ELECTRICAL_CAD_CATALOG.find((item) => item.slug === slug)
  if (!entry) {
    throw new Error(`Unknown electrical CAD part slug "${slug}".`)
  }
  return entry.build()
}

export function measureCadDimensionsMm(group: Group): [number, number, number] {
  const box = new Box3().setFromObject(group)
  const size = new Vector3()
  box.getSize(size)
  return [
    Math.round(size.x * 1000),
    Math.round(size.y * 1000),
    Math.round(size.z * 1000),
  ]
}

export { buildConduitRunCad }
