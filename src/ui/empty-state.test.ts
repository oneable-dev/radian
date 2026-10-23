import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { EmptyState } from "./empty-state.ts";

async function mount() {
  const app = await createTestRenderer({ width: 80, height: 20 });
  const state = new EmptyState(app.renderer, "empty"); app.renderer.root.add(state.root);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (name: string) => {
    const node = app.renderer.root.findDescendantById(`empty:${name}`);
    if (!(node instanceof TextRenderable)) throw new Error(`Missing ${name}`);
    return node;
  };
  return { ...app, state, render, get };
}

test("Empty views center icons, titles, and actual creation shortcuts", async () => {
  // Show necessary guidance without sessions or input controls.
  const app = await mount();
  try {
    // Features supply configured keys and creation actions.
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Ctrl+Space → n", label: "New terminal" } }); await app.render();

    // Center groups and lines without adding arbitrary focus targets.
    const icon = app.get("icon"), title = app.get("title"), hint = app.get("hint");
    expect(title.plainText).toBe("No terminals"); expect(hint.plainText).toBe("Ctrl+Space → n New terminal");
    expect(title.y).toBe(icon.y + 2); expect(hint.y).toBe(title.y + 2);
    expect(Math.abs((icon.y + hint.y + 1) / 2 - app.state.root.height / 2)).toBeLessThanOrEqual(1);
    for (const node of [icon, title, hint]) expect(Math.abs(node.x + node.width / 2 - app.state.root.width / 2)).toBeLessThanOrEqual(1);
    expect(app.renderer.currentFocusedRenderable).toBeNull();
  } finally { await app.dispose(); }
});

test("Disabled creation keys leave no stale defaults or creation hints", async () => {
  // Empty keymap hints mean disabled state, not fallback to defaults.
  const app = await mount();
  try {
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Ctrl+Space → n", label: "New terminal" } }); await app.render();

    // Remove creation guidance when disabled.
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "", label: "New terminal" } }); await app.render();

    // Retain only titles without previous key strings.
    expect(app.get("hint").visible).toBe(false); expect(app.captureCharFrame()).not.toContain("Ctrl+Space");
    expect(app.captureCharFrame()).not.toContain("New terminal"); expect(app.captureCharFrame()).toContain("No terminals");
  } finally { await app.dispose(); }
});

test("Compact bodies prioritize creation guidance and restore centering when expanded", async () => {
  // Creation entry points must not leave compact body bounds.
  const app = await mount();
  try {
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Alt+n", label: "New terminal" } });

    // Resize small, then return to original dimensions.
    for (const [width, height] of [[24, 3], [10, 1], [80, 20]] as const) {
      app.resize(width, height); await app.render();

      // Truncate safely and show only key guidance when height is one row.
      const hint = app.get("hint");
      expect(hint.visible).toBe(true); expect(hint.y).toBeGreaterThanOrEqual(0);
      expect(hint.y + hint.height).toBeLessThanOrEqual(height); expect(hint.x + hint.width).toBeLessThanOrEqual(width);
      expect(Bun.stringWidth(hint.plainText)).toBeLessThanOrEqual(width);
      expect(app.get("icon").visible).toBe(height >= 5); expect(app.get("title").visible).toBe(height >= 2);
    }
  } finally { await app.dispose(); }
});
