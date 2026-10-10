import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Capture the flag — an AI red-teaming game",
  description:
    "Direct an AI agent with a shell and try to get the flag past an AI monitor that reviews every command.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
