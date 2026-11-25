# Pure Agent Tools Reference (`E-016`)

`@kruschdev/pascal-plugin-electrical` exposes 8 pure Zod-validated agent tools via [`@kruschdev/pascal-plugin-electrical/agent-tools`](../src/agent-tools.ts) and matching deterministic scene operations via [`@kruschdev/pascal-plugin-electrical/agent-operations`](../src/agent-operations.ts).

Because `./agent-tools` imports only Zod and `@pascal-app/core/agent-tools`, any MCP server, autonomous agent harness, or Pascal chat runtime can load all 8 contracts without bundling React or Three.js.

## Available Tools

| Tool Name | Mode | Purpose |
|---|---|---|
| `electrical_place_panel` | Write | Place a residential (`120/240V-1P`) or commercial (`120/208V-3P`, `277/480V-3P`) panelboard with NEC 110.26 clearance envelope |
| `electrical_place_transformer` | Write | Place a commercial dry-type step-down transformer (`480V -> 208V 3P`) with NEC Table 450.3(B) FLA and OCPD sizing |
| `electrical_place_device` | Write | Place any of 25 live equipment and device kinds (receptacles, GFCI/AFCI, USB-C duplex, weatherproof in-use GFCI, brass floor box, smart dimmer, 1P/3-way switches, luminaires, ceiling fan, under-cabinet LED, smoke/CO alarm, exit sign, EVSE, 240V dedicated, 3-phase motor, VFD, Type 2 SPD, solar PV inverter, wall battery ESS, 200A ATS, 50A generator inlet, PV rapid shutdown, or junction box) with full `#14`-`750kcmil` wire gauge support, stud-side snapping, and automatic room-aware Manhattan wiring |
| `electrical_route_circuit` | Write | Route a 3D conduit or cable run from panel to device, automatically detouring around Pascal plumbing, HVAC, and structural obstacles and auto-sizing wire gauge and conduit trade size |
| `electrical_autopopulate_nec` | Write | Walk Pascal walls, exterior doors, stairways, room zones, and optional `@pascal-app/plugin-bones` framing/service nodes to mount `MDP-1` in a stud bay, snap nail-on devices flush to `16"`/`24" OC` studs within NEC spacing slack, and generate NEC minimum outlets, GFCIs, lighting/3-way switches, balanced panel circuits, 10-color home runs, and daisy-chain runs |
| `electrical_calculate_load` | Read-only | Run Residential Standard, Residential Optional (`220.82`), or Commercial (`Table 220.12` / `220.44` / `430.24`) NEC Article 220 service load calculations |
| `electrical_audit_nec` | Read-only | Audit the entire live scene (with strict multi-level isolation) for NEC 110.26 working/dedicated space, prohibited locations (`240.24`, `312.2`, `406.9(C)`, `404.4(C)`, `410.10(D)`, `406.5(E)`, `210.52(C)`, `410.16(C)`, `210.11(C)`), trade clashes, bend limits, ampacity, conduit/box fill, voltage drop, GFCI/AFCI, and solar 120% busbar rules |
| `electrical_generate_schedule` | Read-only (`rendersView`) | Generate odd/even L1/L2 or A/B/C panel schedules, phase imbalance %, spreadsheet-safe CSV export (`sanitizeCsvCell`), and priced BOM with configurable `laborRatePerHourUsd` and `materialMarkupPct` |

## Example: One-Click Auto-Populate + Audit + Priced BOM Pipeline

```ts
import { electricalAgentOperations } from '@kruschdev/pascal-plugin-electrical/agent-operations'

// 1. Auto-populate NEC minimum layout, balanced circuits, home runs & daisy chains
const auto = electricalAgentOperations.electrical_autopopulate_nec(
  sceneNodes,
  {
    levelId: 'level_1',
    occupancy: 'residential',
    protectionMode: 'hybrid', // 'hybrid' | 'gfci-breakers' | 'gfci-receptacles'
    includeLighting: true,
    includeWiring: true,
  },
  { activeLevelId: 'level_1' },
)

// Apply auto.changes.create to sceneNodes, then audit:
const audit = electricalAgentOperations.electrical_audit_nec(updatedNodes, {}, {})
console.log(audit.result.passed, audit.result.errorCount, audit.result.findings)

// Generate panel schedule and contractor-priced BOM:
const schedule = electricalAgentOperations.electrical_generate_schedule(
  updatedNodes,
  { laborRatePerHourUsd: 95, materialMarkupPct: 15 },
  {},
)
console.log(schedule.result.takeoff.pricing.estimatedTotalUsd)
```

## Example: Registering Tools in an MCP or Chat Host

```ts
import { electricalAgentTools } from '@kruschdev/pascal-plugin-electrical/agent-tools'
import { electricalAgentOperations } from '@kruschdev/pascal-plugin-electrical/agent-operations'

for (const tool of electricalAgentTools.tools) {
  const handler = electricalAgentOperations[tool.name]
  // Register tool.name, tool.description, tool.input (Zod), tool.annotations, and handler
}
```
