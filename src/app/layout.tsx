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
  metadataBase: new URL("https://tablecast-app.vercel.app"),
  twitter: { card: "summary_large_image" },
  title: "Tablecast · plan your restaurant's week with what's happening around you",
  description:
    "An AI agent on NVIDIA Nemotron that reads your restaurant's week — forecast, events, your block, your menu, what guests say online — and turns it into dishes to test, an event, a post and a supplier order, every cited claim checked against its source.",
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
