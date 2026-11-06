import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import { builtinAgents, getBuiltinAgent } from "./builtin-agents.ts";
import { discoverAgentProfiles, findAgentProfile, readAgentProfile } from "./agent-profiles.ts";
import {
  builtInAgentsEnabled,
  profileAdmission,
  profileHash,
  resolveEffectiveProfile,
  type AgentOverlay,
} from "./effective-profile.ts";
import { resolveCommandAgent } from "./command-agent.ts";

const overlay = (
  fields: unknown,
  source: AgentOverlay["source"] = "personal",
  path = "/personal/role.md",
): AgentOverlay => ({
  fields,
  source,
  path,
  body: `Additive instructions from ${path}.`,
  hash: profileHash(JSON.stringify(fields)),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "radian-effective-profile-"));
  const agent = join(root, "agent");
  const parent = join(root, "project");
  const cwd = join(parent, "nested");
  for (const path of [
    join(agent, "agents"),
    join(parent, ".pi", "agents"),
    join(cwd, ".pi", "agents"),
  ])
    await mkdir(path, { recursive: true });
  const write = (
    directory: string,
    name: string,
    fields: string,
    body = "Additional role guidance.",
  ) => writeFile(join(directory, `${name}.md`), `---\n${fields}---\n${body}\n`);
  return {
    root,
    agent,
    parent,
    cwd,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("No overlay preserves packaged prose, descriptor authority and default selection", () => {
  // Packaged roles must not depend on installed models or personal skills.
  for (const builtin of builtinAgents) {
    const profile = expectOk(
      resolveEffectiveProfile(builtin.descriptor.id, { overlays: [], projectTrusted: false }),
    );

    expect(profile.prompt).toBe(builtin.prompt);
    expect(profile.effectiveProfile.overlays).toEqual([]);
    expect(profile.effectiveProfile.model).toBeUndefined();
    expect(profile.effectiveProfile.outputContractVersions.length).toBeGreaterThan(0);
    expect(Object.isFrozen(profile.effectiveProfile.toolCeiling)).toBe(true);
    expect(profile.toolCeiling).toEqual([
      ...builtin.descriptor.toolCeiling,
      ...builtin.descriptor.verificationTools,
    ]);
  }
});

test("Personal preferences are exact and nearer trusted project fields replace without losing skills or built-in prose", async () => {
  // Each ancestor contributes instructions and skills, while scalar preferences replace.
  const app = await fixture();
  try {
    await app.write(
      join(app.agent, "agents"),
      "tech-lead",
      "model: claude-code/claude-opus-5-5\nthinking: xhigh\nskills: [evidence, code]\n",
    );
    await app.write(
      join(app.parent, ".pi", "agents"),
      "tech-lead",
      "model: fixture/far\nthinking: medium\nskills: [code, far]\n",
    );
    await app.write(
      join(app.cwd, ".pi", "agents"),
      "tech-lead",
      "model: fixture/near\nthinking: high\nskills: [near]\n",
    );

    const personal = findAgentProfile(
      expectOk(discoverAgentProfiles(app.agent, app.cwd, false)),
      "tech-lead",
    )!;
    const project = findAgentProfile(
      expectOk(discoverAgentProfiles(app.agent, app.cwd, true)),
      "tech-lead",
    )!;
    const chat = findAgentProfile(
      expectOk(discoverAgentProfiles(app.agent, app.cwd, true, { scope: "chat" })),
      "tech-lead",
    )!;

    expect(personal.model).toBe("claude-code/claude-opus-5-5");
    expect(personal.thinking).toBe("xhigh");
    expect(chat.effectiveProfile).toEqual(personal.effectiveProfile);
    expect(project.model).toBe("fixture/near");
    expect(project.thinking).toBe("high");
    expect(project.skills).toEqual(["evidence", "code", "far", "near"]);
    expect(project.prompt.startsWith(getBuiltinAgent("tech-lead")!.prompt)).toBe(true);
    expect(project.effectiveProfile?.overlays.map(({ path }) => path)).toEqual([
      join(app.agent, "agents", "tech-lead.md"),
      join(app.parent, ".pi", "agents", "tech-lead.md"),
      join(app.cwd, ".pi", "agents", "tech-lead.md"),
    ]);
    expect(project.prompt).toContain('source="project"');
    expect(project.prompt.indexOf(app.parent)).toBeLessThan(project.prompt.lastIndexOf(app.cwd));
  } finally {
    await app.cleanup();
  }
});

test("Host run choices replace preferences last and cannot restore authority removed by an overlay", () => {
  const personal = overlay({
    model: "fixture/personal",
    thinking: "high",
    tools: ["read"],
    delegation: { enabled: false },
  });
  const run = overlay(
    { model: "fixture/run", thinking: "xhigh", skills: ["code"] },
    "run",
    "host:run-choice",
  );

  const profile = expectOk(
    resolveEffectiveProfile("tech-lead", { overlays: [personal], projectTrusted: false }, run),
  );
  const widened = resolveEffectiveProfile(
    "tech-lead",
    { overlays: [personal], projectTrusted: false },
    overlay({ delegation: { enabled: true } }, "run"),
  );

  expect(profile.source).toBe("run");
  expect(profile.model).toBe("fixture/run");
  expect(profile.thinking).toBe("xhigh");
  expect(profile.skills).toEqual(["code"]);
  expect(profile.toolCeiling).toEqual(["read"]);
  expect(profile.effectiveProfile.overlays.at(-1)?.source).toBe("run");
  expect(expectError(widened).code).toBe("AGENT_OVERLAY_WIDENS");
});

test.each([
  [{ tools: ["*"] }, "AGENT_OVERLAY_WIDENS"],
  [{ tools: ["mcp__*"] }, "AGENT_OVERLAY_WIDENS"],
  [{ tools: ["write"] }, "AGENT_OVERLAY_WIDENS"],
  [{ tools: ["edit"] }, "AGENT_OVERLAY_WIDENS"],
  [{ tools: ["arbitrary"] }, "AGENT_OVERLAY_WIDENS"],
  [{ delegation: { enabled: true } }, "AGENT_OVERLAY_WIDENS"],
  [{ toolCeiling: ["*"] }, "AGENT_OVERLAY_FIELD"],
  [{ delegation: { enabled: false, maxDepth: 5 } }, "AGENT_OVERLAY_FIELD"],
  [{ thinking: "imaginary" }, "AGENT_OVERLAY_FIELD"],
  [{ name: "engineer" }, "AGENT_NAME_COLLISION"],
] as const)("QA overlay rejects invalid authority or metadata: %j", (fields, code) => {
  // Invalid preferences are admission errors, not a successful silently clamped role.
  const result = resolveEffectiveProfile("qa", {
    overlays: [overlay(fields)],
    projectTrusted: false,
  });

  expect(expectError(result).code).toBe(code);
});

test("Empty tool selection narrows to protocol-only and QA verification access stays separately classified", () => {
  const empty = expectOk(
    resolveEffectiveProfile("engineer", {
      overlays: [overlay({ tools: [] })],
      projectTrusted: false,
    }),
  );
  const qa = expectOk(
    resolveEffectiveProfile("qa", {
      overlays: [overlay({ tools: ["read", "bash", "mcp__browser_use"] })],
      projectTrusted: false,
    }),
  );

  expect(empty.tools).toEqual([]);
  expect(empty.toolCeiling).toEqual([]);
  expect(qa.toolCeiling).toEqual(["read", "bash", "mcp__browser_use"]);
  expect(qa.verificationTools).toEqual(["bash", "mcp__browser_use"]);
  expect(qa.effectiveProfile.descriptorVersion).toBe(2);
});

test("Unavailable required skills and models produce stable role-local admission errors", () => {
  const preferences = overlay({ model: "fixture/missing", skills: ["evidence"] });
  const skill = resolveEffectiveProfile("engineer", {
    overlays: [preferences],
    projectTrusted: false,
    availableSkills: [],
  });
  const model = resolveEffectiveProfile("engineer", {
    overlays: [preferences],
    projectTrusted: false,
    modelAvailable: () => false,
  });
  const complete = expectOk(
    resolveEffectiveProfile("engineer", {
      overlays: [preferences],
      projectTrusted: false,
      availableSkills: [{ name: "evidence", path: "/skill/SKILL.md", hash: "skill-hash" }],
    }),
  );

  expect(expectError(skill).code).toBe("AGENT_SKILL_MISSING");
  expect(expectError(model).code).toBe("AGENT_MODEL_UNAVAILABLE");
  expect(complete.effectiveProfile.skills).toEqual([
    { name: "evidence", path: "/skill/SKILL.md", hash: "skill-hash" },
  ]);
});

test("Invalid files, duplicates and reserved names block only affected roles while real read failures remain errors", async () => {
  const app = await fixture();
  try {
    // Several independent bad definitions must not hide the valid engineer or other built-ins.
    await app.write(join(app.agent, "agents"), "qa", "tools: ['*']\n");
    await app.write(join(app.agent, "agents"), "main", "description: Reserved\n");
    await app.write(join(app.agent, "agents"), "a", "name: pm\n");
    await app.write(join(app.agent, "agents"), "b", "name: pm\n");
    await app.write(join(app.agent, "agents"), "designer", "unexpected: true\n");
    await app.write(join(app.agent, "agents"), "custom", "description: Valid custom\n");
    await app.write(join(app.agent, "agents"), "broken", "tools: [\n");

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));

    for (const [name, code] of [
      ["qa", "AGENT_OVERLAY_WIDENS"],
      ["main", "AGENT_NAME_COLLISION"],
      ["pm", "AGENT_NAME_COLLISION"],
      ["designer", "AGENT_OVERLAY_FIELD"],
      ["broken", "AGENT_OVERLAY_FIELD"],
    ] as const) {
      const blocked = findAgentProfile(profiles, name!)!;
      expect(blocked.diagnostics?.[0]?.code).toBe(code);
      expect(expectError(profileAdmission(blocked)).code).toBe(code);
      expect(
        expectError(resolveCommandAgent("plan", { commandAgents: { plan: name } }, profiles)).code,
      ).toBe(code);
    }
    expectOk(profileAdmission(findAgentProfile(profiles, "engineer")!));
    expectOk(profileAdmission(findAgentProfile(profiles, "custom")!));
    await symlink(join(app.root, "missing.md"), join(app.agent, "agents", "io.md"));
    expect(expectError(discoverAgentProfiles(app.agent, app.cwd, false)).code).toBe(
      "RESOURCE_UNAVAILABLE",
    );
  } finally {
    await app.cleanup();
  }
});

