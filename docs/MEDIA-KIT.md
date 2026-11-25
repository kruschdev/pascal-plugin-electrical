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
- **License**: MIT (clean-room procedural Three.js geometry, zero third-party meshes)
- **Host Compatibility**: Pascal Editor Plugin API v1 (`E-014`, `E-016`, `E-017`), zero upstream core changes required
- **3D CAD Library**: 50 exported binary `.glb` models + 50 studio thumbnails across 6 categories (Panels & Gear, Solar PV / Battery ESS / Backup, NEC 314.16 Boxes, Smart Devices & Motors, Light Fixtures, Conduit / Cable Tray / Grounding)
- **Live Editor Equipment**: 25 placeable `electrical:device` kinds with automatic wall/ceiling/floor snapping, room-aware auto-wiring, 2D floorplan symbols, NEC compliance audit, and 2026 supply-house BOM pricing
- **Verification**: 64/64 deterministic NEC, hybrid attic/crawl-space routing, Smoke/CO life-safety, Bones stud-snapping, multi-level audit, CAD, and boundary tests (`1,274` assertions), `tsc --noEmit` clean, 5/5 entrypoint boundary gates, compiled Node 22 ESM + Bun `dist/` build

## Ready-to-Post Copy

### X (Main Video Post)

I built an open-source MIT electrical engineering plugin for Pascal Editor that turns any floorplan into a wired, NEC-checked 3D model in one click.

It places flush wall-snapped outlets, switches, GFCIs, and fixtures, then routes concealed in-wall 3D Manhattan runs down stud centerlines and over door headers so cables never cut diagonally across rooms. You can peel back the walls with Pascal's native Low Walls and X-Ray viewer modes, open a live 3D Cover-Off or Panel-Cover-On load center down to every individual lug and wire, and drop in any of 25 live equipment kinds (solar PV inverters, wall battery ESS, 200A ATS, VFDs, smart dimmers, ceiling fans) from a 50-model clean-room MIT CAD library.

Everything computes live panel schedules, NEC Article 220 service loads, box/conduit fill, voltage drop, and contractor-priced BOM takeoffs.

Repo (MIT): https://github.com/kruschdev/pascal-plugin-electrical

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
