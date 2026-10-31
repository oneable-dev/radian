import { expect, spyOn, test } from "bun:test";
import { ModelsError } from "@earendil-works/pi-ai";
import { CancelledError, StorageError, UsageError } from "../../errors.ts";
import { expectError, expectOk } from "../../testing/results.ts";
import { anthropicUsageResolver, parseAnthropicUsage } from "./anthropic.ts";

// Frozen, anonymized March 2026 response shape; no live credentials or inference requests.
// https://github.com/GooddyLife/claude-usage-monitor-plus/blob/main/docs/api-reference.md
const payload = Object.freeze({
  five_hour: Object.freeze({ utilization: 48, resets_at: "2026-03-02T11:00:00.521744+00:00" }),
  seven_day: Object.freeze({ utilization: 64, resets_at: "2026-03-06T06:00:00.521764+00:00" }),
  seven_day_sonnet: Object.freeze({
    utilization: 2,
    resets_at: "2026-03-06T07:00:00.521773+00:00",
  }),
  seven_day_opus: null,
});
const access = "sk-ant-oat01-fixture-a";
const auth = (token = access) => ({
  isUsingOAuth: () => true,
  getAuth: async () => ({ auth: { apiKey: token } }),
});
const signal = () => new AbortController().signal;

async function accountFor(fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  return expectOk(await anthropicUsageResolver(auth(), fetcher)("anthropic", signal()))!;
}

test("Overall Claude windows preserve percentages and microsecond ISO reset timestamps", () => {
  // The observed response also includes a model-specific bucket that must not replace overall usage.
  const input = payload;

  const windows = expectOk(parseAnthropicUsage(input));

  // Millisecond precision is sufficient for reset display without rescaling percentages.
  expect(windows).toEqual([
    {
      id: "five_hour",
      usedPercent: 48,
      periodMs: 18000000,
      resetsAt: Date.UTC(2026, 2, 2, 11, 0, 0, 521),
    },
    {
      id: "seven_day",
      usedPercent: 64,
      periodMs: 604800000,
      resetsAt: Date.UTC(2026, 2, 6, 6, 0, 0, 521),
    },
  ]);
});

test.each([
  { five_hour: null, seven_day: null },
  { five_hour: undefined, seven_day: null },
  { five_hour: { utilization: null, resets_at: null } },
  { seven_day: { resets_at: "2026-03-06T06:00:00Z" } },
  { five_hour: null, seven_day_sonnet: { utilization: 99 }, seven_day_opus: { utilization: 100 } },
])("Unknown overall windows stay unavailable instead of becoming zero: %j", (input) => {
  // Absent quotas or model-only allowances cannot establish the overall subscription balance.
  const value = Object.freeze(input);

  const windows = expectOk(parseAnthropicUsage(value));

  expect(windows).toEqual([]);
});

test("Measured zero and full utilization remain real windows with nullable resets", () => {
  // Unlike unavailable usage, measured zero and one hundred are both valid percentages.
  const input = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 100 },
  };

  const windows = expectOk(parseAnthropicUsage(input));

  expect(windows).toEqual([
    { id: "five_hour", usedPercent: 0, periodMs: 18000000, resetsAt: null },
    { id: "seven_day", usedPercent: 100, periodMs: 604800000, resetsAt: null },
  ]);
});

test.each(
  [
    null,
    [],
    {},
    { error: "unrelated response" },
    { five_hour: "wrong" },
    { five_hour: [] },
    { five_hour: { utilization: "48", resets_at: null } },
    { five_hour: { utilization: false, resets_at: null } },
    { five_hour: { utilization: -0.1, resets_at: null } },
    { five_hour: { utilization: 100.1, resets_at: null } },
    { five_hour: { utilization: NaN, resets_at: null } },
    { five_hour: { utilization: Infinity, resets_at: null } },
    { five_hour: { utilization: 1, resets_at: 0 } },
    { five_hour: { utilization: 1, resets_at: false } },
    { five_hour: { utilization: null, resets_at: 123 } },
    { seven_day: { utilization: 1, resets_at: "not a date" } },
    { seven_day: { utilization: 1, resets_at: "1970-01-01T00:00:00Z" } },
    { seven_day: { utilization: 1, resets_at: "1969-12-31T23:59:59Z" } },
    { seven_day: { utilization: 1, resets_at: "2026-02-30T12:00:00Z" } },
    { seven_day: { utilization: 1, resets_at: "2025-02-29T12:00:00Z" } },
    { seven_day: { utilization: 1, resets_at: "2026-03-02" } },
    { seven_day: { utilization: 1, resets_at: "2026-03-02T12:00:00" } },
    { seven_day: { utilization: 1, resets_at: "2026-03-02T12:00:00+24:00" } },
  ].map((input) => [input] as const),
)("Malformed quota percentages, dates, and unrelated response objects fail: %j", (input) => {
  // Protocol failures must not erase a previous valid balance by masquerading as empty usage.
  const value = Object.freeze({ value: input }).value;

  const failure = expectError(parseAnthropicUsage(value));

  expect(failure.code).toBe("USAGE_PROTOCOL_ERROR");
});

