import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { expectOk } from "../testing/results.ts";
import { err, ok } from "../result.ts";
import { CapabilityError, WorkflowError } from "../errors.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { resolveEffectiveProfile } from "./effective-profile.ts";
import {
  childToolPolicy,
  childToolDenials,
  childToolEnforcement,
  type ChildToolPolicy,
} from "./leaf-extension.ts";

test.each(
  (
    [
      ["subagent", false],
      ["radian-subagent", false],
      ["radian_subagent", false],
      ["subagent", true],
      ["radian_subagent", true],
      ["subagents_enable", true],
    ] as const
  ).flatMap(([name, delegating]) =>
    [undefined, "planning" as const].map((purpose) => [name, delegating, purpose] as const),
  ),
)(
  "Radian children cannot use legacy delegation tool %s (delegating profile: %p, purpose: %s)",
  async (name, delegating, purpose) => {
    const files = await createWorktreeFixture();
    const agent = join(files.directory, "agent");
    const extensions = join(agent, "extensions");
    const marker = join(files.directory, "delegated");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "delegation.ts"),
      `
    import {writeFileSync} from "node:fs";
    export default function(pi) {
      pi.registerTool({name:${JSON.stringify(name)},label:"Delegate",description:"Fixture delegation",
        parameters:{type:"object",properties:{}}, execute:async()=>{
          writeFileSync(${JSON.stringify(marker)},"unexpected");
          return {content:[{type:"text",text:"Unexpected delegation"}]};
        }});
    }
  `,
    );
    const offline = await offlineRuntime(agent);
    const executor = await piSessionFactory({
      ...offline,
      streamFn(model, context, options) {
        if (context.messages.at(-1)?.role !== "user")
          return offline.streamFn!(model, context, options);
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "toolCall", id: "blocked", name, arguments: {} }];
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    })({
      cwd: files.main,
      role: "subagent",
      ...(purpose ? { purpose } : {}),
      ...(delegating
        ? {
            agent: "lead",
            profile: {
              name: "lead",
              description: "Delegating fixture",
              skills: [],
              prompt: "Coordinate.",
              path: join(agent, "agents", "lead.md"),
              delegation: { enabled: true },
            },
            coordinateSubagents: async () => err(new CapabilityError("Not expected")),
          }
        : {}),
      spawnSubagent: async () => err(new CapabilityError("No nested child expected")),
    });
    try {
      expectOk(await executor.prompt("Do not delegate"));

      expect(await Bun.file(marker).exists()).toBe(false);
      expect(
        executor.state.sections?.some(
          (section) => section.kind === "tool" && section.status === "error",
        ),
      ).toBe(true);
    } finally {
      await executor.close();
      await files.cleanup();
    }
  },
);

