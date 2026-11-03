import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { expectOk } from "../testing/results.ts";
import { err, ok } from "../result.ts";
import { CapabilityError, WorkflowError } from "../errors.ts";

test.each([
  ["subagent", false],
  ["radian-subagent", false],
  ["radian_subagent", false],
  ["subagent", true],
  ["radian_subagent", true],
  ["subagents_enable", true],
] as const)(
  "Radian children cannot use legacy delegation tool %s (delegating profile: %p)",
  async (name, delegating) => {
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
