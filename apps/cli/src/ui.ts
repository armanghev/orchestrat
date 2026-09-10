import {
  cancel as clackCancel,
  intro as clackIntro,
  isCancel,
  log as clackLog,
  multiselect as clackMultiselect,
  select as clackSelect,
  note as clackNote,
  outro as clackOutro,
  spinner as clackSpinner
} from "@clack/prompts";

export type UiWriter = (text: string) => void;
export type Harness = { id: string; label?: string; hint?: string };
export type DetectedHarness = Harness & {
  configurable: boolean;
  mcpConfigured?: boolean;
  hooksConfigured?: boolean;
  hooksSupported?: boolean;
  unsupportedReason?: string;
};
export type Cancelled = { cancelled: true };
export type Selection<T extends Harness> = { cancelled: false; values: T[] };
export type ProjectChoice = {
  id: string;
  name: string;
  organization_name: string;
};

export type UiComponents = {
  multiselect: (options: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
    initialValues?: string[];
    required?: boolean;
  }) => Promise<string[] | symbol>;
  select?: (options: {
    message: string;
    options: { value: string; label: string }[];
  }) => Promise<string | symbol>;
  cancel: (message?: string) => void;
  outro: (message?: string) => void;
  intro: (message?: string) => void;
  log: {
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
  };
  note: (message?: string, title?: string) => void;
  spinner: () => {
    start(message?: string): void;
    stop(message?: string): void;
  };
};

const defaultComponents: UiComponents = {
  multiselect: clackMultiselect,
  select: clackSelect,
  cancel: clackCancel,
  outro: clackOutro,
  intro: clackIntro,
  log: clackLog,
  note: clackNote,
  spinner: clackSpinner
};

