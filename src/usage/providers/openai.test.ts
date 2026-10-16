import { expect, test } from "bun:test";
import { ModelsError } from "@earendil-works/pi-ai";
import { UsageError } from "../../errors.ts";
import { expectError, expectOk } from "../../testing/results.ts";
import { openAiUsageResolver, parseOpenAiUsage } from "./openai.ts";

const token = (account = "account-fixture") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
const payload = () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1800000000 }, secondary_window: null } });
const auth = (account = "account-fixture") => ({ isUsingOAuth: () => true, getAuth: async () => ({ auth: { apiKey: token(account) } }) });
const signal = () => new AbortController().signal;

test("primary에 있는 주간 한도도 기간·사용률·리셋 시각을 손실 없이 정규화한다", () => {
  // Current accounts may return only a weekly primary window, not a secondary window.
  const result = expectOk(parseOpenAiUsage(payload()));

  expect(result).toEqual([{ id: "primary", usedPercent: 10, periodMs: 604800000, resetsAt: 1800000000000 }]);
  expect(expectOk(parseOpenAiUsage({ rate_limit: null }))).toEqual([]);
});

test("손상된 사용률과 기간 및 리셋 값은 typed 프로토콜 오류로 반환한다", () => {
  const invalid = [null, {}, { rate_limit: "wrong" },
    { rate_limit: { primary_window: { used_percent: 101 } } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: NaN } } },
    { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 0 } } },
    { rate_limit: { primary_window: { used_percent: 10, reset_at: Number.MAX_VALUE } } }];

  for (const value of invalid) expect(expectError(parseOpenAiUsage(value)).code).toBe("USAGE_PROTOCOL_ERROR");
});

test("기존 OAuth로 고정 HTTPS endpoint만 읽고 인증·계정 식별자를 결과에 노출하지 않는다", async () => {
  let calls = 0;
  const resolver = openAiUsageResolver(auth(), async (url, options) => {
    calls++;
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage"); expect(options.method).toBe("GET"); expect(options.redirect).toBe("error");
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token()}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-fixture");
    return Response.json(payload());
  });

  const account = expectOk(await resolver("openai-codex", signal()))!;
  const result = expectOk(await account.load(signal()));

  expect(calls).toBe(1); expect(account.key).not.toContain("account-fixture");
  expect(JSON.stringify(result)).not.toContain(token()); expect(JSON.stringify(result)).not.toContain("account-fixture");
  const alias = expectOk(await resolver("openai", signal()))!;
  expect(alias.key).toBe(account.key);
});

test("API 키와 다른 제공자는 ChatGPT 계정 endpoint로 전송하지 않는다", async () => {
  let resolved = 0, fetched = 0;
  const resolver = openAiUsageResolver({ isUsingOAuth: () => false, getAuth: async () => { resolved++; return { auth: { apiKey: "sk-fixture" } }; } },
    async () => { fetched++; return Response.json(payload()); });

  expect(expectOk(await resolver("openai", signal()))).toBeNull();
  expect(expectOk(await resolver("anthropic", signal()))).toBeNull();

  expect(resolved).toBe(0); expect(fetched).toBe(0);
});

test("다른 OAuth 서비스의 토큰은 계정 헤더가 있어도 OpenAI에 보내지 않는다", async () => {
  let fetched = 0;
  const resolver = openAiUsageResolver({ isUsingOAuth: () => true,
    getAuth: async () => ({ auth: { apiKey: "opaque-other-provider-token", headers: { "ChatGPT-Account-Id": "account-fixture" } } }) },
    async () => { fetched++; return Response.json(payload()); });

  const result = await resolver("openai", signal());

  expect(expectError(result).code).toBe("USAGE_AUTH_REQUIRED"); expect(fetched).toBe(0);
});

for (const [status, code] of [[401, "USAGE_AUTH_REQUIRED"], [429, "USAGE_RATE_LIMITED"], [503, "USAGE_QUERY_FAILED"]] as const) {
  test(`HTTP ${status}는 ${code}로 구분하고 서버 응답 본문은 노출하지 않는다`, async () => {
    const resolver = openAiUsageResolver(auth(), async () => new Response("PRIVATE_PROVIDER_BODY", { status, headers: { "retry-after": "120" } }));
    const account = expectOk(await resolver("openai-codex", signal()))!;

    const failure = expectError(await account.load(signal()));

    expect(failure.code).toBe(code); expect(failure.message).not.toContain("PRIVATE_PROVIDER_BODY");
    if (status === 429) expect(failure instanceof UsageError && failure.retryAfterMs).toBe(120000);
  });
}

test("네트워크 실패와 잘못된 JSON을 빈 사용량 성공으로 바꾸지 않는다", async () => {
  const network = openAiUsageResolver(auth(), async () => { throw new TypeError("network fixture"); });
  const malformed = openAiUsageResolver(auth(), async () => new Response("not json"));
  const first = expectOk(await network("openai-codex", signal()))!;
  const second = expectOk(await malformed("openai-codex", signal()))!;

  expect(expectError(await first.load(signal())).code).toBe("USAGE_QUERY_FAILED");
  expect(expectError(await second.load(signal())).code).toBe("USAGE_PROTOCOL_ERROR");
});

test("SDK 인증 실패만 분류하고 예상하지 못한 SDK 결함은 원래 예외로 남긴다", async () => {
  const defect = new TypeError("auth implementation defect");
  const expected = openAiUsageResolver({ isUsingOAuth: () => true, getAuth: async () => { throw new ModelsError("oauth", "fixture expired"); } });
  const unexpected = openAiUsageResolver({ isUsingOAuth: () => true, getAuth: async () => { throw defect; } });

  expect(expectError(await expected("openai-codex", signal())).code).toBe("USAGE_AUTH_REQUIRED");
  await expect(unexpected("openai-codex", signal())).rejects.toBe(defect);
});
