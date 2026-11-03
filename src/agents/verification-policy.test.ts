import { expect, test } from "bun:test";
import { expectError, expectOk } from "../testing/results.ts";
import { userCommandProvenance } from "./repair-command.ts";
import {
  createWorkflowDocument,
  renderWorkflowStatus,
  renderHumanHandoff,
  renderRootSummary,
  validateWorkflowDocument,
  type WorkflowBinding,
  type WorkflowDocument,
  type WorkflowTask,
} from "./task-workflow.ts";
import {
  addContinuationMember,
  admitRepair,
  continueTask,
  declareScope,
  declareSubtasks,
  isTaskLead,
  humanCancel,
  humanRecheck,
  pendingDeliveries,
  publishPlanArtifact,
  reassign,
  recordAnalysis,
  recordFinding,
  recordVerdict,
  recoverWorkflow,
  splitTask,
  submitFix,
  submitImplementation,
  type WorkflowEvent,
} from "./verification-policy.ts";

const workflowId = "11111111-1111-4111-8111-111111111111";
let sequence = 0;
const event = (): WorkflowEvent => ({
  eventKey: `event-${++sequence}`,
  at: 1000 + sequence,
});
function task(id = "task-primary"): WorkflowTask {
  return {
    id,
    title: "Implement safely",
    kind: "implement",
    scope: "Owned files",
    dependsOn: [],
    lead: { profile: "lead" },
    implementer: { profile: "engineer" },
    verifier: { profile: "qa" },
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
  };
}
function fixture(): WorkflowDocument {
  const doc = createWorkflowDocument(
    {
      conversationId: "origin",
      cwd: "/work",
      sessionFile: "/work/origin.jsonl",
    },
    workflowId,
    0,
  );
  doc.tasks["task-primary"] = task();
  return doc;
}
function binding(
  doc: WorkflowDocument,
  role: WorkflowBinding["role"],
  taskId = "task-primary",
): WorkflowBinding {
  return {
    workflowId: doc.workflowId,
    taskId,
    role,
    assignmentVersion: doc.tasks[taskId]!.assignmentVersion,
  };
}
function discovered(doc = fixture()): WorkflowDocument {
  return expectOk(
    recordFinding(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "defect-primary",
      revision: 0,
      summary: "Incorrect result",
      evidence: "qa-log-0",
    }),
  ).doc;
}
function authorized(doc: WorkflowDocument, attemptId = "attempt-1"): WorkflowDocument {
  return expectOk(
    admitRepair(doc, {
      ...event(),
      binding: binding(doc, "lead"),
      defectId: "defect-primary",
      attemptId,
    }),
  ).doc;
}
function submitted(doc: WorkflowDocument, attemptId = "attempt-1"): WorkflowDocument {
  const admitted = authorized(doc, attemptId);
  return expectOk(
    submitFix(admitted, {
      ...event(),
      binding: binding(admitted, "implementer"),
      defectId: "defect-primary",
      attemptId,
    }),
  ).doc;
}
function failed(doc: WorkflowDocument, attemptId: string): WorkflowDocument {
  const ready = submitted(doc, attemptId);
  return expectOk(
    recordVerdict(ready, {
      ...event(),
      binding: binding(ready, "verifier"),
      defectId: "defect-primary",
      attemptId,
      revision: ready.tasks["task-primary"]!.artifactRevision,
      verdict: "fail",
      evidence: `qa-${attemptId}`,
    }),
  ).doc;
}
function locked(): WorkflowDocument {
  let doc = discovered();
  for (let index = 1; index <= 3; index++) doc = failed(doc, `attempt-${index}`);
  return doc;
}

test("Q04 discovery starts at zero and the third automated failure atomically locks analysis", () => {
  // Discovery is not a repair attempt and must not spend the retry budget.
  const original = fixture();
  let doc = discovered(original);
  expect(doc.defects["defect-primary"]!.automatedFailures).toBe(0);
  expect(original.defects).toEqual({});

  // Each committed automated fail consumes exactly one of the three attempts.
  for (let index = 1; index <= 3; index++) {
    doc = failed(doc, `attempt-${index}`);
    expect(doc.defects["defect-primary"]!.automatedFailures).toBe(index);
    expect(doc.defects["defect-primary"]!.locked).toBe(index === 3);
  }
  const fourth = admitRepair(doc, {
    ...event(),
    binding: binding(doc, "implementer"),
    defectId: "defect-primary",
    attemptId: "attempt-4",
  });

  // Lock and analysis ownership are visible in the same document, before any fourth launch.
  expect(doc.defects["defect-primary"]!.state).toBe("analysis-pending");
  expect(doc.tasks["task-primary"]!.status).toBe("analysis-pending");
  expect(expectError(fourth).code).toBe("WORKFLOW_REPAIR_LOCKED");
  expect(pendingDeliveries(doc)).toContainEqual({
    kind: "notify-leads",
    taskIds: ["task-primary"],
    profiles: ["lead"],
    defectId: "defect-primary",
  });
});

