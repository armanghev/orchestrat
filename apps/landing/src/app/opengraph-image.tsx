import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import sharp from "sharp";

export const alt =
  "Orchestrat — Keep your agents on the same page. Tasks, context, and agent activity in one shared workspace. Join the waitlist at orchestrat.dev.";
export const size = { width: 2400, height: 1260 };
export const contentType = "image/png";
export const dynamic = "force-static";

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
        transform: "scale(2)",
        transformOrigin: "top left",
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
            <span>Tasks, context, and agent activity.</span>
            <span>One shared workspace.</span>
          </div>
        </div>
        <img
          src={`data:image/png;base64,${screenshot.toString("base64")}`}
          width={612}
          height={400}
          alt="Orchestrat workspace on macOS"
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
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
          <span>Join the waitlist</span>
        </div>
        <span style={{ fontSize: 23, color: "#b0b0b0" }}>orchestrat.dev</span>
      </div>
    </div>,
    size
  );
}
