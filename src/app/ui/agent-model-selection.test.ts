import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand, type ModelCatalog, type ModelEffort, type ModelIdentity } from "../../agents/model-selection.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ModelSelectionError } from "../../errors.ts";
import { err, ok } from "../../result.ts";

const catalog: ModelCatalog = { conversationId: "first", current: { provider: "fixture", id: "original" }, effort: "high", models: [
  { provider: "fixture", id: "original", name: "Original model", contextWindow: 200000, images: true, reasoning: true, efforts: ["off", "low", "medium", "high"], effort: "high" },
  { provider: "other", id: "target", name: "Target model", contextWindow: 64000, images: false, reasoning: false, efforts: ["off"], effort: "off" },
] };
async function mount(overrides: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], changes: { id: string; conversation: string; model: ModelIdentity; effort?: ModelEffort }[] = [];
  let state: ExecutionState = { conversationId: "first", status: "complete", output: "Retained answer", error: null,
    telemetry: { provider: "fixture", model: "original", effort: "high", fast: false, context: null, weekly: null } };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, onPrompt: async (_id, text) => { sent.push(text); return ok(undefined); },
    onComplete: async () => ok({ items: [modelCommand], truncated: false }), getSessionDetails: () => state,
    onListModels: async () => ok(structuredClone(catalog)), onSelectModel: async (id, conversation, model, effort) => {
      changes.push({ id, conversation, model, ...(effort !== undefined ? { effort } : {}) });
      state = { ...state, telemetry: { ...state.telemetry!, provider: model.provider, model: model.id, effort: effort ?? state.telemetry!.effort } };
      selection.replaceSnapshot(selection.snapshot); return ok(null);
    }, ...overrides });
  const get = (id: string) => { const item = app.renderer.root.findDescendantById(id); if (!item) throw new Error(`Missing ${id}`); return item; };
  const prompt = get("session-prompt") as InputRenderable;
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render(); prompt.focus(); await render();
  return { ...app, view, selection, sent, changes, get, prompt, render,
    async open(text = "/model") { await app.mockInput.typeText(text); await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); },
    update(next: ExecutionState) { state = next; selection.replaceSnapshot(selection.snapshot); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("model completion opens search and changes only the selected session's model without prompting", async () => {
  // Commands open host popups instead of model requests and identify the current model.
  const app = await mount();
  try {
    await app.open("/mod");
    expect(app.get("model-picker").visible).toBe(true); expect(app.captureCharFrame()).toContain("Original model [Current]");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list"); expect(app.sent).toEqual([]);

    // Search with / from list focus; Enter applies both model and displayed effort.
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("other"); await app.render(); app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.captureCharFrame()).toContain("target"); expect(app.sent).toEqual([]); expect(app.prompt.value).toBe("");
  } finally { await app.close(); }
});

test("Large model lists pin the current model first and initial Enter never selects another model accidentally", async () => {
  const many = Array.from({ length: 205 }, (_, index) => ({ ...catalog.models[1]!, id: `extra-${index}`, name: `Extra model ${index}` }));
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [...many, ...catalog.models] }) });
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("Original model [Current]");

    // Current models beyond the display cap must remain in initial selection.
    app.mockInput.pressEnter(); await app.render();
    expect(app.changes[0]?.model).toEqual({ provider: "fixture", id: "original" });
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Model-row clicks preview only and Enter applies without buttons", async () => {
  const app = await mount();
  try {
    await app.open();
    const row = app.get('model:["other","target"]');

    // Clicking only previews; inspect effort before confirming by command.
    await app.mockMouse.click(row.x + 2, row.y); await app.render();
    expect(app.changes).toEqual([]); expect(app.get("model-picker").visible).toBe(true);
    // Separate preview from application without action rows or close icons.
    expect(app.renderer.root.findDescendantById("model-apply")).toBeUndefined();
    expect(app.renderer.root.findDescendantById("model-cancel")).toBeUndefined();
    const panel = app.get("model-dialog");
    expect(app.captureCharFrame().split("\n")[panel.y + 1]).not.toContain("×");
    app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
    expect(app.get("model-picker").visible).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("j/k and h/l preview model/effort, then Tab and one confirmation apply both", async () => {
  // h/l adjusts effort for the current model even while list-focused.
  const app = await mount();
  try {
    await app.open(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");
    app.mockInput.pressKey("h"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");
    app.mockInput.pressKey("j"); await app.render(); expect(app.captureCharFrame()).toContain("not supported (off)");
    app.mockInput.pressKey("k"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");

    // Model round-trips preserve preview effort; arrows also work alongside h/l.
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-effort");
    app.mockInput.pressKey("h"); await app.render(); expect(app.captureCharFrame()).toContain("[low]");
    app.mockInput.pressKey("l"); app.mockInput.pressArrow("right"); await app.render(); expect(app.captureCharFrame()).toContain("[high]");
    app.mockInput.pressArrow("left"); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");
    app.mockInput.pressKey("p", { ctrl: true }); await app.render(); expect(app.captureCharFrame()).toContain("[low]");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(app.captureCharFrame()).toContain("[medium]");
    expect(app.changes).toEqual([]);
    app.mockInput.pressEnter(); await app.render();

    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "fixture", id: "original" }, effort: "medium" }]);
    expect(app.sent).toEqual([]); expect(app.get("model-picker").visible).toBe(false);
  } finally { await app.close(); }
});

