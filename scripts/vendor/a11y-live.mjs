#!/usr/bin/env node
// a11y-live.mjs - the LIVE accessibility gate: axe-core in a real browser,
// against the BUILT output, every page in every theme.
//
// WHY THIS EXISTS AS A SEPARATE GATE FROM A STATIC a11y PASS
//
// Born from a real escape on launch-kiln (2026-07-20). That product had a
// static accessibility script: a regex pass over source text. It was green.
// Five real WCAG defects shipped to production anyway, and a live Lighthouse
// run after deploy is what found them. The static pass could not have caught a
// single one, because a source-text pass structurally cannot:
//
//   - resolve CSS custom properties into rendered colours, so it cannot compute
//     a contrast ratio at all
//   - model which ARIA attributes a given role actually permits
//   - compare an accessible name against the visible text of its element
//   - see anything painted ON TOP of an element by a decorative pseudo-element
//
// That last one is the sharpest lesson. A decorative .panel::after overlay was
// lightening a primary button from its declared colour to a painted one,
// dropping real contrast to 4.34:1 while every computed-style reading still
// reported a comfortable 4.8:1. No amount of reading the CSS finds that. Only
// the painted pixels do.
//
// Treat a static a11y script as a fast lint, never as the gate. This is the
// gate.
//
// FOUR PROPERTIES WORTH KEEPING WHEN YOU ADAPT THIS
//
//   1. Every theme, not just the default. The dark theme resolves different
//      colour tokens; on launch-kiln it failed contrast while light passed.
//   2. Populated state, not just the empty page. Boards, summaries and lists
//      that only render once there is data are invisible to a cold-load audit.
//   3. axe "incomplete" means UNDETERMINED, and undetermined is not clean.
//      Swallowing incomplete results silently hid 632 of them on launch-kiln,
//      one of which was a real defect. They fail here unless a documented
//      limitation of axe itself explains them.
//   4. Assert the navigation and the theme actually took hold. A 404 still
//      renders a page that axe is perfectly happy with, so an unchecked
//      navigation lets the gate print "passed" for a page it never audited.
//
// WIRING
//
//   npm i -D @playwright/test axe-core
//   copy this file to the product repo (scripts/a11y-live.mjs)
//   "a11y:live": "node scripts/a11y-live.mjs"
//   add it to verify-ship.mjs AFTER the build step (it audits built output)
//
// Then edit the CONFIG block below, and write the matching a11y-prove.mjs
// cases. A gate nobody has watched fail is not a gate.
//
// Point A11Y_BASE_URL at the product's own preview server when it has one:
// serving the built output under the REAL production headers is strictly
// better than the fallback server here, which serves no headers. axe is
// injected with page.evaluate rather than addScriptTag precisely so a strict
// script-src CSP cannot block it.

import { readFile, stat } from 'node:fs/promises'
import { join, extname, sep } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { chromium } from '@playwright/test'

// ===========================================================================
// CONFIG - edit all of this for the product
// ===========================================================================

const DIST = join(process.cwd(), 'dist')

// Every public route. Each one is asserted to answer 200 before it is audited.
const ROUTES = ['/']

// Every theme the product ships. Use a single-entry array if it has one theme.
const THEMES = ['light', 'dark']

// How a theme is pinned BEFORE the document loads. Pre-applying matters:
// toggling a theme on a live page starts a colour transition, and sampling
// inside it reads new text against an old background, which is a phantom
// failure that reproduces on one machine and not another.
const THEME_ATTRIBUTE = 'data-theme'
const THEME_STORAGE_KEY = '' // e.g. 'my-product-theme'; leave empty to skip

// Elements measured from painted pixels (see checkButtonContrast). Buttons are
// the usual case: they are small, often sit under decorative overlays, and are
// where axe most often gives up. Set to '' to skip that check entirely.
const PAINTED_SELECTOR = '.button'

// Optional: drive the app into a state that only exists after interaction, then
// audit again. Return the label to report it under.
// Example:
//   { label: '/ (data loaded)', route: '/', async setup(page) { ... } }
const POPULATED_STATES = []

