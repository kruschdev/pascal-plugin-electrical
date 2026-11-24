# Contributing to `@kruschdev/pascal-plugin-electrical`

Thank you for helping improve open-source electrical authoring for Pascal Editor.

## Local Setup

```bash
bun install
bun run check
```

`bun run check` executes three required verification gates:
1. `tsc --noEmit` (strict TypeScript compilation across all 6 entrypoints).
2. `bun test src` (deterministic Residential/Commercial NEC calculations, prohibited-location rules, auto-populate, BOM pricing, CAD builders, and Plugin API v1 conformance).
3. `bun run check:render` (enforces zero `@pascal-app/editor` imports in `./render` and `./cad`, pure Zod in `./agent-tools`, and zero React/Three.js/`@pascal-app/*` imports in `./nec`).

## Architectural Rules for PRs

1. **Trade-Priority Right-of-Way**: Never write routing logic that relocates plumbing (`pipe-*`), HVAC (`duct-*`, `hvac-equipment`), or structural (`beam`, `column`, `stair`) nodes to clear an electrical run. Electrical always routes around higher-priority trades.
2. **Deterministic NEC Math**: Every NEC table lookup, load calculation, ampacity derating, prohibited-location rule, and BOM rollup belongs in `src/nec/` with unit test coverage citing the exact NEC section.
3. **Clean-Room MIT CAD Only**: Any new 3D model added to `src/cad/` must be procedurally generated in Three.js under the MIT license (never import proprietary vendor meshes). Regenerate binary `.glb` assets and thumbnails with:
   ```bash
   bun run export:cad
   bun scripts/render-cad-thumbnails.ts
   ```
4. **Refresh Walkthrough Media** (when adding major UI or 3D features):
   ```bash
   bun scripts/render-walkthrough-video.ts
   ```
5. **Isolated Plugin State**: Keep plugin UI state inside `src/ui/store.ts` and batch multi-node scene edits inside `runAsSingleSceneHistoryStep(useScene, ...)`.
