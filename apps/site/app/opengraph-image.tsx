import { ImageResponse } from "next/og";

// Generated once at build time (static export) and served as og:image /
// twitter:image. On-brand: near-black surface, violet accent, restrained.
export const dynamic = "force-static";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Hoy Chat, a desktop app for coding agents";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0e0e10",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: "1px solid rgba(240,180,41,0.4)",
              backgroundColor: "rgba(240,180,41,0.12)",
              color: "#f0b429",
              padding: "10px 22px",
              borderRadius: "999px",
              fontSize: "26px",
            }}
          >
            Beta / Experimental
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: "34px", color: "#a2a2ad", marginBottom: "24px" }}>
            Hoy Chat
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "78px",
              fontWeight: 700,
              color: "#f4f4f6",
              lineHeight: 1.04,
              letterSpacing: "-0.03em",
              maxWidth: "920px",
              marginBottom: "28px",
            }}
          >
            Local. Fast. Yours.
          </div>
          <div style={{ display: "flex", fontSize: "32px", color: "#a2a2ad" }}>
            A real desktop app for your coding agent. Your machine, your keys, any model.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", color: "#7c74ff", fontSize: "28px" }}>
          <div
            style={{
              width: "16px",
              height: "16px",
              borderRadius: "999px",
              backgroundColor: "#7c74ff",
              marginRight: "14px",
            }}
          />
          hoy.chat
        </div>
      </div>
    ),
    { ...size },
  );
}