test.each([
  ["model ＯＴＨＥＲ", "Target model"],
  ["ＲＩＧＩＮＡＬ fixture", "Original model [Current]"],
  ["model missing", "No matching models"],
  ["tgt", "No matching models"],
] as const)("Model query %s shows only candidates containing every word", async (query, expected) => {
  // Provider, name and ID are searchable metadata, not model execution inputs.
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render();

    await app.mockInput.typeText(query); await app.render();

    // Search accepts normalized substrings without changing the session model.
    expect(app.captureCharFrame()).toContain(expected);
    expect(app.changes).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Search keeps hjkl literal while Ctrl+N/P moves candidates", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render();
    await app.mockInput.typeText("hjkl"); await app.render();
    expect((app.get("model-search") as InputRenderable).value).toBe("hjkl");
    for (let index = 0; index < 4; index++) app.mockInput.pressBackspace();
    await app.mockInput.typeText("model"); await app.render();

    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true });
    app.mockInput.pressEnter(); await app.render();

    expect(app.changes).toEqual([{ id: "a1", conversation: "first", model: { provider: "other", id: "target" }, effort: "off" }]);
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Only supported efforts appear and normalized SDK previews are inspectable before application", async () => {
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [catalog.models[0]!,
    { ...catalog.models[1]!, reasoning: true, efforts: ["low", "medium"], effort: "medium" }] }) });
  try {
    await app.open(); app.mockInput.pressKey("j"); await app.render();

    expect(app.captureCharFrame()).toContain("[medium]"); expect(app.captureCharFrame()).not.toContain("[high]");
    expect(app.renderer.root.findDescendantById("model-effort:high")).toBeUndefined();
    expect(app.changes).toEqual([]);
    app.mockInput.pressKey("h"); app.mockInput.pressEnter(); await app.render();

    expect(app.changes[0]?.effort).toBe("low"); expect(app.changes[0]?.model.provider).toBe("other");
  } finally { await app.close(); }
});

test("Esc discards model/effort previews and reopening starts from the current pair", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("h"); app.mockInput.pressKey("j"); await app.render();
    app.mockInput.pressEscape(); await app.render();

    expect(app.changes).toEqual([]); expect(app.sent).toEqual([]);
    await app.open(); expect(app.captureCharFrame()).toContain("[high]");
    expect(app.captureCharFrame()).toContain("Original model [Current]");
  } finally { await app.close(); }
});

test("Invalid model arguments preserve input without popup or paid prompt fallbacks", async () => {
  const app = await mount();
  try {
    await app.open("/model other/target");

    expect(app.get("model-picker").visible).toBe(false); expect(app.prompt.value).toBe("/model other/target");
    expect(app.captureCharFrame()).toContain("INVALID_INPUT"); expect(app.sent).toEqual([]); expect(app.changes).toEqual([]);
  } finally { await app.close(); }
});

test("Popup Esc closes and restores input without changing models or interrupting execution", async () => {
  // Search and list focus remain inside popups; background interrupt Esc never runs.
  const interrupted: string[] = [];
  const app = await mount({ getSessionDetails: () => ({ conversationId: "first", status: "working", output: "Running work", error: null }),
    onInterrupt: async id => { interrupted.push(id); return ok(undefined); } });
  try {
    await app.open();
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-effort");
    app.mockInput.pressTab(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");
    pressLeader(app, "a"); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toBe("model-list");

    app.mockInput.pressEscape(); await app.render();
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.changes).toEqual([]); expect(app.sent).toEqual([]); expect(interrupted).toEqual([]);
  } finally { await app.close(); }
});