test.each(["wrong-role", "old-assignment", "other-workflow"])(
  "Q05 %s verdict has no authority",
  (kind) => {
    // The host binding identifies both the workflow and the current assignment generation.
    const doc = submitted(discovered());
    const auth = binding(doc, "verifier");
    if (kind === "wrong-role") auth.role = "worker";
    if (kind === "old-assignment") auth.assignmentVersion--;
    if (kind === "other-workflow") auth.workflowId = "other";
    const before = structuredClone(doc);

    const result = recordVerdict(doc, {
      ...event(),
      binding: auth,
      defectId: "defect-primary",
      attemptId: "attempt-1",
      revision: 1,
      verdict: "fail",
      evidence: "qa",
    });

    // Unauthorized verdicts cannot spend a retry or alter safety facts.
    expect(expectError(result).code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(doc).toEqual(before);
  },
);

test("Q05 stale revisions are committed as information without counting or notifications", () => {
  // An older verifier can report after a newer implementation was submitted.
  const doc = submitted(discovered());
  const command = {
    ...event(),
    binding: binding(doc, "verifier"),
    defectId: "defect-primary",
    attemptId: "attempt-1",
    revision: 0,
    verdict: "fail" as const,
    evidence: "old-qa",
  };

  const result = expectOk(recordVerdict(doc, command));

  // The host can display WORKFLOW_STALE after persisting the deduplication receipt.
  expect(result.outcome).toEqual({ kind: "stale", code: "WORKFLOW_STALE" });
  expect(result.doc.processed[command.eventKey]!.outcome).toEqual(result.outcome);
  expect(result.doc.defects["defect-primary"]!.automatedFailures).toBe(0);
  expect(result.doc.defects["defect-primary"]!.attempts[0]!.verdicts).toEqual([]);
});

test.each(["pass", "fail"] as const)(
  "Q06 blocked then %s is terminal and retries cannot change that outcome",
  (verdict) => {
    // Blocked is evidence of an incomplete check, not a failed repair.
    let doc = submitted(discovered());
    const base = {
      binding: binding(doc, "verifier"),
      defectId: "defect-primary",
      attemptId: "attempt-1",
      revision: 1,
      evidence: "qa",
    };
    doc = expectOk(recordVerdict(doc, { ...event(), ...base, verdict: "blocked" })).doc;
    expect(doc.defects["defect-primary"]!.automatedFailures).toBe(0);
    expect(doc.defects["defect-primary"]!.attempts[0]!.terminal).toBeUndefined();

    const command = { ...event(), ...base, verdict };
    const result = expectOk(recordVerdict(doc, command));
    const duplicate = expectOk(recordVerdict(result.doc, command));
    const conflicting = expectOk(
      recordVerdict(result.doc, {
        ...event(),
        ...base,
        verdict: verdict === "pass" ? "fail" : "pass",
      }),
    );

    // Both repeated delivery and a new event against a terminal attempt preserve its first verdict.
    expect(duplicate.doc).toEqual(result.doc);
    expect(duplicate.outcome).toEqual(result.outcome);
    expect(conflicting.outcome.terminal).toBe(verdict);
    expect(conflicting.doc.defects["defect-primary"]!.automatedFailures).toBe(
      verdict === "fail" ? 1 : 0,
    );
    expect(conflicting.doc.defects["defect-primary"]!.attempts[0]!.verdicts).toHaveLength(2);
    expect(result.doc.tasks["task-primary"]!.status).toBe(verdict === "pass" ? "verified" : "open");
  },
);

test("Q07 cancelling a blocked attempt never resolves or verifies it", () => {
  // Human cancellation is distinct from a successful QA recheck.
  let doc = submitted(discovered());
  doc = expectOk(
    recordVerdict(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "defect-primary",
      attemptId: "attempt-1",
      revision: 1,
      verdict: "blocked",
      evidence: "missing dependency",
    }),
  ).doc;

  const cancelled = expectOk(
    humanCancel(doc, {
      ...event(),
      provenance: userCommandProvenance("origin", 2000),
      id: "task-primary",
    }),
  ).doc;

  expect(cancelled.tasks["task-primary"]!.status).toBe("cancelled");
  expect(cancelled.defects["defect-primary"]!.state).toBe("cancelled");
  expect(cancelled.defects["defect-primary"]!.automatedFailures).toBe(0);
  expect(cancelled.defects["defect-primary"]!.attempts[0]!.terminal).toBeUndefined();
});

test("Q09 reassignment, splitting and task continuation share the same locked defect", () => {
  // New task identities must not manufacture a new repair budget.
  let doc = locked();
  const oldBinding = binding(doc, "verifier");

  doc = expectOk(
    reassign(doc, {
      ...event(),
      taskId: "task-primary",
      role: "verifier",
      profile: "new-qa",
    }),
  ).doc;
  doc = expectOk(
    splitTask(doc, {
      ...event(),
      taskId: "task-primary",
      task: task("task-split"),
    }),
  ).doc;
  doc = expectOk(
    continueTask(doc, {
      ...event(),
      taskId: "task-split",
      task: task("task-next"),
    }),
  ).doc;

  const defect = doc.defects["defect-primary"]!;
  expect(defect.responsibleTasks).toEqual(["task-primary", "task-split", "task-next"]);
  expect(defect.automatedFailures).toBe(3);
  expect(defect.locked).toBe(true);
  expect(doc.tasks["task-split"]!.splitFrom).toBe("task-primary");
  expect(doc.tasks["task-next"]!.continues).toBe("task-split");
  expect(
    expectError(
      recordFinding(doc, {
        ...event(),
        binding: oldBinding,
        defectId: "other",
        revision: 3,
        summary: "Other",
        evidence: "qa",
      }),
    ).code,
  ).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(
    expectError(
      admitRepair(doc, {
        ...event(),
        binding: binding(doc, "lead", "task-next"),
        defectId: defect.id,
        attemptId: "fourth",
      }),
    ).code,
  ).toBe("WORKFLOW_REPAIR_LOCKED");
});

test.each(["implementer", "lead"] as const)(
  "Q09 %s reassignment keeps a submitted fix awaiting QA",
  (role) => {
    // Submitted artifacts outlive the implementer or lead who produced them.
    const doc = submitted(discovered());

    const reassigned = expectOk(
      reassign(doc, {
        ...event(),
        taskId: "task-primary",
        role,
        profile: "replacement",
      }),
    );
    const passed = expectOk(
      recordVerdict(reassigned.doc, {
        ...event(),
        binding: binding(reassigned.doc, "verifier"),
        defectId: "defect-primary",
        attemptId: "attempt-1",
        revision: 1,
        verdict: "pass",
        evidence: "replacement-qa",
      }),
    ).doc;

    // The new assignment generation can finish the mandatory check without another repair.
    expect(reassigned.doc.tasks["task-primary"]!.assignmentVersion).toBe(1);
    expect(reassigned.doc.tasks["task-primary"]!.verification).toEqual({
      state: "awaiting-qa",
      revision: 1,
    });
    expect(reassigned.doc.defects["defect-primary"]!.attempts).toEqual(
      doc.defects["defect-primary"]!.attempts,
    );
    expect(reassigned.effects).toContainEqual({
      kind: "notify-qa",
      taskIds: ["task-primary"],
      profiles: ["qa"],
    });
    expect(passed.defects["defect-primary"]!.state).toBe("resolved");
    expect(passed.defects["defect-primary"]!.automatedFailures).toBe(0);
    expect(passed.tasks["task-primary"]!.status).toBe("verified");
  },
);

