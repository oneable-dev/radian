import { Type } from "typebox";

const position = Type.Integer({ minimum: 0, maximum: 10000000 });
const target = Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]);
export const gitViewsSchema = Type.Record(
  Type.String(),
  Type.Object({
    tab: Type.Union([Type.Literal("commits"), Type.Literal("reflog")]),
    right: Type.Union([Type.Literal("commit"), Type.Literal("refs")]),
    refs: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("tag")]),
    reference: target,
    selected: target,
    refSelected: target,
    reflogSelected: target,
    file: target,
    diff: Type.Boolean(),
    limit: Type.Integer({ minimum: 300, maximum: 3000 }),
    historyScroll: position,
    filesScroll: position,
    refsScroll: position,
    detailsScroll: position,
    diffScroll: position,
  }),
);
