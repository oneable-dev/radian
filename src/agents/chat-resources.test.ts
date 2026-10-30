import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";

test("CHAT reload rereads user extension, skill and package paths without writing global model defaults", async () => {
  // Paths live outside conventional discovery so only a settings reload can change the catalog.
  const directory = await mkdtemp(join(tmpdir(), "radian-chat-reload-"));
  const agentDir = join(directory, "agent");
  const project = join(directory, "project");
  const settingsFile = join(agentDir, "settings.json");
  let executor: Awaited<ReturnType<ReturnType<typeof piSessionFactory>>> | undefined;
  try {
    await mkdir(agentDir);
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ extensions: [join(directory, "project.ts")] }),
    );
    await writeFile(join(directory, "project.ts"), extension("project_only"));
    const settings = async (version: string) => {
      const extensionPath = join(directory, `${version}.ts`);
      const skillDir = join(directory, `${version}-skills`);
      const packageDir = join(directory, `${version}-package`);
      await writeFile(extensionPath, extension(`${version}_extension`));
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: ${version}-skill\ndescription: Reload fixture skill.\n---\nUse this fixture skill.\n`,
      );
      await mkdir(join(packageDir, "extensions"), { recursive: true });
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: `fixture-${version}` }),
      );
      await writeFile(join(packageDir, "extensions", "index.ts"), extension(`${version}_package`));
      return JSON.stringify({
        extensions: [extensionPath],
        skills: [skillDir],
        packages: [packageDir],
        defaultProvider: "global-only",
        defaultModel: version,
        defaultThinkingLevel: "high",
      });
    };
    const initialSettings = await settings("before");
    await writeFile(settingsFile, initialSettings);
    const {
      streamFn: _stream,
      model: _model,
      ...fixture
    } = await offlineRuntime(join(directory, "offline"));
    fixture.modelRuntime!.registerProvider("chat-selected", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      models: [
        {
          id: "reasoning",
          name: "Selected CHAT model",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    executor = await piSessionFactory({
      ...fixture,
      agentDir,
      sessionDir: join(directory, "sessions"),
      defaultPackagePaths: [],
      chatDefaults: () => ({ provider: "radian-offline", model: "fixture", effort: "off" }),
    })({
      cwd: project,
      scope: { kind: "chat" },
      role: "main",
      spawnSubagent: async () => {
        throw new Error("No subagent expected.");
      },
    });
    const before = executor.commands?.().map((item) => item.value);
    expect(before).toContain("before_extension");
    expect(before).toContain("before_package");
    expect(before).toContain("skill:before-skill");
    expectOk(await executor.selectModel!({ provider: "chat-selected", id: "reasoning" }, "high"));
    const current = expectOk(await executor.models!());
    expect(current).toMatchObject({
      current: { provider: "chat-selected", id: "reasoning" },
      effort: "high",
    });
    expect(await readFile(settingsFile, "utf8")).toBe(initialSettings);
    const changedSettings = await settings("after");
    await writeFile(settingsFile, changedSettings);

    // Reload updates resources while the accepted CHAT model and effort remain session-local.
    expectOk(await executor.reload!());
    const after = executor.commands?.().map((item) => item.value);

    expect(after).toContain("after_extension");
    expect(after).toContain("after_package");
    expect(after).toContain("skill:after-skill");
    expect(after).not.toContain("before_extension");
    expect(after).not.toContain("before_package");
    expect(after).not.toContain("skill:before-skill");
    expect(after).not.toContain("project_only");
    expect(expectOk(await executor.models!())).toMatchObject({
      current: current.current,
      effort: current.effort,
    });
    expect(executor.state.resourceRevision).toBe(1);
    expectOk(await executor.close());
    executor = undefined;
    expect(await readFile(settingsFile, "utf8")).toBe(changedSettings);
  } finally {
    if (executor) expectOk(await executor.close());
    await rm(directory, { recursive: true, force: true });
  }
});

const extension = (name: string) =>
  `export default function (pi) { pi.registerCommand("${name}", { description: "test resource", handler: async () => {} }); }`;

test("CHAT loads user extensions without loading launch-project settings or extensions", async () => {
  // Even if a caller supplies a project cwd, CHAT resource policy must use only global inputs.
  const directory = await mkdtemp(join(tmpdir(), "radian-chat-resources-"));
  const agentDir = join(directory, "user-agent");
  const project = join(directory, "project");
  const sessionDir = join(directory, "sessions");
  let executor: Awaited<ReturnType<ReturnType<typeof piSessionFactory>>> | undefined;
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "global.ts"), extension("global_only"));
    await writeFile(join(project, ".pi", "extensions", "project.ts"), extension("project_only"));
    await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ defaultTools: [] }));
    const { streamFn: _stream, ...fixture } = await offlineRuntime(join(directory, "offline"));
    executor = await piSessionFactory({
      ...fixture,
      agentDir,
      sessionDir,
      defaultPackagePaths: [],
    })({
      cwd: project,
      scope: { kind: "chat" },
      role: "main",
      spawnSubagent: async () => {
        throw new Error("No subagent expected.");
      },
    });
    const commands = executor.commands?.().map((item) => item.value);
    expect(commands).toContain("global_only");
    expect(commands).not.toContain("project_only");
  } finally {
    if (executor) expect((await executor.close()).ok).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
