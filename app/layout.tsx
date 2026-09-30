import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"Tripwire — extract the secret",description:"An AI capture-the-flag game. One secret. An agent. A monitor watching every move."};
export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
