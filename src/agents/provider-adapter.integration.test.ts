import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import type { SessionExecutor } from "./session-registry.ts";

const canonicalOrigin = "https://api.anthropic.com";
const fastBeta = "fast-mode-2026-02-01";
const extensionBeta = "fixture-extension-2026-01-01";
const apiKey = "sk-ant-api03-offline-provider-adapter-fixture";
const oauthToken = "sk-ant-oat01-offline-provider-adapter-fixture";

type Reply = {
  startSpeed?: unknown;
  deltaSpeed?: unknown;
  status?: 400 | 429;
};
type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown> };
type FixtureOptions = {
  id?: string;
  provider?: string;
  api?: Api;
  baseUrl?: string;
  credential?: string;
  extension?: boolean;
  replies?: Reply[];
};

function streamedReply(model: string, reply: Reply): Response {
  if (reply.status) {
    return Response.json(
      {
        type: "error",
        error: {
          type: reply.status === 429 ? "rate_limit_error" : "invalid_request_error",
          message: "Offline Fast request rejected.",
        },
      },
      { status: reply.status },
    );
  }

  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_offline_adapter",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0, speed: reply.startSpeed },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Offline reply." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3, speed: reply.deltaSpeed },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function isMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

async function fixture(config: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "radian-provider-adapter-"));
  let executor: SessionExecutor | undefined;
  try {
    const options = await offlineRuntime(join(directory, "agent"));
    const runtime = options.modelRuntime!;
    const provider = config.provider ?? "anthropic";
    const id = config.id ?? "claude-opus-5";
    const credential = config.credential ?? apiKey;
    runtime.registerProvider(provider, {
      api: config.api ?? "anthropic-messages",
      baseUrl: config.baseUrl ?? canonicalOrigin,
      apiKey: credential,
      models: [
        {
          id,
          name: id,
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    options.model = runtime.getModel(provider, id)!;
    options.settings = { defaultThinkingLevel: "high" };

    if (config.extension) {
      const extensions = join(options.agentDir!, "extensions");
      await mkdir(extensions, { recursive: true });
      await writeFile(
        join(extensions, "payload-fixture.ts"),
        `export default function (pi) {
          pi.on("before_provider_request", (event) => ({
            ...event.payload,
            metadata: { user_id: "offline-extension" },
            betas: [...(event.payload.betas ?? []), "${extensionBeta}"],
            speed: "fast",
          }));
          pi.on("after_provider_response", (_event, ctx) => {
            ctx.ui.notify("fixture response", "info");
          });
          pi.on("provider_stream_event", (event, ctx) => {
            if (["message_start", "message_delta"].includes(event.data?.type)) {
              ctx.ui.notify("fixture " + event.data.type, "info");
            }
          });
        }`,
      );
    }

    const requests: CapturedRequest[] = [];
    let modelCalls = 0;
    // The native encoder sees the canonical URL, but this fetch never delegates to a network.
    const fetcher = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body: unknown = init?.body
          ? JSON.parse(await new Response(init.body).text())
          : input instanceof Request
            ? await input.json()
            : null;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new TypeError("Expected an encoded Messages request object.");
        }
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          headers: new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          ),
          body: body as Record<string, unknown>,
        });
        const reply = config.replies?.[requests.length - 1] ?? {};

        return streamedReply(id, reply);
      },
      {
        preconnect: () => {
          throw new Error("Unexpected fixture network preconnect.");
        },
      },
    );
    options.streamFn = (model, context, request) => {
      modelCalls++;
      if (!isMessagesModel(model)) {
        throw new Error("Only the native Messages encoder may run in this fixture.");
      }

      return streamSimple(model, context, {
        ...request,
        apiKey: credential,
        fetch: fetcher,
        maxRetries: 0,
      });
    };
    executor = await piSessionFactory(options)({
      cwd: directory,
      role: "main",
      isUiActive: () => true,
      spawnSubagent: async () => {
        throw new Error("Unexpected fixture delegation.");
      },
    });
    const opened = executor;

    return {
      executor: opened,
      requests,
      model: options.model,
      modelCalls: () => modelCalls,
      async close() {
        try {
          expectOk(await opened.close());
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await executor?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function betas(request: CapturedRequest): string[] {
  return (request.headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

test("Native Anthropic Fast commands change only request preference without starting model calls", async () => {
  // A new SDK conversation has no confirmed execution speed or explicit Fast opt-in.
  const app = await fixture();
  try {
    expect(app.executor.state.telemetry).toMatchObject({
      fast: false,
      fastObserved: null,
      effort: "high",
    });
    const sections = app.executor.state.sections;

    // Status is read-only, and both toggles must remain command-only before the first turn.
    for (const [command, enabled] of [
      ["status", false],
      ["on", true],
      ["status", true],
      ["off", false],
      ["status", false],
    ] as const) {
      expectOk(await app.executor.prompt(`/fast ${command}`));
      expect(app.executor.state.telemetry).toMatchObject({
        fast: enabled,
        fastObserved: null,
        effort: "high",
      });
      expect(app.executor.state.status).toBeNull();
    }

    // No command is converted into a prompt, a conversation message, or a transport probe.
    expect(app.modelCalls()).toBe(0);
    expect(app.requests).toHaveLength(0);
    expect(app.executor.state.sections).toEqual(sections);
    expect(app.executor.state.runTiming).toBeUndefined();
  } finally {
    await app.close();
  }
});

test.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])(
  "The native encoder serializes Fast on/off for %s without changing thinking or extension fields",
  async (id) => {
    // OAuth and an extension supply existing betas that Radian must not replace.
    const app = await fixture({ id, credential: oauthToken, extension: true });
    try {
      expectOk(await app.executor.prompt("/fast on"));

      // Both requests pass through the real Messages encoder; explicit off overrides extension Fast.
      expectOk(await app.executor.prompt("Encode the Fast request."));
      expectOk(await app.executor.prompt("/fast off"));
      expectOk(await app.executor.prompt("Encode the standard request."));

      // The SDK moves betas out of the JSON body and merges the legacy Fast beta only where required.
      expect(app.model.baseUrl).toBe(canonicalOrigin);
      expect(app.requests).toHaveLength(2);
      const [on, off] = app.requests as [CapturedRequest, CapturedRequest];
      for (const request of [on, off]) {
        expect(request.url).toBe(`${canonicalOrigin}/v1/messages?beta=true`);
        expect(request.headers.get("authorization")).toBe(`Bearer ${oauthToken}`);
        expect(request.body).not.toHaveProperty("betas");
        expect(request.body.metadata).toEqual({ user_id: "offline-extension" });
        expect(betas(request)).toContain("oauth-2025-04-20");
        expect(betas(request)).toContain("claude-code-20250219");
        expect(betas(request)).toContain(extensionBeta);
      }
      expect(on.body.speed).toBe("fast");
      expect(off.body).not.toHaveProperty("speed");
      expect(betas(on).filter((beta) => beta === fastBeta)).toHaveLength(
        id === "claude-opus-5-5" ? 0 : 1,
      );
      expect(betas(off)).not.toContain(fastBeta);
      expect(on.body.thinking).toMatchObject({ type: "enabled" });
      expect(off.body.thinking).toEqual(on.body.thinking);
      expect(off.body.output_config).toEqual(on.body.output_config);
      expect(app.executor.state.telemetry).toMatchObject({
        fast: false,
        fastObserved: null,
        effort: "high",
      });
      expect(app.executor.state.finalOutput).toBe("Offline reply.");
      const notices = app.executor.extensionUi!.notifications.map(({ message }) => message);
      for (const message of [
        "fixture response",
        "fixture message_start",
        "fixture message_delta",
      ]) {
        expect(notices.filter((notice) => notice === message)).toHaveLength(2);
      }
    } finally {
      await app.close();
    }
  },
);

test.each([
  {
    name: "fast to standard",
    startSpeed: "fast",
    deltaSpeed: "standard",
    initial: true,
    final: false,
  },
  {
    name: "standard to fast",
    startSpeed: "standard",
    deltaSpeed: "fast",
    initial: false,
    final: true,
  },
  {
    name: "fast to omitted speed",
    startSpeed: "fast",
    deltaSpeed: undefined,
    initial: true,
    final: true,
  },
  {
    name: "fast to explicit null",
    startSpeed: "fast",
    deltaSpeed: null,
    initial: true,
    final: null,
  },
  {
    name: "fast to malformed",
    startSpeed: "fast",
    deltaSpeed: "unexpected",
    initial: true,
    final: null,
  },
])(
  "Provider-confirmed speeds $name update observations without changing the Fast preference",
  async ({ startSpeed, deltaSpeed, initial, final }) => {
    // Raw message_start and message_delta metadata can disagree with the requested speed.
    const app = await fixture({ replies: [{ startSpeed, deltaSpeed }] });
    const observations: (boolean | null | undefined)[] = [];
    const unsubscribe = app.executor.subscribe(() =>
      observations.push(app.executor.state.telemetry?.fastObserved),
    );
    try {
      expectOk(await app.executor.prompt("/fast on"));

      // Consume the actual SSE event parser and its provider-event hooks.
      expectOk(await app.executor.prompt("Observe the confirmed execution speed."));

      // Token-only deltas preserve confirmation; explicit unknown speed clears it.
      expect(observations).toContain(initial);
      expect(app.executor.state.telemetry).toMatchObject({ fast: true, fastObserved: final });
      expect(app.requests).toHaveLength(1);
      expect(app.requests[0]!.body.speed).toBe("fast");
      expect(app.requests[0]!.headers.get("x-api-key")).toBe(apiKey);
      expect(app.executor.state.status).toBe("complete");
    } finally {
      unsubscribe();
      await app.close();
    }
  },
);

test("A confirmed Fast response cannot override an explicit standard-speed preference", async () => {
  // Confirmation describes execution, not permission to enable premium requests.
  const app = await fixture({ replies: [{ startSpeed: "fast", deltaSpeed: "fast" }] });
  try {
    expectOk(await app.executor.prompt("/fast off"));

    // A provider can report Fast even though this request deliberately omitted speed.
    expectOk(await app.executor.prompt("Keep the explicit standard preference."));

    // Request choice and confirmed execution remain separate, including after status reads.
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]!.body).not.toHaveProperty("speed");
    expect(app.executor.state.telemetry).toMatchObject({ fast: false, fastObserved: true });
    expectOk(await app.executor.prompt("/fast status"));
    expect(app.executor.state.telemetry).toMatchObject({ fast: false, fastObserved: true });
    expect(app.modelCalls()).toBe(1);
  } finally {
    await app.close();
  }
});

test.each([400, 429] as const)(
  "A native %i rejection leaves execution unknown and the explicit Fast preference on without retries",
  async (status) => {
    // Rejection after a previously confirmed Fast turn must not retain stale confirmation.
    const app = await fixture({
      replies: [{ startSpeed: "fast", deltaSpeed: "fast" }, { status }],
    });
    try {
      expectOk(await app.executor.prompt("/fast on"));
      expectOk(await app.executor.prompt("Confirm the first turn."));
      expect(app.executor.state.telemetry?.fastObserved).toBe(true);

      // A deterministic API error reaches the SDK with native retries explicitly disabled.
      const rejected = expectError(await app.executor.prompt("Reject the next Fast request."));

      // Failure is visible while the user's next-request preference remains accepted.
      expect(rejected.code).toBe("AGENT_FAILED");
      expect(app.requests).toHaveLength(2);
      expect(app.modelCalls()).toBe(2);
      expect(app.requests[1]!.body.speed).toBe("fast");
      expect(app.executor.state.status).toBe("failure");
      expect(app.executor.state.error).toContain("Offline Fast request rejected.");
      expect(app.executor.state.telemetry).toMatchObject({ fast: true, fastObserved: null });
      expectOk(await app.executor.prompt("/fast status"));
      expect(app.requests).toHaveLength(2);
      expect(app.executor.state.telemetry?.fast).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test.each([
  { id: "claude-opus-4-6" },
  { id: "claude-opus-4-7" },
  { id: "claude-opus-5-5-preview" },
  { provider: "anthropic-gateway" },
  { baseUrl: "https://gateway.example.test/anthropic" },
  { baseUrl: "http://api.anthropic.com" },
  { provider: "claude-code", api: "claude-code-stream-json" },
])("Unsupported model routes reject Fast toggles without any model call: %j", async (route) => {
  // Branding, a compatible API, or an Opus prefix does not grant native Fast support.
  const app = await fixture(route);
  try {
    // Command rejection happens before credential resolution or model transport invocation.
    for (const action of ["on", "off"]) {
      const rejected = expectError(await app.executor.prompt(`/fast ${action}`));
      expect(rejected.message).toContain("Fast requests are not supported");
    }

    // The unsupported connection stays unknown and never receives an inference request.
    expect(app.executor.state.telemetry?.fast).toBeNull();
    expect(app.executor.state.telemetry?.fastObserved).toBeNull();
    expect(app.modelCalls()).toBe(0);
    expect(app.requests).toHaveLength(0);
  } finally {
    await app.close();
  }
});
