import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { PromptInput } from "./prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tinyPng } from "../../testing/image.ts";
import { ok } from "../../result.ts";
import type { ClipboardRepresentation } from "@opentui/core";
import type { Result } from "../../result.ts";
import type { ExpectedError } from "../../errors.ts";
import { CompletionMenu } from "./completion-menu.ts";
import { KeyRouter } from "../../keybindings/router.ts";
import { defaultKeymap } from "../../keybindings/config.ts";

async function mount(options: ConstructorParameters<typeof PromptInput>[3] = {}) {
  const app = await createTestRenderer({ width: 80, height: 10, kittyKeyboard: true });
  const notices: string[] = [], details: DialogContent[] = [];
  const input = new PromptInput(app.renderer, (message) => notices.push(message), (content) => details.push(content), options);
  app.renderer.root.add(input.field); input.focus(); await app.renderOnce();
  return { ...app, input, notices, details, async close() { input.dispose(); await app.dispose(); } };
}

test.each(["", "/", "@"])("Ctrl+V는 입력이 %j여도 이미지 첨부를 추가하고 기존 입력과 포커스를 보존한다", async (prefix) => {
  // Only OS clipboard contents are replaced; the real keymap, router, menu and attachment conversion stay active.
  const directory = await mkdtemp(join(tmpdir(), "radian-clipboard-keys-"));
  let reads = 0, paste: Promise<void> | undefined;
  const app = await mount({ cacheRoot: directory, clipboard: {
    read: async () => { reads++; return ok({ mimeType: "image/png", bytes: tinyPng() }); }, dispose: async () => {},
  } });
  const menu = new CompletionMenu(app.renderer, app.input, () => "session", async () => ok({ items: [], truncated: false }), () => {});
  app.renderer.root.add(menu.root);
  const router = new KeyRouter(app.renderer, defaultKeymap(), () => menu.engaged ? "prompt-completion" : "prompt",
    (command) => command === "agent.paste", (command) => { if (command === "agent.paste") paste = app.input.pasteClipboard(); });
  try {
    await app.mockInput.typeText(prefix); await app.renderOnce();
    expect(menu.open).toBe(Boolean(prefix));

    // Completion ownership must not swallow the paste shortcut while / or @ suggestions are open.
    app.mockInput.pressKey("v", { ctrl: true });
    expect(paste).toBeDefined();
    if (!paste) throw new Error("Clipboard paste shortcut was not routed");
    await paste; await app.renderOnce();

    // The original prefix remains, and the image is retained as private bytes rather than submitted or exposed as a path.
    expect(reads).toBe(1); expect(app.input.value).toBe(`${prefix}[Image #1]`);
    const path = app.input.submission.images[0]!;
    expect(path.startsWith(directory)).toBe(true); expect(await readFile(path)).toEqual(tinyPng());
    expect(app.input.draft.tokens).toHaveLength(1); expect(app.input.pending).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id); expect(app.notices).toEqual([]);
  } finally { router.dispose(); menu.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("읽기 전용 Prompt는 키·붙여넣기를 무시하고 OS 클립보드도 읽지 않는다", async () => {
  // 미리보기에는 같은 입력 컴포넌트를 쓰지만 읽기나 파일 생성 부작용은 없어야 한다.
  let reads = 0;
  const app = await mount({ readOnly: true, clipboard: {
    read: async () => { reads++; return ok({ mimeType: "image/png", bytes: tinyPng() }); }, dispose: async () => {},
  } });
  try {
    app.input.value = "Saved draft";

    // 일반 키, 네이티브 붙여넣기와 명시적 클립보드 경로를 모두 시도한다.
    await app.mockInput.typeText("edit"); app.mockInput.pressBackspace();
    app.mockInput.pressEnter(); app.mockInput.pressKey("return", { shift: true });
    await app.mockInput.pasteBracketedText("pasted edit"); app.input.pasteText("direct paste");
    await app.input.pasteClipboard(); await app.renderOnce();

    // 저장된 표시값은 유지하고 첨부·로딩·OS 읽기를 만들지 않는다.
    expect(app.input.value).toBe("Saved draft"); expect(reads).toBe(0);
    expect(app.input.draft.tokens).toEqual([]); expect(app.input.pending).toBe(false); expect(app.input.activity.root.visible).toBe(false);
  } finally { await app.close(); }
});

test("직접 읽은 클립보드 이미지는 번호로 표시하고 초안에 유지되는 비공개 파일을 참조한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-clipboard-ui-"));
  const app = await mount({cacheRoot: directory, clipboard: {read: async () => ok({mimeType: "image/png", bytes: tinyPng()}), dispose: async () => {}}});
  try {
    await app.input.pasteClipboard();
    expect(app.input.value).toBe("[Image #1]"); expect(app.input.pending).toBe(false);
    const path = app.input.submission.images[0]!;
    expect(path.startsWith(directory)).toBe(true); expect(await readFile(path)).toEqual(tinyPng());
    const saved = app.input.draft; app.input.value = ""; expect(app.input.restore(saved).ok).toBe(true);
    expect(app.input.submission.images).toEqual([path]); expect(app.notices).toEqual([]);
  } finally {await app.close(); await rm(directory, {recursive:true,force:true});}
});

