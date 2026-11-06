import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getSystemMessageText } from "@earendil-works/pi-ai";
import { expectOk } from "../testing/results.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { ok } from "../result.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { SessionRegistry, type SessionExecutor, type SessionContext } from "./session-registry.ts";
import { Value } from "typebox/value";
import { ownedSubagentRecordSchema } from "./subagent-record.ts";
import type { SubagentCommand } from "./subagent-tools.ts";
import { builtinAgents, getBuiltinAgent } from "./builtin-agents.ts";
import { profileHash, resolveEffectiveProfile, type AgentOverlay } from "./effective-profile.ts";

function scriptedCall(
  model: Parameters<NonNullable<import("./pi-session-adapter.ts").PiSessionOptions["streamFn"]>>[0],
  command: SubagentCommand,
) {
  const stream = createAssistantMessageEventStream();
  const message = fixtureMessage(model.api, model.provider, model.id);
  message.content = [
    { type: "toolCall", id: crypto.randomUUID(), name: "radian-subagent", arguments: command },
  ];
  message.stopReason = "toolUse";
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
}

test("SDK QA status and saved records report host enforcement without claiming verification sandboxing", async () => {
  const files = await createWorktreeFixture();
  const offline = await offlineRuntime(join(files.directory, "agent"));
  const factory = piSessionFactory({ ...offline, defaultPackagePaths: [] });
  let rootContext: SessionContext | undefined;
  const registry = new SessionRegistry([files.repository], async (context) => {
    if (context.role === "main") rootContext = context;
    return factory(context);
  });
  try {
    expectOk(await registry.create(files.repository.worktrees[0]!.id));
    const profile = expectOk(
      resolveEffectiveProfile("qa", { overlays: [], projectTrusted: false }),
    );

    const spawned = expectOk(
      await rootContext!.coordinateSubagents!(
        { action: "spawn", agent: "qa", task: "Verify fixture", async: false },
        undefined,
        undefined,
        profile,
      ),
    );
    const statuses = expectOk(await rootContext!.coordinateSubagents!({ action: "status" }));
    const expected = {
      toolPolicy: "host-enforced",
      deniedProductEdit: true,
      reachableUnsandboxed: ["bash", "mcp__*"],
      verificationTrust: "host-trusted",
      sandboxed: false,
    } satisfies NonNullable<SessionExecutor["enforcement"]>;

    expect(spawned).toMatchObject({ enforcement: expected });
    expect(statuses).toEqual([expect.objectContaining({ enforcement: expected })]);
    const saved = registry.records[0]!.ownedSubagents![0]!;
    expect(saved.enforcement).toEqual(expected);
    expect(Value.Check(ownedSubagentRecordSchema, saved)).toBe(true);
  } finally {
    expectOk(await registry.shutdown());
    await files.cleanup();
  }
});