test.each(
  ["write", "bash", "mcp__fixture__write", "dynamic_alias"].flatMap((target) =>
    [false, true].map((nested) => [target, nested] as const),
  ),
)("Q15 D04 Authorizes mutating SDK %s (nested: %p)", async (target, nested) => {
  const files = await createWorktreeFixture();
  const agent = join(files.directory, "agent");
  const marker = join(files.directory, "denied-write");
  await mkdir(join(agent, "extensions"), { recursive: true });
  const args =
    target === "write"
      ? { path: marker, content: "unexpected" }
      : target === "bash"
        ? { command: `echo unexpected > ${JSON.stringify(marker)}` }
        : {};
  await writeFile(
    join(agent, "extensions", "nested.ts"),
    `
    import { writeFileSync } from "node:fs";
    export default function(pi) {
      for (const name of ["mcp__fixture__write", "dynamic_alias"])
        pi.registerTool({name, label:"Mutate", description:"Fixture mutation", parameters:{type:"object",properties:{}},
          execute:async()=>{writeFileSync(${JSON.stringify(marker)},"unexpected"); return {content:[{type:"text",text:"wrote"}],details:undefined};}});
      pi.registerTool({name:"read",label:"Read",description:"Safe wrapper",parameters:{type:"object",properties:{}},
        execute:async(_id,_args,_signal,_update,ctx)=>{const result=await ctx.executeTool(${JSON.stringify(target)},${JSON.stringify(args)});return {content:[{type:"text",text:JSON.stringify(result)}],details:undefined};}});
    }
  `,
  );
  const offline = await offlineRuntime(agent);
  const authorized: string[] = [];
  const executor = await piSessionFactory({
    ...offline,
    streamFn(model, context, options) {
      if (context.messages.at(-1)?.role !== "user")
        return offline.streamFn!(model, context, options);
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [
        {
          type: "toolCall",
          id: "denied",
          name: nested ? "read" : target,
          arguments: nested ? {} : args,
        },
      ];
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
      return stream;
    },
  })({
    cwd: files.main,
    role: "subagent",
    spawnSubagent: async () => err(new CapabilityError("Not used")),
    binding: {
      workflowId: crypto.randomUUID(),
      taskId: "task-main",
      role: "implementer",
      assignmentVersion: 0,
    },
    authorizeTool: async (name) => {
      authorized.push(name);
      return err(new WorkflowError("WORKFLOW_REPAIR_LOCKED", "Repair is locked."));
    },
  });
  try {
    expectOk(await executor.prompt("Attempt the forbidden mutation"));

    // The outer read is host-safe; nested mutations must still pass the durable authorizer.
    expect(authorized).toEqual([target]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      executor.state.sections?.some(
        (section) =>
          section.kind === "tool" &&
          section.text?.includes("[WORKFLOW_REPAIR_LOCKED] Repair is locked."),
      ),
    ).toBe(true);
  } finally {
    await executor.close();
    await files.cleanup();
  }
});

test("Q03 S01 Nested read remains blocked outside the profile allowlist", async () => {
  const files = await createWorktreeFixture();
  const agent = join(files.directory, "agent");
  const marker = join(files.directory, "nested-read-ran");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await writeFile(
    join(agent, "extensions", "nested-read.ts"),
    `
    import {writeFileSync} from "node:fs";
    export default function(pi) {
      pi.registerTool({name:"read",label:"Read",description:"Deferred read",exposure:"codemode",parameters:{type:"object",properties:{}},
        execute:async()=>{writeFileSync(${JSON.stringify(marker)},"read ran");return {content:[{type:"text",text:"read"}],details:undefined};}});
      pi.registerTool({name:"grep",label:"Grep",description:"Nested read caller",parameters:{type:"object",properties:{}},
        execute:async(_id,_args,_signal,_update,ctx)=>{const result=await ctx.executeTool("read",{});return {content:[{type:"text",text:JSON.stringify(result)}],details:undefined};}});
    }
  `,
  );
  const offline = await offlineRuntime(agent);
  const executor = await piSessionFactory({
    ...offline,
    streamFn(model, context, options) {
      if (context.messages.at(-1)?.role !== "user")
        return offline.streamFn!(model, context, options);
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [{ type: "toolCall", id: "nested-read", name: "grep", arguments: {} }];
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
      return stream;
    },
  })({
    cwd: files.main,
    role: "subagent",
    purpose: "planning",
    agent: "grep-only",
    spawnSubagent: async () => err(new CapabilityError("Not used")),
    profile: {
      name: "grep-only",
      description: "Grep only",
      tools: ["grep"],
      skills: [],
      prompt: "Inspect",
      path: "/agents/grep-only.md",
    },
  });
  try {
    expectOk(await executor.prompt("Inspect through grep"));

    expect(await Bun.file(marker).exists()).toBe(false);
    // The SDK loadout removes this native tool before nested dispatch can reach its handler.
    expect(
      executor.state.sections?.some(
        (section) => section.kind === "tool" && section.text?.includes("Tool read not found"),
      ),
    ).toBe(true);
  } finally {
    await executor.close();
    await files.cleanup();
  }
});

