import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const entry=join(import.meta.dir,"..","index.ts");
async function terminalRun(args:string[],directory:string,extra:NodeJS.ProcessEnv={}) {
  let raw="",ready=false,detached=false,timedOut=false;
  const env:NodeJS.ProcessEnv={...process.env,TERM:"xterm-256color",XDG_CONFIG_HOME:join(directory,"config"),RADIAN_STATE_DIR:join(directory,"state"),...extra};
  delete env.FORCE_COLOR;delete env.CLICOLOR_FORCE;
  const child=Bun.spawn([process.execPath,entry,...args],{cwd:directory,env,
    terminal:{cols:120,rows:24,name:env.TERM ?? "xterm-256color",data:(terminal,bytes)=>{
      raw+=new TextDecoder().decode(bytes);
      if(raw.includes("Workspace")&&!detached){ready=true;detached=true;terminal.write("\x00d");}
    }}});
  const timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");},8000);
  try {const code=await child.exited;return{code,raw,ready,timedOut};}
  finally{clearTimeout(timer);child.terminal?.close();}
}
function coloredSGR(raw:string):boolean {
  return [...raw.matchAll(/\x1b\[([\d;:]*)m/gu)].some((match)=>match[1]!.split(/[;:]/u).map(Number)
    .some((code)=>code===38||code===48||code===58||code>=30&&code<=37||code>=40&&code<=47||code>=90&&code<=107));
}

test("실제 PTY의 --no-color와 NO_COLOR는 단색으로 그린 뒤 정상 detach와 터미널 복구를 마친다",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"radian-cli-mono-"));
  try {
    for(const [args,env] of [[["--demo","--no-color"],{NO_COLOR:""}],[["--demo"],{NO_COLOR:"1"}]] as const) {
      const result=await terminalRun([...args],directory,env);
      expect(result.timedOut).toBe(false);expect(result.code).toBe(0);expect(result.ready).toBe(true);
      expect(coloredSGR(result.raw)).toBe(false);
      expect(result.raw).toContain("\x1b[?1049l");expect(result.raw).toContain("\x1b[?25h");
    }
    const colored=await terminalRun(["--demo"],directory,{NO_COLOR:""});
    expect(colored.code).toBe(0);expect(colored.ready).toBe(true);expect(coloredSGR(colored.raw)).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
},30000);

test("TERM=dumb는 실제 TTY에서도 UI 모드에 진입하지 않고 깨끗한 안내로 종료한다",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"radian-cli-dumb-"));
  try {
    const result=await terminalRun(["--demo"],directory,{TERM:"dumb"});
    expect(result.timedOut).toBe(false);expect(result.code).toBe(1);expect(result.ready).toBe(false);
    expect(result.raw).toContain("TERM=dumb");expect(result.raw).not.toContain("\x1b");
  }finally{await rm(directory,{recursive:true,force:true});}
},15000);
