// What the accessibility gate serves the dashboard while it audits it.
//
// The audit is hermetic: no Worker, no database, no telephone. That is not a
// compromise, it is what makes the run repeatable. A board read from a live
// database changes between runs, so a contrast failure on a transcript would
// appear and disappear depending on what somebody said on a call that day, and
// a gate that is only sometimes red is a gate nobody trusts.
//
// The shapes here are the ones src/domain/view.ts declares. When a screen grows
// a field, this file is what makes the gate look at it.

/**
 * Both layouts the deck actually has. Below 78rem the three columns collapse to
 * one, which repaints every surface in the product: a contrast reading taken at
 * desktop width says nothing about the narrow one.
 */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 420, height: 900 },
]

/**
 * Every screen, and how to reach it and know it has settled.
 *
 * `reach` is a list because one screen is two clicks in: an incident record is
 * only reachable through the history table, and it is the screen carrying the
 * transcript and the audit trail, so leaving it out would leave the densest
 * page in the product unaudited.
 */
export const SCREENS = [
  {
    label: '/incidents',
    reach: 'nav a[href="/incidents"]',
    settled: 'table.log',
  },
  {
    label: '/incidents/:id',
    reach: ['nav a[href="/incidents"]', 'table.log tbody a'],
    settled: 'pre.raw',
  },
  {
    label: '/runbooks',
    reach: 'nav a[href="/runbooks"]',
    settled: 'form.card',
  },
  { label: '/rota', reach: 'nav a[href="/rota"]', settled: 'ol.order' },
  {
    label: '/settings',
    reach: 'nav a[href="/settings"]',
    settled: 'pre.raw',
  },
]

/**
 * A fixed clock. Everything below is offset from it, so the ring, the tracks and
 * the arrival trace draw the same picture on every run.
 */
const NOW = Date.parse('2026-08-24T14:04:50.000Z')
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString()

const CHECKOUT = {
  id: 'inc_checkout_01',
  state: 'calling',
  service: 'checkout',
  title: 'Payment errors above 20 percent',
  severity: 'critical',
  detail: 'Error rate 23.1 percent against a 0.2 percent baseline.',
  source: 'prometheus',
  startedAt: at(670),
  links: [{ label: 'The failing dashboard', url: 'https://example.test/checkout' }],
  offeredActions: ['rollback', 'kill_switch'],
  wakeAt: new Date(NOW + 260 * 1000).toISOString(),
  wakeReason: 'no_answer',
  callAttempts: 2,
  rotationPosition: 1,
  callStartedAt: at(41),
  createdAt: at(650),
  updatedAt: at(41),
  outcome: null,
  contactName: 'Nadia',
}

const SEARCH = {
  ...CHECKOUT,
  id: 'inc_search_01',
  state: 'escalating',
  service: 'search',
  title: 'Latency above 5 seconds at the ninety ninth percentile',
  severity: 'high',
  detail: null,
  offeredActions: [],
  wakeAt: new Date(NOW + 90 * 1000).toISOString(),
  callStartedAt: at(220),
  createdAt: at(900),
  updatedAt: at(220),
  contactName: 'Ivo',
}

const MAILER = {
  ...SEARCH,
  id: 'inc_mailer_01',
  state: 'snoozed',
  service: 'mailer',
  title: 'Queue depth past twelve thousand',
  severity: 'low',
  wakeReason: 'snooze_over',
  wakeAt: new Date(NOW + 1500 * 1000).toISOString(),
  createdAt: at(3400),
  updatedAt: at(1200),
  contactName: 'Nadia',
}

const IMPORTS = {
  ...SEARCH,
  id: 'inc_imports_01',
  state: 'resolved',
  service: 'imports',
  title: 'The nightly job failed twice',
  severity: 'high',
  wakeAt: null,
  wakeReason: null,
  outcome: 'rollback:succeeded',
  createdAt: at(9000),
  updatedAt: at(8600),
}

const TRANSCRIPT = [
  {
    offsetSeconds: 0,
    speaker: 'bot',
    text: 'This is an automated call from Ringbolt. Checkout payment errors went from nought point two to twenty three percent, right after a deploy.',
  },
  { offsetSeconds: 11, speaker: 'user', text: 'Is anything else touching payments?' },
  { offsetSeconds: 14, speaker: 'bot', text: 'No. Search and accounts are both clean.' },
  { offsetSeconds: 19, speaker: 'user', text: 'Right. Roll it back.' },
  {
    offsetSeconds: 22,
    speaker: 'bot',
    text: 'Rolling back checkout to the previous release. Say roll it back to confirm.',
  },
  { offsetSeconds: 27, speaker: 'user', text: 'Roll it back.' },
]

const RUN = {
  id: 'run_01',
  actionId: 'rollback',
  authorizedBy: 'Nadia',
  outcome: 'succeeded',
  detail: 'Rolled checkout back to 2026.08.19-b and read the active release back to confirm it.',
  attempts: 1,
  durationMs: 3140,
  verification: { verified: true, read: '2026.08.19-b' },
  stateBefore: { activeRelease: '2026.08.19-c', killSwitch: false },
  stateAfter: { activeRelease: '2026.08.19-b', killSwitch: false },
  decision: { decision: 'run_action', action_id: 'rollback', confirmation_phrase: 'roll it back' },
  parameters: {},
  at: at(30),
}

