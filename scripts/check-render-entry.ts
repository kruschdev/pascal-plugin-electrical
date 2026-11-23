/**
 * Entry boundary gate matching pascalorg/plugin-trees & DECISIONS.md E-001/E-016:
 * 1. `./render` must bundle with ZERO imports from `@pascal-app/editor` or `next`.
 * 2. `./agent-tools` must bundle with ZERO imports from `three`, `react`, `@pascal-app/viewer`, or `@pascal-app/editor`.
 * 3. `./nec` must bundle with ZERO imports from `three`, `react`, `@pascal-app/*`, or `next`.
 * 4. Negative probe: `.` (root entry) MUST reach `@pascal-app/editor` so the gate cannot silently pass blind.
 */
import { fileURLToPath } from 'node:url'
import type { BunPlugin } from 'bun'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = await Bun.file(`${root}package.json`).json()

type Hit = { specifier: string; importer: string }

async function checkForbidden(entry: string, pattern: RegExp): Promise<Hit[]> {
  const hits: Hit[] = []
  const gate: BunPlugin = {
    name: 'entry-boundary-gate',
    setup(build) {
      build.onResolve({ filter: pattern }, (args) => {
        hits.push({
          specifier: args.path,
          importer: args.importer.replace(root, ''),
        })
        return { path: args.path, external: true }
      })
    },
  }

  const result = await Bun.build({
    entrypoints: [`${root}${entry.replace(/^\.\//, '')}`],
    target: 'browser',
    format: 'esm',
    splitting: true,
    external: ['react', 'react-dom', 'three', 'zod', 'zustand', '@pascal-app/*'],
    plugins: [gate],
    throw: false,
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Bundling ${entry} failed`)
  }
  return hits
}

const renderEntry = pkg.exports['./render'].default as string
const agentToolsEntry = pkg.exports['./agent-tools'].default as string
const necEntry = pkg.exports['./nec'].default as string
const rootEntry = pkg.exports['.'].default as string

const renderHits = await checkForbidden(renderEntry, /^(@pascal-app\/editor|next)(\/|$)/)
if (renderHits.length > 0) {
  console.error(`./render (${renderEntry}) reaches editor-only modules:`)
  for (const hit of renderHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
  process.exit(1)
}

const agentToolsHits = await checkForbidden(
  agentToolsEntry,
  /^(three|react|react-dom|@pascal-app\/viewer|@pascal-app\/editor|next)(\/|$)/,
)
if (agentToolsHits.length > 0) {
  console.error(`./agent-tools (${agentToolsEntry}) violates Zod-only contract purity:`)
  for (const hit of agentToolsHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
  process.exit(1)
}

const necHits = await checkForbidden(
  necEntry,
  /^(three|react|react-dom|@pascal-app\/|next)(\/|$)/,
)
if (necHits.length > 0) {
  console.error(`./nec (${necEntry}) must remain pure framework-free TypeScript:`)
  for (const hit of necHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
  process.exit(1)
}

const probeHits = await checkForbidden(rootEntry, /^(@pascal-app\/editor|next)(\/|$)/)
if (!probeHits.some((hit) => hit.specifier.startsWith('@pascal-app/editor'))) {
  console.error(`Negative probe failed: root entry (${rootEntry}) should reach @pascal-app/editor`)
  process.exit(1)
}

console.log(
  `Entry boundary gates PASSED: ./render editor-free, ./agent-tools Zod-pure, ./nec framework-free (negative probe caught ${probeHits.length} editor import(s) from root).`,
)