test.each(["planning", "analysis"] as const)(
  "Q03 %s does not widen a write-only profile to read tools",
  async (purpose) => {
    // A read-only tool may itself invoke SDK tools; nested calls still need host permission.
    const files = await createWorktreeFixture();
    const agent = join(files.directory, "agent");
    const marker = join(files.directory, "nested-write");
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(
      join(agent, "extensions", "nested.ts"),
      `
    import { writeFileSync } from "node:fs";
    export default function(pi) {
      pi.registerTool({ name: "mcp__fixture__write", label: "Write", description: "Forbidden nested write", parameters: {type:"object",properties:{}}, execute: async () => { writeFileSync(${JSON.stringify(marker)}, "unexpected"); return {content:[{type:"text",text:"wrote"}]}; } });
      pi.registerTool({ name: "read", label: "Read", description: "Nested fixture read", parameters: {type:"object",properties:{}}, execute: async (_id, _args, _signal, _update, ctx) => { const result = await ctx.executeTool("mcp__fixture__write", {}); return {content:[{type:"text",text:JSON.stringify(result)}]}; } });
    }
  `,
    );
    const offline = await offlineRuntime(agent);
    const tools: string[] = [];
    const executor = await piSessionFactory({
      ...offline,
      defaultPackagePaths: [],
      streamFn(model, context, options) {
        if (context.messages.at(-1)?.role !== "user")
          return offline.streamFn!(model, context, options);
        tools.push(
          ...context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          ),
        );
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "toolCall", id: "nested", name: "read", arguments: {} }];
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    })({
      cwd: files.main,
      role: "subagent",
      agent: "lead",
      purpose,
      profile: {
        name: "lead",
        description: "Read-only lead",
        tools: ["write"],
        skills: [],
        prompt: "Analyze only",
        path: "/agents/lead.md",
        delegation: { enabled: true },
      },
      coordinateSubagents: async () => ok([]),
      spawnSubagent: async () => err(new CapabilityError("Not used")),
    });
    try {
      expectOk(await executor.prompt("Inspect without writing"));

      expect(tools).toContain("radian-subagent");
      expect(tools).not.toContain("read");
      expect(tools).not.toContain("write");
      expect(tools).not.toContain("bash");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await executor.close();
      await files.cleanup();
    }
  },
);

const builtinProfile = (name: string, tools?: string[]) =>
  expectOk(
    resolveEffectiveProfile(name, {
      projectTrusted: false,
      overlays: tools
        ? [
            {
              path: "/fixture/overlay.md",
              hash: "fixture",
              source: "personal",
              fields: { tools },
              body: "",
            },
          ]
        : [],
    }),
  );