test("Q09 verifier reassignment revokes the old binding and the new verifier can verdict", () => {
  // A verifier replacement changes authority, not the submitted artifact awaiting review.
  const doc = submitted(discovered());
  const oldBinding = binding(doc, "verifier");
  const reassigned = expectOk(
    reassign(doc, {
      ...event(),
      taskId: "task-primary",
      role: "verifier",
      profile: "new-qa",
    }),
  );
  const verdict = {
    defectId: "defect-primary",
    attemptId: "attempt-1",
    revision: 1,
    verdict: "fail" as const,
    evidence: "new-qa-log",
  };

  const rejected = recordVerdict(reassigned.doc, {
    ...event(),
    ...verdict,
    binding: oldBinding,
  });
  const accepted = expectOk(
    recordVerdict(reassigned.doc, {
      ...event(),
      ...verdict,
      binding: binding(reassigned.doc, "verifier"),
    }),
  ).doc;

  // Only the current verifier consumes the pending attempt and its failure budget.
  expect(expectError(rejected).code).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(reassigned.doc.tasks["task-primary"]!.assignmentVersion).toBe(1);
  expect(reassigned.doc.tasks["task-primary"]!.verification.state).toBe("awaiting-qa");
  expect(reassigned.doc.defects["defect-primary"]!.attempts).toEqual(
    doc.defects["defect-primary"]!.attempts,
  );
  expect(reassigned.effects).toContainEqual({
    kind: "notify-qa",
    taskIds: ["task-primary"],
    profiles: ["new-qa"],
  });
  expect(accepted.defects["defect-primary"]!.automatedFailures).toBe(1);
  expect(accepted.defects["defect-primary"]!.attempts[0]!.terminal).toBe("fail");
});

test("Q09 verifier reassignment leaves an authorized implementer attempt active", () => {
  // Replacing QA must not cancel a repair that has not reached submission yet.
  const doc = authorized(discovered());

  const reassigned = expectOk(
    reassign(doc, {
      ...event(),
      taskId: "task-primary",
      role: "verifier",
      profile: "new-qa",
    }),
  ).doc;
  const submitted = expectOk(
    submitFix(reassigned, {
      ...event(),
      binding: binding(reassigned, "implementer"),
      defectId: "defect-primary",
      attemptId: "attempt-1",
    }),
  ).doc;

  // A current implementer binding can still submit the original authorized attempt.
  expect(reassigned.defects["defect-primary"]!.attempts).toEqual(
    doc.defects["defect-primary"]!.attempts,
  );
  expect(submitted.defects["defect-primary"]!.attempts[0]!.status).toBe("submitted");
  expect(submitted.defects["defect-primary"]!.automatedFailures).toBe(0);
});

test("Q11 every responsible lead must publish analysis before notifying the root", () => {
  // A split defect requires independent analysis from each responsible lead.
  let doc = expectOk(
    splitTask(locked(), {
      ...event(),
      taskId: "task-primary",
      task: { ...task("task-secondary"), lead: { profile: "other-lead" } },
    }),
  ).doc;
  const analysis = {
    reproduction: "Run the failing case",
    attempts: "attempt-1, attempt-2, attempt-3: qa-log refs",
    causes: [{ text: "Race suspected", status: "hypothesis" as const }],
    remedies: ["Serialize the writer"],
    humanDecisions: ["Approve scope expansion"],
  };

  const partial = expectOk(
    recordAnalysis(doc, {
      ...event(),
      binding: { ...binding(doc, "lead"), purpose: "analysis" },
      defectId: "defect-primary",
      analysis,
    }),
  );
  doc = expectOk(
    recordAnalysis(partial.doc, {
      ...event(),
      binding: binding(partial.doc, "lead", "task-secondary"),
      defectId: "defect-primary",
      analysis,
    }),
  ).doc;

  expect(partial.doc.defects["defect-primary"]!.state).toBe("analysis-pending");
  expect(partial.effects.some((effect) => effect.kind === "notify-root")).toBe(false);
  expect(doc.defects["defect-primary"]!.state).toBe("human-required");
  expect(doc.defects["defect-primary"]!.locked).toBe(true);
  expect(pendingDeliveries(doc).some((effect) => effect.kind === "notify-root")).toBe(true);
  expect(renderWorkflowStatus(doc)).toContain("Approve scope expansion");
  expect(doc.tasks["task-primary"]!.status).not.toBe("verified");
});

test("Q14 manual recheck increments revision, is idempotent while awaiting QA and never restores automated budget", () => {
  // Manual work is human-owned after the automated budget is exhausted.
  const doc = locked();
  const provenance = userCommandProvenance("origin", 2000);

  const manual = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance,
      id: "defect-primary",
      attemptId: "manual-1",
      worktreeFingerprint: "tree-sha",
    }),
  ).doc;
  const repeated = expectOk(
    humanRecheck(manual, {
      ...event(),
      provenance,
      id: "task-primary",
      attemptId: "manual-2",
    }),
  ).doc;
  const failedManual = expectOk(
    recordVerdict(repeated, {
      ...event(),
      binding: binding(repeated, "verifier"),
      defectId: "defect-primary",
      attemptId: "manual-1",
      revision: 4,
      verdict: "fail",
      evidence: "manual-qa",
    }),
  ).doc;

  expect(manual.tasks["task-primary"]!.artifactRevision).toBe(4);
  expect(repeated.defects["defect-primary"]!.attempts).toHaveLength(4);
  expect(failedManual.defects["defect-primary"]!.automatedFailures).toBe(3);
  expect(failedManual.defects["defect-primary"]!.locked).toBe(true);
  expect(failedManual.defects["defect-primary"]!.state).toBe("human-required");
  expect(
    expectError(
      admitRepair(failedManual, {
        ...event(),
        binding: binding(failedManual, "lead"),
        defectId: "defect-primary",
        attemptId: "fourth-auto",
      }),
    ).code,
  ).toBe("WORKFLOW_REPAIR_LOCKED");
});

test("Q16 restart recovery keeps a submitted fix verifiable and counts its later failure once", () => {
  // A durable submission still needs its assigned verifier after the host restarts.
  const doc = submitted(discovered());
  const verifier = binding(doc, "verifier");

  const recovered = expectOk(recoverWorkflow(doc, event()));
  const command = {
    ...event(),
    binding: verifier,
    defectId: "defect-primary",
    attemptId: "attempt-1",
    revision: 1,
    verdict: "fail" as const,
    evidence: "post-restart-qa",
  };
  const failed = expectOk(recordVerdict(recovered.doc, command));
  const replayed = expectOk(recordVerdict(failed.doc, command));
  const repeated = expectOk(recordVerdict(replayed.doc, { ...command, ...event() }));

  // Recovery reissues QA delivery without interrupting or counting a submitted fix.
  expect(recovered.doc.tasks["task-primary"]!.assignmentVersion).toBe(0);
  expect(recovered.doc.tasks["task-primary"]!.verification).toEqual({
    state: "awaiting-qa",
    revision: 1,
  });
  expect(recovered.doc.defects["defect-primary"]!.attempts).toEqual(
    doc.defects["defect-primary"]!.attempts,
  );
  expect(recovered.doc.defects["defect-primary"]!.automatedFailures).toBe(0);
  expect(recovered.effects).toEqual([
    { kind: "notify-qa", taskIds: ["task-primary"], profiles: ["qa"] },
  ]);
  expect(pendingDeliveries(recovered.doc)).toEqual(recovered.effects);
  expect(replayed.doc).toEqual(failed.doc);
  expect(repeated.outcome.kind).toBe("terminal");
  expect(repeated.doc.defects["defect-primary"]!.automatedFailures).toBe(1);
  expect(repeated.doc.defects["defect-primary"]!.attempts[0]!.verdicts).toHaveLength(1);
});

