import { expect, spyOn, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { SessionRegistry, type SessionExecutor } from "./session-registry.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { summarizeRequest } from "./request-summary.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { tinyPng } from "../testing/image.ts";
import { ok } from "../result.ts";
import { readHistoryPreview } from "./history-preview.ts";
import { commandDisplayEntryType } from "./command-display.ts";
import { SessionHistory } from "./history.ts";
import { readTaskPlan } from "./task-plan-store.ts";

function controlledStreams(options: PiSessionOptions) {
  const gates = new Map<
    string,
    { aborted: boolean; abortReceived: Promise<void>; finish(text: string): void }
  >();
  const started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const waitFor = (key: string) => {
    if (gates.has(key)) {
      return Promise.resolve();
    }

    const gate = started.get(key) ?? Promise.withResolvers<void>();
    started.set(key, gate);

    return gate.promise;
  };
  const base = options.streamFn!;
  const streamFn: NonNullable<PiSessionOptions["streamFn"]> = (model, context, request) => {
    const last = context.messages.at(-1);
    const user = context.messages.findLast((message) => message.role === "user");
    const input =
      last?.role !== "toolResult" && user?.role === "user"
        ? typeof user.content === "string"
          ? user.content
          : user.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
        : "";
    const key = input === "slow" ? "child" : input.startsWith("hold ") ? input.slice(5) : null;
    if (!key) {
      return base(model, context, request);
    }

    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = fixtureMessage(model.api, model.provider, model.id);
    const aborted = Promise.withResolvers<void>();
    const gate = {
      aborted: false,
      abortReceived: aborted.promise,
      finish(text: string) {
        request?.signal?.removeEventListener("abort", cancel);
        message.content = [{ type: "text", text }];
        message.stopReason = gate.aborted ? "aborted" : "stop";
        if (gate.aborted) {
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }

        stream.end();
      },
    };
    const cancel = () => {
      gate.aborted = true;
      aborted.resolve();
    };

    request?.signal?.addEventListener("abort", cancel, { once: true });
    if (request?.signal?.aborted) {
      cancel();
    }

    gates.set(key, gate);
    stream.push({ type: "start", partial: message });
    started.get(key)?.resolve();

    return stream;
  };

  return {
    gates,
    waitFor,
    streamFn,
    releaseAll() {
      for (const gate of gates.values()) {
        gate.finish("fixture released");
      }
    },
  };
}

async function sdkFixture(
  controlled = false,
  configure?: (options: PiSessionOptions) => PiSessionOptions,
) {
  const fixture = await createWorktreeFixture();
  const options = await offlineRuntime(join(fixture.directory, "agent"));
  const streams = controlledStreams(options);
  const executors: SessionExecutor[] = [];
  const factoryOptions = { ...options, ...(controlled ? { streamFn: streams.streamFn } : {}) };
  const factory = piSessionFactory(configure?.(factoryOptions) ?? factoryOptions);
  const registry = new SessionRegistry([fixture.repository], async (context) => {
    const executor = await factory(context);
    executors.push(executor);

    return executor;
  });
  const selection = new WorkspaceSelection(registry.snapshot);
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const feature = fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!;

  return {
    ...fixture,
    registry,
    selection,
    executors,
    streams,
    main,
    feature,
    async cleanup() {
      // Signal cancellation before releasing provider acknowledgements to prevent new requests.
      const shutdown = registry.shutdown();
      streams.releaseAll();
      await shutdown;
      unsubscribe();
      await fixture.cleanup();
    },
  };
}

async function commandExtension(directory: string) {
  const extensions = join(directory, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "commands.ts"),
    `export default function (pi) {
    pi.registerCommand("fixture-command", { description: "Fixture slash command", handler: async (args) => { pi.appendEntry("command-probe", { args }); } });
    pi.registerCommand("fixture-broken", { handler: async () => { throw new Error("Fixture command failure"); } });
    pi.registerCommand("fixture-wait", { handler: async (_args, ctx) => { await ctx.waitForIdle(); } });
  }`,
  );
}

test("history completion overrides extensions and raw submission never reaches SDK or model", async () => {
  // An extension with the same name must not replace the host popup command.
  let requests = 0;
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      requests++;

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const extensions = join(app.directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "history.ts"),
      `export default function(pi) {
      pi.registerCommand("history", { description: "Conflicting extension command", handler: async () => { pi.appendEntry("unexpected-history", {}); } });
    }`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    const conversation = app.registry.details(id)!.conversationId!;

    // Check the full catalog and direct server/SDK submission paths.
    const commands = expectOk(app.registry.catalog(id, conversation)).items.filter(
      (item) => item.value === "history",
    );
    const registryResult = await app.registry.prompt(id, "/history");
    const sdkResult = await app.executors[0]!.prompt("/history");
    const invalid = await app.executors[0]!.prompt("/history recent");

    // Name collisions and calls without popups must never create model requests.
    expect(commands).toHaveLength(1);
    expect(commands[0]?.description).toContain("saved session history");
    expect(expectError(registryResult).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(sdkResult).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(expectError(invalid).code).toBe("INVALID_INPUT");
    expect(requests).toBe(0);
    expect(app.registry.details(id)?.sections).toEqual([]);
  } finally {
    await app.cleanup();
  }
});

async function reviewTemplate(directory: string, body = "PRIVATE_COMMAND_INSTRUCTIONS\nTask: $@") {
  const prompts = join(directory, "agent", "prompts");
  await mkdir(prompts, { recursive: true });
  await writeFile(join(prompts, "review.md"), `---\ndescription: Review fixture\n---\n${body}\n`);
}

test("File prompt commands show invocation and arguments while preserving expanded model context and saved History", async () => {
  // Use real template discovery and SDK persistence with only the model transport offline.
  const inputs: string[] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model, context, request) => {
      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user")
        inputs.push(
          typeof user.content === "string"
            ? user.content
            : user.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
      return options.streamFn!(model, context, request);
    },
  }));
  try {
    await reviewTemplate(app.directory);
    const extensions = join(app.directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "context-edit.ts"),
      `export default function(pi) {
      pi.on("agent_before_settle", (_event, ctx) => {
        const entries = ctx.sessionManager.getBranch();
        const user = entries.findLast(entry => entry.type === "message" && entry.message.role === "user");
        if (!user || entries.some(entry => entry.type === "context_edit" && entry.targetId === user.id)) return;
        return { entries: [{ type: "context_edit", targetId: user.id, replacement: { content: user.message.content } }] };
      });
    }`,
    );
    const id = expectOk(await app.registry.create(app.main.id));

    // Execute both forms before closing, without retaining the template file for restoration.
    expectOk(await app.registry.prompt(id, '/review src/agents "keep quotes"'));
    expectOk(await app.registry.prompt(id, "/review"));
    const file = app.registry.sessionFile(id)!;
    const live = app.registry.details(id)!;
    const saved = SessionManager.open(file);
    const preview = expectOk(await readHistoryPreview(file, app.main.id, saved.getSessionId()));
    expectOk(await app.registry.close(id));
    const history = new SessionHistory(
      [app.repository],
      app.registry,
      join(app.directory, "agent", "sessions"),
    );
    const historyItems = expectOk(await history.list(app.main.id));
    await writeFile(join(app.directory, "agent", "prompts", "review.md"), "Changed template body");
    const reopened = expectOk(await app.registry.create(app.main.id, file));

    // Live, bounded History and reopening must agree without leaking expanded instructions.
    expect(inputs).toEqual([
      "PRIVATE_COMMAND_INSTRUCTIONS\nTask: src/agents keep quotes",
      "PRIVATE_COMMAND_INSTRUCTIONS\nTask: ",
    ]);
    for (const sections of [
      live.sections,
      preview.sections,
      app.registry.details(reopened)?.sections,
    ]) {
      expect(
        sections?.filter((section) => section.kind === "user").map((section) => section.text),
      ).toEqual(["/review", 'src/agents "keep quotes"', "/review"]);
      expect(sections?.filter((section) => section.commandName === "review")).toHaveLength(2);
      expect(JSON.stringify(sections)).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
    }
    expect(live.output).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
    expect(live.request?.text).toBe("/review");
    expect(app.registry.details(reopened)?.request?.text).toBe("/review");
    expect(preview.text).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
    expect(historyItems[0]?.title).toBe('/review src/agents "keep quotes"');
    expect(saved.getBranch().some((entry) => entry.type === "context_edit")).toBe(true);
    expect(
      saved
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === commandDisplayEntryType),
    ).toHaveLength(2);
    expect(JSON.stringify(saved.buildSessionContext().messages)).toContain(
      "PRIVATE_COMMAND_INSTRUCTIONS",
    );
    expect(JSON.stringify(saved.buildSessionContext().messages)).not.toContain(
      commandDisplayEntryType,
    );
  } finally {
    await app.cleanup();
  }
});

test.each([
  [
    "/plan",
    [{ text: "/plan", commandName: "plan" }],
    "/plan",
    "Use the requirements already discussed",
  ],
  [
    '/plan "quoted args"\nkeep literal lines',
    [{ text: "/plan", commandName: "plan" }, { text: '"quoted args"\nkeep literal lines' }],
    '/plan "quoted args" keep literal lines',
    '"quoted args"\nkeep literal lines',
  ],
  [
    "/plan \n  keep indentation\nnext",
    [{ text: "/plan", commandName: "plan" }, { text: "\n  keep indentation\nnext" }],
    "/plan keep indentation next",
    "keep indentation\nnext",
  ],
  [
    "/plan   indented first\n  second",
    [{ text: "/plan", commandName: "plan" }, { text: "  indented first\n  second" }],
    "/plan indented first second",
    "indented first\n  second",
  ],
] as const)(
  "Built-in %s keeps literal display distinct from model instructions in History",
  async (input, parts, summary, requirements) => {
    // Only the transport is offline; admission, custom-message persistence and History use the real SDK.
    const modelContexts: string[] = [];
    const app = await sdkFixture(false, (options) => ({
      ...options,
      defaultPackagePaths: [],
      streamFn: (model, context, request) => {
        modelContexts.push(JSON.stringify(context.messages));
        return options.streamFn!(model, context, request);
      },
    }));
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      const settled = Promise.withResolvers<void>();
      let working = false;
      const unsubscribe = app.registry.subscribe(() => {
        const status = app.registry.details(id)?.status;
        if (status === "working") working = true;
        if (working && status === "complete") settled.resolve();
      });
      try {
        expectOk(await app.registry.prompt(id, input));
        await settled.promise;
      } finally {
        unsubscribe();
      }

      const file = app.registry.sessionFile(id)!;
      const conversation = app.registry.details(id)!.conversationId!;
      const live = app.registry.details(id)!;
      const saved = SessionManager.open(file);
      const preview = expectOk(await readHistoryPreview(file, app.main.id, conversation));
      const custom = saved
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "radian.task-plan-request",
        );
      expect(custom?.type === "custom_message" && custom.display).toBe(false);
      expect(JSON.stringify(custom)).toContain("Read repository instructions");
      expect(modelContexts[0]).toContain("Read repository instructions");
      expect(modelContexts[0]).toContain(JSON.stringify(requirements).slice(1, -1));
      expect(JSON.stringify(saved.buildSessionContext().messages)).toContain(
        "Read repository instructions",
      );
      expect(JSON.stringify(saved.buildSessionContext().messages)).not.toContain(
        commandDisplayEntryType,
      );
      expectOk(await app.registry.close(id));
      const reopened = expectOk(await app.registry.create(app.main.id, file));
      for (const sections of [
        live.sections,
        preview.sections,
        app.registry.details(reopened)?.sections,
      ]) {
        expect(sections?.filter((section) => section.kind === "user")).toMatchObject(parts);
        expect(sections?.filter((section) => section.commandName === "plan")).toHaveLength(1);
        expect(sections?.some((section) => section.title === "radian.task-plan-request")).toBe(
          false,
        );
        expect(JSON.stringify(sections)).not.toContain("Read repository instructions");
      }
      expect(live.output).not.toContain("Read repository instructions");
      expect(preview.text).not.toContain("Read repository instructions");
      expect(live.request?.text).toBe(summary);
      expect(live.result?.request?.text).toBe(summary);
      expect(app.registry.details(reopened)?.request?.text).toBe(summary);
    } finally {
      await app.cleanup();
    }
  },
);

