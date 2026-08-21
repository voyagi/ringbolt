#!/usr/bin/env node
// a11y-prove.mjs - proves the live accessibility gate actually FAILS on the
// defects it claims to catch.
//
// A gate that only ever passes is indistinguishable from a gate that checks
// nothing. This is the Workshop's P1 discipline (every gate demonstrated
// failing) applied to accessibility, and it is not theoretical: on launch-kiln
// a static a11y pass was green while five real WCAG defects shipped to
// production. The green meant nothing, and nobody could tell.
//
// Each case reintroduces one real defect into the BUILT output, runs the gate,
// and expects a non-zero exit AND the specific rule id in the output. Checking
// the rule id matters as much as the exit code: a case that fails for an
// unrelated reason would otherwise read as proof.
//
// The build is redone before and after every case, so the working tree is never
// left dirty.
//
// NOT part of verify:ship: it rebuilds once per case, so it is an on-demand
// proof ("npm run a11y:prove"). Run it when the gate is first wired, and again
// whenever the gate or the design system changes.
//
// WIRING
//
//   copy to the product repo (scripts/a11y-prove.mjs)
//   "a11y:prove": "node scripts/a11y-prove.mjs"
//   adapt BUILD_CMD / GATE_CMD below, then write real CASES
//
// WRITING CASES - the part that carries the value
//
// Do NOT invent plausible defects. Use the ones this product actually shipped
// or nearly shipped, one case per class the gate claims to cover. Seed the list
// from the first live Lighthouse or axe run after deploy: every defect it finds
// that the gate missed is, by definition, a case the gate needs. The launch-kiln
// set covered five classes worth stealing as a template:
//
//   1. a contrast failure in the NON-default theme only
//   2. an aria-label overriding visible text (WCAG 2.5.3, an experimental axe
//      rule that a tag filter alone silently skips)
//   3. an aria-label on an element whose role prohibits it
//   4. a defect axe reports ONLY as "incomplete", never as a violation, which
//      proves undetermined results still fail
//   5. a decorative overlay painted over a control, which a contrast reading
//      alone cannot catch because the dominant colour stays the declared one
//
// An empty CASES list is a FAILURE here, not a pass. A proof harness that
// proves nothing is worse than none, because it looks like coverage.

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// ===========================================================================
// CONFIG - edit for the product
// ===========================================================================

const BUILD_CMD = 'npm run build'
const GATE_CMD = 'node scripts/a11y-live.mjs'
const DIST = join(process.cwd(), 'dist')

// One entry per defect class the gate claims to catch. `from` must be an exact
// substring of the built file; `expectRule` must be the id the gate prints.
const CASES = [
  // {
  //   name: 'dark theme primary button drops below the AA contrast floor',
  //   file: join(DIST, 'assets', 'app.css'),
  //   from: "[data-theme='dark'] .button.primary {\n  color: var(--paper);\n}",
  //   to: "[data-theme='dark'] .button.primary {\n  color: oklch(98% 0.014 84);\n}",
  //   expectRule: 'painted-contrast',
  // },
]

// ===========================================================================
// END CONFIG
// ===========================================================================

function build() {
  const result = spawnSync(BUILD_CMD, { shell: true, stdio: 'ignore' })
  if (result.status !== 0) throw new Error(`"${BUILD_CMD}" failed, cannot continue`)
}

function runGate() {
  const result = spawnSync(GATE_CMD, { shell: true, encoding: 'utf8' })
  return { code: result.status, output: (result.stdout || '') + (result.stderr || '') }
}

let problems = 0

if (CASES.length === 0) {
  console.error('No cases defined. This harness proves nothing until it holds real defects.')
  console.error('Seed it from the first live Lighthouse or axe run after deploy: see the header.')
  process.exit(2)
}

build()
const baseline = runGate()
if (baseline.code === 0) {
  console.log('BASELINE  clean tree passes (correct)')
} else {
  console.error('BASELINE  clean tree FAILS - fix the real violations before trusting this proof')
  console.error(baseline.output)
  problems++
}

for (const testCase of CASES) {
  build()
  const original = readFileSync(testCase.file, 'utf8')
  // Built output carries the platform's line endings, so an anchor authored
  // with \n will not match on Windows. Normalize instead of hand-encoding.
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const from = testCase.from.replace(/\n/g, eol)
  const to = testCase.to.replace(/\n/g, eol)

  if (!original.includes(from)) {
    // A silently non-applied mutation would look like a pass, which is the
    // exact failure mode this script exists to prevent.
    console.error(`SKIPPED   ${testCase.name}: anchor not found, mutation never applied`)
    problems++
    continue
  }

  writeFileSync(testCase.file, original.replace(from, to))
  const result = runGate()
  const named = result.output.includes(testCase.expectRule)

  if (result.code !== 0 && named) {
    console.log(`CAUGHT    ${testCase.name} (${testCase.expectRule})`)
  } else {
    console.error(`MISSED    ${testCase.name}: exit ${result.code}, reported ${testCase.expectRule} = ${named}`)
    problems++
  }
}

build()
const restored = runGate()
if (restored.code !== 0) {
  console.error('RESTORED  the built output still fails after a rebuild - the tree may be dirty')
  problems++
}

if (problems > 0) {
  console.error(`\na11y gate proof FAILED: ${problems} problem(s)`)
  process.exit(1)
}
console.log(`\na11y gate proof passed: catches all ${CASES.length} known defects, clean tree stays green`)
