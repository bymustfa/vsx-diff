import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InstalledExtension, Manifest } from "./types.js";
import { extensionIdKey, isRecord } from "./util.js";
import { isPreRelease, versionCompare } from "./version.js";

const DEFAULT_RELATIVE = [
  { editor: "vscode", dir: path.join(".vscode", "extensions") },
  { editor: "cursor", dir: path.join(".cursor", "extensions") },
  { editor: "vscode-oss", dir: path.join(".vscode-oss", "extensions") },
];

export function defaultExtensionDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return DEFAULT_RELATIVE.map((entry) => path.join(home, entry.dir));
}

export function editorHintForDir(dir: string, home: string): string {
  const rel = path.relative(home, dir);
  if (rel.startsWith(path.join(".cursor", "extensions")) || dir.includes(`${path.sep}.cursor${path.sep}`)) return "cursor";
  if (rel.startsWith(path.join(".vscode-oss", "extensions")) || dir.includes(`${path.sep}.vscode-oss${path.sep}`)) return "vscode-oss";
  if (rel.startsWith(path.join(".vscode", "extensions")) || dir.includes(`${path.sep}.vscode${path.sep}`)) return "vscode";
  return "custom";
}

export async function discoverInstalled(dirs: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<InstalledExtension[]> {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const found: InstalledExtension[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const location = path.join(dir, entry.name);
      const parsed = await readInstalled(location, entry.name);
      if (!parsed) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(location)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      found.push({
        ...parsed,
        location,
        editorHint: editorHintForDir(dir, home),
        mtimeMs,
      });
    }
  }
  return found;
}

async function readInstalled(location: string, folderName: string): Promise<Pick<InstalledExtension, "id" | "idKey" | "version"> | null> {
  try {
    const raw = await readFile(path.join(location, "package.json"), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (isRecord(json) && typeof json.publisher === "string" && typeof json.name === "string" && typeof json.version === "string") {
      const manifest = json as Manifest;
      const id = `${manifest.publisher}.${manifest.name}`;
      return { id, idKey: extensionIdKey(id), version: manifest.version ?? json.version };
    }
  } catch {
    // Fall through to the folder name.
  }
  const parsed = parseFolderName(folderName);
  if (!parsed) return null;
  return { id: parsed.id, idKey: extensionIdKey(parsed.id), version: parsed.version };
}

export function parseFolderName(folderName: string): { id: string; version: string } | null {
  let base = folderName;
  const platform = /-(?:alpine|darwin|linux|win32|web|universal)-[A-Za-z0-9_]+$/;
  if (platform.test(base)) base = base.replace(platform, "");
  const match = /^(.*)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(base);
  if (!match || !match[1] || !match[2] || !match[1].includes(".")) return null;
  return { id: match[1], version: match[2] };
}

export function chooseInstalled(all: readonly InstalledExtension[], id: string): InstalledExtension | null {
  const key = extensionIdKey(id);
  const matches = all.filter((item) => item.idKey === key);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => versionCompare(b.version, a.version) || b.mtimeMs - a.mtimeMs)[0] ?? null;
}

export function uniqueInstalled(all: readonly InstalledExtension[]): InstalledExtension[] {
  const grouped = new Map<string, InstalledExtension[]>();
  for (const item of all) {
    const list = grouped.get(item.idKey) ?? [];
    list.push(item);
    grouped.set(item.idKey, list);
  }
  const chosen: InstalledExtension[] = [];
  for (const list of grouped.values()) {
    const best = [...list].sort((a, b) => versionCompare(b.version, a.version) || b.mtimeMs - a.mtimeMs)[0];
    if (best) chosen.push(best);
  }
  chosen.sort((a, b) => a.idKey.localeCompare(b.idKey));
  return chosen;
}

export function installedIsPreRelease(item: InstalledExtension): boolean {
  return isPreRelease(item.version);
}
