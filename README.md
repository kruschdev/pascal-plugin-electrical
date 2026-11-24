# Pascal Plugin Electrical (`@kruschdev/pascal-plugin-electrical`)

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](./LICENSE)
[![Pascal Plugin API v1](https://img.shields.io/badge/Pascal_Plugin_API-v1-38bdf8.svg)](https://github.com/pascalorg/editor)
[![3D CAD Models](https://img.shields.io/badge/MIT_3D_CAD_Models-30_.glb-10b981.svg)](./docs/CAD-CATALOG.md)
[![NEC Tests](https://img.shields.io/badge/Tests-40%2F40_Passing-22c55e.svg)](./src/__tests__)

An open-source, MIT-licensed **Residential and Commercial NEC Electrical** plugin for [Pascal Editor](https://github.com/pascalorg/editor).

I built this as a standalone external plugin implementing Pascal's full Plugin API v1 contract (`E-014`, `E-016`, `E-017`) so it installs cleanly alongside any Pascal host without requiring upstream core merges.

## Walkthrough Video (Recorded Live in Pascal Editor)

![Live Pascal Editor Walkthrough: One-Click NEC Minimum Auto-Populate on Pascal's Built-In Two-Bedroom House, 3D Trade-Priority Routing Around Plumbing & HVAC, Cover-Off 3D Panel Interior Wiring View, Live Panelboard Schedule, NEC 220 Load Calc, and Live Priced BOM Calculator](./assets/demo-walkthrough.gif)

**[Watch Full 720p HD Walkthrough Video Recorded in Pascal Editor (`assets/demo-walkthrough.mp4`)](./assets/demo-walkthrough.mp4)**

1. **NEC Minimum Auto-Populate and Smart Outlet Auto-Wiring**: One click inside Pascal Editor scans the built-in two-bedroom house (walls, T-junctions, doors, and rooms) to place a 200A panelboard (`MDP-1`), flush wall-snapped 6 ft / 12 ft outlets, kitchen GFCIs, bathroom vanity GFCI, front-door entry and outdoor WR GFCIs, door-jamb wall switches, ceiling lights, balanced circuits, Home Runs, and Outlet-to-Outlet Daisy-Chain runs with `0` NEC errors. Adding another outlet in an existing room automatically snaps it to a wall and extends that room's circuit run, while adding an outlet in a new room automatically allocates a balanced circuit and creates a Home Run from the panel.
2. **Concealed In-Wall 3D Manhattan Routing and Native Pascal Viewer Inspection**: Cables route dead-center inside wall cavities (horizontal stud chases between same-wall outlets, vertical risers climbing inside stud bays over doors, and 90-degree wall top-plate runs, never cutting across open rooms). The Electrical rail integrates directly with Pascal's native `useViewer` (`Full Walls`, `Cutaway`, `Low Walls`, and `X-Ray Wiring`) so walls stay clean in finished view and peel away in one click to inspect every concealed run inside the walls.
3. **Zoom-In Cover-Off 3D Panel Interior View**: Opens inside Pascal's split-pane `Electrical Schedule` view to show the live open 200A load center with copper busbar stabs, AFCI/GFCI breakers, neutral/ground bars, and every 90-degree-bent conductor landing on its lug, with live *Full Open Panel*, *Zoom: Breakers & Lugs*, and *Deadfront On / Cover Off* toggles.
4. **Live Panelboard Schedule and NEC 220 Load Calc**: Inspects populated Odd/Even `L1/L2` breaker circuits, wire gauges, phase balance, and Residential Standard / Optional (`220.82`) service load calculations.
5. **Takeoff and Cost Live Price Calculator plus NEC Audit**: Adjusts live Labor (`$/hr`), Material Markup (`%`), and Material Tax (`%`) right inside Pascal Editor to recalculate BOM totals and CSV exports alongside the live NEC compliance audit.

## Showcase Gallery

![Cover-Off 3D Panel Interior View: Copper Busbars, Main & Branch Breakers, Neutral/Ground Bars, and Every Individual NEC Phase-Colored Wire Landed on Its Terminal](./assets/demo-panel-wired-interior.png)

![Live 3D Trade-Priority Routing in Pascal Editor: EMT conduit runs yielding cleanly around a 4-inch plumbing pipe and 18x10 HVAC trunk, with NEC 110.26 working-space clearance envelopes on LP-1 and TX-1](./assets/demo-3d-trade-routing.png)

![Split 3D Viewport, Electrical Rail Panel, and Full-Pane 3-Phase Panelboard Schedule View](./assets/demo-panel-schedule.png)

![30 Clean-Room MIT Electrical CAD Material Models (.glb): Load Centers, Open-Deadfront Panels, Circuit Breakers, Dry-Type Transformers, NEC 314.16 Boxes, Wiring Devices, Residential & Commercial Light Fixtures, and Conduit Fittings](./assets/cad-material-catalog.png)

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
| **[30-Model MIT 3D CAD Catalog](./docs/CAD-CATALOG.md)** | Full inventory of all 30 `.glb` models, dimensions in mm, NEC references, and programmatic `./cad` usage |
| **[Agent Tools Reference (`E-016`)](./docs/AGENT-TOOLS.md)** | All 8 pure Zod agent tools and pure scene operations for MCP servers, chat workflows, and headless automation |
| **[Contributing Guide](./CONTRIBUTING.md)** | Local setup, boundary gates, CAD `.glb` regeneration, and PR guidelines |

## Package Entrypoints

| Entrypoint | Export | Boundary Guarantee |
|---|---|---|
| `.` | `electricalPlugin`, `electricalHostPanel`, `electricalScheduleView`, `electricalChatExtension` | Full editor integration (`EditorHostPanel`, full-pane `EditorHostView`, `InspectorExtension`, chat cards) |
| `./render` | `electricalRenderPlugin` | Editor-free read-only viewer manifest (verified by `bun run check:render`) |
| `./cad` | `ELECTRICAL_CAD_CATALOG`, `buildElectricalCadPart`, `buildWiredPanelInteriorCad`, `buildPanelCad`, `buildElectricalBoxCad`, `buildDeviceCad`, `buildConduitRunCad` | Editor-free, React-free Three.js CAD part builders for all 30 electrical materials |
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
bun run check              # tsc --noEmit + bun test src + all 4 boundary gates
bun run export:cad         # Regenerate all 30 binary .glb models in assets/cad/
bun run render:walkthrough # Re-render assets/demo-walkthrough.mp4 and .gif
```

## License

MIT. Created by Kevin Ruschman ([@kruschdev](https://github.com/kruschdev)).
