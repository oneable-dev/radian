import { expect, test } from "bun:test";
import { BoxRenderable, type ClipboardRepresentation } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { PromptInput } from "./prompt-input.ts";
import { SearchInput } from "./search-input.ts";
import { ok, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";

test.each(["search", "prompt"] as const)("%s 입력 여백은 커서를 보존해 포커스하고 텍스트 클릭은 네이티브 위치를 사용한다", async kind => {
  // Both fields share padding hit testing without replacing native text clicks.
  const app = await createTestRenderer({ width: 80, height: 12 });
  const input = kind === "search" ? new SearchInput(app.renderer, { id: "query", placeholder: "Search" })
    : new PromptInput(app.renderer, () => {}, () => {});
  const other = new BoxRenderable(app.renderer, { height: 1, focusable: true });
  app.renderer.root.add(input.field); app.renderer.root.add(other);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  try {
    input.value = "abcdef"; input.cursorOffset = 4; await render(); other.focus();

    // Only primary clicks in padding restore focus without moving the caret.
    await app.mockMouse.click(input.field.x + 2, input.field.y, 2); await render();
    expect(app.renderer.currentFocusedRenderable).toBe(other);
    await app.mockMouse.click(input.field.x + 2, input.field.y); await render();
    expect(app.renderer.currentFocusedRenderable).toBe(input); expect(input.cursorOffset).toBe(4);
    other.focus(); await app.mockMouse.click(input.x + 2, input.y); await app.mockInput.typeText("!"); await render();

    expect(input.value).toBe("ab!cdef"); expect(app.renderer.currentFocusedRenderable).toBe(input);
  } finally { if (input instanceof PromptInput) input.dispose(); await app.dispose(); }
});

test("공용 Prompt는 내용과 가용 공간으로 높이를 맞추고 줄바꿈·리사이즈 중 원문과 커서를 보존한다", async () => {
  // The input owns editor rows and padding within the parent's height budget.
  const app = await createTestRenderer({ width: 120, height: 15 });
  const input = new PromptInput(app.renderer, () => {}, () => {});
  app.renderer.root.add(input.field);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  try {
    const value = "한글🙂 word ".repeat(100);
    input.value = value; input.cursorOffset = input.editBuffer.measureText("한글🙂");
    const cursor = input.cursorOffset;

    await render(); expect(input.height).toBe(6); expect(input.field.height).toBe(8);
    app.resize(60, 15); await render();
    input.fit(4); await render(); expect(input.height).toBe(2); expect(input.field.height).toBe(4);
    input.fit(1); await render();

    expect(input.height).toBe(1); expect(input.field.height).toBe(1);
    expect(input.value).toBe(value); expect(input.cursorOffset).toBe(cursor);
    input.fit(8); input.value = "short"; await render();
    expect(input.height).toBe(1); expect(input.field.height).toBe(3);
  } finally { input.dispose(); await app.dispose(); }
});

test("빈 프롬프트는 placeholder만 표시하고 포커스·리사이즈에도 보더와 초안을 만들지 않는다", async () => {
  // Prompt focus is indicated by the native caret, not horizontal or vertical rails.
  const app = await createTestRenderer({ width: 320, height: 8 });
  const owner = new BoxRenderable(app.renderer, { width: "100%", height: 8, paddingX: 2 });
  const input = new PromptInput(app.renderer, () => {}, () => {});
  input.field.marginX = -2; owner.add(input.field); app.renderer.root.add(owner);
  try {
    for (const [width, inset] of [[320, 2], [60, 1], [80, 2], [320, 2]] as const) {
      app.resize(width, 8);
      for (const focused of [false, true]) {
        if (focused) input.focus(); else input.blur();
        await app.renderOnce(); await app.renderOnce();

        const frame = app.captureCharFrame().split("\n");
        expect(frame[input.y]).toContain("Ask to do anything");
        for (const y of [input.field.y, input.field.y + input.field.height - 1]) expect(frame[y]!.trim()).toBe("");
        expect(input.field.x).toBe(0); expect(input.field.width).toBe(width); expect(input.x).toBe(inset);
        expect(input.value).toBe(""); expect(input.submission.text).toBe("");
      }
    }
    // The placeholder disappears as soon as real input exists, without changing its caret or rows.
    await app.mockInput.typeText("real draft"); await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Ask to do anything"); expect(input.value).toBe("real draft");
    expect(input.cursorOffset).toBe(10); expect(input.height).toBe(1);
  } finally { input.dispose(); await app.dispose(); }
});

test("보더 없는 입력에서도 붙여넣기 스피너는 오른쪽 여백에서 계속 보인다", async () => {
  // Clipboard feedback retains its dedicated gutter independently of work-status effects.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 40, height: 5, clock });
  const input = new PromptInput(app.renderer, () => {}, () => {});
  app.renderer.root.add(input.field);
  try {
    input.focus(); input.activity.start(); await app.renderOnce(); await app.renderOnce();

    const spinner = input.activity.root;
    expect(app.captureCharFrame().split("\n")[spinner.y]![spinner.x]).toBe("⠋");
    clock.advance(80); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[spinner.y]![spinner.x]).toBe("⠙");
  } finally { input.dispose(); await app.dispose(); }
});

test.each([1, 2])("높이가 %i행뿐이어도 입력 텍스트와 커서를 보존한다", async height => {
  // Short layouts spend their last row on the editor, never decoration.
  const app = await createTestRenderer({ width: 40, height: 5 });
  const input = new PromptInput(app.renderer, () => {}, () => {});
  app.renderer.root.add(input.field);
  try {
    input.value = "visible draft"; input.focus(); input.fit(height);

    await app.renderOnce(); await app.renderOnce();

    const line = app.captureCharFrame().split("\n")[input.y]!;
    expect(line).toContain("visible draft"); expect(line).not.toContain("─");
    expect(input.height).toBe(1); expect(input.field.height).toBe(height);
  } finally { input.dispose(); await app.dispose(); }
});

test("공용 Prompt의 부모가 숨겨지면 클립보드 읽기와 로딩 타이머를 정리하고 늦은 결과를 버린다", async () => {
  // A hidden input must not accept a late clipboard result from its previous screen.
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

    const reading = input.pasteClipboard(); expect(input.pending).toBe(true);
    owner.visible = false; await app.renderOnce();
    pending.resolve(ok({ mimeType: "text/plain", bytes: new TextEncoder().encode("late paste") })); await reading;
    clock.advance(1000); await app.renderOnce();

    expect(signal?.aborted).toBe(true); expect(input.value).toBe("retained"); expect(input.pending).toBe(false);
    expect(input.activity.root.visible).toBe(false); expect(clock.pendingTimerCount).toBe(0);
  } finally { pending.resolve(ok({ mimeType: "text/plain", bytes: new Uint8Array() })); input.dispose(); await app.dispose(); }
});
