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

// Package entrypoints must point directly at tracked TypeScript sources so GitHub SHA installs
// work without a dist/ directory or install-time build scripts.
const forbiddenLifecycleHooks = ['prepare', 'postinstall', 'prepack']
for (const hook of forbiddenLifecycleHooks) {
  if (pkg.scripts && hook in pkg.scripts) {
    console.error(`package.json must not define "${hook}" lifecycle script (breaks git installs without devDependencies).`)
    process.exit(1)
  }
}
for (const [label, target] of [
  ['main', pkg.main],
  ['types', pkg.types],
  ...Object.entries(pkg.exports ?? {}).map(([k, v]) => [`exports["${k}"]`, v]),
]) {
  if (typeof target !== 'string') {
    console.error(`package.json ${label} must be a direct source path string, got: ${JSON.stringify(target)}`)
    process.exit(1)
  }
  if (label !== 'exports["./package.json"]' && !target.startsWith('./src/')) {
    console.error(`package.json ${label} must point under ./src/, got: ${target}`)
    process.exit(1)
  }
  const absTarget = `${root}${target.replace(/^\.\//, '')}`
  if (!(await Bun.file(absTarget).exists())) {
    console.error(`package.json ${label} points to missing file: ${target}`)
    process.exit(1)
  }
}
const { electricalAgentTools } = await import(`${root}src/agent-tools.ts`)
if (electricalAgentTools.version !== pkg.version) {
  console.error(
    `Version mismatch: src/agent-tools.ts has "${electricalAgentTools.version}" but package.json has "${pkg.version}".`,
  )
  process.exit(1)
}
const indexSrc = await Bun.file(`${root}src/index.ts`).text()
if (/^\s*(?:import|export)\s+[^;\n]*['"]\.\/ui\//m.test(indexSrc)) {
  console.error('src/index.ts must not statically import/re-export ./ui/* modules (breaks Next.js RSC boundaries).')
  process.exit(1)
}

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

const renderEntry = 'src/render.ts'
const cadEntry = 'src/cad/index.ts'
const agentToolsEntry = 'src/agent-tools.ts'
const agentOperationsEntry = 'src/agent-operations.ts'
const necEntry = 'src/nec/index.ts'
const rootEntry = 'src/index.ts'

const renderHits = await checkForbidden(renderEntry, /^(@pascal-app\/editor|next)(\/|$)/)
if (renderHits.length > 0) {
  console.error(`./render (${renderEntry}) reaches editor-only modules:`)
  for (const hit of renderHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
  process.exit(1)
}

const cadHits = await checkForbidden(cadEntry, /^(react|react-dom|@pascal-app\/editor|next)(\/|$)/)
if (cadHits.length > 0) {
  console.error(`./cad (${cadEntry}) must remain editor-free & React-free:`)
  for (const hit of cadHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
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

const agentOperationsHits = await checkForbidden(
  agentOperationsEntry,
  /^(three|react|react-dom|@pascal-app\/viewer|@pascal-app\/editor|next)(\/|$)/,
)
if (agentOperationsHits.length > 0) {
  console.error(`./agent-operations (${agentOperationsEntry}) violates headless MCP/runtime purity:`)
  for (const hit of agentOperationsHits) console.error(`  ${hit.importer} -> ${hit.specifier}`)
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
  `Entry boundary gates PASSED (5/5): ./render editor-free, ./cad editor-free, ./agent-tools Zod-pure, ./agent-operations headless-pure, ./nec framework-free (negative probe caught ${probeHits.length} editor import(s) from root).`,
)