test.each([
  ["recover", 0],
  ["recover", 2],
  ["implementer", 0],
  ["implementer", 2],
  ["lead", 0],
  ["lead", 2],
] as const)(
  "Q09/Q16 %s interrupts authorized work after %i failures and permits readmission without resetting the budget",
  (operation, failures) => {
    // An unsubmitted repair may be interrupted even when only one failed recheck remains.
    let doc = discovered();
    for (let index = 1; index <= failures; index++) doc = failed(doc, `attempt-${index}`);
    doc = authorized(doc, "interrupted-attempt");

    const interrupted = expectOk(
      operation === "recover"
        ? recoverWorkflow(doc, event())
        : reassign(doc, {
            ...event(),
            taskId: "task-primary",
            role: operation,
            profile: "replacement",
          }),
    );
    const next = failed(interrupted.doc, "replacement-attempt");

    // Interruption emits attention but spends no retry; only the replacement's QA failure counts.
    const defect = interrupted.doc.defects["defect-primary"]!;
    expect(defect.attempts.at(-1)!.status).toBe("interrupted");
    expect(defect.attempts.at(-1)!.terminal).toBeUndefined();
    expect(defect.automatedFailures).toBe(failures);
    expect(defect.locked).toBe(false);
    expect(interrupted.doc.tasks["task-primary"]!.verification).toEqual({
      state: "failed",
      revision: failures,
    });
    expect(interrupted.effects).toContainEqual({
      kind: "needs-attention",
      defectId: "defect-primary",
      taskIds: ["task-primary"],
      profiles: [operation === "lead" ? "replacement" : "lead"],
    });
    expect(pendingDeliveries(interrupted.doc)).toEqual(interrupted.effects);
    expect(next.defects["defect-primary"]!.automatedFailures).toBe(failures + 1);
    expect(next.defects["defect-primary"]!.locked).toBe(failures === 2);
    if (failures === 2) {
      expect(next.defects["defect-primary"]!.state).toBe("analysis-pending");
      expect(
        expectError(
          admitRepair(next, {
            ...event(),
            binding: binding(next, "lead"),
            defectId: "defect-primary",
            attemptId: "fourth-failure",
          }),
        ).code,
      ).toBe("WORKFLOW_REPAIR_LOCKED");
    }
  },
);

test.each(["recover", "implementer", "lead", "verifier"] as const)(
  "Q09/Q16 %s preserves an existing three-failure lock",
  (operation) => {
    // Recovery and assignment changes cannot restore an exhausted repair budget.
    const doc = locked();

    const changed = expectOk(
      operation === "recover"
        ? recoverWorkflow(doc, event())
        : reassign(doc, {
            ...event(),
            taskId: "task-primary",
            role: operation,
            profile: "replacement",
          }),
    ).doc;
    const rejected = admitRepair(changed, {
      ...event(),
      binding: binding(changed, "lead"),
      defectId: "defect-primary",
      attemptId: "fourth-attempt",
    });

    // Terminal attempts retain their evidence and the fourth automated admission stays forbidden.
    expect(changed.defects["defect-primary"]!.automatedFailures).toBe(3);
    expect(changed.defects["defect-primary"]!.locked).toBe(true);
    expect(changed.defects["defect-primary"]!.attempts).toEqual(
      doc.defects["defect-primary"]!.attempts,
    );
    expect(expectError(rejected).code).toBe("WORKFLOW_REPAIR_LOCKED");
  },
);

test("Q04 initial implementation requires a verdict before becoming verified", () => {
  // Submission alone is never proof of correctness.
  const doc = fixture();

  const submitted = expectOk(
    submitImplementation(doc, {
      ...event(),
      binding: binding(doc, "implementer"),
    }),
  ).doc;
  const passed = expectOk(
    recordVerdict(submitted, {
      ...event(),
      binding: binding(submitted, "verifier"),
      revision: 1,
      verdict: "pass",
      evidence: "initial-qa",
    }),
  ).doc;

  expect(submitted.tasks["task-primary"]!.status).toBe("open");
  expect(submitted.tasks["task-primary"]!.verification.state).toBe("awaiting-qa");
  expect(passed.tasks["task-primary"]!.status).toBe("verified");
});

test("Q09 a new conversation may self-join a workflow through its direct user command", () => {
  // Existing membership is intentionally not required for the joining conversation's own command.
  const doc = fixture();
  const member = {
    conversationId: "self-joining",
    cwd: "/work",
    sessionFile: "/work/new.jsonl",
  };

  const result = expectOk(
    addContinuationMember(doc, {
      ...event(),
      provenance: userCommandProvenance(member.conversationId, 100),
      member,
    }),
  );

  expect(doc.members.some((item) => item.conversationId === member.conversationId)).toBe(false);
  expect(result.doc.members[1]).toEqual({
    ...member,
    addedAt: result.doc.log.at(-1)!.at,
    via: "user-continuation",
  });
});

test("Q09 an existing member cannot enroll a different conversation by proxy", () => {
  // Even the origin user's command cannot impersonate a new conversation's direct input.
  const doc = fixture();

  const result = addContinuationMember(doc, {
    ...event(),
    provenance: userCommandProvenance("origin", 100),
    member: {
      conversationId: "someone-else",
      cwd: "/work",
      sessionFile: "/work/other.jsonl",
    },
  });

  expect(expectError(result).code).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(doc.members).toHaveLength(1);
});

test("Q09 user continuation extends membership without copying or resetting defects", () => {
  // Only host user-command provenance may extend canonical membership.
  const doc = locked();

  const continued = expectOk(
    addContinuationMember(doc, {
      ...event(),
      provenance: userCommandProvenance("next", 100),
      member: {
        conversationId: "next",
        cwd: "/next",
        sessionFile: "/next/session.jsonl",
      },
    }),
  ).doc;

  expect(continued.defects).toEqual(doc.defects);
  expect(continued.members[1]!.via).toBe("user-continuation");
  expect(continued.workflowId).toBe(doc.workflowId);
});