test("Command display persistence failures warn without rejecting accepted model work", async () => {
  // Optional display persistence can fail after the SDK has already accepted the prompt.
  const app = await sdkFixture(false, (options) => ({ ...options, defaultPackagePaths: [] }));
  const original = SessionManager.prototype.appendCustomEntry;
  const append = spyOn(SessionManager.prototype, "appendCustomEntry").mockImplementation(function (
    this: SessionManager,
    type,
    data,
  ) {
    if (type === commandDisplayEntryType)
      throw Object.assign(new Error("Fixture write denied"), { code: "EACCES" });
    return original.call(this, type, data);
  });
  try {
    await reviewTemplate(app.directory);
    const id = expectOk(await app.registry.create(app.main.id));

    expectOk(await app.registry.prompt(id, "/review inspect"));

    // The invocation remains compact in memory; persistence uncertainty is reported separately.
    const details = app.registry.details(id)!;
    expect(details.status).toBe("complete");
    expect(details.error).toBeNull();
    expect(details.sections?.some((section) => section.commandName === "review")).toBe(true);
    expect(
      details.sections?.find((section) => section.title === "Command display persistence")?.text,
    ).toContain("STORAGE_FAILED");
    expect(JSON.stringify(details)).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
  } finally {
    append.mockRestore();
    await app.cleanup();
  }
});

test("A failed /plan annotation write preserves its recorded turn and saved History", async () => {
  // Fail at the OS boundary after the SDK has already advanced its in-memory entry tree.
  const app = await sdkFixture(false, (options) => ({ ...options, defaultPackagePaths: [] }));
  const original = fs.appendFileSync;
  let failed = false;
  const append = spyOn(fs, "appendFileSync").mockImplementation((path, data, options) => {
    if (
      !failed &&
      typeof data === "string" &&
      data.includes(`"customType":"${commandDisplayEntryType}"`)
    ) {
      failed = true;
      throw Object.assign(new Error("Fixture annotation write failed"), { code: "EIO" });
    }
    return original(path, data, options);
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const settled = Promise.withResolvers<void>();
    let working = false;
    const unsubscribe = app.registry.subscribe(() => {
      const status = app.registry.details(id)?.status;
      if (status === "working") working = true;
      if (working && status === "complete") settled.resolve();
    });
    try {
      expectOk(await app.registry.prompt(id, "/plan Inspect safely"));
      await settled.promise;
    } finally {
      unsubscribe();
    }

    const details = app.registry.details(id)!;
    const file = app.registry.sessionFile(id)!;
    const saved = SessionManager.open(file);
    expect(failed).toBe(true);
    expect(details.status).toBe("complete");
    expect(details.error).toBeNull();
    expect(details.request?.text).toBe("/plan Inspect safely");
    expect(details.sections?.filter((section) => section.kind === "user")).toMatchObject([
      { text: "/plan", commandName: "plan" },
      { text: "Inspect safely" },
    ]);
    expect(
      details.sections?.find((section) => section.title === "Command display persistence")?.text,
    ).toContain("STORAGE_FAILED");
    expect(
      saved
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
    expect(
      saved
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === commandDisplayEntryType),
    ).toHaveLength(0);

    // Missing optional styling must not sever the saved invocation or later model messages.
    const preview = expectOk(await readHistoryPreview(file, app.main.id, details.conversationId!));
    expect(preview.sections?.filter((section) => section.kind === "user")).toMatchObject([
      { text: "/plan Inspect safely" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("Read repository instructions");
    expectOk(await app.registry.close(id));
    const reopened = expectOk(await app.registry.create(app.main.id, file));
    expect(app.registry.details(reopened)?.request?.text).toBe("/plan Inspect safely");
    expect(
      app.registry.details(reopened)?.sections?.filter((section) => section.kind === "user"),
    ).toMatchObject([{ text: "/plan Inspect safely" }]);
  } finally {
    append.mockRestore();
    await app.cleanup();
  }
});

test("Host controls and extension commands never receive file-command transcript tags", async () => {
  // Conflicting prompt files must not replace app controls or registered extension handlers.
  const app = await sdkFixture(false, (options) => ({ ...options, defaultPackagePaths: [] }));
  try {
    await commandExtension(app.directory);
    const prompts = join(app.directory, "agent", "prompts");
    await mkdir(prompts, { recursive: true });
    for (const name of ["model", "history", "fixture-command"]) {
      await writeFile(join(prompts, `${name}.md`), "PRIVATE_COMMAND_INSTRUCTIONS");
    }
    const id = expectOk(await app.registry.create(app.main.id));

    for (const text of ["/model", "/history"]) {
      expect(expectError(await app.registry.prompt(id, text)).code).toBe("UNSUPPORTED_CAPABILITY");
    }
    expectOk(await app.registry.prompt(id, "/fixture-command argument"));

    // UI-only actions and extension execution must not fabricate user messages or model runs.
    expect(app.registry.details(id)?.sections).toEqual([]);
    expect(app.registry.details(id)?.status).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test("Queued prompt commands keep their own display identity and compact pending summaries", async () => {
  // A long-running request leaves two identical expanded bodies queued with distinct arguments.
  const app = await sdkFixture(true, (options) => ({ ...options, defaultPackagePaths: [] }));
  try {
    await reviewTemplate(app.directory, "PRIVATE_COMMAND_INSTRUCTIONS");
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");
    await app.streams.waitFor("A");

    expectOk(await app.registry.prompt(id, "/review first"));
    expectOk(await app.registry.prompt(id, "/review second"));
    expect(app.registry.details(id)?.pendingMessages?.map((message) => message.text)).toEqual([
      "/review first",
      "/review second",
    ]);
    app.streams.gates.get("A")!.finish("First response");
    expectOk(await running);

    // Queue objects, not body equality, associate each delivered invocation.
    const details = app.registry.details(id)!;
    expect(
      details.sections?.filter((section) => section.kind === "user").map((section) => section.text),
    ).toEqual(["hold A", "/review", "first", "/review", "second"]);
    expect(JSON.stringify(details)).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
  } finally {
    await app.cleanup();
  }
});

test("Interrupt replay preserves command displays alongside ordinary queued input", async () => {
  // Interruption combines pending SDK input into one replayed message without expanding it again.
  const app = await sdkFixture(true, (options) => ({ ...options, defaultPackagePaths: [] }));
  try {
    await reviewTemplate(app.directory);
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");
    await app.streams.waitFor("A");
    expectOk(await app.registry.prompt(id, "/review first"));
    expectOk(await app.registry.prompt(id, "ordinary queued request"));
    expectOk(await app.registry.prompt(id, "/review second"));

    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.status === "complete") settled.resolve();
    });
    const interrupted = app.registry.interrupt(id);
    await app.streams.gates.get("A")!.abortReceived;
    app.streams.gates.get("A")!.finish("Cancelled response");
    expectOk(await interrupted);
    expect(expectError(await running).code).toBe("CANCELLED");
    // Queue acceptance is not settlement; wait for the replayed run itself to finish.
    await settled.promise;
    unsubscribe();
    expectOk(await app.registry.prompt(id, "after replay"));

    const details = app.registry.details(id)!;
    expect(
      details.sections?.filter((section) => section.kind === "user").map((section) => section.text),
    ).toEqual([
      "hold A",
      "/review",
      "first",
      "ordinary queued request",
      "/review",
      "second",
      "after replay",
    ]);
    expect(JSON.stringify(details)).not.toContain("PRIVATE_COMMAND_INSTRUCTIONS");
  } finally {
    await app.cleanup();
  }
});

test("Reload preserves conversation, model, and output while rereading commands, templates, and skills", async () => {
  // Use the real SDK resource loader and replace only model transport offline.
  let requests = 0;
  const inputs: string[] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      requests++;

      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user") {
        inputs.push(
          typeof user.content === "string"
            ? user.content
            : user.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
      }

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const extensions = join(app.directory, "agent", "extensions");
    const skills = join(app.directory, "explicit-skills");
    const template = join(app.directory, "reload-template.md");

    await mkdir(extensions, { recursive: true });
    await mkdir(skills);
    await writeFile(
      template,
      "---\ndescription: Initial template\n---\nInitial template content\n",
    );
    await writeFile(
      join(extensions, "resources.ts"),
      `export default function(pi) {
      pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skills)}], promptPaths: [${JSON.stringify(template)}] }));
    }`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    expect(expectError(await app.registry.prompt(id, "/reload")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(requests).toBe(0);
    expectOk(await app.registry.prompt(id, "Before reload"));

    const before = app.registry.details(id)!;
    const file = app.registry.sessionFile(id);
    const conversation = before.conversationId!;

    expect(
      expectOk(app.registry.catalog(id, conversation)).items.some(
        (item) => item.value === "fresh-149",
      ),
    ).toBe(false);

    // Saved resources enter the catalog only after explicit reload.
    const skill = join(skills, "reload-skill");
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: reload-skill\ndescription: Reloaded skill\n---\nRELOADED_SKILL_MARKER\n",
    );
    await writeFile(
      template,
      "---\ndescription: Updated template\n---\nUpdated template content\n",
    );
    await writeFile(
      join(extensions, "fresh.ts"),
      `export default function(pi) {
      for (let i = 0; i < 150; i++) pi.registerCommand("fresh-" + i, { description: "Fresh command", handler: async () => { pi.appendEntry("reload-probe", { index: i }); } });
    }`,
    );
    expect(
      expectOk(app.registry.catalog(id, conversation)).items.some((item) => item.kind === "skill"),
    ).toBe(false);
    expectOk(await app.registry.reload(id));

    const after = app.registry.details(id)!;
    expect(after.conversationId).toBe(conversation);
    expect(app.registry.sessionFile(id)).toBe(file);
    expect(after.output).toBe(before.output);
    expect(after.sections).toEqual(before.sections);
    expect(after.status).toBe(before.status);
    expect(after.telemetry?.model).toBe(before.telemetry?.model);
    expect(after.telemetry?.effort).toBe(before.telemetry?.effort);
    expect(after.resourceRevision).toBe(1);
    expect(requests).toBe(1);

    const catalog = expectOk(app.registry.catalog(id, conversation));
    expect(catalog.items.length).toBeGreaterThan(150);
    expect(catalog.items.find((item) => item.value === "reload-template")?.description).toBe(
      "Updated template",
    );
    expect(
      catalog.items.some((item) => item.kind === "skill" && item.value === "skill:reload-skill"),
    ).toBe(true);
    expect(
      expectOk(await app.registry.complete(id, { kind: "command", query: "reload-skill" })).items,
    ).toEqual([]);
    expect(
      expectOk(await app.registry.complete(id, { kind: "skill", query: "reload" })).items[0]?.value,
    ).toBe("reload-skill");

    // Dollar syntax expands into loaded skill instructions instead of reaching the model verbatim.
    expectOk(await app.registry.prompt(id, "$reload-skill inspect this"));
    expect(inputs.at(-1)).toContain("RELOADED_SKILL_MARKER");
    expect(inputs.at(-1)).toContain("inspect this");
    expect(expectError(await app.registry.prompt(id, "$missing-skill")).code).toBe("INVALID_INPUT");
    expect(requests).toBe(2);
  } finally {
    await app.cleanup();
  }
});

test.each([
  ["new", false],
  ["new", true],
  ["clear", false],
  ["clear", true],
  ["exit", false],
  ["exit", true],
  ["reload", false],
  ["reload", true],
] as const)(
  "/%s management commands create neither model requests nor intermediate working states with completion history %j",
  async (command, seeded) => {
    // Run management commands through the real SDK for empty and completed conversations.
    let requests = 0;
    const app = await sdkFixture(false, (options) => ({
      ...options,
      streamFn: (model, context, request) => {
        requests++;

        return options.streamFn!(model, context, request);
      },
    }));
    let unsubscribe = () => {};
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      if (seeded) {
        expectOk(await app.registry.prompt(id, "Existing completed conversation"));
      }

      const before = requests;
      const statuses: SessionExecutor["state"]["status"][] = [];

      unsubscribe = app.registry.subscribe(() => {
        for (const repository of app.registry.snapshot) {
          for (const tree of repository.worktrees) {
            for (const session of tree.sessions) {
              statuses.push(session.status);
            }
          }
        }
      });

      // Use the same management operation invoked by the host after UI parsing.
      switch (command) {
        case "new":
          expectOk(await app.registry.newTab(id));
          break;
        case "clear":
          expectOk(await app.registry.clearSession(id));
          break;
        case "exit":
          expectOk(await app.registry.close(id));
          break;
        case "reload":
          expectOk(await app.registry.reload(id));
          break;
      }

      // No published snapshot may contain a fake run, not just the final snapshot.
      expect(statuses).not.toContain("working");
      expect(requests).toBe(before);
    } finally {
      unsubscribe();
      await app.cleanup();
    }
  },
);

test("Reload during execution returns busy without interrupting the request", async () => {
  // Active models and command-resource replacement cannot run concurrently.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold reload");

    await app.streams.waitFor("reload");

    const result = await app.registry.reload(id);

    expect(expectError(result).code).toBe("SESSION_BUSY");
    expect(app.streams.gates.get("reload")?.aborted).toBe(false);
    expect(app.registry.details(id)?.resourceRevision).toBe(0);
    app.streams.gates.get("reload")!.finish("Original work completed");
    expectOk(await run);
  } finally {
    await app.cleanup();
  }
});

test("Failed extension reloads preserve previous catalogs and revisions", async () => {
  // Report invalid extensions as configuration failures without hiding partial application.
  const app = await sdkFixture();
  try {
    await commandExtension(app.directory);

    const id = expectOk(await app.registry.create(app.main.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const before = expectOk(app.registry.catalog(id, conversation));

    await writeFile(
      join(app.directory, "agent", "extensions", "invalid.ts"),
      "export default function ( { invalid source",
    );

    const result = await app.registry.reload(id);

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(expectOk(app.registry.catalog(id, conversation))).toEqual(before);
    expect(app.registry.details(id)?.conversationId).toBe(conversation);
    expect(app.registry.details(id)?.resourceRevision).toBe(0);
  } finally {
    await app.cleanup();
  }
});

test("SDK diagnostics for invalid settings never become reload success", async () => {
  // Reread file-based settings without starting model requests.
  const app = await sdkFixture(false, (options) => {
    const configured = { ...options };
    delete configured.streamFn;

    return configured;
  });
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const before = expectOk(app.registry.catalog(id, conversation));

    await writeFile(join(app.directory, "agent", "settings.json"), "{ invalid settings");

    const result = await app.registry.reload(id);

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(expectOk(app.registry.catalog(id, conversation))).toEqual(before);
    expect(app.registry.details(id)?.output).toBe("");
    expect(warned).toHaveBeenCalled();
  } finally {
    warned.mockRestore();
    await app.cleanup();
  }
});

test("SDK reload initialization error notifications never become success", async () => {
  // Some SDK hook failures arrive through onError rather than exceptions.
  const app = await sdkFixture();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await commandExtension(app.directory);

    const id = expectOk(await app.registry.create(app.main.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const before = expectOk(app.registry.catalog(id, conversation));

    await writeFile(
      join(app.directory, "agent", "extensions", "bad-start.ts"),
      `export default function(pi) {
      pi.on("session_start", () => { throw new Error("Reload lifecycle fixture"); });
    }`,
    );

    const result = await app.registry.reload(id);

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(expectOk(app.registry.catalog(id, conversation))).toEqual(before);
    expect(logged).toHaveBeenCalled();
    expect(warned).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
    warned.mockRestore();
    await app.cleanup();
  }
});

test("Reload programming errors propagate unchanged without replacing catalogs as successful", async () => {
  // Distinguish input/resource diagnostics from host programming errors.
  const app = await sdkFixture();
  let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const marker = new TypeError("Reload programming defect");
    const reload = spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(marker);

    restore = () => reload.mockRestore();

    const operation = app.registry.reload(id);

    await expect(operation).rejects.toBe(marker);
    expect(app.registry.details(id)?.resourceRevision).toBe(0);
  } finally {
    restore?.();
    await app.cleanup();
  }
});

test("The real SDK sends and stores image bytes rather than path labels", async () => {
  const observed: string[] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
    streamFn: (model, context, request) => {
      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user" && typeof user.content !== "string") {
        observed.push(
          ...user.content.flatMap((part) => (part.type === "image" ? [part.data] : [])),
        );
      }

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const path = join(app.directory, "image.png");
    await writeFile(path, tinyPng());

    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "Inspect [Image #1]", undefined, [path]));

    expect(observed).toHaveLength(1);
    expect(Buffer.from(observed[0]!, "base64")).toEqual(tinyPng());

    const file = app.registry.sessionFile(id)!;
    const saved = await readFile(file, "utf8");

    expect(saved).toContain('"type":"image"');
    expect(saved).not.toContain(path);
    expect(app.registry.details(id)?.status).toBe("complete");

    const original = app.registry.details(id)?.sections?.find((section) => section.image)?.image;
    expect(original?.name).toBe("image.png");
    expect(expectOk(app.registry.imageData(id, original!.id)).bytes).toEqual(tinyPng());
    expectOk(await app.registry.close(id));

    const restored = expectOk(await app.registry.create(app.main.id, file));
    expect(
      app.registry.details(restored)?.sections?.some((section) => section.kind === "user"),
    ).toBe(true);
    expect(
      app.registry.details(restored)?.sections?.find((section) => section.image)?.image,
    ).toEqual(original);
    expect(expectOk(app.registry.imageData(restored, original!.id)).bytes).toEqual(tinyPng());
    expect(expectError(app.registry.imageData(id, original!.id)).code).toBe("SESSION_NOT_OPEN");
    expect(observed).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Slow image preparation preserves input acceptance and conversation ordering", async () => {
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admissions: string[] = [];
  const contexts: string[][] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
    imageLoader: async () => {
      preparing.resolve();
      await release.promise;

      return ok([
        { type: "image" as const, data: tinyPng().toString("base64"), mimeType: "image/png" },
      ]);
    },
    streamFn: (model, context, request) => {
      contexts.push(
        context.messages.flatMap((message) =>
          message.role === "user"
            ? [
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join(""),
              ]
            : [],
        ),
      );

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "first image input", () => admissions.push("first"), [
      "/fixture/image.png",
    ]);

    await preparing.promise;

    const second = app.registry.prompt(id, "later text input", () => admissions.push("second"));
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(contexts).toEqual([]);
    expect(admissions).toEqual([]);
    release.resolve();
    expectOk(await first);
    expectOk(await second);

    // The SDK may combine steering received before the first model call.
    // Assert acceptance and actual user-message order rather than call count.
    expect(admissions).toEqual(["first", "second"]);

    // Image previews now have their own section; text order and the real attachment must both survive.
    const sections = app.registry.details(id)?.sections ?? [];
    expect(
      sections.filter((section) => section.kind === "user").map((section) => section.text),
    ).toEqual(["first image input", "later text input"]);

    const images = sections.filter((section) => section.image);
    expect(images).toHaveLength(1);
    expect(images[0]?.image).toMatchObject({
      name: "image.png",
      mimeType: "image/png",
      byteLength: tinyPng().byteLength,
    });
    expect(sections.indexOf(images[0]!)).toBeLessThan(
      sections.findIndex((section) => section.text === "later text input"),
    );
    expect(contexts.at(-1)).toEqual(["first image input", "later text input"]);
  } finally {
    release.resolve();
    await app.cleanup();
  }
});

test("Image steering queues in the same SDK session without interrupting active tools or responses", async () => {
  const observed: string[] = [];
  const app = await sdkFixture(true, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
    streamFn: (model, context, request) => {
      const user = context.messages.findLast((message) => message.role === "user");
      if (user?.role === "user" && typeof user.content !== "string") {
        observed.push(
          ...user.content.flatMap((part) => (part.type === "image" ? [part.data] : [])),
        );
      }

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const path = join(app.directory, "queued.png");
    await writeFile(path, tinyPng());

    const id = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "hold A");

    await app.streams.waitFor("A");

    const accepted = Promise.withResolvers<void>();
    const second = app.registry.prompt(id, "hold B", accepted.resolve, [path]);

    await accepted.promise;
    expect(app.streams.gates.get("A")!.aborted).toBe(false);
    expect(app.streams.gates.has("B")).toBe(false);
    app.streams.gates.get("A")!.finish("A finished");
    await app.streams.waitFor("B");
    expect(observed).toHaveLength(1);
    expect(app.executors).toHaveLength(1);
    app.streams.gates.get("B")!.finish("B finished");
    expectOk(await first);
    expectOk(await second);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally {
    await app.cleanup();
  }
});

test("Rejected image preparation preserves restored-session warnings and saved output", async () => {
  const app = await sdkFixture(false, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "read"));

    const record = app.registry.records.find((item) => item.id === id)!;
    expectOk(await app.registry.close(id));
    expectOk(
      await app.registry.restore({
        ...record,
        state: {
          ...record.state,
          status: "working",
          output: record.state.output + "\nRetained host recovery output",
        },
      }),
    );

    const before = app.registry.details(id);
    let accepted = 0;

    expect(
      expectError(
        await app.registry.prompt(id, "Inspect image", () => accepted++, [
          join(app.directory, "missing.png"),
        ]),
      ).code,
    ).toBe("STORAGE_FAILED");
    expect(accepted).toBe(0);
    expect(app.registry.details(id)?.error).toBe(before?.error);
    expect(app.registry.details(id)?.output).toBe(before?.output);
    expect(before?.output).toContain("Retained host recovery output");
  } finally {
    await app.cleanup();
  }
});

