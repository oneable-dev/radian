import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import type { SessionExecutor } from "./session-registry.ts";
import { ok } from "../result.ts";

test("A cold child can select a provider installed after its parent without using another model", async () => {
  // The shared runtime has never seen the extension provider when the parent starts.
  const files = await createWorktreeFixture();
  const agentDir = join(files.directory, "agent");
  const offline = await offlineRuntime(agentDir);
  const seen: string[] = [];
  const factory = piSessionFactory({
    ...offline,
    defaultPackagePaths: [],
    streamFn(model) {
      seen.push(`${model.provider}/${model.id}`);
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [{ type: "text", text: "Profile model responded" }];
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  const executors: SessionExecutor[] = [];
  try {
    executors.push(
      await factory({ cwd: files.main, role: "main", spawnSubagent: async () => ok("") }),
    );
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "late.ts"),
      `
      export default function(pi) {
        pi.registerProvider("late-profile", { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture",
          models: [{id:"draft",name:"Draft",reasoning:true,thinkingLevelMap:{high:"high",xhigh:"xhigh"},input:["text"],contextWindow:200000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
      }
    `,
    );
    await writeFile(
      join(agentDir, "agents", "late.md"),
      "---\nname: late\ndescription: Late provider fixture\nmodel: late-profile/draft\nthinking: xhigh\n---\nInspect only.\n",
    );
    expect(offline.modelRuntime!.getModel("late-profile", "draft")).toBeUndefined();

    const child = await factory({
      cwd: files.main,
      role: "subagent",
      agent: "late",
      spawnSubagent: async () => ok(""),
    });
    executors.push(child);
    expectOk(await child.prompt("Inspect the fixture"));

    // No fallback request is sent with the parent's original provider.
    expect(seen).toEqual(["late-profile/draft"]);
    expect(child.state.telemetry?.effort).toBe("xhigh");
  } finally {
    for (const executor of executors) expectOk(await executor.close());
    await files.cleanup();
  }
});
