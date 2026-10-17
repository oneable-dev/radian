import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TranscriptSection } from "../transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { RequestHeading } from "./request-heading.ts";

const user = (text: string, id = "request"): TranscriptSection => ({ id, kind: "user", title: "You", text, status: "complete" });
async function mount(width = 60) {
  const app = await createTestRenderer({ width, height: 4, kittyKeyboard: true });
  const heading = new RequestHeading(app.renderer); app.renderer.root.add(heading.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  return { ...app, heading, render, text: () => app.captureCharFrame().split("\n")[0]!.trimEnd() };
}

function palette(light: boolean): TerminalColors {
  return { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
}

test("최근 사용자 요청만 원문 기반 한 줄로 표시하고 로그 갱신은 제목을 바꾸지 않는다", async () => {
  const app = await mount();
  try {
    // 오래된 사용자 요청 뒤로 도구와 응답이 계속 추가되는 대화다.
    const latest = user("  Implement\nthe search\t carefully.  ", "latest");
    const sections: TranscriptSection[] = [user("Old request", "old"), latest,
      { id: "tool", kind: "tool", title: "bash", text: "DO NOT USE TOOL OUTPUT", status: "running" }];

    app.heading.update(sections, true); await app.render();
    expect(app.text()).toBe("Request Implement the search carefully.");
    app.heading.update([...sections, { id: "answer", kind: "assistant", title: "Agent", text: "DO NOT USE THE ANSWER", status: "complete" }], true); await app.render();

    // 작업 완료나 로그 스크롤에 관계없이 마지막 요청을 남겨 둔다.
    expect(app.text()).toBe("Request Implement the search carefully.");
    expect(app.heading.root.height).toBe(1);
    expect(latest.text).toBe("  Implement\nthe search\t carefully.  ");
  } finally { await app.dispose(); }
});

test("한글과 결합 문자 및 emoji 묶음을 자르지 않고 셀 폭에 맞춰 ...를 붙인다", async () => {
  const app = await mount(26);
  try {
    // UTF-16 길이가 아닌 실제 표시 셀과 grapheme 경계로 축약해야 한다.
    app.heading.update([user("A 👨‍👩‍👧‍👦 e\u0301 한글👩🏽‍💻 ZZZZZZZZZZZ")], true); await app.render();

    expect(app.text()).toBe("Request A 👨‍👩‍👧‍👦 e\u0301 한글👩🏽‍💻 Z...");
    expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(26);
    expect(app.captureCharFrame().split("\n")[1]!.trim()).toBe("");
  } finally { await app.dispose(); }
});

test("아주 좁은 화면은 라벨을 생략하고 리사이즈 후 같은 원문을 다시 표시한다", async () => {
  const app = await mount(6);
  try {
    const text = "abcdefghijklmnopqrstuvwxyz";
    app.heading.update([user(text)], true); await app.render();
    expect(app.text()).toBe("abc...");

    // 세션 데이터 재조회 없이 현재 표시 폭에 맞춰 다시 그린다.
    app.resize(2, 4); await app.render(); expect(app.text()).toBe("..");
    app.resize(60, 4); await app.render();

    expect(app.text()).toBe(`Request ${text}`);
    expect(app.heading.root.height).toBe(1);
  } finally { await app.dispose(); }
});

test("스킬 호출은 내부 지침이 아니라 호출 이름이나 실제 사용자 요청만 표시한다", async () => {
  const app = await mount();
  try {
    const skill: TranscriptSection = { id: "skill", kind: "notice", title: "write-good-code", skillName: "write-good-code", text: "PRIVATE INTERNAL INSTRUCTIONS", status: "complete" };

    app.heading.update([user("Old request"), skill], true); await app.render();
    expect(app.text()).toBe("Request /skill:write-good-code");
    app.heading.update([skill, user("Implement the actual task")], true); await app.render();

    expect(app.text()).toBe("Request Implement the actual task");
    expect(app.captureCharFrame()).not.toContain("PRIVATE INTERNAL INSTRUCTIONS");
  } finally { await app.dispose(); }
});

test("요청이 없거나 Agent가 숨겨졌을 때는 행을 만들지 않고 파괴 뒤 갱신도 안전하다", async () => {
  const app = await mount();
  try {
    app.heading.update([user("Visible request")], true); await app.render();
    app.heading.update(undefined, true); await app.render();
    expect(app.heading.root.visible).toBe(false); expect(app.text()).toBe("");
    app.heading.update([user("Hidden request")], false); await app.render();
    expect(app.heading.root.visible).toBe(false); expect(app.captureCharFrame()).not.toContain("Hidden request");

    app.heading.root.destroyRecursively();
    expect(() => app.heading.update([user("Late request")], true)).not.toThrow();
  } finally { await app.dispose(); }
});

test("밝고 어두운 테마 전환은 고정 제품색 없이 요청과 라벨의 의미 색상을 따른다", async () => {
  const app = await mount();
  try {
    app.heading.update([user("Theme request")], true);
    for (const light of [false, true]) {
      const theme = uiTheme(app.renderer); theme.configure(palette(light)); await app.render();

      const spans = app.captureSpans().lines[0]!.spans;
      expect(spans.find((span) => span.text.includes("Request"))!.fg.toInts()).toEqual(theme.colors.muted.toInts());
      expect(spans.find((span) => span.text.includes("Theme request"))!.fg.toInts()).toEqual(theme.colors.text.toInts());
      expect(app.text()).toBe("Request Theme request");
    }
  } finally { await app.dispose(); }
});
