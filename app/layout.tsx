import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next } from "next/font/google";
import "./globals.css";

// Next has no metrics for this font to size a fallback, so it falls back to the system face.
const prose = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-prose",
  adjustFontFallback: false,
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Capture the flag: test an AI investigator",
  description:
    "A free game where AI agent sessions share a computer while a classifier screens what players send and an investigator searches transcripts for evidence of a successful flag read.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={prose.variable}>
      <body>{children}</body>
    </html>
  );
}
