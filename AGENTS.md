# Pascal Plugin Electrical (`AGENTS.md`)

> Standalone MIT Residential & Commercial NEC Electrical Plugin for Pascal Editor (`@kruschdev/pascal-plugin-electrical`, `pluginId: krusch:electrical`).

## Architecture & Boundary Invariants

1. **Trade-Priority Right-of-Way**: Electrical (`electrical:conduit-run`) ALWAYS yields to higher-priority trades in the scene graph (`1. Structural -> 2. Plumbing -> 3. HVAC -> 4. Electrical`). Never mutate plumbing (`pipe-*`) or HVAC (`duct-*`, `hvac-equipment`) nodes to clear an electrical clash.
2. **Entry Boundary Gates (`bun run check:render`)**:
   - `./render` (`src/render.ts`) MUST remain 100% free of `@pascal-app/editor` and `next` imports.
   - `./agent-tools` (`src/agent-tools.ts`) MUST remain pure Zod-only (`E-016` contract purity).
   - `./nec` (`src/nec/index.ts`) MUST remain pure framework-free TypeScript (zero React, Three.js, or `@pascal-app/*` imports).
3. **Plugin Store Isolation**: Keep all plugin UI state inside `src/ui/store.ts`; never extend Pascal's `useScene`, `useEditor`, or `useViewer` stores.
4. **Honesty Disclaimer**: NEC calculations are deterministic drafting/engineering aids and never substitute for licensed PE review or local AHJ approval.

## Verification Commands

```bash
bun run check-types   # Strict TypeScript check
bun test src          # Full NEC Residential/Commercial, Trade-Routing, Audit & Plugin v1 suite
bun run check:render  # Entry boundary gates (./render, ./agent-tools, ./nec + root negative probe)
bun run check         # All three gates combined
```
