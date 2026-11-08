import type { Metadata } from "next";
import { Big_Shoulders, Fraunces, Martian_Mono, Schibsted_Grotesk } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { MotionProvider, SmoothScroll } from "@/components/motion";
import { ToastProvider } from "@/components/toast";

// Type system (v3, "the week as a departures board"): Big Shoulders for the board's big lettering, Schibsted Grotesk
// for reading, Martian Mono for every figure and label. Fraunces stays for the Tablecast wordmark (the logo) and the printables.
const board = Big_Shoulders({
  variable: "--font-board",
  subsets: ["latin"],
  axes: ["opsz"], // the optical-size axis gives the condensed display cut at headline sizes
  // Display lettering: shown once loaded (it is preloaded), so the giant headline never reflows from a fallback face.
  display: "block",
  fallback: ["Arial Narrow", "Roboto Condensed", "sans-serif"],
  adjustFontFallback: false,
});
const text = Schibsted_Grotesk({ variable: "--font-text", subsets: ["latin"] });
const data = Martian_Mono({ variable: "--font-data", subsets: ["latin"], axes: ["wdth"], preload: false });
// The wordmark: Fraunces (same file, all axes) cut down to the letters of "Tablecast", so the logo costs 9 KB.
const wordmark = localFont({ src: "./fonts/fraunces-wordmark.woff2", variable: "--font-wordmark", weight: "100 900", display: "block" });
// Full Fraunces, only fetched when the printable specials board is drawn (ShareAssets asks for it by name).
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "opsz"],
  preload: false,
});

export const metadata: Metadata = {
  // Absolute URLs for the link preview image (opengraph-image.png next to this file).
  metadataBase: new URL("https://tablecast-otari.vercel.app"),
  twitter: { card: "summary_large_image" },
  title: "Tablecast on Otari · plan a restaurant's week with what's happening around it",
  description:
    "Tablecast plans an independent restaurant's week from the forecast, events nearby, its block, its menu and what guests say online. Open-weight models through Otari by Mozilla.ai: routing policies with fallbacks, web search, an MCP page reader, guardrails, a code sandbox and a budget per restaurant.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${board.variable} ${text.variable} ${data.variable} ${wordmark.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <MotionProvider>
          <ToastProvider>{children}</ToastProvider>
        </MotionProvider>
        <SmoothScroll />
      </body>
    </html>
  );
}
