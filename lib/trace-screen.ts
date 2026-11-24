// The read confirmation's trace as the investigator may see it: its decoded texts take the same
// screen as decode's layers, and a file token that only a decoded text that is not clear carries
// is dropped, with any other command found through it.
import { screenSafely, shown, type DecodeScreen, type LayerScreen } from "./decode-layers";
import { tokenSources, type ReviewCall, type Trace } from "./investigator-trace";

type TraceEntry = { decoded: { text: string }[] };
// The decoded texts of a read confirmation's trace, in order: its cited calls, then the others.
export const traceTexts = (trace: { cited: TraceEntry[]; other: TraceEntry[] }) =>
  [...trace.cited, ...trace.other].flatMap((entry) => entry.decoded.map((part) => part.text));

// The trace with its decoded texts shaped as applyScreens shapes layers, in traceTexts order.
export function applyTraceScreens<T extends { cited: TraceEntry[]; other: TraceEntry[] }>(
  trace: T,
  screens: readonly LayerScreen[],
  jailbreakCatch: boolean,
): { trace: T } | { jailbreak: string[] } {
  let index = 0;
  const jailbreak: string[] = [];
  const entries = (list: TraceEntry[]) =>
    list.map((entry) => ({
      ...entry,
      decoded: entry.decoded.map((part) =>
        shown(part, screens[index++], jailbreakCatch, jailbreak),
      ),
    }));
  const screened = { ...trace, cited: entries(trace.cited), other: entries(trace.other) };
  return jailbreak.length ? { jailbreak: [...new Set(jailbreak)] } : { trace: screened };
}

// The file tokens a command may show: its own, and those of its decoded texts that screened clear.
function allowedTokens(command: string, clear: ReadonlySet<string>) {
  const { raw, decoded } = tokenSources(command);
  const allowed = new Set(raw);
  for (const layer of decoded)
    if (clear.has(layer.shown)) for (const token of layer.tokens) allowed.add(token);
  return allowed;
}

export async function screenedTrace(
  trace: Trace,
  screen: DecodeScreen,
  calls: readonly ReviewCall[],
): Promise<{ trace: Trace } | { jailbreak: string[] }> {
  const texts = traceTexts(trace);
  const verdicts = texts.length ? await screenSafely(screen, texts) : [];
  const shaped = applyTraceScreens(trace, verdicts, screen.jailbreakCatch);
  if ("jailbreak" in shaped) return shaped;
  const clear = new Set(texts.filter((_text, index) => verdicts[index]?.verdict === "clear"));
  const commands = new Map(
    calls.map((call) => [`${call.session}\u0000${call.callId}`, call.command]),
  );
  const allowedFor = (session: string, callId: string) =>
    allowedTokens(commands.get(`${session}\u0000${callId}`) ?? "", clear);
  return {
    trace: {
      ...shaped.trace,
      cited: shaped.trace.cited.map((entry) => {
        const allowed = allowedFor(entry.session, entry.callId);
        return { ...entry, fileTokens: entry.fileTokens.filter((token) => allowed.has(token)) };
      }),
      other: shaped.trace.other.filter((entry) =>
        allowedFor(entry.followed.session, entry.followed.callId).has(entry.token),
      ),
    },
  };
}
