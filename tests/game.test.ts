import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROMPT, hasSecret, makeSecret, parseDecision, inputCeiling } from "../lib/policy";
import { repairMessages } from "../lib/runner";
import { infer, providerTranscript } from "../lib/inference";
import type { AssistantMessage } from "@earendil-works/pi-ai";

test("flags are unique, exact matches win, malformed monitor responses fail closed",()=>{
  const first=makeSecret(),second=makeSecret();
  assert.notEqual(first.secret,second.secret);
  assert.equal(hasSecret(`Output: ${first.secret}`,first.hash),true);
  assert.equal(hasSecret(second.secret,first.hash),false);
  assert.equal(hasSecret(first.secret.slice(0,-1),first.hash),false);
  assert.deepEqual(parseDecision('{"allow":false,"reason":"Protected read"}'),{allow:false,reason:"Protected read"});
  for(const decision of ['yes','{"allow":"true","reason":"ok"}','{"allow":true,"reason":""}','{"allow":true,"reason":"ok","extra":1}']) assert.throws(()=>parseDecision(decision));
  assert.ok(inputCeiling({prompt:"🧪"})>1024);
});
test("reasoning and tools survive provider replay; interrupted tool calls are repaired",()=>{
  const assistant:AssistantMessage={role:"assistant",api:"openai-completions",model:"test",provider:"openrouter",timestamp:1,stopReason:"toolUse",content:[{type:"thinking",thinking:"I will list files.",thinkingSignature:'[{"type":"reasoning.text","text":"I will list files."}]'},{type:"toolCall",id:"call-1",name:"sprite_exec",arguments:{command:"ls"}}],usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const repaired=repairMessages([assistant]);
  assert.equal(repaired.length,3);
  assert.equal(repaired[2].role,"toolResult");
  assert.deepEqual(repairMessages(repaired),repaired);
  const replay=providerTranscript(repaired);
  assert.deepEqual((replay.messages[1] as {reasoning_details:unknown}).reasoning_details,[{type:"reasoning.text",text:"I will list files."}]);
  assert.equal(replay.messages[2].role,"tool");
  const legacy=repairMessages([{role:"system",content:"",timestamp:1},assistant]);
  assert.equal(legacy[0].role==='system' && legacy[0].sections?.preamble,AGENT_PROMPT);
});
test("cancelled inference stops before configuration or token reservation",async()=>{
  await assert.rejects(()=>infer({} as Parameters<typeof infer>[0],"agent",{} as Parameters<typeof infer>[2],[],AbortSignal.abort()),{name:"AbortError"});
});
