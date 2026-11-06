import { expect, test } from "bun:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  validateToolArguments,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { createWorkflowDocument } from "./task-workflow.ts";
import { publishPlanArtifact } from "./verification-policy.ts";
import {
  makeStrictJsonSchema,
  resolveJsonSchemaStrictSampling,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { declareActionTool } from "./tool-protocol.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { ToolProtocolError } from "../errors.ts";
import type { Result } from "../result.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { taskProtocol, taskTool, type TaskCommand } from "./task-tool.ts";
import {
  subagentProtocol,
  subagentTool,
  supervisorProtocol,
  supervisorTool,
} from "./subagent-tools.ts";
import { planProtocol, taskPlanningExtension } from "./task-planning.ts";
import type { TaskPlan } from "./task-plan.ts";
import { ok } from "../result.ts";

const plan: TaskPlan = {
  schemaVersion: 1,
  goal: "Ship the contract",
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  tasks: [
    {
      id: "contract",
      title: "Define contract",
      agent: "main",
      dependsOn: [],
      inputs: [],
      outputs: ["Contract"],
      acceptanceCriteria: ["Reviewed"],
      files: [],
    },
  ],
};
const review = { summary: "Reviewed", warnings: [] };
const publish: Extract<TaskCommand, { action: "publish-plan" }> = {
  action: "publish-plan",
  artifactId: "branch-plan",
  plan,
  review,
};
const workflowTask = {
  id: "next",
  title: "Next task",
  kind: "implement",
  scope: "Contract",
  dependsOn: [],
  lead: { profile: "lead" },
  assignmentVersion: 0,
  artifactRevision: 0,
  verification: { state: "unverified" },
  status: "open",
};

type Protocol = {
  parameters: typeof planProtocol.parameters;
  constrainedSampling: typeof planProtocol.constrainedSampling;
  validateAction(raw: unknown): Result<unknown, ToolProtocolError>;
  prepareArguments(raw: unknown): Record<string, unknown>;
};
function protocolError(result: Result<unknown, ToolProtocolError>): ToolProtocolError {
  const error = expectError(result);
  if (!(error instanceof ToolProtocolError)) throw error;
  return error;
}

const cases: [string, Protocol, Record<string, unknown>[]][] = [
  [
    "task",
    taskProtocol,
    [
      { action: "status" },
      publish,
      { action: "finding", defectId: "d", revision: 0, summary: "Defect", evidence: "Test" },
      { action: "verdict", revision: 0, verdict: "pass", evidence: "Test" },
      { action: "submit" },
      {
        action: "analysis",
        defectId: "d",
        analysis: {
          reproduction: "Test",
          attempts: "None",
          causes: [{ text: "Cause", status: "hypothesis" }],
          remedies: [],
          humanDecisions: [],
        },
      },
      {
        action: "declare",
        goal: "Goal",
        branches: [
          {
            id: "branch",
            title: "Branch",
            scope: "Scope",
            dependsOn: [],
            lead: { profile: "lead" },
          },
        ],
      },
      {
        action: "assign",
        parentTaskId: "p",
        tasks: [
          {
            id: "next",
            title: "Next",
            kind: "implement",
            scope: "Scope",
            dependsOn: [],
            lead: { profile: "lead" },
            implementer: { profile: "engineer" },
            verifier: { profile: "qa" },
          },
        ],
      },
      { action: "reassign", taskId: "t", role: "lead", profile: "lead" },
      { action: "continue", taskId: "t", task: workflowTask },
      { action: "split", taskId: "t", task: workflowTask },
    ],
  ],
  [
    "subagent",
    subagentProtocol,
    [
      { action: "list" },
      {
        action: "spawn",
        agent: "engineer",
        task: "Work",
        binding: { id: "task", role: "implementer" },
        async: false,
      },
      { action: "status" },
      { action: "wait" },
      { action: "steer", id: "r", message: "Guide" },
      { action: "reply", id: "r", questionId: "q", message: "Answer" },
      { action: "stop", id: "r" },
    ],
  ],
  [
    "supervisor",
    supervisorProtocol,
    [
      { action: "progress", message: "Update" },
      { action: "ask", message: "Decision?" },
      { action: "proposal", proposal: { plan, review } },
    ],
  ],
  [
    "plan",
    planProtocol,
    [
      { action: "report" },
      { action: "read" },
      { action: "submit", plan, review },
      { action: "delegate" },
      { action: "wait" },
      { action: "reply", questionId: "q", message: "Answer" },
      { action: "cancel" },
      { action: "accept" },
    ],
  ],
];
const escapedFieldCases = [
  ["qa~/field", "/qa~0~1field"],
  ["qa~field", "/qa~0field"],
  ["qa/field", "/qa~1field"],
  ["qa~1field", "/qa~01field"],
  ["qa~0~1/field", "/qa~00~01~1field"],
  ["", "/"],
] as const;

function expectClosedObjects(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if ("type" in value && value.type === "object") {
    expect(value).toHaveProperty("additionalProperties", false);
  }
  for (const child of Object.values(value)) expectClosedObjects(child);
}

for (const [name, protocol, fixtures] of cases) {
  test(`${name} keeps every provider declaration object closed, including nested inputs`, () => {
    // Provider projection retains the imported task, analysis, binding and plan contracts.
    expectClosedObjects(protocol.parameters);
  });

  test(`${name} declares an object with all action fields and accepts canonical fixtures`, () => {
    // Provider projection must not erase the action discriminator or nested contracts.
    expect(protocol.parameters.type).toBe("object");
    expect(protocol.parameters.required).toEqual(["action"]);
    for (const key of ["anyOf", "oneOf", "allOf"])
      expect(protocol.parameters).not.toHaveProperty(key);

    // Host validation and declaration validation agree on every supported action.
    for (const fixture of fixtures) {
      expect(Value.Check(protocol.parameters, fixture)).toBe(true);
      expect(expectOk(protocol.validateAction(fixture))).toEqual(fixture);
      const prepared = protocol.prepareArguments(fixture);
      const validated = validateToolArguments(
        { name, description: "Fixture", parameters: protocol.parameters },
        { type: "toolCall", id: "call", name, arguments: prepared as ToolCall["arguments"] },
      );
      expect(validated).toEqual(fixture);
      expect(fixture).toEqual(prepared);
      expect(prepared).not.toBe(fixture);
    }
  });

  test.each(escapedFieldCases)(
    `${name} reports only the escaped pointer for extra key %j on every action`,
    (key, path) => {
      // Exercise every selected schema, not just the shared provider projection.
      for (const fixture of fixtures) {
        const raw = { ...fixture, [key]: true };
        const error = protocolError(protocol.validateAction(raw));

        // Literal escape sequences are field names and must be escaped exactly once.
        expect(error.code).toBe("TOOL_ACTION_FIELDS");
        expect(error.paths).toEqual([path]);
        expect(error.message).toContain(`Paths: ${path}.`);
      }
    },
  );

  test(`${name} does not force nullable fields that its selected action rejects`, () => {
    // A syntactically supported strict schema can require noncanonical null placeholders.
    const tool = { name, description: "Fixture", ...protocol };
    const strict = makeStrictJsonSchema(protocol.parameters);
    const nullableCall = Object.fromEntries(
      Object.keys(protocol.parameters.properties).map((key) => [key, null]),
    );
    Object.assign(nullableCall, fixtures[0]);

    // Reject incompatible strict generation rather than accepting malformed action fields.
    expect(Value.Check(strict, nullableCall)).toBe(true);
    expect(protocol.validateAction(nullableCall).ok).toBe(false);
    expect(tool.constrainedSampling).toBe(false);
    expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
    expect(resolveJsonSchemaStrictSampling(tool, false)).toBeUndefined();
    expectOk(protocol.validateAction(fixtures[0]));
  });

  test.each([{}, { action: "incident" }, { action: "publish_plan" }, { action: "recheck" }])(
    `${name} rejects missing actions and aliases without mapping them: %j`,
    (raw) => {
      // Unknown actions never trigger union-wide field diagnostics.
      const error = protocolError(protocol.validateAction(raw));
      expect(error.code).toBe("TOOL_ACTION_UNKNOWN");
      expect(error.paths).toEqual(["/action"]);
      expect(error.message).toContain("Valid actions:");
      expect(error.skeleton).toBeUndefined();
    },
  );
}

const profileFieldCases: [Record<string, unknown>, string][] = escapedFieldCases.flatMap(
  ([key, suffix]) => [
    [
      {
        action: "declare",
        goal: "Goal",
        branches: [
          {
            id: "branch",
            title: "Branch",
            scope: "Scope",
            dependsOn: [],
            lead: { profile: "lead", [key]: true },
          },
        ],
      },
      `/branches/0/lead${suffix}`,
    ],
    ...(["lead", "implementer", "verifier"] as const).map(
      (role): [Record<string, unknown>, string] => [
        {
          action: "assign",
          parentTaskId: "parent",
          tasks: [
            {
              id: "next",
              title: "Next",
              kind: "implement",
              scope: "Scope",
              dependsOn: [],
              [role]: { profile: role, [key]: true },
            },
          ],
        },
        `/tasks/0/${role}${suffix}`,
      ],
    ),
  ],
);

const rawFieldCases: {
  name: string;
  protocol: Protocol;
  valid: Record<string, unknown>;
  invalid: [Record<string, unknown>, string][];
}[] = [
  {
    name: "radian-subagent",
    protocol: subagentProtocol,
    valid: { action: "list" },
    invalid: [
      [{ action: "list", extraQA: true }, "/extraQA"],
      [{ action: "list", "qa~/field": true }, "/qa~0~1field"],
      [{ action: "list", id: "x" }, "/id"],
      [{ action: "list", async: null }, "/async"],
      [{ action: "spawn", agent: "engineer", task: "Work", async: null }, "/async"],
    ],
  },
  {
    name: "radian-supervisor",
    protocol: supervisorProtocol,
    valid: { action: "progress", message: "Update" },
    invalid: [
      [{ action: "progress", message: "Update", extraQA: true }, "/extraQA"],
      [{ action: "progress", message: "Update", "qa~1/field": true }, "/qa~01~1field"],
      [{ action: "progress", message: "Update", proposal: { plan, review } }, "/proposal"],
      [{ action: "progress", message: "Update", proposal: null }, "/proposal"],
    ],
  },
  {
    name: "radian-task",
    protocol: taskProtocol,
    valid: { action: "status" },
    invalid: [
      ...profileFieldCases,
      [{ action: "status", extraQA: true }, "/extraQA"],
      [{ action: "status", "qa~/field": true }, "/qa~0~1field"],
      [{ ...publish, plan: { ...plan, "qa~/field": true } }, "/plan/qa~0~1field"],
      [
        {
          ...publish,
          plan: { ...plan, tasks: [{ ...plan.tasks[0], "qa~1/field": true }] },
        },
        "/plan/tasks/0/qa~01~1field",
      ],
      [{ action: "status", revision: 0 }, "/revision"],
      [{ action: "status", id: null }, "/id"],
    ],
  },
  {
    name: "radian-plan",
    protocol: planProtocol,
    valid: { action: "report" },
    invalid: [
      [{ action: "report", extraQA: true }, "/extraQA"],
      [{ action: "report", "qa~/field": true }, "/qa~0~1field"],
      [{ action: "report", questionId: "q" }, "/questionId"],
      [{ action: "report", review: null }, "/review"],
    ],
  },
];

for (const { name, protocol, invalid } of rawFieldCases) {
  test.each(invalid)(
    `${name} rejects raw extra, cross-action and null fields: %j at %s`,
    (raw, path) => {
      // Nulls in optional projection fields must not be laundered into absent fields by Pi.
      const error = protocolError(protocol.validateAction(raw));

      expect(error.code).toBe("TOOL_ACTION_FIELDS");
      expect(error.paths).toEqual([path]);
      expect(() => protocol.prepareArguments(raw)).toThrow(error.message);
    },
  );
}

test("Pi rejects invalid raw fields for every host tool before normalization or execution", async () => {
  // Register the actual extension tools, including radian-plan's real registration and SDK wrapper.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-raw-tool-fields-")));
  const options = await offlineRuntime(join(directory, "agent"));
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: options.agentDir!,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      taskPlanningExtension(),
      (pi) => {
        pi.registerTool(subagentTool(async () => ok("Handled")));
        pi.registerTool(supervisorTool(async () => ok("Handled"), true));
        pi.registerTool(taskTool(async () => ok("Handled")));
      },
    ],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: options.agentDir!,
      modelRuntime: options.modelRuntime!,
      model: options.model!,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.create(directory, options.sessionDir),
    }));
    await session.bindExtensions({});
    const assistantMessage = fixtureMessage("openai-completions", "radian-offline", "fixture");

    for (const { name, valid, invalid } of rawFieldCases) {
      const registered = session.agent.state.tools.find((tool) => tool.name === name);
      if (!registered) throw new Error(`Missing host tool ${name}`);
      let executions = 0;
      let policyCalls = 0;
      const tool = {
        ...registered,
        execute: (...args: Parameters<typeof registered.execute>) => {
          executions++;
          return registered.execute(...args);
        },
      };
      const run = (raw: Record<string, unknown>) =>
        runToolCall(
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name,
            arguments: raw as ToolCall["arguments"],
          },
          {
            tools: [tool],
            assistantMessage,
            context: { messages: [assistantMessage], tools: [tool] },
            beforeToolCall: async () => {
              policyCalls++;
              return undefined;
            },
          },
        );

      // A valid control proves the wrapped host handler and policy hook are reachable.
      expect((await run(valid)).isError).toBe(false);
      expect(executions).toBe(1);
      expect(policyCalls).toBe(1);

      for (const [raw, path] of invalid) {
        const original = structuredClone(raw);
        const outcome = await run(raw);

        // Preparation errors are model-visible and precede both SDK policy hooks and execution.
        expect(outcome.isError).toBe(true);
        expect(outcome.result.content).toEqual([
          { type: "text", text: expect.stringContaining("[TOOL_ACTION_FIELDS]") },
        ]);
        expect(outcome.result.content[0]).toMatchObject({
          text: expect.stringContaining(`Paths: ${path}.`),
        });
        expect(outcome.durationMs).toBeUndefined();
        expect(executions).toBe(1);
        expect(policyCalls).toBe(1);
        expect(raw).toEqual(original);
      }
    }
  } finally {
    session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(profileFieldCases)(
  "Pi rejects nested profile extras without calling the task handler: %j at %s",
  async (raw, path) => {
    // The real task handler must be unreachable even if Pi normally normalizes nested fields.
    let handlerCalls = 0;
    const definition = taskTool(async () => {
      handlerCalls++;
      return ok("Handled");
    });
    const tool = {
      ...definition,
      execute: (id: string, args: unknown, signal?: AbortSignal) =>
        definition.execute(id, args, signal, undefined, {} as ExtensionToolContext),
    };
    const assistantMessage = fixtureMessage("openai-completions", "radian-offline", "fixture");
    const original = structuredClone(raw);

    const outcome = await runToolCall(
      {
        type: "toolCall",
        id: "nested-profile",
        name: tool.name,
        arguments: raw as ToolCall["arguments"],
      },
      {
        tools: [tool],
        assistantMessage,
        context: { messages: [assistantMessage], tools: [tool] },
      },
    );

    // Model-visible diagnostics must contain only the escaped pointer, not a raw-key variant.
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content).toEqual([
      { type: "text", text: expect.stringContaining("[TOOL_ACTION_FIELDS]") },
    ]);
    expect(outcome.result.content[0]).toMatchObject({
      text: expect.stringContaining(`Paths: ${path}.`),
    });
    expect(handlerCalls).toBe(0);
    expect(raw).toEqual(original);
  },
);