// axe rule sets. WCAG 2.0/2.1 A and AA is a conformance claim; axe's
// best-practice set is a moving style opinion, so it is deliberately not here.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// axe SKIPS rules tagged experimental even when their WCAG tag is selected, so
// a tag filter alone silently drops them. label-content-name-mismatch covers
// WCAG 2.5.3 Label in Name, a real launch-kiln defect. Enable explicitly.
const EXPERIMENTAL_RULES = ['label-content-name-mismatch']

// Undetermined results that a documented limitation of axe explains. Everything
// else undetermined FAILS. Keep this list short and justified, and read the
// printed counts every run: this is the gate's residual blind spot, in writing.
const ACCEPTED_INCOMPLETE = [
  { rule: 'color-contrast', match: /background gradient/i, why: 'axe cannot composite a gradient background' },
  { rule: 'color-contrast', match: /pseudo element/i, why: 'axe cannot composite a pseudo-element background' },
]

// ===========================================================================
// END CONFIG
// ===========================================================================

// Auditing more than one theme without a way to pin one is not a partial run,
// it is the same page audited N times while the summary claims N themes were
// covered. That is the false green this file exists to remove, so it is a
// config error rather than a quiet degradation. A product with a class-based
// dark mode should adapt themedPage and auditPage to set and assert the class,
// then this guard can go.
if (THEMES.length > 1 && !THEME_ATTRIBUTE) {
  console.error(`THEMES lists ${THEMES.length} themes but THEME_ATTRIBUTE is empty, so no theme can be pinned or asserted.`)
  console.error('Set THEME_ATTRIBUTE, or reduce THEMES to a single entry, or teach themedPage how this product switches themes.')
  process.exit(2)
}

const require = createRequire(import.meta.url)
let baseUrl = process.env.A11Y_BASE_URL || ''
let paintedVerified = 0
let paintedSkipped = 0
// Every element the selector MATCHED, measurable or not. A selector that
// matches nothing must not read as a clean painted-contrast pass, so this is
// what the run is judged on rather than the count of successful measurements.
let paintedMatched = 0
// Any request that started and did not finish, EXCEPT ones Chromium reports as
// net::ERR_ABORTED, which is what page-initiated cancellation looks like. The
// listener filters on that error NAME, so state the name: measurement shows
// abort() and window.stop() produce it, not that nothing else ever does. Two
// sources: the fallback server
// failing to send a file, or the browser reporting a fetch it could not
// complete (the only source when A11Y_BASE_URL points elsewhere, and it can
// name a third-party asset rather than a local file). Non-empty means the page
// axe looked at was not the page as authored, so the run is not clean.
const serveFailures = []

if (!baseUrl) {
  const distReady = await stat(join(DIST, 'index.html')).catch(() => null)
  if (!distReady?.isFile()) {
    console.error('dist/ is missing. Build first; this gate audits BUILT output, not source.')
    process.exit(1)
  }
}

const axeSource = await readFile(require.resolve('axe-core'), 'utf8')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

