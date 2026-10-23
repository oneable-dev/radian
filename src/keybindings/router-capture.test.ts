import { expect, test } from "bun:test";
import { InputRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { KeyRouter } from "./router.ts";
import { parseKeymap } from "./config.ts";
import { expectOk } from "../testing/results.ts";

test("Literal argument capture respects trailing leader keys and consumes held repeats", async () => {
  // Shared keymaps take precedence when captured r belongs to a leader.
  const keymap = expectOk(parseKeymap({ leader: "space r", bindings: { "button.activate": [], "app.detach": [{ keys: "<leader> z", scope: "global" }] } }));
  const app = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true });
  const input = new InputRenderable(app.renderer, { width: 60 }); app.renderer.root.add(input); input.focus();
  const commands: string[] = [], captured: string[] = [];
  const router = new KeyRouter(app.renderer, keymap, () => "prompt", command => command === "app.detach", command => commands.push(command), key => {
    if (key.name !== "r") return false;
    captured.push(key.name); return true;
  });
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    // Leaders execute normally; only standalone r is consumed as an argument.
    await app.mockInput.typeText(" rz"); app.mockInput.pressKey("r");
    raw("\x1b[114;1:2u"); raw("\x1b[114;1:3u");

    expect(commands).toEqual(["app.detach"]); expect(captured).toEqual(["r"]); expect(input.value).toBe("");
  } finally { router.dispose(); await app.dispose(); }
});
