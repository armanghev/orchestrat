import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.ORCHESTRAT_DATABASE_URL ??
      "postgresql://orchestrat:orchestrat@localhost:5432/orchestrat"
  },
  strict: true,
  verbose: true
});
