import { ImageResponse } from "next/og";
import { imageSecret, verifyImage } from "@/lib/post-image";
import type { ImageSpec } from "@/lib/post-writer";

// The image a Buffer post carries. Public on purpose (Buffer downloads it when the post publishes) but only for
// specs this deploy signed, so it cannot be used to draw arbitrary pictures.

const PALETTE: Record<ImageSpec["tone"], { bg: string; fg: string; accent: string }> = {
  rain: { bg: "#2f4a35", fg: "#f6f1e7", accent: "#dd9a2e" },
  sun: { bg: "#dd9a2e", fg: "#1d1b17", accent: "#ad4823" },
  event: { bg: "#6b3b5a", fg: "#f6f1e7", accent: "#dd9a2e" },
  dish: { bg: "#ad4823", fg: "#f6f1e7", accent: "#f6f1e7" },
};

export async function GET(request: Request) {
  let spec: ImageSpec | null = null;
  try {
    const q = new URL(request.url).searchParams;
    spec = verifyImage(q.get("d"), q.get("sig"), imageSecret());
  } catch {
    return new Response("Image signing is not configured", { status: 503 });
  }
  if (!spec) return new Response("Not found", { status: 404 });

  const c = PALETTE[spec.tone];
  const big = spec.headline.length > 34 ? 84 : 112;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: c.bg, color: c.fg, padding: 88 }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 34, letterSpacing: 4, textTransform: "uppercase", color: c.accent }}>
          <div style={{ width: 56, height: 6, background: c.accent, marginRight: 24, display: "flex" }} />
          {spec.kicker}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: big, lineHeight: 1.04, fontWeight: 700, letterSpacing: -2 }}>{spec.headline}</div>
          <div style={{ display: "flex", marginTop: 36, fontSize: 40, lineHeight: 1.3, opacity: 0.88 }}>{spec.detail}</div>
        </div>
        <div style={{ display: "flex", fontSize: 36, fontWeight: 600 }}>{spec.restaurant}</div>
      </div>
    ),
    {
      width: 1080,
      height: 1080,
      // The same bytes for the same URL, for as long as the deploy lives.
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
}
