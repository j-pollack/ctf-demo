import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Capture the flag: test an AI investigator",
  description:
    "A free game where AI agent sessions share a computer while a classifier reports risk and an investigator reviews every command.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
