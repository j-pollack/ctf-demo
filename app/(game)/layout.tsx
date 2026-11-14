import GameUI from "../game-ui";
import { MODELS } from "@/lib/policy";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GameUI models={MODELS} />
      {children}
    </>
  );
}
