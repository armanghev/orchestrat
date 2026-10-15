// Copies the repo LICENSE and NOTICE into the CLI package and writes
// THIRD_PARTY_LICENSES with the license text of every npm package that
// esbuild bundled into dist/main.js. Run after the esbuild step, which must
// write dist/metafile.json. Fails when a bundled package has no license file.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "../..");
const metafilePath = join(cliDir, "dist/metafile.json");
const licenseFilePattern = /^(licen[cs]e|copying)([.-].*)?$/i;

for (const file of ["LICENSE", "NOTICE"]) {
  const source = join(repoRoot, file);
  if (!existsSync(source)) {
    throw new Error(`Missing ${file} at the repository root.`);
  }
  copyFileSync(source, join(cliDir, file));
}

const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
const packages = new Map();

for (const input of Object.keys(metafile.inputs)) {
  const marker = input.lastIndexOf("node_modules/");
  if (marker === -1) continue;
  const rest = input.slice(marker + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = resolve(cliDir, input.slice(0, marker), "node_modules", name);
  if (packages.has(dir)) continue;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  packages.set(dir, manifest);
}

const missing = [];
const entries = [];

for (const [dir, manifest] of packages) {
  const id = `${manifest.name}@${manifest.version}`;
  const files = readdirSync(dir)
    .filter((file) => licenseFilePattern.test(file))
    .filter((file) => statSync(join(dir, file)).isFile())
    .sort();
  if (files.length === 0) {
    missing.push(id);
    continue;
  }
  const texts = files.map((file) =>
    readFileSync(join(dir, file), "utf8").trimEnd()
  );
  entries.push({ id, license: licenseName(manifest), texts });
}

if (missing.length > 0) {
  throw new Error(
    `Bundled packages without a license file: ${missing.join(", ")}`
  );
}

entries.sort((a, b) => a.id.localeCompare(b.id));

const rule = "-".repeat(72);
const output = [
  "Third-party software in @orchestrat/cli",
  "",
  "dist/main.js bundles the npm packages listed below. Each is distributed",
  "under its own license, reproduced in full after the list. Orchestrat",
  "itself is licensed under the Elastic License 2.0 (see LICENSE and NOTICE).",
  "",
  ...entries.map((entry) => `- ${entry.id} (${entry.license})`),
  "",
  ...entries.flatMap((entry) => [
    rule,
    entry.id,
    `License: ${entry.license}`,
    "",
    entry.texts.join("\n\n"),
    ""
  ])
].join("\n");

writeFileSync(join(cliDir, "THIRD_PARTY_LICENSES"), output);
console.log(
  `Wrote THIRD_PARTY_LICENSES for ${entries.length} bundled packages.`
);

function licenseName(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((license) => license.type).join(" OR ");
  }
  return "see license text";
}
