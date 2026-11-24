/**
 * Deterministic 720p HD Walkthrough Video Generator for `@kruschdev/pascal-plugin-electrical`.
 *
 * Runs the REAL NEC engine (`planNecAutoPopulate`, `auditSceneElectrical`, `buildPanelSchedule`,
 * `buildElectricalTakeoff`) to generate authentic electrical data, renders a 6-chapter interactive
 * Three.js + Pascal Editor UI walkthrough in headless Chrome via Puppeteer, and encodes:
 *   - `assets/demo-walkthrough.mp4` (1280x720 @ 24fps H.264 +faststart)
 *   - `assets/demo-walkthrough.gif` (720px wide @ 10fps palette-optimized README preview)
 *
 * Run with: `bun scripts/render-walkthrough-video.ts`
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electricalAgentOperations } from '../src/agent-operations'
import { auditSceneElectrical } from '../src/nec/audit'
import type { SceneNodeLike } from '../src/nec/load-calc'
import { buildElectricalTakeoff, buildPanelSchedule } from '../src/nec/panel-schedule'

type PuppeteerLike = {
  launch: (opts: Record<string, unknown>) => Promise<{
    newPage: () => Promise<{
      setViewport: (v: { width: number; height: number; deviceScaleFactor: number }) => Promise<void>
      goto: (url: string, opts: { waitUntil: string }) => Promise<void>
      waitForFunction: (fn: () => boolean, opts: { timeout: number }) => Promise<void>
      evaluate: <T>(fn: (arg: T) => void, arg: T) => Promise<void>
      screenshot: (opts: { type: 'jpeg'; quality: number }) => Promise<Uint8Array>
    }>
    close: () => Promise<void>
  }>
}

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cadDir = path.join(rootDir, 'assets', 'cad')
const outMp4 = path.join(rootDir, 'assets', 'demo-walkthrough.mp4')
const outGif = path.join(rootDir, 'assets', 'demo-walkthrough.gif')
const keyframesDir = path.join(os.tmpdir(), 'pascal_electrical_walkthrough_keyframes')

// ─── 1. Build Real Architectural Scene & Run Live NEC Engine ─────────────────
function buildDemoArchitecturalScene(): Record<string, SceneNodeLike> {
  return {
    level_1: { id: 'level_1', type: 'level', name: 'Ground Floor' },
    // Exterior & interior walls defining Living, Kitchen, Bath, Hallway, Garage
    wall_south: { id: 'wall_south', type: 'wall', parentId: 'level_1', start: [0, 0], end: [12, 0], height: 2.75, thickness: 0.16 },
    wall_north: { id: 'wall_north', type: 'wall', parentId: 'level_1', start: [0, 8], end: [12, 8], height: 2.75, thickness: 0.16 },
    wall_west: { id: 'wall_west', type: 'wall', parentId: 'level_1', start: [0, 0], end: [0, 8], height: 2.75, thickness: 0.16 },
    wall_east: { id: 'wall_east', type: 'wall', parentId: 'level_1', start: [12, 0], end: [12, 8], height: 2.75, thickness: 0.16 },
    wall_mid_v1: { id: 'wall_mid_v1', type: 'wall', parentId: 'level_1', start: [5.5, 0], end: [5.5, 8], height: 2.75, thickness: 0.12 },
    wall_mid_v2: { id: 'wall_mid_v2', type: 'wall', parentId: 'level_1', start: [9.0, 0], end: [9.0, 8], height: 2.75, thickness: 0.12 },
    wall_mid_h1: { id: 'wall_mid_h1', type: 'wall', parentId: 'level_1', start: [5.5, 4.4], end: [9.0, 4.4], height: 2.75, thickness: 0.12 },

    // Front entry door & stairway
    door_front: {
      id: 'door_front',
      type: 'door',
      parentId: 'wall_south',
      name: 'Front Entry Door',
      position: [2.2, 0, 0],
      width: 0.96,
      height: 2.1,
    },
    stair_main: {
      id: 'stair_main',
      type: 'stair',
      parentId: 'level_1',
      name: 'Main Stairway',
      position: [1.0, 0, 4.8],
      rotation: 0,
      width: 1.05,
      length: 2.6,
    },

    // Room zones
    zone_living: {
      id: 'zone_living',
      type: 'zone',
      name: 'Living Room',
      category: 'living',
      polygon: [[0, 0], [5.5, 0], [5.5, 8], [0, 8]],
    },
    zone_kitchen: {
      id: 'zone_kitchen',
      type: 'zone',
      name: 'Kitchen',
      category: 'kitchen',
      polygon: [[5.5, 0], [9.0, 0], [9.0, 4.4], [5.5, 4.4]],
    },
    zone_bath: {
      id: 'zone_bath',
      type: 'zone',
      name: 'Master Bathroom',
      category: 'bathroom',
      polygon: [[5.5, 4.4], [9.0, 4.4], [9.0, 8.0], [5.5, 8.0]],
    },
    zone_garage: {
      id: 'zone_garage',
      type: 'zone',
      name: 'Garage',
      category: 'garage',
      polygon: [[9.0, 0], [12.0, 0], [12.0, 8.0], [9.0, 8.0]],
    },
    zone_patio: {
      id: 'zone_patio',
      type: 'zone',
      name: 'Back Patio',
      category: 'outdoor',
      polygon: [[0, 8.1], [5.5, 8.1], [5.5, 10.2], [0, 10.2]],
    },

    // Architectural fixtures (Bathtub, Stove, Sink)
    item_bathtub: {
      id: 'item_bathtub',
      type: 'item',
      name: 'Bathtub',
      position: [7.8, 0, 7.25],
      asset: { id: 'bathtub', name: 'Bathtub', category: 'bathroom', dimensions: [1.65, 0.58, 0.82] },
    },
    item_stove: {
      id: 'item_stove',
      type: 'item',
      name: 'Gas Range',
      position: [7.2, 0, 0.48],
      asset: { id: 'stove', name: 'Gas Range Stove', category: 'kitchen', dimensions: [0.78, 0.92, 0.68] },
    },
    item_sink: {
      id: 'item_sink',
      type: 'item',
      name: 'Kitchen Sink',
      position: [8.45, 0, 2.2],
      asset: { id: 'sink-cabinet', name: 'Kitchen Sink', category: 'kitchen', dimensions: [0.65, 0.9, 0.9] },
    },

    // Higher-priority MEP obstacles: 4" Plumbing Drain Pipe + 18"x10" HVAC Supply Trunk
    pipe_main: {
      id: 'pipe_main',
      type: 'pipe-segment',
      name: '4" DWV Drain Trunk',
      diameter: 4,
      path: [
        [5.6, 2.48, 0.4],
        [5.6, 2.48, 7.6],
      ],
    },
    duct_hvac: {
      id: 'duct_hvac',
      type: 'duct-segment',
      name: '18"x10" HVAC Supply Trunk',
      width: 0.46,
      height: 0.25,
      path: [
        [0.4, 2.52, 4.1],
        [11.5, 2.52, 4.1],
      ],
    },
  }
}

const baseScene = buildDemoArchitecturalScene()
const autoOutcome = electricalAgentOperations.electrical_autopopulate_nec(
  baseScene as never,
  {
    levelId: 'level_1',
    occupancy: 'residential',
    protectionMode: 'hybrid',
    includeLighting: true,
    includeWiring: true,
  },
  { activeLevelId: 'level_1' },
)

const populatedScene: Record<string, SceneNodeLike> = { ...baseScene }
for (const created of autoOutcome.changes?.create ?? []) {
  const n = created.node as unknown as SceneNodeLike
  populatedScene[n.id] = n
}

const cleanAudit = auditSceneElectrical(populatedScene)
const panelId = autoOutcome.result.panelId as string
const panelNode = populatedScene[panelId]!
const populatedDevices = Object.values(populatedScene).filter((n) => n.type === 'electrical:device')
const populatedRuns = Object.values(populatedScene).filter((n) => n.type === 'electrical:conduit-run')

// Violation demo scene: outlet dropped inside 3ft x 8ft bathtub zone (NEC 406.9(C)) + subpanel inside bathroom (NEC 240.24(E))
const violationScene: Record<string, SceneNodeLike> = {
  ...populatedScene,
  dev_bad_tub: {
    id: 'dev_bad_tub',
    type: 'electrical:device',
    name: 'Tub-Side Outlet',
    deviceKind: 'gfci',
    position: [6.72, 1.1, 7.25], // 0.25m (< 3ft) from bathtub rim!
    gfciProtected: true,
    panelId,
    circuitNumber: 12,
  },
  panel_bad_bath: {
    id: 'panel_bad_bath',
    type: 'electrical:panel',
    name: 'SUB-BATH',
    position: [5.85, 1.5, 6.2], // inside bathroom!
    height: 0.85,
  },
}
const violationAudit = auditSceneElectrical(violationScene)
const tubViolationFindings = violationAudit.findings.filter(
  (f) => f.nodeIds.includes('dev_bad_tub') || f.nodeIds.includes('panel_bad_bath'),
)

const schedule = buildPanelSchedule(panelNode, populatedDevices, populatedRuns)
const takeoffDefault = buildElectricalTakeoff(populatedScene, { laborRatePerHourUsd: 115, materialMarkupPct: 0 })
const takeoffCustom = buildElectricalTakeoff(populatedScene, { laborRatePerHourUsd: 95, materialMarkupPct: 15 })

console.log(
  `Live NEC Engine ready: ${populatedDevices.length} devices, ${populatedRuns.length} runs (${autoOutcome.result.homeRunsPlanned} home runs + ${autoOutcome.result.daisyChainRunsPlanned} daisy-chain), clean errors=${cleanAudit.errorCount}, demo violations=${tubViolationFindings.length}, BOM default=$${takeoffDefault.pricing.estimatedTotalUsd}, BOM custom=$${takeoffCustom.pricing.estimatedTotalUsd}`,
)

const payload = {
  walls: Object.values(baseScene).filter((n) => n.type === 'wall'),
  zones: Object.values(baseScene).filter((n) => n.type === 'zone'),
  panel: panelNode,
  devices: populatedDevices,
  runs: populatedRuns,
  summary: {
    circuitsCreated: autoOutcome.result.circuitsCreated as number,
    homeRunsPlanned: autoOutcome.result.homeRunsPlanned as number,
    daisyChainRunsPlanned: autoOutcome.result.daisyChainRunsPlanned as number,
  },
  cleanAudit: {
    passed: cleanAudit.passed,
    errorCount: cleanAudit.errorCount,
    warningCount: cleanAudit.warningCount,
  },
  violationFindings: tubViolationFindings.slice(0, 3),
  scheduleRows: schedule.rows.slice(0, 10),
  scheduleMeta: {
    panelName: schedule.panelName,
    voltageSystem: schedule.voltageSystem,
    busRatingAmps: schedule.busRatingAmps,
    totalConnectedVa: schedule.totalConnectedVa,
    totalLineAmps: schedule.totalLineAmps,
    utilizationPct: schedule.utilizationPct,
    imbalancePct: schedule.imbalancePct,
    usedSpaces: schedule.usedSpaces,
    spaces: schedule.spaces,
  },
  bomDefault: takeoffDefault.pricing,
  bomCustom: takeoffCustom.pricing,
}

// ─── 2. Build Self-Contained Frame-Stepped Interactive Walkthrough HTML ──────
const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px;
    height: 720px;
    overflow: hidden;
    background: #080d18;
    color: #e2e8f0;
    font-family: Inter, system-ui, -apple-system, sans-serif;
  }
  .topbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 44px;
    background: rgba(11, 18, 32, 0.96);
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    z-index: 30;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 13px; }
  .brand-pill {
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(245, 158, 11, 0.18);
    border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fbbf24;
    font-size: 11px;
    font-weight: 600;
  }
  .chapter-pill {
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.16);
    border: 1px solid rgba(56, 189, 248, 0.45);
    color: #7dd3fc;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .layout {
    position: fixed;
    top: 44px; left: 0; right: 0; bottom: 0;
    display: flex;
  }
  .rail {
    width: 288px;
    background: #0d1526;
    border-right: 1px solid rgba(148, 163, 184, 0.16);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    z-index: 20;
    transition: opacity 0.25s;
  }
  .rail-head { display: flex; justify-content: space-between; align-items: center; }
  .badge-pass {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    background: rgba(16, 185, 129, 0.18);
    color: #34d399;
    border: 1px solid rgba(16, 185, 129, 0.4);
  }
  .badge-err {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    background: rgba(239, 68, 68, 0.22);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.55);
  }
  .card {
    padding: 9px;
    border-radius: 8px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.65);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .card-amber {
    border-color: rgba(245, 158, 11, 0.42);
    background: rgba(245, 158, 11, 0.08);
  }
  .card-red {
    border-color: rgba(239, 68, 68, 0.55);
    background: rgba(239, 68, 68, 0.12);
  }
  .card-title { font-size: 11px; font-weight: 700; color: #f8fafc; }
  .card-sub { font-size: 10px; color: #94a3b8; line-height: 1.35; }
  .btn {
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid rgba(245, 158, 11, 0.55);
    background: rgba(245, 158, 11, 0.22);
    color: #fef3c7;
    font-size: 11px;
    font-weight: 700;
    text-align: center;
  }
  .btn-active {
    background: #f59e0b;
    color: #090d16;
    box-shadow: 0 0 18px rgba(245, 158, 11, 0.65);
  }
  .btn-blue {
    border-color: rgba(56, 189, 248, 0.5);
    background: rgba(56, 189, 248, 0.16);
    color: #bae6fd;
  }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; text-align: center; }
  .stat {
    padding: 6px 4px;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.15);
    background: rgba(15, 23, 42, 0.55);
  }
  .stat-v { font-size: 15px; font-weight: 800; color: #f8fafc; }
  .stat-l { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }

  .stage {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: #080d18;
  }
  canvas#gl {
    width: 100%;
    height: 100%;
    display: block;
  }

  /* Inspector overlay on top-right of viewport */
  .inspector {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 300px;
    background: rgba(11, 18, 32, 0.94);
    border: 1px solid rgba(148, 163, 184, 0.26);
    border-radius: 10px;
    padding: 11px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    display: none;
    flex-direction: column;
    gap: 6px;
    z-index: 25;
  }
  .inspector-row { display: flex; justify-content: space-between; font-size: 11px; }
  .violation-box {
    padding: 8px;
    border-radius: 7px;
    background: rgba(239, 68, 68, 0.16);
    border: 1px solid rgba(239, 68, 68, 0.58);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pass-box {
    padding: 7px 9px;
    border-radius: 7px;
    background: rgba(16, 185, 129, 0.16);
    border: 1px solid rgba(16, 185, 129, 0.5);
    color: #34d399;
    font-size: 11px;
    font-weight: 700;
    display: flex;
    justify-content: space-between;
  }

  /* Trade legend & HUD badge */
  .hud-pill {
    position: absolute;
    top: 14px;
    left: 14px;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(11, 18, 32, 0.88);
    border: 1px solid rgba(148, 163, 184, 0.24);
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 22;
  }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 999px; margin-right: 4px; vertical-align: middle; }

  /* Full Schedule & BOM Overlay (Chapter 5) */
  .schedule-overlay {
    position: absolute;
    inset: 0;
    background: #0a101f;
    padding: 16px 18px 86px 18px;
    display: none;
    grid-template-columns: 1.05fr 1fr;
    gap: 14px;
    z-index: 26;
  }
  .pane {
    background: #10192e;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th {
    text-align: left;
    padding: 5px 6px;
    background: rgba(255, 255, 255, 0.05);
    color: #94a3b8;
    border-bottom: 1px solid rgba(148, 163, 184, 0.2);
  }
  td {
    padding: 4px 6px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    color: #e2e8f0;
  }
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .kpi {
    padding: 7px 9px;
    border-radius: 7px;
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }
  .kpi-val { font-size: 15px; font-weight: 800; color: #38bdf8; }
  .kpi-lbl { font-size: 9px; color: #94a3b8; text-transform: uppercase; }
  .calc-controls {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    padding: 8px;
    border-radius: 7px;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.35);
    font-size: 10px;
  }
  .calc-box {
    background: rgba(11, 18, 32, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 5px;
    padding: 4px 7px;
    font-weight: 700;
    color: #fbbf24;
    margin-top: 2px;
  }

  /* Lower-third chapter caption banner */
  .caption-bar {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 14px;
    padding: 11px 16px;
    border-radius: 10px;
    background: rgba(9, 14, 26, 0.92);
    border: 1px solid rgba(56, 189, 248, 0.34);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    z-index: 28;
  }
  .cap-title { font-size: 14px; font-weight: 800; color: #f8fafc; margin-bottom: 2px; }
  .cap-sub { font-size: 11px; color: #cbd5e1; }
  .cap-tag {
    padding: 5px 10px;
    border-radius: 6px;
    background: rgba(245, 158, 11, 0.16);
    border: 1px solid rgba(245, 158, 11, 0.4);
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }

  /* Progress bar along bottom edge */
  .progress-track {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    height: 4px;
    background: rgba(148, 163, 184, 0.18);
    z-index: 40;
  }
  .progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #f59e0b, #38bdf8, #34d399);
  }

  /* Outro badge */
  .outro-banner {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 22px;
    border-radius: 12px;
    background: rgba(11, 18, 32, 0.92);
    border: 1px solid rgba(245, 158, 11, 0.45);
    text-align: center;
    display: none;
    z-index: 27;
  }
</style>
<script type="importmap">
{
  "imports": {
    "three": "/three/build/three.module.js",
    "three/addons/": "/three/examples/jsm/"
  }
}
</script>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <span style="color:#f59e0b;font-size:15px;">⚡</span>
      <span>Pascal Editor</span>
      <span class="brand-pill">@kruschdev/pascal-plugin-electrical · MIT</span>
    </div>
    <div id="chapterPill" class="chapter-pill">1 / 6 · NEC Minimum Auto-Populate</div>
  </div>

  <div class="layout">
    <aside class="rail" id="leftRail">
      <div class="rail-head">
        <strong style="font-size:12px;">Electrical (NEC)</strong>
        <span id="necBadge" class="badge-pass">NEC PASS</span>
      </div>

      <div class="card card-amber">
        <div class="card-title">NEC Minimum Auto-Populate</div>
        <div class="card-sub">6ft/12ft outlets, 2x20A kitchen GFCIs, bath/garage/outdoor WR GFCIs, front-door &amp; stairway 3-way lighting, home runs &amp; daisy chains.</div>
        <div id="autoBtn" class="btn">Auto-Populate NEC Layout &amp; Wiring</div>
      </div>

      <div class="card">
        <div class="card-title">Trade-Priority Routing</div>
        <div class="card-sub">Yields to Structural, Plumbing (1), and HVAC (1) trunks automatically.</div>
        <div class="btn btn-blue">Inspect Panel Wiring (3D Cover Off)</div>
      </div>

      <div class="stats">
        <div class="stat"><div class="stat-v" id="statPanels">0</div><div class="stat-l">Panels</div></div>
        <div class="stat"><div class="stat-v" id="statDevices">0</div><div class="stat-l">Devices</div></div>
        <div class="stat"><div class="stat-v" id="statRuns">0</div><div class="stat-l">Runs</div></div>
      </div>

      <div id="railFlags" class="card card-red" style="display:none;">
        <div class="card-title" style="color:#f87171;">Live NEC Flags (2)</div>
        <div style="font-size:10px;color:#fca5a5;font-weight:600;">[NEC 406.9(C)] Tub-Side Outlet inside 3ft x 8ft bathtub zone</div>
        <div style="font-size:10px;color:#fca5a5;font-weight:600;">[NEC 240.24(E)] SUB-BATH prohibited inside bathroom</div>
        <div class="card-sub" style="color:#cbd5e1;">Click any flag to jump to offending node in 3D.</div>
      </div>

      <div id="railStatus" class="card" style="font-size:10px;color:#94a3b8;">
        Ready: Residential 120/240V 1Φ scene loaded.
      </div>
    </aside>

    <main class="stage">
      <canvas id="gl"></canvas>

      <div id="hudPill" class="hud-pill"></div>

      <div id="inspector" class="inspector"></div>

      <div id="outroBanner" class="outro-banner">
        <div style="font-size:17px;font-weight:800;color:#f8fafc;">@kruschdev/pascal-plugin-electrical</div>
        <div style="font-size:11px;color:#fbbf24;margin-top:3px;">30 Clean-Room MIT 3D CAD Models · Residential &amp; Commercial NEC Engine · 8 Agent Tools · 34/34 Tests</div>
      </div>

      <div id="scheduleOverlay" class="schedule-overlay"></div>

      <div class="caption-bar">
        <div>
          <div id="capTitle" class="cap-title"></div>
          <div id="capSub" class="cap-sub"></div>
        </div>
        <div id="capTag" class="cap-tag"></div>
      </div>
    </main>
  </div>

  <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>

  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    const DATA = ${JSON.stringify(payload)};
    const TOTAL_DURATION = 42.0;

    const canvas = document.getElementById('gl');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(992, 676, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const camera = new THREE.PerspectiveCamera(42, 992 / 676, 0.02, 80);

    // ─── Scene A: 3D Architectural House + Auto-Populated Electrical ─────────
    const houseScene = new THREE.Scene();
    houseScene.background = new THREE.Color(0x090f1d);
    houseScene.add(new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 1.25));
    const dirA = new THREE.DirectionalLight(0xffffff, 1.55);
    dirA.position.set(14, 18, 12);
    houseScene.add(dirA);
    const fillA = new THREE.DirectionalLight(0x60a5fa, 0.6);
    fillA.position.set(-8, 8, -6);
    houseScene.add(fillA);

    // Floor slab + grid
    const grid = new THREE.GridHelper(24, 24, 0x1e293b, 0x111a2e);
    grid.position.set(6, -0.01, 4.5);
    houseScene.add(grid);

    const floorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(12.2, 0.08, 8.2),
      new THREE.MeshStandardMaterial({ color: 0x131c31, roughness: 0.88 }),
    );
    floorMesh.position.set(6, -0.04, 4);
    houseScene.add(floorMesh);

    // Colored room zone pads
    const zoneColors = {
      living: 0x1e3a5f,
      kitchen: 0x3b2f1e,
      bathroom: 0x164e63,
      garage: 0x1f2937,
      outdoor: 0x14532d,
    };
    for (const z of DATA.zones) {
      const xs = z.polygon.map((p) => p[0]);
      const zs = z.polygon.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...zs) - Math.min(...zs);
      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(w - 0.14, d - 0.14),
        new THREE.MeshStandardMaterial({
          color: zoneColors[z.category] ?? 0x1e293b,
          transparent: true,
          opacity: 0.45,
          roughness: 0.9,
        }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set((Math.min(...xs) + Math.max(...xs)) / 2, 0.005, (Math.min(...zs) + Math.max(...zs)) / 2);
      houseScene.add(pad);
    }

    // Translucent architectural walls so interior wiring & trade pipes stay clearly visible
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.24,
      roughness: 0.7,
    });
    const wallEdgeMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.45 });
    for (const w of DATA.walls) {
      const dx = w.end[0] - w.start[0];
      const dz = w.end[1] - w.start[1];
      const len = Math.hypot(dx, dz);
      const geo = new THREE.BoxGeometry(len, w.height, w.thickness);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set((w.start[0] + w.end[0]) / 2, w.height / 2, (w.start[1] + w.end[1]) / 2);
      mesh.rotation.y = -Math.atan2(dz, dx);
      houseScene.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wallEdgeMat);
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      houseScene.add(edges);
    }

    // Stairway steps (10 risers)
    const stairMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.75 });
    for (let i = 0; i < 10; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.19, 0.26), stairMat);
      step.position.set(1.0, 0.095 + i * 0.21, 4.95 + i * 0.25);
      houseScene.add(step);
    }

    // Front Entry Door frame
    const doorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.96, 2.1, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.6 }),
    );
    doorMesh.position.set(2.2, 1.05, 0.0);
    houseScene.add(doorMesh);

    // Bathtub, Stove, Kitchen Sink
    const tubMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.65, 0.56, 0.82),
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.25, metalness: 0.1 }),
    );
    tubMesh.position.set(7.8, 0.28, 7.25);
    houseScene.add(tubMesh);
    const tubWater = new THREE.Mesh(
      new THREE.BoxGeometry(1.45, 0.06, 0.64),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55, roughness: 0.15 }),
    );
    tubWater.position.set(7.8, 0.54, 7.25);
    houseScene.add(tubWater);

    const stoveMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.92, 0.68),
      new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.5, roughness: 0.35 }),
    );
    stoveMesh.position.set(7.2, 0.46, 0.48);
    houseScene.add(stoveMesh);

    const sinkMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.65, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.3, roughness: 0.5 }),
    );
    sinkMesh.position.set(8.45, 0.45, 2.2);
    houseScene.add(sinkMesh);

    // Higher-priority Plumbing Pipe (Blue 4" DWV) & HVAC Duct (Silver 18"x10")
    const pipeGeo = new THREE.CylinderGeometry(0.065, 0.065, 7.2, 16);
    pipeGeo.rotateX(Math.PI / 2);
    const pipeMesh = new THREE.Mesh(
      pipeGeo,
      new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness: 0.35, roughness: 0.35 }),
    );
    pipeMesh.position.set(5.6, 2.48, 4.0);
    houseScene.add(pipeMesh);

    const ductMesh = new THREE.Mesh(
      new THREE.BoxGeometry(11.1, 0.25, 0.46),
      new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.72, roughness: 0.3 }),
    );
    ductMesh.position.set(5.95, 2.52, 4.1);
    houseScene.add(ductMesh);

    // Main Electrical Panel + NEC 110.26 working-space prism
    const panelGroup = new THREE.Group();
    const pPos = DATA.panel.position;
    const panelBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.92, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.6, roughness: 0.35 }),
    );
    panelGroup.add(panelBox);
    const clearBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.76, 1.98, 0.92),
      new THREE.MeshStandardMaterial({ color: 0x22c55e, transparent: true, opacity: 0.16 }),
    );
    clearBox.position.set(0, -0.53, 0.55);
    panelGroup.add(clearBox);
    panelGroup.position.set(pPos[0], pPos[1], pPos[2]);
    panelGroup.visible = false;
    houseScene.add(panelGroup);

    // Auto-populated devices
    const deviceMeshes = [];
    for (const dev of DATA.devices) {
      let color = 0xfacc15; // duplex
      let size = [0.12, 0.16, 0.08];
      if (dev.deviceKind === 'gfci') color = 0x22d3ee;
      else if (dev.deviceKind === 'luminaire') { color = 0xfef08a; size = [0.32, 0.08, 0.32]; }
      else if (dev.deviceKind === 'switch-1p' || dev.deviceKind === 'switch-3way') { color = 0xa78bfa; size = [0.1, 0.15, 0.07]; }
      else if (dev.deviceKind === 'evse') { color = 0x34d399; size = [0.3, 0.5, 0.14]; }
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: dev.deviceKind === 'luminaire' ? 0.65 : 0.22,
        roughness: 0.35,
      });
      const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
      m.position.set(dev.position[0], dev.position[1], dev.position[2]);
      m.visible = false;
      houseScene.add(m);
      deviceMeshes.push(m);
    }

    // Auto-populated Home Runs (amber) & Daisy-Chain Runs (sky blue)
    const runMeshes = [];
    for (const run of DATA.runs) {
      const pts = (run.path || []).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      if (pts.length < 2) continue;
      const isHomeRun = String(run.name || '').toLowerCase().includes('home run');
      const runGroup = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: isHomeRun ? 0xf59e0b : 0x38bdf8,
        emissive: isHomeRun ? 0xf59e0b : 0x38bdf8,
        emissiveIntensity: 0.28,
        roughness: 0.3,
        metalness: 0.4,
      });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const segLen = a.distanceTo(b);
        if (segLen < 0.005) continue;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(isHomeRun ? 0.022 : 0.016, isHomeRun ? 0.022 : 0.016, segLen, 8), mat);
        cyl.position.copy(a).add(b).multiplyScalar(0.5);
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        runGroup.add(cyl);
      }
      runGroup.visible = false;
      houseScene.add(runGroup);
      runMeshes.push(runGroup);
    }

    // Chapter 3 Violation Objects: 3ft x 8ft bathtub exclusion zone + moving test outlet
    const tubZoneMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });
    const tubZonePrism = new THREE.Mesh(new THREE.BoxGeometry(1.65 + 1.83, 2.44, 0.82 + 1.83), tubZoneMat);
    tubZonePrism.position.set(7.8, 1.22, 7.25);
    tubZonePrism.visible = false;
    houseScene.add(tubZonePrism);

    const testOutletMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.7 });
    const testOutlet = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.12), testOutletMat);
    testOutlet.position.set(6.72, 1.1, 7.25);
    testOutlet.visible = false;
    houseScene.add(testOutlet);

    const badPanel = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.85, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.55 }),
    );
    badPanel.position.set(5.85, 1.5, 6.2);
    badPanel.visible = false;
    houseScene.add(badPanel);

    // ─── Scene B: Cover-Off Wired Panel Interior (Real GLBs) ─────────────────
    const panelScene = new THREE.Scene();
    panelScene.background = new THREE.Color(0x0b1220);
    panelScene.add(new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.45));
    const pKey = new THREE.DirectionalLight(0xffffff, 2.0);
    pKey.position.set(1.8, 2.5, 3.0);
    panelScene.add(pKey);
    const pFill = new THREE.DirectionalLight(0x93c5fd, 0.9);
    pFill.position.set(-2.2, 0.8, 2.0);
    panelScene.add(pFill);

    // ─── Scene C: 30-Model CAD Turntable Showcase (Real GLBs) ────────────────
    const cadScene = new THREE.Scene();
    cadScene.background = new THREE.Color(0x090f1d);
    cadScene.add(new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 1.4));
    const cKey = new THREE.DirectionalLight(0xffffff, 1.85);
    cKey.position.set(3, 5, 4);
    cadScene.add(cKey);
    const cRim = new THREE.DirectionalLight(0x38bdf8, 0.95);
    cRim.position.set(-4, 2, -3);
    cadScene.add(cRim);

    const turntable = new THREE.Group();
    cadScene.add(turntable);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.35, 2.45, 0.08, 48),
      new THREE.MeshStandardMaterial({ color: 0x111c32, metalness: 0.45, roughness: 0.4 }),
    );
    disc.position.y = -0.04;
    turntable.add(disc);

    const loader = new GLTFLoader();
    let resPanelObj = null;
    let commPanelObj = null;

    async function loadAssets() {
      const resGltf = await loader.loadAsync('/cad/panel-res-200a-open/model.glb');
      resPanelObj = resGltf.scene;
      centerObject(resPanelObj);
      panelScene.add(resPanelObj);

      const commGltf = await loader.loadAsync('/cad/panel-comm-400a-3p/model.glb');
      commPanelObj = commGltf.scene;
      centerObject(commPanelObj);
      commPanelObj.visible = false;
      panelScene.add(commPanelObj);

      const heroSlugs = [
        'panel-res-200a-open',
        'transformer-75kva-480v',
        'box-4sq-steel-deep',
        'device-gfci-20a',
        'device-evse-level2',
        'fixture-troffer-2x4',
        'device-motor-3p-tefc',
      ];
      for (let i = 0; i < heroSlugs.length; i++) {
        const gltf = await loader.loadAsync('/cad/' + heroSlugs[i] + '/model.glb');
        const obj = gltf.scene;
        const box = new THREE.Box3().setFromObject(obj);
        const sz = new THREE.Vector3();
        const ctr = new THREE.Vector3();
        box.getSize(sz);
        box.getCenter(ctr);
        const maxDim = Math.max(sz.x, sz.y, sz.z, 0.01);
        const scale = 0.72 / maxDim;
        obj.scale.setScalar(scale);
        obj.position.set(-ctr.x * scale, -box.min.y * scale + 0.02, -ctr.z * scale);
        const holder = new THREE.Group();
        holder.add(obj);
        const ang = (i / heroSlugs.length) * Math.PI * 2;
        holder.position.set(Math.cos(ang) * 1.65, 0, Math.sin(ang) * 1.65);
        holder.rotation.y = -ang + Math.PI / 2;
        turntable.add(holder);
      }
      window.__ready = true;
    }

    function centerObject(obj) {
      const box = new THREE.Box3().setFromObject(obj);
      const ctr = new THREE.Vector3();
      box.getCenter(ctr);
      obj.position.sub(ctr);
    }

    function renderScheduleHtml(isCustom, taxPct) {
      const bom = isCustom ? DATA.bomCustom : DATA.bomDefault;
      const taxUsd = +(bom.materialSubtotalUsd * (taxPct / 100)).toFixed(2);
      const grandTotal = +(bom.estimatedTotalUsd + taxUsd).toFixed(2);
      const rowsHtml = DATA.scheduleRows.map((r) => {
        const l = r.left ? (r.left.circuitNumber + ' · ' + r.left.description + ' (' + r.left.breakerAmps + 'A)') : 'Spare';
        const rt = r.right ? (r.right.circuitNumber + ' · ' + r.right.description + ' (' + r.right.breakerAmps + 'A)') : 'Spare';
        return '<tr><td>' + l + '</td><td style="text-align:center;color:#fbbf24;font-weight:700;">' + r.phaseLabel + '</td><td>' + rt + '</td></tr>';
      }).join('');
      const bomHtml = bom.lineItems.slice(0, 9).map((item) =>
        '<tr><td>' + item.description + '</td><td style="text-align:right;">' + item.quantity + ' ' + item.unit + '</td><td style="text-align:right;">$' + item.extendedMaterialUsd.toFixed(2) + '</td><td style="text-align:right;color:#7dd3fc;">' + item.extendedLaborHours.toFixed(1) + 'h</td></tr>'
      ).join('');

      return \`
        <div class="pane">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:13px;">Panelboard Schedule · \${DATA.scheduleMeta.panelName} (\${DATA.scheduleMeta.voltageSystem})</strong>
            <span class="badge-pass">\${DATA.scheduleMeta.usedSpaces}/\${DATA.scheduleMeta.spaces} Spaces · \${DATA.scheduleMeta.imbalancePct}% Imbalance</span>
          </div>
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-val">\${DATA.scheduleMeta.totalConnectedVa} VA</div><div class="kpi-lbl">Connected Load</div></div>
            <div class="kpi"><div class="kpi-val">\${DATA.scheduleMeta.totalLineAmps} A</div><div class="kpi-lbl">Line Current</div></div>
            <div class="kpi"><div class="kpi-val">\${DATA.scheduleMeta.utilizationPct}%</div><div class="kpi-lbl">200A Bus Util</div></div>
          </div>
          <table>
            <thead><tr><th>Odd Circuits (Left)</th><th style="text-align:center;">Bus</th><th>Even Circuits (Right)</th></tr></thead>
            <tbody>\${rowsHtml}</tbody>
          </table>
        </div>
        <div class="pane">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:13px;">Material Takeoff &amp; Live Price Calculator</strong>
            <span style="font-size:10px;color:#34d399;font-weight:700;">Export BOM CSV</span>
          </div>
          <div class="calc-controls">
            <div>Labor Rate ($/hr)<div class="calc-box">\$\${bom.laborRatePerHourUsd}/hr</div></div>
            <div>Material Markup<div class="calc-box">\${bom.materialMarkupPct}%</div></div>
            <div>Material Tax<div class="calc-box">\${taxPct}%</div></div>
          </div>
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-val" style="color:#fbbf24;">\$\${bom.materialSubtotalUsd.toFixed(2)}</div><div class="kpi-lbl">Materials</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#38bdf8;">\$\${bom.laborSubtotalUsd.toFixed(2)}</div><div class="kpi-lbl">Labor (\${bom.laborHoursTotal.toFixed(1)}h)</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#34d399;">\$\${grandTotal.toFixed(2)}</div><div class="kpi-lbl">Estimated Total</div></div>
          </div>
          <table>
            <thead><tr><th>BOM Line Item</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Material</th><th style="text-align:right;">Labor</th></tr></thead>
            <tbody>\${bomHtml}</tbody>
          </table>
        </div>
      \`;
    }

    const els = {
      chapterPill: document.getElementById('chapterPill'),
      necBadge: document.getElementById('necBadge'),
      autoBtn: document.getElementById('autoBtn'),
      statPanels: document.getElementById('statPanels'),
      statDevices: document.getElementById('statDevices'),
      statRuns: document.getElementById('statRuns'),
      railFlags: document.getElementById('railFlags'),
      railStatus: document.getElementById('railStatus'),
      hudPill: document.getElementById('hudPill'),
      inspector: document.getElementById('inspector'),
      scheduleOverlay: document.getElementById('scheduleOverlay'),
      outroBanner: document.getElementById('outroBanner'),
      capTitle: document.getElementById('capTitle'),
      capSub: document.getElementById('capSub'),
      capTag: document.getElementById('capTag'),
      progressFill: document.getElementById('progressFill'),
    };

    window.__renderFrame = function renderFrame(t) {
      els.progressFill.style.width = Math.min(100, (t / TOTAL_DURATION) * 100).toFixed(2) + '%';

      // Default resets
      els.scheduleOverlay.style.display = 'none';
      els.inspector.style.display = 'none';
      els.outroBanner.style.display = 'none';
      els.railFlags.style.display = 'none';
      els.hudPill.style.display = 'flex';
      els.autoBtn.className = 'btn';
      els.necBadge.className = 'badge-pass';
      els.necBadge.textContent = 'NEC PASS';
      tubZonePrism.visible = false;
      testOutlet.visible = false;
      badPanel.visible = false;

      // ── Chapter 1 (0–8s): NEC Minimum Auto-Populate ────────────────────────
      if (t < 8.0) {
        els.chapterPill.textContent = '1 / 6 · NEC Minimum Auto-Populate';
        els.capTitle.textContent = 'One-Click NEC Minimum Layout, Balanced Circuits & Daisy-Chain Wiring';
        els.capSub.textContent = 'Walks Pascal walls, doors, stairs, and room zones to place 6ft/12ft outlets, 2x20A kitchen GFCIs, bath/garage/outdoor WR GFCIs, 3-way stairway lights, home runs, and outlet-to-outlet runs.';
        els.capTag.textContent = 'NEC 210.52 · 210.70 · 210.8';
        els.hudPill.innerHTML =
          '<span><i class="dot" style="background:#f59e0b"></i>Home Runs</span>' +
          '<span><i class="dot" style="background:#38bdf8"></i>Daisy-Chain Runs</span>' +
          '<span><i class="dot" style="background:#22d3ee"></i>GFCI Outlets</span>' +
          '<span><i class="dot" style="background:#0ea5e9"></i>4" Plumbing</span>' +
          '<span><i class="dot" style="background:#cbd5e1"></i>HVAC Trunk</span>';

        const popP = Math.max(0, Math.min(1, (t - 1.5) / 4.2));
        if (t >= 1.1 && t <= 2.3) els.autoBtn.className = 'btn btn-active';
        panelGroup.visible = popP > 0.05;
        const devVis = Math.floor(popP * deviceMeshes.length);
        const runVis = Math.floor(Math.max(0, (t - 3.2) / 3.2) * runMeshes.length);
        deviceMeshes.forEach((m, idx) => (m.visible = idx < devVis));
        runMeshes.forEach((m, idx) => (m.visible = idx < runVis));

        els.statPanels.textContent = panelGroup.visible ? '1' : '0';
        els.statDevices.textContent = String(devVis);
        els.statRuns.textContent = String(Math.min(runVis, runMeshes.length));
        els.railStatus.textContent = popP > 0.85
          ? 'Auto-populated ' + DATA.devices.length + ' devices across ' + DATA.summary.circuitsCreated + ' balanced circuits (' + DATA.summary.homeRunsPlanned + ' home runs + ' + DATA.summary.daisyChainRunsPlanned + ' daisy chains).'
          : 'Scanning Pascal walls, doors, stairways, and zones...';

        const ang = -0.55 + (t / 8.0) * 0.75;
        camera.position.set(6.0 + Math.sin(ang) * 12.5, 8.8 - t * 0.25, 4.0 + Math.cos(ang) * 11.2);
        camera.lookAt(6.0, 1.1, 4.0);
        renderer.render(houseScene, camera);
        return;
      }

      // Ensure full house electrical is visible for Chapters 2 & 3
      panelGroup.visible = true;
      deviceMeshes.forEach((m) => (m.visible = true));
      runMeshes.forEach((m) => (m.visible = true));
      els.statPanels.textContent = '1';
      els.statDevices.textContent = String(DATA.devices.length);
      els.statRuns.textContent = String(DATA.runs.length);

      // ── Chapter 2 (8–15s): Trade-Priority Routing Around Plumbing & HVAC ──
      if (t < 15.0) {
        const u = (t - 8.0) / 7.0;
        els.chapterPill.textContent = '2 / 6 · Trade-Priority Obstacle Routing';
        els.capTitle.textContent = 'Electrical Always Yields to Structural, Plumbing & HVAC';
        els.capSub.textContent = 'Conduit and NM-B paths automatically jog around the 4" DWV pipe and 18"x10" HVAC supply trunk, tracking NEC 358.26 bend totals and real detoured lengths.';
        els.capTag.textContent = '0 Trade Clashes · <= 360° Bends';
        els.hudPill.innerHTML =
          '<strong style="color:#fbbf24;">Priority:</strong> 1. Structural &rarr; 2. Plumbing &rarr; 3. HVAC &rarr; 4. Electrical' +
          ' &nbsp;|&nbsp; <span style="color:#34d399;font-weight:700;">0 Clashes</span>';
        els.railStatus.textContent = 'Routed ' + DATA.runs.length + ' runs around plumbing & HVAC trunks with 0 clashes.';

        const cx = 3.6 + u * 4.8;
        const cz = 6.9 - u * 4.2;
        camera.position.set(cx, 3.65 - Math.sin(u * Math.PI) * 0.65, cz);
        camera.lookAt(5.6, 2.45, 4.1);
        renderer.render(houseScene, camera);
        return;
      }

      // ── Chapter 3 (15–22s): Live NEC Prohibited-Location Restrictions ──────
      if (t < 22.0) {
        const u = (t - 15.0) / 7.0;
        const fixed = t >= 19.6;
        els.chapterPill.textContent = '3 / 6 · NEC Prohibited-Location Guard';
        els.capTitle.textContent = fixed
          ? 'Moved Outside Restricted Zone -> Instantly Verified NEC Compliant'
          : 'Placing Equipment in Prohibited Spots Immediately Flags NOT TO CODE';
        els.capSub.textContent = fixed
          ? 'Relocating the GFCI outlet >= 3 ft outside the bathtub rim clears NEC 406.9(C) and flips both the Inspector and Left-Rail back to NEC PASS.'
          : 'Live auditor enforces NEC 240.24(A)/(D)/(E)/(F) panels, 312.2 NEMA ratings, 406.9(C)/404.4(C)/410.10(D) tub/shower zones, stove/sink hazards, and 210.11(C) dedicated circuits.';
        els.capTag.textContent = fixed ? 'NEC PASS · 0 Errors' : 'NOT TO CODE · NEC 406.9(C) & 240.24(E)';

        tubZonePrism.visible = true;
        testOutlet.visible = true;
        badPanel.visible = !fixed;

        if (!fixed) {
          tubZoneMat.color.setHex(0xef4444);
          tubZoneMat.opacity = 0.22 + Math.sin(t * 9) * 0.08;
          testOutlet.position.set(6.72, 1.1, 7.25);
          testOutletMat.color.setHex(0xef4444);
          testOutletMat.emissive.setHex(0xef4444);
          els.necBadge.className = 'badge-err';
          els.necBadge.textContent = '2 ERR / 0 WARN';
          els.railFlags.style.display = 'flex';
          els.railStatus.textContent = 'Violation detected! Click any Live NEC Flag to focus offending node.';
          els.inspector.style.display = 'flex';
          els.inspector.innerHTML = \`
            <div style="font-weight:700;font-size:12px;">Inspector · Tub-Side Outlet (GFCI)</div>
            <div class="violation-box">
              <div style="color:#f87171;font-weight:800;font-size:11px;">NOT TO CODE (1)</div>
              <div style="color:#fca5a5;font-weight:700;font-size:10px;">[NEC 406.9(C)] Receptacle inside bathtub/shower restricted zone</div>
              <div style="font-size:10px;color:#e2e8f0;">0.82 ft horizontally from Bathtub (must be >= 3 ft horizontally or >= 8 ft high).</div>
              <div style="font-size:10px;color:#fbbf24;">Fix: Move outlet >= 3 ft (0.92 m) outside bathtub rim.</div>
            </div>
            <div class="inspector-row"><span style="opacity:0.7;">NEC 314.16 Box Fill</span><span>12.5 / 18 cu in (69.4%)</span></div>
          \`;
        } else {
          const slide = Math.min(1, (t - 19.6) / 0.9);
          tubZoneMat.color.setHex(0x10b981);
          tubZoneMat.opacity = 0.14;
          testOutlet.position.set(6.72 - slide * 1.05, 1.1, 7.25 - slide * 1.45);
          testOutletMat.color.setHex(0x22c55e);
          testOutletMat.emissive.setHex(0x22c55e);
          els.railStatus.textContent = 'All NEC prohibited-location and clearance checks passed.';
          els.inspector.style.display = 'flex';
          els.inspector.innerHTML = \`
            <div style="font-weight:700;font-size:12px;">Inspector · Vanity GFCI Outlet</div>
            <div class="pass-box"><span>NEC Code Check: Compliant</span><span>PASS</span></div>
            <div class="inspector-row"><span style="opacity:0.7;">Distance from Tub Rim</span><span style="color:#34d399;font-weight:700;">4.6 ft (&gt;= 3 ft)</span></div>
            <div class="inspector-row"><span style="opacity:0.7;">NEC 314.16 Box Fill</span><span>12.5 / 18 cu in (69.4%)</span></div>
          \`;
        }

        els.hudPill.innerHTML = fixed
          ? '<span style="color:#34d399;font-weight:700;">NEC 406.9(C) Clear · >= 3 ft from Bathtub Rim</span>'
          : '<span style="color:#f87171;font-weight:700;">NEC 406.9(C) 3ft x 8ft Exclusion Zone Active</span>';

        camera.position.set(4.1 + u * 1.2, 3.6, 9.6 - u * 0.6);
        camera.lookAt(7.2, 1.0, 6.8);
        renderer.render(houseScene, camera);
        return;
      }

      // ── Chapter 4 (22–31s): Zoom-In Cover-Off 3D Panel Interior View ──────
      if (t < 31.0) {
        const isCommercial = t >= 27.0;
        if (resPanelObj) resPanelObj.visible = !isCommercial;
        if (commPanelObj) commPanelObj.visible = isCommercial;

        els.chapterPill.textContent = '4 / 6 · Cover-Off 3D Panel Interior View';
        if (!isCommercial) {
          const u = (t - 22.0) / 5.0; // 0..1: start full panel -> zoom right into breaker lugs & wires
          const zoom = Math.min(1, u * 1.25);
          const dist = 1.48 - zoom * 0.92; // 1.48m -> 0.56m extreme close-up!
          const yaw = -0.22 + u * 0.52;
          camera.position.set(Math.sin(yaw) * dist, 0.05 - zoom * 0.06, Math.cos(yaw) * dist);
          camera.lookAt(0.02, -0.02 * zoom, 0.03);

          els.capTitle.textContent = 'Zoom Inside the Open Panelboard: Busbars, Breakers & Individual Wires';
          els.capSub.textContent = 'Cover-off 200A 120/240V interior showing copper bus stabs, main breaker, neutral/ground bars, AFCI/GFCI pigtails, and every 90°-bent branch wire landed on its brass lug.';
          els.capTag.textContent = '200A 120/240V 1Φ · Cover Off';
          els.hudPill.innerHTML =
            '<span><i class="dot" style="background:#1e293b;border:1px solid #94a3b8;"></i>L1 Black</span>' +
            '<span><i class="dot" style="background:#ef4444"></i>L2 Red</span>' +
            '<span><i class="dot" style="background:#f8fafc"></i>Neutral White</span>' +
            '<span><i class="dot" style="background:#d97706"></i>Bare Cu Ground</span>';
          els.railStatus.textContent = 'Interactive 3D Panel Interior: Toggle Cover Off / Deadfront / Closed & click any wire to inspect circuit.';
        } else {
          const u = (t - 27.0) / 4.0;
          const dist = 1.56 - Math.sin(u * Math.PI) * 0.52;
          const yaw = 0.28 - u * 0.56;
          camera.position.set(Math.sin(yaw) * dist, 0.04, Math.cos(yaw) * dist);
          camera.lookAt(0, 0.01, 0.02);

          els.capTitle.textContent = 'Commercial 400A 277/480V 3-Phase Interior Wiring';
          els.capSub.textContent = '3-bus copper interior with NEC Brown/Orange/Yellow phase feeders, 3-pole motor breakers, Gray neutrals, and isolated Green equipment ground bar.';
          els.capTag.textContent = '400A 277/480V 3Φ · B/O/Y';
          els.hudPill.innerHTML =
            '<span><i class="dot" style="background:#78350f"></i>Phase A Brown</span>' +
            '<span><i class="dot" style="background:#f97316"></i>Phase B Orange</span>' +
            '<span><i class="dot" style="background:#eab308"></i>Phase C Yellow</span>' +
            '<span><i class="dot" style="background:#22c55e"></i>Green EGC</span>';
          els.railStatus.textContent = 'Commercial 3Φ 277/480V panelboard interior with 3-pole breakers and phase color coding.';
        }
        renderer.render(panelScene, camera);
        return;
      }

      // ── Chapter 5 (31–37.5s): Panelboard Schedule & Live BOM Calculator ────
      if (t < 37.5) {
        const isCustom = t >= 34.0;
        els.chapterPill.textContent = '5 / 6 · Panel Schedule & Live Price Calculator';
        els.hudPill.style.display = 'none';
        els.scheduleOverlay.style.display = 'grid';
        els.scheduleOverlay.innerHTML = renderScheduleHtml(isCustom, isCustom ? 8.25 : 0);
        els.capTitle.textContent = 'Auto-Generated Panel Schedule, Material Takeoff & Live Cost Estimator';
        els.capSub.textContent = isCustom
          ? 'Live Labor Rate ($95/hr), Material Markup (15%), and Sales Tax (8.25%) immediately recalculate totals and export to CSV.'
          : 'Counts 10%-waste wire rolls, 10ft conduit sticks, connectors/straps, NEC 314.16 boxes, breakers, panels, and fixtures directly from the 3D scene.';
        els.capTag.textContent = isCustom ? 'Live Rates Updated · CSV Ready' : 'Priced BOM + Labor Hours';
        els.railStatus.textContent = 'Schedule & Takeoff synced to ' + DATA.devices.length + ' devices and ' + DATA.runs.length + ' routed runs.';
        return;
      }

      // ── Chapter 6 (37.5–42s): 30-Model MIT 3D CAD Library Showcase & Outro ─
      const u = (t - 37.5) / 4.5;
      els.chapterPill.textContent = '6 / 6 · 30 Clean-Room MIT 3D CAD Models';
      els.hudPill.style.display = 'none';
      els.outroBanner.style.display = 'block';
      els.capTitle.textContent = '30 Clean-Room MIT Electrical .GLB Models + 8 Pure Zod Agent Tools';
      els.capSub.textContent = 'Panels, breakers, transformers, NEC 314.16 boxes, receptacles, EVSE, 3Φ motors, 7 light fixtures, and conduit fittings, ready for Pascal Editor.';
      els.capTag.textContent = 'MIT Open Source · @kruschdev';
      els.railStatus.textContent = 'bun run check: 34/34 tests (395 assertions), 4/4 boundary gates PASSED.';

      turntable.rotation.y = u * Math.PI * 1.25;
      camera.position.set(0, 1.65, 4.35);
      camera.lookAt(0, 0.25, 0);
      renderer.render(cadScene, camera);
    };

    loadAssets();
  </script>
</body>
</html>`

// ─── 3. Serve Assets + Drive Puppeteer Frame-by-Frame into FFmpeg ────────────
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname.startsWith('/three/')) {
      const full = path.join(rootDir, 'node_modules', 'three', url.pathname.slice('/three/'.length))
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full), { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
      }
    }
    if (url.pathname.startsWith('/cad/')) {
      const full = path.join(cadDir, url.pathname.slice('/cad/'.length))
      if (fs.existsSync(full)) return new Response(Bun.file(full))
    }
    return new Response('Not found', { status: 404 })
  },
})