test.each([
  ["qa", "engineer", ["qa", "engineer"]],
  ["radian:qa", "radian:engineer", ["qa", "engineer"]],
  ["custom", "engineer", ["engineer"]],
  ["custom", "radian:qa", ["qa"]],
  ["qa", "custom", ["qa"]],
] as const)("File %s with name %s blocks every involved built-in", async (stem, name, blocked) => {
  const app = await fixture();
  try {
    // Identity conflicts must block both roles even when the tool preference is valid.
    const directory = join(app.agent, "agents");
    await app.write(directory, stem, `name: ${name}\ntools: [read]\n`);

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));
    const direct = readAgentProfile(join(directory, `${stem}.md`));

    expect(expectError(direct).code).toBe("AGENT_NAME_COLLISION");
    expect(profiles).toHaveLength(7);
    for (const role of blocked) {
      const profile = findAgentProfile(profiles, role)!;
      expect(findAgentProfile(profiles, `radian:${role}`)).toBe(profile);
      expect(expectError(profileAdmission(profile)).code).toBe("AGENT_NAME_COLLISION");
      expect(profile.effectiveProfile?.overlays).toEqual([]);
    }
    expectOk(profileAdmission(findAgentProfile(profiles, "pm")!));
  } finally {
    await app.cleanup();
  }
});

