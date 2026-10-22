import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "../app/ui/workbench.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { accountsCommand, type AccountReply, type AccountRequest, type AccountsCatalog, type LoginView } from "./model.ts";
import { BrowserError, CancelledError, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const catalog: AccountsCatalog = { revision: 1, worktreeId: "", selections: {}, accounts: [{ id: "named", provider: "fixture", label: "Personal", type: "api_key", usedBy: [] }],
  providers: [{ id: "fixture", name: "Fixture", methods: [{ id: "api_key", name: "API key" }, { id: "oauth", name: "OAuth" }] }] };
async function mount(overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], requests: AccountRequest[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {},
    onPrompt: async (_id, text) => { sent.push(text); return ok(undefined); }, onComplete: async () => ok({ items: [accountsCommand], truncated: false }),
    onAccountsRequest: async request => { requests.push(request); return ok({ kind: "catalog", catalog: { ...structuredClone(catalog), worktreeId: request.worktreeId } }); }, ...overrides });
  const get = (id: string) => { const item = app.renderer.root.findDescendantById(id); if (!item) throw new Error(`Missing ${id}`); return item; };
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const prompt = get("session-prompt") as InputRenderable; await render(); prompt.focus();
  return { ...app, view, clock, selection, requests, sent, get, prompt, render,
    async open(text = "/accounts") { await app.mockInput.typeText(text); await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("accounts 명령은 네이티브 팝업을 열고 모델 프롬프트 없이 현재 작업 공간의 선택을 변경한다", async () => {
  // 공용 계정 목록은 선택 전에도 보이며 명령 자동완성을 제공한다.
  const app = await mount();
  try {
    // 검색으로 이름 있는 계정을 고르면 현재 작업 공간을 대상으로만 변경한다.
    await app.open("/acc"); expect(app.get("accounts-picker").visible).toBe(true);
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("Personal"); await app.render(); app.mockInput.pressEnter(); await app.render();

    // 명령과 계정 선택은 모델 입력이나 대화 교체를 만들지 않는다.
    expect(app.requests.find(request => request.type === "select")).toEqual({ type: "select", worktreeId: app.selection.worktree!.id, provider: "fixture", accountId: "named", revision: 1 });
    expect(app.sent).toEqual([]); expect(app.prompt.value).toBe("");
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally { await app.close(); }
});

test("계정 검색은 Ctrl+N/P와 반 페이지 이동을 지원하고 검색어·커서를 보존한다", async () => {
  // 한 화면보다 많은 계정을 준비해 검색 입력과 결과 목록 사이 탐색을 검증한다.
  const many = { ...catalog, accounts: Array.from({ length: 60 }, (_, i) => ({ ...catalog.accounts[0]!, id: `account-${i}`, label: `Account ${i}` })) };
  const calls: AccountRequest[] = [];
  const app = await mount({ onAccountsRequest: async request => { calls.push(request); return ok({ kind: "catalog", catalog: { ...many, worktreeId: request.worktreeId } }); } });
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("Account"); await app.render();
    const search = app.get("accounts-search") as InputRenderable, caret = search.cursorOffset;

    // 입력 포커스에서 후보를 옮기고 반 페이지 이동으로 결과 포커스에 인계한다.
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-list"); expect(search.value).toBe("Account"); expect(search.cursorOffset).toBe(caret);
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("k"); app.mockInput.pressEnter(); await app.render();

    // 후보 단위로 이동하며 다음 요청은 첫 후보 이후의 계정을 선택한다.
    const selected = calls.find(request => request.type === "select"); expect(selected?.type).toBe("select");
    if (selected?.type === "select") expect(selected.accountId).not.toBe("account-0");
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("빈 계정 검색의 Ctrl+C는 팝업을 닫지 않고 h/j/k/l을 입력 문자로 유지한다", async () => {
  // 검색 지우기와 일반 입력은 계정 동작이나 앱 종료를 호출하지 않아야 한다.
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render();
    app.mockInput.pressKey("c", { ctrl: true }); await app.mockInput.typeText("hjkl"); await app.render();
    expect((app.get("accounts-search") as InputRenderable).value).toBe("hjkl");

    // 검색만 지우며 Ctrl+L은 지우기 별칭으로 사용하지 않는다.
    app.mockInput.pressKey("l", { ctrl: true }); await app.render(); expect((app.get("accounts-search") as InputRenderable).value).toBe("hjkl");
    app.mockInput.pressKey("c", { ctrl: true }); await app.render(); expect((app.get("accounts-search") as InputRenderable).value).toBe("");
    expect(app.get("accounts-picker").visible).toBe(true); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("API 키 입력은 화면·대화 초안에 평문을 남기지 않고 SDK 입력 요청에만 전달한다", async () => {
  // 로그인 응답의 secret 요청과 상태 조회는 실제 서버 경계 대신 제한된 작업 응답을 쓴다.
  const calls: AccountRequest[] = [], waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const flow: LoginView = { id: "flow", revision: 1, status: "pending", events: [], prompt: { id: "secret", type: "secret", message: "Enter API key" } };
  const app = await mount({ onAccountsRequest: async (request, signal) => {
    calls.push(request);
    if (request.type === "login") return ok({ kind: "login", login: structuredClone(flow) });
    if (request.type === "poll") { signal?.addEventListener("abort", () => waiting.resolve(err(new CancelledError())), { once: true }); return waiting.promise; }
    if (request.type === "answer") return ok({ kind: "login" as const, login: { ...flow, status: "complete" as const, revision: 2, account: catalog.accounts[0]! } });
    return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
  } });
  try {
    // 추가, 제공자, API 키 방식을 고른 뒤 기본 라벨을 사용한다.
    await app.open(); for (let i = 0; i < 4; i++) { app.mockInput.pressEnter(); await app.render(); }
    expect(app.renderer.currentFocusedRenderable?.id).toBe("accounts-secret"); await app.mockInput.typeText("sk-private-key"); await app.render();

    // 실제 키 대신 마스크만 출력하고 Enter로 로그인 작업에만 전송한다.
    expect(app.captureCharFrame()).not.toContain("sk-private-key"); expect(app.captureCharFrame()).toContain("•••");
    app.mockInput.pressEnter(); await app.render(); expect(calls.find(request => request.type === "answer")).toMatchObject({ value: "sk-private-key", promptId: "secret" });
    expect(JSON.stringify(app.view.promptDrafts)).not.toContain("sk-private-key"); expect(app.sent).toEqual([]);
    // 완료 이후 늦게 도착한 이전 poll은 비밀 입력창을 다시 열면 안 된다.
    waiting.resolve(ok({ kind: "login", login: flow })); await app.render();
    expect(app.get("accounts-secret").visible).toBe(false); expect(app.captureCharFrame()).not.toContain("Enter API key");
  } finally { waiting.resolve(err(new CancelledError())); await app.close(); }
});

test("OAuth 브라우저 자동 열기가 실패해도 URL과 기기 코드를 표시하고 복사·취소를 제공한다", async () => {
  // 자동 열기 실패와 수동 인증을 위한 URL·코드를 제공한다.
  const calls: AccountRequest[] = [], opened: string[] = [], copied: string[] = [], waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>();
  const flow: LoginView = { id: "oauth", revision: 1, status: "pending", events: [{ message: "Open the URL", url: "https://example.test/device", code: "ABCD-EFGH" }] };
  const app = await mount({ onOpenLoginUrl: async url => { opened.push(url); return err(new BrowserError("Copy the login URL and open it manually.")); },
    onCopyTranscript: async text => { copied.push(text); return ok("Copied"); }, onAccountsRequest: async (request, signal) => {
      calls.push(request);
      if (request.type === "login") return ok({ kind: "login", login: flow });
      if (request.type === "poll") { signal?.addEventListener("abort", () => waiting.resolve(err(new CancelledError())), { once: true }); return waiting.promise; }
      return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
    } });
  try {
    await app.open(); app.mockInput.pressEnter(); await app.render(); app.mockInput.pressEnter(); await app.render();
    app.mockInput.pressKey("j"); app.mockInput.pressEnter(); await app.render(); app.mockInput.pressEnter(); await app.render();

    // URL은 자동 열기 성공 여부와 관계없이 화면에 남아 수동 인증할 수 있다.
    expect(opened).toEqual(["https://example.test/device"]); expect(app.captureCharFrame()).toContain("https://example.test/device"); expect(app.captureCharFrame()).toContain("ABCD-EFGH");
    const copy = app.get("accounts-copy-url"); await app.mockMouse.click(copy.x + 1, copy.y); await app.render(); expect(copied).toEqual(["https://example.test/device"]);
    app.mockInput.pressEscape(); await app.render(); expect(calls.some(request => request.type === "cancel" && request.flowId === "oauth")).toBe(true);
    expect(app.captureCharFrame()).not.toContain("ABCD-EFGH"); expect(app.sent).toEqual([]);
  } finally { waiting.resolve(err(new CancelledError())); await app.close(); }
});

test("로그인 시작 응답 전 창을 닫으면 늦은 응답의 로그인 작업을 취소하고 팝업을 다시 열지 않는다", async () => {
  // 로그인 시작 요청은 이미 전송됐으므로 응답의 작업 ID를 받은 뒤에도 취소해야 한다.
  const waiting = Promise.withResolvers<Result<AccountReply, ExpectedError>>(), calls: AccountRequest[] = [];
  const app = await mount({ onAccountsRequest: async request => {
    calls.push(request); if (request.type === "login") return waiting.promise;
    return ok({ kind: "catalog", catalog: { ...catalog, worktreeId: request.worktreeId } });
  } });
  try {
    await app.open(); for (let i = 0; i < 4; i++) { app.mockInput.pressEnter(); await app.render(); }

    // 작업 ID를 아직 모르는 상태에서 닫은 후 늦은 시작 응답이 도착한다.
    app.mockInput.pressEscape(); await app.render();
    waiting.resolve(ok({ kind: "login", login: { id: "late-flow", revision: 1, status: "pending", events: [] } })); await app.render();

    expect(app.get("accounts-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(calls.filter(request => request.type === "cancel")).toEqual([{ type: "cancel", worktreeId: app.selection.worktree!.id, flowId: "late-flow" }]);
  } finally { waiting.resolve(err(new CancelledError())); await app.close(); }
});

test("계정 조회 실패는 초안을 보존하고 모델로 재전송하지 않는다", async () => {
  // 사용 불가 오류는 호스트 화면에서 끝나야 한다.
  const app = await mount({ onAccountsRequest: async () => err(new InputError("Fixture failure")) });
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("Fixture failure"); expect(app.sent).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally { await app.close(); }
});