test("Unsupported images and attachment-free settings commands fail before acceptance or execution", async () => {
  const plain = await sdkFixture();
  try {
    const id = expectOk(await plain.registry.create(plain.main.id));
    let accepted = 0;

    expect(
      expectError(
        await plain.registry.prompt(id, "Inspect image", () => accepted++, [
          join(plain.directory, "missing.png"),
        ]),
      ).code,
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(accepted).toBe(0);
    expect(plain.registry.details(id)?.output).toBe("");
  } finally {
    await plain.cleanup();
  }

  const app = await sdkFixture(false, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
  }));
  try {
    await commandExtension(app.directory);

    const path = join(app.directory, "image.png");
    await writeFile(path, tinyPng());

    const id = expectOk(await app.registry.create(app.main.id));
    let accepted = 0;

    expect(
      expectError(await app.registry.prompt(id, "/fixture-command", () => accepted++, [path])).code,
    ).toBe("INVALID_INPUT");
    expect(accepted).toBe(0);
    expect(app.registry.details(id)?.output).toBe("");
    expect(app.registry.details(id)?.status).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test("SDK command listing and execution avoid model calls and preserve previous run state", async () => {
  const app = await sdkFixture();
  try {
    await commandExtension(app.directory);

    const id = expectOk(await app.registry.create(app.main.id));
    const items = expectOk(
      await app.registry.complete(id, { kind: "command", query: "fixture-command" }),
    ).items;

    expect(items.map((item) => [item.value, item.description])).toEqual([
      ["fixture-command", "Fixture slash command"],
    ]);

    let accepted = 0;
    expectOk(await app.registry.prompt(id, "/fixture-command argument", () => accepted++));
    expect(app.registry.details(id)?.status).toBeNull();
    expect(app.registry.details(id)?.output).toBe("");
    expect(accepted).toBe(1);
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    expectOk(await app.registry.prompt(id, "read"));

    const completed = app.registry.details(id)?.sections?.at(-1)?.completion;
    expectOk(await app.registry.prompt(id, "/fixture-command"));
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.sections?.at(-1)?.completion).toEqual(completed);
    expect(
      app.registry.details(id)?.sections?.filter((section) => section.completion),
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Extensions consuming input with notices never show fake intermediate runs", async () => {
  // Distinguish input-hook consumption from model execution, not just registered commands.
  let requests = 0;
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      requests++;

      return options.streamFn!(model, context, request);
    },
  }));
  let unsubscribe = () => {};
  try {
    const directory = join(app.directory, "agent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "handled.ts"),
      `export default function (pi) {
      pi.on("input", async (event) => {
        if (event.text !== "/fixture-handled") return;
        pi.sendMessage({ customType: "fixture-info", content: "Settings updated", display: true }, { triggerTurn: false });
        return { action: "handled" };
      });
    }`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    const statuses: (SessionExecutor["state"]["status"] | undefined)[] = [];

    unsubscribe = app.registry.subscribe(() => statuses.push(app.registry.details(id)?.status));

    // Observe session events emitted when notices are published.
    expectOk(await app.registry.prompt(id, "/fixture-handled"));

    // Repairing only final state cannot stop the tail of an already-started spinner.
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("working");
    expect(app.registry.details(id)?.status).toBeNull();
    expect(requests).toBe(0);
    expect(app.registry.details(id)?.result).toBeUndefined();
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
  } finally {
    unsubscribe();
    await app.cleanup();
  }
});

