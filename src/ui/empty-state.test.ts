import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { EmptyState } from "./empty-state.ts";
import { StateIcon } from "./state-icon.ts";
import { icons } from "../icons.ts";

async function mount() {
  const app = await createTestRenderer({ width: 80, height: 20 });
  const state = new EmptyState(app.renderer, "empty");

  app.renderer.root.add(state.root);

  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const get = (name: string) => {
    const node = app.renderer.root.findDescendantById(`empty:${name}`);
    if (!(node instanceof TextRenderable)) {
      throw new Error(`Missing ${name}`);
    }

    return node;
  };
  const icon = state.root.findDescendantById("empty:icon");
  if (!(icon instanceof StateIcon)) {
    throw new Error("Missing state icon");
  }

  return { ...app, state, icon, render, get };
}

test("Empty views center icons, titles, and actual creation shortcuts", async () => {
  // Show necessary guidance without sessions or input controls.
  const app = await mount();
  try {
    // Features supply configured keys and creation actions.
    app.state.update({
      icon: icons.terminal,
      title: "No terminals",
      action: { key: "Ctrl+Space → n", label: "New terminal" },
    });
    await app.render();

    // Center the enlarged icon and guidance as one group without adding focus targets.
    const icon = app.icon;
    const title = app.get("title");
    const hint = app.get("hint");

    expect(title.plainText).toBe("No terminals");
    expect(hint.plainText).toBe("Ctrl+Space → n New terminal");
    expect(icon.height).toBe(3);
    expect(title.y).toBe(icon.y + icon.height + 1);
    expect(hint.y).toBe(title.y + 2);
    expect(Math.abs((icon.y + hint.y + 1) / 2 - app.state.root.height / 2)).toBeLessThanOrEqual(1);
    for (const node of [icon, title, hint]) {
      expect(Math.abs(node.x + node.width / 2 - app.state.root.width / 2)).toBeLessThanOrEqual(1);
    }

    expect(app.renderer.currentFocusedRenderable).toBeNull();
  } finally {
    await app.dispose();
  }
});

test.each(["blocks", "kitty"] as const)(
  "Odd-width %s panes keep images, titles and shortcuts on the same centerline",
  async (protocol) => {
    // Native boxes and text round fractional flex centers differently, exposing a one-cell offset.
    const app = await mount();
    setRendererCapabilities(app.renderer, {
      kitty_graphics: protocol === "kitty",
      image_protocol: protocol,
    });
    try {
      app.state.update({
        icon: icons.terminal,
        title: "No terminals",
        action: { key: "<leader>c", label: "New terminal" },
      });
      for (const width of [80, 81, 120, 121]) {
        app.resize(width, 24);
        await app.render();

        const title = app.get("title");
        const hint = app.get("hint");
        const center = title.x + title.width / 2;

        expect(app.icon.x + app.icon.width / 2).toBe(center);
        expect(hint.x + hint.width / 2).toBe(center);
        expect(Math.abs(center - app.state.root.width / 2)).toBeLessThanOrEqual(0.5);
      }
    } finally {
      await app.dispose();
    }
  },
);

test("Responsive state icons grow with wide panes while keeping descriptions and actions visible", async () => {
  // A wide but shallow terminal must not sacrifice useful guidance to decorative artwork.
  const app = await mount();
  try {
    app.state.update({
      icon: icons.robot,
      title: "No AI sessions",
      description: "Start a session to work on this workspace.",
      action: { key: "<leader>c", label: "New session" },
    });
    for (const [width, height, rows] of [
      [140, 30, 4],
      [80, 20, 3],
      [140, 7, 1],
      [40, 12, 1],
      [140, 30, 4],
    ] as const) {
      app.resize(width, height);
      await app.render();

      expect(app.icon.height).toBe(rows);
      if (rows > 1) {
        expect(app.icon.width).toBe(rows * 2);
      }

      const description = app.get("description");
      const hint = app.get("hint");

      expect(description.visible).toBe(true);
      expect(hint.visible).toBe(true);
      expect(description.plainText).toContain("Start a session");
      expect(hint.y + hint.height).toBeLessThanOrEqual(height);
      expect(app.captureCharFrame()).not.toMatch(/\bv\d+\.\d+\.\d+/u);
      expect(app.renderer.currentFocusedRenderable).toBeNull();
    }
  } finally {
    await app.dispose();
  }
});

test("Disabled creation keys leave no stale defaults or creation hints", async () => {
  // Empty keymap hints mean disabled state, not fallback to defaults.
  const app = await mount();
  try {
    app.state.update({
      icon: ">_",
      title: "No terminals",
      action: { key: "Ctrl+Space → n", label: "New terminal" },
    });
    await app.render();

    // Remove creation guidance when disabled.
    app.state.update({
      icon: ">_",
      title: "No terminals",
      action: { key: "", label: "New terminal" },
    });
    await app.render();

    // Retain only titles without previous key strings.
    expect(app.get("hint").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Ctrl+Space");
    expect(app.captureCharFrame()).not.toContain("New terminal");
    expect(app.captureCharFrame()).toContain("No terminals");
  } finally {
    await app.dispose();
  }
});

test("Compact bodies prioritize creation guidance and restore centering when expanded", async () => {
  // Creation entry points must not leave compact body bounds.
  const app = await mount();
  try {
    app.state.update({
      icon: icons.terminal,
      title: "No terminals",
      action: { key: "Alt+n", label: "New terminal" },
    });

    // Resize small, then return to original dimensions.
    for (const [width, height] of [
      [24, 3],
      [10, 1],
      [80, 20],
    ] as const) {
      app.resize(width, height);
      await app.render();

      // Truncate safely and show only key guidance when height is one row.
      const hint = app.get("hint");
      expect(hint.visible).toBe(true);
      expect(hint.y).toBeGreaterThanOrEqual(0);
      expect(hint.y + hint.height).toBeLessThanOrEqual(height);
      expect(hint.x + hint.width).toBeLessThanOrEqual(width);
      expect(Bun.stringWidth(hint.plainText)).toBeLessThanOrEqual(width);
      expect(app.icon.visible).toBe(height >= 5);
      expect(app.get("title").visible).toBe(height >= 2);
    }
  } finally {
    await app.dispose();
  }
});