// Minimal fallback server. Loopback only, never 0.0.0.0. It serves no headers:
// prefer A11Y_BASE_URL pointed at the product's real preview server when the
// product has one, so the audit runs under production CSP and friends.
function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')

    // Decode before resolving, so a percent-encoded traversal is a real
    // traversal the containment check below can see.
    //
    // Be precise about which forms matter, because the obvious explanation is
    // wrong: the URL parser DOES collapse a bare "%2e%2e" as a dot segment, so
    // /nested/%2e%2e/index.html already resolves to /index.html before this
    // code runs. The form that survives parsing is one with an ENCODED SLASH,
    // "%2e%2e%2f", which the parser does not treat as a separator. Without this
    // decode that arrives as a literal filename, 404s, and the guard below
    // never fires: protection that reads as protection and is not.
    //
    // Malformed encoding is a 400, never a silent pass.
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('bad request')
      return
    }

    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
    if (!extname(relative)) relative += '.html'
    const target = join(DIST, relative)

    // Containment, with the separator on purpose: a bare startsWith(DIST) also
    // accepts a SIBLING whose name merely begins with it, so "<dist>-evil" would
    // read as contained. Compare against the directory boundary instead.
    if (target !== DIST && !target.startsWith(DIST + sep)) {
      response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' })
    const stream = createReadStream(target)
    // Without a handler the process dies on an unhandled 'error' mid-response
    // (a file deleted between the stat and the read, a permission change).
    // But destroying the response quietly is WORSE than crashing for a
    // SUBRESOURCE: the browser drops that request, networkidle still fires, and
    // axe then audits a partly-unrendered page while this gate prints a pass.
    // So it is printed here immediately and recorded, and the run fails: exit 2
    // from the guard after the loop, or a non-zero exit sooner if the same
    // truncation makes a navigation or a screenshot throw first. Either way it
    // is never green, and the per-file line above has already been printed.
    // A crash is loud; a silent truncation is the failure mode this whole file
    // exists to remove.
    stream.on('error', (error) => {
      serveFailures.push(`${relative}: ${error.message}`)
      console.error(`[a11y-live] failed while serving ${relative}: ${error.message}`)
      response.destroy()
    })
    stream.pipe(response)
  })

  return new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`the audit server could not start: ${error.code || error.message}`)))
    // Port 0 asks the OS for a free one. a11y-prove runs this gate as N
    // sequential processes, and a FIXED port leaves sockets in TIME_WAIT
    // between them, which produced roughly a one-in-three spurious failure.
    // Always false reds, never false greens, but a gate that fails at random
    // is not one anybody trusts.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('the audit server started without a usable port'))
        return
      }
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve(server)
    })
  })
}

async function launchBrowser() {
  // Prefer a browser already on the machine so this runs without a separate
  // Playwright download.
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel })
    } catch {
      // try the next option
    }
  }
  return await chromium.launch()
}

// A route that 404s still renders a page, and axe reports no violations against
// it, so an unchecked navigation lets this gate print "passed" while auditing a
// page that is not the one named. Every navigation asserts its status.
async function open(page, route) {
  const response = await page.goto(baseUrl + route, { waitUntil: 'networkidle' })
  const status = response?.status()
  if (status !== 200) {
    throw new Error(`${route} returned ${status ?? 'no response'}: the audit would have run against the wrong page`)
  }
}

async function auditPage(page, { label, theme }) {
  // Auditing the wrong theme is a silent false pass, which is exactly the
  // failure mode this gate exists to remove. So assert, do not assume.
  if (THEME_ATTRIBUTE) {
    const applied = await page.evaluate((attr) => document.documentElement.getAttribute(attr), THEME_ATTRIBUTE)
    if (applied !== theme) {
      throw new Error(`${label}: expected the ${theme} theme but the document is "${applied}"`)
    }
  }

  await page.evaluate(axeSource)
  const result = await page.evaluate(
    ({ tags, extraRules }) => {
      const axe = /** @type {any} */ (window).axe
      return axe.run(document, {
        runOnly: { type: 'tag', values: tags },
        rules: Object.fromEntries(extraRules.map((id) => [id, { enabled: true }])),
      })
    },
    { tags: AXE_TAGS, extraRules: EXPERIMENTAL_RULES },
  )

  const shape = (items, kind) =>
    items.map((item) => ({
      label,
      theme,
      kind,
      id: item.id,
      impact: item.impact,
      help: item.help,
      nodes: item.nodes.map((node) => ({
        target: node.target.join(' '),
        message: node.any?.[0]?.message || '',
        summary: node.failureSummary?.split('\n').filter(Boolean).slice(1).join(' ') || '',
      })),
    }))

  // Violations AND incomplete. Incomplete means axe could not DETERMINE an
  // answer, and treating that as a pass is how a gate goes blind.
  return [...shape(result.violations, 'violation'), ...shape(result.incomplete, 'incomplete')]
}

