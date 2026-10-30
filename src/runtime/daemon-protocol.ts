import { Type, type Static } from "typebox";

export const repositoryRegistrationSchema = Type.Object(
  {
    repositoryId: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" }),
    cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" }),
    config: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" })),
  },
  { additionalProperties: false },
);

export type RepositoryRegistration = Static<typeof repositoryRegistrationSchema>;

export const daemonRegistrySchema = Type.Object(
  {
    version: Type.Literal(1),
    chatConfig: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    repositories: Type.Array(
      Type.Object(
        {
          ...repositoryRegistrationSchema.properties,
          active: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type DaemonRegistry = Static<typeof daemonRegistrySchema>;
