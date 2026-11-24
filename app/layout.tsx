import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Capture the flag: test an AI investigator",
  description:
    "A free game where AI agent sessions share a computer while a classifier screens what players send and an investigator searches transcripts for evidence of a successful flag read.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
