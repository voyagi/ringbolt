import { describe, expect, it } from "vitest";
import { AUTOMATED_DISCLOSURE, type BriefAction, buildTask } from "./brief.js";
import type { BriefIncident } from "./brief.js";

const incident: BriefIncident = {
  service: "checkout",
  title: "payment errors above twenty percent",
  severity: "high",
  detail: null,
  startedAt: "2026-08-24T02:41:00.000Z",
};

const now = new Date("2026-08-24T03:00:00.000Z");

const killSwitch: BriefAction = {
  id: "kill_switch",
  spokenDescription: "turn the checkout feature off",
  confirmationPhrase: null,
  parameters: [],
};

describe("the brief a responder hears", () => {
  /**
   * Article 50(1) of the EU AI Act: a person interacting with an AI system has to be told so. This
   * product telephones people, so there is no screen to put it on and no way for them to have read
   * it in advance. It is the first sentence or it does not exist.
   */
  it("tells the person they are talking to an automated system", () => {
    const task = buildTask(incident, [killSwitch], now);
    expect(task).toContain(AUTOMATED_DISCLOSURE);
    expect(task).toContain("automated system rather than a person");
  });

  it("puts the disclosure before the incident facts", () => {
    const task = buildTask(incident, [killSwitch], now);
    expect(task.indexOf(AUTOMATED_DISCLOSURE)).toBeLessThan(
      task.indexOf("payment errors above twenty percent"),
    );
  });

  /**
   * There is no configuration, no service setting and no action that removes it, which is what
   * makes "on every call" a property of the code rather than a promise in a document.
   */
  it("carries it on a call that offers nothing at all", () => {
    expect(buildTask(incident, [], now)).toContain(AUTOMATED_DISCLOSURE);
  });

  it("reads out each offered action by the id the decision has to name", () => {
    const task = buildTask(incident, [killSwitch], now);
    expect(task).toContain("- kill_switch: turn the checkout feature off.");
  });

  it("asks for the exact words an action that needs confirming wants", () => {
    const task = buildTask(
      incident,
      [
        {
          ...killSwitch,
          id: "rollback",
          spokenDescription: "roll the last deploy back",
          confirmationPhrase: "roll it back",
        },
      ],
      now,
    );
    expect(task).toContain('say the exact words "roll it back"');
  });

  it("gives the responder the facts of the incident and how long it has been running", () => {
    const task = buildTask(incident, [killSwitch], now);
    expect(task).toContain("Service: checkout.");
    expect(task).toContain("Severity: high.");
    expect(task).toContain("Started 19 minutes ago.");
  });
});