test("A trusted project identity mismatch blocks both roles instead of replacing valid personal overlays", async () => {
  const app = await fixture();
  try {
    // A nearer configuration must not make either conflicting identity admissible.
    await app.write(join(app.agent, "agents"), "qa", "tools: [read]\n");
    await app.write(join(app.agent, "agents"), "engineer", "tools: [read]\n");
    await app.write(join(app.cwd, ".pi", "agents"), "qa", "name: engineer\ntools: [edit]\n");

    const trusted = expectOk(discoverAgentProfiles(app.agent, app.cwd, true));
    const untrusted = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));

    for (const role of ["qa", "engineer"]) {
      expect(expectError(profileAdmission(findAgentProfile(trusted, role)!)).code).toBe(
        "AGENT_NAME_COLLISION",
      );
      expectOk(profileAdmission(findAgentProfile(untrusted, role)!));
    }
  } finally {
    await app.cleanup();
  }
});

test.each([
  ["qa", "qa"],
  ["qa", "radian:qa"],
  ["radian:qa", "qa"],
  ["radian:qa", "radian:qa"],
  ["qa", undefined],
  ["radian:qa", undefined],
] as const)("File %s with name %s is one canonical QA overlay", async (stem, name) => {
  const app = await fixture();
  try {
    // An alias changes spelling, never the underlying role identity.
    const directory = join(app.agent, "agents");
    await app.write(directory, stem, `${name ? `name: ${name}\n` : ""}tools: [read]\n`);

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));
    const profile = findAgentProfile(profiles, "qa")!;
    const direct = expectOk(readAgentProfile(join(directory, `${stem}.md`)));

    expect(profiles).toHaveLength(7);
    expect(findAgentProfile(profiles, "radian:qa")).toBe(profile);
    expectOk(profileAdmission(profile));
    expect(profile.tools).toEqual(["read"]);
    expect(direct.effectiveProfile).toEqual(profile.effectiveProfile);
    expect(profile.effectiveProfile?.overlays[0]?.path).toBe(join(directory, `${stem}.md`));
  } finally {
    await app.cleanup();
  }
});

