import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  childSkills,
  delegates,
  discoverAgentProfiles,
  findAgentProfile,
  readAgentProfile,
  roleInstructions,
} from "./agent-profiles.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { builtinAgents, getBuiltinAgent } from "./builtin-agents.ts";
import { resolveCommandAgent } from "./command-agent.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "radian-profiles-"));
  const agent = join(root, "agent");
  const project = join(root, "project");
  await Promise.all(
    [join(agent, "agents"), join(project, ".pi", "agents")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const write = (directory: string, name: string, extra = "") =>
    writeFile(
      join(directory, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} role\n${extra}---\nPerform the assigned role.\n`,
    );
  return {
    root,
    agent,
    project,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("Project agent overrides require trust and preserve user models, skills and exact tool limits", async () => {
  // Untrusted repositories must not replace a user's executable agent profile.
  const app = await fixture();
  try {
    await app.write(
      join(app.agent, "agents"),
      "reviewer",
      "model: fixture/model\nthinking: high\nskills: [review-code]\ntools: [read, grep]\n",
    );
    await app.write(join(app.project, ".pi", "agents"), "reviewer", "tools: []\n");

    const user = expectOk(discoverAgentProfiles(app.agent, app.project, false));
    const project = expectOk(discoverAgentProfiles(app.agent, app.project, true));

    expect(user[0]).toMatchObject({
      model: "fixture/model",
      thinking: "high",
      skills: ["review-code"],
      tools: ["read", "grep"],
    });
    expect(project[0]?.tools).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

test.each([
  "tools: read\n",
  "tools: [+write]\n",
  "tools: [-bash]\n",
  "thinking: imaginary\n",
  "model: ambiguous\n",
  "extensions: old-path\n",
  "skills: [true]\n",
  "tools: [\n",
])(
  "Invalid profile fails explicitly instead of silently widening capabilities: %s",
  async (extra) => {
    // Stale and malformed configuration must not be accepted as an unrestricted role.
    const app = await fixture();
    try {
      await app.write(join(app.agent, "agents"), "reviewer", extra);

      const result = readAgentProfile(join(app.agent, "agents", "reviewer.md"));

      expect(expectError(result).code).toBe(
        extra === "tools: [\n" ? "AGENT_OVERLAY_FIELD" : "RESOURCE_UNAVAILABLE",
      );
    } finally {
      await app.cleanup();
    }
  },
);

test("Role instructions contain profile guidance without injecting a runtime protocol", async () => {
  // Profile compilation must remain independent of a particular host's delegation API.
  const app = await fixture();
  try {
    await app.write(join(app.agent, "agents"), "reviewer");
    const profile = expectOk(readAgentProfile(join(app.agent, "agents", "reviewer.md")));

    // Compile the role without any workflow skill installed.
    const instructions = expectOk(roleInstructions(profile, []));

    // Host-specific reporting and delegation instructions belong to the session factory.
    expect(instructions).toContain("Perform the assigned role.");
    expect(instructions).not.toContain("radian-supervisor");
    expect(instructions).not.toContain("Do not delegate");
  } finally {
    await app.cleanup();
  }
});

test.each(["coordinate-work", "subagent"])(
  "Parent-only metadata filters skill %s and cannot be bypassed by required role skills",
  async (parentName) => {
    // Scope is declared by metadata, not by a hardcoded orchestration skill name.
    const app = await fixture();
    try {
      for (const [name, metadata] of [
        [parentName, 'metadata:\n  parentOnly: "true"\n'],
        ["inspect-code", ""],
      ]) {
        const directory = join(app.agent, "skills", name!);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture instructions\n${metadata}---\nInstructions for ${name}.\n`,
        );
      }
      const loader = new DefaultResourceLoader({
        agentDir: app.agent,
        cwd: app.project,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
      });
      await loader.reload();
      await app.write(join(app.agent, "agents"), "reviewer", `skills: [${parentName}]\n`);

      const visible = expectOk(childSkills(loader.getSkills().skills));
      const instructions = roleInstructions(
        expectOk(readAgentProfile(join(app.agent, "agents", "reviewer.md"))),
        visible,
      );

      expect(visible.map((skill) => skill.name)).toEqual(["inspect-code"]);
      expect(expectError(instructions).message).toContain("parent-only");
      expect(loader.getSkills().skills.map((skill) => skill.name)).toContain(parentName);
    } finally {
      await app.cleanup();
    }
  },
);

test("Delegation metadata accepts only a strict enabled boolean and keeps explicit false", async () => {
  // Any profile name may opt in; there is no role-name privilege or target allowlist.
  const app = await fixture();
  try {
    const directory = join(app.agent, "agents");
    await app.write(directory, "anyone", "tools: []\ndelegation:\n  enabled: true\n");
    await app.write(directory, "leaf", "delegation: { enabled: false }\n");
    await app.write(directory, "plain");

    const profiles = expectOk(discoverAgentProfiles(app.agent, app.project, false));
    const byName = new Map(profiles.map((profile) => [profile.name, profile]));

    expect(byName.get("anyone")?.delegation).toEqual({ enabled: true });
    expect(byName.get("leaf")?.delegation).toEqual({ enabled: false });
    expect(byName.get("plain")?.delegation).toBeUndefined();
    for (const [index, value] of [
      "delegation: true\n",
      "delegation: {}\n",
      'delegation: { enabled: "true" }\n',
      "delegation: { enabled: true, allowedAgents: [worker] }\n",
      "delegation: { enabled: true, maxDepth: 2 }\n",
    ].entries()) {
      await app.write(directory, `invalid${index}`, value);
      expect(expectError(readAgentProfile(join(directory, `invalid${index}.md`))).code).toBe(
        "RESOURCE_UNAVAILABLE",
      );
    }
  } finally {
    await app.cleanup();
  }
});