// Contrast measured from the pixels the browser actually painted.
//
// This exists because axe cannot composite a background it did not paint: a
// decorative overlay makes it return "incomplete" for every element beneath,
// which on a real product is most of the interface. The accepted-incomplete
// list would otherwise mean those elements are never really checked.
//
// It samples a full-page screenshot rather than computed style, and that is
// load-bearing. Computed style only knows what an element DECLARES, not what is
// painted on top of it. Sampling pixels also lets an element with a transparent
// background be judged on what it really shows instead of written off.
//
// A ratio alone still misses a PARTIAL wash: a diagonal gradient leaves most of
// the element untouched, so the dominant colour stays the declared one and the
// ratio looks fine while a corner sits below AA. The drift check covers that by
// comparing every meaningful colour cluster against the declared background.
async function checkPaintedContrast(page, { label, theme }) {
  if (!PAINTED_SELECTOR) return []
  const screenshot = (await page.screenshot({ fullPage: true })).toString('base64')

  const measurements = await page.evaluate(
    ({ png, selector }) =>
      new Promise((resolve) => {
        const image = new Image()
        image.onerror = () => resolve({ error: 'the page screenshot could not be decoded' })
        image.onload = () => {
          const sheet = document.createElement('canvas')
          sheet.width = image.width
          sheet.height = image.height
          const sheetCtx = sheet.getContext('2d', { willReadFrequently: true })
          sheetCtx.drawImage(image, 0, 0)
          // Guards against a device pixel ratio other than 1: box coordinates
          // are CSS pixels, the screenshot may not be.
          const scale = image.width / document.documentElement.scrollWidth

          const probe = document.createElement('canvas')
          probe.width = probe.height = 1
          const probeCtx = probe.getContext('2d', { willReadFrequently: true })
          // The browser resolves oklch/oklab/color-mix for us; painting into a
          // canvas reads it back as concrete sRGB without parsing by hand.
          const toRgb = (color) => {
            probeCtx.clearRect(0, 0, 1, 1)
            probeCtx.fillStyle = color
            probeCtx.fillRect(0, 0, 1, 1)
            const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data
            return { r, g, b }
          }
          const luminance = ({ r, g, b }) => {
            const linear = [r, g, b].map((value) => {
              const channel = value / 255
              return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
            })
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
          }
          const distance = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)

          // A cluster counts if it covers 5% of the element OR at least 150
          // pixels. The absolute floor matters: a 30x30 wash is 3% of a wide
          // element and would slip under a purely proportional threshold, even
          // though it is the same visible defect a narrow one would fail on.
          const overlayDrift = (counts, pixels, declared, foreground) => {
            let worst = 0
            for (const [key, count] of counts) {
              if (count / pixels < 0.05 && count < 150) continue
              const [r, g, b] = key.split(',').map(Number)
              const sample = { r, g, b }
              // Clusters nearer the label colour are the text, not an overlay.
              if (distance(sample, foreground) < distance(sample, declared)) continue
              worst = Math.max(worst, Math.round(distance(sample, declared) * 10) / 10)
            }
            return worst
          }

          const results = []
          let skipped = 0
          for (const element of document.querySelectorAll(selector)) {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const width = Math.round(rect.width * scale)
            const height = Math.round(rect.height * scale)
            // Anything with no painted area cannot be measured. Counted rather
            // than dropped, so nothing vanishes from the totals silently.
            if (style.visibility === 'hidden' || style.display === 'none' || width < 4 || height < 4) {
              skipped += 1
              continue
            }

            // Sample the interior only. A border is a different colour by
            // design and at small sizes is a big enough share of the box to
            // look like an overlay. The extra pixel absorbs antialiasing.
            const inset =
              Math.ceil(
                Math.max(
                  parseFloat(style.borderTopWidth) || 0,
                  parseFloat(style.borderRightWidth) || 0,
                  parseFloat(style.borderBottomWidth) || 0,
                  parseFloat(style.borderLeftWidth) || 0,
                ) * scale,
              ) + 1
            const sampleWidth = width - inset * 2
            const sampleHeight = height - inset * 2
            if (sampleWidth < 4 || sampleHeight < 4) {
              skipped += 1
              continue
            }

            const { data } = sheetCtx.getImageData(
              Math.round((rect.left + window.scrollX) * scale) + inset,
              Math.round((rect.top + window.scrollY) * scale) + inset,
              sampleWidth,
              sampleHeight,
            )
            const counts = new Map()
            for (let index = 0; index < data.length; index += 4) {
              const key = `${data[index]},${data[index + 1]},${data[index + 2]}`
              counts.set(key, (counts.get(key) || 0) + 1)
            }
            let dominant = null
            let best = -1
            for (const [key, count] of counts) {
              if (count > best) {
                best = count
                const [r, g, b] = key.split(',').map(Number)
                dominant = { r, g, b }
              }
            }

            const foreground = toRgb(style.color)
            const high = Math.max(luminance(foreground), luminance(dominant))
            const low = Math.min(luminance(foreground), luminance(dominant))
            const fontPx = parseFloat(style.fontSize)
            const isLarge = fontPx >= 24 || (fontPx >= 18.66 && Number(style.fontWeight) >= 700)

            probeCtx.clearRect(0, 0, 1, 1)
            probeCtx.fillStyle = style.backgroundColor
            probeCtx.fillRect(0, 0, 1, 1)
            const declaredAlpha = probeCtx.getImageData(0, 0, 1, 1).data[3]
            const declared = toRgb(style.backgroundColor)
            // backgroundColor is only a trustworthy reference when it is the
            // whole story. An element painting its own gradient or image has a
            // backgroundColor that is merely the fallback underneath, so every
            // pixel would read as drift: a confident, entirely wrong overlay.
            const declaredIsWholeBackground = style.backgroundImage === 'none' && declaredAlpha === 255
            const drift = declaredIsWholeBackground
              ? overlayDrift(counts, sampleWidth * sampleHeight, declared, foreground)
              : null

            results.push({
              text: (element.textContent || '').trim().slice(0, 30),
              ratio: Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100,
              required: isLarge ? 3 : 4.5,
              color: style.color,
              painted: `rgb(${dominant.r}, ${dominant.g}, ${dominant.b})`,
              declared: style.backgroundColor,
              drift,
            })
          }
          resolve({ results, skipped, total: document.querySelectorAll(selector).length })
        }
        image.src = `data:image/png;base64,${png}`
      }),
    { png: screenshot, selector: PAINTED_SELECTOR },
  )

  if (measurements.error) {
    throw new Error(`${label} (${theme} theme): ${measurements.error}`)
  }
  paintedVerified += measurements.results.length
  paintedSkipped += measurements.skipped
  paintedMatched += measurements.total

  // Tolerance is deliberately tiny: a clean tree measures exactly 0 drift on
  // every opaque element, so anything above sampling noise is a real overlay.
  const OVERLAY_DRIFT_TOLERANCE = 2

  const overlayFindings = measurements.results
    .filter((measurement) => measurement.drift !== null && measurement.drift > OVERLAY_DRIFT_TOLERANCE)
    .map((measurement) => ({
      label,
      theme,
      kind: 'violation',
      id: 'painted-overlay-drift',
      impact: 'serious',
      help: 'Something is painted over this element, so its real contrast is not the contrast its CSS declares',
      nodes: [
        {
          target: `${PAINTED_SELECTOR} "${measurement.text}"`,
          message: `declared ${measurement.declared} but painted ${measurement.painted} (drift ${measurement.drift})`,
          summary: '',
        },
      ],
    }))

  return measurements.results
    .filter((measurement) => measurement.ratio < measurement.required)
    .map((measurement) => ({
      label,
      theme,
      kind: 'violation',
      id: 'painted-contrast',
      impact: 'serious',
      help: 'Label must meet the WCAG AA contrast floor against the pixels actually painted behind it',
      nodes: [
        {
          target: `${PAINTED_SELECTOR} "${measurement.text}"`,
          message: `measured ${measurement.ratio}:1, needs ${measurement.required}:1 (${measurement.color} on painted ${measurement.painted})`,
          summary: '',
        },
      ],
    }))
    .concat(overlayFindings)
}

