import {
  cancel as clackCancel,
  isCancel,
  multiselect as clackMultiselect,
  outro as clackOutro,
  spinner as clackSpinner
} from "@clack/prompts";

export type UiWriter = (text: string) => void;
export type Harness = { id: string; label?: string; hint?: string };
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
  spinner: () => { start(message?: string): void; stop(message?: string): void };
};

const defaultComponents: UiComponents = {
  multiselect: clackMultiselect,
  cancel: clackCancel,
  outro: clackOutro,
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
  if (!options.interactive) return { cancelled: false, values: [...harnesses] };
  const components = options.components ?? defaultComponents;
  const answer = await components.multiselect({
    message: "Select agent harnesses to connect",
    options: harnesses.map((harness) => ({
      value: harness.id,
      label: harness.label ?? harness.id,
      hint: harness.hint
    })),
    initialValues: harnesses.map((harness) => harness.id),
    required: true
  });
  if ((options.isCancel ?? isCancel)(answer)) {
    components.cancel("Setup canceled.");
    return { cancelled: true };
  }
  const selected = new Set(answer as string[]);
  return {
    cancelled: false,
    values: harnesses.filter((harness) => selected.has(harness.id))
  };
}

export type SetupResult = {
  integrations?: Record<string, { agentId?: string }>;
  pathFix?: string;
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
