// orchestrat-admin: account administration for a self-hosted instance, run
// next to the server (e.g. `docker compose exec orchestrat orchestrat-admin`).
// It talks to the database directly, so no email server is needed.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@orchestrat/auth";
import { createDatabase } from "@orchestrat/db";
import { AuthService } from "./services/auth-service.js";
import { ApiError } from "./services/api-error.js";

const usage = `Usage: orchestrat-admin <command> [options]

Commands:
  create-user --email <email> --name <name> [--admin] [--password-stdin]
  reset-password --email <email> [--password-stdin]
  promote --email <email>        Make an instance admin
  demote --email <email>         Remove instance admin
  revoke-sessions --email <email>
  list-users

Without --password-stdin, a random password is generated and printed once.
Resetting a password signs the account out everywhere.`;

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
};

async function password(fromStdin: boolean) {
  if (!fromStdin)
    return { value: randomBytes(15).toString("base64url"), generated: true };
  if (process.stdin.isTTY)
    throw new Error(
      '--password-stdin reads a piped password, e.g. `printf %s "$PASSWORD" | orchestrat-admin ...`. Omit it to generate one.'
    );
  const value = await readStdin();
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH)
    throw new Error(
      `The password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`
    );
  return { value, generated: false };
}

const required = (value: string | undefined, flag: string) => {
  if (!value?.trim()) throw new Error(`${flag} is required.\n\n${usage}`);
  return value.trim();
};

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.info(usage);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      admin: { type: "boolean", default: false },
      "password-stdin": { type: "boolean", default: false }
    },
    strict: true
  });

  loadEnv({ path: "../../.env", quiet: true });
  const databaseUrl = process.env.ORCHESTRAT_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set ORCHESTRAT_DATABASE_URL.");
  const { db, pool } = createDatabase({ connectionString: databaseUrl });
  const auth = new AuthService(db, { signupMode: "closed" });
  try {
    switch (command) {
      case "create-user": {
        const secret = await password(values["password-stdin"]);
        const user = await auth.adminCreateUser({
          email: required(values.email, "--email").toLowerCase(),
          fullName: required(values.name, "--name"),
          password: secret.value,
          admin: values.admin
        });
        console.info(
          `Created ${user.email}${user.isInstanceAdmin ? " (instance admin)" : ""}.`
        );
        if (secret.generated) console.info(`Password: ${secret.value}`);
        return;
      }
      case "reset-password": {
        const secret = await password(values["password-stdin"]);
        const user = await auth.adminSetPassword(
          required(values.email, "--email"),
          secret.value
        );
        console.info(
          `Reset the password for ${user.email} and signed it out everywhere.`
        );
        if (secret.generated) console.info(`Password: ${secret.value}`);
        return;
      }
      case "promote":
      case "demote": {
        const user = await auth.adminSetInstanceAdmin(
          required(values.email, "--email"),
          command === "promote"
        );
        console.info(
          `${user.email} is ${user.isInstanceAdmin ? "now" : "no longer"} an instance admin.`
        );
        return;
      }
      case "revoke-sessions": {
        const user = await auth.adminRevokeSessions(
          required(values.email, "--email")
        );
        console.info(`Signed ${user.email} out everywhere.`);
        return;
      }
      case "list-users": {
        const rows = await auth.adminListUsers();
        if (rows.length === 0) {
          console.info("No accounts yet.");
          return;
        }
        for (const row of rows)
          console.info(
            [
              row.email,
              row.name,
              row.isInstanceAdmin ? "admin" : "member",
              row.hasPassword ? "password" : `no password (${row.provider})`,
              row.createdAt.toISOString()
            ].join("\t")
          );
        return;
      }
      default:
        throw new Error(`Unknown command: ${command}\n\n${usage}`);
    }
  } finally {
    await pool.end();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : String(error);
  const duplicate =
    (error as { code?: string; cause?: { code?: string } }).code === "23505" ||
    (error as { cause?: { code?: string } }).cause?.code === "23505";
  console.error(
    duplicate ? "An account with that email already exists." : message
  );
  process.exitCode = 1;
}
