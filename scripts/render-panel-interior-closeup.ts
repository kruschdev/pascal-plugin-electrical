/**
 * Renders a high-resolution 3-panel close-up showcase (`assets/demo-panel-wired-interior.png`)
 * of the Cover-Off Wired Panel Interior CAD models (Full 200A Residential, Zoomed Breakers & Lugs,
 * and 400A 277/480V 3-Phase Commercial Brown/Orange/Yellow wiring) via Three.js GLTFLoader in Chrome.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cadDir = path.join(rootDir, 'assets', 'cad')
const outImg = path.join(rootDir, 'assets', 'demo-panel-wired-interior.png')

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #0b1220;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, sans-serif;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(148,163,184,0.22);
  }
  h1 { margin: 0; font-size: 19px; }
  .sub { font-size: 12px; color: #94a3b8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .panel {
    background: #111c32;
    border: 1px solid rgba(148,163,184,0.25);
    border-radius: 12px;
    overflow: hidden;
  }
  img { width: 100%; height: 640px; object-fit: cover; display: block; background: #0b1220; }
  .cap { padding: 10px 14px; }
  .cap strong { display: block; font-size: 13px; color: #f8fafc; margin-bottom: 3px; }
  .cap span { font-size: 11px; color: #94a3b8; }
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
    <h1>Cover-Off Panel Interior 3D View — Live Busbars, Breakers & Individual Branch Conductors</h1>
    <div class="sub">Interactive in Pascal Schedule View ("Panel Interior (3D)") & In-Scene Panel Parameter (coverRemoved = true)</div>
  </header>
  <div id="grid" class="grid"></div>
  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    const shots = [
      {
        slug: 'panel-res-200a-open',
        title: '1. Residential 200A 120/240V (Full Cover Off)',
        sub: 'Black L1 / Red L2 hots, White neutrals, Bare Cu grounds, Main Breaker, & copper bus stabs',
        camOffset: [0.22, 0.04, 1.38],
        targetOffset: [0, 0.0, 0.02],
      },
      {
        slug: 'panel-res-200a-open',
        title: '2. Extreme Zoom: Breakers, Brass Lugs & Gutters',
        sub: 'Every individual branch wire makes a 90° bend from the side gutter straight into its exact breaker terminal',
        camOffset: [0.16, 0.02, 0.56],
        targetOffset: [0.02, -0.04, 0.03],
      },
      {
        slug: 'panel-comm-400a-3p',
        title: '3. Commercial 400A 277/480V 3Φ (Cover Off)',
        sub: '3-bus copper interior, Brown/Orange/Yellow phase feeders & 3-pole motor breakers, Gray neutrals, Green EGC',
        camOffset: [-0.24, 0.04, 1.48],
        targetOffset: [0, 0.02, 0.02],
      },
    ];

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(520, 680);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    const loader = new GLTFLoader();
    const grid = document.getElementById('grid');

    for (const s of shots) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1220);
      scene.add(new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 1.9);
      key.position.set(1.8, 2.5, 3.0);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x93c5fd, 0.85);
      fill.position.set(-2.2, 0.8, 2.0);
      scene.add(fill);

      const gltf = await loader.loadAsync('/cad/' + s.slug + '/model.glb');
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const camera = new THREE.PerspectiveCamera(36, 520 / 680, 0.01, 20);
      const target = new THREE.Vector3(
        center.x + size.x * s.targetOffset[0],
        center.y + size.y * s.targetOffset[1],
        center.z + s.targetOffset[2],
      );
      camera.position.set(
        target.x + s.camOffset[0],
        target.y + s.camOffset[1],
        target.z + s.camOffset[2],
      );
      camera.lookAt(target);
      renderer.render(scene, camera);

      const card = document.createElement('div');
      card.className = 'panel';
      card.innerHTML =
        '<img src="' + renderer.domElement.toDataURL('image/png') + '" />' +
        '<div class="cap"><strong>' + s.title + '</strong><span>' + s.sub + '</span></div>';
      grid.appendChild(card);
    }
    document.title = 'DONE';
  </script>
</body>
</html>`

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

const proc = Bun.spawn(
  [
    '/usr/bin/google-chrome',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--virtual-time-budget=20000',
    '--window-size=1640,800',
    `--screenshot=${outImg}`,
    `http://127.0.0.1:${server.port}/`,
  ],
  { stdout: 'ignore', stderr: 'pipe' },
)

const code = await proc.exited
server.stop(true)
if (code !== 0 || !fs.existsSync(outImg)) {
  console.error('Close-up render failed:', await new Response(proc.stderr).text())
  process.exit(1)
}
console.log(`Rendered panel interior close-up (${Math.round(fs.statSync(outImg).size / 1024)} KB) at ${outImg}`)
