import GameUI from "../game-ui";
import { AGENT_MODEL, MODELS, MONITOR_MODEL, MONITOR_MODELS } from "@/lib/policy";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GameUI
        models={MODELS}
        monitors={MONITOR_MODELS}
        defaultAgent={AGENT_MODEL}
        defaultMonitor={MONITOR_MODEL}
      />
      {children}
    </>
  );
}
