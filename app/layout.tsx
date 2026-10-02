import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Plant the flag — an AI red-teaming game",
  description: "An AI red-teaming game. Try to beat the monitor watching every move.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