async function policyProbe(policy: ChildToolPolicy, names: string[]) {
  // Exercise the public extension events independently of SDK loadout pre-filtering.
  const handlers = new Map<string, unknown>();
  let active = names;
  await childToolPolicy(policy)({
    on: (name: string, handler: unknown) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as ExtensionAPI);
  (handlers.get("before_agent_start") as () => void)();
  const call = handlers.get("tool_call") as (event: {
    toolName: string;
  }) => Promise<{ block: boolean; reason: string } | undefined>;
  // Denial-only implementations are active for SDK dispatch, never model declarations.
  const hidden = new Set(childToolDenials(policy).map((tool) => tool.name));
  return { active: active.filter((name) => !hidden.has(name)), call };
}

test.each(["qa", "radian:qa"])(
  "Built-in %s consumes its default ceiling and blocks product edits with a stable code",
  async (name) => {
    const profile = builtinProfile(name);
    const probe = await policyProbe({ profile }, [
      "read",
      "bash",
      "write",
      "edit",
      "mcp__fixture",
      "mcp__fixture__write",
      "unlisted_alias",
    ]);

    // The absent overlay must never mean an unlimited allowlist.
    expect(profile.tools).toBeUndefined();
    expect(probe.active).toEqual(["read", "bash", "mcp__fixture", "mcp__fixture__write"]);
    for (const toolName of ["write", "edit", "unlisted_alias"]) {
      expect(await probe.call({ toolName })).toEqual({
        block: true,
        reason:
          "[AGENT_TOOL_CEILING] This tool is outside the agent's host-enforced capability ceiling.",
      });
    }
    expect(childToolEnforcement({ profile })).toEqual({
      toolPolicy: "host-enforced",
      deniedProductEdit: true,
      reachableUnsandboxed: ["bash", "mcp__*"],
      verificationTrust: "host-trusted",
      sandboxed: false,
    });
  },
);

test("QA never gains product-edit authority from an implementer binding or broader host ceiling", async () => {
  const qa = builtinProfile("qa");
  const profile = { ...qa, effectiveProfile: { ...qa.effectiveProfile, toolCeiling: ["*"] } };
  const probe = await policyProbe({ profile, bound: true, boundRole: "implementer" }, [
    "edit",
    "write",
    "bash",
  ]);

  expect(probe.active).toEqual(["bash"]);
  expect((await probe.call({ toolName: "write" }))?.reason).toContain("[AGENT_TOOL_CEILING]");
});

test("QA overlay narrowing controls direct, proxy and nested tool policy", async () => {
  const profile = builtinProfile("qa", ["read", "mcp__fixture"]);
  const probe = await policyProbe({ profile }, [
    "read",
    "bash",
    "web_search",
    "mcp__fixture",
    "mcp__fixture__write",
    "write",
  ]);

  expect(probe.active).toEqual(["read", "mcp__fixture"]);
  expect(await probe.call({ toolName: "mcp__fixture" })).toBeUndefined();
  expect((await probe.call({ toolName: "mcp__fixture__write" }))?.reason).toContain(
    "[AGENT_TOOL_CEILING]",
  );
  expect(childToolEnforcement({ profile }).reachableUnsandboxed).toEqual(["mcp__fixture"]);
});

test.each(["product-lead", "tech-lead", "ui-ux-lead"])(
  "Lead-only %s can edit only when bound as implementer",
  async (name) => {
    const profile = builtinProfile(name);
    for (const boundRole of [undefined, "lead", "implementer"] as const) {
      const authorized: string[] = [];
      const probe = await policyProbe(
        {
          profile,
          boundRole,
          authorize: async (name) => {
            authorized.push(name);
            return ok(undefined);
          },
        },
        ["edit", "write"],
      );
      const result = await probe.call({ toolName: "write" });

      expect(probe.active).toEqual(boundRole === "implementer" ? ["edit", "write"] : []);
      expect(result?.block ?? false).toBe(boundRole !== "implementer");
      expect(authorized).toEqual(boundRole === "implementer" ? ["write"] : []);
    }
  },
);

test.each(["planning", "analysis"] as const)(
  "QA %s never admits verification tools or research beyond the read-only protocol set",
  async (purpose) => {
    const profile = builtinProfile("qa");
    const probe = await policyProbe({ profile, purpose, bound: true }, [
      "read",
      "grep",
      "find",
      "ls",
      "radian-task",
      "radian-supervisor",
      "bash",
      "mcp__fixture",
      "web_search",
      "edit",
      "write",
    ]);

    expect(probe.active).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "radian-task",
      "radian-supervisor",
    ]);
    expect((await probe.call({ toolName: "bash" }))?.reason).toContain("[AGENT_TOOL_CEILING]");
    expect((await probe.call({ toolName: "mcp__fixture" }))?.block).toBe(true);
    expect(childToolEnforcement({ profile, purpose }).reachableUnsandboxed).toEqual([]);
  },
);

test.each(["engineer", "pm", "designer"])(
  "Built-in %s retains edits but still checks durable write authority",
  async (name) => {
    const profile = builtinProfile(name);
    const probe = await policyProbe(
      {
        profile,
        authorize: async () =>
          err(new WorkflowError("WORKFLOW_REPAIR_LOCKED", "Repair is locked.")),
      },
      ["write", "edit"],
    );

    expect(probe.active).toEqual(["write", "edit"]);
    expect((await probe.call({ toolName: "write" }))?.reason).toBe(
      "[WORKFLOW_REPAIR_LOCKED] Repair is locked.",
    );
    expect(childToolEnforcement({ profile }).deniedProductEdit).toBe(false);
  },
);

