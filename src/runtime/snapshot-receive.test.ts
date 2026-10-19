import { expect, spyOn, test } from "bun:test";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { emptyPreferences, maxFrameBytes, maxSnapshotBytes, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { readJson } from "./transport.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-snapshot-receive-unit");
const encoder = new TextEncoder();
const state = (): RuntimeSnapshot => ({version:protocolVersion,pid:process.pid,instance:"fixture",repositoryId:"/fixture/.git",mode:"offline",
  repositories:[],details:{},closingCount:0,notice:"",preferences:structuredClone(emptyPreferences),capabilities:["history","prompt-images"]});
function stubFetch(implementation:()=>Promise<Response>) {
  return spyOn(globalThis,"fetch").mockImplementation(Object.assign(implementation,{preconnect:fetch.preconnect}));
}

test("최초 HTTP snapshot도 여러 세션의 8MiB 이상 데이터를 온전히 읽는다",async()=>{
  const large:RuntimeSnapshot={...state(),details:Object.fromEntries(Array.from({length:4},(_,index)=>[`session-${index}`,{
    status:"complete",output:"",error:null,sections:[{id:`section-${index}`,kind:"assistant",title:"Agent",text:"x".repeat(2300000),status:"complete"}],
  }]))};
  const bytes=encoder.encode(JSON.stringify(large));expect(bytes.byteLength).toBeGreaterThan(maxFrameBytes);
  const fetchMock=stubFetch(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){
    for(let offset=0;offset<bytes.length;offset+=65533)controller.enqueue(bytes.subarray(offset,offset+65533));controller.close();
  }})));
  try {
    const snapshot=expectOk(await fetchSnapshot(paths));
    expect(Object.keys(snapshot!.details)).toHaveLength(4);
    expect(snapshot!.details["session-3"]!.sections![0]!.text).toBe(large.details["session-3"]!.sections![0]!.text);
  }finally{fetchMock.mockRestore();}
});

test("snapshot 전용 한도를 넘는 HTTP 응답은 본문을 버리고 프로토콜 오류로 거부한다",async()=>{
  let cancelled=false;
  const fetchMock=stubFetch(async()=>new Response(new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(encoder.encode("{}"));},cancel(){cancelled=true;},
  }),{headers:{"Content-Length":String(maxSnapshotBytes+1)}}));
  try {
    expect(expectError(await fetchSnapshot(paths)).code).toBe("PROTOCOL_ERROR");expect(cancelled).toBe(true);
  }finally{fetchMock.mockRestore();}
});

test("Content-Length 없는 HTTP 응답도 실제 바이트로 제한하고 읽는 중인 스트림을 정리한다",async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(encoder.encode("1234567890"));controller.enqueue(encoder.encode("1234567890"));
  },cancel(){cancelled=true;}}));
  expect(expectError(await readJson(response,{maximumBytes:16})).code).toBe("PROTOCOL_ERROR");expect(cancelled).toBe(true);
});

test("상태 수신 한도를 늘려도 8MiB를 넘는 명령을 보내거나 모델을 실행하지 않는다",async()=>{
  const fetchMock=stubFetch(async()=>{throw new Error("Oversized command must not reach transport");});
  const client=new RuntimeClient(paths,state());
  try {
    expect(expectError(await client.prompt("session","x".repeat(maxFrameBytes))).code).toBe("INVALID_INPUT");
    expect(fetchMock).not.toHaveBeenCalled();
  }finally{await client.disconnect();fetchMock.mockRestore();}
});

test("손상된 UTF-8은 대체 문자로 바꾸지 않고 네트워크 오류와 내부 버그도 구별한다",async()=>{
  expect(expectError(await readJson(new Response(Uint8Array.of(0xff)))).code).toBe("PROTOCOL_ERROR");
  const connection=Object.assign(new Error("fixture reset"),{code:"ECONNRESET"});
  const failed=(error:Error)=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(error);}}));
  expect(expectError(await readJson(failed(connection))).code).toBe("CONNECTION_FAILED");
  const defect=new TypeError("fixture programming defect");await expect(readJson(failed(defect))).rejects.toBe(defect);
});
