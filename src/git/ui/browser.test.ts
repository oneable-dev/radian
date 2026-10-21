import { expect, test } from "bun:test";
import type { Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { GitBrowser } from "./browser.ts";
import { defaultKeymap } from "../../keybindings/config.ts";
import { InputError } from "../../errors.ts";
import { err } from "../../result.ts";

test.each(["refs", "reflog"] as const)("%s는 snapshot을 기다리는 동안 검색해도 로딩을 유지하고 결과 도착 즉시 표시한다", async kind => {
  // 아직 로딩 중인 조회와 결과가 실제로 비어 있는 조회를 구분한다.
  const clock = new ManualClock(), app = await createTestRenderer({ width: 120, height: 28, clock });
  let lookups = 0;
  const browser = new GitBrowser(app.renderer, { changed() {}, close() {}, selected() {}, filter() {}, open() {},
    inspect: async () => { lookups++; return err(new InputError("Unexpected target lookup")); },
    hint: (command, context) => defaultKeymap().hint(command, context) });
  app.renderer.root.add(browser.root);
  try {
    browser.show(kind, undefined, null); await app.renderOnce(); browser.search.value = "missing"; await app.renderOnce();

    // 타이핑은 진행 중인 Git 조회의 소유권이나 스피너를 중단하지 않는다.
    clock.advance(800); await app.renderOnce();
    const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
    const spinner = walk(browser.root).find(node => node.id === "git-browser-loading");
    expect(spinner?.visible).toBe(true); expect(app.captureCharFrame()).toContain("Loading Git data");
    browser.update({ commits: [], refs: [], files: [], reflog: [], head: "", headOid: null }); await app.renderOnce();

    expect(spinner?.visible).toBe(false); expect(browser.search.value).toBe("missing");
    expect(app.captureCharFrame()).toContain("No matches"); expect(browser.canOpen).toBe(false); expect(lookups).toBe(0);
    browser.hide(); expect(browser.visible).toBe(false);
  } finally { browser.dispose(); await app.dispose(); }
});
