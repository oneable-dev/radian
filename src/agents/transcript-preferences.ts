import { Type, type Static } from "typebox";

const offset = Type.Integer({ minimum: 0 });
export const transcriptViewSchema = Type.Object({
  selectedId: Type.Union([Type.String(), Type.Null()]),
  folded: Type.Record(Type.String(), Type.Boolean()),
  cursors: Type.Record(Type.String(), offset),
  headingCursors: Type.Optional(Type.Record(Type.String(), offset)),
  readingHeading: Type.Optional(Type.Boolean()),
  // Distinguish displayed-text offsets from cursors saved by the old source reader.
  renderedCursors: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  mode: Type.Union([Type.Literal("sections"), Type.Literal("text"), Type.Literal("visual")]),
  anchor: Type.Union([offset, Type.Null()]),
  // Keep the existing visual wire mode readable by runtimes without linewise selection.
  linewise: Type.Optional(Type.Boolean()),
  follow: Type.Boolean(),
});
export type TranscriptViewState = Static<typeof transcriptViewSchema>;
export const agentViewsSchema = Type.Record(Type.String(), transcriptViewSchema);
export function emptyTranscriptView(): TranscriptViewState {
  return {
    selectedId: null,
    folded: {},
    cursors: {},
    mode: "sections",
    anchor: null,
    follow: true,
  };
}