// Opens a page whose theme is pinned before any document script runs, so the
// page is painted in its final theme and no transition is ever in flight.
async function themedPage(browser, theme) {
  const page = await browser.newPage()

  // The stream-error handler in startServer only exists when THIS file is
  // serving. Point A11Y_BASE_URL at the product's own preview server, which the
  // README recommends as strictly better, and that protection disappears
  // entirely: a truncated subresource would again leave axe auditing a
  // partly-unrendered page under a printed pass. Asking the BROWSER what it
  // failed to fetch covers both modes.
  //
  // ERR_ABORTED is excluded because it is what PAGE-INITIATED cancellation
  // looks like: an app calling AbortController.abort(), or window.stop(). A
  // product whose own code aborts a fetch on unmount would otherwise turn an
  // ordinary green run into a hard "this run proves nothing" block, which is
  // the alarm fatigue the retrofit-ratchet section of the README warns about.
  //
  // Measured against Chromium 150 rather than reasoned from the error names,
  // because the difference is the whole safety of this filter. A truncated
  // response does NOT arrive as ERR_ABORTED: a chunked body cut mid-stream is
  // ERR_INCOMPLETE_CHUNKED_ENCODING, one with Content-Length is
  // ERR_CONTENT_LENGTH_MISMATCH, and headers with no body at all is
  // ERR_EMPTY_RESPONSE. All three still fail the run.
  //
  // Only ERR_ABORTED is excluded. A blocked request (an extension, a content
  // blocker) means the asset genuinely never arrived, which is exactly what
  // this array is for, so it is NOT filtered.
  //
  // A 404 is NOT a failure here, it is a successful response, so ordinary
  // missing-asset noise never reaches this either.
  //
  // The error names above were measured. The listener's behaviour inside a full
  // audit run has never been exercised from this repo, which has no browser.
  // Prove that half on first install.
  const BENIGN_FAILURES = new Set(['net::ERR_ABORTED'])
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || 'unknown error'
    if (BENIGN_FAILURES.has(reason)) return
    // Printed here as well as collected: a throw anywhere in the audit loop
    // (open() on a non-200, the theme assertion, a screenshot that fails to
    // decode) escapes the try, which has a finally but no catch, and kills the
    // process before the summary loop. In A11Y_BASE_URL mode this listener is
    // then the ONLY thing that named the failed URL.
    console.error(`[a11y-live] the browser could not fetch ${request.url()}: ${reason}`)
    serveFailures.push(`${request.url()} (${reason}, reported by the browser)`)
  })

  // Pin BOTH paths: a typical init prefers a stored value and otherwise falls
  // back to prefers-color-scheme, so setting only the attribute is not enough
  // (the app runs after this and overwrites it). reducedMotion keeps any
  // remaining transition from being sampled mid-flight; verify the product's
  // reduced-motion block only changes durations, never colours, or this could
  // alter what axe measures.
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.addInitScript(
    ({ value, attribute, storageKey }) => {
      if (attribute) document.documentElement.setAttribute(attribute, value)
      if (!storageKey) return
      try {
        localStorage.setItem(storageKey, value)
      } catch {
        // Storage denial must not abort the audit: the emulated colour scheme
        // above still resolves the app's fallback to the intended theme.
      }
    },
    { value: theme, attribute: THEME_ATTRIBUTE, storageKey: THEME_STORAGE_KEY },
  )
  return page
}