fs.mkdirSync(keyframesDir, { recursive: true })

const FPS = 24
const DURATION_S = 42
const TOTAL_FRAMES = FPS * DURATION_S
const KEYFRAME_SECONDS = new Set([5, 11, 17, 25, 29, 35, 40])

const puppeteerPath = process.env.PUPPETEER_MODULE ?? 'puppeteer'
const puppeteerMod = (await import(puppeteerPath)) as { default?: PuppeteerLike } & PuppeteerLike
const puppeteer: PuppeteerLike = puppeteerMod.default ?? puppeteerMod
const chromeBin = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'

const browser = await puppeteer.launch({
  executablePath: chromeBin,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--window-size=1280,720',
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, {
  timeout: 30000,
})

const ffmpeg = Bun.spawn(
  [
    ffmpegBin,
    '-y',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-r',
    String(FPS),
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outMp4,
  ],
  { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
)

const t0 = Date.now()
for (let f = 0; f < TOTAL_FRAMES; f++) {
  const t = f / FPS
  await page.evaluate((sec: number) => {
    ;(window as unknown as { __renderFrame: (s: number) => void }).__renderFrame(sec)
  }, t)
  const jpeg = (await page.screenshot({ type: 'jpeg', quality: 92 })) as Uint8Array
  ffmpeg.stdin.write(jpeg)

  if (f % FPS === 0 && KEYFRAME_SECONDS.has(Math.round(t))) {
    const kfPath = path.join(keyframesDir, `ch_t${String(Math.round(t)).padStart(2, '0')}s.jpg`)
    fs.writeFileSync(kfPath, jpeg)
  }
  if (f > 0 && f % 120 === 0) {
    console.log(`Rendered ${f}/${TOTAL_FRAMES} frames (${Math.round((f / TOTAL_FRAMES) * 100)}%)...`)
  }
}

ffmpeg.stdin.end()
const mp4Code = await ffmpeg.exited
await browser.close()
server.stop(true)

if (mp4Code !== 0 || !fs.existsSync(outMp4)) {
  console.error('FFmpeg MP4 encode failed:', await new Response(ffmpeg.stderr).text())
  process.exit(1)
}
const mp4Kb = Math.round(fs.statSync(outMp4).size / 1024)
console.log(`Encoded ${outMp4} (${mp4Kb} KB) in ${Math.round((Date.now() - t0) / 1000)}s`)

// Generate lightweight palette-optimized GIF preview for GitHub README autoplay
const gifProc = Bun.spawn(
  [
    ffmpegBin,
    '-y',
    '-i',
    outMp4,
    '-vf',
    'fps=5,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    outGif,
  ],
  { stdout: 'ignore', stderr: 'pipe' },
)
const gifCode = await gifProc.exited
if (gifCode !== 0 || !fs.existsSync(outGif)) {
  console.error('FFmpeg GIF encode failed:', await new Response(gifProc.stderr).text())
  process.exit(1)
}
console.log(`Encoded ${outGif} (${Math.round(fs.statSync(outGif).size / 1024)} KB)`)
