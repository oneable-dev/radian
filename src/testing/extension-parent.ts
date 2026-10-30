import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Repository } from "../workspace/model.ts";

/** Exercise native async delegation through a compiled host and local model, without an external CLI. */
export async function probeExtensionParent(
  binary: string,
  directory: string,
  repository: Repository,
): Promise<void> {
  const agent = join(directory, "agent");
  await mkdir(join(agent, "agents"), { recursive: true });
  await writeFile(
    join(agent, "agents", "packaged-fixture.md"),
    `---
name: packaged-fixture
description: Local standalone worker fixture
model: fixture/child
tools: [read]
---
Reply briefly.
`,
  );
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      calls.push(body.model);
      const delegate =
        body.model === "parent" && calls.filter((model) => model === "parent").length === 1;
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
      };
      const delta = delegate
        ? {
            tool_calls: [
              {
                index: 0,
                id: "delegate-fixture",
                type: "function",
                function: {
                  name: "radian-subagent",
                  arguments: JSON.stringify({
                    action: "spawn",
                    agent: "packaged-fixture",
                    task: "Reply briefly.",
                    async: true,
                  }),
                },
              },
            ],
          }
        : {
            content: body.model === "child" ? "Native child completed." : "Parent completed.",
          };
      const events = [
        { ...chunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" }],
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  try {
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: server.url.href + "v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: ["parent", "child"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 1024,
            })),
          },
        },
      }),
    );
    const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const registry = fileURLToPath(new URL("../agents/session-registry.ts", import.meta.url));
    const adapter = fileURLToPath(new URL("../agents/pi-session-adapter.ts", import.meta.url));
    const entry = join(directory, "parent-probe.ts");
    await writeFile(
      entry,
      `
      import assert from "node:assert/strict";
      import { join } from "node:path";
      import { ModelRuntime } from ${JSON.stringify(sdk)};
      import { SessionRegistry } from ${JSON.stringify(registry)};
      import { piSessionFactory } from ${JSON.stringify(adapter)};
      {
        const agent = process.env.PI_CODING_AGENT_DIR;
        const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
        const registry = new SessionRegistry([${JSON.stringify(repository)}], piSessionFactory({ agentDir: agent, modelRuntime: runtime, model: runtime.getModel("fixture", "parent") }));
        registry.setUiActive(true);
        try {
          const created = await registry.create(${JSON.stringify(repository.worktrees[0]!.id)});
          if (!created.ok) throw created.error;
          const id = created.value;
          const done = () => registry.snapshot.flatMap(repo => repo.worktrees).flatMap(tree => tree.sessions).find(session => session.id === id)?.subagents.find(child => child.status === "complete" || child.status === "failure");
          const completion = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { unsubscribe(); reject(new Error("Package child did not complete: " + JSON.stringify(registry.details(id)))); }, 30000);
            const unsubscribe = registry.subscribe(() => { const child = done(); const replies = registry.details(id)?.sections?.filter(section => section.kind === "assistant" && section.text.includes("Parent completed.")).length ?? 0; if (!child || replies < 2) return; clearTimeout(timer); unsubscribe(); resolve(child); });
          });
          const prompted = registry.prompt(id, "Call the packaged fixture worker.");
          const [result, child] = await Promise.all([prompted, completion]);
          if (!result.ok) throw result.error;
          assert.equal(child.status, "complete", JSON.stringify({ child, state: registry.details(id) }));
          console.log("Native asynchronous worker completed without a Pi CLI or Node.");
        } finally { await registry.shutdown(); }
      }
    `,
    );
    const probe = join(dirname(binary), "parent-probe");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        entry,
        "--outfile",
        probe,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, error] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Parent probe compilation failed: ${out}\n${error}`);
    const child = Bun.spawn([probe], {
      cwd: repository.worktrees[0]!.path,
      env: {
        HOME: directory,
        PATH: "",
        TMPDIR: directory,
        PI_CODING_AGENT_DIR: agent,
        PI_PACKAGE_DIR: join(
          dirname(binary),
          "packages/node_modules/@earendil-works/pi-coding-agent",
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 40000);
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (
        status !== 0 ||
        !stdout.includes("Native asynchronous worker completed") ||
        calls.filter((model) => model === "child").length !== 1
      ) {
        throw new Error(
          `Native worker failed (${status}, calls=${JSON.stringify(calls)}): ${stderr}\n${stdout}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await server.stop(true);
  }
}
