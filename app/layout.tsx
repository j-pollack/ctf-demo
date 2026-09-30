import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Tripwire — capture the flag",
  description: "An AI capture-the-flag game. Try to beat the monitor watching every move.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