test.each(escapedFieldCases)(
  "selected actions report only escaped pointers for nested extra key %j",
  (key, path) => {
    // Start with the public skeleton to cover the same publication shape shown in errors.
    const canonical = taskProtocol.actionSkeleton("publish-plan") as typeof publish;
    expectOk(taskProtocol.validateAction(canonical));
    const nestedCases = [
      [{ ...canonical, plan: { ...canonical.plan, [key]: true } }, `/plan${path}`],
      [
        {
          ...canonical,
          plan: { ...canonical.plan, tasks: [{ ...canonical.plan.tasks[0], [key]: true }] },
        },
        `/plan/tasks/0${path}`,
      ],
      [{ ...canonical, review: { ...canonical.review, [key]: true } }, `/review${path}`],
      [{ action: "continue", taskId: "t", task: { ...workflowTask, [key]: true } }, `/task${path}`],
      [
        {
          action: "continue",
          taskId: "t",
          task: {
            ...workflowTask,
            verification: { ...workflowTask.verification, [key]: true },
          },
        },
        `/task/verification${path}`,
      ],
    ] as const;

    // Each location must yield one resolvable pointer, not a second raw-key variant.
    for (const [raw, expectedPath] of nestedCases) {
      const error = protocolError(taskProtocol.validateAction(raw));
      expect(error.code).toBe("TOOL_ACTION_FIELDS");
      expect(error.paths).toEqual([expectedPath]);
      expect(error.message).toContain(`Paths: ${expectedPath}.`);
      expect(error.skeleton).toEqual(taskProtocol.actionSkeleton(raw.action));
      expectOk(taskProtocol.validateAction(error.skeleton));
    }
  },
);