test.each(
  builtinAgents.flatMap(({ descriptor }) =>
    (["personal", "project"] as const).map((source) => [source, descriptor.id] as const),
  ),
)(
  "%s %s alias parse and field failures block canonical admission without an alias row",
  async (source, role) => {
    const app = await fixture();
    try {
      const directory =
        source === "personal" ? join(app.agent, "agents") : join(app.cwd, ".pi", "agents");
      // Malformed YAML and valid YAML with invalid fields must reserve the same role identity.
      for (const fields of ["tools: [\n", "tools: invalid\n", "unknown: true\n"]) {
        await app.write(directory, `radian:${role}`, fields);

        const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, true));
        const profile = findAgentProfile(profiles, role)!;

        // Diagnostics belong only to the canonical row, never to a separately selectable alias.
        expect(profiles).toHaveLength(7);
        expect(profiles.some(({ name }) => name === `radian:${role}`)).toBe(false);
        expect(findAgentProfile(profiles, `radian:${role}`)).toBe(profile);
        expect(expectError(profileAdmission(profile)).code).toBe("AGENT_OVERLAY_FIELD");
        expect(profile.diagnostics?.[0]?.path).toBe(join(directory, `radian:${role}.md`));
        for (const other of profiles.filter(({ name }) => name !== role)) {
          expect(other.diagnostics).toBeUndefined();
          expectOk(profileAdmission(other));
        }
      }
    } finally {
      await app.cleanup();
    }
  },
);

test.each([undefined, "qa", "radian:qa"])(
  "Canonical and alias files in one directory collide even if malformed=%s",
  async (malformed) => {
    const app = await fixture();
    try {
      const directory = join(app.agent, "agents");
      await app.write(directory, "qa", malformed === "qa" ? "tools: [\n" : "tools: [read]\n");
      await app.write(
        directory,
        "radian:qa",
        malformed === "radian:qa" ? "tools: [\n" : "tools: [read]\n",
      );

      const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));
      const profile = findAgentProfile(profiles, "qa")!;

      expect(profiles).toHaveLength(7);
      expect(profile.diagnostics?.some(({ code }) => code === "AGENT_NAME_COLLISION")).toBe(true);
      expect(profileAdmission(profile).ok).toBe(false);
    } finally {
      await app.cleanup();
    }
  },
);

test("Custom filename and declared name keep legacy replacement and flag-off semantics", async () => {
  const app = await fixture();
  try {
    const directory = join(app.agent, "agents");
    const project = join(app.cwd, ".pi", "agents");
    await app.write(
      directory,
      "custom-file",
      "name: custom-name\ndescription: Personal custom\ntools: [read]\n",
    );
    await app.write(
      project,
      "another-file",
      "name: custom-name\ndescription: Project custom\ntools: []\n",
    );
    // Flag-off still permits the old declared-name replacement, including reserved stems.
    await app.write(directory, "qa", "name: engineer\ndescription: Legacy rename\ntools: [edit]\n");

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, true));
    const legacyProfiles = expectOk(
      discoverAgentProfiles(app.agent, app.cwd, true, { builtInAgents: false }),
    );

    expect(findAgentProfile(profiles, "custom-name")).toMatchObject({
      description: "Project custom",
      tools: [],
      path: join(project, "another-file.md"),
    });
    expect(findAgentProfile(profiles, "custom-file")).toBeUndefined();
    expect(JSON.stringify(legacyProfiles)).toBe(
      JSON.stringify([
        expectOk(readAgentProfile(join(project, "another-file.md"), false)),
        expectOk(readAgentProfile(join(directory, "qa.md"), false)),
      ]),
    );
  } finally {
    await app.cleanup();
  }
});

