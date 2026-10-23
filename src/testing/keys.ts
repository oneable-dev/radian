import type { MockInput } from "@opentui/core/testing";
import type { CliRenderer } from "@opentui/core";

// Exercise the default command sequences rather than installing legacy test-only
// aliases that would hide regressions in the application's shipped keymap.
export function pressLeader(app: { mockInput: MockInput }, key: string): void {
  app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key);
}

// Use the shipped popup toggle without closing an already open search surface.
export function openWorkspaceSearch(app: { mockInput: MockInput; renderer: CliRenderer }): void {
  const popup = app.renderer.root.findDescendantById("workspace-sidebar");
  if (!popup?.visible) pressLeader(app, "b");
  else if (app.renderer.currentFocusedRenderable?.id !== "workspace-search") app.mockInput.pressKey("/");
}
