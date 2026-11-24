# Walkthrough Voiceover Script (`@kruschdev/pascal-plugin-electrical`)

Timed narration script synchronized to [`assets/demo-walkthrough.mp4`](../assets/demo-walkthrough.mp4) (`48.2s` runtime, `1280 x 720` H.264 @ 24fps, natural technical founder delivery, singular first-person voice).

## Clean Continuous Narration Text (TTS Input)

```text
This is Pascal Plugin Electrical, an open-source MIT plugin I built for Pascal Editor that turns any architectural floorplan into a complete, code-checked 3D electrical model.

Starting from Pascal's two-bedroom house, one click runs NEC Minimum Auto-Populate. It scans every wall, door, bathtub clearance zone, and room boundary to place a 200-amp main panel, flush wall-snapped outlets, kitchen and bath GFCIs, switches, ceiling lights, balanced circuits, home runs, and daisy chains. When I add another receptacle, it snaps cleanly to a wall and joins that room's existing circuit automatically. And from the 50-model clean-room CAD library, I can drop in any of 25 live equipment kinds, like a 52-inch ceiling fan, a solar PV inverter, or a home battery pack.

In Full Walls mode, everything stays clean because every cable routes concealed down the dead center of the wall cavities, never cutting diagonally across rooms. Switching to Pascal's native Low Walls and X-Ray modes peels the architecture back so you can inspect every 90-degree Manhattan run inside the walls.

Next, I open the live 3D Panel Interior view right inside Pascal's split pane. You can zoom straight into the copper busbars, breakers, brass lugs, and every individual phase-colored wire making a 90-degree bend into its terminal, then toggle Panel Cover On to seat the flush steel cover, engraved NEMA nameplate, arc-flash placard, and spare twist-out blanks.

From there, the live Panelboard Schedule, NEC Article 220 load calculator, and priced BOM takeoff update automatically as you adjust labor rates, markup, and tax, all backed by a live NEC compliance audit with zero errors and zero warnings.

Everything is MIT licensed on GitHub.
```

## Chapter-by-Chapter Beat Sheet

| Time | Chapter | Visual On Screen | Spoken Line |
|---|---|---|---|
| `0:00 - 0:12` | **1. Auto-Populate & Catalog Equipment** | Built-in Two-Bedroom House -> One-Click `Auto-Populate NEC Layout & Wiring` -> `+ Receptacle` -> Catalog Picker `52" Ceiling Fan w/ LED Kit` -> `+ Place` | "This is Pascal Plugin Electrical, an open-source MIT plugin I built for Pascal Editor that turns any architectural floorplan into a complete, code-checked 3D electrical model. Starting from Pascal's two-bedroom house, one click runs NEC Minimum Auto-Populate... When I add another receptacle, it snaps cleanly to a wall and joins that room's existing circuit automatically. And from the 50-model clean-room CAD library, I can drop in any of 25 live equipment kinds, like a 52-inch ceiling fan, a solar PV inverter, or a home battery pack." |
| `0:12 - 0:22` | **2. Concealed In-Wall Routing & Native Viewer Modes** | `Full Walls` -> `Low Walls` + 3D zoom & orbit -> `X-Ray Wiring` | "In Full Walls mode, everything stays clean because every cable routes concealed down the dead center of the wall cavities, never cutting diagonally across rooms. Switching to Pascal's native Low Walls and X-Ray modes peels the architecture back so you can inspect every 90-degree Manhattan run inside the walls." |
| `0:22 - 0:34` | **3. 3D Panel Interior (`Cover Off` & `Panel Cover On`)** | Split-pane `Inspect Panel Wiring` -> `Full Open Panel` -> `Zoom: Breakers & Lugs` + live 3D orbit -> `Panel Cover On` -> `Cover Off` | "Next, I open the live 3D Panel Interior view right inside Pascal's split pane. You can zoom straight into the copper busbars, breakers, brass lugs, and every individual phase-colored wire making a 90-degree bend into its terminal, then toggle Panel Cover On to seat the flush steel cover, engraved NEMA nameplate, arc-flash placard, and spare twist-out blanks." |
| `0:34 - 0:41` | **4. Panel Schedule & NEC 220 Load Calc** | `Panel Schedule` tab -> `NEC 220 Load Calc` tab | "From there, the live Panelboard Schedule, NEC Article 220 load calculator..." |
| `0:41 - 0:48` | **5. Live Priced BOM & NEC Audit** | `Takeoff & Cost` live Labor/Markup/Tax edits -> `NEC Audit` (`0 Errors · 0 Warnings · NEC PASS`) | "...and priced BOM takeoff update automatically as you adjust labor rates, markup, and tax, all backed by a live NEC compliance audit with zero errors and zero warnings. Everything is MIT licensed on GitHub." |

## Synthesizing & Muxing Voiceover with Gemini TTS

Once Gemini API credits are active (`gemini-api whoami`), run:

```bash
bash scripts/add-voiceover.sh --voice Charon
```

Use `--dry-run` first to validate the exact `gemini-api tts` request offline at zero cost:

```bash
bash scripts/add-voiceover.sh --dry-run
```