export function isInteractive(
  input: {
    stdin?: { isTTY?: boolean };
    stdout?: { isTTY?: boolean };
    env?: NodeJS.ProcessEnv;
  } = {}
): boolean {
  return Boolean(input.stdin?.isTTY && input.stdout?.isTTY && !input.env?.CI);
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
  if (!options.interactive)
    return { cancelled: false, values: [...configurable] };
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

export async function selectProject(
  projects: readonly ProjectChoice[],
  options: {
    interactive: boolean;
    components?: UiComponents;
    isCancel?: (answer: unknown) => boolean;
  }
): Promise<{ cancelled: false; value: ProjectChoice } | Cancelled> {
  if (!projects.length)
    throw new Error("No projects are available to this account");
  if (!options.interactive) {
    if (projects.length !== 1)
      throw new Error(
        "Select a project by running setup in an interactive terminal"
      );
    return { cancelled: false, value: projects[0]! };
  }
  const components = options.components ?? defaultComponents;
  const answer = await (components.select ?? clackSelect)({
    message: "Select a project to configure",
    options: projects.map((project) => ({
      value: project.id,
      label: `${project.organization_name} / ${project.name}`
    }))
  });
  if ((options.isCancel ?? isCancel)(answer)) {
    components.cancel("Setup canceled.");
    return { cancelled: true };
  }
  const project = projects.find((item) => item.id === answer);
  if (!project) throw new Error("Selected project is unavailable");
  return { cancelled: false, value: project };
}

export async function selectMcpScope(options: {
  interactive: boolean;
  components?: UiComponents;
  isCancel?: (answer: unknown) => boolean;
}): Promise<{ cancelled: false; value: "project" | "global" } | Cancelled> {
  if (!options.interactive) return { cancelled: false, value: "project" };
  const components = options.components ?? defaultComponents;
  const answer = await (components.select ?? clackSelect)({
    message: "Configure MCPs for this project or globally?",
    options: [
      { value: "project", label: "Project (recommended)" },
      { value: "global", label: "Global (choose projects)" }
    ]
  });
  if ((options.isCancel ?? isCancel)(answer)) {
    components.cancel("Setup canceled.");
    return { cancelled: true };
  }
  if (answer !== "project" && answer !== "global")
    throw new Error("Selected Cursor MCP scope is unavailable");
  return { cancelled: false, value: answer };
}

export async function selectGlobalProjects(
  projects: readonly ProjectChoice[],
  options: {
    interactive: boolean;
    components?: UiComponents;
    isCancel?: (answer: unknown) => boolean;
  }
): Promise<Selection<ProjectChoice> | Cancelled> {
  if (!projects.length)
    throw new Error("No projects are available to this account");
  if (!options.interactive) return { cancelled: false, values: [...projects] };
  const components = options.components ?? defaultComponents;
  const answer = await components.multiselect({
    message: "Allow global MCPs to access projects",
    options: projects.map((project) => ({
      value: project.id,
      label: `${project.organization_name} / ${project.name}`
    })),
    initialValues: projects.map((project) => project.id),
    required: true
  });
  if ((options.isCancel ?? isCancel)(answer)) {
    components.cancel("Setup canceled.");
    return { cancelled: true };
  }
  const selected = new Set(answer as string[]);
  return {
    cancelled: false,
    values: projects.filter((project) => selected.has(project.id))
  };
}

export function startSetup(options: {
  interactive: boolean;
  components?: UiComponents;
}): void {
  if (options.interactive)
    (options.components ?? defaultComponents).intro("Welcome to Orchestrat");
}

export function renderSetupAuthorization(
  project: ProjectChoice,
  options: { interactive: boolean; components?: UiComponents }
): void {
  if (!options.interactive) return;
  const components = options.components ?? defaultComponents;
  components.log.success("Authenticated");
  components.log.success(
    `Selected project: ${project.organization_name} / ${project.name}`
  );
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
  options: { interactive: boolean; components?: UiComponents } = {
    interactive: false
  }
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
  const harnesses = result.harnesses ?? [];
  if (!harnesses.length)
    for (const integration of Object.keys(result.integrations ?? {}))
      write(`✓ connected ${integration}\n`);
  for (const harness of harnesses) {
    write(`\n${harness.label ?? harness.id}\n`);
    write(
      `${harness.mcpConfigured ? "✓" : "✗"} MCP ${harness.mcpConfigured ? "configured" : "not configured"}\n`
    );
    write(
      `${harness.hooksSupported === false ? "○" : harness.hooksConfigured ? "✓" : "✗"} Hooks: ${harness.hooksSupported === false ? "unavailable/unsupported" : harness.hooksConfigured ? "configured" : "not configured"}\n`
    );
  }
  if (result.pathFix) write(`  PATH: ${result.pathFix}\n`);
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
    scope?: "project" | "global";
    cwd?: string;
    project_id?: string | null;
    backend?: Record<
      string,
      { ok?: boolean; detail?: string; status?: string }
    >;
  };
  write(`Status: ${value.configured ? "configured" : "not configured"}\n`);
  if (value.configured && value.scope === "global")
    write("Projects: global connections; select a project in MCP\n");
  else if (value.cwd)
    write(`Project: ${value.project_id ?? "none"}\n  ${value.cwd}\n`);
  for (const [name, state] of Object.entries(value.backend ?? {}))
    write(
      `  ${state.ok === false ? "✗" : "✓"} ${name}: ${state.detail ?? state.status ?? "reachable"}\n`
    );
}

export function renderDoctor(result: unknown, write: UiWriter): void {
  const checks =
    (result as { checks?: Record<string, { ok: boolean; detail: string }> })
      .checks ?? {};
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
  (
    ({
      status: renderStatus,
      doctor: renderDoctor,
      disconnect: renderDisconnect
    })[command] as (value: unknown, write: UiWriter) => void
  )(result, options.write);
}

export function finishSetup(
  message: string,
  options: { interactive: boolean; components?: UiComponents } = {
    interactive: false
  }
): void {
  if (options.interactive)
    (options.components ?? defaultComponents).outro(message);
}
