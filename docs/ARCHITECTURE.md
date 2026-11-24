# Architecture Overview

I designed `@kruschdev/pascal-plugin-electrical` as a clean, multi-entrypoint Pascal Editor Plugin API v1 package (`E-014`, `E-016`, `E-017`) where the deterministic NEC engineering engine, the 3D CAD geometry builders, the Zod agent contracts, and the React editor UI are strictly isolated by bundler-verified boundary gates.

## High-Level System Flow

```mermaid
flowchart LR
  Scene["Pascal Scene Graph (walls, doors, stairs, zones, pipes, ducts, fixtures)"]
  NEC["./nec Pure TS Engine (Art. 220, 310.16, 314.16, Routing, Auto-Populate, Audit, BOM)"]
  CAD["./cad Three.js Builders (30 MIT Materials + Cover-Off Wired Panel Interior)"]
  Render["./render Viewer Manifest (4 electrical:* Nodes, 3D + 2D Floorplan)"]
  Tools["./agent-tools & ./agent-operations (8 Pure E-016 Contracts)"]
  UI["Editor UI (Rail Panel, Inspector Card, Schedule View, 3D Panel Interior)"]

  Scene --> NEC
  NEC --> Tools
  NEC --> UI
  CAD --> Render
  Render --> UI
  Tools --> Scene
```

## Entrypoint Boundary Guarantees

Every subpath export in [`package.json`](../package.json) is enforced on every commit by `bun run check:render` ([`scripts/check-render-entry.ts`](../scripts/check-render-entry.ts)):

| Subpath | Module | Runtime Dependencies Allowed | Purpose |
|---|---|---|---|
| `.` | `src/index.ts` | `@pascal-app/core`, `@pascal-app/editor`, React, Three.js, Zustand | Full editor integration (`electricalPlugin`, `electricalHostPanel`, `electricalScheduleView`, `electricalChatExtension`) |
| `./render` | `src/render.ts` | `@pascal-app/core`, Three.js, Zod | Read-only viewer manifest (`electricalRenderPlugin`) with zero `@pascal-app/editor` or `next` imports |
| `./cad` | `src/cad/index.ts` | Three.js + `./nec` types | Standalone 30-model MIT electrical CAD & cover-off panel interior builders with zero React or editor imports |
| `./nec` | `src/nec/index.ts` | Pure TypeScript only | Zero React, zero Three.js, zero `@pascal-app/*`; runs identically in Node, Bun, Cloudflare Workers, or browsers |
| `./agent-tools` | `src/agent-tools.ts` | `@pascal-app/core/agent-tools`, Zod | Pure Zod schemas and skill metadata (`E-016`) for MCP servers and LLM tool registries |
| `./agent-operations` | `src/agent-operations.ts` | `@pascal-app/core`, `./nec`, `./render` | Pure deterministic scene operations returning `{ result, changes }` diffs without touching DOM or React |

## Four Editable Node Kinds (`pluginId: 'krusch:electrical'`)

1. **`electrical:panel`** (`src/nodes/panel.ts`): Residential split-phase (`120/240V-1P`) and commercial three-phase (`120/208V-3P`, `277/480V-3P`) panelboards with NEMA ratings (`NEMA-1`, `NEMA-3R`, `NEMA-4X`), bus/main ratings, solar backfeed amps, optional `coverRemoved` live interior rendering, a 3D translucent **NEC 110.26 working-space prism**, and 2D IEEE floorplan symbols.
2. **`electrical:device`** (`src/nodes/device.ts`): Duplex, GFCI, AFCI, 240V dedicated, Level 2 EVSE, 1-pole and 3-way switches, luminaires, emergency exit signs, 3-phase motor loads, and junction/pull boxes with live **NEC 314.16 Box Fill** tracking.
3. **`electrical:conduit-run`** (`src/nodes/conduit-run.ts`): 3D polyline raceways and cables (`nm-b`, `mc`, `emt`, `pvc-40`, `rmc`) with swept cylindrical segments, shared elbow fittings, live ampacity derating, Chapter 9 fill, 360-degree bend limits, and voltage drop.
4. **`electrical:transformer`** (`src/nodes/transformer.ts`): Commercial dry-type step-down transformers (`480V -> 208Y/120V 3P`) with NEC Table 450.3(B) FLA/OCPD sizing, rotated 3D primary/secondary ports, and local-yaw working-space clearance envelopes.

