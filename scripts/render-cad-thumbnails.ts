/**
 * Renders a studio-lit 50-item WebGL contact sheet (`assets/cad-material-catalog.png`)
 * by loading every exported `.glb` via Three.js `GLTFLoader` in headless Chrome,
 * proving all 50 GLBs parse & render cleanly in a real browser.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cadDir = path.join(rootDir, 'assets', 'cad')
const catalogPath = path.join(cadDir, 'catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
  items: Array<{
    slug: string
    name: string
    category: string
    necRef: string
    dimensionsMm: [number, number, number]
    glbBytes: number
  }>
}

// Serve static node_modules/three + assets/cad + renderer HTML on ephemeral localhost port
const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #0f172a;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, sans-serif;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 14px;
    border-bottom: 1px solid rgba(148,163,184,0.22);
    padding-bottom: 10px;
  }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  .sub { font-size: 12px; color: #94a3b8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
  }
  .card {
    background: #1e293b;
    border: 1px solid rgba(148,163,184,0.2);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .thumb {
    width: 100%;
    height: 170px;
    background: radial-gradient(circle at 50% 35%, #334155 0%, #0f172a 100%);
    display: block;
  }
  .meta { padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 11px; font-weight: 700; color: #f8fafc; line-height: 1.25; }
  .row { display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; }
  .badge { color: #fbbf24; font-weight: 600; }
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
  <header>
    <h1>@kruschdev/pascal-plugin-electrical: 50 Clean-Room MIT Electrical CAD Models (.glb)</h1>
    <div class="sub">Panels · Solar &amp; ESS · ATS/Gen · Transformers · NEC 314.16 Boxes · Smart Devices · Light Fixtures · Cable Tray &amp; Grounding</div>
  </header>
  <div id="grid" class="grid"></div>
  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    const catalog = await (await fetch('/cad/catalog.json')).json();
    const grid = document.getElementById('grid');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 240);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const loader = new GLTFLoader();
    let rendered = 0;

    for (const item of catalog.items) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.35));
      const key = new THREE.DirectionalLight(0xffffff, 1.8);
      key.position.set(2.5, 4, 3.2);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x93c5fd, 0.75);
      fill.position.set(-3, 1.5, -2);
      scene.add(fill);

      const gltf = await loader.loadAsync('/cad/' + item.slug + '/model.glb');
      const root = gltf.scene;
      scene.add(root);

      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const maxDim = Math.max(size.x, size.y, size.z, 0.05);
      const camera = new THREE.PerspectiveCamera(34, 320 / 240, 0.005, 50);
      const dist = maxDim * 2.1;
      const isCeilingFixture =
        (item.slug.startsWith('fixture-') && !item.slug.includes('wall') && !item.slug.includes('exit')) ||
        item.slug === 'device-smoke-co-alarm'
      const isFloorOrTray = item.slug === 'device-floor-box-brass' || item.slug === 'cable-tray-ladder'
      const camPos = isCeilingFixture
        ? new THREE.Vector3(center.x + dist * 0.75, center.y - dist * 0.45, center.z + dist * 0.8)
        : isFloorOrTray
          ? new THREE.Vector3(center.x + dist * 0.7, center.y + dist * 0.85, center.z + dist * 0.85)
          : new THREE.Vector3(center.x + dist * 0.65, center.y + dist * 0.48, center.z + dist * 0.92)
      camera.position.copy(camPos);
      camera.lookAt(center);

      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL('image/png');

      // Upload individual thumbnail PNG back to local Bun server to persist next to model.glb
      await fetch('/save-thumb/' + item.slug, {
        method: 'POST',
        body: dataUrl,
      });

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<img class="thumb" src="' + dataUrl + '" />' +
        '<div class="meta">' +
          '<div class="title">' + item.name + '</div>' +
          '<div class="row"><span class="badge">' + item.necRef + '</span><span>' + (item.glbBytes / 1024).toFixed(1) + ' KB</span></div>' +
          '<div class="row"><span>' + item.slug + '</span><span>' + item.dimensionsMm.join('x') + 'mm</span></div>' +
        '</div>';
      grid.appendChild(card);
      rendered += 1;
    }

    document.title = 'READY:' + rendered;
    await fetch('/done');
  </script>
</body>
</html>`

let resolveDone: () => void = () => {}
let doneReceived = false
const donePromise = new Promise<void>((r) => {
  resolveDone = r
})
let savedCount = 0

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname.startsWith('/three/')) {
      const rel = url.pathname.slice('/three/'.length)
      const full = path.join(rootDir, 'node_modules', 'three', rel)
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full), {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      }
    }
    if (url.pathname.startsWith('/cad/')) {
      const rel = url.pathname.slice('/cad/'.length)
      const full = path.join(cadDir, rel)
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full))
      }
    }
    if (url.pathname.startsWith('/save-thumb/') && req.method === 'POST') {
      const slug = url.pathname.slice('/save-thumb/'.length).replace(/[^a-z0-9-]/g, '')
      const dataUrl = await req.text()
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      fs.writeFileSync(path.join(cadDir, slug, 'thumbnail.png'), Buffer.from(b64, 'base64'))
      savedCount += 1
      return new Response('ok')
    }
    if (url.pathname === '/done') {
      doneReceived = true
      resolveDone()
      return new Response('ok')
    }
    return new Response('Not found', { status: 404 })
  },
})

const outSheet = path.join(rootDir, 'assets', 'cad-material-catalog.png')
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const chromeArgs = [
  chromeBin,
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--virtual-time-budget=35000',
  '--window-size=1680,2560',
  `--screenshot=${outSheet}`,
  `http://127.0.0.1:${server.port}/`,
]

const proc = Bun.spawn(chromeArgs, {
  stdout: 'ignore',
  stderr: 'pipe',
})
const exitCode = await proc.exited
const stderrText = await new Response(proc.stderr).text()

server.stop(true)
if (exitCode !== 0 || !fs.existsSync(outSheet)) {
  console.error('Chrome render failed:', stderrText)
  process.exit(1)
}

if (doneReceived) {
  await donePromise
}
if (savedCount !== catalog.items.length) {
  throw new Error(
    `Incomplete CAD thumbnail render: saved ${savedCount}/${catalog.items.length} thumbnails (done signal ${doneReceived ? 'received' : 'not received'}).`,
  )
}
console.log(
  `Rendered ${savedCount}/${catalog.items.length} individual thumbnails + contact sheet (${Math.round(fs.statSync(outSheet).size / 1024)} KB) at ${outSheet}`,
)
