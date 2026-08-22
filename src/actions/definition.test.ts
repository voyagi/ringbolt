import { describe, expect, it } from "vitest";
import {
  actionDefinitionInput,
  actionHost,
  actionUrlProblem,
  spokenLines,
} from "./definition.js";

const killSwitch = {
  label: "Turn the feature off",
  spokenDescription: "turn the feature off",
  target: { kind: "service_state", operation: "kill_switch_on" },
};

const http = {
  label: "Restart the workers",
  spokenDescription: "restart the workers, which drops every job in flight",
  target: {
    kind: "http",
    method: "POST",
    url: "https://deploy.example.com/services/checkout/restart",
  },
};

/** The refusals as one string, so a test can name the reason it expects rather than a position. */
function problems(input: unknown): string {
  const parsed = actionDefinitionInput.safeParse(input);
  return parsed.success
    ? ""
    : parsed.error.issues.map((issue) => issue.message).join(" | ");
}

describe("what an action definition may say", () => {
  it("accepts the shortest useful one and fills in the rest", () => {
    const parsed = actionDefinitionInput.parse(killSwitch);
    expect(parsed).toMatchObject({
      confirmationPhrase: null,
      minConfidence: null,
      parameters: [],
      verify: null,
    });
  });

  it("accepts an http action with a value substituted into the url and the body", () => {
    const parsed = actionDefinitionInput.parse({
      ...http,
      parameters: [
        {
          name: "release",
          description: "which release to go to",
          type: "string",
        },
      ],
      target: {
        ...http.target,
        url: "https://deploy.example.com/releases/{release}/activate",
        body: { release: "{release}", reason: "authorized by Ringbolt" },
        headers: { "x-api-key": { fromSecret: "RUNBOOK_SECRET_DEPLOY" } },
      },
    });
    expect(parsed.target).toMatchObject({ timeoutMs: 5_000, maxAttempts: 1 });
  });
});

describe("the urls an action may call", () => {
  it("refuses anything that is not https", () => {
    expect(actionUrlProblem("http://deploy.example.com/go")).toContain("https");
    expect(actionUrlProblem("file:///etc/passwd")).toContain("https");
  });

  /**
   * Ringbolt makes this request from inside its own network on the say-so of a database row, which
   * is the shape of every request-forgery bug. The cloud metadata address is the one that turns it
   * into a credential leak, so it is named here rather than left to the general rule.
   */
  it("refuses an address literal, the metadata address included", () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.1"]) {
      expect(actionUrlProblem(`https://${host}/latest/meta-data/`)).toContain(
        "address literal",
      );
    }
    expect(actionUrlProblem("https://[::1]/")).toContain("address literal");
  });

  it("refuses a name that only exists inside a network", () => {
    expect(actionUrlProblem("https://localhost/go")).toContain("public host");
    expect(actionUrlProblem("https://metadata.google.internal/")).toContain(
      "private host",
    );
    expect(actionUrlProblem("https://printer.local/")).toContain("private");
    expect(actionUrlProblem("https://vault/")).toContain("public host");
  });

  it("refuses credentials in the url and a port that is not the https one", () => {
    expect(actionUrlProblem("https://user:pass@deploy.example.com/")).toContain(
      "credentials",
    );
    expect(actionUrlProblem("https://deploy.example.com:8080/")).toContain(
      "https port",
    );
    expect(actionUrlProblem("https://deploy.example.com:443/")).toBeNull();
  });

  it("reads the host through a placeholder rather than giving up on it", () => {
    expect(actionHost("https://deploy.example.com/{release}/go")).toBe(
      "deploy.example.com",
    );
    expect(actionHost("https://127.0.0.1/{release}")).toBeNull();
  });
});

describe("the guardrails a whole definition has to pass", () => {
  it("refuses a credential written into the definition rather than named", () => {
    expect(
      problems({
        ...http,
        target: {
          ...http.target,
          headers: { Authorization: "Bearer sk-live-not-a-real-token" },
        },
      }),
    ).toContain("fromSecret");
  });

  it("refuses a binding that is not one of the runbook secrets", () => {
    expect(
      problems({
        ...http,
        target: {
          ...http.target,
          headers: { authorization: { fromSecret: "CALLE_API_KEY" } },
        },
      }),
    ).not.toBe("");
  });

  it("refuses a placeholder that no required parameter answers", () => {
    expect(
      problems({
        ...http,
        target: {
          ...http.target,
          url: "https://deploy.example.com/{release}/go",
        },
      }),
    ).toContain("{release}");

    expect(
      problems({
        ...http,
        parameters: [
          {
            name: "release",
            description: "which release",
            type: "string",
            required: false,
          },
        ],
        target: {
          ...http.target,
          url: "https://deploy.example.com/{release}/go",
        },
      }),
    ).toContain("not a required parameter");
  });

  /**
   * A request that never came back may have been carried out anyway, so retrying one is a decision
   * about the far side rather than about us. Only a definition that says so may.
   */
  it("refuses retries on an action that has not said it is idempotent", () => {
    expect(
      problems({ ...http, target: { ...http.target, maxAttempts: 3 } }),
    ).toContain("idempotent");

    expect(
      problems({
        ...http,
        target: { ...http.target, maxAttempts: 3, idempotent: true },
      }),
    ).toBe("");
  });

  it("refuses a check on an action that is always read back anyway", () => {
    expect(
      problems({
        ...killSwitch,
        verify: {
          url: "https://status.example.com/checkout",
          jsonPath: ["healthy"],
          equals: true,
        },
      }),
    ).toContain("service_state");
  });

  it("refuses two parameters with one name, and a range that excludes everything", () => {
    expect(
      problems({
        ...killSwitch,
        parameters: [
          { name: "size", description: "how many", type: "number" },
          { name: "size", description: "again", type: "number" },
        ],
      }),
    ).toContain("same name");

    expect(
      problems({
        ...killSwitch,
        parameters: [
          {
            name: "size",
            description: "how many",
            type: "number",
            min: 10,
            max: 2,
          },
        ],
      }),
    ).toContain("minimum above its maximum");
  });

  it("refuses a check whose own url is one that may not be called", () => {
    expect(
      problems({
        ...http,
        verify: {
          url: "https://169.254.169.254/latest/",
          jsonPath: ["ok"],
          equals: true,
        },
      }),
    ).toContain("address literal");
  });
});

describe("what the caller reads out", () => {
  it("names the action, what it does, what it needs, and the words to confirm it", () => {
    const line = spokenLines({
      id: "rollback",
      spokenDescription: "roll back to the previous release",
      confirmationPhrase: "roll it back",
      parameters: [
        {
          name: "release",
          description: "which release to go back to",
          type: "string",
          required: false,
          maxLength: 80,
        },
      ],
    });

    expect(line).toContain("rollback:");
    expect(line).toContain(
      "Ask them for: release (which release to go back to)",
    );
    expect(line).toContain('say the exact words "roll it back"');
  });
});
