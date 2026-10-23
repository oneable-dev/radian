import { expect, test } from "bun:test";
import { formatKeys, parseKeymap } from "./config.ts";
import { keymapHelp } from "./help.ts";
import { expectError, expectOk } from "../testing/results.ts";

test.each([
  ["ctrl+n", "<C-n>"], ["shift+tab", "<S-Tab>"], ["return", "<CR>"], ["escape", "<Esc>"],
  ["alt+x", "<M-x>"], ["super+tab", "<D-Tab>"], ["ctrl+shift+return", "<C-S-CR>"],
  ["space", "<Space>"], ["f12", "<F12>"], ["pageup", "<PageUp>"], ["pagedown", "<PageDown>"],
  ["backspace", "<BS>"], ["delete", "<Del>"], ["insert", "<Insert>"], ["home", "<Home>"], ["end", "<End>"],
  ["up", "<Up>"], ["ctrl+down", "<C-Down>"], ["shift+g", "G"], ["g", "g"], ["G", "G"],
  ["plus", "+"], ["ctrl+plus", "<C-+>"], ["<", "<lt>"], ["|", "<Bar>"], ["\\", "<Bslash>"],
])("Key %s displays as Neovim notation %s", (key, expected) => {
  // Input tokens retain existing configuration formats.
  const keys = [key];

  // Transform display only, never actual input tokens.
  const label = formatKeys(keys);

  // Modifiers and special keys use Neovim names while ordinary character case stays intact.
  expect(label).toBe(expected); expect(keys).toEqual([key]);
});

test.each([
  [["<leader>", "b"], "<leader>b"],
  [["g", "g"], "gg"],
  [["z", "a"], "za"],
  [["<leader>", "shift+tab"], "<leader><S-Tab>"],
  [["ctrl+x", "ctrl+f"], "<C-x><C-f>"],
] as const)("Key sequence %j displays as %s without separators", (keys, expected) => {
  // Leaders and multikey commands form one ordered input sequence.
  const sequence = [...keys];

  // Concatenate notation without implying arrows or spaces are extra keys.
  const label = formatKeys(sequence);

  // Mixed ordinary/special keys retain clear Neovim token boundaries.
  expect(label).toBe(expected);
});

test.each([["ctrl+space", "<C-Space>"], ["ctrl+b", "<C-b>"], ["space r", "<Space>r"]])("Leader %s keeps logical command hints while help explains actual keys", (leader, leaderLabel) => {
  // Space-prefixed leaders must disable default button Space activation.
  const map = expectOk(parseKeymap({ leader, bindings: { "button.activate": [] } }));

  // Verify public lookup paths used by footers and help.
  const hint = map.hint("tab.new", "terminal"), hints = map.hints("app.detach", "terminal");
  const help = keymapHelp(map, "terminal", () => true);

  // Leader overrides change physical-key explanations, not logical command hints.
  expect(hint).toBe("<leader>c"); expect(hints).toBe("<leader>d");
  expect(help).toContain(`<leader>: ${leaderLabel}`);
  expect(help).toContain("<leader>c"); expect(help).toContain("<leader>d");
  expect(help).toContain("<S-CR>"); expect(help).toContain("<Esc>");
  expect(help).not.toMatch(/ctrl\+|shift\+|alt\+| → /u);
});

test("Explicit physical leader-like bindings never display as logical leaders", () => {
  // Fixed bindings differ from leader-dependent bindings despite identical physical prefixes.
  const map = expectOk(parseKeymap({ bindings: {
    "app.detach": ["ctrl+space q"], "view.editor": ["<leader> v"],
  } }));

  // Hints preserve original binding semantics rather than expanded keys.
  const literal = map.hint("app.detach", "terminal"), symbolic = map.hint("view.editor", "terminal");

  // Later leader changes must not reinterpret fixed bindings as leader commands.
  expect(literal).toBe("<C-Space>q"); expect(symbolic).toBe("<leader>v");
});

test("Expanded multikey leaders exceeding sequence limits are rejected", () => {
  // Short logical tokens may expand beyond the router's eight-key limit.
  const config = { leader: "space r", bindings: { "app.detach": ["<leader> q q q q q q q"] } };

  // Separate display tokens must not relax existing input validation.
  const result = parseKeymap(config);

  // Invalid input returns errors instead of silently restoring default keymaps.
  expect(expectError(result).code).toBe("INVALID_INPUT");
});
