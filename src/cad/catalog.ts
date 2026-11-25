/**
 * 50-Item Clean-Room MIT Electrical Materials 3D CAD Catalog.
 * Covers Panels, Breakers, Transformers, Disconnects, Meter Sockets,
 * Solar PV, Battery ESS, Backup Transfer Gear, NEC 314.16 Outlet & Junction Boxes,
 * Wiring Devices, Smart Controls, Light Fixtures, Grounding, and Conduit/Cable Tray —
 * ready for live Pascal rendering or `.glb` export.
 */

import { Box3, type Group, Vector3 } from 'three'
import { buildPanelSchedule } from '../nec/panel-schedule'
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
import {
  buildBrassFloorBoxCad,
  buildCeilingFanLightCad,
  buildCommercialVfdCad,
  buildConduitBodyTrioCad,
  buildGroundRodAcornClampCad,
  buildLadderCableTrayCad,
  buildSmartDimmerCad,
  buildSmokeCoAlarmCad,
  buildType2SpdCad,
  buildUnderCabinetLedCad,
  buildUsbDuplexReceptacleCad,
  buildWeatherproofInUseCoverCad,
  buildWirewayGutter4x4Cad,
} from './expansion'
import { buildWiredPanelInteriorCad } from './panel-interior'
import {
  buildAutomaticTransferSwitchCad,
  buildGeneratorInletBoxCad,
  buildPvRapidShutdownCad,
  buildSolarStringInverterCad,
  buildWallBatteryEssCad,
} from './solar-backup'