test("escaped pointers survive TypeBox's error limit without a parent additionalProperties error", () => {
  // More than eight extras exhaust TypeBox's default error budget with boolean errors alone.
  const raw = {
    action: "list",
    ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`qa~1/${index}`, true])),
  };
  const error = protocolError(subagentProtocol.validateAction(raw));

  expect(error.code).toBe("TOOL_ACTION_FIELDS");
  expect(error.paths.length).toBeGreaterThan(0);
  expect(error.paths.length).toBeLessThanOrEqual(16);
  for (const path of error.paths) expect(path).toMatch(/^\/qa~01~1\d+$/);
  expect(new Set(error.paths).size).toBe(error.paths.length);
});

test("nested diagnostics remain bounded while traversing array items", () => {
  // Each task has a distinct invalid array field, beyond the diagnostic output budget.
  const raw = {
    ...publish,
    plan: {
      ...plan,
      tasks: Array.from({ length: 40 }, () => ({ ...plan.tasks[0], outputs: [] })),
    },
  };
  const error = protocolError(taskProtocol.validateAction(raw));

  expect(error.code).toBe("TOOL_ACTION_FIELDS");
  expect(error.paths).toEqual(
    Array.from({ length: 16 }, (_, index) => `/plan/tasks/${index}/outputs`),
  );
  expectOk(taskProtocol.validateAction(error.skeleton));
});

