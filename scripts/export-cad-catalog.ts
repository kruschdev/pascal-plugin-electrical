/**
 * Exports all 50 clean-room MIT Electrical Materials CAD models into binary `.glb` files
 * under `assets/cad/<slug>/model.glb` (matching Pascal's `apps/editor/public/items/<slug>/` layout)
 * plus `assets/cad/catalog.json` metadata.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Box3, Scene, Vector3 } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { ELECTRICAL_CAD_CATALOG, measureCadDimensionsMm } from '../src/cad/catalog'

// Minimal FileReader polyfill for Three.js GLTFExporter running in Bun/Node
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null
    onloadend: (() => void) | null = null
    onerror: ((err: unknown) => void) | null = null
    readAsArrayBuffer(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf
          this.onloadend?.()
        })
        .catch((err) => this.onerror?.(err))
    }
    readAsDataURL(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          const b64 = Buffer.from(buf).toString('base64')
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`
          this.onloadend?.()
        })
        .catch((err) => this.onerror?.(err))
    }
  }
  ;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader
}

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outRoot = path.join(rootDir, 'assets', 'cad')
fs.mkdirSync(outRoot, { recursive: true })

const exporter = new GLTFExporter()

function exportGroupToGlb(group: Scene): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (res) => {
        if (res instanceof ArrayBuffer) {
          resolve(Buffer.from(res))
        } else {
          reject(new Error('Expected binary ArrayBuffer from GLTFExporter'))
        }
      },
      (err) => reject(err),
      { binary: true },
    )
  })
}

const manifest: Array<{
  slug: string
  name: string
  category: string
  necRef: string
  description: string
  dimensionsMm: [number, number, number]
  glbBytes: number
  modelPath: string
  thumbnailPath: string
}> = []

for (const entry of ELECTRICAL_CAD_CATALOG) {
  const part = entry.build()
  // Center horizontally & rest bottom on y = 0 for clean Pascal item placement
  const box = new Box3().setFromObject(part)
  const center = new Vector3()
  box.getCenter(center)
  part.position.set(-center.x, -box.min.y, -center.z)

  const scene = new Scene()
  scene.name = entry.slug
  scene.add(part)

  const dimsMm = measureCadDimensionsMm(scene as unknown as ReturnType<typeof entry.build>)
  const glb = await exportGroupToGlb(scene)

  const slugDir = path.join(outRoot, entry.slug)
  fs.mkdirSync(slugDir, { recursive: true })
  fs.writeFileSync(path.join(slugDir, 'model.glb'), glb)

  manifest.push({
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    necRef: entry.necRef,
    description: entry.description,
    dimensionsMm: dimsMm,
    glbBytes: glb.byteLength,
    modelPath: `./${entry.slug}/model.glb`,
    thumbnailPath: `./${entry.slug}/thumbnail.png`,
  })
}

fs.writeFileSync(
  path.join(outRoot, 'catalog.json'),
  `${JSON.stringify({ version: 1, license: 'MIT', count: manifest.length, items: manifest }, null, 2)}\n`,
)

const totalKb = Math.round(manifest.reduce((s, m) => s + m.glbBytes, 0) / 1024)
console.log(`Exported ${manifest.length} electrical CAD .glb models (${totalKb} KB total) to ${outRoot}`)