// Sanitized frontmatter copies of the seven dotfiles profiles. Only descriptions and prose
// are replaced; exact model/thinking/skills, tool selections and delegation are preserved.
const research = [
  "read",
  "grep",
  "find",
  "ls",
  "web_enable",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
];
const legacy = [
  {
    name: "designer",
    model: "claude-code/claude-sonnet-5-5",
    thinking: "high",
    skills: ["work-with-evidence"],
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      ...research.slice(4),
      "mcp__figma_remote",
      "mcp__spline",
    ],
  },
  {
    name: "engineer",
    model: "openai-codex/gpt-6.1-sol",
    thinking: "high",
    skills: ["write-good-code", "work-with-evidence"],
  },
  {
    name: "pm",
    model: "openai-codex/gpt-6.1-sol",
    thinking: "high",
    skills: ["work-with-evidence"],
    tools: ["read", "grep", "find", "ls", "edit", "write", ...research.slice(4)],
  },
  {
    name: "product-lead",
    model: "openai-codex/gpt-6-astra",
    thinking: "xhigh",
    skills: ["work-with-evidence"],
    tools: research,
    delegation: { enabled: true },
  },
  {
    name: "qa",
    model: "openai-codex/gpt-6-astra",
    thinking: "high",
    skills: ["work-with-evidence", "verify-changes"],
    tools: ["read", "grep", "find", "ls", "bash", "mcp__browser_use"],
  },
  {
    name: "tech-lead",
    model: "claude-code/claude-opus-5-5",
    thinking: "xhigh",
    skills: ["write-good-code", "work-with-evidence"],
    tools: research,
    delegation: { enabled: true },
  },
  {
    name: "ui-ux-lead",
    model: "claude-code/claude-opus-5-5",
    thinking: "xhigh",
    skills: ["work-with-evidence"],
    tools: [...research, "mcp__figma_remote", "mcp__spline"],
    delegation: { enabled: true },
  },
] as const;

test("All seven dotfiles-shaped files load as overlays without preference or capability changes", async () => {
  const app = await fixture();
  try {
    for (const data of legacy)
      await app.write(
        join(app.agent, "agents"),
        data.name,
        Object.entries({ ...data, description: "Sanitized legacy fixture" })
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
          .join(""),
      );

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.cwd, false));

    expect(profiles).toHaveLength(7);
    for (const data of legacy) {
      const profile = findAgentProfile(profiles, data.name)!;
      const old = expectOk(readAgentProfile(join(app.agent, "agents", `${data.name}.md`), false));
      expect(profile.diagnostics).toBeUndefined();
      expect(profile.model).toBe(data.model);
      expect(profile.thinking).toBe(data.thinking);
      expect(profile.skills).toEqual(data.skills);
      expect(profile.tools).toEqual(old.tools);
      expect(profile.delegation?.enabled).toBe(old.delegation?.enabled ?? false);
      expect(profile.prompt).toContain(getBuiltinAgent(data.name)!.prompt);
      expect(profile.effectiveProfile?.overlays[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  } finally {
    await app.cleanup();
  }
});

test("Flag off restores the byte-for-byte legacy list shape without source or built-in metadata", async () => {
  const app = await fixture();
  try {
    await app.write(
      join(app.agent, "agents"),
      "qa",
      "name: qa\ndescription: Legacy QA\nmodel: fixture/model\nthinking: xhigh\nskills: [evidence]\ntools: ['*']\ndelegation: {enabled: true}\n",
    );
    const enabled = expectOk(builtInAgentsEnabled({ radian: { builtInAgents: "off" } }));

    const profiles = expectOk(
      discoverAgentProfiles(app.agent, app.cwd, false, { builtInAgents: enabled }),
    );
    const list = profiles.map(({ prompt: _prompt, ...entry }) => entry);

    expect(JSON.stringify(list)).toBe(
      JSON.stringify([
        {
          name: "qa",
          description: "Legacy QA",
          model: "fixture/model",
          thinking: "xhigh",
          skills: ["evidence"],
          tools: ["*"],
          delegation: { enabled: true },
          path: join(app.agent, "agents", "qa.md"),
        },
      ]),
    );
    expect(findAgentProfile(profiles, "radian:qa")).toBeUndefined();
    expect(expectOk(builtInAgentsEnabled({}))).toBe(true);
    expect(expectError(builtInAgentsEnabled({ radian: { builtInAgents: false } })).code).toBe(
      "AGENT_OVERLAY_FIELD",
    );
  } finally {
    await app.cleanup();
  }
});