test("Q11 redeclaration refreshes diagnostics without resetting task safety facts or history", () => {
  // A planning task may carry a permanent repair lock that replanning must not erase.
  let doc = discovered();
  doc.tasks["task-primary"]!.kind = "plan";
  doc.tasks["task-primary"]!.assignmentVersion = 7;
  doc.tasks["task-primary"]!.artifactRevision = 9;
  doc.tasks["task-primary"]!.planArtifact = "retained";
  doc.defects["defect-primary"]!.automatedFailures = 3;
  doc.defects["defect-primary"]!.locked = true;
  doc.defects["defect-primary"]!.state = "analysis-pending";
  const safety = structuredClone(doc.tasks["task-primary"]!);
  const defects = structuredClone(doc.defects);
  const branch = {
    id: "task-primary",
    title: "New plan",
    scope: "New files",
    lead: { profile: "new-lead" },
    dependsOn: [],
  };
  doc.manifest = { goal: "Old", updatedAt: 0, diagnostics: ["Old diagnostic"] };

  // Duplicate IDs in one command remain errors, but the first legitimate declaration updates scope.
  doc = expectOk(
    declareScope(doc, {
      ...event(),
      goal: "Replan",
      branches: [branch, branch],
      knownProfiles: ["new-lead"],
    }),
  ).doc;
  expect(doc.manifest!.diagnostics).toEqual(["Duplicate task ID: task-primary"]);
  doc = expectOk(
    declareScope(doc, {
      ...event(),
      goal: "Replan again",
      branches: [branch],
      knownProfiles: ["new-lead"],
    }),
  ).doc;

  // Assignment, verification, lock/counter ledger and artifact pointer survive unchanged.
  expect(doc.manifest!.diagnostics).toEqual([]);
  expect(doc.manifest!.branches).toEqual(["task-primary"]);
  expect(doc.tasks["task-primary"]).toEqual({
    ...safety,
    ...branch,
    declaredRevision: doc.revision,
  });
  expect(doc.defects).toEqual(defects);
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);
});

test("Q11 declarations reject canonical collisions and scope dependencies exclude historical roots", () => {
  // Existing implement tasks, subtasks, cancelled roots and defect IDs are never overwritten.
  let doc = discovered();
  doc.tasks.child = { ...task("child"), kind: "plan", parentTaskId: "task-primary" };
  doc.tasks.cancelled = { ...task("cancelled"), kind: "plan", status: "cancelled" };
  doc.tasks.old = { ...task("old"), kind: "plan", dependsOn: ["historical-missing"] };
  const original = structuredClone(doc.tasks);
  const branches = ["task-primary", "child", "cancelled", "defect-primary", "new"].map((id) => ({
    id,
    title: id,
    scope: "Owned",
    lead: { profile: "lead" },
    dependsOn: id === "new" ? ["old"] : [],
  }));

  doc = expectOk(
    declareScope(doc, { ...event(), goal: "Current", branches, knownProfiles: ["lead"] }),
  ).doc;

  for (const id of ["task-primary", "child", "cancelled", "defect-primary"])
    expect(doc.manifest!.diagnostics).toContain(`Duplicate task ID: ${id}`);
  for (const id of Object.keys(original)) expect(doc.tasks[id]).toEqual(original[id]);
  expect(doc.manifest!.diagnostics).toContain("Missing dependency: new -> old");
  expect(doc.manifest!.diagnostics.join(" ")).not.toContain("historical-missing");
});

test("Q11 publication validates host receipts and rejects non-current branches while retaining history", () => {
  // Host-only receipts must refer to one real revision of a declared dependency artifact.
  const branch = (id: string, dependsOn: string[] = []) => ({
    id,
    title: id,
    scope: "Owned",
    lead: { profile: "lead" },
    dependsOn,
  });
  let doc = expectOk(
    declareScope(fixture(), {
      ...event(),
      goal: "Current",
      branches: [branch("up"), branch("down", ["up"])],
      knownProfiles: ["lead"],
    }),
  ).doc;
  const plan = {
    schemaVersion: 1,
    goal: "Plan",
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    tasks: [
      {
        id: "inspect",
        title: "Inspect",
        agent: "main",
        dependsOn: [],
        inputs: [],
        outputs: ["Contract"],
        acceptanceCriteria: ["Reviewed"],
        files: [],
      },
    ],
  };
  const command = (id: string) => ({
    ...event(),
    binding: binding(doc, "lead", id),
    artifactId: `${id}-plan`,
    plan,
    review: { summary: "Reviewed", warnings: [] },
    author: { runId: "run", profile: "lead", role: "lead" as const },
  });
  doc = expectOk(publishPlanArtifact(doc, command("up"))).doc;
  const receipt = { artifactId: "up-plan", revision: 1 };

  for (const reviewedDependencies of [
    [{ ...receipt, revision: 2 }],
    [{ artifactId: "absent", revision: 1 }],
    [receipt, receipt],
  ])
    expect(
      expectError(publishPlanArtifact(doc, { ...command("down"), reviewedDependencies })).code,
    ).toBe("WORKFLOW_CONFLICT");
  expect(
    expectError(publishPlanArtifact(doc, { ...command("up"), reviewedDependencies: [receipt] }))
      .code,
  ).toBe("WORKFLOW_CONFLICT");
  doc = expectOk(
    publishPlanArtifact(doc, { ...command("down"), reviewedDependencies: [receipt] }),
  ).doc;
  expect(doc.artifacts["down-plan"]!.revisions[0]!.dependencies).toEqual([receipt]);
  expect(doc.artifacts["down-plan"]!.revisions[0]!.docRevision).toBe(doc.revision);
  doc = expectOk(
    declareScope(doc, {
      ...event(),
      goal: "Different",
      branches: [branch("other")],
      knownProfiles: ["lead"],
    }),
  ).doc;
  const denied = expectError(publishPlanArtifact(doc, command("down")));
  expect(denied.code).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(denied.message).toBe("Task is not in the current planning scope.");
  expect(doc.artifacts["down-plan"]!.revisions).toHaveLength(1);
});

