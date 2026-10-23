import { expect, test } from "bun:test";
import { parseSessionControl, sessionControlCommands } from "./session-controls.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("Completion descriptions match parsing for new-tab, clear, exit, reload, and compact commands", () => {
  // Host-reserved commands must not be shadowed by SDK commands with different meanings.
  const names = sessionControlCommands.map((item) => item.value);
  const actions = names.map((name) => expectOk(parseSessionControl(`/${name}`))?.action);
  expect(names).toEqual(["new", "clear", "exit", "reload", "compact"]); expect(actions).toEqual(["new-tab", "clear", "exit", "reload", "compact"]);
  expect(sessionControlCommands.find((item) => item.value === "new")?.description).toContain("new session tab");
  expect(sessionControlCommands.find((item) => item.value === "clear")?.description).toContain("History");
});

test.each(["/new", "/new  ", "/new\n"])("new creates a tab rather than clearing the current conversation: %j", (text) => {
  // Whitespace must not turn into an implicit first model prompt.
  expect(expectOk(parseSessionControl(text))).toEqual({ action: "new-tab" });
});

test.each(["/clear", "/clear  ", "/clear\n"])("clear replaces the current tab's conversation: %j", (text) => {
  expect(expectOk(parseSessionControl(text))).toEqual({ action: "clear" });
});

test.each(["/exit", "/exit  ", "/exit\n"])("exit closes the current session and tab: %j", (text) => {
  // Trailing whitespace must not confuse exit with conversation reset.
  const result = parseSessionControl(text);

  // Recognized commands never reach the SDK or model.
  expect(expectOk(result)).toEqual({ action: "exit" });
});

test.each(["new", "clear", "exit", "reload"])("%s rejects extra input instead of discarding it", (command) => {
  const result = parseSessionControl(`/${command} implement auth`);
  expect(expectError(result).code).toBe("INVALID_INPUT");
  expect(expectError(result).message).toBe(`Usage: /${command} (no arguments).`);
});

test.each(["/reload", "/reload  ", "/reload\n"])("reload explicitly refreshes resources without arguments: %j", text => {
  // Whitespace is only a separator, not instructions or new model input.
  const result = parseSessionControl(text);

  expect(expectOk(result)).toEqual({ action: "reload" });
});

test("Compaction preserves multiline instructions without trimming or flattening their contents", () => {
  const instructions = "Keep the plan\nPreserve 한글 👩🏽‍💻 constraints";
  expect(expectOk(parseSessionControl(`/compact ${instructions}`))).toEqual({ action: "compact", instructions });
});

test.each(["compact", "/compact-more", "/newspaper", "/clearance", "/exit-now", "/skill:strategic-compact", "Please use /new"])("Ordinary input and other resource commands are not intercepted: %j", (text) => {
  expect(expectOk(parseSessionControl(text))).toBeNull();
});
