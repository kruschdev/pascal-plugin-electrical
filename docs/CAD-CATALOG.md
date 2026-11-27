# 50-Model Clean-Room MIT Electrical 3D CAD Library

Every electrical material in [`@kruschdev/pascal-plugin-electrical/cad`](../src/cad/index.ts) is built procedurally from clean-room Three.js geometry (MIT license, zero third-party meshes) and can be downloaded pre-exported as binary `.glb` + studio `.png` thumbnails from the [`v0.2.7` GitHub Release (`electrical-cad-models-v0.2.7.tar.gz`)](https://github.com/kruschdev/pascal-plugin-electrical/releases/download/v0.2.7/electrical-cad-models-v0.2.7.tar.gz) or regenerated locally into `assets/cad/` via `bun run export:cad` following Pascal's `public/items/<slug>/` layout.

![50 Clean-Room MIT Electrical CAD Material Models](https://github.com/kruschdev/pascal-plugin-electrical/releases/download/v0.2.7/cad-material-catalog.png)

## Programmatic Usage (`./cad`)

```ts
import {
  ELECTRICAL_CAD_CATALOG,
  buildElectricalCadPart,
  buildWiredPanelInteriorCad,
  buildConduitRunCad,
} from '@kruschdev/pascal-plugin-electrical/cad'
import { buildPanelSchedule } from '@kruschdev/pascal-plugin-electrical/nec'

// Build any of the 50 catalog models as a Three.js Group
const inverterMesh = buildElectricalCadPart('solar-inverter-string')

// Build a live cover-off or Panel-Cover-On panel interior wired to match a scene's PanelSchedule
const openPanel = buildWiredPanelInteriorCad({
  schedule: buildPanelSchedule(panelNode, deviceNodes, conduitRuns),
  nemaRating: 'NEMA-1',
  viewMode: 'cover-off', // 'cover-off' | 'panel-cover-on' | 'closed'
})
```

To regenerate all 50 `.glb` assets and thumbnails after editing CAD geometry:

```bash
bun run export:cad
bun scripts/render-cad-thumbnails.ts
```

## Complete 50-Model Catalog

### Panels, Breakers and Distribution Gear (12)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `panel-res-200a-closed` | 200A Residential Load Center (Closed) | `404 x 944 x 167` | NEC 408 / 110.26 |
| `panel-res-200a-open` | 200A Load Center (Cover Off, Wired) | `426 x 901 x 149` | NEC 408.36 / 312.6 |
| `panel-comm-400a-3p` | 400A 277/480V 3P Panelboard (Cover Off) | `526 x 1091 x 149` | NEC 408 / 277-480V |
| `panel-nema3r-outdoor` | NEMA-3R Outdoor Load Center | `410 x 844 x 182` | NEC 312.2 / NEMA 3R |
| `breaker-1p-2p-3p-set` | Circuit Breaker Trio (1P / 2P / 3P) | `225 x 76 x 92` | NEC 240.6 / 240.15 |
| `transformer-75kva-480v` | 75 kVA Dry-Type Transformer | `794 x 995 x 681` | NEC 450.3(B) / 110.26 |
| `safety-disconnect-100a` | 100A Heavy-Duty Safety Disconnect | `337 x 586 x 163` | NEC 430.102 |
| `meter-socket-200a` | 200A Ringless Utility Meter Base | `292 x 422 x 226` | NEC 230.66 |
| `panel-res-200a-cover-on` | 200A Load Center (Panel Cover On) | `452 x 907 x 152` | NEC 408.7 / UL 67 |
| `subpanel-100a-mlo` | 100A 12-Space MLO Subpanel (Wired) | `366 x 661 x 149` | NEC 250.24(A)(5) / 408 |
| `spd-type2-panel` | Type 2 Whole-Home Surge Protector (SPD) | `164 x 145 x 85` | NEC 230.67 |
| `vfd-drive-commercial` | Commercial 3-Phase VFD Motor Drive | `220 x 411 x 238` | NEC 430.122 |

### Solar PV, Battery ESS and Backup Power (5)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `solar-inverter-string` | String Solar PV Inverter (NEC 690) | `434 x 579 x 234` | NEC 690.15 / 690.31 |
| `battery-wall-ess` | Wall-Mounted Home Battery ESS (13.5 kWh) | `762 x 1157 x 156` | NEC 706.15 |
| `transfer-switch-200a` | 200A Automatic Transfer Switch (ATS) | `547 x 755 x 222` | NEC 702.5 |
| `generator-inlet-50a` | 50A NEMA SS2-50P Generator Inlet Box | `135 x 193 x 183` | NEC 702.7 |
| `ac-rapid-shutdown` | PV Rapid Shutdown / AC Disconnect Switch | `161 x 261 x 160` | NEC 690.12 |

### NEC 314.16 Outlet and Junction Boxes (7)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `box-1gang-pvc` | 1-Gang Blue PVC Nail-On Box (18 cu in) | `99 x 133 x 71` | NEC 314.16(A) |
| `box-2gang-pvc` | 2-Gang Blue PVC Nail-On Box (32 cu in) | `144 x 133 x 71` | NEC 314.16(A) |
| `box-3gang-pvc` | 3-Gang Blue PVC Nail-On Box (48 cu in) | `188 x 133 x 71` | NEC 314.16(A) |
| `box-4sq-steel-deep` | 4" Square x 2-1/8" Steel Box (1900) | `105 x 104 x 68` | NEC Table 314.16(A) |
| `box-4-11-16-steel` | 4-11/16" Commercial Junction Box | `146 x 146 x 58` | NEC Table 314.16(A) |
| `box-4oct-ceiling` | 4" Octagon Ceiling Steel Box | `96 x 102 x 73` | NEC 314.27 |
| `box-weatherproof-fs` | NEMA-3R Cast Weatherproof Bell Box | `71 x 159 x 55` | NEC 314.15 |

### Wiring Devices, Smart Controls, EVSE and Motors (11)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `device-duplex-20a` | 20A Duplex Receptacle (NEMA 5-20R) | `106 x 133 x 83` | NEC 210.52 |
| `device-gfci-20a` | 20A GFCI Receptacle (TEST/RESET) | `106 x 133 x 105` | NEC 210.8(A)/(B) |
| `device-nema-14-50r` | 50A NEMA 14-50R Range/EV Outlet | `122 x 122 x 90` | NEC 210.21 / 625 |
| `device-switch-decora` | Decora Rocker Wall Switch (1P/3-Way) | `106 x 133 x 94` | NEC 404.2 |
| `device-evse-level2` | Level 2 Wall EVSE Charger (48A) | `311 x 509 x 128` | NEC 625.41 |
| `device-motor-3p-tefc` | Commercial 3-Phase TEFC Motor | `530 x 415 x 340` | NEC 430.24 |
| `device-dimmer-smart` | Smart Decora Slide Dimmer Switch | `108 x 133 x 94` | NEC 404.2 |
| `device-usb-duplex-20a` | 20A TR USB-A / USB-C Duplex Receptacle | `108 x 133 x 107` | NEC 406.12 |
| `device-weatherproof-inuse` | Extra-Duty Weatherproof In-Use Bubble Cover | `96 x 161 x 137` | NEC 406.9(B)(1) |
| `device-floor-box-brass` | Recessed Solid-Brass Floor Outlet Box | `148 x 129 x 146` | NEC 314.27(B) |
| `device-smoke-co-alarm` | Hardwired 120V Interconnected Smoke/CO Alarm | `148 x 47 x 148` | IRC R314 / NEC 760 |

### Residential and Commercial Light Fixtures (9)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `fixture-can-6in-recessed` | 6" IC Recessed Can Downlight | `460 x 180 x 320` | NEC 410.116 |
| `fixture-troffer-2x4` | Commercial 2x4 LED Recessed Troffer | `1219 x 108 x 610` | NEC 410.36 |
| `fixture-highbay-ufo` | Warehouse UFO LED High-Bay | `390 x 210 x 390` | NEC 410.30 |
| `fixture-shop-4ft-strip` | 4 ft Commercial LED Strip Light | `1226 x 68 x 118` | NEC 410 |
| `fixture-wall-sconce-pack` | Exterior Commercial LED Wall Pack | `370 x 252 x 219` | NEC 410.10(A) |
| `fixture-flush-ceiling-drum` | Residential Flush LED Ceiling Drum | `340 x 91 x 340` | NEC 410 |
| `fixture-exit-sign` | Emergency EXIT Sign + Twin Floods | `504 x 190 x 89` | NEC 700.12 |
| `fixture-ceiling-fan-light` | 52" Ceiling Fan with Integrated LED Kit | `1231 x 333 x 1294` | NEC 314.27(C) |
| `fixture-under-cabinet-led` | 24" Hardwired Under-Cabinet LED Task Bar | `610 x 32 x 111` | NEC 410 |

### Conduit Bodies, Raceways, Grounding and Fittings (6)
| Slug | Name | Dimensions (mm) | NEC Ref |
|---|---|---|---|
| `conduit-body-lb-34` | 3/4" Type LB Conduit Body | `44 x 195 x 85` | NEC 314.16(C)(2) |
| `fitting-emt-connector-coupling` | 3/4" EMT Fittings & Unistrut Clamp Kit | `273 x 77 x 46` | NEC 358.30 / 358.42 |
| `conduit-body-ll-lr-t-set` | 3/4" Type LL, LR & T Conduit Body Trio | `264 x 180 x 54` | NEC 314.16(C)(2) |
| `wireway-gutter-4x4` | 4"x4"x4ft Hinged Auxiliary Wireway Gutter | `1223 x 115 x 118` | NEC 376 |
| `cable-tray-ladder` | 12" Aluminum Ladder Cable Tray Section | `1240 x 102 x 330` | NEC 392 |
| `ground-rod-acorn-clamp` | Copper-Clad Ground Rod + Acorn Clamp & GEC | `164 x 487 x 57` | NEC 250.52(A)(5) |