const server = process.env.A11Y_BASE_URL ? null : await startServer()
const browser = await launchBrowser()
const findings = []

try {
  for (const theme of THEMES) {
    const page = await themedPage(browser, theme)

    for (const route of ROUTES) {
      await open(page, route)
      findings.push(...(await auditPage(page, { label: route, theme })))
      findings.push(...(await checkPaintedContrast(page, { label: route, theme })))
    }

    for (const state of POPULATED_STATES) {
      await open(page, state.route)
      await state.setup(page)
      findings.push(...(await auditPage(page, { label: state.label, theme })))
      findings.push(...(await checkPaintedContrast(page, { label: state.label, theme })))
    }

    await page.close()
  }
} finally {
  await browser.close()
  // Awaited so the port is released before the next run in a11y-prove.mjs
  // starts, rather than racing process exit.
  if (server) await new Promise((resolve) => server.close(resolve))
}

const checkCount = (ROUTES.length + POPULATED_STATES.length) * THEMES.length

// A request that started and never finished means axe audited something other
// than the page as authored. Reported first: every verdict below is about a page
// that may have been truncated.
if (serveFailures.length > 0) {
  console.error('Live accessibility audit is NOT valid: these requests never completed:')
  for (const failure of serveFailures) console.error(`  ${failure}`)
  console.error('axe may have audited a partly-unrendered page, so this run proves nothing.')
  process.exit(2)
}

