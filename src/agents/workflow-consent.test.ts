import { expect, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import type { EffectiveProfileSnapshot } from "./effective-profile.ts";
import { userCommandProvenance } from "./repair-command.ts";
import { createWorkflowDocument, validateWorkflowDocument } from "./task-workflow.ts";
import { migrateWorkflowToV2 } from "./task-workflow-store.ts";
import { previewExecution, renderConsent, validateExecutionConsent } from "./workflow-consent.ts";

function fixture() {
  const doc = migrateWorkflowToV2(
    createWorkflowDocument(
      { conversationId: "root", cwd: "/fixture", sessionFile: "/fixture/root.jsonl" },
      "11111111-1111-4111-8111-111111111111",
      0,
    ),
  );
  doc.tasks.change = {
    id: "change",
    title: "Change",
    kind: "implement",
    scope: "Update only the parser",
    dependsOn: [],
    lead: { profile: "tech-lead" },
    implementer: { profile: "engineer" },
    verifier: { profile: "qa" },
    assignmentVersion: 2,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
  };
  const profiles: Record<string, EffectiveProfileSnapshot> = Object.fromEntries(
    ["tech-lead", "engineer", "qa"].map((id) => [
      id,
      {
        id,
        descriptorVersion: 2,
        promptHash: "a".repeat(64),
        overlays: [],
        model: id === "qa" ? "openai-codex/fixture-gpt" : "claude-code/fixture-claude",
        thinking: "high",
        skills: [{ name: "verify-changes", hash: "skill-hash" }],
        toolCeiling: id === "qa" ? ["read", "bash", "mcp__browser_use__*"] : ["*"],
        verificationTools: id === "qa" ? ["bash", "mcp__browser_use__*"] : [],
        delegation: { enabled: id === "tech-lead" },
        purpose: "execution",
        outputContractVersions: ["submit@1"],
      } satisfies EffectiveProfileSnapshot,
    ]),
  );
  const receipt = expectOk(
    previewExecution(
      doc,
      ["change"],
      "/fixture",
      profiles,
      userCommandProvenance("root", 10),
      false,
      "receipt",
    ),
  );
  doc.scheduler = { invocations: [], admissions: {}, consents: { receipt } };
  return { doc, profiles, receipt };
}

test("execution preview displays exactly the stored scope, model, effort and verification ceiling", () => {
  // Approval needs inspectable immutable facts, not just an opaque fingerprint.
  const { doc, receipt, profiles } = fixture();

  const text = expectOk(renderConsent(receipt, doc, profiles));
  const saved = JSON.parse(JSON.stringify(receipt)) as typeof receipt;

  // The durable receipt and user-visible preview identify the same actual assignments.
  expect(saved.approval).toMatchObject({
    provenance: { kind: "user-command", conversationId: "root", receivedAt: 10 },
    tasks: [
      {
        taskId: "change",
        scope: "Update only the parser",
        assignmentVersion: 2,
        implementer: "engineer",
        verifier: "qa",
      },
    ],
  });
  expect(text).toContain(`Model: ${saved.approval!.profiles.qa!.model}; effort: high`);
  expect(text).toContain("Tool ceiling: read, bash, mcp__browser_use__*");
  expect(text).toContain("Verification tools: bash, mcp__browser_use__*");
  expect(text).toContain("read-only locked-defect analysis only");
  expect(text).toContain("skills: verify-changes");
  expect(text).toContain("not an OS sandbox");
  expect(text).toContain("Approve exactly this scope: /workflow confirm receipt");
  expectOk(validateWorkflowDocument(doc));
});

test.each(["model", "toolCeiling"] as const)(
  "changed %s cannot be rendered under a previous approval",
  (field) => {
    // A view must not silently replace the profiles the user was asked to approve.
    const { doc, receipt, profiles } = fixture();
    profiles.qa = {
      ...profiles.qa!,
      ...(field === "model" ? { model: "other/new" } : { toolCeiling: ["*"] }),
    };

    const result = renderConsent(receipt, doc, profiles);

    expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
    expect(receipt.approval!.profiles.qa!.model).toBe("openai-codex/fixture-gpt");
    expect(receipt.approval!.profiles.qa!.toolCeiling).toEqual([
      "read",
      "bash",
      "mcp__browser_use__*",
    ]);
  },
);

test("mismatched embedded approval facts fail closed despite an unchanged fingerprint", () => {
  // Human-readable receipt details cannot contradict the authority fingerprint.
  const { doc, receipt, profiles } = fixture();
  receipt.approval!.tasks[0]!.scope = "Unapproved write";

  const result = validateExecutionConsent(doc, receipt, "/fixture", profiles);

  expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
});

test("legacy receipts remain valid without invented embedded approval facts", () => {
  // Existing v2 receipts were protected by a fingerprint but lack inspectable snapshots.
  const { doc, receipt, profiles } = fixture();
  delete receipt.approval;

  const result = renderConsent(receipt, doc, profiles);

  expectOk(validateWorkflowDocument(doc));
  expect(expectOk(result)).toContain("openai-codex/fixture-gpt");
  expect(receipt.approval).toBeUndefined();
});

test("receipt provenance and embedded task/profile references are validated before storage", () => {
  // A syntactically valid receipt must still belong to its recorded user and task scope.
  const { doc, receipt } = fixture();
  receipt.approval!.provenance.conversationId = "other";

  const result = validateWorkflowDocument(doc);

  expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
});
