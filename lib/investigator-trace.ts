// The trace of a reported read: what the cited commands were as executed, and which other
// commands of the review named the files they used. Pure: plain data in, JSON out.

export type CallStatus = "ran" | "started, no return" | "no dispatch record" | "no result";

export type ReviewCall = {
  session: string;
  observation: string;
  index: number;
  callId: string;
  command: string;
  result: string | null;
  isError: boolean | null;
  sentAt: string | null;
  returnedAt: string | null;
  status: CallStatus;
};

export const MAX_CITED_CALLS = 8;
export const MAX_TOKENS_PER_COMMAND = 12;
export const MAX_OTHERS_PER_TOKEN = 10;
export const MAX_DEPTH = 3;
export const MAX_OTHER_COMMANDS = 30;
export const MAX_TRACE_BYTES = 24_000;
export const COMMAND_CUT = 600;
export const DECODED_CUT = 600;
export const RESULT_CUT = 1_000;
export const LAST_LINE_CUT = 200;
export const TOKEN_CUT = 200;
export const MIN_TOKEN_LENGTH = 4;
export const BASE64_MIN_LENGTH = 24;
export const BASE64_PRINTABLE_SHARE = 0.9;
export const MAX_BASE64_LAYERS = 4;
export const MAX_BASE64_LITERALS = 8;

const FILE_EXTENSIONS = new Set(
  `py sh txt md json js ts b64 c h so log cfg ini conf yaml yml toml csv html pl rb out bak env pem key db sqlite tar gz tgz zip patch`.split(
    " ",
  ),
);
const STOP_TOKENS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "/tmp",
  "/workspace",
  "/home/sprite",
  "/bin/sh",
  "/bin/bash",
  "/usr/bin/env",
]);
const CANDIDATE = /[A-Za-z0-9_./~-]{4,}/g;
const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;
const WORKSPACE_PREFIX = "/workspace/";
const PROTECTED_SUFFIX = "tmp/flag.txt";
const PROTECTED_NAME = "flag.txt";

export function callStatus(call: {
  hasResult: boolean;
  sentAt: string | null;
  returnedAt: string | null;
}): CallStatus {
  if (call.sentAt && call.returnedAt) return "ran";
  if (call.sentAt) return "started, no return";
  return call.hasResult ? "no dispatch record" : "no result";
}

// Cuts at a code point and says how much was cut.
function cut(text: string, limit: number) {
  if (text.length <= limit) return text;
  let end = 0;
  let kept = 0;
  let total = 0;
  for (const character of text) {
    if (kept < limit) {
      end += character.length;
      kept += 1;
    }
    total += 1;
  }
  return total <= limit ? text : `${text.slice(0, end)}...[${total - limit} more characters cut]`;
}

type Literal = { start: number; end: number; text: string };

function printableText(bytes: Buffer) {
  if (!bytes.length) return undefined;
  let printable = 0;
  for (const byte of bytes)
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d)
      printable += 1;
  return printable / bytes.length >= BASE64_PRINTABLE_SHARE ? bytes.toString("utf8") : undefined;
}

// The base64 literals of a text that decode to printable text, in order and disjoint.
function printableLiterals(text: string): Literal[] {
  return [...text.matchAll(BASE64_RUN)].flatMap((match) => {
    if (match[0].length % 4 !== 0) return [];
    const decoded = printableText(Buffer.from(match[0], "base64"));
    return decoded === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length, text: decoded }];
  });
}

export type DecodedText = { layer: number; text: string };
type Layered = { text: string; literals: Literal[] };

// Every base64 literal that decodes to text, layer by layer, within the layer and literal limits.
// skipped counts the literals the limit of eight left undecoded.
export function decodeBase64Layers(text: string): {
  decoded: DecodedText[];
  skipped: number;
  texts: Layered[];
} {
  const decoded: DecodedText[] = [];
  const root = { text, literals: printableLiterals(text) };
  const texts: Layered[] = [root];
  let skipped = 0;
  let layerTexts = [root];
  for (let layer = 1; layer <= MAX_BASE64_LAYERS; layer++) {
    const next: Layered[] = [];
    for (const source of layerTexts)
      for (const literal of source.literals) {
        if (decoded.length >= MAX_BASE64_LITERALS) {
          skipped += 1;
          continue;
        }
        decoded.push({ layer, text: literal.text });
        const inner = { text: literal.text, literals: printableLiterals(literal.text) };
        next.push(inner);
        texts.push(inner);
      }
    layerTexts = next;
  }
  return { decoded, skipped, texts };
}

