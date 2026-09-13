/**
 * Everything the dashboard is allowed to know, and the only module under `src/` that the browser
 * bundle may import.
 *
 * It has no imports of its own, and that is the whole point rather than an accident of size. The
 * server half of this repo reaches D1, Durable Objects and the CALL-E key, and a single import from
 * a screen would pull one of them into a file a stranger can read. `.dependency-cruiser.cjs`
 * enforces the boundary and `src/domain/view.test.ts` enforces the emptiness, because a rule that
 * allows one module through stops being a boundary the moment that module grows an import.
 *
 * The state and severity lists live here rather than in `incident.ts` for the same reason. They are
 * one list, not two: `incident.ts` re-exports them, so a state added here reaches the state machine
 * and the interface in the same edit.
 */

export const incidentStates = [
  "received",
  "calling",
  "deciding",
  "acting",
  "deferred",
  "muted",
  "escalating",
  "snoozed",
  "resolved",
  "held",
  "filtered",
  "failed",
] as const;

export type IncidentState = (typeof incidentStates)[number];

/**
 * An incident counts as open while it can still lead to a call. Three things read this: the
 * duplicate check that decides whether a repeat alert rings a phone, the unique index in migration
 * 0004 that enforces one open incident per fingerprint, and the board's own count of what is
 * standing. Change it here and change it in the migration in the same commit, because a state that
 * is open to one and not the other is a silent second phone call.
 */
export const openIncidentStates = [
  "received",
  "calling",
  "deciding",
  "acting",
  "deferred",
  "muted",
  "escalating",
  "snoozed",
] as const satisfies readonly IncidentState[];

/**
 * States Ringbolt has deliberately parked with a time on them. Each one carries a wakeAt and a
 * wakeReason, the incident's own Durable Object holds an alarm for it, and the reconciliation sweep
 * is the backstop for an alarm that never fires.
 */
export const scheduledStates = [
  "deferred",
  "muted",
  "snoozed",
] as const satisfies readonly IncidentState[];

/**
 * Why an incident is parked, and therefore what happens when its time comes. It is stored on the
 * incident rather than beside the alarm so that the alarm and the sweep read the same answer.
 */
export const wakeReasons = [
  "no_answer",
  "snooze_over",
  "quiet_hours_over",
  "flap_window_over",
] as const;

export type WakeReason = (typeof wakeReasons)[number];

export function isWakeReason(value: unknown): value is WakeReason {
  return (
    typeof value === "string" &&
    (wakeReasons as readonly string[]).includes(value)
  );
}

/** Most severe first. Everything that compares two severities reads that order from here. */
export const severities = ["critical", "high", "low"] as const;
export type Severity = (typeof severities)[number];

export function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" &&
    (severities as readonly string[]).includes(value)
  );
}

/** Whether a severity is at least as serious as a floor. */
export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  return severities.indexOf(severity) <= severities.indexOf(floor);
}

/**
 * The five colours of the instrument panel, plus the neutral. Each one means one state of the
 * world, never a decoration, which is the rule `design/ART-DIRECTION.md` sets and the reason the
 * mapping lives in one function instead of in whichever component needed a colour.
 */
export const tones = [
  "live",
  "cyan",
  "green",
  "amber",
  "violet",
  "dim",
] as const;
export type Tone = (typeof tones)[number];

const stateTone: Record<IncidentState, Tone> = {
  received: "violet",
  calling: "live",
  deciding: "cyan",
  acting: "cyan",
  deferred: "amber",
  muted: "dim",
  escalating: "amber",
  snoozed: "amber",
  resolved: "green",
  held: "dim",
  filtered: "dim",
  failed: "live",
};

export function toneForState(state: IncidentState): Tone {
  return stateTone[state];
}

/**
 * What each state is called on screen. Upper case because an instrument panel labels its readouts
 * that way; the CSS does not do it, so a screen reader hears the same words the eye does.
 */
const stateLabel: Record<IncidentState, string> = {
  received: "RECEIVED",
  calling: "ON THE LINE",
  deciding: "DECIDING",
  acting: "ACTING",
  deferred: "HELD FOR QUIET HOURS",
  muted: "SUPPRESSED",
  escalating: "ESCALATING",
  snoozed: "SNOOZED",
  resolved: "RESOLVED",
  held: "HELD",
  filtered: "FILTERED",
  failed: "FAILED",
};

export function labelForState(state: IncidentState): string {
  return stateLabel[state];
}

const severityTone: Record<Severity, Tone> = {
  critical: "live",
  high: "amber",
  low: "dim",
};

export function toneForSeverity(severity: Severity): Tone {
  return severityTone[severity];
}