test("클립보드 읽기 중 세션 초안이 교체되면 늦은 이미지를 새 입력에 넣지 않는다", async () => {
  const gate = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  const app = await mount({clipboard: {read: () => gate.promise, dispose: async () => {}}});
  try {
    const pending = app.input.pasteClipboard(); expect(app.input.pending).toBe(true);
    app.input.value = "new session draft"; gate.resolve(ok({mimeType:"image/png",bytes:tinyPng()})); await pending;

    expect(app.input.value).toBe("new session draft"); expect(app.input.draft.tokens).toEqual([]);
    expect(app.input.pending).toBe(false); expect(app.input.activity.root.visible).toBe(false);
  } finally {await app.close();}
});

test("클립보드 읽기 중 커서를 옮기면 잘못된 위치에 삽입하지 않고 재시도를 안내한다", async () => {
  const gate = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  const app = await mount({clipboard: {read: () => gate.promise, dispose: async () => {}}});
  try {
    await app.mockInput.typeText("before"); const pending = app.input.pasteClipboard();
    app.mockInput.pressArrow("left"); gate.resolve(ok({mimeType:"text/plain",bytes:new TextEncoder().encode("paste")})); await pending;

    expect(app.input.value).toBe("before"); expect(app.notices[0]).toContain("paste again");
    expect(app.input.pending).toBe(false);
  } finally {await app.close();}
});

test("초안 교체 후 undo·redo가 이전 세션의 첨부 메타데이터를 되살리지 않는다", async () => {
  const app = await mount();
  try {
    app.input.attachFile("/tmp/secret.png"); await app.mockInput.typeText(" old");
    app.input.value = "new session"; app.mockInput.pressKey("-", {ctrl:true}); app.mockInput.pressKey(".", {ctrl:true});
    expect(app.input.value).toBe("new session"); expect(app.input.draft.tokens).toEqual([]);
    await app.mockInput.typeText(" edit"); app.mockInput.pressKey("-", {ctrl:true});
    expect(app.input.draft.tokens).toEqual([]); expect(app.input.submission.images).toEqual([]);
  } finally {await app.close();}
});

test("접힌 붙여넣기 자체의 undo·redo는 표시와 원문을 함께 복원한다", async () => {
  const app = await mount();
  try {
    const text = "long pasted content\n".repeat(100);
    await app.mockInput.pasteBracketedText(text); app.mockInput.pressKey("-", {ctrl:true});
    expect(app.input.value).toBe(""); expect(app.input.draft.tokens).toEqual([]);
    app.mockInput.pressKey(".", {ctrl:true});
    expect(app.input.value).toContain("[Pasted Content"); expect(app.input.submission.text).toBe(text);
    expect(app.input.draft.tokens).toHaveLength(1);
  } finally {await app.close();}
});

test("긴 붙여넣기는 짧은 항목으로 보이지만 1,000자를 넘는 원문 전체를 전송한다", async () => {
  const app = await mount();
  try {
    // 화면 표현만 접고 실제 사용자 데이터는 보존해야 한다.
    const text = "A".repeat(6324);
    await app.mockInput.pasteBracketedText(text); await app.renderOnce();

    expect(app.input.value).toBe("[Pasted Content 6324 chars]");
    expect(app.input.submission.text).toBe(text); expect(app.input.draft.tokens).toHaveLength(1);
    expect(app.notices).toEqual([]);
  } finally { await app.close(); }
});

