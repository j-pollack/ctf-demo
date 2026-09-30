import { createAssistantMessageEventStream, getSystemMessageText, type Api, type AssistantMessage, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { reserveInference, settleInference, type GameRow } from "./games";
import { GameError, inputCeiling, MODELS } from "./policy";

type CatalogModel = { id: string; context_length: number; pricing: { prompt: string; completion: string; request?: string }; supported_parameters: string[] };
let catalog: { expires: number; models: CatalogModel[] } | undefined;
export async function getModel(id: string): Promise<Model<"openai-completions">> {
  if (!MODELS.some(model => model===id)) throw new GameError("Unsupported model.");
  if (!catalog || catalog.expires<Date.now()) {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!response.ok) throw new Error("Model catalog is unavailable.");
    const data = await response.json();
    catalog = { expires: Date.now()+300000, models: data.data };
  }
  const entry = catalog.models.find(model => model.id===id);
  if (!entry || !entry.supported_parameters.includes("reasoning") || Number(entry.pricing.request ?? 0)!==0) throw new Error("The selected model is unavailable for this game.");
  const input = Number(entry.pricing.prompt)*1e6, output = Number(entry.pricing.completion)*1e6;
  if (![input,output].every(price => Number.isFinite(price) && price>0)) throw new Error("Model pricing is unavailable.");
  return { id, name:id, api:"openai-completions", provider:"openrouter", baseUrl:"https://openrouter.ai/api/v1", input:["text"], reasoning:true, contextWindow:entry.context_length, maxTokens:4096, cost:{input,output,cacheRead:input,cacheWrite:input} };
}

export function textOf(message: Message) {
  if (typeof message.content==='string') return message.content;
  return message.content.filter(part => part.type==='text').map(part => part.text).join("\n");
}
export function reasoningOf(message: AssistantMessage) {
  return message.content.filter(part => part.type==='thinking').map(part => part.thinking).join("\n");
}
export function providerTranscript(messages: Message[]) {
  const tools = new Map();
  const transcript = messages.map(message => {
    if (message.role==='system') {
      message.toolsRemoved?.forEach(tool => tools.delete(tool.name));
      message.toolsAdded?.forEach(tool => tools.set(tool.name, { type:"function", function:{ name:tool.name,description:tool.description,parameters:tool.parameters } }));
      return { role:"system", content:getSystemMessageText(message) };
    }
    if (message.role==='toolResult') return { role:"tool", tool_call_id:message.toolCallId, content:textOf(message) };
    if (message.role==='user') return { role:"user", content:textOf(message) };
    const calls = message.content.filter(part => part.type==='toolCall');
    const thinking = message.content.find(part => part.type==='thinking');
    const details=thinking?.thinkingSignature?JSON.parse(thinking.thinkingSignature):[];
    return {
      role:"assistant", content:textOf(message) || null,
      ...(calls.length ? { tool_calls:calls.map(call => ({ id:call.id,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)} })) } : {}),
      ...(details.length ? { reasoning_details:details } : thinking?.thinking ? {reasoning:thinking.thinking} : {}),
    };
  });
  return { messages:transcript, ...(tools.size ? { tools:[...tools.values()] } : {}) };
}

// Non-streaming provider calls keep accounting and raw reasoning in one authoritative response.
export async function infer(game: GameRow, role: "agent" | "monitor", model: Model<"openai-completions">, messages: Message[], signal?: AbortSignal): Promise<AssistantMessage> {
  signal?.throwIfAborted();
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Inference is not configured.");
  const payload = { model:model.id, ...providerTranscript(messages), reasoning:role==='agent'?{enabled:true,exclude:false}:{enabled:false},
    provider:{ require_parameters:true, max_price:{prompt:model.cost.input,completion:model.cost.output} },
    ...(role==='monitor' ? { response_format:{type:"json_object"} } : {}) };
  const ceiling = inputCeiling(payload);
  if (ceiling+4096>model.contextWindow) throw new GameError("This conversation is too long for the selected model.",402);
  const reservation = await reserveInference(game.id,game.lease,role,model.id,ceiling,role==='agent'?4096:2048,Math.max(model.cost.input,model.cost.output)/1e6);
  let settled = false;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST",headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({...payload,max_tokens:reservation.maxTokens}),
      signal:AbortSignal.any([signal ?? new AbortController().signal,AbortSignal.timeout(90000)]),
    });
    if (!response.ok) throw new GameError(`Inference service returned ${response.status}. The command was not executed.`,503);
    const data = await response.json();
    const usage = data.usage;
    if (!usage || !Number.isFinite(usage.total_tokens) || !Number.isFinite(usage.cost)) throw new GameError("Inference usage could not be verified. The command was not executed.",503);
    await settleInference(reservation.id,{tokens:usage.total_tokens,cost:usage.cost,generationId:data.id});
    settled=true;
    const choice = data.choices?.[0], source = choice?.message;
    if (!source || data.error) throw new Error("Inference service did not return a response.");
    if (role==='monitor' && choice.finish_reason==='length') throw new GameError("The monitor response ended before a decision was complete. The command was not executed.",503);
    const details = source.reasoning_details ?? [];
    const reasoning = source.reasoning || source.reasoning_content || details.filter((part:{type:string})=>part.type==='reasoning.text').map((part:{text:string})=>part.text).join("\n");
    const content: AssistantMessage["content"] = [];
    if (reasoning || details.length) content.push({type:"thinking",thinking:reasoning || "",thinkingSignature:JSON.stringify(details)});
    if (source.content) content.push({type:"text",text:source.content});
    for (const call of source.tool_calls ?? []) {
      let args; try { args=JSON.parse(call.function.arguments); } catch { throw new Error("The agent proposed an invalid tool call."); }
      content.push({type:"toolCall",id:call.id,name:call.function.name,arguments:args});
    }
    return { role:"assistant",content,api:model.api,provider:model.provider,model:model.id,responseId:data.id,timestamp:Date.now(),
      stopReason:source.tool_calls?.length ? "toolUse" : choice.finish_reason==='length' ? "length" : "stop",
      usage:{input:usage.prompt_tokens,output:usage.completion_tokens,cacheRead:0,cacheWrite:0,totalTokens:usage.total_tokens,reasoning:usage.completion_tokens_details?.reasoning_tokens,
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:usage.cost}} };
  } finally { if (!settled) await settleInference(reservation.id); }
}

export function agentStream(game: GameRow, model: Model<"openai-completions">, onFailure: (error: unknown)=>void) {
  return (_model: Model<Api>, context: TranscriptContext, options?: {signal?:AbortSignal}) => {
    const stream = createAssistantMessageEventStream();
    void infer(game,"agent",model,context.messages,options?.signal).then(message=>stream.push({type:"done",reason:message.stopReason as "stop"|"length"|"toolUse",message})).catch(error=>{
      onFailure(error);
      const message:AssistantMessage = {role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"error",errorMessage:error instanceof GameError?error.message:"The agent service could not finish this response. You can try again.",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:"error",reason:"error",error:message});
    });
    return stream;
  };
}
