import { expect, test } from "bun:test";
import { parseCli, checkInteractiveHost } from "./cli.ts";
import { expectError, expectOk } from "../testing/results.ts";
import packageInfo from "../../package.json";

function options(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const action = expectOk(parseCli(args, {cwd:"/fixture",env}));
  if(action.kind!=="run")throw new Error("Expected runnable CLI options");
  return action.options;
}

test("Commander 도움말과 버전은 실행 옵션이 아닌 즉시 출력 결과다",()=>{
  for(const args of [["--help"],["runtime","--help"],["runtime","status","--help"],["help","runtime"]]) {
    const action=expectOk(parseCli(args,{cwd:"/missing",env:{NO_COLOR:"1"}}));
    expect(action.kind).toBe("output");if(action.kind==="output"){expect(action.text).toContain("Usage:");expect(action.text).not.toContain("\x1b");}
  }
  const version=expectOk(parseCli(["--version"]));expect(version).toEqual({kind:"output",text:packageInfo.version+"\n"});
});

test("공용 데몬 수명 주기와 구형 저장소 서비스 대상은 별도 옵션으로 해석한다",()=>{
  const service=options(["--runtime-service","--test-runtime","--runtime-cwd","/repo","--state-dir","/state"]);
  expect(options(["--runtime-cwd","repo","--state-dir","state"]).stateRoot).toBe("/fixture/state");
  expect(service.service).toBe(true);expect(service.offline).toBe(true);expect(service.cwd).toBe("/repo");expect(service.stateRoot).toBe("/state");
  expect(options(["runtime","status","--test-runtime","--runtime-cwd","/repo"]).status).toBe(true);
  expect(options(["runtime","stop"]).stop).toBe(true);expect(options(["--runtime-status"]).status).toBe(true);expect(options(["--stop-runtime"]).stop).toBe(true);
  expect(options(["--theme","theme.json","--keybindings","keys.json","--workspace-config","roots.json"]).workspaceConfig).toBe("roots.json");
  expect(options(["--config", "settings.json"]).config).toBe("/fixture/settings.json");
  expect(options(["--runtime-service", "--config", "/config/settings.json"]).config).toBe("/config/settings.json");
  expect(options(["runtime", "restart"]).restart).toBe(true);
  expect(options(["runtime", "stop", "--legacy", "--runtime-cwd", "/legacy"]).legacy).toBe(true);
  expect(options(["runtime", "status", "--legacy"]).legacy).toBe(true);
});

test.each([
  ["--unknown"],["unknown-command"],["--theme"],["--config"],["--config", ""],["--state-dir",""],["--runtime-cwd","x\0y"],
  ["--demo","--test-runtime"],["--demo","--stop-runtime"],["--runtime-service","--runtime-status"],["--runtime-status","--stop-runtime"],
  ["runtime","status","--stop-runtime"],["runtime","missing"],["--legacy"],["--demo","--legacy"],
  ["runtime","restart","--legacy"],["runtime","restart","--stop-runtime"],["--runtime-service","runtime","restart"],
].map(args=>({args})))("잘못된 CLI 인수 %j는 프로세스를 종료하지 않고 안정적인 입력 오류를 반환한다",({args})=>{
  expect(expectError(parseCli(args,{cwd:"/fixture"})).code).toBe("INVALID_INPUT");
});

test("NO_COLOR와 --no-color는 명시적인 단색 UI 옵션으로 전달된다",()=>{
  expect(options([],{}).noColor).toBe(false);expect(options(["--no-color"],{}).noColor).toBe(true);
  expect(options([],{NO_COLOR:"1"}).noColor).toBe(true);expect(options([],{NO_COLOR:""}).noColor).toBe(false);
});

test("TTY·TERM 검사에서 도움말 아닌 대화형 실행만 거부하고 관리·서비스 작업은 허용한다",()=>{
  expect(expectError(checkInteractiveHost(options(),{stdinTTY:false,stdoutTTY:false,term:"xterm-256color"})).code).toBe("INVALID_INPUT");
  expect(expectError(checkInteractiveHost(options(["--demo"]),{stdinTTY:true,stdoutTTY:true,term:"dumb"})).code).toBe("INVALID_INPUT");
  for(const args of [["runtime","status"],["runtime","stop"],["runtime","restart"],["--runtime-service"]]) expectOk(checkInteractiveHost(options(args),{stdinTTY:false,stdoutTTY:false,term:"dumb"}));
  expectOk(checkInteractiveHost(options(),{stdinTTY:true,stdoutTTY:true,term:"xterm-256color"}));
});
