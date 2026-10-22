import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { uiTheme } from "../../ui/theme.ts";
import { PendingMessages } from "./pending-messages.ts";

async function mount(width = 120, key = "<Esc>") {
  const app = await createTestRenderer({ width, height: 8 });
  const pending = new PendingMessages(app.renderer, () => key);
  app.renderer.root.add(pending.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const rows = () => app.captureCharFrame().split("\n").map(line => line.trimEnd());
  return { ...app, pending, render, rows, async close() { await app.dispose(); } };
}

test("너비가 바뀌어도 안내와 중단 도움말은 한 줄이며 메시지의 들여쓰기와 순서를 유지한다", async () => {
  // 넓은 화면에서는 전송 시점을 설명하고 좁은 화면에서는 단축키를 유지하며 문구만 줄인다.
  const app = await mount();
  const messages = [{ text: "First message", images: 0, files: 0 }, { text: "Second message", images: 0, files: 0 }];
  try {
    app.pending.update(messages, true, 4); await app.render();
    for (const [width, heading] of [
      [120, "• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)"],
      [78, "• Messages waiting to be sent (press <Esc> to interrupt and send immediately)"],
      [76, "• Messages waiting (<Esc>: interrupt & send)"],
      [44, "• Messages waiting (<Esc>: interrupt & send)"],
      [120, "• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)"],
    ] as const) {
      // 리사이즈는 대기 메시지를 다시 받지 않아도 현재 너비에 맞춰 안내를 갱신해야 한다.
      app.resize(width, 8); await app.render();

      // 안내 아래에는 두 메시지가 붙고 입력창을 위한 마지막 한 줄은 비워 둔다.
      expect(app.rows().slice(0, 4)).toEqual([heading, "  ↳ First message", "  ↳ Second message", ""]);
      expect(app.pending.rows).toBe(4);
    }
  } finally { await app.close(); }
});

test("대기 안내와 메시지는 기본 글자색이고 도움말·연결 기호는 흐리게 표시하며 설정된 중단 키만 강조한다", async () => {
  // 기본 Esc가 아닌 사용자 단축키도 같은 안내와 강조 규칙을 따라야 한다.
  const app = await mount(130, "<C-x>");
  try {
    app.pending.update([{ text: "Review changes", images: 0, files: 0 }], true, 3); await app.render();

    // 제목·도움말·연결 기호의 대비를 실제 렌더링된 터미널 span으로 확인한다.
    const colors = uiTheme(app.renderer).colors, lines = app.captureSpans().lines;
    const heading = lines[0]!.spans, message = lines[1]!.spans;
    expect(app.rows()[0]).toEndWith("(press <C-x> to interrupt and send immediately)");
    expect(heading.find(span => span.text.includes("Messages"))!.fg.toInts()).toEqual(colors.text.toInts());
    expect(heading.find(span => span.text.includes("to interrupt"))!.fg.toInts()).toEqual(colors.muted.toInts());
    expect(message.find(span => span.text.includes("↳"))!.fg.toInts()).toEqual(colors.muted.toInts());
    expect(message.find(span => span.text.includes("Review changes"))!.fg.toInts()).toEqual(colors.text.toInts());
    expect(heading.filter(span => span.attributes & TextAttributes.BOLD).map(span => span.text)).toEqual(["<C-x>"]);
  } finally { await app.close(); }
});

test("들여쓴 긴 대기 메시지도 첨부 배지를 보존하며 원문이나 다음 행을 침범하지 않는다", async () => {
  // 실제 첨부를 가진 긴 한글·이모지 메시지는 표시 폭만 줄이고 런타임 원문은 보존한다.
  const app = await mount(32);
  const request = { text: "한글👩‍💻 요청\n자세한 설명 ".repeat(8), images: 1, files: 0 };
  const original = request.text;
  try {
    app.pending.update([request], true, 3); await app.render();

    // 연결 기호의 폭을 제외한 공간에 말줄임과 첨부 배지가 함께 들어가야 한다.
    expect(app.rows()[1]).toStartWith("  ↳ 한글👩‍💻");
    expect(app.rows()[1]).toEndWith("…  [1 image]");
    expect(Bun.stringWidth(app.rows()[1]!)).toBeLessThanOrEqual(32);
    expect(app.rows()[2]).toBe(""); expect(request.text).toBe(original);
  } finally { await app.close(); }
});

test("대기 목록에 스크롤바가 생겨도 첨부 배지와 연결 기호가 가려지지 않는다", async () => {
  // 대기 메시지가 많으면 목록의 실제 폭은 스크롤바만큼 좁아진다.
  const app = await mount(32);
  const request = { text: "A long queued request ".repeat(8), images: 1, files: 0 };
  try {
    app.pending.update(Array.from({ length: 20 }, () => request), true, 4); await app.render();
    const list = app.renderer.root.findDescendantById("agent-pending-list");
    if (!(list instanceof ScrollBoxRenderable)) throw new Error("Missing pending list");

    // 메시지는 컨테이너 전체가 아닌 스크롤바를 제외한 화면 폭 안에서 줄여야 한다.
    const row = app.rows()[list.viewport.y]!.slice(list.viewport.x, list.viewport.x + list.viewport.width).trimEnd();
    expect(list.viewport.width).toBeLessThan(32);
    expect(row).toStartWith("  ↳ "); expect(row).toEndWith("…  [1 image]");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(list.viewport.width);
  } finally { await app.close(); }
});

test.each([0, 1, 2, 3])("높이 예산이 %i행이면 안내와 메시지는 예산 안에만 표시된다", async (maximumRows) => {
  // 작은 터미널에서 대기 목록이 입력창에 할당된 행을 빼앗지 않아야 한다.
  const app = await mount();
  try {
    app.pending.update([{ text: "Waiting message", images: 0, files: 0 }], true, maximumRows); await app.render();

    // 두 행만 있어도 제목 다음에 메시지가 보이며 도움말용 별도 행은 만들지 않는다.
    expect(app.pending.rows).toBe(maximumRows);
    if (maximumRows > 0) expect(app.rows()[0]).toStartWith("• Messages");
    if (maximumRows >= 2) expect(app.rows()[1]).toBe("  ↳ Waiting message");
    expect(app.rows().slice(maximumRows).every(line => line === "")).toBe(true);
  } finally { await app.close(); }
});

test("대기 메시지가 전달되거나 화면이 숨겨지면 안내와 하단 여백도 함께 사라진다", async () => {
  // 대기 목록은 런타임 스냅샷의 투영이므로 빈 목록이나 숨겨진 화면에 장식을 남기지 않는다.
  const app = await mount();
  const messages = [{ text: "Waiting message", images: 0, files: 0 }];
  try {
    app.pending.update(messages, true, 3); await app.render();
    expect(app.rows()[1]).toBe("  ↳ Waiting message");

    // 전달 완료와 화면 숨김을 각각 적용하면 목록 전체가 접혀야 한다.
    for (const [next, visible] of [[[], true], [messages, false]] as const) {
      app.pending.update(next, visible, 3); await app.render();

      expect(app.pending.rows).toBe(0); expect(app.pending.root.visible).toBe(false);
      expect(app.rows().every(line => line === "")).toBe(true);
    }
  } finally { await app.close(); }
});
