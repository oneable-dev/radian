import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { SessionTranscript } from "./transcript.ts";
import { imageNamesEntryType, maximumPreviewImageBytes } from "./transcript-images.ts";
import { tinyPng } from "../testing/image.ts";
import { expectError, expectOk } from "../testing/results.ts";

const image = (): ImageContent => ({ type: "image", mimeType: "image/png", data: tinyPng().toString("base64") });
function deliver(transcript: SessionTranscript, message: UserMessage) {
  transcript.handle({ type: "message_start", message }); transcript.handle({ type: "message_end", message });
}

test("이미지 첨부는 본문 중복 라벨 없이 독립 섹션으로 투영하고 파일명·원본을 저장 복원한다", () => {
  // Names are display-only custom entries; the original SDK message and image bytes stay intact.
  const block = image(), message: UserMessage = { role: "user", content: [{ type: "text", text: "[Image #1] Inspect this" }, block], timestamp: 1 };
  const manager = SessionManager.inMemory("/fixture"), live = new SessionTranscript([]);
  const names = live.rememberImages([block], ["/private/screens/design.png"]);
  manager.appendCustomEntry(imageNamesEntryType, names); manager.appendMessage(message); deliver(live, message);

  const restored = new SessionTranscript(manager.getBranch());
  for (const transcript of [live, restored]) {
    expect(transcript.sections.map((section) => section.text)).toEqual(["Inspect this", "design.png"]);
    const attachment = transcript.sections[1]!;
    expect(attachment.kind).toBe("notice"); expect(attachment.title).toBe("read"); expect(attachment.image?.name).toBe("design.png");
    expect(attachment.image?.byteLength).toBe(tinyPng().byteLength);
    expect(expectOk(transcript.imageData(attachment.image!.id)).bytes).toEqual(tinyPng());
    expect(JSON.stringify(transcript.sections)).not.toContain(block.data);
    expect(JSON.stringify(transcript.sections)).not.toContain("/private/");
    expect(JSON.stringify(transcript.sections)).not.toContain("[Image");
  }
  expect((message.content as { text?: string }[])[0]?.text).toBe("[Image #1] Inspect this");
  expect(JSON.stringify(names)).not.toContain(block.data);
});

test("이름 없는 이미지와 이미지 전용 요청도 순서·요청 개수를 보존하고 실제 원본만 반환한다", () => {
  const transcript = new SessionTranscript([]), first = image(), second = { ...image(), data: tinyPng(2).toString("base64") };
  deliver(transcript, { role: "user", content: [{ type: "text", text: "[Image #1] [Image #3]" }, first, second], timestamp: 1 });

  expect(transcript.sections.map((section) => section.text)).toEqual(["clipboard-1.png", "clipboard-2.png"]);
  expect(transcript.sections[0]?.request).toEqual({ text: "", images: 2, files: 0 });
  expect(transcript.sections[1]?.request).toBeUndefined();
  expect(expectError(transcript.imageData("f".repeat(64))).code).toBe("INVALID_INPUT");
});

test("실제 이미지 블록이 없는 일반 문자열은 이미지 첨부나 숨길 라벨로 추측하지 않는다", () => {
  const transcript = new SessionTranscript([]), text = "Explain [Image #1] and [Image: image/png] as literal text";
  deliver(transcript, { role: "user", content: text, timestamp: 1 });

  expect(transcript.sections).toHaveLength(1); expect(transcript.sections[0]?.text).toBe(text);
  expect(transcript.sections[0]?.image).toBeUndefined();
});

test.each(["invalid!", "@@@@", "AAAA=AAA", "A".repeat(Math.ceil(maximumPreviewImageBytes / 3) * 4 + 4)])("잘못되거나 과도한 이미지 데이터는 미리보기 성공으로 반환하지 않는다: %#", (data) => {
  const transcript = new SessionTranscript([]);
  deliver(transcript, { role: "user", content: [{ ...image(), data }], timestamp: 1 });

  expect(expectError(transcript.imageData(transcript.sections[0]!.image!.id)).code).toBe("INVALID_INPUT");
});
