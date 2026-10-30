import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionRegistry } from "../agents/session-registry.ts";
import { piSessionFactory } from "../agents/pi-session-adapter.ts";
import { defaultPackagePaths } from "../agents/default-packages.ts";
import { offlineRuntime, fixtureMessage } from "./offline-runtime.ts";
import { createWorktreeFixture } from "./worktree-fixture.ts";
import type { Result } from "../result.ts";

const requestSchema = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  method: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

function checked<T>(result: Result<T, Error>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function wait(registry: SessionRegistry, predicate: () => boolean): Promise<void> {
  if (predicate()) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Component did not appear"));
    }, 5000);
    const unsubscribe = registry.subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

// Run in a dedicated process with an empty HOME and explicit profile. None of these
// fixtures use provider credentials, a public model/search API or a real MCP service.
export async function exerciseDefaultExtensions(agent: string) {
  const isolated = process.env.RADIAN_TEST_FIXTURE_ROOT;
  assert(
    isolated && process.env.HOME === isolated && agent === join(isolated, "agent"),
    "Default extension fixture requires an explicitly isolated HOME and agent directory.",
  );
  const files = await createWorktreeFixture();
  const methods: string[] = [];
  let pageRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/page") {
        pageRequests++;
        return new Response("Local fetched fixture content.", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body: unknown = await request.json();
      if (!Value.Check(requestSchema, body)) return new Response(null, { status: 400 });
      methods.push(body.method);
      if (body.id === undefined) return new Response(null, { status: 204 });
      let result: unknown = {};
      if (body.method === "initialize")
        result = {
          protocolVersion: body.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      if (body.method === "tools/list")
        result = {
          tools: [
            {
              name: "echo",
              description: "Fixture echo",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        };
      if (body.method === "tools/call") {
        const args = body.params?.arguments;
        assert(args && typeof args === "object" && "value" in args);
        result = { content: [{ type: "text", text: "echo:" + String(args.value) }] };
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  let registry: SessionRegistry | undefined;
  try {
    const config = join(process.env.HOME!, ".config", "mcp");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "mcp.json"),
      JSON.stringify({ mcpServers: { fixture: { url: server.url.href + "mcp" } } }),
    );
    const offline = await offlineRuntime(agent);
    await writeFile(
      join(agent, "agents", "extension-worker.md"),
      `---\nname: extension-worker\ndescription: Native child with inherited default extensions\nmodel: radian-offline/fixture\ntools: [read, "mcp*", "web_*", fetch_content, get_search_content, source_check]\n---\nUse the inherited extension tools for the assigned probe.\n`,
    );
    const originalStream = offline.streamFn;
    assert(originalStream);
    let modelCalls = 0;
    registry = new SessionRegistry(
      [files.repository],
      piSessionFactory({
        ...offline,
        defaultPackagePaths: defaultPackagePaths(),
        streamFn(model, context, options) {
          modelCalls++;
          const last = context.messages.at(-1);
          const input =
            last?.role === "user"
              ? typeof last.content === "string"
                ? last.content
                : last.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
              : "";
          const tool =
            input === "probe-child"
              ? {
                  name: "radian-subagent",
                  arguments: {
                    action: "spawn",
                    agent: "extension-worker",
                    task: "probe-web",
                    async: false,
                  },
                }
              : input === "probe-mcp"
                ? {
                    name: "mcp",
                    arguments: { tool: "echo", server: "fixture", args: { value: "fixture" } },
                  }
                : input === "probe-web"
                  ? { name: "web_enable", arguments: {} }
                  : input === "probe-fetch"
                    ? {
                        name: "fetch_content",
                        arguments: { url: server.url.href + "page", mode: "raw" },
                      }
                    : undefined;
          if (!tool) return originalStream(model, context, options);
          const stream = createAssistantMessageEventStream();
          const message = fixtureMessage(model.api, model.provider, model.id);
          message.content = [{ type: "toolCall", id: crypto.randomUUID(), ...tool }];
          message.stopReason = "toolUse";
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end();
          return stream;
        },
      }),
    );
    registry.setUiActive(true);
    const id = checked(await registry.create(files.repository.worktrees[0]!.id));
    const conversation = registry.details(id)!.conversationId!;
    const catalog = checked(registry.catalog(id, conversation));
    for (const command of [
      "mcp",
      "mcp-adapter",
      "mcp-auth",
      "websearch",
      "curator",
      "google-account",
      "search",
    ]) {
      assert(
        catalog.items.some((item) => item.kind === "command" && item.value === command),
        command,
      );
    }
    for (const skill of ["mcp-scripting"]) {
      assert(
        catalog.items.some((item) => item.kind === "skill" && item.value === "skill:" + skill),
        skill,
      );
    }
    assert(
      !catalog.items.some((item) =>
        ["subagents", "subagents-guide", "skill:pi-subagents", "skill:council-mode"].includes(
          item.value,
        ),
      ),
    );
    for (const command of ["/mcp"]) {
      const run = registry.prompt(id, command);
      const current = () => registry!.extensionUi.find((state) => state.sessionId === id)?.dialog;
      await wait(registry, () => {
        const dialog = current();
        return dialog?.kind === "custom" && dialog.frame.revision > 0;
      });
      checked(
        registry.answerExtensionUi(id, conversation, { requestId: current()!.id, cancelled: true }),
      );
      checked(await run);
      assert.equal(current(), undefined);
    }
    const beforeReload = registry.details(id)!.resourceRevision ?? 0;
    const edit = registry.prompt(id, "/mcp-adapter edit project");
    const editor = () => registry!.extensionUi.find((state) => state.sessionId === id)?.dialog;
    await wait(registry, () => editor()?.kind === "editor");
    checked(
      registry.answerExtensionUi(id, conversation, {
        requestId: editor()!.id,
        value: '{"mcpServers":{}}',
      }),
    );
    checked(await edit);
    assert.equal(registry.details(id)!.resourceRevision, beforeReload + 1);
    assert.equal(registry.details(id)!.conversationId, conversation);

    const argumentResult = checked(
      await registry.complete(id, { kind: "argument", command: "mcp-adapter", query: "jev s" }),
    );
    assert(argumentResult.items.some((item) => item.value === "jev setup"));
    assert.equal(modelCalls, 0);

    checked(await registry.prompt(id, "probe-mcp"));
    assert(
      methods.includes("initialize") &&
        methods.includes("tools/list") &&
        methods.includes("tools/call"),
    );
    assert(
      registry
        .details(id)!
        .sections?.some(
          (section) => section.kind === "tool" && section.text.includes("echo:fixture"),
        ),
    );
    checked(await registry.prompt(id, "probe-web"));
    assert(
      registry
        .details(id)!
        .sections?.some(
          (section) =>
            section.kind === "tool" &&
            section.title === "web_enable" &&
            section.text.includes("fetch_content"),
        ),
    );
    checked(await registry.prompt(id, "probe-fetch"));
    // The real Web Access URL policy must still prevent requests to private hosts.
    assert(
      registry
        .details(id)!
        .sections?.some(
          (section) =>
            section.kind === "tool" &&
            section.title === "fetch_content" &&
            section.text.includes("Blocked internal address"),
        ),
    );
    assert.equal(pageRequests, 0);
    assert.equal(modelCalls, 6);
    checked(await registry.prompt(id, "probe-child"));
    const native = registry.records
      .find((record) => record.id === id)
      ?.ownedSubagents?.find((run) => run.name === "extension-worker");
    assert.equal(native?.status, "complete");
    assert(native.output.includes("Enabled: web_search"));
    assert.equal(modelCalls, 10);
    return {
      commands: catalog.items.filter((item) => item.kind === "command").length,
      skills: catalog.items.filter((item) => item.kind === "skill").length,
      templates: catalog.items.filter((item) => item.kind === "template").length,
      childExtensions: true,
      modelCalls,
      mcpMethods: methods,
      privateFetchBlocked: true,
    };
  } finally {
    try {
      await registry?.shutdown();
    } finally {
      await server.stop(true);
      await files.cleanup();
    }
  }
}

if (import.meta.main) {
  const agent = process.env.PI_CODING_AGENT_DIR;
  if (!agent) throw new Error("Default extension fixture requires an isolated agent directory.");
  console.log(JSON.stringify(await exerciseDefaultExtensions(agent)));
}
