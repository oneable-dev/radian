import { Type, type Static } from "typebox";
import { strictEffectiveProfileSnapshotSchema } from "./effective-profile.ts";

const id = Type.String({ minLength: 1, maxLength: 4096 });
export const workflowApprovalSchema = Type.Object(
  {
    tasks: Type.Array(
      Type.Object(
        {
          taskId: id,
          scope: Type.String(),
          dependsOn: Type.Array(id),
          assignmentVersion: Type.Integer({ minimum: 0 }),
          lead: id,
          implementer: id,
          verifier: id,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
    profiles: Type.Record(id, strictEffectiveProfileSnapshotSchema, {
      additionalProperties: false,
    }),
    provenance: Type.Object(
      {
        kind: Type.Literal("user-command"),
        conversationId: id,
        receivedAt: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WorkflowApproval = Static<typeof workflowApprovalSchema>;
export const workflowConsentSchema = Type.Object(
  {
    id,
    conversationId: id,
    workflowId: id,
    worktree: id,
    taskIds: Type.Array(id, { minItems: 1, maxItems: 128, uniqueItems: true }),
    artifactRefs: Type.Array(id, { uniqueItems: true }),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    autoRepair: Type.Boolean(),
    // Legacy v2 receipts remain readable; newly created receipts always embed display facts.
    approval: Type.Optional(workflowApprovalSchema),
    state: Type.Enum(["preview", "confirmed", "revoked"]),
    createdAt: Type.Integer({ minimum: 0 }),
    confirmedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type WorkflowConsent = Static<typeof workflowConsentSchema>;