test.each([false, true])(
  "Missing or empty personal agents directory supplies every built-in: exists=%s",
  async (exists) => {
    const app = await fixture();
    try {
      // Absence must not require profile installation or a copied private skill.
      if (!exists) await rm(join(app.agent, "agents"), { recursive: true });
      const profiles = expectOk(discoverAgentProfiles(app.agent, app.project, false));

      expect(profiles.map(({ name }) => name)).toEqual(
        builtinAgents.map(({ descriptor }) => descriptor.id),
      );
      for (const profile of profiles) {
        expect(profile.source).toBe("builtin");
        expect(profile.model).toBeUndefined();
        expect(profile.thinking).toBeUndefined();
        expect(profile.skills).toEqual([]);
        expect(expectOk(roleInstructions(profile, []))).toContain(profile.prompt);
        expect(findAgentProfile(profiles, `radian:${profile.name}`)).toBe(profile);
        expect(
          expectOk(
            resolveCommandAgent(
              "plan",
              { commandAgents: { plan: `radian:${profile.name}` } },
              profiles,
            ),
          ),
        ).toBe(profile);
      }
    } finally {
      await app.cleanup();
    }
  },
);

test("Same-name legacy files preserve prose and model but cannot widen built-in descriptor authority", async () => {
  const app = await fixture();
  try {
    // Legacy role settings remain usable; authority belongs to the built-in identity instead.
    await app.write(
      join(app.agent, "agents"),
      "qa",
      "model: fixture/model\ndelegation: { enabled: true }\ntools: ['*']\n",
    );
    await app.write(
      join(app.project, ".pi", "agents"),
      "qa",
      "delegation: { enabled: true }\ntools: [write, bash]\n",
    );
    await app.write(join(app.agent, "agents"), "tech-lead", "delegation: { enabled: false }\n");

    const personal = expectOk(discoverAgentProfiles(app.agent, app.project, false));
    const project = expectOk(discoverAgentProfiles(app.agent, app.project, true));
    const qa = findAgentProfile(personal, "radian:qa")!;
    const direct = readAgentProfile(join(app.agent, "agents", "qa.md"));

    // Invalid overlays block only this identity, never replace the host's built-in prose.
    expect(qa.diagnostics?.[0]?.code).toBe("AGENT_OVERLAY_WIDENS");
    expect(expectError(direct).code).toBe("AGENT_OVERLAY_WIDENS");
    expect(qa.prompt).toBe(getBuiltinAgent("qa")!.prompt);
    expect(qa.toolCeiling).not.toContain("*");
    expect(qa.toolCeiling).not.toContain("write");
    expect(qa.builtin).toBe(getBuiltinAgent("qa")!.descriptor);
    expect(delegates({ ...qa, delegation: { enabled: true } })).toBe(false);
    expect(findAgentProfile(project, "qa")?.diagnostics?.[0]?.code).toBe("AGENT_OVERLAY_WIDENS");
    expect(findAgentProfile(project, "qa")?.builtin).toBe(qa.builtin);
    expect(delegates(findAgentProfile(personal, "tech-lead"))).toBe(false);
    expect(qa.builtin?.toolCeiling).not.toContain("write");
    expect(qa.builtin?.toolCeiling).not.toContain("bash");
  } finally {
    await app.cleanup();
  }
});

test("Custom profiles keep discovery precedence, exact preferences and source identity", async () => {
  const app = await fixture();
  try {
    await app.write(
      join(app.agent, "agents"),
      "custom-worker",
      "model: fixture/custom\nskills: [custom-skill]\ntools: [read]\ndelegation: { enabled: true }\n",
    );
    await app.write(join(app.project, ".pi", "agents"), "custom-worker", "tools: []\n");

    const personal = findAgentProfile(
      expectOk(discoverAgentProfiles(app.agent, app.project, false)),
      "custom-worker",
    )!;
    const project = findAgentProfile(
      expectOk(discoverAgentProfiles(app.agent, app.project, true)),
      "custom-worker",
    )!;

    expect(personal).toMatchObject({
      source: "personal",
      model: "fixture/custom",
      skills: ["custom-skill"],
      tools: ["read"],
      delegation: { enabled: true },
    });
    expect(personal.builtin).toBeUndefined();
    expect(delegates(personal)).toBe(true);
    expect(project).toMatchObject({ source: "project", tools: [] });
    expect(project.model).toBeUndefined();
    expect(findAgentProfile([personal], "radian:custom-worker")).toBeUndefined();
    await app.write(join(app.agent, "agents"), "main");
    expect(expectError(readAgentProfile(join(app.agent, "agents", "main.md"))).message).toContain(
      "root session",
    );
  } finally {
    await app.cleanup();
  }
});