test("Q11 scope diagnostics are durable and only a planning lead can publish reviewed artifacts", () => {
  // Diagnostics retain invalid branch relationships instead of silently discarding them.
  const doc = fixture();
  const scoped = expectOk(
    declareScope(doc, {
      ...event(),
      goal: "Plan delivery",
      knownProfiles: ["lead"],
      branches: [
        {
          id: "plan-branch",
          title: "Plan",
          scope: "Owned",
          lead: { profile: "unknown" },
          dependsOn: ["missing"],
        },
        {
          id: "plan-branch",
          title: "Duplicate",
          scope: "Owned",
          lead: { profile: "lead" },
          dependsOn: [],
        },
      ],
    }),
  ).doc;
  const plan = {
    schemaVersion: 1,
    goal: "Small plan",
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    tasks: [
      {
        id: "build",
        title: "Build",
        agent: "engineer",
        dependsOn: [],
        inputs: [],
        outputs: ["Work"],
        acceptanceCriteria: ["QA"],
        files: [],
      },
    ],
  };

  const published = expectOk(
    publishPlanArtifact(scoped, {
      ...event(),
      binding: binding(scoped, "lead", "plan-branch"),
      artifactId: "plan-ref",
      plan,
      review: { summary: "Reviewed", warnings: [] },
      author: { runId: "run", profile: "unknown", role: "lead" },
    }),
  );
  const forbidden = publishPlanArtifact(scoped, {
    ...event(),
    binding: binding(scoped, "worker", "plan-branch"),
    artifactId: "bad",
    plan,
    review: { summary: "Reviewed", warnings: [] },
    author: { runId: "run", profile: "unknown", role: "worker" },
  });

  expect(scoped.manifest!.diagnostics).toEqual(
    expect.arrayContaining([
      "Unknown profile: unknown",
      "Duplicate task ID: plan-branch",
      "Missing dependency: plan-branch -> missing",
    ]),
  );
  expect(published.outcome.ref).toBe("plan-ref@1");
  expect(published.outcome.summary).toContain("tasks: 1");
  expect(published.doc.artifacts["plan-ref"]!.revisions[0]!.author.runId).toBe("run");
  expect(expectError(forbidden).code).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(renderWorkflowStatus(published.doc)).not.toContain("acceptanceCriteria");
});

test("Q14 shared defects require a task-scoped recheck and reject another task's verifier", () => {
  // A shared ledger does not make different task revisions or verifier assignments interchangeable.
  let doc = expectOk(
    splitTask(locked(), {
      ...event(),
      taskId: "task-primary",
      task: task("task-secondary"),
    }),
  ).doc;
  const provenance = userCommandProvenance("origin", 2000);
  const ambiguous = humanRecheck(doc, {
    ...event(),
    provenance,
    id: "defect-primary",
    attemptId: "manual-shared",
  });

  doc = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance,
      id: "task-primary",
      attemptId: "manual-shared",
    }),
  ).doc;
  const otherVerifier = recordVerdict(doc, {
    ...event(),
    binding: binding(doc, "verifier", "task-secondary"),
    defectId: "defect-primary",
    attemptId: "manual-shared",
    revision: 3,
    verdict: "pass",
    evidence: "wrong task QA",
  });

  expect(expectError(ambiguous).code).toBe("WORKFLOW_CONFLICT");
  expect(expectError(ambiguous).message).toContain("/repair recheck <taskId>");
  expect(doc.tasks["task-primary"]!.artifactRevision).toBe(4);
  expect(doc.tasks["task-secondary"]!.artifactRevision).toBe(3);
  expect(doc.defects["defect-primary"]!.attempts.at(-1)!.submittedTaskId).toBe("task-primary");
  expect(expectError(otherVerifier).code).toBe("WORKFLOW_NOT_AUTHORIZED");
});

test("Q14 shared defect requires each responsible task's current QA", () => {
  // The second task passed before discovery, which must invalidate that obsolete assurance.
  let doc = fixture();
  doc.tasks["task-other"] = task("task-other");
  doc = expectOk(
    submitImplementation(doc, {
      ...event(),
      binding: binding(doc, "implementer", "task-other"),
    }),
  ).doc;
  doc = expectOk(
    recordVerdict(doc, {
      ...event(),
      binding: binding(doc, "verifier", "task-other"),
      revision: 1,
      verdict: "pass",
      evidence: "QA before shared discovery",
    }),
  ).doc;
  doc = expectOk(
    recordFinding(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "shared-defect",
      revision: 0,
      summary: "Both APIs broken",
      evidence: "Both fail",
      responsibleTasks: ["task-other"],
    }),
  ).doc;
  expect(doc.tasks["task-other"]!.verification).toEqual({
    state: "failed",
    revision: 1,
  });
  expect(doc.tasks["task-other"]!.status).not.toBe("verified");

  // Passing one task resolves only its own current revision, not the shared defect.
  const provenance = userCommandProvenance("origin", 2000);
  doc = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance,
      id: "task-primary",
      attemptId: "manual-primary",
    }),
  ).doc;
  const passedEvent = event();
  doc = expectOk(
    recordVerdict(doc, {
      ...passedEvent,
      binding: binding(doc, "verifier"),
      defectId: "shared-defect",
      attemptId: "manual-primary",
      revision: 1,
      verdict: "pass",
      evidence: "Primary API passes",
    }),
  ).doc;

  // The unresolved responsibility remains manually recheckable with fresh QA.
  expect(doc.defects["shared-defect"]!.state).toBe("human-required");
  expect(doc.defects["shared-defect"]!.resolutions).toEqual({
    "task-primary": {
      revision: 1,
      eventKey: passedEvent.eventKey,
      at: passedEvent.at,
    },
  });
  expect(doc.tasks["task-primary"]!.status).toBe("verified");
  expect(doc.tasks["task-other"]!.status).not.toBe("verified");
  expect(renderWorkflowStatus(doc, "task-primary")).toContain("blockers: none");
  expect(renderWorkflowStatus(doc, "task-other")).toContain("resolution task-other: needs QA r1");
  doc = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance,
      id: "task-other",
      attemptId: "manual-other",
    }),
  ).doc;
  expect(doc.tasks["task-other"]!.verification).toEqual({
    state: "awaiting-qa",
    revision: 2,
  });
  doc = expectOk(
    recordVerdict(doc, {
      ...event(),
      binding: binding(doc, "verifier", "task-other"),
      defectId: "shared-defect",
      attemptId: "manual-other",
      revision: 2,
      verdict: "pass",
      evidence: "Other API passes",
    }),
  ).doc;
  expect(doc.defects["shared-defect"]!.state).toBe("resolved");
  expect(doc.tasks["task-other"]!.status).toBe("verified");
  expect(expectOk(validateWorkflowDocument(doc))).toEqual(doc);
});