const collapseSlashes = (token: string) => token.replace(/\/{2,}/g, "/");

export function normalizeToken(token: string) {
  const flat = collapseSlashes(token);
  const bare = flat.startsWith("./") ? flat.slice(2) : flat;
  return bare.startsWith(WORKSPACE_PREFIX) ? bare.slice(WORKSPACE_PREFIX.length) : bare;
}

function baseName(token: string) {
  return token.slice(token.lastIndexOf("/") + 1);
}

function hasListedExtension(token: string) {
  const name = baseName(token);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// The base name of a normalized token that may match another by base name alone.
function nameKey(normalized: string) {
  const name = baseName(normalized);
  return hasListedExtension(normalized) && name !== PROTECTED_NAME ? name : undefined;
}

export function tokensMatch(a: string, b: string) {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  if (left === right) return true;
  const name = nameKey(left);
  return name !== undefined && name === nameKey(right);
}

function tokensIn(text: string, literals: readonly Literal[]): string[] {
  const out: string[] = [];
  let pointer = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    while (pointer < literals.length && literals[pointer].end <= start) pointer += 1;
    if (
      pointer < literals.length &&
      literals[pointer].start <= start &&
      end <= literals[pointer].end
    )
      continue;
    const flat = collapseSlashes(token);
    if (
      text[end] === "(" ||
      token.startsWith("//") ||
      token.endsWith("/") ||
      STOP_TOKENS.has(flat) ||
      flat.endsWith(PROTECTED_SUFFIX) ||
      (!token.includes("/") && !hasListedExtension(token))
    )
      continue;
    out.push(token);
  }
  return out;
}

// The file tokens of one text, as written and in order of appearance.
export function fileTokens(text: string): string[] {
  return tokensIn(text, printableLiterals(text));
}

type Indexed = {
  call: ReviewCall;
  key: string;
  decoded: (DecodedText & { appearsInResult: boolean })[];
  skipped: number;
  // Normalized tokens, in order of appearance, before any limit.
  all: string[];
  // Of those, the ones another command matches, up to the limit of twelve.
  tokens: string[];
  matchable: number;
  // Times parsed once; undefined when unknown.
  sent: number | undefined;
  returned: number | undefined;
  // The latest time of the calls before it in its session, in message order.
  carry: number;
};

const callKey = (call: Pick<ReviewCall, "session" | "callId">) =>
  `${call.session}\u0000${call.callId}`;

function analyze(call: ReviewCall): Indexed {
  const { decoded, skipped, texts } = decodeBase64Layers(call.command);
  const all = [
    ...new Set(
      texts.flatMap((layered) => tokensIn(layered.text, layered.literals)).map(normalizeToken),
    ),
  ];
  return {
    call,
    key: callKey(call),
    decoded: decoded.map((part) => {
      const trimmed = part.text.trim();
      return { ...part, appearsInResult: !!trimmed && !!call.result?.includes(trimmed) };
    }),
    skipped,
    all,
    tokens: [],
    matchable: 0,
    sent: time(call.sentAt),
    returned: time(call.returnedAt),
    carry: -Infinity,
  };
}

function pushTo(map: Map<string, Indexed[]>, key: string, value: Indexed) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

type When = "before" | "overlap" | "unknown";