test("A running SDK child and persisted run record retain the launch snapshot after overlay and skill edits", async () => {
  const files = await createWorktreeFixture();
  const directory = join(files.directory, "agent");
  const offline = await offlineRuntime(directory);
  const overlayPath = join(directory, "agents", "engineer.md");
  const skillDirectory = join(directory, "skills", "fixture-evidence");
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: fixture-evidence\ndescription: Fixture evidence\n---\nOriginal skill instructions.\n",
  );
  await writeFile(
    overlayPath,
    "---\nmodel: radian-offline/fixture\nskills: [fixture-evidence]\ntools: []\n---\nOriginal additive instructions.\n",
  );
  const prompts: string[] = [];
  const requested = Promise.withResolvers<void>();
  let releaseHeld: (() => void) | undefined;
  let active: ReturnType<SessionExecutor["prompt"]> | undefined;
  let next: SubagentCommand | undefined;
  const executors: SessionExecutor[] = [];
  const factory = piSessionFactory({
    ...offline,
    defaultPackagePaths: [],
    streamFn(model, context, request) {
      prompts.push(
        context.messages
          .filter((message) => message.role === "system")
          .map(getSystemMessageText)
          .join("\n"),
      );
      const input = context.messages.findLast((message) => message.role === "user");
      let inputText = "";
      if (input?.role === "user") {
        inputText =
          typeof input.content === "string"
            ? input.content
            : input.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
      }
      if (inputText === "hold-active") {
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "text", text: "Held response completed." }];
        stream.push({ type: "start", partial: message });
        let finished = false;
        releaseHeld = () => {
          if (finished) return;
          finished = true;
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        };
        requested.resolve();
        return stream;
      }
      if (next) {
        const command = next;
        next = undefined;
        return scriptedCall(model, command);
      }
      return offline.streamFn!(model, context, request);
    },
  });
  const registry = new SessionRegistry([files.repository], async (context) => {
    const executor = await factory(context);
    executors.push(executor);
    return executor;
  });
  let direct: SessionExecutor | undefined;
  try {
    direct = await factory({
      cwd: files.main,
      role: "subagent",
      agent: "engineer",
      spawnSubagent: async () => ok(""),
    });
    active = direct.prompt("hold-active");
    await requested.promise;
    const id = expectOk(await registry.create(files.repository.worktrees[0]!.id));
    next = { action: "spawn", agent: "engineer", task: "Inspect only", async: false };
    expectOk(await registry.prompt(id, "Spawn the engineer"));
    const child = direct;
    const snapshot = child.effectiveProfile!;
    const recordsBefore = registry.records;

    // Editing either input must affect only the next admission, not existing prompts or metadata.
    await writeFile(
      overlayPath,
      "---\nmodel: radian-offline/fixture\ntools: [read]\n---\nReplacement additive instructions.\n",
    );
    await writeFile(
      skillPath,
      "---\nname: fixture-evidence\ndescription: Fixture evidence\n---\nReplacement skill instructions.\n",
    );
    expect(child.busy).toBe(true);
    expect(child.effectiveProfile).toBe(snapshot);
    releaseHeld!();
    expectOk(await active);
    expectOk(await child.reload!());
    expectOk(await child.prompt("Inspect again"));

    expect(child.effectiveProfile).toBe(snapshot);
    expect(snapshot.model).toBe("radian-offline/fixture");
    expect(snapshot.toolCeiling).toEqual([]);
    expect(snapshot.purpose).toBe("execution");
    expect(snapshot.skills[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(prompts.at(-1)).toContain(getBuiltinAgent("engineer")!.prompt);
    expect(prompts.at(-1)).toContain("Original additive instructions.");
    expect(prompts.at(-1)).toContain("Original skill instructions.");
    expect(prompts.at(-1)).not.toContain("Replacement additive instructions.");
    expect(prompts.at(-1)).not.toContain("Replacement skill instructions.");
    expect(JSON.stringify(recordsBefore)).toContain(snapshot.overlays[0]!.hash);
    expect(JSON.stringify(registry.records)).toContain(snapshot.overlays[0]!.hash);
    const entries = (await readFile(child.sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.find((entry) => entry.customType === "radian.effective-profile")?.data).toEqual(
      snapshot,
    );

    next = { action: "spawn", agent: "engineer", task: "Inspect only", async: false };
    expectOk(await registry.prompt(id, "Spawn the updated engineer"));
    expect(executors[2]!.effectiveProfile?.toolCeiling).toEqual(["read"]);
    expect(executors[2]!.effectiveProfile?.overlays[0]?.hash).not.toBe(snapshot.overlays[0]?.hash);
    expect(prompts.some((prompt) => prompt.includes("Replacement additive instructions."))).toBe(
      true,
    );
  } finally {
    releaseHeld?.();
    if (active) await active;
    expectOk(await registry.shutdown());
    if (direct) expectOk(await direct.close());
    await files.cleanup();
  }
});

test("SDK inspection reports role-local diagnostics without prompt bodies and refuses a widened role before coordination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-overlay-inspection-"));
  const offline = await offlineRuntime(directory);
  await writeFile(
    join(directory, "agents", "qa.md"),
    "---\ntools: ['*']\n---\nPrivate overlay instructions.\n",
  );
  await writeFile(
    join(directory, "agents", "engineer.md"),
    "---\nmodel: missing/model\n---\nPrivate engineer instructions.\n",
  );
  let next: SubagentCommand | undefined;
  const results: string[] = [];
  let coordinated = 0;
  const factory = piSessionFactory({
    ...offline,
    defaultPackagePaths: [],
    streamFn(model, context, request) {
      const last = context.messages.findLast((message) => message.role === "toolResult");
      if (last?.role === "toolResult")
        results.push(
          last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      if (next) {
        const command = next;
        next = undefined;
        return scriptedCall(model, command);
      }
      return offline.streamFn!(model, context, request);
    },
  });
  let root: SessionExecutor | undefined;
  try {
    root = await factory({
      cwd: directory,
      role: "main",
      spawnSubagent: async () => ok(""),
      coordinateSubagents: async () => {
        coordinated++;
        return ok({ id: "unexpected" });
      },
    });
    next = { action: "list" };
    expectOk(await root.prompt("List agents"));
    next = { action: "spawn", agent: "qa", task: "Verify" };
    expectOk(await root.prompt("Try QA"));

    const list = JSON.parse(results[0]!);
    expect(list.find((entry: { name: string }) => entry.name === "qa").diagnostics[0].code).toBe(
      "AGENT_OVERLAY_WIDENS",
    );
    expect(
      list.find((entry: { name: string }) => entry.name === "engineer").diagnostics[0].code,
    ).toBe("AGENT_MODEL_UNAVAILABLE");
    expect(
      list.find((entry: { name: string }) => entry.name === "pm").effectiveProfile
        .descriptorVersion,
    ).toBe(1);
    expect(results[0]).not.toContain("Private overlay instructions.");
    expect(results[0]).not.toContain("Private engineer instructions.");
    expect(results[1]).toContain("AGENT_OVERLAY_WIDENS");
    expect(coordinated).toBe(0);
  } finally {
    if (root) expectOk(await root.close());
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["personal", "qa", "name: engineer\ntools: [read]\n", ["qa", "engineer"], "AGENT_NAME_COLLISION"],
  ["personal", "custom", "name: engineer\ntools: [read]\n", ["engineer"], "AGENT_NAME_COLLISION"],
  ...builtinAgents.flatMap(({ descriptor }) =>
    (["personal", "project"] as const).flatMap((source) =>
      ["tools: [\n", "tools: invalid\n", "unknown: true\n"].map(
        (fields) =>
          [
            source,
            `radian:${descriptor.id}`,
            fields,
            [descriptor.id],
            "AGENT_OVERLAY_FIELD",
          ] as const,
      ),
    ),
  ),
] as const)(
  "SDK admission blocks %s file %s with fields %s before coordination or child transport",
  async (source, stem, fields, roles, code) => {
    const directory = await mkdtemp(join(tmpdir(), "radian-overlay-identity-sdk-"));
    const offline = await offlineRuntime(directory);
    // In-memory SDK settings trust this isolated project, so both discovery sources are exercised.
    const overlayDirectory =
      source === "personal" ? join(directory, "agents") : join(directory, ".pi", "agents");
    await mkdir(overlayDirectory, { recursive: true });
    const overlayPath = join(overlayDirectory, `${stem}.md`);
    await writeFile(overlayPath, `---\n${fields}---\nPrivate invalid instructions.\n`);
    let next: SubagentCommand | undefined;
    const results: string[] = [];
    const errors: boolean[] = [];
    let coordinated = 0;
    let transportCalls = 0;
    const factory = piSessionFactory({
      ...offline,
      defaultPackagePaths: [],
      streamFn(model, context, request) {
        transportCalls++;
        const last = context.messages.findLast((message) => message.role === "toolResult");
        if (last?.role === "toolResult") {
          results.push(
            last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
          errors.push(last.isError);
        }
        if (next) {
          const command = next;
          next = undefined;
          return scriptedCall(model, command);
        }
        return offline.streamFn!(model, context, request);
      },
    });
    let root: SessionExecutor | undefined;
    try {
      root = await factory({
        cwd: directory,
        role: "main",
        spawnSubagent: async () => ok(""),
        coordinateSubagents: async () => {
          coordinated++;
          return ok({ id: "unexpected" });
        },
      });
      next = { action: "list" };
      expectOk(await root.prompt("Inspect configuration"));
      const list = JSON.parse(results[0]!) as {
        name: string;
        diagnostics?: { code: string; path: string }[];
      }[];

      expect(list).toHaveLength(builtinAgents.length + 1); // The fixture also defines custom probe.
      expect(results[0]).not.toContain("Private invalid instructions.");
      for (const other of list.filter(({ name }) => !roles.some((role) => role === name)))
        expect(other.diagnostics).toBeUndefined();

      // Both public spellings must reject before any child can reach the fake transport.
      for (const role of roles) {
        expect(list.find(({ name }) => name === role)?.diagnostics?.[0]).toMatchObject({
          code,
          path: overlayPath,
        });
        expect(list.some(({ name }) => name === `radian:${role}`)).toBe(false);
        for (const agent of [role, `radian:${role}`]) {
          next = { action: "spawn", agent, task: "Verify only" };
          expectOk(await root.prompt("Try blocked role"));
          expect(errors.at(-1)).toBe(true);
          expect(results.at(-1)).toContain(overlayPath);
          const before = transportCalls;
          let child: SessionExecutor | undefined;
          try {
            await expect(
              factory({
                cwd: directory,
                role: "subagent",
                agent,
                spawnSubagent: async () => ok(""),
              }).then((executor) => {
                child = executor;
                return executor;
              }),
            ).rejects.toMatchObject({ code });
            expect(transportCalls).toBe(before);
          } finally {
            if (child) expectOk(await child.close());
          }
        }
      }
      expect(coordinated).toBe(0);
    } finally {
      if (root) expectOk(await root.close());
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("SDK canonical and alias child names accept an equivalent alias overlay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-overlay-valid-alias-sdk-"));
  const offline = await offlineRuntime(directory);
  const path = join(directory, "agents", "radian:qa.md");
  await writeFile(path, "---\nname: radian:qa\ntools: []\n---\nAccepted alias instructions.\n");
  const factory = piSessionFactory({ ...offline, defaultPackagePaths: [] });
  try {
    for (const agent of ["qa", "radian:qa"]) {
      const child = await factory({
        cwd: directory,
        role: "subagent",
        agent,
        spawnSubagent: async () => ok(""),
      });
      try {
        expectOk(await child.prompt("Inspect only"));
        expect(child.effectiveProfile?.id).toBe("qa");
        expect(child.effectiveProfile?.overlays[0]?.path).toBe(path);
        expect(child.effectiveProfile?.toolCeiling).toEqual([]);
      } finally {
        expectOk(await child.close());
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SDK flag off uses the existing Pi extension settings and returns only legacy file profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-overlay-flag-"));
  const offline = await offlineRuntime(directory);
  let next: SubagentCommand | undefined = { action: "list" };
  let listed: unknown;
  const factory = piSessionFactory({
    ...offline,
    settings: { radian: { builtInAgents: "off" } } as NonNullable<
      import("./pi-session-adapter.ts").PiSessionOptions["settings"]
    >,
    streamFn(model, context, request) {
      const last = context.messages.findLast((message) => message.role === "toolResult");
      if (last?.role === "toolResult")
        listed = JSON.parse(
          last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
      if (next) {
        const command = next;
        next = undefined;
        return scriptedCall(model, command);
      }
      return offline.streamFn!(model, context, request);
    },
  });
  let root: SessionExecutor | undefined;
  try {
    root = await factory({ cwd: directory, role: "main", spawnSubagent: async () => ok("") });
    expectOk(await root.prompt("List legacy agents"));

    expect(listed).toEqual([
      {
        name: "probe",
        description: "Offline worktree probe",
        skills: [],
        tools: ["read", "bash", "edit", "write"],
        path: join(directory, "agents", "probe.md"),
      },
    ]);
  } finally {
    if (root) expectOk(await root.close());
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["personal", "project", "run"] as const)(
  "A %s built-in overlay cannot bypass subscription routing or trigger fallback",
  async (source) => {
    // The fixture registers a native API model but never installs a live provider transport.
    const directory = await mkdtemp(join(tmpdir(), "radian-overlay-subscription-"));
    const offline = await offlineRuntime(directory);
    offline.modelRuntime!.registerProvider("anthropic", {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "fixture",
      models: [
        {
          id: "overlay-blocked",
          name: "Blocked overlay",
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const choice: AgentOverlay = {
      path: `${source}:engineer`,
      source,
      fields: { model: "anthropic/overlay-blocked" },
      body: "Inspect only.",
      hash: profileHash(source),
    };
    const profile = expectOk(
      resolveEffectiveProfile(
        "engineer",
        { overlays: source === "run" ? [] : [choice], projectTrusted: true },
        source === "run" ? choice : undefined,
      ),
    );
    let transportCalls = 0;
    const factory = piSessionFactory({
      ...offline,
      subscriptionsOnly: true,
      streamFn(...args) {
        transportCalls++;
        return offline.streamFn!(...args);
      },
    });
    let child: SessionExecutor | undefined;
    try {
      const creation = factory({
        cwd: directory,
        role: "subagent",
        agent: "engineer",
        profile,
        spawnSubagent: async () => ok(""),
      }).then((executor) => {
        child = executor;
        return executor;
      });

      await expect(creation).rejects.toMatchObject({ code: "SUBSCRIPTION_ROUTE_BLOCKED" });
      expect(transportCalls).toBe(0);
    } finally {
      if (child) expectOk(await child.close());
      await rm(directory, { recursive: true, force: true });
    }
  },
);
