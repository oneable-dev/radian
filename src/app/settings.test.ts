import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import { loadSessionSettings, loadSettings, parseSessionSettings } from "./settings.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-settings-")), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const root = join(directory, "radian"); await mkdir(root);
  return { directory, root, settings: join(root, "settings.json"),
    async file(name: string, data: unknown) { const path = join(root, name); await writeFile(path, JSON.stringify(data)); return path; },
    async close() { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(directory, { recursive: true, force: true }); } };
}

test("통합 설정은 영역별 검증과 설정 파일 기준의 상대 워크스페이스 경로를 사용한다", async () => {
  // 통합 설정이 있으면 같은 영역의 잘못된 레거시 파일은 읽지 않는다.
  const app = await fixture();
  try {
    await app.file("theme.json", { invalid: true }); await app.file("keybindings.json", { invalid: true }); await app.file("workspace.json", { invalid: true });
    await app.file("settings.json", { theme: { accent: "#123456", styles: { "status.success": { bold: true } } }, keybindings: { leader: "ctrl+b" }, workspace: { roots: ["./repos"], maxDepth: 2 }, sessions: { retentionDays: 7 } });

    // 실제 외부 파일 하나에서 모든 Radian 설정을 읽는다.
    const settings = expectOk(await loadSettings());

    // UI·탐색·런타임 정책은 형식만 공유하고 각 영역의 기존 동작을 유지한다.
    expect(settings.path).toBe(app.settings); expect(settings.theme.accent).toBe("#123456");
    expect(settings.keymap.leader).toEqual(["ctrl+b"]);
    expect(settings.keymap.hint("app.detach", "none")).toBe("<leader>c");
    expect(settings.workspace).toEqual({ roots: [join(app.root, "repos")], maxDepth: 2 }); expect(settings.sessions.retentionDays).toBe(7);
  } finally { await app.close(); }
});

test("명시한 개별 파일 옵션은 통합 설정보다 우선하고 없는 영역만 레거시 파일로 보완한다", async () => {
  // 테마는 CLI에서 고르고 단축키와 탐색 경로는 기존 파일을 유지한다.
  const app = await fixture();
  try {
    await app.file("settings.json", { theme: { accent: "#111111" }, sessions: { retentionDays: null } });
    const theme = await app.file("custom-theme.json", { accent: "#ABCDEF" });
    await app.file("keybindings.json", { leader: "ctrl+b" }); await app.file("workspace.json", { roots: ["./legacy"] });

    // 영역별 우선순위는 명시 옵션, 통합 영역, 레거시, 기본값 순서다.
    const settings = expectOk(await loadSettings({ theme }));

    // 통합 설정을 쓰더라도 기존 사용자 설정이 조용히 사라지지 않는다.
    expect(settings.theme.accent).toBe("#ABCDEF"); expect(settings.keymap.leader).toEqual(["ctrl+b"]);
    expect(settings.keymap.hint("app.detach", "none")).toBe("<leader>c");
    expect(settings.workspace.roots).toEqual([join(app.root, "legacy")]); expect(settings.sessions.retentionDays).toBeNull();
  } finally { await app.close(); }
});

test("설정 파일이 없으면 기본 30일이고 명시한 파일의 누락이나 손상은 오류다", async () => {
  // 기본 파일은 선택 사항이지만 --config로 지정한 파일은 필수다.
  const app = await fixture();
  try {
    expect(expectOk(await loadSettings()).sessions.retentionDays).toBe(30);

    // 잘못된 파일을 기본 30일로 대체하면 의도치 않은 삭제가 생길 수 있다.
    const missing = expectError(await loadSettings({ config: join(app.root, "missing.json") }));
    await writeFile(app.settings, "{broken JSON"); const broken = expectError(await loadSessionSettings());

    // 런타임도 파일 오류를 명시하고 정리 정책으로 해석하지 않는다.
    expect(missing.code).toBe("STORAGE_FAILED"); expect(broken.code).toBe("INVALID_INPUT");
  } finally { await app.close(); }
});

test.each([null, [], { unknown: 30 }, { retentionDays: 0 }, { retentionDays: -1 }, { retentionDays: 1.5 }, { retentionDays: "30" }, { retentionDays: undefined }].map(value => ({ value })))("잘못된 세션 보관 설정 %j는 자동 정리 기본값으로 대체하지 않는다", ({ value }) => {
  // 잘못된 값을 정상 정책으로 간주하면 원치 않는 기록 삭제가 발생한다.
  const result = parseSessionSettings(value);

  // 0이나 문자열을 특별한 무기한 정책으로 추측하지 않는다.
  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("런타임은 UI 전용 설정 파일과 값에 의존하지 않고 보관 정책만 읽는다", async () => {
  // 실행 중인 데몬은 테마나 단축키의 잘못된 값 때문에 기록을 정리하면 안 된다.
  const app = await fixture();
  try {
    await app.file("settings.json", { theme: "UI-invalid", keybindings: 123, sessions: { retentionDays: 90 } });
    await app.file("theme.json", { invalid: true });

    // 세션 정책은 UI를 초기화하거나 레거시 UI 설정을 읽지 않는다.
    const sessions = expectOk(await loadSessionSettings());
    const ui = expectError(await loadSettings());

    // 같은 파일을 읽되 UI와 런타임의 책임은 분리돼 있다.
    expect(sessions.retentionDays).toBe(90); expect(ui.code).toBe("INVALID_INPUT");
  } finally { await app.close(); }
});

test("잘못된 통합 루트나 sessions 값은 런타임 정리를 중단한다", async () => {
  // null은 sessions 전체가 아니라 retentionDays 값에서만 무기한 보관을 뜻한다.
  const app = await fixture();
  try {
    for (const data of [{ unknown: {} }, { sessions: null }, []]) {
      await app.file("settings.json", data);

      // 정책을 다시 읽을 때마다 유효한 형식인지 검증한다.
      const result = await loadSessionSettings();

      // 손상이나 알 수 없는 설정을 조용히 무시하지 않는다.
      expect(expectError(result).code).toBe("INVALID_INPUT");
    }
  } finally { await app.close(); }
});

test("표시 전용 모드에서는 사용하지 않는 레거시 워크스페이스 파일을 읽지 않는다", async () => {
  // --demo와 --test-runtime의 기존 무탐색 동작을 유지한다.
  const app = await fixture();
  try {
    await writeFile(join(app.root, "workspace.json"), "invalid JSON");

    // UI 설정은 읽지만 실제 저장소 탐색 설정은 건너뛴다.
    const settings = expectOk(await loadSettings({ includeWorkspace: false }));

    // 사용하지 않는 파일의 손상으로 데모나 격리 테스트가 실패하지 않는다.
    expect(settings.workspace).toEqual({ roots: [], maxDepth: 0 });
  } finally { await app.close(); }
});
