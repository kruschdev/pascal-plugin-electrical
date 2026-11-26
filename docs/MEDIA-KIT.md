# Media Kit and Launch Package (`@kruschdev/pascal-plugin-electrical`)

Ready-to-share video, high-resolution screenshots, 3D CAD contact sheet, OpenGraph hero banner, and launch copy for [`@kruschdev/pascal-plugin-electrical`](https://github.com/kruschdev/pascal-plugin-electrical).

## Included Visual Assets

| Asset | Resolution / Format | Best Use |
|---|---|---|
| [`assets/social-preview.png`](../assets/social-preview.png) | `1280 x 640` PNG | GitHub Social Preview, OpenGraph card, LinkedIn/X link banner |
| [`assets/demo-walkthrough.mp4`](../assets/demo-walkthrough.mp4) | `1280 x 720` H.264 MP4 (`59.7s`, narrated AAC + `+faststart`) | X video post, LinkedIn native video, YouTube, GitHub Release |
| [`assets/demo-walkthrough.gif`](../assets/demo-walkthrough.gif) | `640px` palette-optimized GIF | README preview, Reddit, Discord, Slack |
| [`assets/demo-3d-trade-routing.png`](../assets/demo-3d-trade-routing.png) | `1440 x 810` PNG | Live Pascal Editor Low Walls view showing concealed in-wall Manhattan routing & Catalog Equipment rail |
| [`assets/demo-panel-wired-interior.png`](../assets/demo-panel-wired-interior.png) | `1920 x 760` PNG | 4-panel 3D Panel Interior showcase (Cover Off, Zoom Breakers & Lugs, Panel Cover On, 400A 3-Phase) |
| [`assets/demo-panel-schedule.png`](../assets/demo-panel-schedule.png) | `1440 x 810` PNG | Live split-pane 3D house + populated Panelboard Schedule |
| [`assets/cad-material-catalog.png`](../assets/cad-material-catalog.png) | `1680 x 2560` PNG | Complete 50-model clean-room MIT CAD catalog contact sheet (5x10 studio grid) |
| [`docs/WALKTHROUGH-SCRIPT.md`](./WALKTHROUGH-SCRIPT.md) | Markdown Beat Sheet | Timed ~60-second chapter-by-chapter narration script & TTS input text |
| [`scripts/add-voiceover.sh`](../scripts/add-voiceover.sh) | Bash (`gemini-api tts` + `ffmpeg`) | One-command Gemini TTS synthesis (`gemini-3.8-flash-tts`) and AAC muxing into `assets/demo-walkthrough-narrated.mp4` |

## Project Facts (Quick Reference)

- **Repository**: `https://github.com/kruschdev/pascal-plugin-electrical`
- **npm Package**: `https://www.npmjs.com/package/@kruschdev/pascal-plugin-electrical` (`@kruschdev/pascal-plugin-electrical`)
- **License**: MIT (clean-room procedural Three.js geometry, zero third-party meshes)
- **Host Compatibility**: Pascal Editor Plugin API v1 (`E-014`, `E-016`, `E-017`), zero upstream core changes required
- **3D CAD Library**: 50 exported binary `.glb` models + 50 studio thumbnails across 6 categories (Panels & Gear, Solar PV / Battery ESS / Backup, NEC 314.16 Boxes, Smart Devices & Motors, Light Fixtures, Conduit / Cable Tray / Grounding)
- **Live Editor Equipment**: 25 placeable `electrical:device` kinds with automatic wall/ceiling/floor snapping, room-aware auto-wiring, 2D floorplan symbols, NEC compliance audit, and 2026 supply-house BOM pricing
- **Verification**: 82/82 deterministic NEC, Bones schematic ingestion (`bones:framing` / `bones:device` / `bones:service`), cross-trade `plumbing:*` / `hvac:*` / `structural:*` coordination, hybrid attic/crawl-space routing, Smoke/CO life-safety, multi-level audit, CAD, and boundary tests (`1,455` assertions), `tsc --noEmit` clean, 5/5 entrypoint boundary gates, compiled Node 22 ESM + Bun `dist/` build

## Ready-to-Post Copy

### Pascal GitHub Discussions (`pascalorg/editor` -> `Show and tell`)

**Category**: `Show and tell` (`https://github.com/pascalorg/editor/discussions/categories/show-and-tell`)

**Title**: `MIT Residential & Commercial NEC Electrical Plugin (@kruschdev/pascal-plugin-electrical): Load Calcs, Panel Schedules, 3D Trade-Priority Routing, and 50 .glb CAD Models`

**Attachments to drag-and-drop into the GitHub Discussion editor**:
1. `assets/demo-walkthrough.mp4` (renders an inline native video player in GitHub Discussions)
2. `assets/demo-panel-wired-interior.png`

**Body**:

I built a standalone, MIT-licensed **Residential and Commercial NEC Electrical** plugin for Pascal Editor (`@kruschdev/pascal-plugin-electrical`) implementing Pascal's Plugin API v1 (`E-014`, `E-016`, `E-017`) with zero upstream core changes.

`pascalorg/plugin-bones` explicitly notes in its electrical research doc that wire sizing, box fill, conduit, and load-based service calculations are out of scope for its layout-computable rough-in engine. I built this plugin to pick up right where Bones stops, and to ingest Bones' persisted scene nodes directly (`src/nec/framing-interop.ts` reads `bones:framing`, `bones:device`, and `bones:service`, including user-dragged receptacles/GFCIs/switches, `panel`, back-to-back `electric-meter`/`power-entry`, `water-heater`, and `heat-pump`, with zero hard dependency on `@pascal-app/plugin-bones`). You can run Bones X-Ray, drag outlets or services where you want them, and click **Import & Wire Bones Schematic** (`bonesMode: 'import-only'`) or **Auto-Populate** (`bonesMode: 'auto'`) to turn that exact rough-in into balanced 1P/2P panel schedules, NEC 220 load calcs, 3D routing, and priced BOMs.

**What it ships**

- **One-click NEC auto-populate and smart incremental auto-wiring**: Scans walls, T-junctions, doors, bathtub/shower exclusion zones, and rooms to place outlets, GFCIs, switches, luminaires, hardwired 120V `14/3` interconnected Smoke/CO alarms on a shared hallway/living-area pilot lighting circuit (`IRC R314/R315`, `NFPA 72`), and a balanced panel. Adding a new outlet later extends that room's run, auto-upsizes spliced anchor boxes per `NEC 314.16`, and checks `NEC 210.19(A)` voltage drop.
- **Trade-priority 3D routing (Structural -> Plumbing -> HVAC -> Electrical)**: Keeps concealed cables strictly on wall centerlines (hybrid wall-Manhattan plus attic/crawl-space Euclidean pulls emitting `NEC 334.23` and `334.15(C)` advisory drafting notes while enforcing the `NEC 334.12(B)(4)` wet crawl-space ban in both routing and audit), yields around higher-priority plumbing and HVAC obstacles, tracks cumulative bends against the `NEC 358.26` 360-degree pull-point limit, and flags `NEC 110.26(E)` dedicated electrical space violations above panels or transformers.
- **Live 3D panel interior (`Cover Off`, `Panel Cover On`, `Cover Closed`) and schedules**: Renders copper busbars, AFCI/GFCI breakers, neutral/ground bars, and 90-degree-bent phase conductors inside Pascal's split-pane view, paired with Odd/Even `L1/L2` and `A/B/C` 3-phase panelboard schedules, NEC Article 220 Standard / Optional (`220.82`) / Commercial 3-phase load calcs, and a priced BOM calculator (labor, markup, tax, CSV).
- **25 live placeable equipment kinds and 50 clean-room MIT `.glb` CAD models**: Covers residential load centers, 400A 277/480V 3-phase panelboards, transformers, VFDs, Type 2 SPDs, solar PV inverters (`NEC 690`), 13.5 kWh wall battery ESS (`NEC 706`), 200A ATS (`NEC 702`), smart dimmers, ceiling fans, cable tray, and grounding hardware.
- **Strict boundary entrypoints and 8 pure Zod agent tools**: `.` (full editor integration), `./render` (editor-free viewer manifest), `./cad` (Three.js-only builders), `./nec` (framework-free TypeScript), `./agent-tools`, and `./agent-operations`.

> Drafting and engineering aid, not stamped engineering. Always verify calculations, conductor sizing, and local AHJ amendments with a licensed electrical engineer or inspector before construction.

**Try it**

```bash
npm install @kruschdev/pascal-plugin-electrical
```

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

Or clone and run the full deterministic check suite locally (`82/82` tests, `1,455` assertions, typecheck, render-boundary gate, and compiled `dist/` build):

```bash
git clone https://github.com/kruschdev/pascal-plugin-electrical.git
cd pascal-plugin-electrical
bun install && bun run check
```

Repo (MIT): https://github.com/kruschdev/pascal-plugin-electrical
npm: https://www.npmjs.com/package/@kruschdev/pascal-plugin-electrical

**What I would love feedback on**

1. If you test it on a multi-level Pascal project (especially alongside `plugin-bones` or custom plumbing/HVAC runs), let me know where the obstacle routing or stud-snapping hits edge cases.
2. Any feedback on the Plugin API v1 boundary layout (`./render`, `./cad`, `./nec`, `./agent-tools`) or commercial 3-phase schedule conventions would be super helpful.

### Pascal Discord (`https://discord.gg/XRKsDcpqgS`)

Attach `assets/demo-walkthrough.mp4` or `assets/demo-walkthrough.gif`:

Hey everyone! I just published an open-source MIT Residential & Commercial NEC Electrical plugin for Pascal Editor (`@kruschdev/pascal-plugin-electrical`, built on Plugin API v1 with zero core changes).

It picks up where `plugin-bones`'s layout rough-in stops (and reads `bones:framing` / `bones:service` to snap boxes to studs), adding NEC Article 220 load calcs, live Odd/Even `L1/L2` and 3-phase panel schedules, trade-priority 3D routing around plumbing and HVAC, a live Cover-Off / Panel-Cover-On 3D wired panel interior, 50 clean-room MIT `.glb` CAD models (including solar PV, battery ESS, ATS, and 3-phase gear), a priced BOM calculator, and 8 pure Zod agent tools.

GitHub (MIT): https://github.com/kruschdev/pascal-plugin-electrical
npm: https://www.npmjs.com/package/@kruschdev/pascal-plugin-electrical
Discussion thread: <paste pascalorg/editor Show and tell URL once posted>

Would love feedback from anyone testing it on real floorplans!

### OSArch Community (`https://community.osarch.org`)

**Title**: `Open-source MIT NEC Electrical Plugin + 50 Procedural Three.js .glb CAD Models for Pascal Editor`

**Body**:

I recently built and published `@kruschdev/pascal-plugin-electrical`, a standalone MIT-licensed residential and commercial NEC electrical plugin for Pascal Editor (open-source browser-first 3D AECO editor built on React Three Fiber and WebGPU).

A few technical details that may be useful to OpenBIM / AECO builders here:

- **Zero-dependency engineering core (`./nec`)**: Pure TypeScript implementations of NEC Article 220 load calculations (Residential Standard, Optional `220.82`, and Commercial 3-phase), NEC 310.16 ampacity, NEC 314.16 box fill with automatic spliced anchor upsizing, Chapter 9 conduit fill, NEC 210.19 voltage drop, NEC 358.26 cumulative 360-degree bend counting, and `NEC 110.26(E)` dedicated electrical space auditing.
- **Trade-priority 3D MEP routing**: Yields automatically around Structural, Plumbing, and HVAC elements, using wall-centerline Manhattan routing inside framed walls and straight Euclidean pulls across accessible attics and dry crawl spaces (emitting `NEC 334.23` and `334.15(C)` advisory drafting notes while enforcing the `NEC 334.12(B)(4)` wet crawl-space ban in routing and audit).
- **50 clean-room MIT `.glb` electrical CAD models (`./cad`)**: Generated purely in Three.js with no third-party meshes, covering 200A load centers (closed, cover-off wired interior, cover-on), 400A 277/480V 3-phase panelboards, transformers, VFDs, Type 2 SPDs, solar PV inverters, 13.5 kWh wall battery ESS, 200A ATS, boxes, smart wiring devices, luminaires, cable tray, and grounding hardware.
- **8 pure Zod agent tools (`./agent-tools`)**: Designed so MCP servers or headless workflows can place equipment, route circuits, audit NEC violations, and export priced BOMs without pulling in React or Three.js.

Repo & walkthrough video: https://github.com/kruschdev/pascal-plugin-electrical
npm: https://www.npmjs.com/package/@kruschdev/pascal-plugin-electrical

Drafting and engineering aid only, not stamped engineering. I would appreciate any critique on NEC edge cases, 3-phase panelboard schedule conventions, or IFC / OpenBIM export interoperability.

### X (Main Video Post)

I built an open-source MIT electrical engineering plugin for @pascal (Pascal Editor) that turns any floorplan into a wired, NEC-checked 3D model in one click.

It snaps boxes flush to studs alongside Pascal's Bones framing plugin, routes concealed in-wall 3D runs around plumbing and HVAC, opens a live 3D Cover-Off or Panel-Cover-On load center down to every individual lug and wire, and lets you place 25 live equipment kinds (solar PV inverters, wall battery ESS, 200A ATS, VFDs, smart dimmers, ceiling fans) from a 50-model clean-room MIT CAD library.

Everything computes live panel schedules, NEC Article 220 service loads, box and conduit fill, voltage drop, and contractor-priced BOM takeoffs.

Repo (MIT): https://github.com/kruschdev/pascal-plugin-electrical
npm: https://www.npmjs.com/package/@kruschdev/pascal-plugin-electrical

### LinkedIn Post

I just released an expanded MIT-licensed NEC electrical authoring plugin for Pascal Editor (`@kruschdev/pascal-plugin-electrical`).

Starting from a standard architectural floorplan, one click scans walls, T-junctions, doors, bathtub exclusion zones, and room polygons to place compliant outlets, GFCIs, switches, luminaires, balanced panel circuits, Home Runs, and outlet-to-outlet daisy chains.

A few engineering details I focused on:
- Concealed in-wall 3D Manhattan routing that runs strictly down wall centerlines and inside top plates (integrated directly with Pascal's native Full Walls, Cutaway, Low Walls, and X-Ray viewer modes) while automatically yielding around higher-priority structural, plumbing, and HVAC obstacles.
- Room-aware auto-wiring when adding new devices (joining an existing compatible room run with NEC 314.16 spliced anchor box auto-upsizing and NEC 210.19(A) voltage-drop checks, or creating a balanced Home Run in a new room).
- A live 3D Panel Interior viewer supporting Cover Off (copper busbars, main and branch breakers, neutral/ground bars, and every 90-degree-bent phase wire), Panel Cover On (flush ANSI-61 steel cover, engraved NEMA phenolic nameplate, NEC 110.16 arc-flash placard, and UL 67 spare filler plates), and Cover Closed.
- A 50-model clean-room MIT `.glb` CAD library (with 25 live placeable equipment kinds including solar PV inverters, 13.5 kWh wall battery ESS, 200A transfer switches, commercial VFDs, Type 2 SPDs, smart dimmers, USB-C outlets, brass floor boxes, and ceiling fans) wired directly into live panel schedules, NEC 220 load calculations, and contractor-priced BOM takeoffs.

Code, all 50 `.glb` assets, and 8 pure Zod agent tools are open source under MIT: https://github.com/kruschdev/pascal-plugin-electrical

### Hacker News (`Show HN`)

**Title**: `Show HN: Open-source NEC electrical CAD and in-wall 3D routing plugin for Pascal Editor`

**Body**:
I built an open-source MIT electrical plugin (`@kruschdev/pascal-plugin-electrical`) for Pascal Editor that implements Pascal's Plugin API v1 (`E-014` / `E-016`) as a standalone external package with zero core merges.

Given a Pascal floorplan, it runs a deterministic NEC layout and circuit planner, routes concealed 3D Manhattan cables strictly along a T-junction-split wall centerline graph (yielding around plumbing, HVAC, and structural obstacles), renders a live Cover-Off / Panel-Cover-On 3D panelboard interior down to individual phase-colored wires and brass lugs, and computes panel schedules, NEC Article 220 service loads, box/conduit fill, voltage drop, and contractor-priced BOM takeoffs.

It also ships 50 clean-room procedural Three.js `.glb` electrical CAD models (25 live-placeable in the editor, covering residential, commercial 3-phase, solar PV, battery ESS, and backup transfer gear) plus 8 pure Zod agent tools with zero React or Three.js dependencies.

Repo: https://github.com/kruschdev/pascal-plugin-electrical

## Regenerating the Full Media Kit

```bash
bun run export:cad
bun scripts/render-cad-thumbnails.ts
bun scripts/render-panel-interior-closeup.ts
PASCAL_EDITOR_URL=http://localhost:3099/project/<id> bun run render:walkthrough
bun scripts/render-social-preview.ts
bash scripts/add-voiceover.sh --voice Charon
```
