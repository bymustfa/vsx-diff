import path from "node:path";
import type {
  CheckReport,
  ConfigData,
  DiffReport,
  Listing,
  Runtime,
  Snapshot,
  SourcePreference,
  UpdateRow,
  VersionRef,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { compareSnapshots } from "./analyze.js";
import { defaultCacheDir, defaultConfigPath, loadConfig, pinOf, saveConfig } from "./config.js";
import { findEditor, installCommand, missingEditorMessage, runInstall, type EditorName } from "./editors.js";
import { chooseInstalled, defaultExtensionDirs, discoverInstalled, uniqueInstalled } from "./installed.js";
import { decideUpdate } from "./policy.js";
import { RegistryClient, selectLatest, selectPrevious, selectVersion } from "./registry.js";
import { snapshotFromDirectory, snapshotFromVsixBytes } from "./unpack.js";
import { UserError, canonicalDuration, errorMessage, extensionIdKey, mapPool, parseDuration, splitExtensionId, splitPinSpec } from "./util.js";
import { versionCompare } from "./version.js";

export interface DiffRequest {
  runtime: Runtime;
  extensionId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  left?: string | undefined;
  right?: string | undefined;
  source: SourcePreference;
  cacheDir: string;
  extensionDirs: string[];
  refresh: boolean;
  preRelease: boolean;
  timeoutMs: number;
}

export async function diffRequest(request: DiffRequest): Promise<DiffReport> {
  if (request.left || request.right) {
    if (!request.left || !request.right) throw new UserError("Pass both --left and --right VSIX files.");
    const from = snapshotFromVsixBytes(new Uint8Array(await readFileBytes(request.left)), "file", request.left, null);
    const to = snapshotFromVsixBytes(new Uint8Array(await readFileBytes(request.right)), "file", request.right, null);
    return compareSnapshots(from, to);
  }
  if (!request.extensionId) {
    throw new UserError("Pass an extension id (publisher.name), or two VSIX files with compare / --left / --right.");
  }
  splitExtensionId(request.extensionId);
  const registry = new RegistryClient(request.runtime, request.timeoutMs);
  const listing = await registry.getListing(request.extensionId, request.source);
  const installed = chooseInstalled(await discoverInstalled(request.extensionDirs, request.runtime.env), listing.id);
  const latest = selectLatest(listing.versions, request.preRelease);
  if (!latest) throw new UserError(`${listing.id} has no published versions.`);

  const toRef = request.to ? requireVersion(listing, request.to) : latest;
  let fromSnapshot: Snapshot;
  let fromRef: VersionRef | null = null;
  if (request.from) {
    if (installed && versionCompare(installed.version, request.from) === 0) {
      fromSnapshot = await snapshotFromDirectory(installed.location, `installed:${installed.editorHint}`);
    } else {
      fromRef = requireVersion(listing, request.from);
      fromSnapshot = await downloadSnapshot(registry, listing, fromRef, request);
    }
  } else if (installed) {
    fromSnapshot = await snapshotFromDirectory(installed.location, `installed:${installed.editorHint}`);
  } else {
    const previous = selectPrevious(listing.versions, toRef, request.preRelease);
    if (!previous) {
      throw new UserError(`${listing.id} has no earlier version to compare with ${toRef.version}. Pass --from or install the extension locally.`);
    }
    fromRef = previous;
    fromSnapshot = await downloadSnapshot(registry, listing, previous, request);
  }

  const toSnapshot = fromRef && fromRef.version === toRef.version
    ? fromSnapshot
    : await downloadSnapshot(registry, listing, toRef, request);

  const notes: string[] = [];
  if (listing.source === "marketplace") notes.push("Versions came from the VS Code Marketplace.");
  if (fromSnapshot.source.startsWith("installed")) notes.push("The base side is the unpacked extension on disk, not a re-downloaded VSIX.");
  if (fromSnapshot.version === toSnapshot.version) notes.push("The two sides are the same version.");
  if (!request.preRelease && listing.versions.some((version) => version.preRelease)) {
    notes.push("Pre-release versions are hidden. Pass --pre-release to include them.");
  }
  return compareSnapshots(fromSnapshot, toSnapshot, notes);
}

async function downloadSnapshot(
  registry: RegistryClient,
  listing: Listing,
  version: VersionRef,
  request: DiffRequest,
): Promise<Snapshot> {
  const resolved = await registry.enrich(listing, version);
  const downloaded = await registry.download(resolved, request.cacheDir, request.refresh, listing);
  const snapshot = snapshotFromVsixBytes(downloaded.bytes, resolved.source, downloaded.filePath, resolved.publishedAt);
  snapshot.version = resolved.version || snapshot.version;
  snapshot.publishedAt = resolved.publishedAt;
  return snapshot;
}

function requireVersion(listing: Listing, version: string): VersionRef {
  const found = selectVersion(listing.versions, version);
  if (found) return found;
  const sample = listing.versions.slice(0, 8).map((item) => item.version).join(", ");
  throw new UserError(`Version ${version} of ${listing.id} was not found. Recent versions: ${sample || "(none)"}.`);
}

export async function checkInstalled(options: {
  runtime: Runtime;
  extensionDirs: string[];
  source: SourcePreference;
  config: ConfigData;
  timeoutMs: number;
  preRelease: boolean;
}): Promise<CheckReport> {
  const installed = uniqueInstalled(await discoverInstalled(options.extensionDirs, options.runtime.env));
  const registry = new RegistryClient(options.runtime, options.timeoutMs);
  const now = Date.now();
  const rows = await mapPool(installed, 4, async (item): Promise<UpdateRow> => {
    const pin = pinOf(options.config, item.id);
    try {
      const listing = await registry.getListing(item.id, options.source);
      const latest = selectLatest(listing.versions, options.preRelease || item.version.includes("-"));
      const decision = decideUpdate({
        installed: item.version,
        latest: latest?.version ?? null,
        publishedAt: latest?.publishedAt ?? null,
        now,
        minAge: options.config.minAge,
        pin,
      });
      return {
        id: item.id,
        editor: item.editorHint,
        location: item.location,
        installed: item.version,
        latest: latest?.version ?? null,
        publishedAt: latest?.publishedAt ?? null,
        source: listing.source,
        status: decision.status,
        reasons: decision.reasons,
        pin,
      };
    } catch (error) {
      return {
        id: item.id,
        editor: item.editorHint,
        location: item.location,
        installed: item.version,
        latest: null,
        publishedAt: null,
        source: null,
        status: "error",
        reasons: [errorMessage(error)],
        pin,
      };
    }
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    minAge: options.config.minAge,
    extensionsDirs: options.extensionDirs,
    extensions: rows,
  };
}

export interface PolicyResult {
  exitCode: number;
  message: string;
}

export async function pinExtension(options: {
  runtime: Runtime;
  spec: string;
  configPath: string;
  config: ConfigData;
  cacheDir: string;
  dryRun: boolean;
  editor: "auto" | EditorName;
  source: SourcePreference;
  timeoutMs: number;
}): Promise<PolicyResult> {
  const { id, version } = splitPinSpec(options.spec);
  const key = extensionIdKey(id);
  const lines: string[] = [];
  if (options.dryRun) {
    lines.push(`Dry-run: would pin ${id} to ${version} in ${options.configPath}.`);
  } else {
    options.config.pins[key] = version;
    await saveConfig(options.configPath, options.config);
    lines.push(`Pinned ${id} to ${version}.`);
    lines.push(`Saved ${options.configPath}.`);
  }
  const editor = await findEditor(options.editor, options.runtime.env);
  const vsixGuess = path.join(options.cacheDir, key, `${version}.vsix`);
  if (!editor) {
    lines.push(missingEditorMessage());
    lines.push("Dry-run: editor install was not performed.");
    lines.push("Would download the VSIX into the cache and run:");
    lines.push(`  code --install-extension ${vsixGuess} --force`);
    lines.push("Turn off editor auto-update or this pin is only enforced by `vsx-diff check`:");
    lines.push(`  "extensions.autoUpdate": false`);
    return { exitCode: 0, message: `${lines.join("\n")}\n` };
  }
  if (options.dryRun) {
    const command = installCommand(editor, vsixGuess);
    lines.push(`Found ${editor.name} at ${editor.path}.`);
    lines.push(`Dry-run: would download ${id}@${version} and run:`);
    lines.push(`  ${command.display}`);
    return { exitCode: 0, message: `${lines.join("\n")}\n` };
  }
  try {
    const registry = new RegistryClient(options.runtime, options.timeoutMs);
    const listing = await registry.getListing(id, options.source);
    const ref = selectVersion(listing.versions, version);
    if (!ref) throw new UserError(`Version ${version} of ${listing.id} was not found.`);
    const downloaded = await registry.download(ref, options.cacheDir, false, listing);
    const command = installCommand(editor, downloaded.filePath);
    lines.push(`Found ${editor.name} at ${editor.path}.`);
    lines.push(`Running ${command.display}`);
    const result = runInstall(options.runtime, editor, downloaded.filePath);
    lines.push(result.detail);
    if (!result.ok) {
      lines.push("The pin is saved. The editor install failed, so the installed copy may still be the old one.");
      return { exitCode: 2, message: `${lines.join("\n")}\n` };
    }
    lines.push(`Installed ${listing.id}@${version}.`);
    return { exitCode: 0, message: `${lines.join("\n")}\n` };
  } catch (error) {
    lines.push(`Download or install failed: ${errorMessage(error)}`);
    lines.push("The pin is saved. Re-run pin when the registry is reachable, or install the VSIX yourself.");
    return { exitCode: 0, message: `${lines.join("\n")}\n` };
  }
}

export async function unpinExtension(configPath: string, config: ConfigData, id: string): Promise<PolicyResult> {
  splitExtensionId(id);
  const key = extensionIdKey(id);
  if (!config.pins[key]) {
    return { exitCode: 0, message: `${id} is not pinned.\n` };
  }
  delete config.pins[key];
  await saveConfig(configPath, config);
  return { exitCode: 0, message: `Unpinned ${id}.\nSaved ${configPath}.\n` };
}

export async function rollbackExtension(options: {
  runtime: Runtime;
  id: string;
  to?: string | undefined;
  configPath: string;
  config: ConfigData;
  cacheDir: string;
  dryRun: boolean;
  editor: "auto" | EditorName;
  source: SourcePreference;
  timeoutMs: number;
  extensionDirs: string[];
  preRelease: boolean;
}): Promise<PolicyResult> {
  splitExtensionId(options.id);
  const registry = new RegistryClient(options.runtime, options.timeoutMs);
  const listing = await registry.getListing(options.id, options.source);
  const installed = chooseInstalled(await discoverInstalled(options.extensionDirs, options.runtime.env), listing.id);
  const latest = selectLatest(listing.versions, options.preRelease);
  let target: VersionRef | null = null;
  if (options.to) {
    target = selectVersion(listing.versions, options.to);
    if (!target) throw new UserError(`Version ${options.to} of ${listing.id} was not found.`);
  } else if (installed) {
    const older = listing.versions.filter((version) => versionCompare(version.version, installed.version) < 0 && (options.preRelease || !version.preRelease));
    target = older[0] ?? null;
  } else if (latest) {
    target = selectPrevious(listing.versions, latest, options.preRelease);
  }
  if (!target) throw new UserError(`No older version of ${listing.id} is available to roll back to. Pass --to <version>.`);

  const lines: string[] = [];
  lines.push(`Rollback ${listing.id} → ${target.version}${installed ? ` (installed ${installed.version})` : ""}.`);
  const editor = await findEditor(options.editor, options.runtime.env);
  if (options.dryRun || !editor) {
    if (!options.dryRun) {
      options.config.pins[extensionIdKey(listing.id)] = target.version;
      await saveConfig(options.configPath, options.config);
      lines.push(`Pinned ${listing.id} to ${target.version} so \`vsx-diff check\` keeps holding newer releases.`);
      lines.push(`Saved ${options.configPath}.`);
    } else {
      lines.push(`Dry-run: would pin ${listing.id} to ${target.version} in ${options.configPath}.`);
    }
    if (!editor) lines.push(missingEditorMessage());
    lines.push("Dry-run: editor install was not performed.");
    const guess = path.join(options.cacheDir, sanitize(listing.id), `${sanitize(target.version)}-${target.source}.vsix`);
    lines.push("Would download the VSIX and run:");
    lines.push(`  ${(editor?.name ?? "code")} --install-extension ${guess} --force`);
    return { exitCode: 0, message: `${lines.join("\n")}\n` };
  }

  const downloaded = await registry.download(target, options.cacheDir, false, listing);
  options.config.pins[extensionIdKey(listing.id)] = target.version;
  await saveConfig(options.configPath, options.config);
  lines.push(`Pinned ${listing.id} to ${target.version}.`);
  const result = runInstall(options.runtime, editor, downloaded.filePath);
  lines.push(`Running ${installCommand(editor, downloaded.filePath).display}`);
  lines.push(result.detail);
  if (!result.ok) return { exitCode: 2, message: `${lines.join("\n")}\n` };
  lines.push(`Installed ${listing.id}@${target.version}.`);
  return { exitCode: 0, message: `${lines.join("\n")}\n` };
}

export async function setCooldown(options: {
  runtime: Runtime;
  value: string;
  configPath: string;
  config: ConfigData;
  dryRun: boolean;
  editor: "auto" | EditorName;
}): Promise<PolicyResult> {
  const lines: string[] = [];
  const clearing = options.value === "0" || options.value === "0d";
  const stored = clearing ? null : canonicalDuration(options.value);
  if (!clearing) parseDuration(options.value);
  if (options.dryRun) {
    lines.push(clearing
      ? `Dry-run: would clear the cooldown in ${options.configPath}.`
      : `Dry-run: would set minAge to ${stored} in ${options.configPath}.`);
  } else {
    options.config.minAge = stored;
    await saveConfig(options.configPath, options.config);
    lines.push(clearing ? `Cleared the cooldown.` : `Cooldown set: a version must be at least ${stored} old.`);
    lines.push(`Saved ${options.configPath}.`);
  }
  const editor = await findEditor(options.editor, options.runtime.env);
  if (!editor) {
    lines.push(missingEditorMessage());
    lines.push("Dry-run: could not ask the editor to disable auto-update.");
  } else {
    lines.push(`Found ${editor.name} at ${editor.path}.`);
    const version = options.runtime.spawn(editor.path, ["--version"], options.runtime.env);
    if (version.status === 0) {
      const first = version.stdout.split(/\r?\n/).find((line) => line.trim()) ?? editor.name;
      lines.push(`Editor responded to --version: ${first.trim()}.`);
    } else {
      lines.push(`Editor CLI did not respond to --version (${version.stderr.trim() || "no output"}).`);
    }
  }
  lines.push("The editor will still auto-update unless you turn that off. Add this to user settings:");
  lines.push(`  "extensions.autoUpdate": false`);
  lines.push("Then run `vsx-diff check` before installing anything newer.");
  return { exitCode: 0, message: `${lines.join("\n")}\n` };
}

export async function resolvePaths(env: NodeJS.ProcessEnv, configPathFlag: string | undefined, cacheFlag: string | undefined): Promise<{
  configPath: string;
  config: ConfigData;
  cacheDir: string;
}> {
  const configPath = configPathFlag || env.VSX_DIFF_CONFIG || defaultConfigPath(env);
  const config = await loadConfig(configPath);
  const cacheDir = cacheFlag || env.VSX_DIFF_CACHE || config.cacheDir || defaultCacheDir(env);
  return { configPath, config, cacheDir };
}

export function extensionDirsFor(options: {
  env: NodeJS.ProcessEnv;
  flagged: string[];
  config: ConfigData;
  noDefaults: boolean;
}): string[] {
  const extra = [...options.flagged, ...options.config.extensionsDirs];
  if (options.noDefaults) return dedupe(extra);
  return dedupe([...defaultExtensionDirs(options.env), ...extra]);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._+-]+/g, "_");
}

async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  try {
    return new Uint8Array(await readFile(filePath));
  } catch {
    throw new UserError(`Could not read ${filePath}.`);
  }
}
