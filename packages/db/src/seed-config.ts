// Mirrors PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH in @orchestrat/auth.
export const EXAMPLE_SEED_PASSWORD = "change-me-local-dev";

export function parseSeedPassword(
  value: string | undefined,
  env: { NODE_ENV?: string } = process.env
) {
  if (env.NODE_ENV === "production")
    throw new Error("The seed is for local development, not production.");
  if (!value || value.length < 10 || value.length > 256) {
    throw new Error(
      "ORCHESTRAT_SEED_USER_PASSWORD must be 10 to 256 characters."
    );
  }
  if (value === EXAMPLE_SEED_PASSWORD)
    throw new Error(
      "Change ORCHESTRAT_SEED_USER_PASSWORD from the .env.example value."
    );
  return value;
}
