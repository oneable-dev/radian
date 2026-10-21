import { expect, test } from "bun:test";
import { BoxRenderable, type ClipboardRepresentation } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { PromptInput } from "./prompt-input.ts";
import { SearchInput } from "./search-input.ts";
import { ok, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";

test.each(["search", "prompt"] as const)("%s 입력 여백은 커서를 보존해 포커스하고 텍스트 클릭은 네이티브 위치를 사용한다", async kind => {
  // 기본 입력과 프롬프트 모두 같은 필드 hit testing을 사용한다.
  const app = await createTestRenderer({ width: 80, height: 12 });
  const input = kind === "search" ? new SearchInput(app.renderer, { id: "query", placeholder: "Search" })
    : new PromptInput(app.renderer, () => {}, () => {});
  const other = new BoxRenderable(app.renderer, { height: 1, focusable: true });
  app.renderer.root.add(input.field); app.renderer.root.add(other);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  try {
    input.value = "abcdef"; input.cursorOffset = 4; await render(); other.focus();

    // 보조 버튼은 포커스를 빼앗지 않고, 주 버튼으로 빈 여백을 눌렀을 때만 복귀한다.
    await app.mockMouse.click(input.field.x + 2, input.field.y, 2); await render();
    expect(app.renderer.currentFocusedRenderable).toBe(other);
    await app.mockMouse.click(input.field.x + 2, input.field.y); await render();
    expect(app.renderer.currentFocusedRenderable).toBe(input); expect(input.cursorOffset).toBe(4);
    other.focus(); await app.mockMouse.click(input.x + 2, input.y); await app.mockInput.typeText("!"); await render();

    // 실제 글자를 누르면 기존 커서를 고정하지 않고 클릭 위치에 입력한다.
    expect(input.value).toBe("ab!cdef"); expect(app.renderer.currentFocusedRenderable).toBe(input);
  } finally { if (input instanceof PromptInput) input.dispose(); await app.dispose(); }
});

test("공용 Prompt는 내용과 가용 공간으로 높이를 맞추고 줄바꿈·리사이즈 중 원문과 커서를 보존한다", async () => {
  // 부모는 공간만 전달하며 행 수와 패딩의 계산은 입력 컴포넌트가 소유한다.
  const app = await createTestRenderer({ width: 120, height: 15 });
  const input = new PromptInput(app.renderer, () => {}, () => {});
  app.renderer.root.add(input.field);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  try {
    const value = "한글🙂 word ".repeat(100);
    input.value = value; input.cursorOffset = input.editBuffer.measureText("한글🙂");
    const cursor = input.cursorOffset;

    // 긴 한 줄도 실제 화면의 줄바꿈으로 확장하고 작은 공간에서는 장식부터 줄인다.
    await render(); expect(input.height).toBe(6); expect(input.field.height).toBe(8);
    app.resize(60, 15); await render();
    input.fit(4); await render(); expect(input.height).toBe(2); expect(input.field.height).toBe(4);
    input.fit(1); await render();

    // 높이 제한은 표시만 바꾸며 한글·emoji 원문과 편집 위치는 손실시키지 않는다.
    expect(input.height).toBe(1); expect(input.field.height).toBe(1);
    expect(input.value).toBe(value); expect(input.cursorOffset).toBe(cursor);
    input.fit(8); input.value = "short"; await render();
    expect(input.height).toBe(1); expect(input.field.height).toBe(3);
  } finally { input.dispose(); await app.dispose(); }
});

test("공용 Prompt의 부모가 숨겨지면 클립보드 읽기와 로딩 타이머를 정리하고 늦은 결과를 버린다", async () => {
  // 화면 종류와 무관하게 숨겨진 입력에 붙여넣기가 유입되지 않아야 한다.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 80, height: 12, clock });
  const pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  let signal: AbortSignal | undefined;
  const input = new PromptInput(app.renderer, () => {}, () => {}, { clipboard: {
    read: current => { signal = current; return pending.promise; }, dispose: async () => {},
  } });
  const owner = new BoxRenderable(app.renderer, { width: "100%", height: 8 });
  owner.add(input.field); app.renderer.root.add(owner);
  try {
    input.value = "retained"; await app.renderOnce();

    // 부모만 숨겨도 입력이 자체적으로 취소하며 호출자가 스피너를 따로 관리할 필요가 없다.
    const reading = input.pasteClipboard(); expect(input.pending).toBe(true);
    owner.visible = false; await app.renderOnce();
    pending.resolve(ok({ mimeType: "text/plain", bytes: new TextEncoder().encode("late paste") })); await reading;
    clock.advance(1000); await app.renderOnce();

    // 작업 결과는 취소된 입력에 반영되지 않고 타이머도 남지 않는다.
    expect(signal?.aborted).toBe(true); expect(input.value).toBe("retained"); expect(input.pending).toBe(false);
    expect(input.activity.root.visible).toBe(false); expect(clock.pendingTimerCount).toBe(0);
  } finally { pending.resolve(ok({ mimeType: "text/plain", bytes: new Uint8Array() })); input.dispose(); await app.dispose(); }
});
