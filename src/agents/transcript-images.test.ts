import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { SessionTranscript } from "./transcript.ts";
import { imageNamesEntryType, maximumPreviewImageBytes } from "./transcript-images.ts";
import { tinyPng } from "../testing/image.ts";
import { expectError, expectOk } from "../testing/results.ts";

const image = (): ImageContent => ({
  type: "image",
  mimeType: "image/png",
  data: tinyPng().toString("base64"),
});
function deliver(transcript: SessionTranscript, message: UserMessage) {
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
}

test("Image attachments project into separate sections without duplicate labels and restore names and originals", () => {
  // Names are display-only custom entries; the original SDK message and image bytes stay intact.
  const block = image(),
    message: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "[Image #1] Inspect this" }, block],
      timestamp: 1,
    };
  const manager = SessionManager.inMemory("/fixture"),
    live = new SessionTranscript([]);
  const names = live.rememberImages([block], ["/private/screens/design.png"]);
  manager.appendCustomEntry(imageNamesEntryType, names);
  manager.appendMessage(message);
  deliver(live, message);

  const restored = new SessionTranscript(manager.getBranch());
  for (const transcript of [live, restored]) {
    expect(transcript.sections.map((section) => section.text)).toEqual([
      "Inspect this",
      "design.png",
    ]);
    const attachment = transcript.sections[1]!;
    expect(attachment.kind).toBe("notice");
    expect(attachment.title).toBe("read");
    expect(attachment.image?.name).toBe("design.png");
    expect(attachment.image?.byteLength).toBe(tinyPng().byteLength);
    expect(expectOk(transcript.imageData(attachment.image!.id)).bytes).toEqual(tinyPng());
    expect(JSON.stringify(transcript.sections)).not.toContain(block.data);
    expect(JSON.stringify(transcript.sections)).not.toContain("/private/");
    expect(JSON.stringify(transcript.sections)).not.toContain("[Image");
  }
  expect((message.content as { text?: string }[])[0]?.text).toBe("[Image #1] Inspect this");
  expect(JSON.stringify(names)).not.toContain(block.data);
});

test("Unnamed images and image-only requests preserve order and counts while returning only real originals", () => {
  const transcript = new SessionTranscript([]),
    first = image(),
    second = { ...image(), data: tinyPng(2).toString("base64") };
  deliver(transcript, {
    role: "user",
    content: [{ type: "text", text: "[Image #1] [Image #3]" }, first, second],
    timestamp: 1,
  });

  expect(transcript.sections.map((section) => section.text)).toEqual([
    "clipboard-1.png",
    "clipboard-2.png",
  ]);
  expect(transcript.sections[0]?.request).toEqual({ text: "", images: 2, files: 0 });
  expect(transcript.sections[1]?.request).toBeUndefined();
  expect(expectError(transcript.imageData("f".repeat(64))).code).toBe("INVALID_INPUT");
});

test.each([false, true])(
  "Live and restored skill requests %s hide image guidance while preserving user newlines",
  (skill) => {
    // SDK image guidance is not display data, regardless of skill expansion.
    const input =
      'Review both images [Image #1] [Image #2]\nKeep newlines @"/tmp/a.ts" @"/tmp/b.ts"';
    const hint =
      "[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]";
    const text =
      (skill
        ? '<skill name="review-code" location="/private/SKILL.md">\nInternal instructions\n</skill>\n\n'
        : "") + `${input}\n\n[Image converted from image/heic to image/png.]\n${hint}`;
    const message: UserMessage = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text }, image(), image()],
    };
    const original = JSON.stringify(message),
      manager = SessionManager.inMemory("/fixture"),
      live = new SessionTranscript([]);
    manager.appendMessage(message);

    // Live events and restored history must produce identical user sections.
    deliver(live, message);
    const restored = new SessionTranscript(manager.getBranch());

    // Body and summary represent the same request; original messages and image sections remain intact.
    for (const transcript of [live, restored]) {
      const user = transcript.sections.find((section) => section.kind === "user");
      expect(user?.text).toBe('Review both images\nKeep newlines @"/tmp/a.ts" @"/tmp/b.ts"');
      expect(user?.request).toEqual({
        text: "Review both images Keep newlines",
        images: 2,
        files: 2,
      });
      expect(transcript.sections.filter((section) => section.image)).toHaveLength(2);
      expect(JSON.stringify(transcript.sections)).not.toContain("[Image");
    }
    expect(JSON.stringify(message)).toBe(original);
    expect(manager.getBranch().find((entry) => entry.type === "message")?.message).toEqual(message);
  },
);

test("Image-only requests with generated guidance summarize counts without empty user sections", () => {
  // The SDK may append resize guidance to requests containing only images.
  const transcript = new SessionTranscript([]);
  const text =
    "[Image #1]\n\n[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]";

  deliver(transcript, { role: "user", content: [{ type: "text", text }, image()], timestamp: 1 });

  // Hiding guidance preserves the usual image-only section structure.
  expect(transcript.sections).toHaveLength(1);
  expect(transcript.sections[0]?.text).toBe("clipboard-1.png");
  expect(transcript.sections[0]?.request).toEqual({ text: "", images: 1, files: 0 });
});

test("Plain strings without image blocks never imply attachments or hidden labels", () => {
  const transcript = new SessionTranscript([]),
    text = "Explain [Image #1] and [Image: image/png] as literal text";
  deliver(transcript, { role: "user", content: text, timestamp: 1 });

  expect(transcript.sections).toHaveLength(1);
  expect(transcript.sections[0]?.text).toBe(text);
  expect(transcript.sections[0]?.image).toBeUndefined();
});

test.each([
  "invalid!",
  "@@@@",
  "AAAA=AAA",
  "A".repeat(Math.ceil(maximumPreviewImageBytes / 3) * 4 + 4),
])("Invalid or excessive image data never returns preview success: %#", (data) => {
  const transcript = new SessionTranscript([]);
  deliver(transcript, { role: "user", content: [{ ...image(), data }], timestamp: 1 });

  expect(expectError(transcript.imageData(transcript.sections[0]!.image!.id)).code).toBe(
    "INVALID_INPUT",
  );
});
