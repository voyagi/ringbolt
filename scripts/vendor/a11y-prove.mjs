#!/usr/bin/env node
// a11y-prove.mjs - proves the live accessibility gate actually FAILS on the
// defects it claims to catch.
//
// A gate that only ever passes is indistinguishable from a gate that checks
// nothing, so every gate here has to be watched failing at least once. That is
// not theoretical: a static accessibility pass on an earlier project of ours
// was green while five real WCAG defects shipped to production. The green meant
// nothing, and nobody could tell.
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
// WRITING CASES - the part that carries the value
//
// Do NOT invent plausible defects. Use the ones this product actually shipped
// or nearly shipped, one case per class the gate claims to cover. Seed the list
// from the first live Lighthouse or axe run after deploy: every defect it finds
// that the gate missed is, by definition, a case the gate needs. These five
// classes are the ones that have caught real regressions here:
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
// CONFIG
// ===========================================================================

const BUILD_CMD = 'npm run build'
const GATE_CMD = 'node scripts/vendor/a11y-live.mjs'
const DIST = join(process.cwd(), 'dist', 'client')
const CSS = join(DIST, 'assets', 'index.css')
const JS = join(DIST, 'assets', 'index.js')

// One entry per defect class the gate claims to catch. `from` must be an exact
// substring of the built file; `expectRule` must be the id the gate prints.
//
// EVERY CASE BELOW IS A DEFECT THIS PRODUCT ACTUALLY HAD. The first live run of
// the gate, on 2026-08-24, reported 30 violations and 14 undetermined results
// across the dashboard as first written. These five are one per class it found,
// each restored into the built output by putting the broken value back. Nothing
// here is a plausible-sounding defect somebody invented to give the harness
// something to catch.
//
// The anchors are minified output rather than source, which is the point: this
// proves the gate on the bytes that ship. They move when the build output moves,
// and a moved anchor is reported as SKIPPED and fails the run, never as a pass.
const CASES = [
  {
    // The primary button was white on the night red: 3.41 to one against a
    // floor of 4.5. Fixed by giving the ink its own token per theme.
    name: 'the night theme primary button goes back to white ink on red',
    file: CSS,
    from: '--on-live:#0d1420}',
    to: '--on-live:#fff}',
    expectRule: 'painted-contrast',
  },
  {
    // At one column the deck used to keep its pinned height and scroll the
    // cluster, so each section's content spilled outside its own painted
    // background and eleven elements ended up reading on the dividing colour
    // instead of on the deck. The whole media block goes back, because the
    // defect was the combination rather than any one declaration in it.
    name: 'the one-column deck spills its content off its own background again',
    file: CSS,
    from: '@media (width<=78rem){.shell.pinned{height:auto;overflow:visible}.cluster{grid-template-columns:1fr}.cluster>section{min-height:auto;overflow:visible}}',
    to: '@media (width<=78rem){.cluster{grid-template-columns:1fr;overflow:auto}.cluster>section{overflow:visible}}',
    expectRule: 'color-contrast',
  },
  {
    // The intake example carried an aria-label on a bare pre, which has no role
    // to hang it on. axe reports this only as UNDETERMINED, never as a
    // violation, so this case also proves undetermined results still fail.
    name: 'the intake example loses the role its aria-label needs',
    file: JS,
    from: 'role:`region`,tabIndex:0,"aria-label":`An example intake request`',
    to: 'tabIndex:0,"aria-label":`An example intake request`',
    expectRule: 'aria-prohibited-attr',
  },
  {
    // The sharpest case. The gauge readout lies over the dial's SVG, so axe
    // gives up on it and the accepted-incomplete list waves it through. Only
    // the painted-pixel measurement can catch a contrast failure there, and if
    // PAINTED_SELECTOR ever stops covering the readout, this case goes red.
    name: 'the dial readout is coloured into the deck, where axe cannot judge it',
    file: CSS,
    from: '.gauge .readout .under{font-size:var(--step-small);color:var(--dim)}',
    to: '.gauge .readout .under{font-size:var(--step-small);color:#0f1826}',
    expectRule: 'painted-contrast',
  },
  {
    // A decorative overlay over a control. Nothing in the CSS changes what the
    // button DECLARES, so every computed-style reading stays comfortable while
    // the painted pixels drift. Only a screenshot finds this.
    name: 'a decorative overlay is painted across every control',
    file: CSS,
    from: '.btn:hover:not(:disabled){border-color:var(--dim)}',
    to: '.btn{position:relative}.btn:after{content:"";position:absolute;inset:0;background:#ffffff40}.btn:hover:not(:disabled){border-color:var(--dim)}',
    expectRule: 'painted-overlay-drift',
  },
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
