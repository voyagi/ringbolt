import { type ActionParameter, spokenLines } from "../actions/definition.js";
import { type Incident, describeForSpeech } from "./incident.js";

/**
 * The first thing Ringbolt says on every call, and the reason it is a named constant rather than a
 * clause inside the brief below.
 *
 * A voice system that telephones a person and holds a conversation with them has to tell that
 * person they are not talking to a human, at the first interaction, in a way they can understand.
 * That is EU AI Act Article 50(1), it applies to this product wherever the person answering is in
 * the Union, and the determination behind it is recorded in `docs/ai-act.md`.
 *
 * Wording matters as much as presence. "Automated" is what a person woken at three in the morning
 * understands immediately; a legalism they have to decode is not a disclosure. It goes in the
 * opening sentence rather than at the end, because a disclosure somebody hangs up before hearing
 * has not been made.
 */
export const AUTOMATED_DISCLOSURE =
  "Ringbolt is an automated system, not a person, and the first sentence of every call has to say so in plain words.";

export type BriefIncident = Pick<
  Incident,
  "service" | "title" | "severity" | "detail" | "startedAt"
>;

export type BriefAction = {
  id: string;
  spokenDescription: string;
  confirmationPhrase: string | null;
  parameters: readonly ActionParameter[];
};

/**
 * Everything the responder's side of the call is built from. It is a pure function of the incident,
 * the actions the policy allows, and the clock, so what a person will hear at three in the morning
 * can be read and tested without a telephone.
 */
export function buildTask(
  incident: BriefIncident,
  offered: readonly BriefAction[],
  now: Date,
): string {
  const choices = offered.map(spokenLines).join("\n");

  return [
    // CALL-E refuses to create a task that does not say who the caller is, which is right: a
    // stranger's telephone ringing at three in the morning with an unnamed voice on it is how a
    // person hangs up on their own alert. Naming Ringbolt is also the only introduction that makes
    // the rest of the call make sense, because what follows is a request for authority to act.
    "You are Ringbolt, an automated on-call line. You telephone the engineer on call when a production system breaks, talk the incident through with them, and carry out the fix they authorize.",
    `You are calling the engineer on call for ${incident.service}, about a live production problem.`,
    AUTOMATED_DISCLOSURE,
    'Open with one sentence that names you as Ringbolt, says you are an automated system rather than a person, and says what has broken, for example "This is Ringbolt, an automated system, calling about checkout: payment errors are above twenty percent." Then stop and let them respond.',
    "Say it that way on every call, including a call back to somebody you have already spoken to today.",
    "",
    describeForSpeech(incident, now),
    "",
    "Answer their questions about the incident using only the facts above. If they ask something you were not told, say plainly that you do not have that detail.",
    "",
    "These are the only things you can do for them:",
    choices,
    "- hold: change nothing for now.",
    "- escalate: hand this to someone else.",
    "- snooze: leave it and call back later, and ask how many minutes.",
    "",
    "Read the choices out only if they ask what you can do, or if they have not decided after their questions are answered. Do not push them.",
    "Where an action asks for a value, ask for it in their own words and report exactly what they said in action_parameters. If they do not give one, leave it out rather than filling it in yourself.",
    "Before ending the call, say back what you understood the decision to be and get a yes.",
  ].join("\n");
}
