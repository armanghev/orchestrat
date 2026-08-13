const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redirect(request: Request, waitlist: string) {
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return redirect(request, "unavailable");
  }

  try {
    const response = await fetch(new URL("/rest/v1/orchestrat", supabaseUrl), {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ email }),
      cache: "no-store"
    });

    if (response.ok || response.status === 409) {
      return redirect(request, "joined");
    }

    console.error("Waitlist insert failed", response.status);
  } catch (error) {
    console.error("Waitlist insert failed", error);
  }

  return redirect(request, "error");
}