test("Closed popups ignore late model lists and immediately clean loading timers", async () => {
  // Delay only the network boundary to produce responses beyond popup lifetime.
  const gate = Promise.withResolvers<ReturnType<typeof ok<ModelCatalog>>>(); let signal: AbortSignal | undefined;
  const app = await mount({ onListModels: async (_id, _conversation, abort) => { signal = abort; return gate.promise; } });
  try {
    await app.open(); expect(app.get("model-loading").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    expect(signal?.aborted).toBe(true); expect(app.get("model-loading").visible).toBe(false);

    gate.resolve(ok(catalog)); await app.render();
    expect(app.get("model-picker").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.changes).toEqual([]);
  } finally { gate.resolve(ok(catalog)); await app.close(); }
});

test("Model lookup failures, no matches, and unauthenticated empty lists stay distinct and refreshable", async () => {
  let calls = 0;
  const app = await mount({ onListModels: async () => ++calls === 1 ? err(new ModelSelectionError("Fixture login unavailable")) : ok(catalog) });
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("MODEL_UNAVAILABLE");
    expect(app.captureCharFrame()).not.toContain("No available models");

    app.mockInput.pressKey("r", { ctrl: true }); await app.render();
    app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("no-such-model"); await app.render();
    expect(app.captureCharFrame()).toContain("No matching models"); app.mockInput.pressEnter(); await app.render();
    expect(app.changes).toEqual([]); expect(app.get("model-picker").visible).toBe(true);
  } finally { await app.close(); }
  const empty = await mount({ onListModels: async () => ok({ ...catalog, models: [] }) });
  try { await empty.open(); expect(empty.captureCharFrame()).toContain("No available models"); }
  finally { await empty.close(); }
});

test.each(["tab", "conversation"] as const)("Changing %s during application closes popups without late success reclaiming focus", async (change) => {
  const gate = Promise.withResolvers<ReturnType<typeof ok<null>>>();
  const app = await mount({ onSelectModel: async () => gate.promise });
  try {
    await app.open(); app.mockInput.pressArrow("down"); app.mockInput.pressEnter(); await app.render();
    if (change === "tab") app.selection.selectSession("demo:main", "a2");
    else app.update({ conversationId: "replacement", status: null, output: "", error: null });
    await app.render();
    expect(app.get("model-picker").visible).toBe(false);
    const focus = app.renderer.currentFocusedRenderable;

    gate.resolve(ok(null)); await app.render();
    expect(app.selection.sessionId).toBe(change === "tab" ? "a2" : "a1"); expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.sent).toEqual([]);
  } finally { gate.resolve(ok(null)); await app.close(); }
});

test("Many effort options wrap within narrow layouts and remain selectable and applicable", async () => {
  // Even models with maximal effort options keep choices inside the popup.
  const app = await mount({ onListModels: async () => ok({ ...catalog, models: [{ ...catalog.models[0]!,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }] }) });
  try {
    await app.open(); app.resize(46, 12); await app.render();
    const panel = app.get("model-dialog"), maximum = app.get("model-effort:max");

    await app.mockMouse.click(maximum.x + 1, maximum.y); await app.render();

    expect(maximum.y + maximum.height).toBeLessThan(panel.y + panel.height);
    expect(maximum.x + maximum.width).toBeLessThan(panel.x + panel.width);
    expect(app.captureCharFrame()).toContain("[max]"); expect(app.changes).toEqual([]);
    app.mockInput.pressEnter(); await app.render(); expect(app.changes[0]?.effort).toBe("max");
  } finally { await app.close(); }
});

test("Model popups remain onscreen in narrow layouts and preserve searches across resize", async () => {
  const app = await mount();
  try {
    await app.open(); app.mockInput.pressKey("/"); await app.render(); await app.mockInput.typeText("target"); await app.render();
    app.resize(46, 12); await app.render();
    const panel = app.get("model-dialog");
    expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(46); expect(panel.y + panel.height).toBeLessThanOrEqual(12);
    expect(app.captureCharFrame()).toContain("Target model");

    app.resize(120, 28); await app.render();
    expect((app.get("model-search") as InputRenderable).value).toBe("target"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
