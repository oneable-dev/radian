import { expect, test } from "bun:test";
import type { AgentProfile } from "./agent-profiles.ts";
import { resolveCommandAgent } from "./command-agent.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { InputError } from "../errors.ts";
import { err } from "../result.ts";

const profile: AgentProfile = {
  name: "planner",
  description: "Planning fixture",
  model: "fixture/first",
  thinking: "high",
  skills: [],
  tools: ["read"],
  prompt: "Plan only.",
  path: "/fixture/planner.md",
};

test("Unconfigured commands preserve parent planning without changing unrelated settings", () => {
  // Ordinary Pi settings and other command bindings must not opt this command into delegation.
  const settings = { defaultModel: "unrelated", commandAgents: { review: "planner" } };
  expect(expectOk(resolveCommandAgent("plan", {}, [profile]))).toBeNull();
  expect(expectOk(resolveCommandAgent("plan", settings, [profile]))).toBeNull();
  expect(settings.defaultModel).toBe("unrelated");
});

test("An unbound command does not discover unrelated malformed profiles", () => {
  // Legacy planning must not depend on an unused subagent catalog being valid.
  let lookups = 0;
  const broken = () => {
    lookups++;
    return err(new InputError("Malformed unrelated profile"));
  };
  expect(expectOk(resolveCommandAgent("plan", {}, broken))).toBeNull();
  expect(lookups).toBe(0);
  expect(
    expectError(resolveCommandAgent("plan", { commandAgents: { plan: "planner" } }, broken))
      .message,
  ).toContain("Malformed");
  expect(lookups).toBe(1);
});

test("Command bindings refer to the latest profile rather than a duplicated model selection", () => {
  // Only the user's profile changes between invocations.
  const settings = { commandAgents: { plan: "planner" } };
  const updated = { ...profile, model: "fixture/second", thinking: "xhigh" as const };
  expect(expectOk(resolveCommandAgent("plan", settings, [profile]))?.model).toBe("fixture/first");
  expect(expectOk(resolveCommandAgent("plan", settings, [updated]))).toBe(updated);
});

test.each(
  [
    null,
    [],
    { commandAgents: null },
    { commandAgents: [] },
    { commandAgents: { plan: "provider/model" } },
    { commandAgents: { plan: { model: "bad" } } },
    { commandAgents: { plan: "missing" } },
    { commandAgents: { "/plan": "planner" } },
  ].map((value) => [value]),
)(
  "Malformed or missing configured profiles fail instead of silently using the parent: %j",
  (settings) => {
    // An explicit routing failure must remain visible to the caller.
    expect(expectError(resolveCommandAgent("plan", settings, [profile])).code).toBe(
      "INVALID_INPUT",
    );
  },
);
