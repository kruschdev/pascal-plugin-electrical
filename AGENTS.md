# Pascal Plugin Electrical (`AGENTS.md`)

> Standalone MIT Residential and Commercial NEC Electrical Plugin for Pascal Editor (`@kruschdev/pascal-plugin-electrical`, `pluginId: krusch:electrical`).

## Hazards and Non-Negotiable Invariants

1. **Trade-Priority Right-of-Way**: Electrical (`electrical:conduit-run`) ALWAYS yields to higher-priority trades in the scene graph (`1. Structural -> 2. Plumbing -> 3. HVAC -> 4. Electrical`). Never mutate plumbing (`pipe-*`) or HVAC (`duct-*`, `hvac-equipment`) nodes to clear an electrical clash.
2. **Entry Boundary Gates (`bun run check:render`, 5/5)**:
   - `./render` (`src/render.ts`) MUST remain 100% free of `@pascal-app/editor` and `next` imports.
   - `./cad` (`src/cad/index.ts`) MUST remain 100% free of React and `@pascal-app/editor` imports.
   - `./agent-tools` (`src/agent-tools.ts`) MUST remain pure Zod-only (`E-016` contract purity).
   - `./agent-operations` (`src/agent-operations.ts`) MUST remain headless MCP/runtime pure (zero React, Three.js, `@pascal-app/viewer`, or `@pascal-app/editor` imports).
   - `./nec` (`src/nec/index.ts`) MUST remain pure framework-free TypeScript (zero React, Three.js, or `@pascal-app/*` imports).
3. **Plugin Store Isolation**: Keep all plugin UI state inside `src/ui/store.ts`; never extend Pascal's `useScene`, `useEditor`, or `useViewer` stores.
4. **Geometry Resource Safety**: Allocate fresh PBR `CadMaterialPool` instances per CAD build call so Pascal `<GeometrySystem>` node disposal never disposes materials still referenced by sibling meshes.
5. **Engineering Disclaimer**: NEC calculations, prohibited-location checks, and BOM cost estimates are deterministic drafting aids and never substitute for licensed PE review or local AHJ approval.

## Quick Start

```bash
bun install
bun run check          # tsc --noEmit + bun test src + all 5 entry boundary gates + dist build
bun run export:cad     # Regenerate all 50 binary .glb CAD models in assets/cad/
```

## Architecture and File Map

| Layer | File | Responsibility |
|---|---|---|
| **Plugin Manifests** | `src/index.ts`, `src/render.ts` | Full Pascal Plugin API v1 manifest (`electricalPlugin`, host panel, schedule view, chat extension) and editor-free viewer manifest (`electricalRenderPlugin`) |
| **Node Definitions** | `src/nodes/panel.ts`, `src/nodes/device.ts`, `src/nodes/conduit-run.ts`, `src/nodes/transformer.ts`, `src/nodes/parametrics.ts` | Zod v4 schemas, 3D geometry builders, 2D IEEE floorplan symbols, snapping ports, and parametric inspector schemas for all 4 `electrical:*` node kinds |
| **Pure NEC Engine (`./nec`)** | `src/nec/tables.ts`, `src/nec/sizing.ts`, `src/nec/load-calc.ts`, `src/nec/routing.ts`, `src/nec/framing-interop.ts`, `src/nec/panel-schedule.ts`, `src/nec/pricing.ts`, `src/nec/autopopulate.ts`, `src/nec/audit.ts`, `src/nec/index.ts` | Deterministic Article 220 loads, 310.16/310.15 ampacity, Ch. 9 conduit fill, 314.16 box fill, voltage drop, trade-priority routing, `structural:assembly`/`bones:*` framing & schematic interop, cross-trade `plumbing:*`/`hvac:*` demand ingestion, NEC minimum auto-populate, prohibited-location audit, schedules, and priced BOM takeoff |
| **3D CAD Library (`./cad`)** | `src/cad/materials.ts`, `src/cad/boxes.ts`, `src/cad/equipment.ts`, `src/cad/expansion.ts`, `src/cad/solar-backup.ts`, `src/cad/panel-interior.ts`, `src/cad/catalog.ts`, `src/cad/index.ts` | 50 clean-room MIT procedural Three.js material builders (including smart devices, fixtures, cable tray, grounding, solar PV, ESS, ATS, VFD, SPD), cover-off wired panelboard interior builder, and continuous filleted conduit builder |
| **Agent Surface (`E-016`)** | `src/agent-tools.ts`, `src/agent-operations.ts` | 8 pure Zod tool contracts and pure scene mutation/query operations runnable from MCP, detached runtimes, or live chat |
| **Editor UI** | `src/ui/electrical-panel.tsx`, `src/ui/inspector-card.tsx`, `src/ui/schedule-view.tsx`, `src/ui/panel-interior-view.tsx`, `src/ui/chat-card.tsx`, `src/ui/store.ts` | Left-rail palette + auto-populate + live NEC flags, selected-node `NOT TO CODE` inspector card, full-pane Schedule/Load/Audit/Takeoff/Panel-Interior view, and isolated Zustand UI store |
| **Build and Media Scripts** | `scripts/build-dist.ts`, `scripts/check-render-entry.ts`, `scripts/export-cad-catalog.ts`, `scripts/render-cad-thumbnails.ts`, `scripts/render-panel-interior-closeup.ts`, `scripts/render-social-preview.ts`, `scripts/render-walkthrough-video.ts` | Dual-runtime `dist/` bundler, 5-gate boundary verifier, 50-model `.glb` exporter, studio thumbnail renderer, panel close-up renderer, social preview card renderer, and 720p walkthrough video generator |
| **Tests** | `src/__tests__/nec-load-calc.test.ts`, `src/__tests__/nec-sizing.test.ts`, `src/__tests__/trade-routing.test.ts`, `src/__tests__/scene-audit-and-schedule.test.ts`, `src/__tests__/autopopulate-nec.test.ts`, `src/__tests__/plugin-contract.test.ts` | Full deterministic unit and integration test suite covering Residential/Commercial NEC math, framing/Bones & cross-trade MEP interop, hybrid attic/crawl-space routing, Smoke/CO life safety, prohibited locations, multi-level isolation, auto-populate, BOM pricing, all 50 CAD models, and Plugin v1 contracts |