test("Q14 unlocked shared repairs stay open until every task has current resolution evidence", () => {
  // Discovery invalidates both tasks, but successful automated QA does not transfer manual ownership.
  let doc = fixture();
  doc.tasks["task-other"] = task("task-other");
  doc = expectOk(
    recordFinding(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "shared",
      revision: 0,
      summary: "Shared failure",
      evidence: "Initial QA",
      responsibleTasks: ["task-other"],
    }),
  ).doc;

  // The same durable defect accepts a separate admitted automated repair for each responsibility.
  for (const id of ["task-primary", "task-other"]) {
    const attemptId = `repair-${id}`;
    doc = expectOk(
      admitRepair(doc, {
        ...event(),
        binding: binding(doc, "lead", id),
        defectId: "shared",
        attemptId,
      }),
    ).doc;
    doc = expectOk(
      submitFix(doc, {
        ...event(),
        binding: binding(doc, "implementer", id),
        defectId: "shared",
        attemptId,
      }),
    ).doc;
    doc = expectOk(
      recordVerdict(doc, {
        ...event(),
        binding: binding(doc, "verifier", id),
        defectId: "shared",
        attemptId,
        revision: 1,
        verdict: "pass",
        evidence: `Current QA for ${id}`,
      }),
    ).doc;
    expect(doc.tasks[id]!.status).toBe("verified");
    expect(doc.defects.shared!.state).toBe(id === "task-primary" ? "open" : "resolved");
  }

  // Success is not a counter or lock reset; each receipt identifies its own task and revision.
  expect(Object.keys(doc.defects.shared!.resolutions!)).toEqual(["task-primary", "task-other"]);
  expect(doc.defects.shared!.locked).toBe(false);
  expect(doc.defects.shared!.automatedFailures).toBe(0);
});

test("Q14 shared manual passes and failures never reset the permanent lock or counter", () => {
  // A split shares the locked ledger but must earn its own resolution.
  let doc = expectOk(
    splitTask(locked(), {
      ...event(),
      taskId: "task-primary",
      task: task("task-other"),
    }),
  ).doc;
  const provenance = userCommandProvenance("origin", 2000);
  const recheck = (taskId: string, attemptId: string, verdict: "pass" | "fail") => {
    doc = expectOk(humanRecheck(doc, { ...event(), provenance, id: taskId, attemptId })).doc;
    doc = expectOk(
      recordVerdict(doc, {
        ...event(),
        binding: binding(doc, "verifier", taskId),
        defectId: "defect-primary",
        attemptId,
        revision: doc.tasks[taskId]!.artifactRevision,
        verdict,
        evidence: `QA ${attemptId}`,
      }),
    ).doc;
  };

  // One current pass releases its task while the other task remains human-owned.
  recheck("task-primary", "manual-primary", "pass");
  expect(doc.tasks["task-primary"]!.status).toBe("verified");
  expect(doc.defects["defect-primary"]!.state).toBe("human-required");
  recheck("task-other", "manual-other-fail", "fail");
  expect(doc.defects["defect-primary"]!.state).toBe("human-required");
  expect(doc.tasks["task-primary"]!.status).toBe("verified");
  recheck("task-other", "manual-other-pass", "pass");

  // Resolution closes the defect, not its immutable repair history.
  expect(doc.defects["defect-primary"]!.state).toBe("resolved");
  expect(doc.defects["defect-primary"]!.locked).toBe(true);
  expect(doc.defects["defect-primary"]!.automatedFailures).toBe(3);
});

test("Q14 cancelled shared responsibilities do not cancel another task's required QA", () => {
  // Cancelling one responsibility cannot pretend the remaining task passed.
  let doc = expectOk(
    splitTask(discovered(), {
      ...event(),
      taskId: "task-primary",
      task: task("task-other"),
    }),
  ).doc;
  const provenance = userCommandProvenance("origin", 2000);

  doc = expectOk(humanCancel(doc, { ...event(), provenance, id: "task-other" })).doc;
  expect(doc.defects["defect-primary"]!.state).toBe("open");
  doc = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance,
      id: "task-primary",
      attemptId: "manual-primary",
    }),
  ).doc;
  doc = expectOk(
    recordVerdict(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "defect-primary",
      attemptId: "manual-primary",
      revision: 1,
      verdict: "pass",
      evidence: "Current QA",
    }),
  ).doc;

  // Only non-cancelled tasks must supply a current resolution.
  expect(doc.defects["defect-primary"]!.state).toBe("resolved");
  expect(doc.tasks["task-primary"]!.status).toBe("verified");
  expect(doc.tasks["task-other"]!.status).toBe("cancelled");
});

test.each([splitTask, continueTask])(
  "Q09 linked tasks cannot inherit a resolved responsibility's QA",
  (link) => {
    // The original task has already earned its current revision's resolution.
    let doc = submitted(discovered());
    doc = expectOk(
      recordVerdict(doc, {
        ...event(),
        binding: binding(doc, "verifier"),
        defectId: "defect-primary",
        attemptId: "attempt-1",
        revision: 1,
        verdict: "pass",
        evidence: "Original QA",
      }),
    ).doc;

    doc = expectOk(
      link(doc, {
        ...event(),
        taskId: "task-primary",
        task: task("task-linked"),
      }),
    ).doc;

    // The original stays verified, but the new identity needs a fresh check and has no resolution.
    expect(doc.tasks["task-primary"]!.status).toBe("verified");
    expect(doc.tasks["task-linked"]!.status).not.toBe("verified");
    expect(doc.tasks["task-linked"]!.verification).toEqual({
      state: "failed",
      revision: 1,
    });
    expect(doc.defects["defect-primary"]!.resolutions?.["task-linked"]).toBeUndefined();
    expect(doc.defects["defect-primary"]!.state).toBe("open");
  },
);

