import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentProfile } from "./agent-profiles.ts";
import { expectOk } from "../testing/results.ts";

const directory = fileURLToPath(new URL("../../resources/agents/", import.meta.url));
const roles = [
  ["product-lead", "openai-codex/gpt-6-astra", "xhigh", true],
  ["pm", "openai-codex/gpt-6.1-sol", "high", false],
  ["tech-lead", "claude-code/claude-opus-5-5", "xhigh", true],
  ["engineer", "openai-codex/gpt-6.1-sol", "high", false],
  ["ui-ux-lead", "claude-code/claude-opus-5-5", "xhigh", true],
  ["designer", "claude-code/claude-sonnet-5-5", "high", false],
  ["qa", "openai-codex/gpt-6-astra", "high", false],
] as const;

test.each(roles)(
  "The %s example parses with the agreed model, effort and delegation capability",
  (name, model, thinking, delegating) => {
    // Examples are portable profile definitions, not automatically installed global configuration.
    const profile = expectOk(readAgentProfile(join(directory, `${name}.md`)));

    expect(profile.name).toBe(name);
    expect(profile.model).toBe(model);
    expect(profile.thinking).toBe(thinking);
    expect(profile.delegation?.enabled === true).toBe(delegating);
    expect(profile.skills).toContain("work-with-evidence");
    expect(profile.prompt).toContain("Korean");
  },
);

test("Only the seven domain profiles are shipped and QA reuses the existing browser server proxy", () => {
  // A directory copied into agents must not contain a README or stale stage-specific profile.
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const qa = expectOk(readAgentProfile(join(directory, "qa.md")));

  expect(files).toEqual(roles.map(([name]) => `${name}.md`).sort());
  // Server-level access avoids changing MCP configuration; helper restrictions remain instructions.
  // Do not grant the all-server gateway, unrelated namespaces or product-edit tools.
  expect(qa.tools).toEqual(["read", "grep", "find", "ls", "bash", "mcp__browser_use"]);
});
