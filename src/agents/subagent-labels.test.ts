import { expect, test } from "bun:test";
import { compactSubagentLabel, subagentLabels } from "./subagent-labels.ts";

test("Descendant labels retain their owner path independently of display ordering", () => {
  // A worker remains active after its owner has stopped producing model output.
  const runs = [
    { id: "lead", name: "tech-lead", ownerId: "root" },
    { id: "worker", name: "engineer", ownerId: "lead" },
    { id: "nested", name: "review", ownerId: "worker" },
    { id: "qa", name: "qa", ownerId: "root" },
  ];

  const labels = subagentLabels([runs[2]!, runs[3]!, runs[1]!, runs[0]!]);

  // Compact active-first rows can still identify every branch without exposing UUIDs.
  expect(labels.get("nested")).toBe("tech-lead › engineer › review");
  expect(labels.get("worker")).toBe("tech-lead › engineer");
  expect(labels.get("lead")).toBe("tech-lead");
  expect(labels.get("qa")).toBe("qa");
});

test("Repeated sibling roles receive distinct names inherited by their descendants", () => {
  // Parallel instances of the same Lead each own an Engineer with the same role name.
  const runs = [
    { id: "lead-a", name: "tech-lead", ownerId: "root" },
    { id: "worker-a", name: "engineer", ownerId: "lead-a" },
    { id: "lead-b", name: "tech-lead", ownerId: "root" },
    { id: "worker-b", name: "engineer", ownerId: "lead-b" },
  ];

  const labels = subagentLabels(runs);

  // Ordinals use stable launch order, not the temporary working/settled row order.
  expect(labels.get("worker-a")).toBe("tech-lead [1] › engineer");
  expect(labels.get("worker-b")).toBe("tech-lead [2] › engineer");
  expect(runs[0]!.name).toBe("tech-lead");
});

test.each([0, 5, 12, 24, 60])(
  "At width %i, compact ancestry preserves the worker name before its long ancestors",
  (width) => {
    // A narrow passive row must not show only the long owner's name for every active worker.
    const label = "a-very-long-product-lead › a-very-long-tech-lead › engineer";

    const compact = compactSubagentLabel(label, width);

    expect(Bun.stringWidth(compact)).toBeLessThanOrEqual(width);
    if (width >= "engineer".length) expect(compact).toEndWith("engineer");
    else expect(compact).not.toContain("lead");
  },
);

test("Compact labels preserve distinguishing ancestor ordinals on different branches", () => {
  // The five-slot tree can contain two repeated Leads, each supervising an Engineer.
  const first = "tech-lead › tech-lead [1] › engineer";
  const second = "tech-lead › tech-lead [2] › engineer";

  const compact = [first, second].map((label) => compactSubagentLabel(label, 35));

  expect(compact[0]).not.toBe(compact[1]);
  expect(compact[0]).toContain("[1]");
  expect(compact[1]).toContain("[2]");
  for (const label of compact) {
    expect(label).toEndWith("engineer");
    expect(Bun.stringWidth(label)).toBeLessThanOrEqual(35);
  }
});

test("Legacy flat records and incomplete or cyclic ancestry remain bounded", () => {
  // Historical flat records have no ownership fields; malformed ancestry must not hang rendering.
  const runs = [
    { id: "legacy", name: "reviewer" },
    { id: "orphan", name: "qa", ownerId: "missing" },
    { id: "cycle-a", name: "a", ownerId: "cycle-b" },
    { id: "cycle-b", name: "b", ownerId: "cycle-a" },
  ];

  const labels = subagentLabels(runs);

  expect(labels.get("legacy")).toBe("reviewer");
  expect(labels.get("orphan")).toBe("qa");
  expect(labels.get("cycle-a")).toBe("b › a");
  expect(labels.get("cycle-b")).toBe("a › b");
  expect(labels.size).toBe(4);
});
