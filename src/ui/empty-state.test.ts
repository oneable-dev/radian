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

test("빈 화면은 아이콘·제목·실제 생성 단축키를 본문 중앙에 배치한다", async () => {
  // 세션이나 입력 컨트롤 없이 필요한 안내만 제공한다.
  const app = await mount();
  try {
    // 기능이 현재 설정된 키와 생성 작업을 전달한다.
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Ctrl+Space → n", label: "New terminal" } }); await app.render();

    // 안내 그룹과 각 줄이 중앙에 있고 임의의 포커스 대상을 추가하지 않는다.
    const icon = app.get("icon"), title = app.get("title"), hint = app.get("hint");
    expect(title.plainText).toBe("No terminals"); expect(hint.plainText).toBe("Ctrl+Space → n New terminal");
    expect(title.y).toBe(icon.y + 2); expect(hint.y).toBe(title.y + 2);
    expect(Math.abs((icon.y + hint.y + 1) / 2 - app.state.root.height / 2)).toBeLessThanOrEqual(1);
    for (const node of [icon, title, hint]) expect(Math.abs(node.x + node.width / 2 - app.state.root.width / 2)).toBeLessThanOrEqual(1);
    expect(app.renderer.currentFocusedRenderable).toBeNull();
  } finally { await app.dispose(); }
});

test("생성 키를 비활성화하면 오래된 기본 키나 생성 안내를 남기지 않는다", async () => {
  // 키맵의 빈 힌트는 기본값으로 복구할 신호가 아니라 비활성 상태다.
  const app = await mount();
  try {
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Ctrl+Space → n", label: "New terminal" } }); await app.render();

    // 설정이 비활성화된 후에는 생성 안내를 제거한다.
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "", label: "New terminal" } }); await app.render();

    // 제목만 남고 이전 키 문자열은 표시되지 않는다.
    expect(app.get("hint").visible).toBe(false); expect(app.captureCharFrame()).not.toContain("Ctrl+Space");
    expect(app.captureCharFrame()).not.toContain("New terminal"); expect(app.captureCharFrame()).toContain("No terminals");
  } finally { await app.dispose(); }
});

test("낮고 좁은 본문은 장식보다 생성 안내를 우선하고 넓히면 중앙 배치를 복원한다", async () => {
  // 작은 터미널에서도 생성 경로가 본문 밖으로 밀려나서는 안 된다.
  const app = await mount();
  try {
    app.state.update({ icon: ">_", title: "No terminals", action: { key: "Alt+n", label: "New terminal" } });

    // 작은 창을 거쳐 다시 원래 크기로 돌아온다.
    for (const [width, height] of [[24, 3], [10, 1], [80, 20]] as const) {
      app.resize(width, height); await app.render();

      // 안내는 안전하게 말줄임하고 높이 한 줄에서는 키 안내만 남긴다.
      const hint = app.get("hint");
      expect(hint.visible).toBe(true); expect(hint.y).toBeGreaterThanOrEqual(0);
      expect(hint.y + hint.height).toBeLessThanOrEqual(height); expect(hint.x + hint.width).toBeLessThanOrEqual(width);
      expect(Bun.stringWidth(hint.plainText)).toBeLessThanOrEqual(width);
      expect(app.get("icon").visible).toBe(height >= 5); expect(app.get("title").visible).toBe(height >= 2);
    }
  } finally { await app.dispose(); }
});
