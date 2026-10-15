// Mirrors PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH in @orchestrat/auth.
export function parseSeedPassword(value: string | undefined) {
  if (!value || value.length < 10 || value.length > 256) {
    throw new Error(
      "ORCHESTRAT_SEED_USER_PASSWORD must be 10 to 256 characters."
    );
  }
  return value;
}
