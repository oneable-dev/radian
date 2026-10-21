import { expect, test } from "bun:test";
import { DashboardAccumulator, dashboardDate, emptyDashboard, mergeDashboards } from "./dashboard.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

const now = new Date(2026, 2, 22, 12).getTime();
const entry = (id: string, fields: Record<string, unknown>, timestamp = now - 1000) => ({ id, parentId: null, timestamp: new Date(timestamp).toISOString(), ...fields });
const message = (id: string, fields: Record<string, unknown>, timestamp?: number) => entry(id, { type: "message", message: { timestamp: timestamp ?? now - 1000, ...fields } }, timestamp);
const usage = { input: 100, output: 20, cacheRead: 80, cacheWrite: 10, reasoning: 15, cacheWrite1h: 5, totalTokens: 210 };
const assistant = (id: string, content: unknown[] = []) => message(id, { role: "assistant", provider: "test", model: "large", usage, content });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

test("기간별 토큰은 캐시를 포함하되 reasoning과 컨텍스트 크기를 중복 가산하지 않는다", () => {
  // 요약·캐시 워밍도 별도 모델 사용량이며 tokensBefore는 소비량이 아니다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [assistant("answer"), entry("compact", { type: "compaction", tokensBefore: 90000, usage }),
    entry("warm", { type: "usage", provider: "test", model: "small", usage })];

  // 실제 기록된 세 종류의 모델 사용량을 집계한다.
  for (const value of entries) expectOk(accumulator.add(value));
  const result = accumulator.finish();

  // 입력·출력·캐시 합계 210이 각각 한 번씩 반영된다.
  expect(result.totals.tokens).toBe(630); expect(result.daily.at(-1)?.tokens).toBe(630);
  expect(result.models).toEqual([{ name: "test/large", value: 420 }, { name: "test/small", value: 210 }]);
});

test("기록된 실행은 완료 시점에 집계하고 오류·중단도 횟수와 실제 소요 시간을 유지한다", () => {
  // 프롬프트나 도구 호출 수를 실행 횟수로 오인하지 않도록 완료 메타데이터만 준비한다.
  const accumulator = new DashboardAccumulator(1, "/repo", now);
  for (const [index, outcome] of ["complete", "error", "cancelled"].entries()) expectOk(accumulator.add(entry(`run-${index}`, {
    type: "custom", customType: runCompletionEntryType, data: { startedAt: now - 6000, completedAt: now - 1000, durationMs: 5000, outcome },
  })));

  // 같은 날짜의 서로 다른 종료 결과를 합산한다.
  const result = accumulator.finish();

  // 정상 종료 여부와 무관하게 실제 수행한 실행 세 번과 누적 시간을 표시한다.
  expect(result.totals).toEqual({ tokens: 0, runs: 3, durationMs: 15000 });
  expect(result.daily).toEqual([{ date: dashboardDate(now), tokens: 0, runs: 3, durationMs: 15000 }]);
});

test("명시 호출과 성공한 스킬 읽기는 합산하고 실패하거나 일반 문서인 SKILL.md는 제외한다", () => {
  // 스킬 목록과 명시 호출이 있어도 일반 파일 읽기나 실패를 스킬 로드로 세면 안 된다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [message("system", { role: "system", sections: { skills: "<skill>\n<name>good-code</name>\n<description>Code</description>\n<location>/skills/good/SKILL.md</location>\n</skill>" } }),
    message("explicit", { role: "user", content: '<skill name="good-code" location="/skills/good/SKILL.md">\nInstructions\n</skill>' }),
    assistant("read-calls", [call("good", "read", { path: "/skills/good/SKILL.md" }), call("failed", "read", { path: "/skills/good/SKILL.md" }), call("ordinary", "read", { path: "/repo/SKILL.md" }), call("discovered", "read", { path: "/skills/review/SKILL.md" })]),
    message("good-result", { role: "toolResult", toolCallId: "good", content: [{ type: "text", text: "Partial known instructions" }], isError: false }),
    message("failed-result", { role: "toolResult", toolCallId: "failed", content: [], isError: true }),
    message("ordinary-result", { role: "toolResult", toolCallId: "ordinary", content: [{ type: "text", text: "An ordinary file" }], isError: false }),
    message("discovered-result", { role: "toolResult", toolCallId: "discovered", content: [{ type: "text", text: "---\nname: review-code\ndescription: Review\n---\nInstructions" }], isError: false })];

  // 두 호출 경로를 같은 스킬 이름으로 묶는다.
  for (const value of entries) expectOk(accumulator.add(value));
  const result = accumulator.finish();

  // UI에는 출처 구분 없이 합계만 전달한다.
  expect(result.skills).toEqual([{ name: "good-code", value: 2 }, { name: "review-code", value: 1 }]);
});

test("MCP는 게이트웨이와 중첩 호출을 중복 집계하지 않고 subagent 관리 조회는 제외한다", () => {
  // 스크립트 내부 호출은 코드 문자열이 아니라 실제 저장된 nestedCalls로 관측한다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [assistant("calls", [call("native", "mcp__figma_remote__get_design", {}), call("gateway", "mcp", { tool: "mcp__atlassian__issue" }),
    call("worker", "radian_subagent", { name: "reviewer", task: "review" }), call("inspect", "subagent", { action: "status", agent: "reviewer" }), call("single", "subagent", { agent: "implementer", task: "build" })]),
    message("native-result", { role: "toolResult", toolCallId: "native", details: { server: "figma-remote", tool: "get_design" }, content: [] }),
    message("gateway-result", { role: "toolResult", toolCallId: "gateway", nestedCalls: { complete: true, calls: [
      { id: "n1", name: "mcp__atlassian__issue", status: "ok" }, { id: "n2", name: "mcp__atlassian__search", status: "error" },
    ] }, content: [] })];

  // 실제 하위 도구 호출 두 번과 직접 호출 한 번을 기록한다.
  for (const value of entries) expectOk(accumulator.add(value));
  const result = accumulator.finish();

  // 서버 호출 수는 토큰과 별도 단위이고 관리 요청은 실행 횟수가 아니다.
  expect(result.mcp).toEqual([{ name: "atlassian", value: 2 }, { name: "figma-remote", value: 1 }]);
  expect(result.subagents).toEqual([{ name: "implementer", value: 1 }, { name: "reviewer", value: 1 }]);
});

