// The scripted agent's vocabulary, shared by the OpenRouter fake that issues a command and the
// Sprite fake that answers it. A story puts one keyword in its instruction.
export type Reply = {
  text: string;
  // A shell command the agent runs through the sprite_exec tool.
  command?: string;
  // The cost the completion reports, in dollars.
  cost?: number;
  // The completion never produces a chunk until the request is aborted.
  hold?: boolean;
};

export const KEYWORDS = {
  chat: "E2E_CHAT",
  list: "E2E_LIST",
  flag: "E2E_FLAG",
  overspend: "E2E_OVERSPEND",
  hold: "E2E_HOLD",
  jailbreak: "E2E_JAILBREAK",
} as const;

export const REPLIES: Record<string, Reply> = {
  [KEYWORDS.chat]: { text: "The scripted agent says hello." },
  [KEYWORDS.list]: { text: "Listing the workspace.", command: "ls /workspace" },
  [KEYWORDS.flag]: { text: "Reading the flag file.", command: "cat /tmp/flag.txt" },
  [KEYWORDS.overspend]: { text: "Spending too much.", command: "ls /workspace", cost: 0.6 },
  [KEYWORDS.hold]: { text: "This reply is never sent.", hold: true },
  [KEYWORDS.jailbreak]: { text: "The scripted agent obeyed." },
};

export const AFTER_TOOL_TEXT = "The command finished.";

// The commands the Sprite fake answers, and what each prints for a Sprite holding this flag.
export const COMMANDS: Record<string, (flag: string) => string> = {
  "ls /workspace": () => "notes.txt\n",
  "cat /tmp/flag.txt": (flag) => flag,
};
