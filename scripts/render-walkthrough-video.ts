/**
 * Real Pascal Editor Walkthrough Video Recorder for `@kruschdev/pascal-plugin-electrical`.
 *
 * Connects Puppeteer to a live running Pascal Editor host (`PASCAL_EDITOR_URL`, e.g.
 * `http://127.0.0.1:3099/project/<sceneId>`) with `@kruschdev/pascal-plugin-electrical` loaded,
 * drives real clicks and 3D camera orbits across:
 *   1. One-Click NEC Minimum Auto-Populate (6ft/12ft outlets, GFCIs, lights, circuits, home runs & daisy chains)
 *   2. 3D Trade-Priority Routing orbit & zoom (yielding around plumbing pipe & HVAC duct)
 *   3. Cover-Off 3D Panel Interior Wiring View (Full Open Panel, Zoom: Breakers & Lugs, Panel Cover On toggle, Main & Busbars)
 *   4. Panelboard Schedule & NEC Article 220 Load Calculation
 *   5. Live Priced BOM Takeoff Calculator (Labor/Markup/Tax) & NEC Compliance Audit
 *
 * Encodes:
 *   - `assets/demo-walkthrough.mp4` (1280x720 H.264 +faststart)
 *   - `assets/demo-walkthrough.gif` (640px wide palette-optimized README preview)
 *
 * Usage:
 *   PASCAL_EDITOR_URL=http://127.0.0.1:3099/project/<id> bun run render:walkthrough
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type PuppeteerPageLike = {
  setViewport: (v: { width: number; height: number; deviceScaleFactor: number }) => Promise<void>
  goto: (url: string, opts: { waitUntil: string; timeout: number }) => Promise<void>
  evaluate: <R = unknown, A = unknown>(fn: (arg: A) => R, arg?: A) => Promise<R>
  screenshot: (opts: { type: 'jpeg' | 'png'; quality?: number }) => Promise<Uint8Array>
  mouse: {
    move: (x: number, y: number, opts?: { steps?: number }) => Promise<void>
    down: (opts?: { button?: 'left' | 'right' | 'middle' }) => Promise<void>
    up: (opts?: { button?: 'left' | 'right' | 'middle' }) => Promise<void>
    click: (x: number, y: number) => Promise<void>
    wheel: (opts: { deltaY: number }) => Promise<void>
  }
  on: (event: string, cb: (arg: { message?: string }) => void) => void
}

type PuppeteerLike = {
  launch: (opts: Record<string, unknown>) => Promise<{
    newPage: () => Promise<PuppeteerPageLike>
    close: () => Promise<void>
  }>
}

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outMp4 = path.join(rootDir, 'assets', 'demo-walkthrough.mp4')
const outGif = path.join(rootDir, 'assets', 'demo-walkthrough.gif')
const keyframesDir = path.join(os.tmpdir(), 'pascal_real_walkthrough_keyframes')
const mediaShotsDir = process.env.MEDIA_SHOTS_DIR ?? ''
const refreshRepoShots = process.env.REFRESH_REPO_SHOTS !== '0'
if (mediaShotsDir) fs.mkdirSync(mediaShotsDir, { recursive: true })

const targetUrl = process.env.PASCAL_EDITOR_URL
if (!targetUrl) {
  console.error('Set PASCAL_EDITOR_URL=http://127.0.0.1:3099/project/<sceneId> before running render:walkthrough.')
  process.exit(1)
}

const puppeteerPath = process.env.PUPPETEER_MODULE ?? 'puppeteer'
const puppeteerMod = (await import(puppeteerPath)) as { default?: PuppeteerLike } & PuppeteerLike
const puppeteer: PuppeteerLike = puppeteerMod.default ?? puppeteerMod
const chromeBin = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'

fs.mkdirSync(keyframesDir, { recursive: true })

const VIEW_W = 1440
const VIEW_H = 810
const CAPTURE_FPS = 10

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
    `--window-size=${VIEW_W},${VIEW_H}`,
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message))

console.log(`Opening real Pascal Editor at ${targetUrl}...`)
await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 })
// Wait until the 3D canvas AND the Electrical plugin button (or Plugins rail) are mounted & hydrated
let sceneReady = false
for (let i = 0; i < 120; i++) {
  const state = await page
    .evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'))
      const hasCanvas = canvases.some((c) => c.getBoundingClientRect().width > 300)
      const btns = Array.from(document.querySelectorAll('button'))
      const hasElectrical = btns.some(
        (b) => b.innerText.trim() === 'Electrical' || b.getAttribute('aria-label') === 'Electrical',
      )
      const hasPlugins = btns.some(
        (b) => b.innerText.trim() === 'Plugins' || b.getAttribute('aria-label') === 'Plugins',
      )
      return { hasCanvas, hasElectrical, hasPlugins }
    })
    .catch(() => ({ hasCanvas: false, hasElectrical: false, hasPlugins: false }))
  if (state.hasCanvas && state.hasElectrical) {
    sceneReady = true
    break
  }
  if (i > 20 && state.hasCanvas && state.hasPlugins) {
    sceneReady = true
    break
  }
  await new Promise((r) => setTimeout(r, 500))
}
if (!sceneReady) {
  throw new Error('Timed out waiting for Pascal Editor 3D canvas and plugin rail to hydrate')
}
// Allow SwiftShader WebGL scene geometry & materials to finish compiling first frames
await new Promise((r) => setTimeout(r, 4000))

// Dismiss the "Pan / Rotate / Zoom" hint pill if present
await page
  .evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    for (const b of btns) {
      const parentText = b.parentElement?.innerText ?? ''
      if (parentText.includes('Pan') && parentText.includes('Rotate') && parentText.includes('Zoom')) {
        b.click()
        break
      }
    }
  })
  .catch(() => {})
await new Promise((r) => setTimeout(r, 600))

// Open Electrical rail panel (either directly in Plugins section or via Plugins -> Install/Open Electrical)
let electricalPanelOpen = false
for (let attempt = 0; attempt < 25; attempt++) {
  const hasAutoPop = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('Auto-Populate NEC Layout')),
    )
    .catch(() => false)
  if (hasAutoPop) {
    electricalPanelOpen = true
    break
  }
  await page
    .evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const elec = btns.find(
        (b) => b.innerText.trim() === 'Electrical' || b.getAttribute('aria-label') === 'Electrical',
      )
      if (elec) {
        elec.click()
        return
      }
      const plug = btns.find(
        (b) => b.innerText.trim() === 'Plugins' || b.getAttribute('aria-label') === 'Plugins',
      )
      if (plug) plug.click()
    })
    .catch(() => {})
  await new Promise((r) => setTimeout(r, 800))
}
if (!electricalPanelOpen) {
  throw new Error('Electrical plugin panel did not open (Auto-Populate NEC Layout button not found)')
}
await new Promise((r) => setTimeout(r, 2000))

// Inject clean CSS hiding Next.js dev overlay badges (e.g. "N 2 Issues"), plus non-intrusive
// chapter banner and visual click cursor ring for walkthrough clarity.
await page.evaluate(() => {
  const hideDevStyle = document.createElement('style')
  hideDevStyle.textContent =
    'nextjs-portal, #__next-build-indicator, [data-nextjs-toast], [data-nextjs-dialog-overlay] {' +
    '  display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;' +
    '}'
  document.head.appendChild(hideDevStyle)

  const pill = document.createElement('div')
  pill.id = '__walkthrough_banner'
  pill.style.cssText =
    'position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:99999;' +
    'padding:7px 16px;border-radius:999px;background:rgba(10,15,28,0.92);' +
    'border:1px solid rgba(245,158,11,0.55);color:#f8fafc;font:600 13px/1.2 system-ui,sans-serif;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.45);pointer-events:none;white-space:nowrap;'
  pill.textContent = '1 / 5 · Pascal Editor + Electrical NEC Plugin (Ready)'
  document.body.appendChild(pill)

  const cursor = document.createElement('div')
  cursor.id = '__walkthrough_cursor'
  cursor.style.cssText =
    'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;' +
    'border-radius:999px;border:3px solid #f59e0b;background:rgba(245,158,11,0.28);' +
    'box-shadow:0 0 14px rgba(245,158,11,0.75);z-index:99999;pointer-events:none;' +
    'transition:transform 0.14s ease;'
  document.body.appendChild(cursor)
})

// Collapse narrow left icon menu before recording so the 3D Two-Bedroom House fills the widescreen viewport
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(
    (x) => x.getAttribute('aria-label') === 'Hide menu' || x.innerText.trim() === 'Hide menu',
  )
  if (b) b.click()
})
await new Promise((r) => setTimeout(r, 600))

// Pre-frame the entire Two-Bedroom House cleanly in a crisp 3/4 architectural overview before frame 1
const initCanvasCenter = await page.evaluate(() => {
  const c = Array.from(document.querySelectorAll('canvas')).find((x) => x.getBoundingClientRect().width > 300)
  const r = c?.getBoundingClientRect()
  return r ? { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } : { cx: 920, cy: 420 }
})
await page.mouse.move(initCanvasCenter.cx, initCanvasCenter.cy)
await page.mouse.wheel({ deltaY: 65 })
await new Promise((r) => setTimeout(r, 180))
await page.mouse.down({ button: 'right' })
for (let i = 1; i <= 5; i++) {
  await page.mouse.move(initCanvasCenter.cx + i * 24, initCanvasCenter.cy + i * 14)
  await new Promise((r) => setTimeout(r, 60))
}
await page.mouse.up({ button: 'right' })
await new Promise((r) => setTimeout(r, 900))

const ffmpeg = Bun.spawn(
  [
    ffmpegBin,
    '-y',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-r',
    String(CAPTURE_FPS),
    '-i',
    '-',
    '-vf',
    'scale=1280:720:flags=lanczos',
    '-r',
    '24',
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

let totalFrames = 0
let lastKeyframe = 0

async function setBanner(text: string) {
  await page.evaluate((txt: string) => {
    const el = document.getElementById('__walkthrough_banner')
    if (el) el.textContent = txt
  }, text)
}

async function moveCursor(x: number, y: number) {
  await page.evaluate(
    ([cx, cy]: [number, number]) => {
      const el = document.getElementById('__walkthrough_cursor')
      if (el) {
        el.style.left = `${cx}px`
        el.style.top = `${cy}px`
      }
    },
    [x, y],
  )
}

async function pulseCursor(active: boolean) {
  await page.evaluate((on: boolean) => {
    const el = document.getElementById('__walkthrough_cursor')
    if (el) el.style.transform = on ? 'scale(1.55)' : 'scale(1)'
  }, active)
}

async function captureCleanShot(mediaFilename: string, repoAssetFilename?: string) {
  if (!mediaShotsDir && (!refreshRepoShots || !repoAssetFilename)) return
  await page.evaluate(() => {
    const b = document.getElementById('__walkthrough_banner')
    const c = document.getElementById('__walkthrough_cursor')
    if (b) b.style.display = 'none'
    if (c) c.style.display = 'none'
  })
  await new Promise((r) => setTimeout(r, 120))
  const png = await page.screenshot({ type: 'png' })
  if (mediaShotsDir) {
    fs.writeFileSync(path.join(mediaShotsDir, mediaFilename), png)
  }
  if (refreshRepoShots && repoAssetFilename) {
    fs.writeFileSync(path.join(rootDir, 'assets', repoAssetFilename), png)
  }
  await page.evaluate(() => {
    const b = document.getElementById('__walkthrough_banner')
    const c = document.getElementById('__walkthrough_cursor')
    if (b) b.style.display = ''
    if (c) c.style.display = ''
  })
}

async function captureFrames(
  count: number,
  delayMs = 90,
  saveKeyframeName?: string,
  staticHold = false,
) {
  if (staticHold && count > 2) {
    // Capture 2 live frames so React + WebGL settle, then hold the settled frame cleanly
    let lastJpeg: Uint8Array | null = null
    for (let i = 0; i < 2; i++) {
      lastJpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
      ffmpeg.stdin.write(lastJpeg)
      totalFrames += 1
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }
    if (lastJpeg) {
      if (saveKeyframeName) {
        fs.writeFileSync(path.join(keyframesDir, `${saveKeyframeName}.jpg`), lastJpeg)
        lastKeyframe += 1
      }
      for (let i = 2; i < count; i++) {
        ffmpeg.stdin.write(lastJpeg)
        totalFrames += 1
      }
    }
    return
  }

  for (let i = 0; i < count; i++) {
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
    ffmpeg.stdin.write(jpeg)
    totalFrames += 1
    if (saveKeyframeName && i === Math.floor(count / 2)) {
      const kfPath = path.join(keyframesDir, `${saveKeyframeName}.jpg`)
      fs.writeFileSync(kfPath, jpeg)
      lastKeyframe += 1
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }
}

async function findButtonRect(needle: string, exact = false): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ([txt, isExact]: [string, boolean]) => {
      const btns = Array.from(document.querySelectorAll('button'))
      const match = btns.find((b) => {
        const r = b.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const label = b.innerText.trim()
        const aria = b.getAttribute('aria-label') ?? ''
        if (isExact) return label === txt || aria === txt
        return label.includes(txt) || aria.includes(txt)
      })
      if (!match) return null
      match.scrollIntoView({ block: 'nearest' })
      const r = match.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    },
    [needle, exact],
  )
}

async function smoothClickButton(needle: string, exact = false, holdBefore = 6, holdAfter = 14, kf?: string) {
  const rect = await findButtonRect(needle, exact)
  if (!rect) {
    console.warn(`Button not found: "${needle}"`)
    return false
  }
  await moveCursor(rect.x, rect.y)
  await captureFrames(holdBefore, 80, undefined, true)
  await pulseCursor(true)
  await page.mouse.click(rect.x, rect.y)
  await captureFrames(3, 80)
  await pulseCursor(false)
  await captureFrames(holdAfter, 90, kf, true)
  return true
}

async function dragOrbit(
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  steps: number,
  button: 'left' | 'right' = 'right',
  kf?: string,
) {
  await page.mouse.move(startX, startY)
  await moveCursor(startX, startY)
  await page.mouse.down({ button })
  for (let i = 1; i <= steps; i++) {
    const nx = Math.round(startX + (dx * i) / steps)
    const ny = Math.round(startY + (dy * i) / steps)
    await page.mouse.move(nx, ny)
    await moveCursor(nx, ny)
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
    ffmpeg.stdin.write(jpeg)
    totalFrames += 1
    if (kf && i === Math.floor(steps / 2)) {
      fs.writeFileSync(path.join(keyframesDir, `${kf}.jpg`), jpeg)
    }
    await new Promise((r) => setTimeout(r, 70))
  }
  await page.mouse.up({ button })
}

// ─── CHAPTER 1: Real Pascal Two-Bedroom Demo + One-Click NEC Auto-Populate ──
console.log('Recording Chapter 1: NEC Minimum Auto-Populate in Pascal Editor...')
await setBanner('1 / 5 · Pascal Editor Built-In Two-Bedroom House · Ready for NEC Auto-Populate')
await captureFrames(18, 90, '01_before_autopop', true)

await setBanner('1 / 5 · One-Click NEC Minimum Auto-Populate (Wall-Snapped Outlets, Switches & Manhattan Runs)')
await smoothClickButton('Auto-Populate NEC Layout', false, 6, 26, '02_after_autopop')

// Demonstrate adding an outlet: snaps flush to wall & joins existing room circuit run automatically!
await setBanner('1 / 5 · Add Outlet -> Snaps to Wall & Auto-Joins Existing Room Circuit Run')
await smoothClickButton('+ Receptacle', true, 5, 16, '02b_add_outlet')

// Demonstrate 1-click Catalog Equipment placement (52" Ceiling Fan w/ LED Kit -> centers in room & joins lighting!)
await setBanner('1 / 5 · 50-Model CAD Catalog -> 1-Click Place 52" Ceiling Fan w/ LED Kit')
await page.evaluate(() => {
  const sel = document.querySelector<HTMLSelectElement>('select[aria-label="Catalog Equipment Model"]')
  if (sel) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(sel, 'ceiling-fan')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
})
await smoothClickButton('+ Place', true, 4, 16, '02c_place_catalog_fan')

// ─── CHAPTER 2: Low Walls + Extended Multi-Angle Color-Coded X-Ray Circuits + 2D Blueprint ──
console.log('Recording Chapter 2: Low Walls, Extended X-Ray Color-Coded Circuits & 2D Floorplan...')
await setBanner('2 / 5 · Full Walls: Concealed Stud-Snapped Wiring & Flush Faceplates (Bones 16" OC · NEC PASS)')
await captureFrames(12, 90, '03a_full_walls', true)

await setBanner('2 / 5 · Pascal Native Low Walls Mode: Inspect Color-Coded Circuits Inside Wall Centerlines')
await smoothClickButton('Low Walls', true, 5, 18, '03_orbit_3d')
await dragOrbit(initCanvasCenter.cx + 40, initCanvasCenter.cy, -120, -15, 10, 'right', '03b_low_walls_orbit')
await captureCleanShot('02-pascal-inwall-low-walls.png', 'demo-3d-trade-routing.png')

await setBanner('2 / 5 · Pascal Native X-Ray Wiring Mode: Every Color-Coded Circuit Isolated in 3D')
await smoothClickButton('X-Ray Wiring', true, 5, 22, '03c_xray_wiring')
await captureCleanShot('03-pascal-xray-wiring.png')

// Extended X-Ray Showcase: zoom gently into the full wired house & perform a smooth multi-angle 3D orbit
await page.mouse.move(initCanvasCenter.cx, initCanvasCenter.cy)
await moveCursor(initCanvasCenter.cx, initCanvasCenter.cy)
for (let i = 0; i < 2; i++) {
  await page.mouse.wheel({ deltaY: -85 })
  await captureFrames(3, 80)
}
await setBanner('2 / 5 · X-Ray 3D Orbit: Trace Every Circuit (CKT-1..CKT-9), Stud Box & Home Run to MDP-1')
await dragOrbit(initCanvasCenter.cx - 80, initCanvasCenter.cy + 10, 220, -20, 18, 'right', '03d_xray_orbit_1')
await captureFrames(12, 90, undefined, true)
await dragOrbit(initCanvasCenter.cx + 120, initCanvasCenter.cy - 10, -160, 25, 14, 'right', '03e_xray_orbit_2')
await captureFrames(10, 90, undefined, true)

// Brief 2D Blueprint peek showing exact color-matched 2D electrical schematic symbols & circuit runs
await setBanner('2 / 5 · Live Color-Matched 2D Electrical Floorplan Schematic')
await smoothClickButton('2D', true, 4, 20, '03f_2d_blueprint')
await smoothClickButton('3D', true, 3, 10)
await smoothClickButton('Full Walls', true, 4, 8)

// ─── CHAPTER 3: Zoom-In Cover-Off 3D Panel Interior Wiring View ─────────────
console.log('Recording Chapter 3: Cover-Off 3D Panel Interior Wiring View...')
await setBanner('3 / 5 · Opening Cover-Off 3D Panel Interior View (Live Busbars, Breakers & Individual Wires)')
await smoothClickButton('Inspect Panel Wiring', false, 6, 16)

// Collapse left navigation menu so the 3D house + Cover-Off 3D Panel Interior get full widescreen space
const hideBtn = await findButtonRect('Hide menu', true)
if (hideBtn) {
  await page.mouse.click(hideBtn.x, hideBtn.y)
  await new Promise((r) => setTimeout(r, 500))
}
const closeRailBtn = await findButtonRect('Close panel', true)
if (closeRailBtn) {
  await page.mouse.click(closeRailBtn.x, closeRailBtn.y)
  await new Promise((r) => setTimeout(r, 700))
}
await moveCursor(-40, -40)
await captureFrames(18, 90, '04_panel_breakers_zoom', true)

// Click Full Open Panel, then Zoom: Breakers & Lugs, then orbit the live 3D open panel canvas!
await setBanner('3 / 5 · Cover-Off 3D Panel Interior · Full Open Panel & Copper Busbars')
await smoothClickButton('Full Open Panel', true, 5, 16, '04b_panel_full')
await captureCleanShot('05a-pascal-panel-cover-off-split.png')

await setBanner('3 / 5 · Extreme Zoom: Individual 90°-Bent Wires Landed on Circuit Breakers & Brass Lugs')
await smoothClickButton('Zoom: Breakers & Lugs', true, 5, 12)

// Find the live 3D Panel Interior canvas on the right split pane and drag-orbit it!
const panelCanvasRect = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'))
  const rightMost = canvases
    .map((c) => c.getBoundingClientRect())
    .filter((r) => r.width > 200 && r.height > 200)
    .sort((a, b) => b.x - a.x)[0]
  return rightMost
    ? { x: Math.round(rightMost.x + rightMost.width / 2), y: Math.round(rightMost.y + rightMost.height / 2) }
    : null
})
if (panelCanvasRect) {
  await dragOrbit(panelCanvasRect.x - 40, panelCanvasRect.y, 110, -25, 12, 'left', '05_panel_orbit')
}

await setBanner('3 / 5 · Panel Cover On: Flush ANSI-61 Steel Cover, NEMA Nameplate, NEC 110.16 Placard & Spare Blanks')
await smoothClickButton('Full Open Panel', true, 3, 6)
await smoothClickButton('Panel Cover On', true, 4, 18, '05b_panel_cover_on')
await captureCleanShot('05-pascal-panel-cover-on-split.png')
await smoothClickButton('Cover Off (Wired)', true, 4, 12)

// ─── CHAPTER 4: Live Panelboard Schedule & NEC 220 Load Calculation ─────────
console.log('Recording Chapter 4: Panel Schedule & NEC 220 Load Calc...')
await setBanner('4 / 5 · Live Split-Phase Panelboard Schedule (Odd/Even L1/L2, Wire Gauges & Phase Balance)')
await smoothClickButton('Panel Schedule', true, 5, 24, '06_panel_schedule')
await captureCleanShot('06-pascal-panel-schedule.png', 'demo-panel-schedule.png')

await setBanner('4 / 5 · Deterministic NEC Article 220 Service Load Calculation (Standard & Optional 220.82)')
await smoothClickButton('NEC 220 Load Calc', true, 5, 20)

// ─── CHAPTER 5: Live Priced BOM Calculator & NEC Audit ──────────────────────
console.log('Recording Chapter 5: Live Priced BOM Calculator & NEC Audit...')
await setBanner('5 / 5 · Material Takeoff & Live Price Calculator (Updating Labor $/hr, Markup % & Tax %)')
await smoothClickButton('Takeoff & Cost', true, 5, 14)

// Live-edit Labor Rate, Markup, and Tax inputs so viewers see real recalculation in Pascal Editor!
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'))
  const setReactVal = (el: HTMLInputElement | undefined, val: string) => {
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (inputs.length >= 3) {
    setReactVal(inputs[0], '95')
    setReactVal(inputs[1], '15')
    setReactVal(inputs[2], '8.25')
  }
})
await moveCursor(-40, -40)
await captureFrames(24, 90, '07_takeoff_cost', true)
await captureCleanShot('07-pascal-bom-takeoff.png')

await setBanner('5 / 5 · Live NEC Compliance Audit: 0 Errors, 0 Warnings (NEC PASS)')
await smoothClickButton('NEC Audit', false, 5, 22, '08_nec_audit')
await captureCleanShot('08-pascal-nec-audit.png')

// Finish encoding
ffmpeg.stdin.end()
const mp4Code = await ffmpeg.exited
await browser.close()

if (mp4Code !== 0 || !fs.existsSync(outMp4)) {
  console.error('FFmpeg MP4 encode failed:', await new Response(ffmpeg.stderr).text())
  process.exit(1)
}
console.log(
  `Encoded REAL Pascal Editor walkthrough MP4: ${outMp4} (${Math.round(fs.statSync(outMp4).size / 1024)} KB, ${totalFrames} captured frames)`,
)

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
console.log(`Encoded REAL Pascal Editor GIF: ${outGif} (${Math.round(fs.statSync(outGif).size / 1024)} KB)`)