test("Hosted /plan hides its internal request while retaining the displayed command and saved report", async () => {
  let requests = 0;
  const modelContexts: string[] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model, context) => {
      requests++;
      modelContexts.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      if (requests % 2 === 1) {
        message.content = [
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name: "radian-plan",
            arguments: {
              action: "submit",
              plan: {
                schemaVersion: 1,
                goal: "Hosted plan",
                outOfScope: [],
                assumptions: [],
                openQuestions: [],
                tasks: [
                  {
                    id: "work",
                    title: "Implement work",
                    agent: "main",
                    dependsOn: requests > 2 ? ["missing"] : [],
                    inputs: [],
                    outputs: ["Feature"],
                    acceptanceCriteria: ["Feature works"],
                    files: [],
                  },
                ],
              },
              review: { summary: "Checked coverage", warnings: [] },
            },
          },
        ];
        message.stopReason = "toolUse";
      } else {
        message.content = [{ type: "text", text: "Planning response finished." }];
      }
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const conversation = app.registry.details(id)!.conversationId!;
    const runPlan = async (text: string) => {
      const settled = Promise.withResolvers<void>();
      let working = false;
      const unsubscribe = app.registry.subscribe(() => {
        const status = app.registry.details(id)?.status;
        if (status === "working") working = true;
        if (working && status === "complete") settled.resolve();
      });
      try {
        expectOk(await app.registry.prompt(id, text));
        await settled.promise;
      } finally {
        unsubscribe();
      }
    };
    await runPlan("/plan Hosted valid");
    const file = app.registry.sessionFile(id)!;
    const owner = { conversationId: conversation, cwd: app.main.path };
    const before = expectOk(await readTaskPlan(file, owner))!;
    const live = app.registry.details(id)!;
    const displayed = live.sections ?? [];
    expect(displayed.filter((section) => section.kind === "user")).toMatchObject([
      { text: "/plan", commandName: "plan" },
      { text: "Hosted valid" },
    ]);
    expect(displayed.some((section) => section.title === "radian.task-plan-request")).toBe(false);
    expect(JSON.stringify(displayed)).not.toContain("Read repository instructions");
    expect(live.output).not.toContain("Read repository instructions");
    expect(live.request?.text).toBe("/plan Hosted valid");
    expect(live.result?.request?.text).toBe("/plan Hosted valid");
    expect(modelContexts[0]).toContain("Read repository instructions");
    expect(modelContexts[0]).toContain("User requirements:\\nHosted valid");
    expect(
      displayed.some((section) => section.text.includes("Semantic review (agent assessment)")),
    ).toBe(true);
    expect(
      displayed.some((section) => section.kind === "tool" && section.title === "radian-plan"),
    ).toBe(true);

    await runPlan("/plan Hosted invalid");
    const after = expectOk(await readTaskPlan(file, owner))!;
    expect(after.hash).toBe(before.hash);
    expect(
      app.registry
        .details(id)
        ?.sections?.some(
          (section) =>
            section.kind === "tool" &&
            section.title === "radian-plan" &&
            section.status === "error" &&
            section.text.includes("missing"),
        ),
    ).toBe(true);
    // Each planning invocation is recorded once, even when its proposed revision fails.
    expect(
      app.registry.details(id)?.sections?.filter((section) => section.kind === "user"),
    ).toMatchObject([
      { text: "/plan", commandName: "plan" },
      { text: "Hosted valid" },
      { text: "/plan", commandName: "plan" },
      { text: "Hosted invalid" },
    ]);
    expect(app.registry.details(id)?.result?.request?.text).toBe("/plan Hosted invalid");
    expect(
      modelContexts.some((context) => context.includes("User requirements:\\nHosted invalid")),
    ).toBe(true);
    const preview = expectOk(await readHistoryPreview(file, app.main.id, conversation));
    expect(
      preview.sections?.some((section) =>
        section.text.includes("Semantic review (agent assessment)"),
      ),
    ).toBe(true);
    expect(JSON.stringify(preview.sections)).not.toContain("Read repository instructions");
    expectOk(await app.registry.close(id));
    const reopened = expectOk(await app.registry.create(app.main.id, file));
    expect(
      app.registry
        .details(reopened)
        ?.sections?.some((section) => section.text.includes("Semantic review (agent assessment)")),
    ).toBe(true);
    expect(JSON.stringify(app.registry.details(reopened)?.sections)).not.toContain(
      "Read repository instructions",
    );
  } finally {
    await app.cleanup();
  }
});

test("Hosted planning retains the delivered command request through a held and settled run", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const app = await sdkFixture(false, (options) => ({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model) => {
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [{ type: "text", text: "Response finished" }];
      if (hold) {
        stream.push({ type: "start", partial: message });
        started.resolve();
        void release.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
      } else {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }

      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "Previous ordinary request"));
    hold = true;
    const settled = Promise.withResolvers<void>();
    let working = false;
    const unsubscribe = app.registry.subscribe(() => {
      const status = app.registry.details(id)?.status;
      if (status === "working") working = true;
      if (working && status === "complete") settled.resolve();
    });
    try {
      expectOk(await app.registry.prompt(id, "/plan Verify metadata"));
      await started.promise;
      const live = app.registry.details(id);
      expect(live?.request?.text).toBe("/plan Verify metadata");
      expect(live?.sections?.filter((section) => section.kind === "user")).toMatchObject([
        { text: "Previous ordinary request" },
        { text: "/plan", commandName: "plan" },
        { text: "Verify metadata" },
      ]);
      expect(live?.sections?.some((section) => section.title === "radian.task-plan-request")).toBe(
        false,
      );
      release.resolve();
      await settled.promise;
    } finally {
      release.resolve();
      unsubscribe();
    }
    const complete = app.registry.details(id);
    expect(complete?.request?.text).toBe("/plan Verify metadata");
    expect(complete?.result?.request?.text).toBe("/plan Verify metadata");
    expect(complete?.sections?.filter((section) => section.commandName === "plan")).toHaveLength(1);
    expect(JSON.stringify(complete?.sections)).not.toContain("Read repository instructions");
  } finally {
    release.resolve();
    await app.cleanup();
  }
});

test("A failed hosted planning turn keeps its command request without exposing internal instructions", async () => {
  // Provider failure is terminal, but the pre-recorded invocation remains the request identity.
  const app = await sdkFixture(false, (options) => ({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model) => {
      const stream = createAssistantMessageEventStream();
      const failure = fixtureMessage(model.api, model.provider, model.id);
      failure.stopReason = "error";
      failure.errorMessage = "Fixture planning provider failure";
      stream.push({ type: "error", reason: "error", error: failure });
      stream.end();
      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));

    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.status === "failure") settled.resolve();
    });
    try {
      expectOk(await app.registry.prompt(id, "/plan Check provider failure"));
      await settled.promise;
    } finally {
      unsubscribe();
    }

    const details = app.registry.details(id)!;
    expect(details.status).toBe("failure");
    expect(details.request?.text).toBe("/plan Check provider failure");
    expect(details.result?.outcome).toBe("error");
    expect(details.result?.request?.text).toBe("/plan Check provider failure");
    expect(details.sections?.filter((section) => section.kind === "user")).toMatchObject([
      { text: "/plan", commandName: "plan" },
      { text: "Check provider failure" },
    ]);
    expect(JSON.stringify(details.sections)).not.toContain("Read repository instructions");
  } finally {
    await app.cleanup();
  }
});

