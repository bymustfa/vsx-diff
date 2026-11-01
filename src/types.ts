export const SCHEMA_VERSION = 1 as const;

export type RiskLevel = "low" | "medium" | "high";

export type SourceName = "openvsx" | "marketplace" | "installed" | "file";

export type SourcePreference = "auto" | "openvsx" | "marketplace";

export interface SideInfo {
  version: string;
  source: string;
  path: string | null;
  publishedAt: string | null;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  note: string | null;
}

export interface ScriptChange {
  name: string;
  kind: "added" | "removed" | "changed";
  from: string | null;
  to: string | null;
}

export interface DepChange {
  section: "dependencies" | "devDependencies" | "optionalDependencies";
  name: string;
  kind: "added" | "removed" | "bumped";
  from: string | null;
  to: string | null;
}

export interface FileChange {
  path: string;
  kind: "added" | "removed" | "modified";
  sizeBefore: number | null;
  sizeAfter: number | null;
  delta: number;
  sha256Before: string | null;
  sha256After: string | null;
}

export type SuspiciousCategory = "minified" | "high-entropy" | "native-binary" | "indicator";

export interface SuspiciousFinding {
  path: string;
  category: SuspiciousCategory;
  severity: RiskLevel;
  indicator: string | null;
  points: number;
  detail: string;
}

export interface RiskFactor {
  points: number;
  severity: RiskLevel;
  reason: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
  factors: RiskFactor[];
}

export interface DiffReport {
  schemaVersion: typeof SCHEMA_VERSION;
  extensionId: string;
  from: SideInfo;
  to: SideInfo;
  risk: RiskAssessment;
  manifest: FieldChange[];
  scripts: ScriptChange[];
  dependencies: DepChange[];
  files: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    changes: FileChange[];
  };
  suspicious: SuspiciousFinding[];
  notes: string[];
}

export interface FileBlob {
  path: string;
  size: number;
  sha256: string;
  data: Uint8Array;
}

export interface Snapshot {
  extensionId: string;
  version: string;
  source: string;
  path: string | null;
  publishedAt: string | null;
  manifest: Manifest;
  files: FileBlob[];
}

export interface Manifest {
  name?: string;
  publisher?: string;
  version?: string;
  displayName?: string;
  description?: string;
  main?: string;
  browser?: string;
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: { vscode?: string; [key: string]: unknown };
  capabilities?: {
    untrustedWorkspaces?: { supported?: boolean | "limited"; description?: string };
    virtualWorkspaces?: boolean | { supported?: boolean | "limited"; description?: string };
    [key: string]: unknown;
  };
  contributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VersionRef {
  version: string;
  publishedAt: string | null;
  downloadUrl: string;
  preRelease: boolean;
  source: "openvsx" | "marketplace";
  targetPlatform: string | null;
}

export interface Listing {
  id: string;
  namespace: string;
  name: string;
  source: "openvsx" | "marketplace";
  versions: VersionRef[];
}

export interface InstalledExtension {
  id: string;
  idKey: string;
  version: string;
  location: string;
  editorHint: string;
  mtimeMs: number;
}

export type UpdateStatus = "up-to-date" | "allowed" | "held" | "unknown" | "error";

export interface UpdateRow {
  id: string;
  editor: string;
  location: string;
  installed: string;
  latest: string | null;
  publishedAt: string | null;
  source: string | null;
  status: UpdateStatus;
  reasons: string[];
  pin: string | null;
}

export interface CheckReport {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  minAge: string | null;
  extensionsDirs: string[];
  extensions: UpdateRow[];
}

export interface ConfigData {
  minAge: string | null;
  pins: Record<string, string>;
  extensionsDirs: string[];
  editor: "auto" | "code" | "cursor" | "codium";
  cacheDir: string | null;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => SpawnResult;

export interface Runtime {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  spawn: SpawnFn;
}
