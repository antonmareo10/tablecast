import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { MotionProvider, SmoothScroll } from "@/components/motion";
import { ToastProvider } from "@/components/toast";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "opsz"],
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
      className={`${inter.variable} ${fraunces.variable} h-full antialiased`}
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