test("Custom profiles keep their existing tools semantics rather than acquiring built-in role authority", async () => {
  const profile: AgentProfile = {
    name: "qa",
    description: "Legacy custom QA",
    skills: [],
    prompt: "Inspect",
    path: "/custom/qa.md",
    toolCeiling: ["read"],
  };
  const unrestricted = await policyProbe({ profile }, ["write", "edit", "bash"]);
  const narrowed = await policyProbe({ profile: { ...profile, tools: ["write"] } }, [
    "write",
    "edit",
    "bash",
  ]);

  expect(unrestricted.active).toEqual(["write", "edit", "bash"]);
  expect(await unrestricted.call({ toolName: "write" })).toBeUndefined();
  expect(narrowed.active).toEqual(["write"]);
});

test.each(["edit", "write"])(
  "SDK nested MCP alias to registered %s reaches the stable ceiling block",
  async (target) => {
    const directory = await mkdtemp(join(tmpdir(), "radian-capability-nested-"));
    const offline = await offlineRuntime(directory);
    const marker = join(directory, "forbidden.txt");
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [
        childToolPolicy({ profile: builtinProfile("qa") }),
        (pi) => {
          // Non-direct exposure stays callable while inactive, unlike native tools.
          pi.registerTool({
            name: target,
            label: target,
            description: "Forbidden fixture mutation",
            exposure: "codemode",
            parameters: Type.Object({}),
            execute: async () => {
              await writeFile(marker, "unexpected");
              return { content: [{ type: "text", text: "unexpected" }], details: undefined };
            },
          });
          pi.registerTool({
            name: "mcp__fixture",
            label: "Alias",
            description: "Nested SDK alias",
            parameters: Type.Object({}),
            execute: async (_id, _args, _signal, _update, ctx) => {
              const result = await ctx.executeTool(target, {});
              return { content: result.result.content, details: undefined };
            },
          });
        },
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: offline.modelRuntime!,
      model: offline.model!,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(directory),
      customTools: childToolDenials({ profile: builtinProfile("qa") }),
    });
    session.agent.streamFunction = (model, context, request) => {
      if (context.messages.at(-1)?.role !== "user")
        return offline.streamFn!(model, context, request);
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      message.content = [
        { type: "toolCall", id: "nested-alias", name: "mcp__fixture", arguments: {} },
      ];
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
      return stream;
    };
    try {
      await session.bindExtensions({});
      await session.prompt("Attempt registered nested product edit");

      expect(await Bun.file(marker).exists()).toBe(false);
      // Active denial-only implementations are deliberately hidden from model declarations.
      expect(session.getToolDefinition(target)?.prepareLoadout?.({} as never)).toEqual({
        hiddenDeclarations: [target],
      });
      const result = session.messages.find((message) => message.role === "toolResult");
      expect(result?.content).toEqual([
        {
          type: "text",
          text: "[AGENT_TOOL_CEILING] This tool is outside the agent's host-enforced capability ceiling.",
        },
      ]);
    } finally {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

type CapabilityCase = {
  agent: string;
  target: string;
  nested?: boolean;
  outer?: "read" | "mcp__browser_use";
  tools?: string[];
  denyAuthorization?: boolean;
  malformed?: boolean;
  route?: "claude-code" | "anthropic" | "openai";
  purpose?: "planning" | "analysis";
  boundRole?: "lead" | "implementer" | undefined;
};

async function sdkCapabilityProbe(testCase: CapabilityCase) {
  const directory = await mkdtemp(join(tmpdir(), "radian-capability-"));
  const agentDir = join(directory, "agent");
  const marker = join(directory, "product.txt");
  let executor: Awaited<ReturnType<ReturnType<typeof piSessionFactory>>> | undefined;
  try {
    const offline = await offlineRuntime(agentDir);
    await writeFile(marker, "original");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    const nativeArgs =
      testCase.target === "write"
        ? { path: marker, content: "changed" }
        : testCase.target === "edit"
          ? { path: marker, oldText: "original", newText: "changed" }
          : testCase.target === "bash"
            ? { command: `printf changed > ${JSON.stringify(marker)}` }
            : {};
    const args = testCase.malformed ? { invalid: true } : nativeArgs;
    const outer = testCase.outer ?? "read";
    await writeFile(
      join(agentDir, "extensions", "capability.ts"),
      `
      import {writeFileSync} from "node:fs";
      export default function(pi) {
        for (const name of ["mcp__fixture", "mcp__fixture__write", "unknown_alias"])
          pi.registerTool({name, label:name, description:"Fixture mutation", exposure:"codemode", parameters:{type:"object",properties:{}}, execute:async()=>{writeFileSync(${JSON.stringify(marker)}, "changed"); return {content:[{type:"text",text:"changed"}],details:undefined};}});
        pi.registerTool({name:${JSON.stringify(outer)},label:"Alias",description:"Alias using the SDK tool pipeline",parameters:{type:"object",properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{const result=await ctx.executeTool(${JSON.stringify(testCase.target)},${JSON.stringify(args)});return {isError:result.isError,content:result.result.content,details:undefined};}});
      }
    `,
    );
    if (testCase.tools)
      await writeFile(
        join(agentDir, "agents", `${testCase.agent}.md`),
        `---\ntools: ${JSON.stringify(testCase.tools)}\n---\nNarrowed fixture.\n`,
      );
    if (testCase.route) {
      const api =
        testCase.route === "claude-code"
          ? "claude-code-stream-json"
          : testCase.route === "openai"
            ? "openai-responses"
            : "anthropic-messages";
      offline.modelRuntime!.registerProvider(testCase.route, {
        api,
        baseUrl: "http://127.0.0.1:1",
        apiKey: "offline-declaration-fixture",
        models: [
          {
            id: "declarations",
            name: "Declaration fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      offline.model = offline.modelRuntime!.getModel(testCase.route, "declarations")!;
    }
    const advertised: string[] = [];
    const authorized: string[] = [];
    executor = await piSessionFactory({
      ...offline,
      defaultPackagePaths: [],
      streamFn(model, context, request) {
        // Inspect every request, including the automatic follow-up after the denied call.
        for (const message of context.messages)
          if (message.role === "system")
            advertised.push(...(message.toolsAdded ?? []).map((tool) => tool.name));
        if (context.messages.at(-1)?.role !== "user")
          return offline.streamFn!(model, context, request);
        const stream = createAssistantMessageEventStream();
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [
          {
            type: "toolCall",
            id: "capability-call",
            name: testCase.nested ? outer : testCase.target,
            arguments: testCase.nested ? {} : args,
          },
        ];
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    })({
      cwd: directory,
      role: "subagent",
      agent: testCase.agent,
      ...(testCase.purpose ? { purpose: testCase.purpose } : {}),
      ...(testCase.boundRole
        ? {
            binding: {
              workflowId: crypto.randomUUID(),
              taskId: "fixture",
              assignmentVersion: 0,
              role: testCase.boundRole,
            },
          }
        : {}),
      authorizeTool: async (name) => {
        authorized.push(name);
        return testCase.denyAuthorization
          ? err(new WorkflowError("WORKFLOW_REPAIR_LOCKED", "Repair is locked."))
          : ok(undefined);
      },
      spawnSubagent: async () => ok("unused"),
    });

    expectOk(await executor.prompt("Attempt fixture tool"));

    return {
      advertised,
      authorized,
      contents: await readFile(marker, "utf8"),
      output: executor.state.output,
      toolErrors: executor.state.sections?.filter(
        (section) => section.kind === "tool" && section.status === "error",
      ),
      enforcement: executor.enforcement,
    };
  } finally {
    if (executor) expectOk(await executor.close());
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(
  ["write", "edit"].flatMap((target) =>
    [false, true].map((nested) => ({ agent: "qa", target, nested })),
  ),
)("Default QA cannot advertise or execute native $target (nested: $nested)", async (testCase) => {
  const result = await sdkCapabilityProbe(testCase);

  expect(result.advertised).not.toContain("edit");
  expect(result.advertised).not.toContain("write");
  expect(result.contents).toBe("original");
  expect(result.output).toContain("[AGENT_TOOL_CEILING]");
  expect(result.toolErrors).toHaveLength(1);
  expect(result.authorized).toEqual([]);
  expect(result.enforcement).toMatchObject({
    deniedProductEdit: true,
    reachableUnsandboxed: ["bash", "mcp__*"],
    sandboxed: false,
  });
});

test.each(["bash", "mcp__fixture", "mcp__fixture__write"])(
  "QA execution admits host-trusted unsandboxed %s verification",
  async (target) => {
    const result = await sdkCapabilityProbe({ agent: "qa", target, nested: true });

    // Deliberately prove that verification access is not filesystem isolation.
    expect(result.contents).toBe("changed");
    expect(result.authorized).toEqual([target]);
    expect(result.enforcement?.sandboxed).toBe(false);
  },
);

test.each(["bash", "mcp__fixture", "mcp__fixture__write", "unknown_alias"])(
  "QA overlay prevents SDK nested %s outside its narrowed ceiling",
  async (target) => {
    const result = await sdkCapabilityProbe({ agent: "qa", target, nested: true, tools: ["read"] });

    expect(result.contents).toBe("original");
    expect(result.authorized).toEqual([]);
    expect(result.enforcement?.reachableUnsandboxed).toEqual([]);
  },
);

test.each(["planning", "analysis"] as const)(
  "QA SDK %s retains read-only purpose despite verification ceiling",
  async (purpose) => {
    const result = await sdkCapabilityProbe({ agent: "qa", target: "bash", nested: true, purpose });

    expect(result.contents).toBe("original");
    expect(result.advertised).not.toContain("bash");
    expect(result.enforcement?.reachableUnsandboxed).toEqual([]);
  },
);

test.each(
  ["product-lead", "tech-lead", "ui-ux-lead"].flatMap((agent) =>
    [undefined, "lead" as const].flatMap((boundRole) =>
      ["edit", "write"].flatMap((target) =>
        [false, true].map((nested) => ({ agent, boundRole, target, nested })),
      ),
    ),
  ),
)(
  "SDK $agent ($boundRole) returns a stable native $target denial (nested: $nested)",
  async (testCase) => {
    // A lead-only role cannot gain edit authority by omitting its binding.
    const result = await sdkCapabilityProbe(testCase);

    expect(result.contents).toBe("original");
    expect(result.advertised).not.toContain(testCase.target);
    expect(result.output).toContain("[AGENT_TOOL_CEILING]");
    expect(result.toolErrors).toHaveLength(1);
    expect(result.authorized).toEqual([]);
  },
);

test.each(
  ["qa", "engineer", "product-lead"].flatMap((agent) =>
    (["planning", "analysis"] as const).flatMap((purpose) =>
      ["edit", "write", "bash", "powershell"].flatMap((target) =>
        [false, true].map((nested) => ({ agent, purpose, target, nested })),
      ),
    ),
  ),
)(
  "SDK $agent $purpose returns a stable native $target denial (nested: $nested)",
  async (testCase) => {
    // Purpose restrictions also apply to roles whose execution ceiling permits the real tool.
    const result = await sdkCapabilityProbe(testCase);

    expect(result.contents).toBe("original");
    expect(result.advertised).not.toContain(testCase.target);
    expect(result.output).toContain("[AGENT_TOOL_CEILING]");
    expect(result.toolErrors).toHaveLength(1);
    expect(result.authorized).toEqual([]);
  },
);

test.each(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"])(
  "SDK built-in overlay returns a stable denial for native %s outside its ceiling",
  async (target) => {
    // An empty built-in overlay denies every native tool, including investigation tools.
    const result = await sdkCapabilityProbe({ agent: "engineer", tools: [], target });

    expect(result.contents).toBe("original");
    expect(result.advertised).not.toContain(target);
    expect(result.output).toContain("[AGENT_TOOL_CEILING]");
    expect(result.toolErrors).toHaveLength(1);
    expect(result.authorized).toEqual([]);
  },
);

test.each(["edit", "write"])("SDK MCP wrapper cannot bypass native %s denial", async (target) => {
  // The allowed outer MCP tool still passes authorize; the inner native tool never does.
  const result = await sdkCapabilityProbe({
    agent: "qa",
    target,
    nested: true,
    outer: "mcp__browser_use",
  });

  expect(result.contents).toBe("original");
  expect(result.advertised).not.toContain(target);
  expect(result.output).toContain("[AGENT_TOOL_CEILING]");
  expect(result.toolErrors).toHaveLength(1);
  expect(result.authorized).toEqual(["mcp__browser_use"]);
});

test.each(["claude-code", "anthropic", "openai"] as const)(
  "SDK %s request declarations never advertise denial-only native tools",
  async (route) => {
    // All transports receive the SDK's projected declarations, not its executable loadout.
    const result = await sdkCapabilityProbe({ agent: "qa", target: "write", route });

    expect(result.advertised).toContain("read");
    expect(result.advertised).not.toContain("write");
    expect(result.advertised).not.toContain("edit");
    expect(result.output).toContain("[AGENT_TOOL_CEILING]");
    expect(result.contents).toBe("original");
  },
);

test.each([false, true])(
  "SDK malformed native denial retains its code (nested: %p)",
  async (nested) => {
    // Denied arguments must not turn a ceiling refusal into an SDK validation failure.
    const result = await sdkCapabilityProbe({
      agent: "qa",
      target: "write",
      nested,
      malformed: true,
    });

    expect(result.output).toContain("[AGENT_TOOL_CEILING]");
    expect(result.toolErrors).toHaveLength(1);
    expect(result.contents).toBe("original");
  },
);

test.each(
  ["engineer", "product-lead", "tech-lead", "ui-ux-lead", "probe"].flatMap((agent) =>
    ["edit", "write"].flatMap((target) =>
      [false, true].map((nested) => ({ agent, target, nested })),
    ),
  ),
)("SDK $agent uses real native $target through authorize (nested: $nested)", async (testCase) => {
  // Binding a lead as implementer keeps the original native tool, not a denial replacement.
  const result = await sdkCapabilityProbe({
    ...testCase,
    boundRole:
      testCase.agent === "engineer" || testCase.agent === "probe" ? undefined : "implementer",
  });

  expect(result.contents).toBe("changed");
  expect(result.authorized).toEqual([testCase.target]);
  expect(result.advertised).toContain(testCase.target);
  expect(result.advertised).not.toContain("grep");
  expect(result.toolErrors).toHaveLength(0);
});

test.each(
  ["engineer", "tech-lead"].flatMap((agent) =>
    ["edit", "write"].flatMap((target) =>
      [false, true].map((nested) => ({ agent, target, nested })),
    ),
  ),
)(
  "SDK $agent native $target still respects authorization refusal (nested: $nested)",
  async (testCase) => {
    // Durable workflow authorization must remain the boundary for otherwise allowed native tools.
    const result = await sdkCapabilityProbe({
      ...testCase,
      boundRole: "implementer",
      denyAuthorization: true,
    });

    expect(result.contents).toBe("original");
    expect(result.authorized).toEqual([testCase.target]);
    expect(result.advertised).toContain(testCase.target);
    expect(result.output).toContain("[WORKFLOW_REPAIR_LOCKED]");
    expect(result.toolErrors).toHaveLength(1);
  },
);

test("Denial-only native replacements fail closed even without a tool_call hook", async () => {
  const denials = childToolDenials({ profile: builtinProfile("qa"), purpose: "planning" });

  // These replacements carry no reference to the real SDK implementation or caller arguments.
  for (const denial of denials) {
    const result = await denial.execute("fixture", {}, undefined, undefined, {} as never);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[AGENT_TOOL_CEILING] This tool is outside the agent's host-enforced capability ceiling.",
      },
    ]);
  }
  expect(
    childToolDenials({
      profile: {
        name: "custom",
        description: "Custom",
        prompt: "Inspect",
        path: "/custom.md",
        skills: [],
        tools: [],
      },
    }),
  ).toEqual([]);
});
