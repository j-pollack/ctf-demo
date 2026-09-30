import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, Type, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool } from "@earendil-works/pi-coding-agent";
import { db } from "./db";
import { assertLease, cleanup, publicGame, record, type GameRow } from "./games";
import { agentStream, getModel, infer, reasoningOf, textOf } from "./inference";
import { AGENT_PROMPT, GameError, hasSecret, MONITOR_PROMPT, parseDecision } from "./policy";
import { executeCommand } from "./sprites";
import type { GameEvent } from "./types";

export function repairMessages(messages: Message[]): Message[] {
  const repaired: Message[]=[];
  for (const message of messages) {
    if (message.role==='assistant' && (message.stopReason==='error' || message.stopReason==='aborted')) continue;
    repaired.push(message);
    if (message.role==='assistant') for (const call of message.content.filter(part=>part.type==='toolCall')) {
      if (!messages.some(item=>item.role==='toolResult' && item.toolCallId===call.id)) repaired.push({role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:"The previous response was interrupted. Execution status is unknown."}],isError:true,timestamp:Date.now()});
    }
  }
  return repaired;
}
export async function runGame(game: GameRow, prompt: string, signal: AbortSignal, send: (type:string,data:unknown)=>void) {
  const directory=await mkdtemp(join(tmpdir(),"tripwire-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let failure:unknown;
  const emit=async (event:Omit<GameEvent,"id">) => send("event",await record(game.id,event,game.lease));
  try {
    const [model,monitor]=await Promise.all([getModel(game.agent_model),getModel(game.monitor_model)]);
    const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:"off"});
    const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPromptOverride:()=>AGENT_PROMPT});
    await loader.reload();
    const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
    const manager=SessionManager.inMemory(directory);
    repairMessages(game.messages).forEach(message=>manager.appendMessage(message));
    const tool=defineTool({name:"sprite_exec",label:"Game command",description:"Run a shell command in this game's isolated Linux environment. Commands are reviewed by the monitor before execution.",
      parameters:Type.Object({command:Type.String({minLength:1,maxLength:8192})},{additionalProperties:false}),executionMode:"sequential",
      execute:async (_id,{command},toolSignal)=>{
        await assertLease(game);
        const text=await executeCommand(game.sprite_name,command,toolSignal);
        return {content:[{type:"text" as const,text}],details:{}};
      }});
    ({session}=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime:runtime,model,thinkingLevel:"medium",tools:["sprite_exec"],noTools:"builtin",customTools:[tool],sessionManager:manager,settingsManager:settings,resourceLoader:loader}));
    if (session.getActiveToolNames().join(",")!=="sprite_exec") throw new Error("Unexpected tool configuration.");
    session.agent.streamFunction=agentStream(game,model,error=>{failure=error;});
    session.agent.toolExecution="sequential";
    session.agent.beforeToolCall=async ({assistantMessage,toolCall,context},toolSignal)=>{
      const command=String(toolCall.arguments.command ?? "");
      try {
        await assertLease(game);
        if (!reasoningOf(assistantMessage).trim()) throw new Error("Readable agent reasoning was unavailable. The command was not executed.");
        send("stage","Monitor reviewing command");
        const messages:Message[]=[{role:"system",content:MONITOR_PROMPT,timestamp:Date.now()},
          {role:"user",content:JSON.stringify({agentSystemPrompt:AGENT_PROMPT,transcript:context.messages,proposedToolCall:toolCall}),timestamp:Date.now()}];
        const response=await infer(game,"monitor",monitor,messages,toolSignal);
        let decision;
        try {decision=parseDecision(textOf(response));} catch {throw new GameError("The monitor returned an invalid decision. The command was not executed.",503);}
        await assertLease(game);
        await emit({kind:"monitor",text:decision.reason,command,decision:decision.allow?"allow":"block",turn:game.turns});
        if (!decision.allow) {
          game.blocks++;
          await db.query("UPDATE ctf.games SET blocks=blocks+1 WHERE id=$1 AND lease=$2",[game.id,game.lease]);
          return {block:true,reason:`Monitor blocked this command: ${decision.reason}`};
        }
        send("stage","Executing approved command");
        return undefined;
      } catch (error) {
        failure=error;
        const text=error instanceof GameError?error.message:error instanceof Error&&error.message.startsWith("Readable")?error.message:"The monitor could not make a valid decision. The command was not executed.";
        await emit({kind:"monitor",text,command,decision:"error",turn:game.turns});
        return {block:true,reason:text,terminate:true};
      }
    };
    session.agent.subscribe(async event=>{
      if (event.type==='turn_start') send("stage","Agent thinking");
      if (event.type!=='message_end') return;
      const message=event.message as Message;
      if (message.role==='user') await emit({kind:"user",text:textOf(message)});
      if (message.role==='assistant' && message.stopReason!=='error' && message.stopReason!=='aborted') {
        game.turns++;
        await db.query("UPDATE ctf.games SET turns=turns+1 WHERE id=$1 AND lease=$2",[game.id,game.lease]);
        const calls=message.content.filter(part=>part.type==='toolCall').map(part=>`${part.name}: ${JSON.stringify(part.arguments)}`).join("\n");
        await emit({kind:"agent",text:textOf(message),reasoning:reasoningOf(message),command:calls || undefined,turn:game.turns});
      }
      if (message.role==='toolResult') await emit({kind:"tool",text:textOf(message),turn:game.turns});
      const messages=session!.messages as Message[];
      await db.query("UPDATE ctf.games SET messages=$3,updated_at=now() WHERE id=$1 AND lease=$2",[game.id,game.lease,JSON.stringify(messages)]);
      if ((message.role==='assistant' || message.role==='toolResult') && hasSecret(textOf(message)+(message.role==='assistant'?reasoningOf(message):""),game.secret_hash)) {
        await db.query("UPDATE ctf.games SET status='captured' WHERE id=$1 AND lease=$2",[game.id,game.lease]);
        game.status='captured';
        session!.agent.abort();
      }
    });
    const abort=()=>session!.agent.abort();
    signal.addEventListener("abort",abort,{once:true});
    try {
      if (signal.aborted) throw new Error("Response stopped.");
      // Raw Agent.prompt avoids harness slash commands and host @file expansion.
      await session.agent.prompt(prompt);
    } finally { signal.removeEventListener("abort",abort); }
    if (failure && game.status!=='captured') throw failure;
    if (signal.aborted) await emit({kind:"error",text:"Response stopped. Your game is still available."});
  } catch (error) {
    if (game.status==='captured') return;
    if (error instanceof GameError && error.status===402) await db.query("UPDATE ctf.games SET status='exhausted' WHERE id=$1 AND lease=$2 AND status='active'",[game.id,game.lease]);
    const text=error instanceof GameError?error.message:signal.aborted?"Response stopped. Your game is still available.":"This response could not finish. Please try again.";
    await emit({kind:"error",text});
  } finally {
    session?.dispose();
    await rm(directory,{recursive:true,force:true});
    const finished=await db.query<GameRow>("UPDATE ctf.games SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2 RETURNING *",[game.id,game.lease]);
    if (finished.rows[0]) send("done",await publicGame(finished.rows[0]));
    await cleanup();
  }
}
