import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { requestSummarySchema, summarizeRequest } from "./request-summary.ts";

test("Request summaries count actual images and explicit file references without changing source text", () => {
  const text = 'Review these [Image #1] [Image #3]\n@"/tmp/some note.md" @"/tmp/panel.ts"';
  const summary = summarizeRequest(text, 2);
  expect(summary).toEqual({ text: "Review these", images: 2, files: 2 });
  expect(text).toContain('@"/tmp/some note.md"');
  expect(Value.Check(requestSummarySchema, summary)).toBe(true);
});

test.each([
  "[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]",
  "[Image converted from image/heic to image/png.]",
  "[Image converted from image/heic to image/png.]\n[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
])("Image guidance stays hidden in summaries while attachment counts and source remain intact: %#", (hints) => {
  // The SDK appends image-processing guidance after user input.
  const text = `Review both images [Image #1] [Image #2]\n@"/tmp/a.ts" @"/tmp/b.ts"\n\n${hints}`;

  // Build a display summary containing real image and file attachments.
  const summary = summarizeRequest(text, 2);

  // Hide only internal guidance while preserving attachment counts and SDK source text.
  expect(summary).toEqual({ text: "Review both images", images: 2, files: 2 });
  expect(text).toEndWith(hints);
});

test("Ordinary input and code resembling image guidance remain visible", () => {
  // Guidance without real images or quoted inside code is user input.
  const hint = "[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]";
  const literal = `Explain this message:\n\n${hint}`;
  const example = `Explain this example:\n\n\`\`\`text\n${hint}\n\`\`\``;

  const plainSummary = summarizeRequest(literal, 0);
  const exampleSummary = summarizeRequest(example, 1);

  // Never damage input by stripping entire bracketed expressions.
  expect(plainSummary.text).toContain(hint);
  expect(exampleSummary.text).toContain(hint);
});

test("Single-file summaries show basenames rather than full paths", () => {
  expect(summarizeRequest('@"/private/workspace/한글 note.md"', 0)).toEqual({ text: "", images: 0, files: 1, fileName: "한글 note.md" });
});

test("Attachment-like prose and invalid references never infer attachment counts", () => {
  const text = '[Image #1] diagram.png /tmp/panel.ts @"relative.ts" @"/tmp/bad\\q"';
  expect(summarizeRequest(text, 0)).toEqual({ text, images: 0, files: 0 });
});

test.each(["```", "````", "~~~"])("%s code examples exclude file references while real references outside code count", (fence) => {
  const text = `Explain:\n${fence}text\n@"/tmp/example.ts"\n${fence}\n@"/tmp/actual.ts"`;
  const summary = summarizeRequest(text, 0);
  expect(summary.files).toBe(1); expect(summary.fileName).toBe("actual.ts");
  expect(summary.text).toContain('@"/tmp/example.ts"'); expect(summary.text).not.toContain("actual.ts");
});

test("Large-request display metadata is bounded while preserving graphemes and source text", () => {
  const text = "x".repeat(4094) + "👩‍💻" + "long tail".repeat(1000);
  const summary = summarizeRequest(text, 0);
  expect(summary.text).toBe("x".repeat(4094) + "…");
  expect(Value.Check(requestSummarySchema, summary)).toBe(true); expect(summary.text).not.toContain("\uFFFD");
  expect(text).toContain("👩‍💻long tail");
});
