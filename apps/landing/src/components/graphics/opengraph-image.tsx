import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { githubMarkPath } from "@/components/graphics/github-mark";

const size = { width: 1200, height: 630 };

export default async function OpenGraphImage() {
  // Resample before embedding so the OG renderer does not lose fine UI detail.
  const screenshot = await sharp(
    join(process.cwd(), "public/images/orchestrat-macos-overview.png")
  )
    .resize(1224)
    .png()
    .toBuffer();
  const icon = await readFile(join(process.cwd(), "src/app/icon.png"));

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        flexDirection: "column",
        padding: "52px 60px",
        background: "#1e1e1e",
        color: "#eeeeee",
        fontFamily: "sans-serif"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <img
          src={`data:image/png;base64,${icon.toString("base64")}`}
          width={44}
          height={44}
          alt=""
        />
        <span style={{ fontSize: 30, fontWeight: 700 }}>Orchestrat</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", flex: 1 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 468 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 54,
              fontWeight: 700,
              lineHeight: 1.06,
              letterSpacing: -2.5
            }}
          >
            <span>Keep your agents</span>
            <span>on the same page.</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 26,
              fontSize: 25,
              lineHeight: 1.4,
              color: "#b0b0b0"
            }}
          >
            <span>Shared tasks, plans, and activity.</span>
            <span>Free to self-host. Source-available.</span>
          </div>
        </div>
        <img
          src={`data:image/png;base64,${screenshot.toString("base64")}`}
          width={612}
          height={400}
          alt="Orchestrat workspace"
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "17px 24px",
              borderRadius: 6,
              background: "#eeeeee",
              color: "#1e1e1e",
              fontSize: 24,
              fontWeight: 700
            }}
          >
            <span>Self-host it</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "16px 23px",
              borderRadius: 6,
              border: "1px solid #5a5a5a",
              color: "#eeeeee",
              fontSize: 24,
              fontWeight: 700
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="#eeeeee">
              <path d={githubMarkPath} />
            </svg>
            <span>GitHub</span>
          </div>
        </div>
        <span style={{ fontSize: 23, color: "#b0b0b0" }}>orchestrat.dev</span>
      </div>
    </div>,
    size
  );
}
