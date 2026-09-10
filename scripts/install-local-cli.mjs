import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { installLauncher } from "../apps/cli/dist/setup.js";

const source = fileURLToPath(
  new URL("../apps/cli/dist/main.js", import.meta.url)
);
console.log(await installLauncher(homedir(), source));
