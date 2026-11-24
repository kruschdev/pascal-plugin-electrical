# Pascal Plugin Electrical (`@kruschdev/pascal-plugin-electrical`)

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](./LICENSE)
[![Pascal Plugin API v1](https://img.shields.io/badge/Pascal_Plugin_API-v1-38bdf8.svg)](https://github.com/pascalorg/editor)
[![3D CAD Models](https://img.shields.io/badge/MIT_3D_CAD_Models-50_.glb-10b981.svg)](./docs/CAD-CATALOG.md)
[![NEC Tests](https://img.shields.io/badge/Tests-45%2F45_Passing-22c55e.svg)](./src/__tests__)

An open-source, MIT-licensed **Residential and Commercial NEC Electrical** plugin for [Pascal Editor](https://github.com/pascalorg/editor).

I built this as a standalone external plugin implementing Pascal's full Plugin API v1 contract (`E-014`, `E-016`, `E-017`) so it installs cleanly alongside any Pascal host without requiring upstream core merges.

## Walkthrough Video (Recorded Live in Pascal Editor)

![Live Pascal Editor Walkthrough: One-Click NEC Minimum Auto-Populate on Pascal's Built-In Two-Bedroom House, 3D Trade-Priority Routing Around Plumbing & HVAC, Cover-Off 3D Panel Interior Wiring View, Live Panelboard Schedule, NEC 220 Load Calc, and Live Priced BOM Calculator](./assets/demo-walkthrough.gif)

**[Watch Full 720p HD Walkthrough Video Recorded in Pascal Editor (`assets/demo-walkthrough.mp4`)](./assets/demo-walkthrough.mp4)**

1. **NEC Minimum Auto-Populate and Smart Room-Aware Auto-Wiring**: One click inside Pascal Editor scans each level (walls, T-junctions, doors, bathtubs/showers, and rooms) to place a 200A panelboard (`MDP-1`), flush wall-snapped 6 ft / 12 ft outlets, kitchen GFCIs, bathroom vanity GFCI, front-door entry and outdoor WR GFCIs, door-jamb wall switches, ceiling lights, balanced circuits, Home Runs, and Outlet-to-Outlet Daisy-Chain runs with `0` NEC errors. Adding another outlet in an existing room automatically snaps it to a wall, extends that room's circuit run, upsizes spliced anchor boxes per NEC 314.16, and checks NEC 210.19(A) voltage drop, while adding an outlet in a new room (or any dedicated load) allocates a balanced circuit and creates a Home Run from the panel.
2. **Concealed In-Wall 3D Manhattan Routing and Native Pascal Viewer Inspection**: Cables route dead-center inside wall cavities (horizontal stud chases between same-wall outlets, vertical risers climbing inside stud bays over doors, and 90-degree wall top-plate runs, never climbing above wall caps or cutting across open rooms). The Electrical rail integrates directly with Pascal's native `useViewer` (`Full Walls`, `Cutaway`, `Low Walls`, and `X-Ray Wiring`) so walls stay clean in finished view and peel away in one click to inspect every concealed run inside the walls.
3. **Zoom-In 3D Panel Interior View (`Cover Off`, `Panel Cover On`, and `Cover Closed`)**: Opens inside Pascal's split-pane `Electrical Schedule` view to show the live open load center with copper busbar stabs, AFCI/GFCI breakers, neutral/ground bars, and every 90-degree-bent conductor landing cleanly on its lug. Toggling **Panel Cover On** seats a flush ANSI-61 gray steel cover with an engraved NEMA phenolic nameplate, compact NEC 110.16 arc-flash warning placard, main breaker cutout, white circuit index strips, and UL 67 galvanized spare twist-out filler plates over all live parts.
4. **25 Live Placeable Equipment Kinds and 50 Clean-Room MIT 3D CAD Models**: Place any of 25 live equipment and device kinds directly from the Electrical rail's **Catalog Equipment** picker or `electrical_place_device` agent tool (including Solar PV Inverter, 13.5 kWh Wall Battery ESS, 200A ATS, 50A Generator Inlet, PV Rapid Shutdown, Type 2 SPD, 3-Phase VFD, Smart Slide Dimmer, 20A USB-A/USB-C Duplex, Weatherproof In-Use Bubble GFCI, Recessed Brass Floor Box, Hardwired Smoke/CO Alarm, 52" Ceiling Fan with LED Kit, and 24" Under-Cabinet LED Bar) with automatic wall/ceiling/floor placement, 2D floorplan symbols, room-aware auto-wiring, NEC compliance auditing, and BOM pricing.
5. **Live Panelboard Schedule, NEC 220 Load Calc, and Priced BOM Takeoff**: Inspects populated Odd/Even `L1/L2` or `A/B/C` breaker circuits, wire gauges, phase balance, Residential Standard / Optional (`220.82`) and Commercial 3-phase service loads, plus live Labor (`$/hr`), Material Markup (`%`), and Material Tax (`%`) BOM totals and CSV exports alongside the live NEC compliance audit.

## Showcase Gallery

![4-Panel 3D Panel Interior Showcase: Residential 200A Cover Off, Zoomed Breakers/Lugs/Gutters, Rebuilt Panel Cover On with Engraved NEMA Nameplate and NEC 110.16 Arc-Flash Placard, and Commercial 400A 277/480V 3-Phase Panelboard](./assets/demo-panel-wired-interior.png)

![Live Pascal Editor Electrical Rail and Native Low Walls Inspection View: Concealed In-Wall 3D Manhattan Routing, Catalog Equipment Picker, and Trade-Priority Obstacle Detection](./assets/demo-3d-trade-routing.png)

![Split-Pane Pascal Editor 3D Viewport and Live Populated Panelboard Schedule with NEC Audit (0/0)](./assets/demo-panel-schedule.png)

![50 Clean-Room MIT Electrical CAD Material Models (.glb): Load Centers, Open-Cover and Panel-Cover-On Panels, Solar Inverters, Battery ESS, Automatic Transfer Switches, VFDs, SPDs, Dry-Type Transformers, NEC 314.16 Boxes, Smart Wiring Devices, Light Fixtures, Cable Tray, Wireways, and Grounding Hardware](./assets/cad-material-catalog.png)

### 50-Model Clean-Room MIT CAD Library (6 Categories)

| Category | Count | Included Highlights |
|---|---|---|
| **Panels, Breakers and Distribution Gear** | 12 | 200A Load Centers (`Closed`, `Cover Off`, `Panel Cover On`), 400A 277/480V 3P Panelboard, 100A MLO Subpanel, NEMA-3R Outdoor Panel, 75 kVA Transformer, 100A Safety Disconnect, 200A Meter Base, Breaker Trio, Type 2 SPD, Commercial 3P VFD |
| **Solar PV, Battery ESS and Backup Power** | 5 | String Solar PV Inverter (`NEC 690`), 13.5 kWh Wall Battery ESS (`NEC 706`), 200A NEMA-3R Automatic Transfer Switch (`NEC 702`), 50A SS2-50P Generator Inlet Box, PV Rapid Shutdown / AC Disconnect (`NEC 690.12`) |
| **NEC 314.16 Outlet and Junction Boxes** | 7 | 1/2/3-Gang Blue PVC Nail-On Boxes, 4" Square Deep 1900 Steel Box, 4-11/16" Commercial J-Box, 4" Octagon Ceiling Box, NEMA-3R Cast Weatherproof Bell Box |
| **Wiring Devices, Smart Controls and Motors** | 11 | 20A Duplex, 20A GFCI, 50A NEMA 14-50R, Decora Rocker Switch, Smart Slide Dimmer, 20A USB-A/USB-C Duplex, Weatherproof In-Use Bubble Cover, Recessed Solid-Brass Floor Box, Hardwired 120V Smoke/CO Alarm, 48A Level 2 EVSE, 3-Phase TEFC Motor |
| **Residential and Commercial Light Fixtures** | 9 | 6" IC Recessed Can, 2x4 LED Troffer, Warehouse UFO High-Bay, 4 ft LED Strip, Exterior LED Wall Pack, Flush Ceiling Drum, Emergency EXIT Sign + Twin Floods, 52" Ceiling Fan with LED Kit, 24" Under-Cabinet LED Task Bar |
| **Conduit, Cable Tray and Grounding** | 6 | 3/4" Type LB Conduit Body, Type LL/LR/T Conduit Body Trio, 3/4" EMT Fittings and Unistrut Clamp Kit, 4"x4"x4ft Hinged Auxiliary Wireway Gutter (`NEC 376`), 12" Aluminum Ladder Cable Tray (`NEC 392`), Copper-Clad Ground Rod + Bronze Acorn Clamp and #6 GEC (`NEC 250.52`) |

> **Drafting and engineering aid, not stamped engineering.** Always verify calculations, conductor sizing, and local AHJ amendments with a licensed electrical engineer or inspector before construction.

## Core Principle: Trade-Priority Routing

On a real jobsite, electrical yields to gravity-bound and rigid trades. Electrical never moves a drain pipe or sheet-metal trunk.

1. **Structural** (`beam`, `column`, `stair`, wall openings): inviolable.
2. **Plumbing** (`pipe-segment`, `pipe-fitting`, `pipe-trap`, `liquid-line`): gravity DWV and supply hold first MEP right-of-way.
3. **HVAC** (`duct-segment`, `duct-fitting`, `duct-terminal`, `hvac-equipment`, `lineset`): rigid trunks and air handlers hold second MEP right-of-way.
4. **Electrical** (`electrical:conduit-run`): automatically routes orthogonally in 3D around all higher-priority obstacles, tracks every detour, counts cumulative bend degrees against the **NEC 358.26 / 344.26 / 352.26 360-degree pull-point limit**, and feeds the actual detoured length straight into **Voltage Drop (NEC 210.19 / 215.2)** and **Material Takeoff**.

The one code exception where foreign systems cannot invade electrical is **NEC 110.26(E) Dedicated Electrical Space**: if a Pascal plumbing pipe or HVAC duct passes directly above an `electrical:panel` or `electrical:transformer` footprint, the auditor flags the violation and recommends relocating the electrical equipment clear of the piping or adding leak protection.

## Documentation

| Guide | What It Covers |
|---|---|
| **[Architecture Guide](./docs/ARCHITECTURE.md)** | System diagram, 6 entrypoint boundary gates, 4 `electrical:*` node kinds, local-yaw 2D SAT clearances, and cover-off 3D panel pipeline |
| **[NEC Engineering Reference](./docs/NEC-REFERENCE.md)** | Every implemented NEC Article and Table (`220`, `210.8`, `210.11`, `210.12`, `210.19`, `210.52`, `210.70`, `240.4(D)`, `240.24`, `310.16`, `312.2`, `314.16`, `358.26`, `404.4(C)`, `406.5(E)`, `406.9(C)`, `410.10(D)`, `410.16(C)`, `450.3(B)`, `705.12`, `110.26`, `Ch. 9`) |
| **[50-Model MIT 3D CAD Catalog](./docs/CAD-CATALOG.md)** | Full inventory of all 50 `.glb` models across 6 categories (including Solar/ESS/ATS, Smart Controls, VFDs, Cable Tray, and Grounding), dimensions in mm, NEC references, and programmatic `./cad` usage |
| **[Agent Tools Reference (`E-016`)](./docs/AGENT-TOOLS.md)** | All 8 pure Zod agent tools (including 25 live placeable device/equipment kinds and `wallPlacement` routing) and pure scene operations for MCP servers, chat workflows, and headless automation |
| **[Media Kit & Launch Copy](./docs/MEDIA-KIT.md)** | Ready-to-share social preview (`1280 x 640`), HD walkthrough video, high-res screenshots, CAD contact sheet, and X / LinkedIn / Show HN launch copy |
| **[Walkthrough Voiceover Script](./docs/WALKTHROUGH-SCRIPT.md)** | Timed 48-second narration beat sheet and one-command Gemini TTS (`gemini-3.8-flash-tts`) + `ffmpeg` muxing script (`scripts/add-voiceover.sh`) |
| **[Contributing Guide](./CONTRIBUTING.md)** | Local setup, boundary gates, CAD `.glb` regeneration, and PR guidelines |

## Package Entrypoints

| Entrypoint | Export | Boundary Guarantee |
|---|---|---|
| `.` | `electricalPlugin`, `electricalHostPanel`, `electricalScheduleView`, `electricalChatExtension` | Full editor integration (`EditorHostPanel`, full-pane `EditorHostView`, `InspectorExtension`, chat cards) |
| `./render` | `electricalRenderPlugin` | Editor-free read-only viewer manifest (verified by `bun run check:render`) |
| `./cad` | `ELECTRICAL_CAD_CATALOG`, `buildElectricalCadPart`, `buildWiredPanelInteriorCad`, `buildPanelCad`, `buildElectricalBoxCad`, `buildDeviceCad`, `buildConduitRunCad` | Editor-free, React-free Three.js CAD part builders for all 50 electrical materials |
| `./nec` | Pure NEC, auto-populate, audit, trade-routing, schedule, and BOM pricing functions | Framework-free TypeScript (zero React, Three.js, or `@pascal-app/*`) |
| `./agent-tools` | `electricalAgentTools` (`PluginAgentTools`, `E-016`) | Pure Zod-only contracts (`8` tools + skill) |
| `./agent-operations` | `electricalAgentOperations` (`AgentOperations`, `E-016`) | Pure scene operations runnable on MCP, detached runtime, or live chat |

## Quick Start in a Pascal Host

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

For read-only viewers (zero `@pascal-app/editor` bundle overhead):

```ts
import { setPluginDiscovery } from '@pascal-app/core'
import { electricalRenderPlugin } from '@kruschdev/pascal-plugin-electrical/render'

setPluginDiscovery(async () => [electricalRenderPlugin])
```

## Development and Verification

```bash
bun install
bun run check              # tsc --noEmit + bun test src (45/45 tests) + all 4 boundary gates
bun run export:cad         # Regenerate all 50 binary .glb models in assets/cad/
bun scripts/render-cad-thumbnails.ts # Re-render all 50 thumbnails + 5x10 contact sheet
bun run render:walkthrough # Re-render assets/demo-walkthrough.mp4 and .gif
```

## License

MIT. Created by Kevin Ruschman ([@kruschdev](https://github.com/kruschdev)).
