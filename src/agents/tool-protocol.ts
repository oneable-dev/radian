import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { Tool } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ToolProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** A small canonical example, not a replacement for the selected action's schema. */
type SchemaShape = {
  const?: unknown;
  enum?: unknown[];
  type?: string;
  required?: string[];
  properties?: Record<string, TSchema>;
  items?: TSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
};

function skeleton(input: TSchema): unknown {
  const schema = input as SchemaShape;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? []).map((key: string) => [key, skeleton(schema.properties![key]!)]),
    );
  if (schema.type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, () => skeleton(schema.items!));
  if (schema.type === "string") return "x".repeat(Math.max(1, schema.minLength ?? 1));
  if (schema.type === "boolean") return false;
  return schema.minimum ?? 0;
}

/** Read errors locally so TypeBox's raw instance paths never become JSON pointers. */
function validationPaths(schema: TSchema, value: unknown, path = ""): string[] {
  const failures = Value.Errors(schema, value);
  if (!failures.length) return [];

  const localPaths = failures.flatMap((failure) => {
    // TypeBox 1.3 emits a false-schema error for each extra key before its parent
    // additionalProperties error. The latter can be omitted by its error limit.
    if (failure.keyword === "boolean" && failure.schemaPath === "#/additionalProperties")
      return [`${path}/${pointer(failure.instancePath.slice(1))}`];
    // Child errors are handled below using structured property names and array indices.
    if (failure.instancePath !== "") return [];
    const keys =
      failure.keyword === "required"
        ? failure.params.requiredProperties
        : failure.keyword === "additionalProperties"
          ? failure.params.additionalProperties
          : [];
    return keys.length ? keys.map((key) => `${path}/${pointer(key)}`) : [path || "/"];
  });

  const paths = [...new Set(localPaths)].slice(0, 16);
  if (paths.length === 16) return paths;

  const shape = schema as SchemaShape;
  if (shape.properties && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, field] of Object.entries(shape.properties)) {
      if (Object.hasOwn(value, key))
        paths.push(...validationPaths(field, Reflect.get(value, key), `${path}/${pointer(key)}`));
      if (paths.length >= 16) return paths.slice(0, 16);
    }
  }
  if (shape.items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      paths.push(...validationPaths(shape.items, item, `${path}/${index}`));
      if (paths.length >= 16) return paths.slice(0, 16);
    }
  }
  return paths.length ? paths : [path || "/"];
}

function actionNames(schema: TObject): string[] {
  const action = schema.properties.action as { const?: string; enum?: string[] };
  return action.enum ?? [action.const!];
}

/** Provider declarations describe every field; only the host selects and enforces an action. */
export function actionToolSchema(actions: readonly TObject[]) {
  const names = actions.flatMap(actionNames);
  const properties: Record<string, TSchema> = {};
  for (const schema of actions) {
    for (const [key, field] of Object.entries(schema.properties)) {
      if (key !== "action") properties[key] ??= Type.Optional(field);
    }
  }
  // Some encoders discard root-schema metadata, so keep action examples on a property.
  const examples = actions
    .map((schema) => `${actionNames(schema).join("/")}: ${JSON.stringify(skeleton(schema))}`)
    .join("\n");
  return Type.Object(
    {
      action: Type.String({
        enum: names,
        description: `Exact action name; aliases are invalid. Canonical action shapes:\n${examples}`,
      }),
      ...properties,
    },
    { additionalProperties: false },
  );
}

export function declareActionTool<const A extends readonly TObject[]>(actions: A) {
  type Command = Static<A[number]>;
  for (const schema of actions) {
    // The provider projection includes other actions' fields; only a closed member rejects them.
    if (!("additionalProperties" in schema) || schema.additionalProperties !== false)
      throw new TypeError(`Action schema ${actionNames(schema).join("/")} must be closed.`);
  }
  const parameters = actionToolSchema(actions);
  const names = actions.flatMap(actionNames);
  const validateAction = (raw: unknown): Result<Command, ToolProtocolError> => {
    const action =
      raw !== null && typeof raw === "object" && "action" in raw ? raw.action : undefined;
    const selected = actions.find(
      (schema) => typeof action === "string" && actionNames(schema).includes(action),
    );
    if (typeof action !== "string" || !selected)
      return err(
        new ToolProtocolError(
          "TOOL_ACTION_UNKNOWN",
          `Valid actions: ${names.join(", ")}. Aliases are not accepted.`,
          ["/action"],
        ),
      );
    if (!Value.Check(selected, raw)) {
      const paths = validationPaths(selected, raw);
      return err(
        new ToolProtocolError(
          "TOOL_ACTION_FIELDS",
          `Invalid fields for ${action}.`,
          [...new Set(paths)].slice(0, 16),
          skeleton(selected),
        ),
      );
    }
    // Value.Check checks the selected member of the tuple without converting the input.
    return ok(raw as Command);
  };
  const preference = { type: "json_schema", strict: "prefer" } as const;
  // Strict conversion makes optional slots required and nullable. Such output cannot
  // satisfy a closed selected action, so do not request that incompatible encoding.
  const required = new Set<string>(parameters.required ?? []);
  const hasOptionalSlots = Object.keys(parameters.properties).some((key) => !required.has(key));
  const accepted =
    !hasOptionalSlots &&
    resolveJsonSchemaStrictSampling(
      { name: "action-tool", description: "", parameters, constrainedSampling: preference } as Tool,
      true,
    );
  return {
    parameters,
    constrainedSampling: accepted ? preference : (false as const),
    validateAction,
    actionSkeleton(action: string) {
      const selected = actions.find((schema) => actionNames(schema).includes(action));
      return selected ? skeleton(selected) : undefined;
    },
    prepareArguments(raw: unknown) {
      const result = validateAction(raw);
      // Pi 1.2 coerces values and removes optional nulls before execute. This SDK boundary
      // must reject raw failures first; an envelope would hide the action from policy hooks.
      if (!result.ok) throw result.error;
      return structuredClone(result.value);
    },
  };
}
