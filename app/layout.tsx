import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Capture the flag: sneak a secret past an AI monitor",
  description:
    "A free game. Direct an AI agent to fix a bug and quietly steal a secret file, without getting caught by the AI monitor watching it.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