export type ElectricalCadCategory =
  | 'panels-gear'
  | 'solar-backup'
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
    name: '200A Load Center (Cover Off — Wired)',
    category: 'panels-gear',
    necRef: 'NEC 408.36 / 312.6',
    description: 'Cover-off residential 200A panelboard showing copper busbars, neutral/ground bars, service feeders, 1P/2P breakers, and every individual branch wire landed on its lug.',
    build: () => {
      const panel = {
        id: 'demo_res_200a',
        type: 'electrical:panel',
        name: 'MDP-1',
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        mainType: 'main-breaker',
        spaces: 20,
      }
      const devices = [
        { id: 'd1', type: 'electrical:device', name: 'EVSE 50A', panelId: 'demo_res_200a', circuitNumber: 1, poles: 2, breakerAmps: 50, loadVa: 9600, wireGauge: '6', gfciProtected: true },
        { id: 'd2', type: 'electrical:device', name: 'Range 40A', panelId: 'demo_res_200a', circuitNumber: 2, poles: 2, breakerAmps: 40, loadVa: 8000, wireGauge: '8' },
        { id: 'd3', type: 'electrical:device', name: 'Dryer 30A', panelId: 'demo_res_200a', circuitNumber: 5, poles: 2, breakerAmps: 30, loadVa: 5000, wireGauge: '10' },
        { id: 'd4', type: 'electrical:device', name: 'Kitchen GFCI 1', panelId: 'demo_res_200a', circuitNumber: 6, poles: 1, breakerAmps: 20, loadVa: 1500, wireGauge: '12', gfciProtected: true, afciProtected: true },
        { id: 'd5', type: 'electrical:device', name: 'Kitchen GFCI 2', panelId: 'demo_res_200a', circuitNumber: 8, poles: 1, breakerAmps: 20, loadVa: 1500, wireGauge: '12', gfciProtected: true },
        { id: 'd6', type: 'electrical:device', name: 'Living AFCI', panelId: 'demo_res_200a', circuitNumber: 9, poles: 1, breakerAmps: 20, loadVa: 1440, wireGauge: '12', afciProtected: true },
        { id: 'd7', type: 'electrical:device', name: 'Master Bed AFCI', panelId: 'demo_res_200a', circuitNumber: 10, poles: 1, breakerAmps: 15, loadVa: 1080, wireGauge: '14', afciProtected: true },
        { id: 'd8', type: 'electrical:device', name: 'Bath GFCI', panelId: 'demo_res_200a', circuitNumber: 11, poles: 1, breakerAmps: 20, loadVa: 1440, wireGauge: '12', gfciProtected: true },
        { id: 'd9', type: 'electrical:device', name: 'Lighting', panelId: 'demo_res_200a', circuitNumber: 12, poles: 1, breakerAmps: 15, loadVa: 900, wireGauge: '14' },
      ]
      return buildWiredPanelInteriorCad({
        schedule: buildPanelSchedule(panel, devices),
        nemaRating: 'NEMA-1',
        viewMode: 'cover-off',
      })
    },
  },
  {
    slug: 'panel-comm-400a-3p',
    name: '400A 277/480V 3P Panelboard (Cover Off)',
    category: 'panels-gear',
    necRef: 'NEC 408 / 277-480V',
    description: 'Cover-off commercial 400A 277/480V 3-phase panelboard with 3-bus copper interior, Brown/Orange/Yellow phase wiring, 3-pole motor breakers, and isolated neutral/ground bars.',
    build: () => {
      const panel = {
        id: 'demo_comm_480v',
        type: 'electrical:panel',
        name: 'HDP-1',
        occupancy: 'commercial',
        voltageSystem: '277/480V-3P',
        busRatingAmps: 400,
        mainBreakerAmps: 400,
        mainType: 'main-breaker',
        spaces: 24,
      }
      const devices = [
        { id: 'c1', type: 'electrical:device', name: 'RTU-1 3P Motor', panelId: 'demo_comm_480v', circuitNumber: 1, poles: 3, breakerAmps: 60, loadVa: 36000, wireGauge: '6' },
        { id: 'c2', type: 'electrical:device', name: 'TX-1 75kVA Feeder', panelId: 'demo_comm_480v', circuitNumber: 2, poles: 3, breakerAmps: 125, loadVa: 75000, wireGauge: '2' },
        { id: 'c3', type: 'electrical:device', name: 'Warehouse High-Bay Ltg', panelId: 'demo_comm_480v', circuitNumber: 7, poles: 1, breakerAmps: 20, loadVa: 3600, wireGauge: '12' },
        { id: 'c4', type: 'electrical:device', name: 'Office 277V Troffers', panelId: 'demo_comm_480v', circuitNumber: 8, poles: 1, breakerAmps: 20, loadVa: 3200, wireGauge: '12' },
        { id: 'c5', type: 'electrical:device', name: 'Air Compressor 3P', panelId: 'demo_comm_480v', circuitNumber: 9, poles: 3, breakerAmps: 40, loadVa: 22000, wireGauge: '8' },
        { id: 'c6', type: 'electrical:device', name: 'Exterior Wall Packs', panelId: 'demo_comm_480v', circuitNumber: 10, poles: 1, breakerAmps: 20, loadVa: 2400, wireGauge: '12' },
      ]
      return buildWiredPanelInteriorCad({
        schedule: buildPanelSchedule(panel, devices),
        nemaRating: 'NEMA-1',
        viewMode: 'cover-off',
      })
    },
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
  {
    slug: 'panel-res-200a-cover-on',
    name: '200A Load Center (Panel Cover On)',
    category: 'panels-gear',
    necRef: 'NEC 408.7 / UL 67',
    description: '200A residential load center with flush ANSI-61 gray steel panel cover, breaker handles, spare twist-out blanks, NEMA nameplate, and NEC 110.16 arc-flash placard.',
    build: () => {
      const panel = {
        id: 'demo_res_cover_on',
        type: 'electrical:panel',
        name: 'MDP-1',
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 200,
        mainBreakerAmps: 200,
        mainType: 'main-breaker',
        spaces: 20,
      }
      const devices = [
        { id: 'd1', type: 'electrical:device', name: 'EVSE 50A', panelId: 'demo_res_cover_on', circuitNumber: 1, poles: 2, breakerAmps: 50, loadVa: 9600, wireGauge: '6', gfciProtected: true },
        { id: 'd2', type: 'electrical:device', name: 'Dryer 30A', panelId: 'demo_res_cover_on', circuitNumber: 2, poles: 2, breakerAmps: 30, loadVa: 5000, wireGauge: '10' },
        { id: 'd3', type: 'electrical:device', name: 'Kitchen GFCI 1', panelId: 'demo_res_cover_on', circuitNumber: 5, poles: 1, breakerAmps: 20, loadVa: 1500, wireGauge: '12', gfciProtected: true, afciProtected: true },
        { id: 'd4', type: 'electrical:device', name: 'Kitchen GFCI 2', panelId: 'demo_res_cover_on', circuitNumber: 6, poles: 1, breakerAmps: 20, loadVa: 1500, wireGauge: '12', gfciProtected: true },
        { id: 'd5', type: 'electrical:device', name: 'Living AFCI', panelId: 'demo_res_cover_on', circuitNumber: 7, poles: 1, breakerAmps: 20, loadVa: 1440, wireGauge: '12', afciProtected: true },
        { id: 'd6', type: 'electrical:device', name: 'Bath GFCI', panelId: 'demo_res_cover_on', circuitNumber: 8, poles: 1, breakerAmps: 20, loadVa: 1440, wireGauge: '12', gfciProtected: true },
      ]
      return buildWiredPanelInteriorCad({
        schedule: buildPanelSchedule(panel, devices),
        nemaRating: 'NEMA-1',
        viewMode: 'panel-cover-on',
      })
    },
  },
  {
    slug: 'subpanel-100a-mlo',
    name: '100A 12-Space MLO Subpanel (Wired)',
    category: 'panels-gear',
    necRef: 'NEC 250.24(A)(5) / 408',
    description: 'Compact 100A Main-Lugs-Only garage/ADU subpanel with isolated neutral and separate equipment grounding bar (no main bonding screw).',
    build: () => {
      const panel = {
        id: 'demo_sub_100a',
        type: 'electrical:panel',
        name: 'SUB-1',
        occupancy: 'residential',
        voltageSystem: '120/240V-1P',
        busRatingAmps: 100,
        mainBreakerAmps: 100,
        mainType: 'mlo',
        spaces: 12,
      }
      const devices = [
        { id: 's1', type: 'electrical:device', name: 'Garage EVSE', panelId: 'demo_sub_100a', circuitNumber: 1, poles: 2, breakerAmps: 50, loadVa: 9600, wireGauge: '6', gfciProtected: true },
        { id: 's2', type: 'electrical:device', name: 'Bench GFCI', panelId: 'demo_sub_100a', circuitNumber: 2, poles: 1, breakerAmps: 20, loadVa: 1440, wireGauge: '12', gfciProtected: true },
        { id: 's3', type: 'electrical:device', name: 'Shop Lighting', panelId: 'demo_sub_100a', circuitNumber: 4, poles: 1, breakerAmps: 15, loadVa: 720, wireGauge: '14' },
        { id: 's4', type: 'electrical:device', name: 'Mini-Split 20A', panelId: 'demo_sub_100a', circuitNumber: 5, poles: 2, breakerAmps: 20, loadVa: 3200, wireGauge: '12' },
      ]
      return buildWiredPanelInteriorCad({
        schedule: buildPanelSchedule(panel, devices),
        width: 0.36,
        height: 0.62,
        nemaRating: 'NEMA-1',
        viewMode: 'cover-off',
      })
    },
  },
  {
    slug: 'spd-type2-panel',
    name: 'Type 2 Whole-Home Surge Protector (SPD)',
    category: 'panels-gear',
    necRef: 'NEC 230.67',
    description: 'NEMA-4X Type 2 panel-mounted Surge Protective Device with 1/2" close-nipple, locknut, twin green diagnostic LEDs, and color-coded leads.',
    build: () => buildType2SpdCad(),
  },
  {
    slug: 'vfd-drive-commercial',
    name: 'Commercial 3-Phase VFD Motor Drive',
    category: 'panels-gear',
    necRef: 'NEC 430.122',
    description: 'Industrial Variable Frequency Drive with deep aluminum heatsink fins, front keypad, cyan frequency display, speed pot, and dual bottom EMT hubs.',
    build: () => buildCommercialVfdCad(),
  },

  // ─── Solar PV, Battery ESS & Backup Power (5) ────────────────────────────
  {
    slug: 'solar-inverter-string',
    name: 'String Solar PV Inverter (NEC 690)',
    category: 'solar-backup',
    necRef: 'NEC 690.15 / 690.31',
    description: 'Wall-mounted string PV inverter with extruded rear heatsink fins, OLED readout, integrated rotary DC isolator, MC4 inputs, and AC conduit gland.',
    build: () => buildSolarStringInverterCad(),
  },
  {
    slug: 'battery-wall-ess',
    name: 'Wall-Mounted Home Battery ESS (13.5 kWh)',
    category: 'solar-backup',
    necRef: 'NEC 706.15',
    description: 'Architectural wall-mounted lithium ESS battery pack with beveled white fascia, glowing charge-status lightpipe, side shutoff toggle, and bottom conduit hub.',
    build: () => buildWallBatteryEssCad(),
  },
  {
    slug: 'transfer-switch-200a',
    name: '200A Automatic Transfer Switch (ATS)',
    category: 'solar-backup',
    necRef: 'NEC 702.5',
    description: 'Service-entrance rated 200A NEMA-3R ATS with sloped drip hood, utility/generator/load status LEDs, side throw handle, and feeder hubs.',
    build: () => buildAutomaticTransferSwitchCad(),
  },
  {
    slug: 'generator-inlet-50a',
    name: '50A NEMA SS2-50P Generator Inlet Box',
    category: 'solar-backup',
    necRef: 'NEC 702.7',
    description: 'Raintight outdoor 50A generator power inlet box with spring-flip weather lid and recessed twist-lock brass male prongs.',
    build: () => buildGeneratorInletBoxCad(),
  },
  {
    slug: 'ac-rapid-shutdown',
    name: 'PV Rapid Shutdown / AC Disconnect Switch',
    category: 'solar-backup',
    necRef: 'NEC 690.12',
    description: 'NEMA-4X polycarbonate rapid-shutdown disconnect with high-visibility yellow escutcheon, red padlockable rotary handle, and watertight glands.',
    build: () => buildPvRapidShutdownCad(),
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
    name: '3-Gang Blue PVC Nail-On Box (48 cu in)',
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
  {
    slug: 'device-dimmer-smart',
    name: 'Smart Decora Slide Dimmer Switch',
    category: 'wiring-devices',
    necRef: 'NEC 404.2',
    description: 'Smart architectural Decora dimmer with rocker paddle, side slide bar, 5-dot cyan brightness LEDs, beveled wallplate, and rough-in box.',
    build: () => buildSmartDimmerCad(),
  },
  {
    slug: 'device-usb-duplex-20a',
    name: '20A TR USB-A / USB-C Duplex Receptacle',
    category: 'wiring-devices',
    necRef: 'NEC 406.12',
    description: '20A tamper-resistant T-slot duplex outlet with integrated USB-A and USB-C charging ports, charging LED, wallplate, and deep box.',
    build: () => buildUsbDuplexReceptacleCad(),
  },
  {
    slug: 'device-weatherproof-inuse',
    name: 'Extra-Duty Weatherproof In-Use Bubble Cover',
    category: 'wiring-devices',
    necRef: 'NEC 406.9(B)(1)',
    description: 'Wet-location cast-aluminum FS box with 20A WR GFCI behind a hinged translucent polycarbonate extra-duty bubble hood.',
    build: () => buildWeatherproofInUseCoverCad(),
  },
  {
    slug: 'device-floor-box-brass',
    name: 'Recessed Solid-Brass Floor Outlet Box',
    category: 'wiring-devices',
    necRef: 'NEC 314.27(B)',
    description: 'Flush brushed-brass floor box assembly with under-floor galvanized rough-in box, conduit hubs, coin-slot plug, and hinged access flap.',
    build: () => buildBrassFloorBoxCad(),
  },
  {
    slug: 'device-smoke-co-alarm',
    name: 'Hardwired 120V Interconnected Smoke/CO Alarm',
    category: 'wiring-devices',
    necRef: 'IRC R314 / NEC 760',
    description: 'Ceiling-mounted 120V interconnected smoke and carbon monoxide detector with intake louver ring, test/hush button, and status LEDs.',
    build: () => buildSmokeCoAlarmCad(),
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
  {
    slug: 'fixture-ceiling-fan-light',
    name: '52" Ceiling Fan with Integrated LED Kit',
    category: 'light-fixtures',
    necRef: 'NEC 314.27(C)',
    description: 'Fan-rated ceiling luminaire assembly with canopy, downrod, brushed motor housing, 5 pitched blades, and frosted LED dome.',
    build: () => buildCeilingFanLightCad(),
  },
  {
    slug: 'fixture-under-cabinet-led',
    name: '24" Hardwired Under-Cabinet LED Task Bar',
    category: 'light-fixtures',
    necRef: 'NEC 410',
    description: 'Slim anodized aluminum kitchen under-cabinet LED task bar with continuous frosted diffuser, rocker switch, and rear Romex clamp.',
    build: () => buildUnderCabinetLedCad(),
  },

  // ─── Conduit Bodies, Raceways, Grounding & Fittings (6) ──────────────────
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
  {
    slug: 'conduit-body-ll-lr-t-set',
    name: '3/4" Type LL, LR & T Conduit Body Trio',
    category: 'conduit-fittings',
    necRef: 'NEC 314.16(C)(2)',
    description: 'Cast-aluminum 3/4" Type LL, LR, and Tee conduit bodies with stamped steel covers, neoprene gaskets, and stainless cover screws.',
    build: () => buildConduitBodyTrioCad(),
  },
  {
    slug: 'wireway-gutter-4x4',
    name: '4"x4"x4ft Hinged Auxiliary Wireway Gutter',
    category: 'conduit-fittings',
    necRef: 'NEC 376',
    description: 'NEMA-1 ANSI-61 gray steel 4-inch square hinged wiring trough with top piano hinges, quarter-turn latches, end flanges, and knockouts.',
    build: () => buildWirewayGutter4x4Cad(),
  },
  {
    slug: 'cable-tray-ladder',
    name: '12" Aluminum Ladder Cable Tray Section',
    category: 'conduit-fittings',
    necRef: 'NEC 392',
    description: 'Commercial extruded aluminum ladder cable tray with I-beam rails, cross rungs, end splice plates, and colored feeder cable bundle.',
    build: () => buildLadderCableTrayCad(),
  },
  {
    slug: 'ground-rod-acorn-clamp',
    name: 'Copper-Clad Ground Rod + Acorn Clamp & GEC',
    category: 'conduit-fittings',
    necRef: 'NEC 250.52(A)(5)',
    description: '5/8" copper-clad grounding electrode rod with solid bronze direct-burial acorn clamp and #6 AWG bare copper grounding electrode conductor.',
    build: () => buildGroundRodAcornClampCad(),
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