test("An interrupted hosted planning turn retains its persisted command and hidden instructions", async () => {
  // Cancellation before the provider finishes must not erase the initial real user entry.
  const started = Promise.withResolvers<void>();
  const app = await sdkFixture(false, (options) => ({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model, _context, request) => {
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      stream.push({ type: "start", partial: message });
      started.resolve();
      request?.signal?.addEventListener(
        "abort",
        () => {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end();
        },
        { once: true },
      );
      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "/plan Stop this turn");
    await started.promise;

    expectOk(await app.registry.interrupt(id));
    expectOk(await running);

    const details = app.registry.details(id)!;
    const file = app.registry.sessionFile(id)!;
    const preview = expectOk(await readHistoryPreview(file, app.main.id, details.conversationId!));
    expect(details.request?.text).toBe("/plan Stop this turn");
    expect(details.result?.request?.text).toBe("/plan Stop this turn");
    expect(details.result?.outcome).toBe("cancelled");
    expect(details.sections?.filter((section) => section.commandName === "plan")).toHaveLength(1);
    expect(preview.sections?.filter((section) => section.kind === "user")).toMatchObject([
      { text: "/plan", commandName: "plan" },
      { text: "Stop this turn" },
    ]);
    expect(JSON.stringify(details.sections)).not.toContain("Read repository instructions");
    expect(JSON.stringify(preview)).not.toContain("Read repository instructions");
    expect(
      SessionManager.open(file)
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("An overriding /plan extension does not record the built-in planning request", async () => {
  const app = await sdkFixture(false, (options) => ({ ...options, defaultPackagePaths: [] }));
  try {
    const directory = join(app.directory, "agent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "plan-override.ts"),
      `export default function (pi) {
        pi.registerCommand("plan", { handler: () => {
          pi.sendMessage({ customType: "fixture-plan-override", content: "Overridden", display: true });
        } });
      }`,
    );
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "/plan Overridden request"));
    expect(
      app.registry
        .details(id)
        ?.sections?.some((section) => section.title === "fixture-plan-override"),
    ).toBe(true);
    expect(app.registry.details(id)?.sections?.some((section) => section.kind === "user")).toBe(
      false,
    );
    expect(await Bun.file(app.registry.sessionFile(id)!).exists()).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test("A plan-only conversation has a History title and a reopened request", async () => {
  const app = await sdkFixture(false, (options) => ({ ...options, defaultPackagePaths: [] }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const settled = Promise.withResolvers<void>();
    let working = false;
    const unsubscribe = app.registry.subscribe(() => {
      const status = app.registry.details(id)?.status;
      if (status === "working") working = true;
      if (working && status === "complete") settled.resolve();
    });
    try {
      expectOk(await app.registry.prompt(id, "/plan First planning request"));
      await settled.promise;
    } finally {
      unsubscribe();
    }
    const file = app.registry.sessionFile(id)!;
    expectOk(await app.registry.close(id));
    const history = new SessionHistory(
      [app.repository],
      app.registry,
      join(app.directory, "agent", "sessions"),
    );
    const items = expectOk(await history.list(app.main.id));
    expect(items.some((item) => item.title === "/plan First planning request")).toBe(true);
    const reopened = expectOk(await app.registry.create(app.main.id, file));
    expect(app.registry.details(reopened)?.request?.text).toBe("/plan First planning request");
    expect(app.registry.details(reopened)?.result?.request?.text).toBe(
      "/plan First planning request",
    );
  } finally {
    await app.cleanup();
  }
});

test.each(["ordinary initial request", "/plan Initial planning request"])(
  "An initial request is persisted before provider completion: %s",
  async (input) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let providerUserRequests: string[] = [];
    const app = await sdkFixture(false, (options) => ({
      ...options,
      defaultPackagePaths: [],
      streamFn: (model, context) => {
        providerUserRequests = context.messages.flatMap((message) =>
          message.role === "user"
            ? [
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join(""),
              ]
            : [],
        );
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        stream.push({ type: "start", partial: message });
        started.resolve();
        void release.promise.then(() => {
          message.content = [{ type: "text", text: "Finished" }];
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });

        return stream;
      },
    }));
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      let working = false;
      const settled = Promise.withResolvers<void>();
      const unsubscribe = app.registry.subscribe(() => {
        const status = app.registry.details(id)?.status;
        if (status === "working") working = true;
        if (working && status === "complete") settled.resolve();
      });
      try {
        const pending = app.registry.prompt(id, input);
        await started.promise;
        const file = app.registry.sessionFile(id)!;
        expect(await Bun.file(file).exists()).toBe(true);
        if (input.startsWith("/plan")) {
          const entries = SessionManager.open(
            file,
            join(app.directory, "agent", "sessions"),
            app.main.path,
          ).getBranch();
          const users = entries.filter(
            (entry) => entry.type === "message" && entry.message.role === "user",
          );
          const display = entries.find(
            (entry) => entry.type === "custom" && entry.customType === commandDisplayEntryType,
          );
          expect(users).toHaveLength(1);
          expect(display?.type === "custom" && display.data).toMatchObject({
            messageId: users[0]?.id,
            parts: [{ text: "/plan", commandName: "plan" }, { text: "Initial planning request" }],
          });
          expect(entries.indexOf(display!)).toBe(entries.indexOf(users[0]!) + 1);
          const preview = expectOk(
            await readHistoryPreview(file, app.main.id, app.registry.details(id)!.conversationId!),
          );
          expect(preview.sections?.filter((section) => section.kind === "user")).toMatchObject([
            { text: "/plan", commandName: "plan" },
            { text: "Initial planning request" },
          ]);
          expect(JSON.stringify(preview)).not.toContain("Read repository instructions");
          expect(providerUserRequests.filter((request) => request === input)).toHaveLength(1);
          expect(
            providerUserRequests.some((request) =>
              request.includes("User requirements:\nInitial planning request"),
            ),
          ).toBe(true);
        }
        release.resolve();
        expectOk(await pending);
        await settled.promise;
      } finally {
        release.resolve();
        unsubscribe();
      }
    } finally {
      release.resolve();
      await app.cleanup();
    }
  },
);

test("Registered slash commands starting real model work report working and completion", async () => {
  // Hiding all slash-prefixed loading would also hide extensions starting real work.
  const app = await sdkFixture(true);
  const settled = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  try {
    const directory = join(app.directory, "agent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "run.ts"),
      `export default function (pi) {
      pi.registerCommand("fixture-run", { handler: async () => { pi.sendUserMessage("hold command"); } });
    }`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.status === "complete") {
        settled.resolve();
      }
    });

    // Start real SDK work before withholding the provider response.
    expectOk(await app.registry.prompt(id, "/fixture-run"));
    await app.streams.waitFor("command");

    // Unlike control commands, real work must be tracked from start to finish.
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.registry.details(id)?.runTiming).toBeDefined();
    app.streams.gates.get("command")!.finish("Command work finished");
    await settled.promise;
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.result?.outcome).toBe("complete");
  } finally {
    unsubscribe();
    await app.cleanup();
  }
});

test.each([true, false])(
  "Completion metadata persistence failures warn without rejecting finished requests: %j",
  async (expected) => {
    // Fail only supplementary metadata persistence after model and tool work finishes.
    const app = await sdkFixture();
    const original = SessionManager.prototype.appendCustomEntry;
    const failure = Object.assign(
      new Error("Timing persistence fixture"),
      expected ? { code: "EIO" } : {},
    );
    const log = spyOn(console, "error").mockImplementation(() => {});
    const append = spyOn(SessionManager.prototype, "appendCustomEntry").mockImplementation(
      function (this: SessionManager, type, data) {
        if (type === runCompletionEntryType) {
          throw failure;
        }

        return original.call(this, type, data);
      },
    );
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      expectOk(await app.registry.prompt(id, "read"));
      // Separate completion from persistence warnings and log unexpected errors with original stacks.
      expect(app.registry.details(id)?.status).toBe("complete");
      expect(app.registry.details(id)?.error).toBeNull();

      const completion = app.registry.details(id)?.sections?.at(-1)?.completion;
      expect(completion?.outcome).toBe("complete");
      expect(completion?.warning).toContain(
        expected ? "STORAGE_FAILED" : "Unexpected run timing persistence",
      );
      if (expected) {
        expect(log).not.toHaveBeenCalled();
      } else {
        expect(log.mock.calls.some((call) => call.includes(failure))).toBe(true);
      }
    } finally {
      append.mockRestore();
      log.mockRestore();
      await app.cleanup();
    }
  },
);

test("SDK command failure notifications return failure Results instead of accepted success", async () => {
  const app = await sdkFixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await commandExtension(app.directory);

    const id = expectOk(await app.registry.create(app.main.id));
    let accepted = false;
    const failure = expectError(
      await app.registry.prompt(id, "/fixture-broken", () => {
        accepted = true;
      }),
    );

    expect(failure.code).toBe("AGENT_FAILED");
    expect(failure.message).toContain("Fixture command failure");
    expect(accepted).toBe(false);
    expect(app.registry.details(id)?.status).toBeNull();
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    await app.cleanup();
  }
});

test("Commands awaiting models preserve completion state and never deadlock on close", async () => {
  const app = await sdkFixture(true);
  try {
    await commandExtension(app.directory);

    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold A");

    await app.streams.waitFor("A");

    const command = app.registry.prompt(id, "/fixture-wait");
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    app.streams.gates.get("A")!.finish("finished");
    expectOk(await run);
    expectOk(await command);
    expect(app.registry.details(id)?.status).toBe("complete");

    const next = app.registry.prompt(id, "hold B");
    await app.streams.waitFor("B");

    const waiting = app.registry.prompt(id, "/fixture-wait");
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    const close = app.registry.close(id);
    const gate = app.streams.gates.get("B")!;

    await gate.abortReceived;
    gate.finish("aborted");
    await Promise.all([next, waiting]);
    expectOk(await close);
    expect(app.registry.details(id)).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test("SDK sessions discover extensions in agentDir and execute registered tools", async () => {
  // Isolate extension discovery from the user's packages, credentials and external services.
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      if (context.messages.at(-1)?.role !== "user") {
        return options.streamFn!(model, context, request);
      }

      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);

      message.content = [
        { type: "toolCall", id: "extension-probe", name: "extension_probe", arguments: {} },
      ];
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();

      return stream;
    },
  }));
  try {
    const directory = join(app.directory, "agent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "probe.ts"),
      `
      import { Type } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
      export default function (pi) {
        pi.registerTool({ name: "extension_probe", label: "Extension probe", description: "Isolated extension probe",
          parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "EXTENSION_PROBE_OK" }], details: {} }) });
      }
    `,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "run extension probe"));

    const tool = app.registry
      .details(id)
      ?.sections?.find((section) => section.kind === "tool" && section.title === "extension_probe");
    expect(tool?.status).toBe("complete");
    expect(tool?.text).toContain("EXTENSION_PROBE_OK");
  } finally {
    await app.cleanup();
  }
});

test("Fast commands avoid model calls and apply or remove priority on native Codex HTTP requests", async () => {
  // A loopback SSE server exercises the real provider encoder without a paid model or user credentials.
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const bytes = Buffer.from(await request.arrayBuffer());
      const json =
        request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
      const body = JSON.parse(json.toString("utf8")) as Record<string, unknown>;

      bodies.push(body);

      const message = {
        id: "msg-fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Native fixture response", annotations: [] }],
      };
      const response = {
        id: `resp-${bodies.length}`,
        status: "completed",
        model: "native-fixture",
        output: [message],
        service_tier: body.service_tier ?? "default",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      const events = [
        { type: "response.created", response: { id: response.id, status: "in_progress" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Native fixture response",
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response },
      ];

      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const app = await sdkFixture(false, (options) => {
    const modelRuntime = options.modelRuntime!;
    const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;

    modelRuntime.registerProvider("native-fast-fixture", {
      api: "openai-codex-responses",
      apiKey,
      baseUrl: server.url.origin,
      models: [
        {
          id: "native-fixture",
          name: "Native fixture",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });

    const configured: PiSessionOptions = {
      ...options,
      model: modelRuntime.getModel("native-fast-fixture", "native-fixture")!,
      settings: {
        transport: "sse",
        defaultThinkingLevel: "high",
        retry: { enabled: false },
        compaction: { enabled: false },
      },
    };
    delete configured.streamFn;

    return configured;
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expect(app.registry.details(id)?.telemetry?.fast).toBe(false);

    const statuses: (SessionExecutor["state"]["status"] | undefined)[] = [];
    const toggle = async (text: string) => {
      statuses.length = 0;

      const before = app.registry.details(id);
      const unsubscribe = app.registry.subscribe(() =>
        statuses.push(app.registry.details(id)?.status),
      );
      try {
        expectOk(await app.registry.prompt(id, text));
      } finally {
        unsubscribe();
      }

      // Fast telemetry must not start prompt or session-tab loading.
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses).not.toContain("working");
      expect(app.registry.details(id)?.status).toBe(before?.status);
      expect(app.registry.details(id)?.result).toEqual(before?.result);
    };

    await toggle("/fast on");
    await toggle("/fast status");
    await toggle("/fast off");
    await toggle("/fast");
    expect(bodies).toHaveLength(0);
    // Reload preserves Fast selection and telemetry subscriptions without model requests.
    expectOk(await app.registry.reload(id));
    expect(bodies).toHaveLength(0);
    expect(app.registry.details(id)?.telemetry?.fast).toBe(true);

    expectOk(await app.registry.prompt(id, "priority fixture request"));

    expect(bodies[0]?.service_tier).toBe("priority");
    expect(bodies[0]?.reasoning).toMatchObject({ effort: "high" });
    expect(app.registry.details(id)?.telemetry?.fast).toBe(true);
    await toggle("/fast off");
    expect(bodies).toHaveLength(1);
    expect(app.registry.details(id)?.telemetry?.fast).toBe(false);
    expectOk(await app.registry.prompt(id, "standard fixture request"));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("service_tier");
    expect(bodies[1]?.reasoning).toMatchObject({ effort: "high" });
  } finally {
    await app.cleanup();
    await server.stop(true);
  }
});

test("Real SDK read/write uses the selected worktree cwd without modifying other worktrees", async () => {
  // Real Git worktrees and SDK built-in tools are used; only model responses are scripted.
  const app = await sdkFixture();
  try {
    const a = expectOk(await app.registry.create(app.main.id));
    const b = expectOk(await app.registry.create(app.feature.id));
    const originalCwd = process.cwd();

    // Concurrent prompts route identical relative paths to different workspace handles.
    await Promise.all([app.registry.prompt(a, "read"), app.registry.prompt(b, "read")]);
    app.selection.selectSession(app.feature.id, b);
    await app.registry.prompt(b, "write");

    // Repository discovery, tool cwd and process cwd remain independent of display selection.
    expect(app.registry.details(a)?.output).toContain("main-worktree-marker");
    expect(app.registry.details(b)?.output).toContain("feature-worktree-marker");
    expect(await Bun.file(join(app.feature.path, "radian-probe.txt")).text()).toBe(
      "Offline SDK write probe\n",
    );
    expect(await Bun.file(join(app.main.path, "radian-probe.txt")).exists()).toBe(false);
    expect(process.cwd()).toBe(originalCwd);
    expect(app.registry.details(a)?.status).toBe("complete");

    const read = app.registry
      .details(a)
      ?.sections?.find((section) => section.kind === "tool" && section.title === "read");
    expect(read?.status).toBe("complete");
    expect(read?.text).toContain("main-worktree-marker");
    expect(read?.text).toContain("Arguments:");
    expect(app.registry.details(a)?.sections?.some((section) => section.kind === "user")).toBe(
      true,
    );
  } finally {
    await app.cleanup();
  }
});

test("Two real SDK runs survive worktree switching and restore background results on selection", async () => {
  // Provider completion is held explicitly, so switching cannot accidentally occur after work ended.
  const app = await sdkFixture(true);
  try {
    const a = expectOk(await app.registry.create(app.main.id));
    const b = expectOk(await app.registry.create(app.feature.id));
    const runA = app.registry.prompt(a, "hold A");
    const runB = app.registry.prompt(b, "hold B");

    await Promise.all([app.streams.waitFor("A"), app.streams.waitFor("B")]);

    // A continues on its original SDK handle while B is the visible workspace.
    app.selection.selectSession(app.feature.id, b);
    expect(app.registry.details(a)?.status).toBe("working");
    app.streams.gates.get("A")!.finish("A finished in the background");
    await runA;
    expect(app.selection.sessionId).toBe(b);
    app.selection.selectWorktree(app.main.id);

    // Returning restores A without an abort, replacement, or a second provider request.
    expect(app.selection.sessionId).toBe(a);
    expect(app.registry.details(a)?.output).toContain("A finished in the background");
    expect(app.streams.gates.get("A")!.aborted).toBe(false);
    expect(app.streams.gates.get("B")!.aborted).toBe(false);
    expect(app.executors).toHaveLength(2);
    app.streams.gates.get("B")!.finish("B done");
    await runB;
  } finally {
    await app.cleanup();
  }
});

test("Direct Pi subagent tools expose their authored input only after an exact launch receipt", async () => {
  // A scripted model invokes the real SDK tool boundary without starting an external child process.
  const task = "Check the actual delegated input";
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      if (context.messages.at(-1)?.role === "toolResult") {
        return options.streamFn!(model, context, request);
      }

      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);

      message.content = [
        {
          type: "toolCall",
          id: "launch",
          name: "subagent",
          arguments: { agent: "implementer", task },
        },
      ];
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();

      return stream;
    },
  }));
  try {
    const extensions = join(app.directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "subagent.ts"),
      `export default function(pi) {
      pi.registerTool({ name: "subagent", label: "Subagent", description: "Fixture child", parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"] }, execute: async (_id, args, _signal, _update, ctx) => {
        pi.events.emit("subagent:async-started", { id: "direct", mode: "single", agent: args.agent, task: "[prompt redacted]" });
        const now = Date.now();
        ctx.ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: now,
          runs: [{ id: "direct", kind: "subagent", label: args.agent, state: "running", children: [{ id: "step:0", kind: "step", label: "Test implementer response", state: "running", startedAt: now - 9000 }] }],
        })]);
        return { content: [{ type: "text", text: "Started" }], details: { mode: "single", asyncId: "direct" } };
      } });
    }`,
    );

    const id = expectOk(await app.registry.create(app.main.id));

    expectOk(await app.registry.prompt(id, "Start the child"));

    // Observed Pi work keeps its identity and input, but acquires no Radian-owned child handle.
    const children = app.registry.snapshot[0]!.worktrees.find((tree) => tree.id === app.main.id)!
      .sessions[0]!.subagents;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      name: "implementer",
      source: "pi",
      status: "working",
      request: { text: task, images: 0, files: 0 },
    });
    expect(children[0]!.runTiming!.elapsedMs).toBeGreaterThanOrEqual(9000);
    expect(app.executors).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Owned SDK children retain their received task and runtime duration after completion", async () => {
  // Delegation starts a real child session whose first input differs from its parent's request.
  const app = await sdkFixture(true);
  try {
    const parent = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(parent, "delegate");

    await app.streams.waitFor("child");

    const children = () => app.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents;

    // Working snapshots expose the actual child task and the runtime-owned clock.
    expect(children()).toHaveLength(1);
    expect(children()[0]?.request?.text).toBe("slow");
    expect(children()[0]?.status).toBe("working");
    expect(children()[0]?.runTiming?.elapsedMs).toBeGreaterThanOrEqual(0);
    app.streams.gates.get("child")!.finish("Child completed");
    expectOk(await run);

    // Closing the child executor must not discard the preview or restart its timer.
    const completed = children()[0]!;
    expect(completed.status).toBe("complete");
    expect(completed.request?.text).toBe("slow");
    expect(completed.runTiming?.elapsedMs).toBeGreaterThan(0);
    expect(children()[0]?.runTiming).toEqual(completed.runTiming);

    const saved = app.registry.records[0]!.subagents[0]!;
    expect(saved.request).toEqual(completed.request);
    expect(saved.runTiming).toEqual(completed.runTiming);
  } finally {
    await app.cleanup();
  }
});

