import {
  cancel as clackCancel,
  intro as clackIntro,
  isCancel,
  log as clackLog,
  multiselect as clackMultiselect,
  note as clackNote,
  outro as clackOutro,
  spinner as clackSpinner
} from "@clack/prompts";

export type UiWriter = (text: string) => void;
export type Harness = { id: string; label?: string; hint?: string };
export type DetectedHarness = Harness & {
  configurable: boolean;
  unsupportedReason?: string;
};
export type Cancelled = { cancelled: true };
export type Selection<T extends Harness> = { cancelled: false; values: T[] };

export type UiComponents = {
  multiselect: (options: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
    initialValues?: string[];
    required?: boolean;
  }) => Promise<string[] | symbol>;
  cancel: (message?: string) => void;
  outro: (message?: string) => void;
  intro: (message?: string) => void;
  log: { info(message: string): void; success(message: string): void; warn(message: string): void };
  note: (message?: string, title?: string) => void;
  spinner: () => { start(message?: string): void; stop(message?: string): void };
};

const defaultComponents: UiComponents = {
  multiselect: clackMultiselect,
  cancel: clackCancel,
  outro: clackOutro,
  intro: clackIntro,
  log: clackLog,
  note: clackNote,
  spinner: clackSpinner
};

export function isInteractive(input: {
  stdin?: { isTTY?: boolean };
  stdout?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  return Boolean(
    input.stdin?.isTTY && input.stdout?.isTTY && !input.env?.CI
  );
}

export async function selectHarnesses<T extends Harness>(
  harnesses: readonly T[],
  options: {
    interactive: boolean;
    components?: UiComponents;
    isCancel?: (answer: unknown) => boolean;
  }
): Promise<Selection<T> | Cancelled> {
  const configurable = harnesses.filter(
    (harness) => (harness as unknown as DetectedHarness).configurable !== false
  );
  if (!options.interactive) return { cancelled: false, values: [...configurable] };
  const components = options.components ?? defaultComponents;
  const answer = await components.multiselect({
    message: "Select agent harnesses to connect",
    options: configurable.map((harness) => ({
      value: harness.id,
      label: harness.label ?? harness.id,
      hint: harness.hint
    })),
    initialValues: configurable.map((harness) => harness.id),
    required: true
  });
  if ((options.isCancel ?? isCancel)(answer)) {
    components.cancel("Setup canceled.");
    return { cancelled: true };
  }
  const selected = new Set(answer as string[]);
  return {
    cancelled: false,
    values: configurable.filter((harness) => selected.has(harness.id))
  };
}

export function renderDetectedAgents(
  harnesses: readonly DetectedHarness[],
  options: { interactive: boolean; write: UiWriter; components?: UiComponents }
): void {
  if (!options.interactive) {
    options.write(`${JSON.stringify({ detected: harnesses })}\n`);
    return;
  }
  const components = options.components ?? defaultComponents;
  components.intro("Welcome to Orchestrat");
  components.log.info("Detected agents");
  for (const harness of harnesses) {
    const suffix = harness.configurable
      ? "configurable"
      : `unsupported${harness.unsupportedReason ? `: ${harness.unsupportedReason}` : ""}`;
    components.note(`${harness.label ?? harness.id} — ${suffix}`, harness.id);
  }
}

export type SetupResult = {
  integrations?: Record<string, { agentId?: string }>;
  pathFix?: string;
  harnesses?: readonly {
    id: string;
    label?: string;
    mcpConfigured?: boolean;
    hooksConfigured?: boolean;
    hooksSupported?: boolean;
  }[];
};

export async function runSetupProgress<T>(
  operation: () => Promise<T>,
  options: { interactive: boolean; components?: UiComponents } = { interactive: false }
): Promise<T> {
  if (!options.interactive) return operation();
  const spinner = (options.components ?? defaultComponents).spinner();
  spinner.start("Configuring Orchestrat");
  try {
    const result = await operation();
    spinner.stop("Orchestrat is configured");
    return result;
  } catch (error) {
    spinner.stop("Setup failed");
    throw error;
  }
}

export function renderSetupResult(result: SetupResult, write: UiWriter): void {
  for (const integration of Object.keys(result.integrations ?? {}))
    write(`✓ connected ${integration}\n`);
  if (result.pathFix) write(`  PATH: ${result.pathFix}\n`);
  for (const harness of result.harnesses ?? []) {
    write(`  ${harness.label ?? harness.id}: MCP ${harness.mcpConfigured ? "configured" : "not configured"}\n`);
    write(
      `    Hooks: ${harness.hooksSupported === false ? "unavailable/unsupported" : harness.hooksConfigured ? "configured" : "not configured"}\n`
    );
  }
  const connected = Object.keys(result.integrations ?? {}).length;
  if (connected) write(`${connected} agents connected\n`);
}

export function renderPreview(
  previews: readonly { path: string; entries?: readonly string[] }[],
  write: UiWriter
): void {
  for (const preview of previews)
    write(`  ${preview.path} (${(preview.entries ?? []).join(", ")})\n`);
}

export function renderStatus(result: unknown, write: UiWriter): void {
  const value = result as {
    configured?: boolean;
    cwd?: string;
    project_id?: string | null;
    backend?: Record<string, { ok?: boolean; detail?: string; status?: string }>;
  };
  write(`Status: ${value.configured ? "configured" : "not configured"}\n`);
  if (value.cwd) write(`Project: ${value.project_id ?? "none"}\n  ${value.cwd}\n`);
  for (const [name, state] of Object.entries(value.backend ?? {}))
    write(`  ${state.ok === false ? "✗" : "✓"} ${name}: ${state.detail ?? state.status ?? "reachable"}\n`);
}

export function renderDoctor(result: unknown, write: UiWriter): void {
  const checks = (result as { checks?: Record<string, { ok: boolean; detail: string }> }).checks ?? {};
  write("Doctor\n");
  for (const [name, check] of Object.entries(checks))
    write(`  ${check.ok ? "✓" : "✗"} ${name}: ${check.detail}\n`);
}

export function renderDisconnect(result: unknown, write: UiWriter): void {
  const value = result as {
    previews?: readonly { path: string; entries?: readonly string[] }[];
    disconnected?: readonly string[];
  };
  if (value.previews?.length) renderPreview(value.previews, write);
  write(
    value.disconnected?.length
      ? `Disconnected: ${value.disconnected.join(", ")}\n`
      : "Nothing to disconnect.\n"
  );
}

export function renderResult(
  command: "status" | "doctor" | "disconnect",
  result: unknown,
  options: { interactive: boolean; write: UiWriter }
): void {
  if (!options.interactive) {
    options.write(`${JSON.stringify(result)}\n`);
    return;
  }
  ({ status: renderStatus, doctor: renderDoctor, disconnect: renderDisconnect }[command] as (value: unknown, write: UiWriter) => void)(result, options.write);
}

export function finishSetup(
  message: string,
  options: { interactive: boolean; components?: UiComponents } = { interactive: false }
): void {
  if (options.interactive) (options.components ?? defaultComponents).outro(message);
}