/**
 * How far through its own deadline a parked or ringing incident is, from 0 to 1, or null when it
 * has no deadline to run against. The board draws it as a track, and the ring on the live call is
 * the same number at a larger size.
 *
 * `from` is the moment the clock started and `to` the moment it runs out. A deadline already passed
 * reads as full rather than as more than full: the track is a picture of how much time is left, and
 * an overrun is not extra time.
 */
export function elapsedFraction(
  from: string | null,
  to: string | null,
  now: number,
): number | null {
  if (from === null || to === null) return null;
  const started = Date.parse(from);
  const ends = Date.parse(to);
  if (Number.isNaN(started) || Number.isNaN(ends) || ends <= started)
    return null;
  return Math.min(1, Math.max(0, (now - started) / (ends - started)));
}

/** A duration as a clock reads it, for anything that is counting while somebody watches it. */
export function asClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return `${pad(minutes)}:${pad(rest)}`;
  const hours = Math.floor(minutes / 60);
  return `${pad(hours)}:${pad(minutes % 60)}:${pad(rest)}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * How long ago something happened, in the words a person would use. Anything in the future reads as
 * "just now": a clock skew between the monitor that sent the alert and this service is ordinary,
 * and a negative age on screen reads as a bug in Ringbolt rather than as a clock disagreeing.
 */
export function sinceWords(at: string | null, now: number): string | null {
  if (at === null) return null;
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Speech to text does not preserve punctuation, casing, or filler, so an exact string compare would
 * refuse phrases a person plainly said. Normalising to words is as loose as this is allowed to get:
 * the words themselves, in order, still have to be right.
 *
 * The authorization gate and the screen that shows which sentence authorized an action both read
 * this. One normalisation, not two: a screen that highlighted a turn the gate would not have
 * accepted would be showing evidence for a decision that was made on something else.
 */
export function normalisePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
}

export function phrasesMatch(spoken: string, required: string): boolean {
  return normalisePhrase(spoken) === normalisePhrase(required);
}

/** The words of a value, in order, after the reduction `normalisePhrase` does. */
function wordsOf(value: string): string[] {
  const normalised = normalisePhrase(value);
  return normalised === "" ? [] : normalised.split(" ");
}

/**
 * What every n't contraction leaves in front of its t: "couldn't" is `couldn` and then `t`.
 *
 * English has a closed set of these, so it is written out in full rather than guessed from a
 * suffix. A rule like "a word ending in nt" would read "want" and "went" as refusals, and a hand
 * picked list of the common ones is how "couldnt" and "wasnt" were missed the first time.
 */
const CONTRACTION_STEMS: ReadonlySet<string> = new Set([
  "ain",
  "aren",
  "can",
  "couldn",
  "daren",
  "didn",
  "doesn",
  "don",
  "hadn",
  "hasn",
  "haven",
  "isn",
  "mightn",
  "mustn",
  "needn",
  "oughtn",
  "shan",
  "shouldn",
  "wasn",
  "weren",
  "won",
  "wouldn",
]);

/**
 * Words that, said just before the required phrase, make it a refusal rather than a grant.
 *
 * Bare `no` and bare `can` are left out on purpose. "No, roll it back" contradicts something and
 * then authorizes, and "can we roll it back" asks for it. Refusing either would throw away a real
 * authorization, and a genuine negation of the phrase almost always carries one of these as well.
 *
 * A contraction reaches this function in one of two spellings, and both come from
 * `CONTRACTION_STEMS` so the two cannot drift apart. When transcription drops the apostrophe it is
 * one word, `couldnt`, and that is listed here. When it keeps it, `normalisePhrase` turns the
 * apostrophe into a space and it arrives as `couldn` then `t`, which `isNegation` reads as a pair.
 */
const NEGATORS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "cannot",
  "nope",
  "neither",
  "nor",
  "without",
  ...[...CONTRACTION_STEMS].map((stem) => `${stem}t`),
]);

/**
 * How many words before the phrase are read for a negation.
 *
 * Three reaches a split contraction with a word between it and the phrase, "don't just roll it
 * back", which is four words to the `roll`. It also reaches back into an unrelated clause often
 * enough to refuse "I didn't catch that, roll it back". That second cost is accepted: punctuation
 * does not survive transcription, so there is no clause boundary to stop at, and of the two errors
 * available a refusal is the safe one. It escalates to the next person on the rota, where the other
 * error is a production change made on somebody saying not to.
 */
const NEGATION_WINDOW = 3;

function isNegation(words: readonly string[], index: number): boolean {
  const word = words[index];
  if (word === undefined) return false;
  if (NEGATORS.has(word)) return true;
  // A split contraction: a lone t after one of the stems, `couldn t`, `won t`. Checked against the
  // same set the unpunctuated spellings come from, rather than any word ending in n.
  return word === "t" && CONTRACTION_STEMS.has(words[index - 1] ?? "");
}

function negatedBefore(words: readonly string[], start: number): boolean {
  for (
    let index = Math.max(0, start - NEGATION_WINDOW);
    index < start;
    index += 1
  ) {
    if (isNegation(words, index)) return true;
  }
  return false;
}

/**
 * Where the phrase last begins as a whole run of words, or null when it does not occur.
 *
 * Whole words, not characters. Matching inside the joined string let "unroll it backwards" count as
 * saying "roll it back", because the characters are there even though neither word is.
 */
function lastRunStart(
  words: readonly string[],
  phrase: readonly string[],
): number | null {
  for (let start = words.length - phrase.length; start >= 0; start -= 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) {
      return start;
    }
  }
  return null;
}

/**
 * Which turn is the responder saying the words an action demanded, or null when no turn is.
 *
 * The last one wins. A conversation can rehearse a phrase before agreeing to it, and the moment
 * that counts is the one they finished on. That rule runs both ways: when the latest turn that says
 * the words at all says them negated, the responder finished on a refusal, so there is no grant and
 * the search does NOT carry on back to an earlier turn that said them plainly. "Roll it back", then
 * "actually, do not roll it back", has withdrawn the first. Inside one turn the last saying decides
 * for the same reason.
 *
 * A run of whole words rather than equality, because a person says the phrase inside a sentence:
 * "yes, roll it back then" carries it and an equality test would refuse it. The words themselves,
 * in order and as words, still have to be there, and not with a negation directly in front of them.
 *
 * Until this read words it tested characters in the joined string, so "do not roll it back" counted
 * as saying it and so did "unroll it backwards". This is the third of the three questions the
 * authorization gate asks, documented as the check that catches a provider extraction the
 * transcript does not support, and a refusal is exactly the transcript not supporting it.
 *
 * What this still cannot see is a question. "Should I roll it back" normalises to the same words as
 * "roll it back" once the question mark is gone, and transcription does not reliably keep one. A
 * rehearsal question followed by a plain saying is handled by the last-one-wins rule. A question
 * that is the only saying on the call is not.
 *
 * The authorization gate and the deck both read this, which is why it is here rather than in either
 * of them. A gate that acted on a phrase the deck could not find would have nothing to draw the tie
 * from, and a deck that marked a sentence the gate would have refused would be worse: both would be
 * showing evidence for a decision made on something else.
 */
export function turnGranting(
  transcript: readonly { speaker: string; text: string }[],
  phrase: string,
): number | null {
  const wanted = wordsOf(phrase);
  if (wanted.length === 0) return null;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const turn = transcript[index];
    if (turn === undefined || turn.speaker !== "user") continue;

    const words = wordsOf(turn.text);
    const start = lastRunStart(words, wanted);
    if (start === null) continue;

    return negatedBefore(words, start) ? null : index;
  }
  return null;
}

export type IncidentLinkView = { label: string; url: string };

/** One incident as every screen reads it. The call id never appears: it is the one value the
 * unauthenticated webhook route accepts from an anonymous body. */
export type IncidentView = {
  id: string;
  state: IncidentState;
  service: string;
  title: string;
  severity: Severity;
  detail: string | null;
  source: string | null;
  startedAt: string | null;
  links: IncidentLinkView[];
  offeredActions: string[];
  wakeAt: string | null;
  wakeReason: WakeReason | null;
  callAttempts: number;
  rotationPosition: number;
  callStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
  outcome: string | null;
  /** Who is on the phone, or who was. The name, never the number. */
  contactName: string | null;
};

export type TranscriptTurnView = {
  offsetSeconds: number | null;
  speaker: "bot" | "user" | "unknown";
  text: string;
};

export type CallView = {
  status: string;
  taskCompleted: boolean | null;
  confidence: number | null;
  summary: string | null;
  transcript: TranscriptTurnView[];
  recordedAt: string;
  /**
   * When the words were erased under the retention window, or null while they are still here.
   *
   * A screen has to be able to tell the two apart. An empty transcript is also the signature of the
   * fault this product was built around, a call where the responder was never heard, and drawing a
   * retained-and-erased call as one of those would be inventing evidence of a bug.
   */
  redactedAt: string | null;
};

export type ActionRunView = {
  id: string;
  actionId: string;
  authorizedBy: string | null;
  outcome: "succeeded" | "failed" | "unverified";
  detail: string | null;
  attempts: number;
  durationMs: number | null;
  /** What the check afterwards found, kept whole because it is the evidence, not a summary. */
  verification: unknown;
  stateBefore: unknown;
  stateAfter: unknown;
  decision: unknown;
  parameters: unknown;
  at: string;
};

export type EventView = {
  id: string;
  at: string;
  kind: string;
  message: string;
};

/**
 * Whether the check that was meant to confirm an action found what it expected, or null when there
 * was no check to read. Null is a third answer rather than a false: an action recorded as
 * `unverified` is one nobody has looked at, and drawing that as "did not work" is a different claim
 * from the one the record makes.
 */
export function verifiedFlag(verification: unknown): boolean | null {
  if (verification === null || typeof verification !== "object") return null;
  const found = (verification as Record<string, unknown>)["verified"];
  return typeof found === "boolean" ? found : null;
}

/** One bucket of the arrival sparkline: how many alerts landed for a service in that window. */
export type ArrivalBucket = { at: string; alerts: number };

export type DeckFocus = {
  incident: IncidentView;
  /** The deadline the ring counts against, which is the escalation clock while a call is live. */
  call: CallView | null;
  events: EventView[];
  actions: ActionRunView[];
  arrivals: ArrivalBucket[];
  /** How many repeats of this alert arrived while it was open. */
  repeats: number;
};

export type RotaView = {
  service: string;
  contacts: { id: string; name: string }[];
  usesConfiguredNumber: boolean;
};

export type BudgetView = {
  realCallsPlaced: number;
  callPriceUsd: number;
  spentUsd: number;
  creditUsd: number;
  remainingUsd: number;
  callsRemaining: number;
};

export type BoardView = {
  /** The server's clock, so a ring counting seconds counts against it and not the laptop's. */
  now: string;
  focus: DeckFocus | null;
  standing: IncidentView[];
  counts: {
    open: number;
    onTheLine: number;
    actedToday: number;
    refusedToday: number;
  };
  rota: RotaView;
  budget: BudgetView;
};

/**
 * An action definition as the configuration screen reads it. The three composite fields stay
 * `unknown` rather than mirroring the zod schema that defines them: the screen shows them as the
 * JSON an operator edits and hands them straight back, and the server is the only thing that gets
 * to decide whether a target is valid. A mirror here would be a second, weaker rule that drifts.
 */
export type ActionDefinitionView = {
  id: string;
  label: string;
  spokenDescription: string;
  confirmationPhrase: string | null;
  minConfidence: number | null;
  parameters: unknown;
  target: unknown;
  verify: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ServicePolicyView = {
  service: string;
  minSeverity: Severity;
  quietHours: unknown;
  allowedActions: string[];
  flapWindowMinutes: number;
  maxCallsPerWindow: number;
  escalateAfterMinutes: number;
  updatedAt: string;
};

export type ContactView = { id: string; name: string; phone: string };

/**
 * How the demo service is doing. Three answers rather than two, because a service somebody has
 * switched off is not a healthy service and it is not a failing one either: it is the outcome of
 * the other action Ringbolt can be authorized to take, and drawing it as either of the other two
 * would hide what just happened to it.
 */
export type DemoHealth = "serving" | "failing" | "off";

/** A control on the demo screen, and the server's reason when it may not be pressed. */
export type DemoControl = { available: boolean; why: string | null };

export type DemoIncidentView = {
  id: string;
  state: IncidentState;
  wakeAt: string | null;
  callAttempts: number;
};

export type DemoView = {
  service: string;
  health: DemoHealth;
  activeRelease: string;
  previousRelease: string | null;
  killSwitch: boolean;
  /** What the demo service reports it is serving, against what it serves when it is well. */
  errorPercent: number;
  baselinePercent: number;
  faultyRelease: string;
  healthyRelease: string;
  changedAt: string | null;
  /** The server's clock, for the same reason the board carries one. */
  now: string;
  incident: DemoIncidentView | null;
  controls: { breakIt: DemoControl; repair: DemoControl; seed: DemoControl };
  /** True when this deployment is the public demo, so nothing on it may be written. */
  publicDemo: boolean;
};

/**
 * How this deployment guards the screens that carry transcripts and decide which telephone rings.
 * `demo` is the public one: it refuses every write except the demo controls and it cannot be in
 * live mode at all, so there is nothing left for a token to protect on the way in.
 */
export type AdminMode = "open" | "token" | "unavailable" | "demo";

/**
 * How long this deployment keeps what it holds. It is on the session rather than behind the
 * configuration API because it is a statement about the deployment that anybody reading a screen is
 * entitled to, and because the settings page's answer to "what is kept" has to be the number the
 * sweep is actually running on rather than a sentence somebody typed into a document.
 */
export type RetentionView = {
  /** Days before the words of a call are erased, leaving the record that it happened. */
  transcriptDays: number;
  /** Days before a closed incident is deleted outright, with everything hanging off it. */
  incidentDays: number;
};

export type SessionView = {
  admin: AdminMode;
  environment: "development" | "preview" | "production";
  calleMode: "fake" | "live";
  retention: RetentionView;
};