test("Leap days and timezone offsets resolve to the same absolute reset time", () => {
  // An ISO offset changes the timestamp, while the calendar date must still be valid.
  const input = { five_hour: { utilization: 0.5, resets_at: "2024-02-29T17:30:00+05:30" } };

  const windows = expectOk(parseAnthropicUsage(input));

  expect(windows[0]?.resetsAt).toBe(Date.UTC(2024, 1, 29, 12));
  expect(windows[0]?.usedPercent).toBe(0.5);
});

test("Claude OAuth uses only the fixed GET endpoint and explicit usage headers", async () => {
  // Auth-supplied headers, endpoints, and CLI identities are not trusted for quota requests.
  const requestSignal = signal();
  let fetched = 0;
  const resolver = anthropicUsageResolver(
    {
      isUsingOAuth: () => true,
      getAuth: async (provider, options) => {
        expect(provider).toBe("anthropic");
        expect(options.signal).toBe(requestSignal);

        return {
          auth: {
            apiKey: access,
            baseUrl: "https://untrusted.invalid",
            headers: { "User-Agent": "claude-cli/fixture", "x-api-key": "PRIVATE_FIXTURE" },
          },
        };
      },
    },
    async (url, options) => {
      fetched++;
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBe(requestSignal);
      expect(options.body).toBeUndefined();
      expect(Object.fromEntries(new Headers(options.headers))).toEqual({
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${access}`,
      });

      return Response.json(payload);
    },
  );

  const account = expectOk(await resolver("anthropic", requestSignal))!;
  const windows = expectOk(await account.load(requestSignal));

  expect(account.provider).toBe("anthropic");
  expect(account.minRefreshMs).toBe(300000);
  expect(fetched).toBe(1);
  expect(windows).toHaveLength(2);
  expect(JSON.stringify(windows)).not.toContain(access);
  expect(JSON.stringify(windows)).not.toContain(account.key);
});

test("Private fallback account fingerprints are stable per token and isolated across tokens", async () => {
  // With no account UUID in the usage payload, only a private, provider-scoped fingerprint is safe.
  const firstResolver = anthropicUsageResolver(auth());
  const secondResolver = anthropicUsageResolver(auth("sk-ant-oat01-fixture-b"));

  const first = expectOk(await firstResolver("anthropic", signal()))!;
  const repeated = expectOk(await firstResolver("anthropic", signal()))!;
  const second = expectOk(await secondResolver("anthropic", signal()))!;

  expect(first.key).toBe("a25a24b5f3d32368d8b820aaf62941c6b8d2625a2f01dd67d901c851235ac1da");
  expect(repeated.key).toBe(first.key);
  expect(second.key).not.toBe(first.key);
  expect(first.key).not.toContain(access);
});

test("API-key auth and non-Anthropic providers never resolve or send credentials", async () => {
  // Even an OAuth-shaped token must not bypass the runtime's actual auth method.
  let resolved = 0;
  let fetched = 0;
  const resolver = anthropicUsageResolver(
    {
      isUsingOAuth: () => false,
      getAuth: async () => {
        resolved++;

        return { auth: { apiKey: access } };
      },
    },
    async () => {
      fetched++;

      return Response.json(payload);
    },
  );
  const otherProvider = anthropicUsageResolver(auth());

  expect(expectOk(await resolver("anthropic", signal()))).toBeNull();
  expect(expectOk(await otherProvider("openai", signal()))).toBeNull();
  expect(expectOk(await otherProvider("openai-codex", signal()))).toBeNull();

  expect(resolved).toBe(0);
  expect(fetched).toBe(0);
});

test.each([
  "",
  "sk-ant-api03-fixture",
  "e30.openai.fixture",
  "opaque-other-provider-token",
  `${access}\r\nX: private`,
])("Missing, API-key, foreign, or unsafe tokens never reach Claude: %j", async (token) => {
  // The auth method can change between checking metadata and resolving request credentials.
  let fetched = 0;
  const resolver = anthropicUsageResolver(auth(token), async () => {
    fetched++;

    return Response.json(payload);
  });

  const failure = expectError(await resolver("anthropic", signal()));

  expect(failure.code).toBe("USAGE_AUTH_REQUIRED");
  expect(fetched).toBe(0);
});

test.each([
  [401, "USAGE_AUTH_REQUIRED"],
  [403, "USAGE_AUTH_REQUIRED"],
  [429, "USAGE_RATE_LIMITED"],
  [503, "USAGE_QUERY_FAILED"],
] as const)("HTTP %d produces %s without reading private error bodies", async (status, code) => {
  // Subscription failures must not include provider body text or trigger a new authentication lookup.
  let resolved = 0;
  const response = new Response("PRIVATE_PROVIDER_BODY", { status });
  const text = spyOn(response, "text");
  const resolver = anthropicUsageResolver(
    {
      isUsingOAuth: () => true,
      getAuth: async () => {
        resolved++;

        return { auth: { apiKey: access } };
      },
    },
    async () => response,
  );
  const account = expectOk(await resolver("anthropic", signal()))!;

  const failure = expectError(await account.load(signal()));

  expect(failure.code).toBe(code);
  expect(failure.message).not.toContain("PRIVATE_PROVIDER_BODY");
  expect(text).not.toHaveBeenCalled();
  expect(resolved).toBe(1);
});

test.each([
  [null, 300000],
  ["", 300000],
  ["0", 300000],
  ["-1", 300000],
  ["invalid", 300000],
  ["Infinity", 300000],
  ["999999999999999999999999", 300000],
  ["120", 120000],
  ["7200", 7200000],
  ["Wed, 21 Oct 2026 12:02:00 GMT", 120000],
  ["Wed, 21 Oct 2026 11:59:00 GMT", 300000],
] as const)(
  "Retry-After %j preserves its wait or conservatively defaults to %dms",
  async (header, wait) => {
    // Missing, zero, invalid, or elapsed server waits must not cause a rapid retry loop.
    const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 21, 12));
    try {
      const account = await accountFor(
        async () =>
          new Response(null, {
            status: 429,
            headers: header === null ? {} : { "retry-after": header },
          }),
      );

      const failure = expectError(await account.load(signal()));

      expect(failure).toBeInstanceOf(UsageError);
      expect(failure instanceof UsageError && failure.retryAfterMs).toBe(wait);
    } finally {
      now.mockRestore();
    }
  },
);

test.each(["not json", "x".repeat(131073)])(
  "Malformed or oversized responses are protocol failures",
  async (body) => {
    // A provider response cannot grow past the same accepted response limit as OpenAI.
    const account = await accountFor(async () => new Response(body));

    const failure = expectError(await account.load(signal()));

    expect(failure.code).toBe("USAGE_PROTOCOL_ERROR");
  },
);

test.each([
  new TypeError("network fixture"),
  Object.assign(new Error("fixture"), { code: "ECONNRESET" }),
])("Expected network failures retain typed errors instead of empty usage", async (error) => {
  // Only known transport failures are converted at the fetch boundary.
  const account = await accountFor(async () => {
    throw error;
  });

  const failure = expectError(await account.load(signal()));

  expect(failure.code).toBe("USAGE_QUERY_FAILED");
  expect(failure.cause).toBe(error);
});

test("Response read failures are typed while unexpected fetch and read defects retain identity", async () => {
  // A failed body read is an I/O boundary, but unrelated programming errors must still reject.
  const network = new Response("fixture");
  spyOn(network, "text").mockRejectedValue(new TypeError("read fixture"));
  const readDefect = new Error("read implementation defect");
  const broken = new Response("fixture");
  spyOn(broken, "text").mockRejectedValue(readDefect);
  const fetchDefect = new Error("fetch implementation defect");
  const networkAccount = await accountFor(async () => network);
  const readAccount = await accountFor(async () => broken);
  const fetchAccount = await accountFor(async () => {
    throw fetchDefect;
  });

  const failure = expectError(await networkAccount.load(signal()));

  expect(failure.code).toBe("USAGE_QUERY_FAILED");
  await expect(readAccount.load(signal())).rejects.toBe(readDefect);
  await expect(fetchAccount.load(signal())).rejects.toBe(fetchDefect);
});

test("Expected auth and cancellation failures remain typed but auth implementation defects reject", async () => {
  // SDK auth failures and known application errors are expected; a TypeError in auth is a defect.
  const defect = new TypeError("auth implementation defect");
  const storage = new StorageError("private storage fixture");
  const resolvers = [
    new ModelsError("auth", "fixture expired"),
    new ModelsError("oauth", "fixture expired"),
    storage,
    new CancelledError(),
  ].map((failure) =>
    anthropicUsageResolver({
      isUsingOAuth: () => true,
      getAuth: async () => {
        throw failure;
      },
    }),
  );
  const unexpected = anthropicUsageResolver({
    isUsingOAuth: () => true,
    getAuth: async () => {
      throw defect;
    },
  });

  const failures = await Promise.all(resolvers.map((resolver) => resolver("anthropic", signal())));

  expect(failures.map((result) => expectError(result).code)).toEqual([
    "USAGE_AUTH_REQUIRED",
    "USAGE_AUTH_REQUIRED",
    "STORAGE_FAILED",
    "CANCELLED",
  ]);
  expect(expectError(failures[2]!)).toBe(storage);
  await expect(unexpected("anthropic", signal())).rejects.toBe(defect);
});

test("Missing resolved authentication is not an empty usage success", async () => {
  // A logged-out account can disappear after its OAuth check succeeds.
  const resolver = anthropicUsageResolver({
    isUsingOAuth: () => true,
    getAuth: async () => undefined,
  });

  const failure = expectError(await resolver("anthropic", signal()));

  expect(failure.code).toBe("USAGE_AUTH_REQUIRED");
});

test("Pre-cancelled resolution and load never start authentication or HTTP requests", async () => {
  // Cancellation must stop work even when an injected transport would ignore the signal.
  const controller = new AbortController();
  controller.abort();
  let resolved = 0;
  let fetched = 0;
  const resolver = anthropicUsageResolver(
    {
      isUsingOAuth: () => true,
      getAuth: async () => {
        resolved++;
        return { auth: { apiKey: access } };
      },
    },
    async () => {
      fetched++;
      return Response.json(payload);
    },
  );
  const account = expectOk(await resolver("anthropic", signal()))!;

  const resolution = expectError(await resolver("anthropic", controller.signal));
  const load = expectError(await account.load(controller.signal));

  expect(resolution.code).toBe("CANCELLED");
  expect(load.code).toBe("CANCELLED");
  expect(resolved).toBe(1);
  expect(fetched).toBe(0);
});

test("Cancellation during auth or fetch cannot publish a completed result", async () => {
  // A late fulfilled transport response must be discarded before consuming its body.
  const authController = new AbortController();
  const authResolver = anthropicUsageResolver({
    isUsingOAuth: () => true,
    getAuth: async () => {
      authController.abort();
      return { auth: { apiKey: access } };
    },
  });
  const requestController = new AbortController();
  const response = Response.json(payload);
  const text = spyOn(response, "text");
  const account = await accountFor(async () => {
    requestController.abort();
    return response;
  });

  const authentication = expectError(await authResolver("anthropic", authController.signal));
  const request = expectError(await account.load(requestController.signal));

  expect(authentication.code).toBe("CANCELLED");
  expect(request.code).toBe("CANCELLED");
  expect(text).not.toHaveBeenCalled();
});

test("Fetch abort rejections are cancellation rather than network or protocol errors", async () => {
  // Browser-style AbortError is expected even if the transport aborts before the caller signal.
  const account = await accountFor(async () => {
    throw new DOMException("fixture", "AbortError");
  });

  const failure = expectError(await account.load(signal()));

  expect(failure.code).toBe("CANCELLED");
});
