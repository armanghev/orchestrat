import { waitlistWelcomeEmail } from "../../../lib/waitlist-email";
import { waitlistDatabase } from "../../../lib/waitlist-db";

export const runtime = "nodejs";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendWelcomeEmail(email: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("Waitlist welcome email skipped: RESEND_API_KEY is missing");
    return;
  }

  // ponytail: best-effort delivery; use a durable queue if automatic retries become necessary.
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Orchestrat <welcome@orchestrat.dev>",
        to: [email],
        ...waitlistWelcomeEmail
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      console.error("Waitlist welcome email failed", response.status);
    }
  } catch {
    console.error("Waitlist welcome email failed: request could not complete");
  }
}

function redirect(request: Request, waitlist: string) {
  if (request.headers.get("accept")?.includes("application/json"))
    return Response.json(
      { status: waitlist },
      {
        status: waitlist === "joined" ? 200 : waitlist === "invalid" ? 400 : 503
      }
    );
  return Response.redirect(
    new URL(`/?waitlist=${waitlist}#waitlist`, request.url),
    303
  );
}

export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return redirect(request, "invalid");
  }

  if (String(formData.get("company") ?? "").trim()) {
    return redirect(request, "joined");
  }

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) {
    return redirect(request, "invalid");
  }

  if (!process.env.WAITLIST_DATABASE_URL) {
    return redirect(request, "unavailable");
  }

  try {
    const result = await waitlistDatabase.insert(email);
    if (result === "joined") {
      await sendWelcomeEmail(email);
      return redirect(request, "joined");
    }

    if (result === "duplicate") {
      return redirect(request, "joined");
    }

    console.error("Waitlist insert failed: database is unavailable");
  } catch (error) {
    console.error("Waitlist insert failed", error);
  }

  return redirect(request, "error");
}