## Trade-Priority Obstacle Routing (`src/nec/routing.ts`)

Electrical runs never relocate structural or gravity-bound trades. `extractTradeObstacles` reads every Pascal `beam`, `column`, `stair`, `pipe-segment`, `pipe-fitting`, `pipe-trap`, `liquid-line`, `duct-segment`, `duct-fitting`, `duct-terminal`, `hvac-equipment`, and `lineset` node into 3D bounding volumes with configurable clearance margins.

`routeElectricalRun` computes an orthogonal 3D path from panel lug to device box along the ceiling chase (`preferredChaseY`), detects segment intersections against higher-priority obstacles, applies minimum-clearance vertical or lateral detours, deduplicates coincident vertices, counts cumulative bend angles (`countPathBendDegrees`) against the **NEC 358.26 360-degree pull-point limit**, and feeds the exact detoured 3D length straight into **Voltage Drop** (`calculateVoltageDrop`) and **Material Takeoff** (`buildElectricalTakeoff`).

## Local-Yaw 2D SAT Clearance Checking (`src/nec/audit.ts`)

Rotated panels and floor-mounted transformers cannot be checked accurately with world-axis AABBs. `getEquipmentSpacePrisms` builds oriented prisms aligned to each panel or transformer's `rotation` yaw (`cos`, `sin`), and `prismIntersectsAabb` runs a full 2D Separating Axis Theorem (SAT) test in XZ plus Y overlap against every cabinet, fixture, column, HVAC unit, and overhead pipe/duct.

## Cover-Off 3D Panel Interior Pipeline (`src/cad/panel-interior.ts` and `src/ui/panel-interior-view.tsx`)

`buildWiredPanelInteriorCad` consumes a live `PanelSchedule` and generates:
- A hollow galvanized steel tub with rear mounting flanges and knockouts.
- Exposed copper 2-bus (split-phase) or 3-bus (three-phase) central stabs, main breaker or MLO lugs, and service entrance feeders.
- Isolated neutral and ground bus bars with an NEC 250.28 green bonding screw on main-breaker service panels.
- Populated 1P, 2P, and 3P molded-case breakers with colored handles, AFCI/GFCI test buttons, neutral pigtails, and brass wire lugs.
- Every individual Hot, Neutral, and Ground branch conductor routed down the side wiring gutters with 90-degree bends into its exact terminal, using NEC phase color coding (`Black/Red` for 120/240V, `Black/Red/Blue` for 120/208V, `Brown/Orange/Yellow` for 277/480V).

`PanelInteriorView` mounts a single persistent `WebGLRenderer` with `ResizeObserver`, preserves camera orbit across toggle changes, supports **Cover Off / Deadfront On / Cover Closed** and **Hots / Neutrals / Grounds / Feeders** visibility filters, and raycasts clicks on any wire or breaker to highlight its circuit details.

## UI Store Isolation (`src/ui/store.ts`)

All plugin-local UI state (`occupancy`, `activeTab`, `selectedPanelId`, `residentialMethod`, `commercialBuildingType`) lives inside `useElectricalUi`. Scene edits triggered from the rail panel (such as `Auto-Populate NEC Layout & Wiring` or `Auto-Route Around Trades`) wrap multi-node creations inside Pascal's `runAsSingleSceneHistoryStep(useScene, ...)` so one `Ctrl+Z` cleanly undoes the entire layout.
