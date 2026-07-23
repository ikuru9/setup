export type ConversionStatus =
  | "converted"
  | "approximated"
  | "preserved"
  | "unsupported";

export interface RuntimeRequirement {
  id: "pi-subagents" | "pi-mcp-adapter" | "pi-web-access";
  source: string;
  packageName: string;
  version: string;
  reason: string;
  required: boolean;
  resourceFilter?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
  };
}

export interface ConversionIssue {
  status: ConversionStatus;
  component: string;
  source?: string;
  target?: string;
  message: string;
  detail?: unknown;
}

export interface ComponentSummary {
  component: string;
  converted: number;
  approximated: number;
  preserved: number;
  unsupported: number;
}

export interface ReportActivationAction {
  kind: "install-package" | "install-runtime" | "copy-file" | "merge-mcp" | "merge-settings";
  target: string;
  source?: string;
}

export interface ActivationFile {
  source: string;
  target: string;
  kind: "agent" | "runtime" | "extension" | "other";
  mode?: number;
}

export interface ActivationManifest {
  schemaVersion: 1;
  pluginId: string;
  pluginSlug: string;
  packageRoot: string;
  agents: ActivationFile[];
  /** Native Pi skill directories/files activated under project .pi/skills. */
  skillFiles?: ActivationFile[];
  runtimeFiles: ActivationFile[];
  mcpConfig?: Record<string, unknown>;
  runtimeRequirements: RuntimeRequirement[];
  webAccessRequired: boolean;
}

export interface ConversionReport {
  schemaVersion: 1;
  converterVersion: string;
  createdAt: string;
  source: string;
  output: string;
  pluginId: string;
  pluginSlug: string;
  target: {
    node: ">=22.19.0";
    pi: "0.81.1";
  };
  runtimeRequirements: RuntimeRequirement[];
  components: ComponentSummary[];
  issues: ConversionIssue[];
  warnings: ConversionIssue[];
  unsupportedFields: ConversionIssue[];
  activationActions: ReportActivationAction[];
  activationManifest: string;
}

export interface ConvertOptions {
  source: string;
  /** A stable, user-facing source identifier (for example, a GitHub URL). */
  sourceDisplay?: string;
  output?: string;
  strict?: boolean;
  /** Add the plugin slug to generated public slash-command names. */
  commandPrefix?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  includeSecrets?: boolean;
}

export interface ActivateOptions {
  convertedDir: string;
  project: string;
  installRuntimes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface DeactivateOptions {
  convertedDirOrPluginId: string;
  project: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface DoctorOptions {
  convertedDir: string;
  project: string;
  json?: boolean;
}

export interface ReceiptFileChange {
  path: string;
  beforeExists: boolean;
  beforeContentBase64?: string;
  beforeMode?: number;
  afterSha256: string;
}

export interface AppliedValueChange {
  beforeExists: boolean;
  beforeValue?: unknown;
  appliedValue: unknown;
}

export interface AppliedPackageChange {
  identity: string;
  beforeExists: boolean;
  beforeEntry?: unknown;
  appliedEntry: unknown;
}

export interface SettingsReceipt extends ReceiptFileChange {
  /** Package entries changed by activation, keyed by a stable npm/local identity. */
  appliedPackages?: AppliedPackageChange[];
}

export interface McpReceipt {
  path: string;
  addedServers: string[];
  previousServers: Record<string, unknown>;
  beforeContentBase64?: string;
  beforeMode?: number;
  afterSha256: string;
  /** MCP server entries actually added or changed by activation. */
  appliedServers?: Record<string, AppliedValueChange>;
  /** Non-server top-level MCP settings actually added or changed by activation. */
  appliedSettings?: Record<string, AppliedValueChange>;
}

export interface ActivationReceipt {
  schemaVersion: 1;
  pluginId: string;
  pluginSlug: string;
  convertedDir: string;
  project: string;
  activatedAt: string;
  files: ReceiptFileChange[];
  mcp?: McpReceipt;
  settings?: SettingsReceipt;
  installedRuntimes: string[];
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  convertedDir: string;
  project: string;
  checks: DoctorCheck[];
}

export interface OperationResult {
  ok: boolean;
  changed: string[];
  warnings: string[];
  message: string;
}
