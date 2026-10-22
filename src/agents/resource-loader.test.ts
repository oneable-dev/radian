import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionResourceLoader } from "./resource-loader.ts";

test("pi-accounts는 최초 로드와 reload에서 import 전에 제외하고 다른 확장과 사용자 설정은 보존한다", async () => {
  // 차단 대상은 import 자체가 부수 효과를 일으키므로 핸들러만 숨기는 것으로는 부족하다.
  const directory = await mkdtemp(join(tmpdir(), "radian-resource-filter-")), agent = join(directory, "agent"), legacy = join(directory, "pi-accounts", "index.ts");
  const marker = join(directory, "legacy-imported"), normal = join(directory, "normal.ts"), normalMarker = join(directory, "normal-loaded");
  await mkdir(agent); await mkdir(join(directory, "pi-accounts"));
  await writeFile(legacy, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default function(pi) { pi.registerCommand("accounts", {handler:async()=>{}}); }`);
  await writeFile(normal, `import {writeFileSync} from "node:fs"; export default function(pi) {writeFileSync(${JSON.stringify(normalMarker)}, "loaded"); pi.registerCommand("normal", {handler:async()=>{}});}`);
  const settings = JSON.stringify({ extensions: [legacy, normal] }); await writeFile(join(agent, "settings.json"), settings);
  const loader = sessionResourceLoader({ cwd: directory, agentDir: agent, settingsManager: SettingsManager.create(directory, agent), noThemes: true });
  try {
    // 같은 리소스 로더를 새로고침해도 설정의 차단 대상은 실행하지 않는다.
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.some(extension => extension.commands.has("normal"))).toBe(true);
    // 새 확장 경로를 추가해 /reload가 초기 경로 목록에 고정되지 않는지 확인한다.
    await mkdir(join(agent, "extensions"));
    await writeFile(join(agent, "extensions", "added.ts"), 'export default function(pi) { pi.registerCommand("after-reload", {handler:async()=>{}}); }');
    await loader.reload();
    expect(loader.getExtensions().extensions.some(extension => extension.commands.has("after-reload"))).toBe(true);

    // 다른 확장은 실행되고 원본 설정은 바뀌지 않으며 금지한 import는 발생하지 않는다.
    expect(await Bun.file(marker).exists()).toBe(false); expect(await readFile(normalMarker, "utf8")).toBe("loaded");
    expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(settings);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
