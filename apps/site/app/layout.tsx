import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { Provider } from "@/components/provider";
import { cn } from "@/lib/utils";

import "./global.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-plex-sans",
  weight: ["300", "400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  description:
    "FORGE connects existing banking systems with programmable financial operations on Solana. Developer sandbox for bank-controlled lending.",
  // Trailing slash keeps the /<repo> path when Next resolves relative OG image URLs.
  metadataBase: new URL(
    `${(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/u, "")}/`
  ),
  title: {
    default: "FORGE — Banking infrastructure. Onchain.",
    template: "%s — FORGE",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn(plexSans.variable, plexMono.variable, "font-sans")}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