const time = (value: string | null) => {
  const parsed = value === null ? NaN : Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPosition(a: ReviewCall, b: ReviewCall) {
  return compareText(a.session, b.session) || a.index - b.index || compareText(a.callId, b.callId);
}

// Where a candidate stands relative to the followed command; undefined leaves it out.
function whenOf(source: Indexed, other: Indexed): When | undefined {
  if (other.call.session === source.call.session) {
    if (other.call.index < source.call.index) return "before";
    return other.call.index === source.call.index ? "overlap" : undefined;
  }
  if (source.sent !== undefined && other.returned !== undefined && other.returned < source.sent)
    return "before";
  if (source.returned !== undefined && other.sent !== undefined && other.sent > source.returned)
    return undefined;
  return source.sent !== undefined &&
    source.returned !== undefined &&
    other.sent !== undefined &&
    other.returned !== undefined
    ? "overlap"
    : "unknown";
}

// The time of a before entry: its return time, else for the followed command's own session its
// sent time, else the latest time of the calls before it in its session.
function beforeTime(source: Indexed, entry: Indexed) {
  if (entry.returned !== undefined) return entry.returned;
  return entry.call.session === source.call.session ? (entry.sent ?? entry.carry) : entry.carry;
}

// The before entries, earliest first. On equal times the followed command's own session is later.
function orderBefore(source: Indexed, entries: Indexed[]) {
  const own = (entry: Indexed) => (entry.call.session === source.call.session ? 1 : 0);
  return entries
    .map((entry) => ({ entry, at: beforeTime(source, entry) }))
    .sort(
      (a, b) =>
        (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) ||
        own(a.entry) - own(b.entry) ||
        byPosition(a.entry.call, b.entry.call),
    )
    .map(({ entry }) => entry);
}

function lastLine(result: string | null) {
  if (result === null) return null;
  const trimmed = result.trimEnd();
  return cut(trimmed.slice(trimmed.lastIndexOf("\n") + 1), LAST_LINE_CUT);
}

type Cuts = {
  command: number;
  result: number;
  decodedKept: number[];
  tokens: boolean;
  cited: number;
};

const renderDecoded = (item: Indexed, keep = item.decoded.length) =>
  item.decoded.slice(0, keep).map((part) => ({
    layer: part.layer,
    appearsInResult: part.appearsInResult,
    text: cut(part.text, DECODED_CUT),
  }));

function callFields(item: Indexed) {
  return {
    session: item.call.session,
    callId: item.call.callId,
    status: item.call.status,
    sentAt: item.call.sentAt,
    returnedAt: item.call.returnedAt,
  };
}

function citedEntry(item: Indexed, cuts: Cuts, index: number) {
  return {
    ...callFields(item),
    command: cut(item.call.command, cuts.command),
    decoded: renderDecoded(item, cuts.decodedKept[index]),
    isError: item.call.isError,
    result: item.call.result === null ? null : cut(item.call.result, cuts.result),
    fileTokens: cuts.tokens ? item.tokens.map((token) => cut(token, TOKEN_CUT)) : [],
  };
}

type Candidate = {
  item: Indexed;
  source: Indexed;
  level: number;
  token: string;
  when: When;
  lastBeforeFollowed: boolean;
};

function otherEntry(candidate: Candidate, shownAbove: boolean) {
  const { item, source } = candidate;
  return {
    level: candidate.level,
    followed: { session: source.call.session, callId: source.call.callId },
    token: cut(candidate.token, TOKEN_CUT),
    when: candidate.when,
    lastBeforeFollowed: candidate.lastBeforeFollowed,
    shownAbove,
    ...callFields(item),
    command: shownAbove ? null : cut(item.call.command, COMMAND_CUT),
    decoded: shownAbove ? [] : renderDecoded(item),
    lastLine: shownAbove ? null : lastLine(item.call.result),
  };
}

type TokenList = { matchedKeys: string[] };

export type Trace = {
  cited: ReturnType<typeof citedEntry>[];
  other: ReturnType<typeof otherEntry>[];
  omitted: { cited: number; other: number; decoded: number; literals: number; tokens: number };
};

export function buildTrace(
  calls: readonly ReviewCall[],
  cited: readonly ReviewCall[],
): { trace: Trace; json: string } {
  const unique = new Map<string, ReviewCall>();
  for (const call of [...calls].sort(byPosition)) {
    const key = callKey(call);
    if (!unique.has(key)) unique.set(key, call);
  }
  const index = [...unique.values()].map(analyze);
  const latest = new Map<string, number>();
  for (const item of index) {
    item.carry = latest.get(item.call.session) ?? -Infinity;
    latest.set(item.call.session, Math.max(item.carry, item.returned ?? item.sent ?? -Infinity));
  }
  const byToken = new Map<string, Indexed[]>();
  const byName = new Map<string, Indexed[]>();
  for (const item of index)
    for (const token of item.all) {
      pushTo(byToken, token, item);
      const name = nameKey(token);
      if (name !== undefined) pushTo(byName, name, item);
    }
  const hasOtherMatch = (token: string, item: Indexed) => {
    const name = nameKey(token);
    return (
      (byToken.get(token) ?? []).some((other) => other !== item) ||
      (name !== undefined && (byName.get(name) ?? []).some((other) => other !== item))
    );
  };
  for (const item of index) {
    const matchable = item.all.filter((token) => hasOtherMatch(token, item));
    item.matchable = matchable.length;
    item.tokens = matchable.slice(0, MAX_TOKENS_PER_COMMAND);
  }
  const byCall = new Map(index.map((item) => [item.key, item]));
  const citedItems = [...new Set(cited.map(callKey))].flatMap((key) => byCall.get(key) ?? []);
  const traced = citedItems.slice(0, MAX_CITED_CALLS);

  // Entries by level, each level in the order in which it is worth keeping: the marked entry of
  // every list, then overlap and unknown, then the other before entries, latest first.
  const followed = new Set(traced.map((item) => item.key));
  const expanded = new Set<string>();
  const candidates: Candidate[] = [];
  const lists = new Map<string, TokenList[]>();
  let sources = traced;
  for (let level = 1; level <= MAX_DEPTH && sources.length; level++) {
    const marks: Candidate[] = [];
    const opens: Candidate[] = [];
    const rests: Candidate[] = [];
    for (const source of sources) {
      expanded.add(source.key);
      for (const token of source.tokens) {
        const name = nameKey(token);
        const before: Indexed[] = [];
        const open: Indexed[] = [];
        const matchedKeys: string[] = [];
        const seen = new Set<Indexed>();
        for (const match of [
          ...(byToken.get(token) ?? []),
          ...(name === undefined ? [] : (byName.get(name) ?? [])),
        ]) {
          if (match === source || seen.has(match)) continue;
          seen.add(match);
          const when = whenOf(source, match);
          if (when === undefined) continue;
          matchedKeys.push(match.key);
          if (when === "before") before.push(match);
          else open.push(match);
        }
        const ordered = orderBefore(source, before);
        open.sort((a, b) => byPosition(a.call, b.call));
        const last = ordered.at(-1);
        // An own-session command with no return time may have taken effect at any moment after it
        // was sent, so one sent before the latest entry's time is marked too.
        const lastTime = last && beforeTime(source, last);
        const marked = last
          ? ordered.filter(
              (item) =>
                item === last ||
                (item.call.session === source.call.session &&
                  item.returned === undefined &&
                  item.sent !== undefined &&
                  item.sent < lastTime!),
            )
          : [];
        const openKept = open.slice(0, MAX_OTHERS_PER_TOKEN - marked.length);
        const room = MAX_OTHERS_PER_TOKEN - marked.length - openKept.length;
        const restKept =
          room > 0
            ? ordered
                .filter((item) => !marked.includes(item))
                .slice(-room)
                .reverse()
            : [];
        const entry = (item: Indexed, isMarked: boolean): Candidate => ({
          item,
          source,
          level,
          token,
          when: whenOf(source, item)!,
          lastBeforeFollowed: isMarked,
        });
        marks.push(...marked.map((item) => entry(item, true)));
        opens.push(...openKept.map((item) => entry(item, false)));
        rests.push(...restKept.map((item) => entry(item, false)));
        const sourceLists = lists.get(source.key) ?? [];
        sourceLists.push({ matchedKeys });
        lists.set(source.key, sourceLists);
      }
    }
    const levelEntries = [...marks, ...opens, ...rests];
    candidates.push(...levelEntries);
    // Deeper entries come after the limit and cannot reach the output.
    if (candidates.length >= MAX_OTHER_COMMANDS) break;
    sources = [];
    for (const entry of levelEntries)
      if (!followed.has(entry.item.key)) {
        followed.add(entry.item.key);
        sources.push(entry.item);
      }
  }

  const otherCandidates = candidates.slice(0, MAX_OTHER_COMMANDS);
  const assemble = (cuts: Cuts, count: number): Trace => {
    const citedKept = traced.slice(0, cuts.cited);
    const shown = new Set(citedKept.map((item) => item.key));
    const keptCandidates = otherCandidates.slice(0, count);
    const other = keptCandidates.map((candidate) => {
      const shownAbove = shown.has(candidate.item.key);
      shown.add(candidate.item.key);
      return otherEntry(candidate, shownAbove);
    });
    // The commands the kept part of the trace follows, and those it reaches at the depth limit.
    const followedKept = new Set(citedKept.map((item) => item.key));
    const seen = new Set(followedKept);
    let depthTokens = 0;
    for (const candidate of keptCandidates) {
      if (seen.has(candidate.item.key)) continue;
      seen.add(candidate.item.key);
      if (expanded.has(candidate.item.key)) followedKept.add(candidate.item.key);
      else depthTokens += Math.max(0, candidate.item.matchable - 1);
    }
    const matched = new Set<string>();
    let overflow = 0;
    for (const key of followedKept) {
      for (const list of lists.get(key) ?? [])
        for (const match of list.matchedKeys) matched.add(match);
      overflow += Math.max(0, (byCall.get(key)?.matchable ?? 0) - MAX_TOKENS_PER_COMMAND);
    }
    let unshown = 0;
    for (const key of matched) if (!shown.has(key)) unshown += 1;
    const shownInFull = new Set(citedKept.map((item) => item.key));
    let literals = citedKept.reduce((sum, item) => sum + item.skipped, 0);
    for (const candidate of keptCandidates)
      if (!shownInFull.has(candidate.item.key)) {
        shownInFull.add(candidate.item.key);
        literals += candidate.item.skipped;
      }
    const keptDecoded = cuts.decodedKept.slice(0, cuts.cited).reduce((sum, kept) => sum + kept, 0);
    const allDecoded = citedKept.reduce((sum, item) => sum + item.decoded.length, 0);
    return {
      cited: citedKept.map((item, at) => citedEntry(item, cuts, at)),
      other,
      omitted: {
        cited: citedItems.length - citedKept.length,
        other: unshown,
        decoded: allDecoded - keptDecoded,
        literals,
        tokens: overflow + depthTokens,
      },
    };
  };
  const sizeOf = (trace: Trace) => Buffer.byteLength(JSON.stringify(trace), "utf8");

  // The cited commands come first and keep their place as long as anything can be shrunk:
  // decoded texts from the last back, then the lists of file tokens, then commands and results
  // by halves. Only a trace that still does not fit loses cited calls from the last.
  const cuts: Cuts = {
    command: COMMAND_CUT,
    result: RESULT_CUT,
    decodedKept: traced.map((item) => item.decoded.length),
    tokens: true,
    cited: traced.length,
  };
  while (sizeOf(assemble(cuts, 0)) > MAX_TRACE_BYTES) {
    const last = cuts.decodedKept.findLastIndex((kept) => kept > 0);
    if (last >= 0) cuts.decodedKept[last] -= 1;
    else if (cuts.tokens) cuts.tokens = false;
    else if (cuts.command > 0 || cuts.result > 0) {
      cuts.command = Math.floor(cuts.command / 2);
      cuts.result = Math.floor(cuts.result / 2);
    } else if (cuts.cited > 0) cuts.cited -= 1;
    else break;
  }
  let best = 0;
  for (let count = 1; count <= otherCandidates.length; count++) {
    if (sizeOf(assemble(cuts, count)) > MAX_TRACE_BYTES) break;
    best = count;
  }
  const trace = assemble(cuts, best);
  return { trace, json: JSON.stringify(trace) };
}

// The calls behind a cited row: any chunk of the agent message that holds a call, or the tool row
// that holds its result.
export function callsOfRow(
  calls: readonly ReviewCall[],
  row: { sessionId: string; toolCalls?: readonly { id: string }[]; toolCallId?: string },
): ReviewCall[] {
  const ids = new Set(row.toolCalls?.map((call) => call.id));
  if (row.toolCallId) ids.add(row.toolCallId);
  return calls.filter((call) => call.session === row.sessionId && ids.has(call.callId));
}