test("declared special keys retain structured pointers for required, type and extra-field errors", () => {
  // Raw paths are ambiguous when a slash-containing key also resembles a nested object path.
  const protocol = declareActionTool([
    Type.Object(
      {
        action: Type.Literal("check"),
        "qa~/~1": Type.Object({ "value~/~1": Type.String() }, { additionalProperties: false }),
        "qa/b": Type.String(),
        qa: Type.Object({ b: Type.String() }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
  ]);
  const valid = {
    action: "check",
    "qa~/~1": { "value~/~1": "Value" },
    "qa/b": "Value",
    qa: { b: "Value" },
  };
  const invalidCases = [
    [{ ...valid, "qa~/~1": {} }, ["/qa~0~1~01/value~0~1~01"]],
    [{ ...valid, "qa~/~1": { "value~/~1": false } }, ["/qa~0~1~01/value~0~1~01"]],
    [
      { ...valid, "qa~/~1": { ...valid["qa~/~1"], "extra~/~1": true } },
      ["/qa~0~1~01/extra~0~1~01"],
    ],
    [{ ...valid, "qa/b": false }, ["/qa~1b"]],
    [{ ...valid, qa: { b: false } }, ["/qa/b"]],
    [{ ...valid, "qa/b": false, qa: { b: false } }, ["/qa~1b", "/qa/b"]],
  ] as const;

  for (const [raw, paths] of invalidCases) {
    const error = protocolError(protocol.validateAction(raw));
    expect(error.code).toBe("TOOL_ACTION_FIELDS");
    expect(error.paths).toEqual(paths);
    expectOk(protocol.validateAction(error.skeleton));
  }
});

const invalidFields: [unknown, string][] = [
  [{ ...publish, plan: { ...plan, extraField: true } }, "/plan/extraField"],
  [
    { ...publish, plan: { ...plan, openQuestions: [{ question: "Decision?" }] } },
    "/plan/openQuestions/0",
  ],
  [
    { ...publish, plan: { ...plan, openQuestions: { question: "Decision?" } } },
    "/plan/openQuestions",
  ],
  [{ ...publish, plan: { ...plan, tasks: [] } }, "/plan/tasks"],
  [
    { ...publish, plan: { ...plan, tasks: [{ ...plan.tasks[0], extraField: true }] } },
    "/plan/tasks/0/extraField",
  ],
  [
    { ...publish, plan: { ...plan, tasks: [{ ...plan.tasks[0], outputs: [] }] } },
    "/plan/tasks/0/outputs",
  ],
  [
    { ...publish, plan: { ...plan, tasks: [{ ...plan.tasks[0], acceptanceCriteria: [] }] } },
    "/plan/tasks/0/acceptanceCriteria",
  ],
  [{ ...publish, review: { ...review, extraField: true } }, "/review/extraField"],
  [{ ...publish, plan: { incident: "Outage", timeline: [] } }, "/plan/incident"],
  [
    { action: "continue", taskId: "t", task: { ...workflowTask, extraField: true } },
    "/task/extraField",
  ],
  [{ action: "status", revision: 0 }, "/revision"],
  [{ ...publish, plan: { ...plan, schemaVersion: "1" } }, "/plan/schemaVersion"],
  [{ ...publish, review: null }, "/review"],
];
test.each(invalidFields)("selected action rejects invalid raw fields at %s (%s)", (raw, path) => {
  // Errors describe just the chosen action, with one canonical skeleton and JSON pointers.
  const error = protocolError(taskProtocol.validateAction(raw));
  expect(error.code).toBe("TOOL_ACTION_FIELDS");
  expect(error.paths).toContain(path);
  expect(error.message.match(/Canonical skeleton:/g)).toHaveLength(1);
  expect(Value.Check(taskProtocol.parameters, error.skeleton)).toBe(true);
  expectOk(taskProtocol.validateAction(error.skeleton));
  expect(error.message).not.toContain("anyOf");
});

test.each([
  { tasks: [{ ...plan.tasks[0], dependsOn: ["foreign"] }], path: "/plan/tasks/0/dependsOn/0" },
  { tasks: [plan.tasks[0], { ...plan.tasks[0] }], path: "/plan/tasks/1/id" },
  {
    tasks: [
      { ...plan.tasks[0], dependsOn: ["second"] },
      { ...plan.tasks[0], id: "second", dependsOn: ["contract"] },
    ],
    path: "/plan/tasks",
  },
])("publication graph validation preserves canonical rules at $path", ({ tasks, path }) => {
  // Structural validity alone cannot authorize foreign dependencies, duplicate IDs or cycles.
  const raw = { ...publish, plan: { ...plan, tasks } };
  expectOk(taskProtocol.validateAction(raw));
  const tool = taskTool(async () => ok("must not publish"));

  // The same graph validator used by publication now rejects before Pi normalizes arguments.
  expect(() => tool.prepareArguments!(raw)).toThrow("[PLAN_INVALID_SHAPE]");
  expect(() => tool.prepareArguments!(raw)).toThrow(path);
});

test.each([undefined, true, Type.String()])(
  "open action schemas fail at declaration instead of silently accepting extra fields: %j",
  (additionalProperties) => {
    // Future tools must explicitly close each member, not merely the shared provider projection.
    const schema = Type.Object(
      { action: Type.Literal("open") },
      additionalProperties === undefined ? {} : { additionalProperties },
    );

    expect(() => declareActionTool([schema])).toThrow("Action schema open must be closed.");
  },
);

test("strict generation remains available when it does not introduce nullable fields", () => {
  // Action-only tools have no optional slots for the strict converter to make mandatory.
  const protocol = declareActionTool([
    Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  ]);
  const tool = { name: "action-only", description: "Fixture", ...protocol };

  // The generated schema and the selected action agree on every generated field.
  expect(protocol.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  expect(resolveJsonSchemaStrictSampling(tool, true)).toBe(true);
  expect(Value.Check(makeStrictJsonSchema(protocol.parameters), { action: "status" })).toBe(true);
  expectOk(protocol.validateAction({ action: "status" }));
});

test("unsupported strict schemas do not request constrained sampling", () => {
  // Dynamic maps exceed the installed strict converter's closed-object subset.
  const protocol = declareActionTool([
    Type.Object(
      {
        action: Type.Literal("store"),
        values: Type.Record(Type.String(), Type.String()),
      },
      { additionalProperties: false },
    ),
  ]);
  expect(protocol.constrainedSampling).toBe(false);
});

test("nullable required strict fields do not bypass canonical raw validation", () => {
  // OpenAI's strict conversion requires every otherwise-optional field, allowing null placeholders.
  const strict = makeStrictJsonSchema(taskProtocol.parameters);
  const raw: Record<string, unknown> = Object.fromEntries(
    Object.keys(taskProtocol.parameters.properties).map((key) => [key, null]),
  );
  raw.action = "status";
  expect(strict.required).toEqual(Object.keys(taskProtocol.parameters.properties));
  expect(Value.Check(strict, raw)).toBe(true);

  // Pi would remove these nulls, but they are not fields of the canonical status action.
  const error = protocolError(taskProtocol.validateAction(raw));
  expect(error.code).toBe("TOOL_ACTION_FIELDS");
  expect(error.paths).toContain("/defectId");
  expect(() => taskTool(async () => ok("accepted")).prepareArguments!(raw)).toThrow(
    "[TOOL_ACTION_FIELDS]",
  );
});

test("raw validation runs before SDK coercion and execute defensively rejects direct invalid calls", async () => {
  // Pi would coerce numeric strings and delete optional nulls without prepareArguments.
  const raw = { action: "verdict", revision: "0", verdict: "pass", evidence: "Test" };
  const tool = taskTool(async () => ok("accepted"));
  expect(
    validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: raw }),
  ).toMatchObject({ revision: 0 });

  // The SDK preparation boundary rejects rather than laundering the malformed argument.
  expect(() => tool.prepareArguments!(raw)).toThrow("[TOOL_ACTION_FIELDS]");
  await expect(
    tool.execute("call", raw, undefined, undefined, {} as ExtensionToolContext),
  ).rejects.toMatchObject({ code: "TOOL_ACTION_FIELDS" });
  expect(raw.revision).toBe("0");
});

async function leadFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-publication-protocol-")));
  const options = await offlineRuntime(join(directory, "agent"));
  let doc = createWorkflowDocument(
    { conversationId: "root", cwd: directory, sessionFile: join(directory, "root.jsonl") },
    "workflow",
    1,
  );
  doc.tasks.branch = {
    id: "branch",
    title: "Branch",
    kind: "plan",
    scope: "Contract",
    dependsOn: [],
    lead: { profile: "lead" },
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
  };
  const binding = {
    workflowId: doc.workflowId,
    taskId: "branch",
    role: "lead",
    assignmentVersion: 0,
  } as const;
  const publishValid = (
    command: Extract<TaskCommand, { action: "publish-plan" }>,
    eventKey: string,
  ) => {
    const result = publishPlanArtifact(doc, {
      ...command,
      plan: { ...command.plan, schemaVersion: 1 },
      binding,
      eventKey,
      at: 2,
      author: { runId: "lead-run", profile: "lead", role: "lead" },
    });
    if (result.ok) doc = result.value.doc;
    return result;
  };
  expectOk(publishValid(publish, "baseline"));
  let script: (Record<string, unknown> | null)[] = [];
  const requests: string[] = [];
  let handled = 0;
  options.streamFn = (model, context) => {
    requests.push(JSON.stringify(context.messages));
    const message = fixtureMessage(model.api, model.provider, model.id);
    const command = script.shift();
    message.content = command
      ? [
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name: "radian-task",
            arguments: command as ToolCall["arguments"],
          },
        ]
      : [{ type: "text", text: "Done." }];
    message.stopReason = command ? "toolUse" : "stop";
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  const executor = await piSessionFactory(options)({
    cwd: directory,
    role: "subagent",
    purpose: "planning",
    binding,
    coordinateTask: async (command, callId) => {
      handled++;
      if (command.action !== "publish-plan") throw new Error("Unexpected fixture command");
      const result = publishValid(command, callId);
      return result.ok ? ok(result.value.outcome) : result;
    },
    spawnSubagent: async () => {
      throw new Error("Unexpected delegation");
    },
  });
  return {
    executor,
    requests,
    doc: () => doc,
    handled: () => handled,
    async run(next: (Record<string, unknown> | null)[]) {
      script = [...next];
      const before = requests.length;
      expectOk(await executor.prompt("Publish the reviewed branch plan."));
      return requests.length - before;
    },
    async close() {
      try {
        expectOk(await executor.close());
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

test("Pi delivers raw nested-field failures as tool errors and gives the same lead only one correction continuation", async () => {
  // A previous valid artifact must survive both invalid publications and a later prompt in the same run.
  const app = await leadFixture();
  const invalid = { ...publish, plan: { ...plan, extraField: true } };
  const baseline = structuredClone(app.doc());
  try {
    const calls = await app.run([invalid, null, invalid, null]);

    // prepareArguments failures are model-visible tool results, not crashes or persisted artifacts.
    expect(calls).toBe(4);
    expect(app.handled()).toBe(0);
    expect(app.requests[1]).toContain("TOOL_ACTION_FIELDS");
    expect(app.requests[1]).toContain("/plan/extraField");
    expect(app.requests[1]).toContain('"isError":true');
    expect(app.requests[2]).toContain("Correct this publish-plan once");
    expect(app.requests[2]).toContain("Do not edit files or execute tasks");
    expect(await readFile(app.executor.sessionFile!, "utf8")).toContain(
      "Publication blocked: correction budget exhausted",
    );
    expect(app.doc()).toEqual(baseline);
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(1);
    expect(app.doc().defects).toEqual({});

    // A new model turn does not reset the artifact+lead-run budget.
    expect(await app.run([invalid, null])).toBe(2);
    expect(app.doc()).toEqual(baseline);

    // An independent publication intent has its own one-turn budget.
    expect(await app.run([{ ...invalid, artifactId: "other-plan" }, null, null])).toBe(3);
    expect(app.doc()).toEqual(baseline);
  } finally {
    await app.close();
  }
});

test("a corrected publication succeeds in the continuation without another correction or invalid revision", async () => {
  const app = await leadFixture();
  try {
    // Only the canonical corrected body may reach the workflow policy and advance its revision.
    expect(await app.run([{ ...publish, plan: { ...plan, tasks: [] } }, null, publish, null])).toBe(
      4,
    );
    expect(app.handled()).toBe(1);
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(2);
    expect(await readFile(app.executor.sessionFile!, "utf8")).not.toContain("Publication blocked");

    // Success clears the pending error without replenishing this run's spent intent budget.
    expect(await app.run([{ ...publish, review: { ...review, extraField: true } }, null])).toBe(2);
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("semantic graph failures share the schema correction budget and reject unavailable agents", async () => {
  const app = await leadFixture();
  const invalid = {
    ...publish,
    plan: { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["contract"] }] },
  };
  try {
    // Self-dependencies pass the declaration but fail the unchanged graph validator before publication.
    expect(await app.run([invalid, null, invalid, null])).toBe(4);
    expect(app.requests[1]).toContain("PLAN_INVALID_SHAPE");
    expect(app.requests[1]).toContain("/plan/tasks/0/dependsOn");
    expect(app.handled()).toBe(0);
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(1);

    // Changing the error category does not reset the same intent's spent correction turn.
    expect(await app.run([{ ...publish, plan: { ...plan, extraField: true } }, null])).toBe(2);
    expect(
      await app.run([
        { ...publish, plan: { ...plan, tasks: [{ ...plan.tasks[0], agent: "unavailable" }] } },
        null,
      ]),
    ).toBe(2);
    expect(app.requests.at(-1)).toContain("/plan/tasks/0/agent");
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a successful publication before settle cancels the pending correction", async () => {
  const app = await leadFixture();
  try {
    // The ordinary tool follow-up may fix the body before the final actionable boundary.
    expect(
      await app.run([{ ...publish, review: { ...review, extraField: true } }, publish, null]),
    ).toBe(3);
    expect(app.handled()).toBe(1);
    expect(app.doc().artifacts["branch-plan"]!.revisions).toHaveLength(2);
    expect(await readFile(app.executor.sessionFile!, "utf8")).not.toContain(
      "radian.publication-correction",
    );
  } finally {
    await app.close();
  }
});

test("ordinary supervisors do not expose or accept the planning-only proposal action", () => {
  const tool = supervisorTool();
  expect(tool.parameters.properties.action).toMatchObject({ enum: ["progress", "ask"] });
  expect(() => tool.prepareArguments!({ action: "proposal", proposal: { plan, review } })).toThrow(
    "[TOOL_ACTION_UNKNOWN]",
  );
});
