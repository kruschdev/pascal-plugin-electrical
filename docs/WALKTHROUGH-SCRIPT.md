# Walkthrough Voiceover Script (`@kruschdev/pascal-plugin-electrical`)

Timed narration script synchronized to [`assets/demo-walkthrough.mp4`](../assets/demo-walkthrough.mp4) (`59.7s` narrated runtime, `1280 x 720` H.264 @ 24fps + 48 kHz AAC voiceover via `gemini-3.8-flash-tts` voice `Charon`, 148 words, singular first-person voice).

## Clean Continuous Narration Text (TTS Input)

```text
This is Pascal Plugin Electrical, an MIT plugin I built for Pascal Editor. One click auto-populates an entire NEC layout, snaps new outlets onto existing circuits, and drops in 25 live CAD equipment models.

Cables route concealed down wall centerlines, never cutting across rooms. Switching to Pascal's native Low Walls and X-Ray modes peels the architecture back so you can inspect every 90-degree Manhattan run.

Next, I open the live 3D Panel Interior right inside Pascal's split pane. Zoom into the copper busbars, breakers, brass lugs, and phase-colored wires, then toggle Panel Cover On for the steel cover, engraved NEMA nameplate, arc-flash placard, and spare blanks.

Every circuit flows straight into a live Panelboard Schedule and NEC Article 220 load calculator.

Adjust labor, markup, and tax in the live priced BOM takeoff, backed by an instant NEC compliance audit with zero errors. Everything is MIT licensed on GitHub.
```

## Chapter-by-Chapter Beat Sheet

| Time | Chapter | Visual On Screen | Spoken Line |
|---|---|---|---|
| `0:00 - 0:12` | **1. Auto-Populate & Catalog Equipment** | Built-in Two-Bedroom House -> One-Click `Auto-Populate NEC Layout & Wiring` -> `+ Receptacle` -> Catalog Picker `52" Ceiling Fan w/ LED Kit` -> `+ Place` | "This is Pascal Plugin Electrical, an MIT plugin I built for Pascal Editor. One click auto-populates an entire NEC layout, snaps new outlets onto existing circuits, and drops in 25 live CAD equipment models." |
| `0:12 - 0:25` | **2. Concealed In-Wall Routing & Native Viewer Modes** | `Full Walls` -> `Low Walls` + 3D zoom & orbit -> `X-Ray Wiring` | "Cables route concealed down wall centerlines, never cutting across rooms. Switching to Pascal's native Low Walls and X-Ray modes peels the architecture back so you can inspect every 90-degree Manhattan run." |
| `0:25 - 0:42` | **3. 3D Panel Interior (`Cover Off` & `Panel Cover On`)** | Split-pane `Inspect Panel Wiring` -> `Full Open Panel` -> `Zoom: Breakers & Lugs` + live 3D orbit -> `Panel Cover On` -> `Cover Off` | "Next, I open the live 3D Panel Interior right inside Pascal's split pane. Zoom into the copper busbars, breakers, brass lugs, and phase-colored wires, then toggle Panel Cover On for the steel cover, engraved NEMA nameplate, arc-flash placard, and spare blanks." |
| `0:42 - 0:49` | **4. Panel Schedule & NEC 220 Load Calc** | `Panel Schedule` tab -> `NEC 220 Load Calc` tab | "Every circuit flows straight into a live Panelboard Schedule and NEC Article 220 load calculator." |
| `0:49 - 0:59.7` | **5. Live Priced BOM & NEC Audit** | `Takeoff & Cost` live Labor/Markup/Tax edits -> `NEC Audit` (`0 Errors · 0 Warnings · NEC PASS`) | "Adjust labor, markup, and tax in the live priced BOM takeoff, backed by an instant NEC compliance audit with zero errors. Everything is MIT licensed on GitHub." |

## Synthesizing & Muxing Voiceover with Gemini TTS

Run:

```bash
bash scripts/add-voiceover.sh --voice Charon
```

Use `--dry-run` first to validate the exact `gemini-api tts` request offline at zero cost:

```bash
bash scripts/add-voiceover.sh --dry-run
```
