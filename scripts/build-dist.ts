/**
 * Local & CI verification build of compiled ESM bundles + `.d.ts` declarations (`dist/`) for all 6
 * subpath exports with production JSX (`react/jsx-runtime`). Published npm and pinned GitHub SHA
 * installs resolve directly to TypeScript sources (`./src/*.ts`) so Pascal hosts compile natively.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const distDir = path.join(rootDir, 'dist')

// Ensure Bun.build emits production JSX (`react/jsx-runtime` / `jsx`), never `react/jsx-dev-runtime` (`jsxDEV`).
process.env.NODE_ENV = 'production'

fs.rmSync(distDir, { recursive: true, force: true })

const entrypoints = [
  'src/index.ts',
  'src/render.ts',
  'src/nec/index.ts',
  'src/cad/index.ts',
  'src/agent-tools.ts',
  'src/agent-operations.ts',
].map((p) => path.join(rootDir, p))

const result = await Bun.build({
  entrypoints,
  root: path.join(rootDir, 'src'),
  outdir: distDir,
  target: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'three',
    'zod',
    'zustand',
    '@pascal-app/*',
  ],
  throw: false,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Guard against regressions back into development JSX runtime (`jsxDEV` throws in production React)
// and hoist any mid-file `"use client";` directives emitted by Bun.build code-splitting to line 1
// so Next.js 16 Turbopack never rejects split chunks.
for (const output of result.outputs) {
  if (!output.path.endsWith('.js')) continue
  let contents = await Bun.file(output.path).text()
  if (contents.includes('react/jsx-dev-runtime') || /\bjsxDEV\b/.test(contents)) {
    console.error(
      `Production JSX guard failed: ${path.relative(rootDir, output.path)} references react/jsx-dev-runtime or jsxDEV.`,
    )
    process.exit(1)
  }
  const directiveRe = /^[ \t]*['"]use client['"];?[ \t]*\r?\n?/gm
  if (directiveRe.test(contents)) {
    const stripped = contents.replace(directiveRe, '')
    contents = `"use client";\n${stripped}`
    fs.writeFileSync(output.path, contents, 'utf8')
  }
}

// Emit strict .d.ts type declarations alongside compiled ESM bundles
const tscProc = Bun.spawnSync(
  [path.join(rootDir, 'node_modules', '.bin', 'tsc'), '-p', path.join(rootDir, 'tsconfig.build.json')],
  { cwd: rootDir, stdout: 'inherit', stderr: 'inherit' },
)
if (tscProc.exitCode !== 0) {
  process.exit(tscProc.exitCode ?? 1)
}

console.log(`Built ${result.outputs.length} ESM output(s) + .d.ts declarations into dist/.`)