const EVENTS = [
  { id: 'evt_1', at: at(650), kind: 'alert.received', message: 'checkout: Payment errors above 20 percent' },
  { id: 'evt_2', at: at(628), kind: 'call.placed', message: 'Calling Nadia about checkout.' },
  { id: 'evt_3', at: at(300), kind: 'incident.escalated', message: 'Nobody has resolved this, so Ivo is being called.' },
  { id: 'evt_4', at: at(41), kind: 'call.placed', message: 'Calling Nadia about checkout.' },
  { id: 'evt_5', at: at(33), kind: 'call.ended', message: 'The responder authorized a rollback.' },
  { id: 'evt_6', at: at(30), kind: 'action.succeeded', message: 'Rollback ran, the active release is now 2026.08.19-b.' },
]

const ARRIVALS = [0, 0, 0, 1, 0, 0, 2, 6, 9, 4].map((alerts, index) => ({
  at: new Date(NOW - (10 - index) * 5 * 60_000).toISOString(),
  alerts,
}))

const ACTIONS = [
  {
    id: 'rollback',
    label: 'Roll back the last release',
    spokenDescription: 'I can roll this service back to its previous release.',
    confirmationPhrase: 'roll it back',
    minConfidence: 0.85,
    parameters: [],
    target: { kind: 'service_state', operation: 'rollback' },
    verify: null,
    createdAt: at(90000),
    updatedAt: at(90000),
  },
  {
    id: 'kill_switch',
    label: 'Turn the service off',
    spokenDescription: 'I can turn this service off until somebody looks at it.',
    confirmationPhrase: null,
    minConfidence: null,
    parameters: [],
    target: { kind: 'service_state', operation: 'kill_switch_on' },
    verify: null,
    createdAt: at(90000),
    updatedAt: at(90000),
  },
]

const CONTACTS = [
  { id: 'con_1', name: 'Nadia', phone: '+31600000001' },
  { id: 'con_2', name: 'Ivo', phone: '+31600000002' },
]

const BUDGET = {
  realCallsPlaced: 3,
  callPriceUsd: 0.05,
  spentUsd: 0.15,
  creditUsd: 5,
  remainingUsd: 4.85,
  callsRemaining: 97,
}

/**
 * The read API, keyed by path. Every value is a function so a screen that reads
 * one twice cannot mutate what the next read sees.
 */
export const API_FIXTURES = {
  '/api/session': () => ({
    admin: 'open',
    environment: 'development',
    calleMode: 'fake',
  }),
  '/api/budget': () => BUDGET,
  '/api/audit/board': () => ({
    now: new Date(NOW).toISOString(),
    focus: {
      incident: CHECKOUT,
      call: {
        status: 'completed',
        taskCompleted: true,
        confidence: 0.94,
        summary: 'The responder authorized a rollback and it was carried out.',
        transcript: TRANSCRIPT,
        recordedAt: at(33),
      },
      events: EVENTS,
      actions: [RUN],
      arrivals: ARRIVALS,
      repeats: 4,
    },
    standing: [SEARCH, MAILER],
    counts: { open: 3, onTheLine: 1, actedToday: 7, refusedToday: 2 },
    rota: {
      service: '*',
      contacts: CONTACTS.map((one) => ({ id: one.id, name: one.name })),
      usesConfiguredNumber: false,
    },
    budget: BUDGET,
  }),
  '/api/audit/incidents': () => ({
    incidents: [CHECKOUT, SEARCH, MAILER, IMPORTS],
  }),
  [`/api/audit/incidents/${CHECKOUT.id}`]: () => ({
    incident: CHECKOUT,
    events: EVENTS,
    calls: [
      {
        status: 'failed',
        taskCompleted: false,
        confidence: null,
        summary: 'Nobody answered.',
        transcript: [],
        recordedAt: at(300),
      },
      {
        status: 'completed',
        taskCompleted: true,
        confidence: 0.94,
        summary: 'The responder authorized a rollback and it was carried out.',
        transcript: TRANSCRIPT,
        recordedAt: at(33),
      },
    ],
    actions: [RUN],
  }),
  '/api/config/actions': () => ({
    actions: ACTIONS,
    allowedHosts: ['actions.example.test'],
  }),
  '/api/config/services': () => ({
    services: [
      {
        service: 'checkout',
        minSeverity: 'high',
        quietHours: null,
        allowedActions: ['rollback', 'kill_switch'],
        flapWindowMinutes: 15,
        maxCallsPerWindow: 1,
        escalateAfterMinutes: 5,
        updatedAt: at(90000),
      },
    ],
  }),
  '/api/config/contacts': () => ({ contacts: CONTACTS }),
  '/api/config/rotation/*': () => ({
    service: '*',
    contacts: CONTACTS,
    own: true,
    usesConfiguredNumber: false,
  }),
}