test("SDK parents and subagents hide immediately and terminate in background without stopping other sessions", async () => {
  // The registered custom tool starts an actual owned SDK child, not a display-only fixture.
  const app = await sdkFixture(true);
  try {
    const parent = expectOk(await app.registry.create(app.main.id));
    const other = expectOk(await app.registry.create(app.feature.id));
    const delegating = app.registry.prompt(parent, "delegate");
    const unrelated = app.registry.prompt(other, "hold B");

    await Promise.all([app.streams.waitFor("child"), app.streams.waitFor("B")]);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents).toHaveLength(1);

    const file = app.registry.sessionFile(parent)!;
    expect(
      expectError(await app.registry.create(app.main.id, app.executors[2]!.sessionFile!)).code,
    ).toBe("SESSION_CONFLICT");

    // UI removal is synchronous, while the child deliberately delays its cancellation acknowledgement.
    const closing = app.registry.close(parent);
    expect(app.registry.details(parent)).toBeNull();
    expect(app.registry.closingCount).toBe(1);
    await app.streams.gates.get("child")!.abortReceived;
    expect(expectError(await app.registry.create(app.main.id, file)).code).toBe("SESSION_CONFLICT");
    expect(app.streams.gates.get("B")!.aborted).toBe(false);
    app.streams.gates.get("child")!.finish("child cancelled");

    const [closed, cancelled] = await Promise.all([closing, delegating]);
    expectOk(closed);
    expect(expectError(cancelled).code).toBe("CANCELLED");

    // Cleanup completes for the owned family, preserves history, and leaves B untouched.
    expect(app.registry.closingCount).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);
    expect(app.registry.details(other)?.status).toBe("working");
    app.streams.gates.get("B")!.finish("B complete");
    await unrelated;
  } finally {
    await app.cleanup();
  }
});

test("Reopening closed SDK sessions restores the same saved ID and history without forking", async () => {
  // A finalized user/assistant exchange has been persisted in an isolated session directory.
  const app = await sdkFixture();
  try {
    const original = expectOk(await app.registry.create(app.main.id));
    await app.registry.prompt(original, "read");

    const file = app.registry.sessionFile(original)!;
    const completion = app.registry.details(original)?.sections?.at(-1)?.completion;

    expect(completion?.outcome).toBe("complete");
    expect(completion?.durationMs).toBeGreaterThanOrEqual(0);

    const saved = SessionManager.open(file);
    const savedId = saved.getSessionId();

    expect(
      saved
        .getBranch()
        .findLast(
          (entry) => entry.type === "custom" && entry.customType === runCompletionEntryType,
        ),
    ).toMatchObject({ data: completion });
    expect(JSON.stringify(saved.buildSessionContext().messages)).not.toContain(
      runCompletionEntryType,
    );

    // Close and reopen use a new display ID but the original persisted session file.
    await app.registry.close(original);

    const reopened = expectOk(await app.registry.create(app.main.id, file));

    // SDK restoration, not transcript copying, reconstructs the conversation.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(app.executors.at(-1)!.savedSessionId).toBe(savedId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
    expect(app.registry.details(reopened)?.sections?.at(-1)?.completion).toEqual(completion);
    expect(
      app.registry.details(reopened)?.sections?.find((section) => section.kind === "tool")?.text,
    ).toContain("main-worktree-marker");
    expect(
      (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "session"),
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Input during SDK execution queues after the current response without replacing sessions", async () => {
  // Hold the real provider response so admission cannot be confused with completion.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");

    await app.streams.waitFor("A");

    const accepted = Promise.withResolvers<void>();

    // Pi queues B without aborting A or waiting for A's completion to acknowledge it.
    expectOk(await app.registry.prompt(id, "hold B", accepted.resolve));
    await accepted.promise;
    expect(app.streams.gates.has("B")).toBe(false);
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.streams.gates.get("A")!.aborted).toBe(false);
    app.streams.gates.get("A")!.finish("A complete");
    await app.streams.waitFor("B");
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    app.streams.gates.get("B")!.finish("B complete");
    expectOk(await running);

    // Both turns belong to the original SDK session and settle only after B.
    expect(app.executors).toHaveLength(1);
    expect(app.registry.details(id)?.output).toContain("B complete");
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(
      app.registry.details(id)?.sections?.filter((section) => section.completion),
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Interrupt preserves sessions and merges queued input with newlines for one delivery", async () => {
  // Hold A so neither queued message can be delivered before the interrupt.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");

    await app.streams.waitFor("A");
    expectOk(await app.registry.prompt(id, "second"));
    expectOk(await app.registry.prompt(id, "third"));
    expect(app.registry.details(id)?.pendingMessages?.map((message) => message.text)).toEqual([
      "second",
      "third",
    ]);
    expect(app.registry.details(id)?.runTiming?.elapsedMs).toBeGreaterThanOrEqual(0);

    // Repeated Esc coalesces while the provider is still acknowledging cancellation.
    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.status === "complete") {
        settled.resolve();
      }
    });
    const interrupt = app.registry.interrupt(id);
    const repeated = app.registry.interrupt(id);

    await app.streams.gates.get("A")!.abortReceived;
    expect(app.registry.details(id)?.pendingMessages?.map((message) => message.text)).toEqual([
      "second",
      "third",
    ]);
    app.streams.gates.get("A")!.finish("interrupted");
    expectOk(await interrupt);
    expectOk(await repeated);
    expect(expectError(await running).code).toBe("CANCELLED");
    await settled.promise;
    unsubscribe();

    // Only delivered input is persisted; the two queue entries become one user message.
    const messages = SessionManager.open(app.registry.sessionFile(id)!)
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? [
              typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
            ]
          : [],
      );
    expect(messages).toEqual(["hold A", "second\nthird"]);
    expect(app.executors).toHaveLength(1);
    expect(app.registry.details(id)?.pendingMessages).toEqual([]);
    expectOk(await app.registry.prompt(id, "continue in the same conversation"));
  } finally {
    await app.cleanup();
  }
});

test("Merging queued input preserves image bytes and duplicate-input order", async () => {
  // Two equal texts still represent two accepted messages, each with its own image.
  const app = await sdkFixture(true, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const path = join(app.directory, "queued.png");

    await writeFile(path, tinyPng());

    const running = app.registry.prompt(id, "hold A");
    await app.streams.waitFor("A");
    expectOk(await app.registry.prompt(id, "same", undefined, [path]));
    expectOk(await app.registry.prompt(id, "same", undefined, [path]));
    expect(app.registry.details(id)?.pendingMessages).toEqual([
      summarizeRequest("same", 1),
      summarizeRequest("same", 1),
    ]);

    const settled = Promise.withResolvers<void>();
    const unsubscribe = app.registry.subscribe(() => {
      if (app.registry.details(id)?.status === "complete") {
        settled.resolve();
      }
    });

    const interrupted = app.registry.interrupt(id);

    await app.streams.gates.get("A")!.abortReceived;
    app.streams.gates.get("A")!.finish("cancelled");
    expectOk(await interrupted);
    await running;
    await settled.promise;
    unsubscribe();

    const users = SessionManager.open(app.registry.sessionFile(id)!)
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
      );
    const last = users.at(-1)!;

    expect(users).toHaveLength(2);
    expect(
      typeof last.content === "string"
        ? last.content
        : last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
    ).toBe("same\nsame");
    expect(
      typeof last.content === "string"
        ? []
        : last.content.filter((part) => part.type === "image").map((part) => part.data),
    ).toEqual([tinyPng().toString("base64"), tinyPng().toString("base64")]);
  } finally {
    await app.cleanup();
  }
});