test("짧은 여러 줄 붙여넣기와 Shift·Alt Enter는 줄바꿈을 보존한다", async () => {
  const app = await mount();
  try {
    // 줄바꿈은 키 입력이 아니라 붙여넣은 데이터의 일부다.
    await app.mockInput.pasteBracketedText("first\nsecond");
    app.mockInput.pressEnter({ shift: true }); await app.mockInput.typeText("third");
    app.mockInput.pressEnter({ meta: true }); await app.mockInput.typeText("fourth");

    expect(app.input.value).toBe("first\nsecond\nthird\nfourth");
    expect(app.input.submission.text).toBe(app.input.value); expect(app.input.draft.tokens).toEqual([]);
  } finally { await app.close(); }
});

test("첨부 경로는 번호로 표시하고 실제 전송에는 이미지 경로와 파일 참조를 보존한다", async () => {
  const app = await mount();
  try {
    app.input.setWorkingDirectory("/workspace");
    await app.mockInput.pasteBracketedText('"/tmp/한글 image.png" /tmp/file.txt');

    expect(app.input.value).toBe("[Image #1] [File #1] ");
    expect(app.input.value).not.toContain("/tmp/");
    expect(app.input.submission.images).toEqual(["/tmp/한글 image.png"]);
    expect(app.input.submission.text).toBe('[Image #1] @"/tmp/file.txt" ');
    expect(app.input.legacyText).toBe('@"/tmp/한글 image.png" @"/tmp/file.txt" ');
  } finally { await app.close(); }
});

test("첨부 앞뒤의 한글·emoji 편집과 저장·복원은 원문 위치와 커서를 보존한다", async () => {
  const app = await mount();
  try {
    const text = "원문👩🏽‍💻\n".repeat(100);
    await app.mockInput.pasteBracketedText("앞👩🏽‍💻 "); await app.mockInput.pasteBracketedText(text); await app.mockInput.typeText(" 뒤");
    app.mockInput.pressArrow("left"); const cursor = app.input.cursorOffset;
    const saved = app.input.draft, expanded = app.input.submission.text;
    app.input.value = "another session"; const restored = app.input.restore(saved);

    expect(restored.ok).toBe(true); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.input.submission.text).toBe(expanded); expect(expanded).toBe(`앞👩🏽‍💻 ${text} 뒤`);
    expect(app.input.draft).toEqual(saved);
  } finally { await app.close(); }
});

test("Backspace는 접힌 붙여넣기 전체를 삭제하고 undo는 원문까지 복원한다", async () => {
  const app = await mount();
  try {
    const text = "large text ".repeat(200);
    await app.mockInput.typeText("before "); await app.mockInput.pasteBracketedText(text);
    app.mockInput.pressBackspace();
    expect(app.input.value).toBe("before "); expect(app.input.draft.tokens).toEqual([]);

    app.mockInput.pressKey("-", { ctrl: true });

    expect(app.input.submission.text).toBe(`before ${text}`); expect(app.input.draft.tokens).toHaveLength(1);
  } finally { await app.close(); }
});

test("내용 확인 후 삭제는 해당 항목만 제거하고 나머지 첨부는 유지한다", async () => {
  const app = await mount();
  try {
    app.input.attachFile("/tmp/one.txt"); app.input.attachFile("/tmp/two.png");
    app.input.inspectAtCursor();
    expect(app.details[0]!.title).toBe("[Image #1]"); expect(app.details[0]!.text).toContain("/tmp/two.png");
    app.details[0]!.remove!();

    expect(app.input.value).toBe("[File #1]"); expect(app.input.submission.images).toEqual([]);
    expect(app.input.submission.text).toBe('@"/tmp/one.txt"');
  } finally { await app.close(); }
});

test("완성 후보 삽입은 기존 첨부를 잃지 않고 대상 범위만 바꾼다", async () => {
  const app = await mount();
  try {
    app.input.attachFile("/tmp/image.png"); await app.mockInput.typeText(" /mode");
    const start = app.input.value.indexOf("/mode"); app.input.replaceRange(start, app.input.value.length, "/model ");

    expect(app.input.value).toBe("[Image #1] /model "); expect(app.input.submission.images).toEqual(["/tmp/image.png"]);
    expect(app.input.draft.tokens).toHaveLength(1);
  } finally { await app.close(); }
});
