import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAgents, getBuiltinAgent } from "./builtin-agents.ts";

const ids = ["product-lead", "tech-lead", "ui-ux-lead", "pm", "engineer", "designer", "qa"];

test("Built-in descriptors are complete, immutable and independent of personal configuration", async () => {
  // The public registry must ship all seven roles without root or local skill dependencies.
  expect(builtinAgents.map(({ descriptor }) => descriptor.id)).toEqual(ids);
  expect(getBuiltinAgent("main")).toBeUndefined();
  expect(getBuiltinAgent("radian:main")).toBeUndefined();
  expect(Object.isFrozen(builtinAgents)).toBe(true);

  for (const agent of builtinAgents) {
    const { descriptor, prompt } = agent;
    const asset = await readFile(
      new URL(`../../resources/agents/${descriptor.id}.md`, import.meta.url),
      "utf8",
    );

    // Source imports must preserve the exact bytes hashed by the host descriptor.
    expect(prompt).toBe(asset);
    expect(descriptor.promptHash).toBe(createHash("sha256").update(asset).digest("hex"));
    expect(getBuiltinAgent(`radian:${descriptor.id}`)).toBe(agent);
    expect(descriptor.descriptorVersion).toBe(descriptor.id === "qa" ? 2 : 1);
    expect(descriptor.workflowRoles.length).toBeGreaterThan(0);
    expect(descriptor.purposes).toEqual(["planning", "analysis", "execution"]);
    expect(descriptor.outputContracts.length).toBeGreaterThan(0);
    expect(descriptor.delegation.enabled).toBe(ids.slice(0, 3).includes(descriptor.id));
    for (const value of [
      agent,
      descriptor,
      descriptor.aliases,
      descriptor.workflowRoles,
      descriptor.purposes,
      descriptor.delegation,
      descriptor.toolCeiling,
      descriptor.verificationTools,
      descriptor.outputContracts,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    // Packaged instructions must not carry a personal provider, effort, path or skill requirement.
    expect(asset).not.toMatch(
      /(?:\/Users\/|\/home\/|~\/|\.dotfiles|\.pi\/|<required_skill|skills:|model:|thinking:)/u,
    );
    expect(asset).not.toMatch(
      /(?:claude-|gpt-|gemini-|anthropic\/|openai\/|write-good-code|work-with-evidence|implement-issue|review-code)/u,
    );
    expect(asset).toContain("radian-task");
    expect(asset).toContain("/repair");
    expect(asset).toContain("not an OS sandbox");
  }

  // Verification access stays separate and does not claim an OS sandbox.
  expect(getBuiltinAgent("qa")?.descriptor.toolCeiling).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "web_enable",
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
    "radian-task",
    "radian-supervisor",
  ]);
  expect(getBuiltinAgent("qa")?.descriptor.verificationTools).toEqual(["bash", "mcp__*"]);
});

test("Compiled standalone and source mode expose identical packaged prompts without resource files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-builtin-build-"));
  try {
    // Compile a registry consumer outside the source tree, then remove its source before running.
    const entry = join(directory, "registry.ts");
    const binary = join(directory, "registry");
    const module = new URL("./builtin-agents.ts", import.meta.url).pathname;
    await writeFile(
      entry,
      `import { builtinAgents } from ${JSON.stringify(module)};\nconsole.log(JSON.stringify(builtinAgents));\n`,
    );
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        entry,
        "--outfile",
        binary,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new Response(build.stderr).text();
    expect(await build.exited, await stderr).toBe(0);
    await rm(entry);

    const run = Bun.spawn([binary], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const output = new Response(run.stdout).text();
    const errors = new Response(run.stderr).text();
    expect(await run.exited, await errors).toBe(0);

    // Every byte of every prompt and every descriptor survives compilation, not just its filename.
    expect(JSON.parse(await output)).toEqual(builtinAgents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("All built-ins launch with the session default model and list their source without personal profiles", async () => {
  const { offlineRuntime, fixtureMessage } = await import("../testing/offline-runtime.ts");
  const { piSessionFactory } = await import("./pi-session-adapter.ts");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { expectOk } = await import("../testing/results.ts");
  const { ok } = await import("../result.ts");
  const directory = await mkdtemp(join(tmpdir(), "radian-builtin-session-"));
  const executors: import("./session-registry.ts").SessionExecutor[] = [];
  try {
    const options = await offlineRuntime(directory);
    await rm(join(directory, "agents"), { recursive: true });
    const models: string[] = [];
    const calls: unknown[] = [];
    const toolResults: unknown[] = [];
    let nextCommand: import("./subagent-tools.ts").SubagentCommand | undefined;
    const factory = piSessionFactory({
      ...options,
      defaultPackagePaths: [],
      streamFn(model, context, request) {
        models.push(`${model.provider}/${model.id}`);
        const last = context.messages.findLast((message) => message.role === "toolResult");
        if (last?.role === "toolResult") {
          for (const part of last.content) {
            if (part.type === "text") toolResults.push(JSON.parse(part.text));
          }
        }
        if (!nextCommand) return options.streamFn!(model, context, request);
        const command = nextCommand;
        nextCommand = undefined;
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name: "radian-subagent",
            arguments: command,
          },
        ];
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    });
    const spawnSubagent = async () => ok("unused");

    // Direct alias lookup in a fresh SDK child must not require a personal role or model preference.
    for (const id of ids) {
      const child = await factory({
        cwd: directory,
        role: "subagent",
        agent: `radian:${id}`,
        spawnSubagent,
      });
      executors.push(child);
      expectOk(await child.prompt("Inspect only"));
    }
    const root = await factory({
      cwd: directory,
      role: "main",
      spawnSubagent,
      coordinateSubagents: async (command, _signal, _purpose, target) => {
        calls.push({ command, target });
        return ok({ id: "scripted-child" });
      },
    });
    executors.push(root);
    nextCommand = { action: "list" };
    expectOk(await root.prompt("list"));
    nextCommand = { action: "spawn", agent: "radian:engineer", task: "Inspect only" };
    expectOk(await root.prompt("spawn:radian:engineer"));

    expect(models.length).toBeGreaterThanOrEqual(7);
    expect(new Set(models)).toEqual(new Set(["radian-offline/fixture"]));
    expect(toolResults[0]).toMatchObject(ids.map((name) => ({ name, source: "builtin" })));
    expect(calls).toMatchObject([
      {
        command: { action: "spawn", agent: "engineer" },
        target: { name: "engineer", source: "builtin" },
      },
    ]);
  } finally {
    for (const executor of executors) await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
