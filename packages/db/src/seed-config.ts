const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSeedAuthSubject(value: string | undefined) {
  const subject = value?.trim();
  if (!subject || !UUID_PATTERN.test(subject)) {
    throw new Error(
      "ORCHESTRAT_SEED_AUTH_SUBJECT must be a Supabase user UUID."
    );
  }
  return subject.toLowerCase();
}
