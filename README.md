# Pascal Plugin Electrical (`@kruschdev/pascal-plugin-electrical`)

An open-source, MIT-licensed **Residential and Commercial NEC Electrical** plugin for [Pascal Editor](https://github.com/pascalorg/editor).

I built this as a standalone external plugin implementing Pascal's full Plugin API v1 contract (`E-014`, `E-016`, `E-017`) so it installs cleanly alongside any Pascal host without requiring upstream core merges.

![Live 3D Trade-Priority Routing in Pascal Editor: EMT conduit runs yielding cleanly around a 4-inch plumbing pipe and 18x10 HVAC trunk, with NEC 110.26 working-space clearance envelopes on LP-1 and TX-1](./assets/demo-3d-trade-routing.png)

![Split 3D Viewport, Electrical Rail Panel, and Full-Pane 3-Phase Panelboard Schedule View](./assets/demo-panel-schedule.png)

![Cover-Off 3D Panel Interior View: Copper Busbars, Main & Branch Breakers, Neutral/Ground Bars, and Every Individual NEC Phase-Colored Wire Landed on Its Terminal](./assets/demo-panel-wired-interior.png)

![30 Clean-Room MIT Electrical CAD Material Models (.glb): Load Centers, Open-Deadfront Panels, Circuit Breakers, Dry-Type Transformers, NEC 314.16 Boxes, Wiring Devices, Residential & Commercial Light Fixtures, and Conduit Fittings](./assets/cad-material-catalog.png)

> **Drafting and engineering aid, not stamped engineering.** Always verify calculations, conductor sizing, and local AHJ amendments with a licensed engineer or electrical inspector before construction.

## Core Principle: Trade-Priority Routing

On a real jobsite, electrical yields to gravity-bound and rigid trades. Electrical never moves a drain pipe or sheet-metal trunk.

1. **Structural** (`beam`, `column`, `stair`, wall openings): inviolable.
2. **Plumbing** (`pipe-segment`, `pipe-fitting`, `pipe-trap`, `liquid-line`): gravity DWV and supply hold first MEP right-of-way.
3. **HVAC** (`duct-segment`, `duct-fitting`, `duct-terminal`, `hvac-equipment`, `lineset`): rigid trunks and air handlers hold second MEP right-of-way.
4. **Electrical** (`electrical:conduit-run`): automatically routes orthogonally in 3D around all higher-priority obstacles, tracks every detour, counts cumulative bend degrees against the **NEC 358.26 / 344.26 / 352.26 360-degree pull-point limit**, and feeds the actual detoured length straight into **Voltage Drop (NEC 210.19 / 215.2)** and **Material Takeoff**.

The one code exception where foreign systems cannot invade electrical is **NEC 110.26(E) Dedicated Electrical Space**: if a Pascal plumbing pipe or HVAC duct passes directly above an `electrical:panel` footprint, the auditor flags the violation and recommends relocating the panel clear of the piping or adding leak protection.

## What It Ships

### 4 First-Class Editable Node Kinds (`id: 'krusch:electrical'`)
- `electrical:panel`: Residential single-phase (`120/240V-1P`) and commercial three-phase (`120/208V-3P`, `277/480V-3P`) panelboards with NEMA enclosure sizing, main breaker / MLO ratings, solar backfeed tracking, 3D **NEC 110.26 working-clearance prism** (`30"W x 36"/42"/48"D x 78"H`), and 2D IEEE panelboard symbols.
- `electrical:device`: Editable duplex, GFCI, AFCI, 240V dedicated, EVSE, 1-pole / 3-way switches, luminaires, exit signs, commercial 3-phase motor loads, and junction/pull boxes with live **NEC 314.16 Box Fill** volume tracking.
- `electrical:conduit-run`: Color-coded 3D/2D polyline raceways and cables (`NM-B`, `MC`, `EMT`, `PVC-40`, `RMC`) with live **Table 310.16 / 310.15 derated ampacity**, **NEC Chapter 9 conduit fill**, **360-degree bend checks**, and **1-phase / 3-phase voltage drop**.
- `electrical:transformer`: Commercial dry-type step-down transformers (`480V -> 120/208V 3P`) with **NEC Table 450.3(B)** primary/secondary FLA and OCPD sizing.

### Deterministic Residential & Commercial NEC Engine (`./nec`)
Zero LLM calls, zero React/Three.js dependencies:
- **NEC Article 220 Service Load Calculations**:
  - Residential Standard Method (`220.12`, `220.42`, `220.50`, `220.52`, `220.54`, `220.55` Col. C, `220.60`, `625.41` EVSE) and Optional Method (`220.82`)
  - Solar PV **120% Busbar Rule** (`NEC 705.12(B)(3)(2)`)
  - Commercial Occupancies (`Table 220.12` Office, Retail, Warehouse, Restaurant, School, Healthcare, Industrial, Garage with 125% continuous lighting, `220.14(I)` + `Table 220.44` receptacle demand, `430.24` motor loads, `220.60` non-coincident HVAC, 3-phase current)
- **Table 310.16 + 310.15(B)/(C) + 240.4(D)**: Copper & Aluminum `60°C` / `75°C` / `90°C` ampacity, ambient correction, rooftop `+33°C` adder, bundling adjustment, `334.80` NM-B 60°C cap, and small-conductor OCPD limits.
- **Chapter 9 Conduit Fill**: EMT, PVC Sch 40, and RMC (`53%` / `31%` / `40%` + `60%` nipple exception `<= 24"`).
- **Article 314.16 Box Fill**: Conductors, 2x device yokes, internal clamps, support fittings, and equipment grounds.
- **NEC Minimum Auto-Populate (`electrical_autopopulate_nec`)**: Walks live Pascal walls, exterior doors, stairways, and room zones to automatically place 6 ft / 12 ft wall outlets (`210.52(A)`), 4 ft kitchen countertop GFCIs split across 2x 20A SAB circuits (`210.52(C)` / `210.11(C)(1)`), dedicated bathroom/laundry/garage/outdoor WR GFCIs (`210.52(D)-(G)`), front-door entry switch + exterior light + outlet (`210.70(A)(2)(b)`), stairway landing outlet + top/bottom 3-way switches + light (`210.70(A)(2)(c)`), balanced panel circuits (Hybrid GFCI outlets + AFCI breakers OR panel GFCI/AFCI breakers), Home Runs (`Panel -> First Device`), and Outlet-to-Outlet Daisy-Chain runs yielding around plumbing/HVAC/structural obstacles.
- **NEC Prohibited-Location & Restricted-Zone Auditor (`electrical_audit_nec`)**: Live red `NOT TO CODE` alerts in both the selected-node Inspector card and clickable Left-Rail violation list flag panels inside bathrooms (`240.24(E)`), clothes closets (`240.24(D)`), over stairway steps (`240.24(F)`), mounted too high (`> 6'-7"`, `240.24(A)`), or indoor `NEMA-1`/`NEMA-2` panels/transformers placed outdoors (`312.2` / `450.22`); receptacles, switches, or low luminaires inside the 3 ft x 8 ft bathtub/shower restricted zone (`406.9(C)`, `404.4(C)`, `410.10(D)`); outlets over stoves (`210.52(C)` / `110.11`) or inside sink basins (`406.5(E)`); low closet luminaires (`410.16(C)`); and mixed bathroom or kitchen small-appliance circuits (`210.11(C)(1)/(3)`).
- **Panelboard Schedules, Material Lists & Live Price Calculator**: Odd/Even `L1/L2` (1P) and `A/B/C` (3P) breaker schedules, phase imbalance %, CSV export, and a full **Priced Bill of Materials (BOM)** calculating 10%-waste Copper/Aluminum wire rolls, 10 ft conduit sticks, connectors/couplings/straps, NEC 314.16 boxes, breakers, panels, transformers, fixtures, live editable Labor Rate / Markup / Tax controls, custom distributor `priceOverrides`, and one-click BOM CSV export.
- **30-Model Clean-Room MIT 3D CAD Library (`./cad` & `assets/cad/`)**: Every material (closed/open load centers, 277/480V 3P panelboards, NEMA 3R panels, 1P/2P/3P breakers, 75 kVA transformer, 100A safety disconnect, 200A meter base, 1/2/3-gang PVC & 4" square / 4-11/16" / 4" octagon / weatherproof FS boxes, NEMA 5-20R / GFCI / 14-50R / Decora switches / EVSE / 3P TEFC motor, 7 residential & commercial light fixtures, Type LB conduit body, and EMT fittings + Unistrut clamps) ships as both live Three.js geometry and pre-exported `.glb` + `.png` thumbnails in Pascal's `public/items/<slug>/` layout.

### Full Pascal Plugin API v1 Surface
| Entrypoint | Export | Boundary Guarantee |
|---|---|---|
| `.` | `electricalPlugin`, `electricalHostPanel`, `electricalScheduleView`, `electricalChatExtension` | Full editor integration (`EditorHostPanel`, full-pane `EditorHostView`, `InspectorExtension`, chat cards) |
| `./render` | `electricalRenderPlugin` | Editor-free read-only viewer manifest (verified by `bun run check:render`) |
| `./cad` | `ELECTRICAL_CAD_CATALOG`, `buildElectricalCadPart`, `buildPanelCad`, `buildElectricalBoxCad`, `buildDeviceCad`, `buildConduitRunCad` | Editor-free, React-free Three.js CAD part builders for all 30 electrical materials |
| `./nec` | Pure NEC, trade-routing & BOM pricing functions | Framework-free TypeScript (zero React, Three.js, or `@pascal-app/*`) |
| `./agent-tools` | `electricalAgentTools` (`PluginAgentTools`, `E-016`) | Pure Zod-only contracts (`8` tools + skill) |
| `./agent-operations` | `electricalAgentOperations` (`AgentOperations`, `E-016`) | Pure scene operations runnable on MCP, detached runtime, or live chat |

## Load in a Pascal Host

```ts
import { extendPluginDiscovery } from '@pascal-app/core'
import { registerEditorHostPanel, registerEditorHostView } from '@pascal-app/editor'
import {
  electricalHostPanel,
  electricalPlugin,
  electricalScheduleView,
} from '@kruschdev/pascal-plugin-electrical'

extendPluginDiscovery(async () => [electricalPlugin])
registerEditorHostPanel(electricalHostPanel)
registerEditorHostView(electricalScheduleView)
```

For read-only viewers:

```ts
import { setPluginDiscovery } from '@pascal-app/core'
import { electricalRenderPlugin } from '@kruschdev/pascal-plugin-electrical/render'

setPluginDiscovery(async () => [electricalRenderPlugin])
```

## Development & Verification

```bash
bun install
bun run check        # tsc --noEmit + bun test + render/agent-tools/nec boundary gates
```

## License

MIT. Created by Kevin Ruschman ([@kruschdev](https://github.com/kruschdev)).
