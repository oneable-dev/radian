import { expect, test } from "bun:test";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { TerminalInfo } from "../../runtime/protocol.ts";

const scrolls = (node: Renderable): ScrollBoxRenderable[] => [...(node instanceof ScrollBoxRenderable ? [node] : []), ...node.getChildren().flatMap(scrolls)];
async function mount(longSessionIds = false) {
  const app = await createTestRenderer({width: 120, height: 24, kittyKeyboard: true});
  const items: TerminalInfo[] = Array.from({length: 8}, (_, i)=>({id:`fixture-${i}`, worktreeId:"demo:main", title:`long-process-name-${i}`, pid:100+i, shellPid:200+i, exited:false, exitCode:null}));
  const repositories = demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
    sessions: tree.sessions.map((session) => ({ ...session, id: longSessionIds ? `session-identifier-for-overflow-${session.id}` : session.id })),
  })) }));
  const view = new Workbench(app.renderer, new WorkspaceSelection(repositories), {onNewSession:()=>{},onCloseSession:()=>{},onPrompt:()=>ok(undefined),
    getSessionDetails:()=>({status:null,output:"",error:null,sections:[{id:"u",kind:"user",title:"You",text:"Original task",status:"complete"}]}),
    terminal:{list:()=>items,create:async()=>ok("fixture-0"),close:async()=>ok(undefined),attach:async()=>ok({input:()=>{},resize:()=>{},disconnect:async()=>{}})}});
  const render = async()=>{for(let i=0;i<8;i++)await Promise.resolve();await app.renderOnce();await app.renderOnce();};
  await render();
  return {...app, view, render, get:(id:string)=>app.renderer.root.findDescendantById(id)!, async close(){view.dispose();await app.dispose();}};
}

test("높이가 달라져도 탭·검색·항목 간격을 유지하고 작은 창은 입력 여백보다 본문과 상태 여백을 우선한다", async()=>{
  const app=await mount();
  try {
    let previous=0;
    for(const [height,inputHeight] of [[11,2],[12,3],[17,3],[18,3],[24,3],[30,3]] as const) {
      app.resize(80,height);await app.render();
      const body=app.get("session-transcript"), composer=app.get("agent-composer"),status=app.get("session-status");
      expect(app.get("workspace-search-box").height).toBe(3);expect(app.renderer.root.findDescendantById("work-view-tabs")).toBeUndefined();expect(composer.height).toBe(inputHeight);
      expect(body.height).toBeGreaterThanOrEqual(1);expect(body.height).toBeGreaterThanOrEqual(previous);previous=body.height;
      expect(composer.y+composer.height).toBe(status.y);expect(status.height).toBe(3);
      expect(status.y+status.height).toBeLessThanOrEqual(app.get("app-footer").y);
      // Closed workspace overlays reserve no geometry in the live work pane.
      expect(app.get("workspace-picker").visible).toBe(false); expect(app.get("work-panel").width).toBe(80);
    }
  }finally{await app.close();}
});

test("Agent와 Terminal 탭의 가로바는 resize 후에도 숨고 선택된 탭으로의 좌우 이동은 유지한다",async()=>{
  const app=await mount(true);
  try {
    // Long session IDs, not display names or removed toolbar buttons, produce real overflow.
    app.resize(80,24);await app.render();
    const agent=app.get("agent-session-list") as ScrollBoxRenderable;
    expect(agent.scrollWidth).toBeGreaterThan(agent.viewport.width);
    agent.scrollLeft=10;await app.render();expect(agent.scrollLeft).toBe(10);expect(agent.horizontalScrollBar.visible).toBe(false);
    app.mockInput.pressKey(" ",{ctrl:true});app.mockInput.pressKey("t");await app.render();
    const tabs=scrolls(app.get("terminal-view"))[0]!;
    expect(tabs.scrollWidth).toBeGreaterThan(tabs.viewport.width);
    for(const width of [60,120]) {
      app.resize(width,24);await app.render();tabs.scrollLeft=20;await app.render();
      expect(tabs.scrollLeft).toBe(20);expect(tabs.horizontalScrollBar.visible).toBe(false);
    }
    // 공통 정책은 세로 스크롤이나 내장 프로그램 설정을 변경하지 않는다.
    for(const area of scrolls(app.view.root))expect(area.horizontalScrollBar.visible).toBe(false);
  }finally{await app.close();}
});
