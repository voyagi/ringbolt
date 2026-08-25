#!/usr/bin/env node
// Renders every screen of the built dashboard into design/mockups/.
//
// These are screenshots of the REAL bundle, not drawings of it. design/ used to
// hold one hand-written HTML mockup of the board, which was the right artefact
// while the direction was being chosen and the wrong one afterwards: a picture
// of a screen that does not exist any more is worse than none, because somebody
// will trust it.
//
// It serves the same fixtures the accessibility gate does, so the board in
// design/ and the board the gate audits are the same board.
//
//   npm run build && node scripts/render-screens.mjs

import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, sep } from 'node:path'
import puppeteer from 'puppeteer-core'
import { API_FIXTURES } from './a11y-fixtures.mjs'

const DIST = join(process.cwd(), 'dist', 'client')
const OUT = join(process.cwd(), 'design', 'mockups')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 420, height: 1100 }

// Each entry is one saved image: where to click to get there, what to wait for,
// and how wide. `deck` is rendered at both widths because the three columns
// collapsing to one is the layout decision worth being able to look at.
const SHOTS = [
  { name: 'deck', clicks: [], settled: '.gauge', size: DESKTOP },
  { name: 'deck-narrow', clicks: [], settled: '.gauge', size: NARROW },
  {
    name: 'incidents',
    clicks: ['nav a[href="/incidents"]'],
    settled: 'table.log',
    size: DESKTOP,
  },
  {
    name: 'incident',
    clicks: ['nav a[href="/incidents"]', 'table.log tbody a'],
    settled: 'pre.raw',
    size: DESKTOP,
  },
  {
    name: 'runbooks',
    clicks: ['nav a[href="/runbooks"]'],
    settled: 'form.card',
    size: DESKTOP,
  },
  {
    name: 'rota',
    clicks: ['nav a[href="/rota"]'],
    settled: 'ol.order',
    size: DESKTOP,
  },
  {
    name: 'demo',
    clicks: ['nav a[href="/demo"]'],
    settled: 'p.demo-state',
    size: DESKTOP,
  },
  {
    name: 'settings',
    clicks: ['nav a[href="/settings"]'],
    settled: 'pre.raw',
    size: DESKTOP,
  },
]

const BROWSER_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const fixture = API_FIXTURES[url.pathname]
    if (fixture !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(fixture()))
      return
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const target = join(DIST, relative)
    if (target !== DIST && !target.startsWith(DIST + sep)) {
      response.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
    })
    createReadStream(target).pipe(response)
  })
  // Loopback only, and port 0 so a second run cannot collide with a socket the
  // first one left in TIME_WAIT.
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const executablePath = BROWSER_PATHS.find(Boolean) ?? ''
const distReady = await stat(join(DIST, 'index.html')).catch(() => null)
if (!distReady?.isFile()) {
  console.error('dist/client is missing. Run `npm run build` first.')
  process.exit(1)
}

await mkdir(OUT, { recursive: true })
const server = await serve()
const base = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({ executablePath, headless: true })

try {
  for (const theme of ['dark', 'light']) {
    for (const shot of SHOTS) {
      const page = await browser.newPage()
      await page.setViewport(shot.size)
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: theme },
      ])
      await page.evaluateOnNewDocument((value) => {
        document.documentElement.setAttribute('data-theme', value)
        try {
          localStorage.setItem('ringbolt-theme', value)
        } catch {
          // The attribute above is enough.
        }
      }, theme)

      await page.goto(base + '/', { waitUntil: 'networkidle0' })
      for (const click of shot.clicks) {
        await page.waitForSelector(click)
        await page.click(click)
      }
      await page.waitForSelector(shot.settled)

      const file = join(OUT, `${shot.name}-${theme === 'dark' ? 'night' : 'day'}.png`)
      await page.screenshot({ path: file, fullPage: shot.name !== 'deck' })
      console.log(`wrote ${file}`)
      await page.close()
    }
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