test("Q11 human handoff contains every attempt, verdict evidence, remedies and decisions", () => {
  // All three automated attempts and complete lead analyses belong in the human packet.
  let doc = locked();
  const fullText = `${"evidence ".repeat(100)}UNTRUNCATED_END`;
  doc = expectOk(
    recordAnalysis(doc, {
      ...event(),
      binding: binding(doc, "lead"),
      defectId: "defect-primary",
      analysis: {
        reproduction: `Reproduce ${fullText}`,
        attempts: `All attempts ${fullText}`,
        causes: [
          { text: "Confirmed cause", status: "verified" },
          { text: "Possible cause", status: "hypothesis" },
        ],
        remedies: [`Remedy ${fullText}`],
        humanDecisions: [`Decision ${fullText}`],
      },
    }),
  ).doc;

  const handoff = expectOk(renderHumanHandoff(doc, "defect-primary"));
  const summary = renderRootSummary(doc, "defect-primary");

  // The compact surface points at details; the detailed surface never applies display truncation.
  for (const attempt of doc.defects["defect-primary"]!.attempts) {
    expect(handoff).toContain(
      `Attempt ${attempt.id}: origin=automated task=task-primary status=closed submittedRevision=${attempt.submittedRevision} terminal=fail`,
    );
    for (const verdict of attempt.verdicts) {
      expect(handoff).toContain(
        `eventKey=${verdict.eventKey} verdict=fail revision=${verdict.revision}`,
      );
      expect(handoff).toContain(verdict.evidence);
    }
  }
  expect(handoff).toContain(`Reproduction: Reproduce ${fullText}`);
  expect(handoff).toContain(`Attempts: All attempts ${fullText}`);
  expect(handoff).toContain(`Remedy: Remedy ${fullText}`);
  expect(handoff).toContain(`Human decision: Decision ${fullText}`);
  expect(handoff).toContain("Cause (verified): Confirmed cause");
  expect(handoff).toContain("Cause (hypothesis): Possible cause");
  expect(handoff).toContain("Discovery: eventKey=");
  expect(handoff).toContain("revision=0; evidence: qa-log-0");
  expect(handoff).toContain("lock: LOCKED; automatedFailures: 3/3");
  expect(handoff).toContain("/repair recheck task-primary");
  expect(handoff).toContain("/repair cancel defect-primary");
  expect(summary.length).toBeLessThanOrEqual(2000);
  expect(summary).toContain("Analyses: 1/1; decisions: 1");
  expect(summary).toContain("handoff: /repair status defect-primary");
  expect(summary).not.toContain(fullText);
  expect(renderWorkflowStatus(doc)).toContain("attempts: 3; remedies: 1");
  expect(renderWorkflowStatus(doc)).toContain("handoff: /repair status defect-primary");
});

test("Q11 human handoff sanitizes controls, reports missing IDs and names bounded durable evidence", () => {
  // Full evidence may exceed the handoff transport budget, but must remain retrievable.
  const doc = locked();
  doc.defects["defect-primary"]!.evidence = `safe\u001b[31m${"x".repeat(61000)}`;

  const handoff = expectOk(renderHumanHandoff(doc, "defect-primary"));

  // The hard bound is explicit, rather than silently dropping the omitted package.
  expect(handoff.length).toBeLessThanOrEqual(60000);
  expect(handoff).not.toContain("\u001b");
  expect(handoff).toContain(
    "[Truncated; complete durable evidence: /work/origin.jsonl.workflow.json]",
  );
  expect(expectError(renderHumanHandoff(doc, "missing")).code).toBe("WORKFLOW_NOT_FOUND");
});

test("Q14 task recheck creates one manual attempt for every unresolved defect", () => {
  // One submitted worktree revision can address multiple blocking findings without losing either ledger.
  let doc = discovered();
  doc = expectOk(
    recordFinding(doc, {
      ...event(),
      binding: binding(doc, "verifier"),
      defectId: "defect-other",
      revision: 0,
      summary: "Second issue",
      evidence: "qa-other",
    }),
  ).doc;

  const rechecked = expectOk(
    humanRecheck(doc, {
      ...event(),
      provenance: userCommandProvenance("origin", 2000),
      id: "task-primary",
      attemptId: "manual-both",
    }),
  ).doc;

  expect(rechecked.tasks["task-primary"]!.artifactRevision).toBe(1);
  for (const defect of Object.values(rechecked.defects)) {
    expect(defect.attempts).toHaveLength(1);
    expect(defect.attempts[0]!.submittedRevision).toBe(1);
    expect(defect.attempts[0]!.submittedTaskId).toBe("task-primary");
    expect(defect.automatedFailures).toBe(0);
  }
});

test("Q09 declared subtasks inherit their parent lead but not its defect budget", () => {
  // Planning decomposition is distinct from splitting or continuing an already defective task.
  const doc = locked();
  const subtask = {
    id: "child-plan",
    title: "Child plan",
    kind: "plan" as const,
    scope: "Narrower",
    dependsOn: [],
  };

  const declared = expectOk(
    declareSubtasks(doc, {
      ...event(),
      binding: binding(doc, "lead"),
      parentTaskId: "task-primary",
      subtasks: [subtask],
      knownProfiles: ["lead"],
    }),
  ).doc;
  const nested = expectOk(
    declareSubtasks(declared, {
      ...event(),
      parentTaskId: "child-plan",
      subtasks: [{ ...subtask, id: "grandchild" }],
      knownProfiles: ["lead"],
    }),
  ).doc;

  expect(declared.tasks["child-plan"]!.parentTaskId).toBe("task-primary");
  expect(declared.tasks["child-plan"]!.lead).toEqual({ profile: "lead" });
  expect(declared.defects["defect-primary"]!.responsibleTasks).toEqual(["task-primary"]);
  expect(isTaskLead(nested, binding(nested, "lead"), "grandchild")).toBe(true);
  expect(isTaskLead(nested, binding(nested, "lead", "grandchild"), "task-primary")).toBe(false);
  expect(
    isTaskLead(nested, { ...binding(nested, "lead"), assignmentVersion: -1 }, "grandchild"),
  ).toBe(false);
  expect(isTaskLead(nested, binding(nested, "worker"), "grandchild")).toBe(false);
});

test("Q11 subtask declarations preserve diagnostics and reject non-parent bindings", () => {
  // A lead can inspect descendants but only the immediate parent lead can declare their children.
  const doc = fixture();
  const child = {
    id: "child",
    title: "Child",
    kind: "implement" as const,
    scope: "Owned",
    dependsOn: ["missing"],
    implementer: { profile: "unknown" },
  };
  const declared = expectOk(
    declareSubtasks(doc, {
      ...event(),
      parentTaskId: "task-primary",
      subtasks: [child, child],
      knownProfiles: ["lead"],
    }),
  ).doc;

  const rejected = declareSubtasks(declared, {
    ...event(),
    binding: binding(declared, "lead"),
    parentTaskId: "child",
    subtasks: [{ ...child, id: "grandchild" }],
    knownProfiles: ["lead"],
  });
  const cyclic = expectOk(
    declareSubtasks(declared, {
      ...event(),
      parentTaskId: "task-primary",
      subtasks: [
        { ...child, id: "cycle-a", dependsOn: ["cycle-b"] },
        { ...child, id: "cycle-b", dependsOn: ["cycle-a"] },
      ],
      knownProfiles: ["lead"],
    }),
  ).doc;

  expect(declared.manifest!.diagnostics).toContain("Duplicate task ID: child");
  expect(declared.manifest!.diagnostics).toContain("Unknown profile: unknown");
  expect(declared.manifest!.diagnostics).toContain("Missing dependency: child -> missing");
  expect(expectError(rejected).code).toBe("WORKFLOW_NOT_AUTHORIZED");
  expect(
    cyclic.manifest!.diagnostics.some((message) => message.startsWith("Dependency cycle")),
  ).toBe(true);
});