// Order matters here. With no routes AND a selector configured, BOTH this and
// the selector check below are true, and the selector message would blame the
// selector for a fault that is really "nothing was audited at all".
//
// THEMES is named too, because an empty THEMES also drives checkCount to zero
// while slipping past the multi-theme guard at the top, and a message blaming
// ROUTES when ROUTES is fine sends you looking in the wrong place.
if (checkCount === 0) {
  console.error(
    `Live accessibility audit ran ZERO checks: ROUTES=${ROUTES.length}, POPULATED_STATES=${POPULATED_STATES.length}, THEMES=${THEMES.length}. All checks are the product of (routes + states) and themes, so a zero in either factor audits nothing.`,
  )
  process.exit(2)
}

// A configured selector that matched NOTHING anywhere is a broken config, not a
// clean painted-contrast pass. Same rule this directory already applies to a
// mutation run that generates zero mutants: a zero result is UNKNOWN, and a gate
// that quietly measured nothing is the exact false green this file exists to
// remove. Surfaced before the findings, because it invalidates the whole run.
if (PAINTED_SELECTOR && paintedMatched === 0) {
  console.error(`Live accessibility audit could not run: PAINTED_SELECTOR "${PAINTED_SELECTOR}" matched no elements on any page.`)
  console.error('Fix the selector or set PAINTED_SELECTOR to an empty string to skip the painted-contrast check deliberately.')
  process.exit(2)
}

const accepted = new Map()
const failures = []

for (const finding of findings) {
  if (finding.kind === 'violation') {
    failures.push(finding)
    continue
  }
  const unexplained = finding.nodes.filter((node) => {
    const text = `${node.message} ${node.summary}`
    const rule = ACCEPTED_INCOMPLETE.find((entry) => entry.rule === finding.id && entry.match.test(text))
    if (!rule) return true
    accepted.set(rule.why, (accepted.get(rule.why) || 0) + 1)
    return false
  })
  if (unexplained.length > 0) failures.push({ ...finding, nodes: unexplained })
}

// Printed every run so the accepted-incomplete list is never mistaken for full
// coverage, and so an element silently dropping out of measurement is visible
// rather than implied.
for (const [why, count] of [...accepted.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  undetermined (accepted): ${String(count).padStart(4)}  ${why}`)
}
if (PAINTED_SELECTOR) {
  console.log(`  painted contrast verified: ${String(paintedVerified).padStart(3)}  measured from painted pixels`)
  console.log(`  painted contrast skipped:  ${String(paintedSkipped).padStart(3)}  no painted area (hidden or zero-size)`)
}

if (failures.length > 0) {
  const violationCount = failures.filter((f) => f.kind === 'violation').length
  const undeterminedCount = failures.length - violationCount
  console.error(
    `\nLive accessibility audit FAILED across ${checkCount} page/theme checks: ` +
      `${violationCount} violation(s), ${undeterminedCount} unexplained undetermined result(s)\n`,
  )
  for (const failure of failures) {
    const tag = failure.kind === 'violation' ? failure.impact : 'undetermined'
    console.error(`  [${tag}] ${failure.id} - ${failure.label} (${failure.theme} theme)`)
    console.error(`    ${failure.help}`)
    for (const node of failure.nodes) {
      console.error(`    -> ${node.target}`)
      const detail = node.summary || node.message
      if (detail) console.error(`       ${detail}`)
    }
    console.error('')
  }
  process.exit(1)
}

console.log(`Live accessibility audit passed (axe ${AXE_TAGS.join(', ')}; ${checkCount} page/theme checks)`)
