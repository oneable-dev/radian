import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageInfo from "../../package.json";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";

const entry=join(import.meta.dir,"..","index.ts");
async function run(args:string[],cwd:string,config:string,state:string) {
  const child=Bun.spawn([process.execPath,entry,...args],{cwd,env:{...process.env,XDG_CONFIG_HOME:config,RADIAN_STATE_DIR:state},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
  const timer=setTimeout(()=>child.kill("SIGTERM"),10000);
  try {const code=await child.exited;return{code,stdout:await stdout,stderr:await stderr};}finally{clearTimeout(timer);}
}

test("실제 --help·--version·인수 오류·비TTY 실행은 손상된 설정을 읽거나 런타임 상태를 만들지 않는다",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"radian-cli-entry-")),config=join(directory,"config"),state=join(directory,"state");
  try {
    await mkdir(join(config,"radian"),{recursive:true});
    for(const name of ["workspace.json","keybindings.json","theme.json"])await writeFile(join(config,"radian",name),"{broken");
    const help=await run(["--help"],directory,config,state);expect(help.code).toBe(0);expect(help.stdout).toContain("Usage: radian");expect(help.stderr).toBe("");
    const version=await run(["--version"],directory,config,state);expect(version.code).toBe(0);expect(version.stdout.trim()).toBe(packageInfo.version);
    const invalid=await run(["--unknown"],directory,config,state);expect(invalid.code).toBe(1);expect(invalid.stderr).toContain("INVALID_INPUT");
    const pipe=await run(["--demo"],directory,config,state);expect(pipe.code).toBe(1);expect(pipe.stderr).toContain("requires a TTY");
    for(const result of [help,version,invalid,pipe])expect(result.stdout+result.stderr).not.toContain("\x1b");
    // 정보 출력과 거절된 진입은 상태 디렉터리 자체를 만들지 않는다.
    expect(await readdir(directory)).toEqual(["config"]);
  }finally{await rm(directory,{recursive:true,force:true});}
},20000);

test("새 runtime 서브커맨드도 비TTY에서 단일 저장소를 조회·종료하며 없는 서비스를 시작하지 않는다",async()=>{
  const fixture=await createWorktreeFixture(),state=join(fixture.directory,"state"),config=join(fixture.directory,"config");
  try {
    await mkdir(join(config,"radian"),{recursive:true});await writeFile(join(config,"radian","workspace.json"),"{broken");
    for(const operation of ["status","stop"]) {
      const result=await run(["runtime",operation,"--test-runtime","--runtime-cwd",fixture.main,"--state-dir",state],fixture.main,config,state);
      expect(result.code).toBe(0);expect(result.stdout).toContain("No running workspace service.");expect(result.stderr).toBe("");
    }
    expect(await readdir(fixture.directory)).not.toContain("state");
  }finally{await fixture.cleanup();}
},20000);