test("Interrupt cancels manual compaction while preserving conversation and session", async () => {
  // Only the summary request waits; ordinary conversation uses the real offline SDK path.
  let summarizing = false;
  const started = Promise.withResolvers<void>();
  const app = await sdkFixture(false, (options) => ({
    ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      if (!summarizing) {
        return options.streamFn!(model, context, request);
      }

      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      const cancel = () => {
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      };
      if (request?.signal?.aborted) {
        cancel();
      } else {
        request?.signal?.addEventListener("abort", cancel, { once: true });
      }

      started.resolve();

      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first"));
    expectOk(await app.registry.prompt(id, "second"));

    const before = app.registry.details(id)!;
    summarizing = true;

    const compact = app.registry.compact(id);
    await started.promise;

    expectOk(await app.registry.interrupt(id));

    expect(expectError(await compact).code).toBe("CANCELLED");
    expect(app.registry.details(id)?.sections?.at(-1)).toMatchObject({
      title: "Compaction cancelled",
      status: "cancelled",
    });
    expect(app.registry.details(id)?.conversationId).toBe(before.conversationId);
    expect(app.registry.details(id)?.runTiming).toBeUndefined();
    expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([
      ...before.sections!,
    ]);
    summarizing = false;
    expectOk(await app.registry.prompt(id, "continue"));
  } finally {
    await app.cleanup();
  }
});

test("Unaccepted image input still preparing at interruption never executes later", async () => {
  // Image decoding is an SDK/OS boundary that can finish after the user presses Esc.
  const loading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = await sdkFixture(true, (options) => ({
    ...options,
    model: { ...options.model!, input: ["text", "image"] },
    imageLoader: async () => {
      loading.resolve();
      await release.promise;

      return ok([]);
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "hold A");

    await app.streams.waitFor("A");

    let accepted = false;
    const preparing = app.registry.prompt(
      id,
      "Late image input",
      () => {
        accepted = true;
      },
      ["/fixture/image.png"],
    );

    await loading.promise;

    const interrupted = app.registry.interrupt(id);
    await app.streams.gates.get("A")!.abortReceived;
    release.resolve();
    app.streams.gates.get("A")!.finish("cancelled");
    expectOk(await interrupted);

    expect(expectError(await preparing).code).toBe("CANCELLED");
    expect(accepted).toBe(false);
    await running;
    expect(app.registry.details(id)?.pendingMessages).toEqual([]);
    expect(app.registry.details(id)?.output).not.toContain("Late image input");
  } finally {
    release.resolve();
    await app.cleanup();
  }
});

test("Interrupt waits for owned subagent cancellation without closing the parent session", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const running = app.registry.prompt(id, "delegate");

    await app.streams.waitFor("child");

    const interrupted = app.registry.interrupt(id);
    await app.streams.gates.get("child")!.abortReceived;
    app.streams.gates.get("child")!.finish("cancelled child");
    expectOk(await interrupted);

    expect(expectError(await running).code).toBe("CANCELLED");
    expect(app.registry.details(id)).not.toBeNull();
    expect(app.registry.closingCount).toBe(0);
    expectOk(await app.registry.prompt(id, "Continue after cancellation"));
  } finally {
    await app.cleanup();
  }
});

test("Interrupt without queued input cancels only the selected run", async () => {
  // Two independent sessions prove this is not runtime shutdown or session close.
  const app = await sdkFixture(true);
  try {
    const a = expectOk(await app.registry.create(app.main.id));
    const b = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(a, "hold A");
    const second = app.registry.prompt(b, "hold B");

    await Promise.all([app.streams.waitFor("A"), app.streams.waitFor("B")]);

    const interrupt = app.registry.interrupt(a);
    await app.streams.gates.get("A")!.abortReceived;
    app.streams.gates.get("A")!.finish("cancelled");
    expectOk(await interrupt);

    expect(expectError(await first).code).toBe("CANCELLED");
    expect(app.streams.gates.get("B")!.aborted).toBe(false);
    expect(
      app.registry.snapshot[0]?.worktrees.find((tree) => tree.id === app.main.id)?.sessions,
    ).toHaveLength(2);
    expect(app.registry.details(a)?.runTiming).toBeUndefined();
    app.streams.gates.get("B")!.finish("finished");
    expectOk(await second);
  } finally {
    await app.cleanup();
  }
});

test("Concurrent SDK submissions serialize acceptance and preserve actual queue order", async () => {
  // Startup includes asynchronous SDK preflight; no stream is active at invocation time.
  const app = await sdkFixture();
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const admissions = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];

    // Concurrent callers must not create three overlapping initial runs.
    const runs = ["A", "B", "C"].map((name, i) =>
      app.registry.prompt(id, `hold ${name}`, admissions[i]!.resolve),
    );

    await Promise.all(admissions.map((item) => item.promise));
    for (const result of await Promise.all(runs)) {
      expectOk(result);
    }

    // Early steering may join the initial request; finalized user-message order is authoritative.
    const messages = SessionManager.open(app.registry.sessionFile(id)!)
      .getBranch()
      .flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "user") {
          return [];
        }

        const content = entry.message.content;

        return [
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        ];
      });
    expect(messages).toEqual(["hold A", "hold B", "hold C"]);
    expect(app.executors).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("Intermediate agent_end events during SDK retries do not report completion before final settlement", async () => {
  // The first scripted response is retryable; the second remains held until explicitly released.
  let requests = 0;
  const app = await sdkFixture(true, (options) => ({
    ...options,
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
    streamFn: (model, context, request) => {
      if (++requests !== 1) {
        return options.streamFn!(model, context, request);
      }

      const stream = createAssistantMessageEventStream();
      const error = fixtureMessage(model.api, model.provider, model.id);

      error.stopReason = "error";
      error.errorMessage = "429 Too Many Requests";
      stream.push({ type: "error", reason: "error", error });
      stream.end();

      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const observed: (string | null)[] = [];
    const unsubscribe = app.registry.subscribe(() => {
      observed.push(app.registry.details(id)?.status ?? null);
    });

    // Pi performs the retry; radian does not implement a second retry engine.
    const running = app.registry.prompt(id, "hold Retry");

    await app.streams.waitFor("Retry");
    expect(requests).toBe(2);
    expect(observed).not.toContain("complete");
    expect(app.registry.details(id)?.status).toBe("working");
    expect(app.registry.details(id)?.sections?.some((section) => section.completion)).toBe(false);
    app.streams.gates.get("Retry")!.finish("retry succeeded");
    await running;
    unsubscribe();

    // Completion appears only once Pi settles the successful recovery.
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(app.registry.details(id)?.error).toBeNull();
    expect(
      app.registry.details(id)?.sections?.filter((section) => section.completion),
    ).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test.each(["close", "interrupt"] as const)(
  "Real SDK bash work cancels on %s without leaving owned shell processes",
  async (operation) => {
    // The only spawned shell and filesystem changes belong to an isolated test worktree.
    const app = await sdkFixture(false, (options) => ({
      ...options,
      streamFn: (model, context, request) => {
        const last = context.messages.at(-1);
        if (last?.role !== "user") {
          return options.streamFn!(model, context, request);
        }

        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);

        message.stopReason = "toolUse";
        message.content.push({
          type: "toolCall",
          id: crypto.randomUUID(),
          name: "bash",
          arguments: {
            command: "echo $$ > .bash-probe.pid; echo BASH_STARTED; while :; do sleep 1; done",
          },
        });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();

        return stream;
      },
    }));
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      const started = Promise.withResolvers<void>();
      const unsubscribe = app.registry.subscribe(() => {
        if (app.registry.details(id)?.output.includes("BASH_STARTED")) {
          started.resolve();
        }
      });

      // Await the actual SDK tool update, not a guessed process-start delay.
      const running = app.registry.prompt(id, "bash probe");

      await started.promise;
      unsubscribe();

      const pid = Number.parseInt(
        await readFile(join(app.main.path, ".bash-probe.pid"), "utf8"),
        10,
      );
      expect(process.kill(pid, 0)).toBe(true);

      const [stopped] = await Promise.all([app.registry[operation](id), running]);
      expectOk(stopped);

      // Abort propagation and tool completion include process cleanup before control resolves.
      expect(() => process.kill(pid, 0)).toThrow();
      expect(app.registry.closingCount).toBe(0);
      if (operation === "interrupt") {
        expect(app.registry.details(id)).not.toBeNull();
      }
    } finally {
      await app.cleanup();
    }
  },
);

test("SDK history defaults to the specified agentDir when sessionDir is omitted", async () => {
  // Default SDK session-directory selection must not escape into the user's global history.
  const app = await sdkFixture(false, (options) => {
    const scoped = { ...options };
    delete scoped.sessionDir;

    return scoped;
  });
  try {
    const id = expectOk(await app.registry.create(app.main.id));

    // The SDK chooses its own cwd-encoded directory under the explicit agent directory.
    await app.registry.prompt(id, "read");

    // No hand-written encoding or accidental global SessionManager default is used.
    expect(
      app.registry.sessionFile(id)?.startsWith(join(app.directory, "agent", "sessions") + "/"),
    ).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test("Final SDK provider failures return AgentRunError Results distinct from cancellation", async () => {
  // The SDK reports a terminal provider failure through its actual event contract, not a thrown bug.
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model) => {
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);

      message.stopReason = "error";
      message.errorMessage = "Provider rejected this test request";
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();

      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));

    // A settled failed run produces an explicit domain value instead of a generic rejection.
    const result = await app.registry.prompt(id, "fixture request");

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(app.registry.details(id)?.status).toBe("failure");
    expect(app.registry.details(id)?.error).toBe("Provider rejected this test request");
  } finally {
    await app.cleanup();
  }
});

test("Automatic compaction reports dedicated activity and returns to normal execution before completing once", async () => {
  // Trigger real SDK threshold compaction with a low limit and pause only the summary provider.
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = await sdkFixture(false, (options) => ({
    ...options,
    settings: { compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 199900 } },
    streamFn: async (model, context, request) => {
      const first = context.messages[0];
      const system =
        first?.role === "system"
          ? typeof first.content === "string"
            ? first.content
            : first.content.map((part) => part.text).join("")
          : "";
      if (system.startsWith("You are a context summarization assistant.")) {
        started.resolve();
        await release.promise;
      }

      return options.streamFn!(model, context, request);
    },
  }));
  let unsubscribe = () => {};
  const resumed: boolean[] = [];
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const pending = app.registry.prompt(id, "Preserve the implementation plan. ".repeat(500));

    await Promise.race([
      started.promise,
      pending.then((result) => {
        expectOk(result);
        throw new Error("SDK run ended without entering compaction.");
      }),
    ]);
    expect(app.registry.details(id)).toMatchObject({ status: "working", activity: "compacting" });
    unsubscribe = app.registry.subscribe(() => {
      const state = app.registry.details(id);
      resumed.push(state?.status === "working" && !("activity" in state));
    });

    // UI activity must end on compaction_end even if SDK isCompacting remains true.
    release.resolve();
    expectOk(await pending);

    expect(resumed).toContain(true);
    expect(app.registry.details(id)).not.toHaveProperty("activity");
    expect(app.registry.details(id)?.status).toBe("complete");
    expect(
      app.registry.details(id)?.sections?.filter((section) => section.completion),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    unsubscribe();
    await app.cleanup();
  }
});

test.each(["complete", "error"] as const)(
  "Manual compaction retains dedicated activity throughout its lifetime and clears after %s",
  async (outcome) => {
    // Pause only the real SDK summary stream to observe compaction deterministically.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let summarizing = false;
    const app = await sdkFixture(false, (options) => ({
      ...options,
      settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
      streamFn: async (model, context, request) => {
        if (!summarizing) {
          return options.streamFn!(model, context, request);
        }

        started.resolve();
        await release.promise;

        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);

        message.content = [{ type: "text", text: "Retain the fixture implementation plan" }];
        if (outcome === "complete") {
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        } else {
          message.stopReason = "error";
          message.errorMessage = "Offline compaction fixture";
          stream.push({ type: "error", reason: message.stopReason, error: message });
        }

        stream.end();

        return stream;
      },
    }));
    const observed: string[] = [];
    let unsubscribe = () => {};
    try {
      const id = expectOk(await app.registry.create(app.main.id));
      expectOk(await app.registry.prompt(id, "first request"));
      expectOk(await app.registry.prompt(id, "second request"));

      const before = app.registry.details(id)!;
      unsubscribe = app.registry.subscribe(() => {
        const state = app.registry.details(id);
        if (state?.status === "working") {
          observed.push("activity" in state ? String(state.activity) : "missing");
        }
      });
      summarizing = true;

      // Never revert to the previous request's Working on state before SDK completion.
      const pending = app.registry.compact(id);
      await Promise.race([
        started.promise,
        pending.then((result) => {
          expectOk(result);
          throw new Error("SDK compaction ended before the summary provider started.");
        }),
      ]);
      expect(app.registry.details(id)).toMatchObject({
        status: "working",
        activity: "compacting",
        conversationId: before.conversationId,
      });
      release.resolve();

      const result = await pending;

      if (outcome === "complete") {
        expectOk(result);
      } else {
        expect(expectError(result).code).toBe("AGENT_FAILED");
      }

      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((activity) => activity === "compacting")).toBe(true);
      expect(app.registry.details(id)).not.toHaveProperty("activity");
      expect(app.registry.details(id)?.status).toBe(before.status);
      expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([
        ...before.sections!,
      ]);
    } finally {
      release.resolve();
      unsubscribe();
      await app.cleanup();
    }
  },
);