test("포크가 복사한 공통 기록은 한 번만 집계하고 새 기록은 추가한다", () => {
  // SDK 포크는 과거 엔트리의 ID와 timestamp를 그대로 복사한다.
  const original = new DashboardAccumulator(7, "/repo", now);
  expectOk(original.add(assistant("shared")));
  const fork = new DashboardAccumulator(7, "/repo", now, original.identities);

  // 포크에서도 과거 문맥은 읽지만 토큰은 새 응답만 늘어난다.
  expectOk(fork.add(assistant("shared"))); expectOk(fork.add(assistant("new")));
  const result = mergeDashboards([original.finish(), fork.finish()], 7, now);

  // 컨텍스트 복사를 새 모델 소비로 보지 않는다.
  expect(result.totals.tokens).toBe(420); expect(result.models).toEqual([{ name: "test/large", value: 420 }]);
});

test("로컬 날짜 경계 밖과 미래 기록은 제외하고 활동이 없는 날짜도 그래프에 남긴다", () => {
  // 오늘 자정 이전과 현재 시각 이후 기록을 별도로 준비한다.
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const accumulator = new DashboardAccumulator(1, "/repo", now);
  const fields = { role: "assistant", provider: "test", model: "large", usage, content: [] };

  // 범위의 양 끝을 포함 여부에 맞춰 집계한다.
  expectOk(accumulator.add(message("old", fields, start.getTime() - 1)));
  expectOk(accumulator.add(message("boundary", fields, start.getTime())));
  expectOk(accumulator.add(message("future", fields, now + 1)));

  // 날짜별 버킷은 비어도 보존하고 경계에 속한 소비만 표시한다.
  expect(accumulator.finish().totals.tokens).toBe(210);
  expect(emptyDashboard(30, now).daily).toHaveLength(30);
  expect(emptyDashboard(7, now).totals).toEqual({ tokens: 0, runs: 0, durationMs: 0 });
});

test("저장된 workflow 자식 결과는 실제 에이전트별로 집계하고 메타데이터 없는 실행은 경고한다", () => {
  // 실행 스크립트 문자열을 분석해 에이전트 호출을 추측하지 않는다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [assistant("workflow-calls", [call("workflow", "subagent", { workflowScript: "opaque script" }), call("opaque", "subagent", { workflow: "named" }), call("script", "mcpScript", { code: "opaque script" })]),
    message("workflow-result", { role: "toolResult", toolCallId: "workflow", details: { mode: "workflow", results: [
      { agent: "reviewer", runId: "one" }, { agent: "reviewer", runId: "two" }, { agent: "reviewer", runId: "one" }, { agent: "implementer", runId: "three" },
    ] }, content: [] }),
    message("opaque-result", { role: "toolResult", toolCallId: "opaque", details: {}, content: [] }),
    message("script-result", { role: "toolResult", toolCallId: "script", content: [] })];

  // 관측 가능한 자식 실행만 합산하고 동일 runId는 한 번만 센다.
  for (const value of entries) expectOk(accumulator.add(value));
  const result = accumulator.finish();

  // 데이터 부재는 사용하지 않았다는 0과 구분해 화면에 전달한다.
  expect(result.subagents).toEqual([{ name: "reviewer", value: 2 }, { name: "implementer", value: 1 }]);
  expect(result.warnings).toEqual(["Some subagent workflows lack stored child metadata and are excluded.", "Some scripted MCP calls lack stored server metadata and are excluded."]);
});

test("도구가 보고한 중첩 모델 소비량은 현재 모델로 오인하지 않고 미귀속 토큰으로 보존한다", () => {
  // 도구 안의 별도 모델 호출에는 부모 모델의 신원을 임의로 붙이지 않는다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);

  // SDK의 toolResult usage도 전체 소비에 포함한다.
  expectOk(accumulator.add(message("nested-usage", { role: "toolResult", toolCallId: "nested", usage, content: [] })));
  const result = accumulator.finish();

  // 집계에서 누락하지 않되 모델별 추론을 하지 않는다.
  expect(result.totals.tokens).toBe(210); expect(result.models).toEqual([{ name: "Tool work (unattributed)", value: 210 }]);
});

test("잘못된 소비량을 0으로 숨기지 않고 안정적인 기록 오류를 반환한다", () => {
  // 음수나 누락 토큰은 정상적인 빈 통계가 아니다.
  const accumulator = new DashboardAccumulator(7, "/repo", now);

  // 외부 저장 데이터의 잘못된 usage를 공개 집계 경계에 전달한다.
  const result = accumulator.add(message("bad", { role: "assistant", content: [], usage: { ...usage, input: -1 } }));

  // 호출자가 부분 집계 경고를 표시할 수 있는 명시적 오류다.
  expect(expectError(result).code).toBe("HISTORY_CORRUPT");
});
