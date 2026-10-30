import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  childSkills,
  discoverAgentProfiles,
  readAgentProfile,
  roleInstructions,
} from "./agent-profiles.ts";
import { expectError, expectOk } from "../testing/results.ts";

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
  return { root, agent, project, write, cleanup: () => rm(root, { recursive: true, force: true }) };
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

      expect(expectError(result).code).toBe("RESOURCE_UNAVAILABLE");
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
