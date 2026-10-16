import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { sessionCommands } from "./session-commands.ts";

test("명령 카탈로그는 SDK 확장·템플릿·활성화된 Skill을 합치되 CLI 기본 명령은 광고하지 않는다", async () => {
  // Explicit resource paths keep discovery independent from the user's installed resources.
  const directory = await mkdtemp(join(tmpdir(), "radian-command-catalog-"));
  let session: AgentSession | undefined;
  try {
    const agentDir = join(directory, "agent"); const options = await offlineRuntime(agentDir);
    if (!options.modelRuntime || !options.model) throw new Error("Offline model fixture is missing.");
    const skill = join(directory, "fixture-skill"); await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill\n---\nDo a fixture task.\n");
    const template = join(directory, "fixture-template.md"); await writeFile(template, "---\ndescription: Fixture template\n---\nInspect $ARGUMENTS\n");
    const settingsManager = SettingsManager.inMemory({ enableSkillCommands: true });
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
      noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      additionalSkillPaths: [skill], additionalPromptTemplatePaths: [template],
      extensionFactories: [(pi) => pi.registerCommand("fixture-command", { description: "Fixture extension", handler: async () => {} })],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: directory, agentDir, resourceLoader, settingsManager,
      modelRuntime: options.modelRuntime, model: options.model, sessionManager: SessionManager.inMemory(directory) }));
    await session.bindExtensions({});

    const commands = sessionCommands(session);
    expect(commands.map((item) => [item.kind, item.value])).toEqual([
      ["command", "fixture-command"], ["template", "fixture-template"], ["skill", "skill:fixture-skill"],
    ]);
    expect(commands.some((item) => item.value === "model" || item.value === "settings")).toBe(false);
    settingsManager.applyOverrides({ enableSkillCommands: false });
    expect(sessionCommands(session).some((item) => item.kind === "skill")).toBe(false);
    expect(session.messages).toEqual([]);
  } finally { session?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