test("Manual compaction saves real SDK summaries while preserving conversation, request ID, and tab", async () => {
  // A small retained tail makes this offline conversation eligible without a paid model call.
  const requests: string[] = [];
  const app = await sdkFixture(false, (options) => ({
    ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      requests.push(JSON.stringify(context.messages));

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "Keep the current implementation plan"));
    expectOk(await app.registry.prompt(id, "Continue the fixture work"));

    const before = app.registry.details(id)!;
    const file = app.registry.sessionFile(id)!;
    const calls = requests.length;
    let accepted = 0;
    const commands = expectOk(
      await app.registry.complete(id, { kind: "command", query: "" }),
    ).items;

    expect(commands.map((item) => item.value)).toEqual(expect.arrayContaining(["new", "compact"]));

    // Instructions go to SDK summarization, never into a new user/model turn.
    expectOk(await app.registry.compact(id, "Preserve the implementation plan", () => accepted++));

    expect(accepted).toBe(1);
    expect(requests.length).toBeGreaterThan(calls);
    expect(requests.slice(calls).join("\n")).toContain("Preserve the implementation plan");

    const after = app.registry.details(id)!;
    expect(after.conversationId).toBe(before.conversationId);
    expect(app.registry.sessionFile(id)).toBe(file);
    expect(after.sections?.slice(0, before.sections!.length)).toEqual([...before.sections!]);
    expect(after.sections?.at(-1)?.title).toBe("Context compacted");
    expect(after.status).toBe("complete");
    expect(
      SessionManager.open(file)
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([id]);
  } finally {
    await app.cleanup();
  }
});

test("Manual compaction rejects empty or undersized conversations without model calls", async () => {
  let calls = 0;
  const app = await sdkFixture(false, (options) => ({
    ...options,
    streamFn: (model, context, request) => {
      calls++;

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    let accepted = 0;

    expect(expectError(await app.registry.compact(id, undefined, () => accepted++)).code).toBe(
      "INVALID_INPUT",
    );
    expect(calls).toBe(0);
    expectOk(await app.registry.prompt(id, "tiny fixture"));

    const before = calls;

    expect(expectError(await app.registry.compact(id, undefined, () => accepted++)).code).toBe(
      "INVALID_INPUT",
    );

    expect(calls).toBe(before);
    expect(accepted).toBe(0);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally {
    await app.cleanup();
  }
});

test("Manual compaction during execution neither interrupts the model nor queues input", async () => {
  // Hold a real SDK response so refusal can be distinguished from abort-and-restart.
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold compact-busy");

    await app.streams.waitFor("compact-busy");

    expect(expectError(await app.registry.compact(id)).code).toBe("SESSION_BUSY");

    expect(app.streams.gates.get("compact-busy")!.aborted).toBe(false);
    app.streams.gates.get("compact-busy")!.finish("original result");
    expectOk(await run);
    expect(
      app.registry.details(id)?.sections?.some((section) => section.text === "original result"),
    ).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test("Compaction model failures preserve conversation and record accepted command errors inline", async () => {
  let failSummary = false;
  const app = await sdkFixture(false, (options) => ({
    ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      if (!failSummary) {
        return options.streamFn!(model, context, request);
      }

      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);

      message.stopReason = "error";
      message.errorMessage = "Offline summary rejected";
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();

      return stream;
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first"));
    expectOk(await app.registry.prompt(id, "second"));

    const before = app.registry.details(id)!;
    let accepted = 0;

    failSummary = true;

    const result = await app.registry.compact(id, undefined, () => accepted++);

    expect(expectError(result).code).toBe("AGENT_FAILED");
    expect(accepted).toBe(1);
    expect(app.registry.details(id)?.sections?.slice(0, before.sections!.length)).toEqual([
      ...before.sections!,
    ]);
    expect(app.registry.details(id)?.sections?.at(-1)).toMatchObject({
      title: "Compaction failed",
      status: "error",
    });
    expect(app.registry.details(id)?.sections?.at(-1)?.text).toContain("Offline summary rejected");
    expect(
      SessionManager.open(app.registry.sessionFile(id)!)
        .getBranch()
        .some((entry) => entry.type === "compaction"),
    ).toBe(false);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally {
    await app.cleanup();
  }
});

test("Compaction programming errors propagate unchanged instead of becoming input errors", async () => {
  let broken = false;
  const defect = new TypeError("Offline compaction defect", { cause: new Error("Original cause") });
  const app = await sdkFixture(false, (options) => ({
    ...options,
    settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 } },
    streamFn: (model, context, request) => {
      if (broken) {
        throw defect;
      }

      return options.streamFn!(model, context, request);
    },
  }));
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "first"));
    expectOk(await app.registry.prompt(id, "second"));
    broken = true;

    await expect(app.registry.compact(id)).rejects.toBe(defect);

    expect(app.registry.details(id)?.status).toBe("failure");
    expect(app.registry.details(id)?.error).toContain("Unexpected compaction failure");
  } finally {
    await app.cleanup();
  }
});

test("newTab opens a session without touching active SDK conversations, child work, or saved files", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "delegate");

    await app.streams.waitFor("child");

    const conversation = app.registry.details(id)!.conversationId;
    const file = app.registry.sessionFile(id)!;

    const added = expectOk(await app.registry.newTab(id));

    expect(added).not.toBe(id);
    expect(app.registry.details(id)?.conversationId).toBe(conversation);
    expect(app.registry.sessionFile(id)).toBe(file);
    expect(app.registry.sessionFile(added)).not.toBe(file);
    expect(app.registry.historyOwnership(file).openSessionId).toBe(id);
    expect(app.registry.details(added)?.sections).toEqual([]);
    expect(app.streams.gates.get("child")!.aborted).toBe(false);
    expect(app.registry.records.find((record) => record.id === id)?.subagents).toHaveLength(1);
    expect(app.registry.records.find((record) => record.id === added)?.subagents).toEqual([]);
    app.streams.gates.get("child")!.finish("original child completed normally");
    expectOk(await run);
    expect(app.registry.details(id)?.status).toBe("complete");
  } finally {
    await app.cleanup();
  }
});

test("clear interrupts and saves the current tab before replacing its conversation in place", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const other = expectOk(await app.registry.create(app.main.id));
    const first = app.registry.prompt(id, "hold previous-conversation");

    await app.streams.waitFor("previous-conversation");

    const second = app.registry.prompt(other, "hold other-tab");
    await app.streams.waitFor("other-tab");

    const conversation = app.registry.details(id)!.conversationId;
    const oldFile = app.registry.sessionFile(id)!;

    app.selection.selectSession(app.main.id, id);

    const accepted = Promise.withResolvers<void>();

    const replacement = app.registry.clearSession(id, () => accepted.resolve());

    await accepted.promise;
    await app.streams.gates.get("previous-conversation")!.abortReceived;
    expect(expectError(await app.registry.prompt(id, "during replacement")).code).toBe(
      "SESSION_BUSY",
    );
    app.streams.gates.get("previous-conversation")!.finish("persisted cancellation");
    expect(expectError(await first).code).toBe("CANCELLED");
    expectOk(await replacement);

    expect(app.selection.sessionId).toBe(id);
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual([id, other]);
    expect(app.registry.details(id)?.conversationId).not.toBe(conversation);
    expect(app.registry.details(id)?.sections).toEqual([]);
    expect(app.registry.sessionFile(id)).not.toBe(oldFile);
    expect(app.registry.historyOwnership(oldFile)).toEqual({
      openSessionId: null,
      unavailableReason: null,
    });
    expect(
      SessionManager.open(oldFile)
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "aborted",
        ),
    ).toBe(true);
    expect(app.streams.gates.get("other-tab")!.aborted).toBe(false);
    app.streams.gates.get("other-tab")!.finish("unrelated tab result");
    expectOk(await second);
    expectOk(await app.registry.prompt(id, "fresh conversation"));
    expect(
      app.registry
        .details(id)
        ?.sections?.some((section) => section.text === "hold previous-conversation"),
    ).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test("clear cleans up owned child work and saves cancellation in the original conversation", async () => {
  const app = await sdkFixture(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "delegate");

    await app.streams.waitFor("child");

    const accepted = Promise.withResolvers<void>();

    const replacement = app.registry.clearSession(id, () => accepted.resolve());

    await accepted.promise;
    await app.streams.gates.get("child")!.abortReceived;
    app.streams.gates.get("child")!.finish("cancelled owned child");
    await run;
    expectOk(await replacement);

    expect(app.registry.records[0]?.subagents).toEqual([]);
    expect(app.registry.details(id)?.sections).toEqual([]);
    expect(app.executors).toHaveLength(3);
  } finally {
    await app.cleanup();
  }
});

test("clear respects extension vetoes without interrupting the active model", async () => {
  const app = await sdkFixture(true);
  try {
    const extensions = join(app.directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "cancel-new.ts"),
      `export default (pi) => {
      pi.on("session_before_switch", (event) => event.reason === "new" ? { cancel: true } : undefined);
    };`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    const run = app.registry.prompt(id, "hold cancelled-new");

    await app.streams.waitFor("cancelled-new");

    const conversation = app.registry.details(id)!.conversationId;
    let accepted = false;

    const result = await app.registry.clearSession(id, () => {
      accepted = true;
    });

    expect(expectError(result).code).toBe("CANCELLED");
    expect(accepted).toBe(false);
    expect(app.registry.details(id)?.conversationId).toBe(conversation);
    expect(app.executors).toHaveLength(1);
    expect(app.streams.gates.get("cancelled-new")!.aborted).toBe(false);
    app.streams.gates.get("cancelled-new")!.finish("continued original");
    expectOk(await run);
  } finally {
    await app.cleanup();
  }
});

test("clear SDK lifecycle hooks receive replacement reasons instead of startup or quit", async () => {
  const app = await sdkFixture();
  try {
    const extensions = join(app.directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "lifecycle.ts"),
      `export default (pi) => {
      pi.on("session_start", (event) => { pi.appendEntry("start-reason", event); });
      pi.on("session_shutdown", (event) => { pi.appendEntry("shutdown-reason", event); });
    };`,
    );

    const id = expectOk(await app.registry.create(app.main.id));
    expectOk(await app.registry.prompt(id, "original work"));

    const oldFile = app.registry.sessionFile(id)!;

    expectOk(await app.registry.clearSession(id));

    const oldEntries = SessionManager.open(oldFile).getBranch();
    // Pi buffers an empty conversation's metadata until its first actual turn.
    expectOk(await app.registry.prompt(id, "first fresh conversation turn"));

    const newEntries = SessionManager.open(app.registry.sessionFile(id)!).getBranch();
    expect(
      oldEntries
        .filter((entry) => entry.type === "custom" && entry.customType === "shutdown-reason")
        .map((entry) => (entry.type === "custom" ? entry.data : null)),
    ).toEqual([{ type: "session_shutdown", reason: "new" }]);
    expect(
      newEntries
        .filter((entry) => entry.type === "custom" && entry.customType === "start-reason")
        .map((entry) => (entry.type === "custom" ? entry.data : null)),
    ).toEqual([{ type: "session_start", reason: "new", previousSessionFile: oldFile }]);
  } finally {
    await app.cleanup();
  }
});
