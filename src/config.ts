import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConfigData } from "./types.js";
import { UserError, canonicalDuration, extensionIdKey, isRecord, parseDuration } from "./util.js";

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config");
  return path.join(base, "vsx-diff", "config.json");
}

export function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
    ? env.XDG_CACHE_HOME
    : path.join(home, ".cache");
  return path.join(base, "vsx-diff");
}

export function emptyConfig(): ConfigData {
  return {
    minAge: null,
    pins: {},
    extensionsDirs: [],
    editor: "auto",
    cacheDir: null,
  };
}

export async function loadConfig(filePath: string): Promise<ConfigData> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return emptyConfig();
    throw new UserError(`Could not read config ${filePath}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new UserError(`Config ${filePath} is not valid JSON.`);
  }
  return normalizeConfig(json, filePath);
}

export function normalizeConfig(json: unknown, filePath = "config"): ConfigData {
  if (!isRecord(json)) throw new UserError(`Config ${filePath} must be a JSON object.`);
  const config = emptyConfig();
  if (json.minAge === null || json.minAge === undefined || json.minAge === "0" || json.minAge === 0) {
    config.minAge = null;
  } else if (typeof json.minAge === "string") {
    parseDuration(json.minAge);
    config.minAge = canonicalDuration(json.minAge);
  } else if (typeof json.minAge === "number") {
    config.minAge = `${json.minAge}d`;
    parseDuration(config.minAge);
  } else {
    throw new UserError(`Config ${filePath} has an invalid minAge.`);
  }
  if (json.pins !== undefined) {
    if (!isRecord(json.pins)) throw new UserError(`Config ${filePath} pins must be an object.`);
    for (const [id, version] of Object.entries(json.pins)) {
      if (typeof version !== "string" || !version.trim()) {
        throw new UserError(`Config ${filePath} pin for ${id} must be a version string.`);
      }
      config.pins[extensionIdKey(id)] = version;
    }
  }
  if (json.extensionsDirs !== undefined) {
    if (!Array.isArray(json.extensionsDirs) || json.extensionsDirs.some((dir) => typeof dir !== "string")) {
      throw new UserError(`Config ${filePath} extensionsDirs must be an array of paths.`);
    }
    config.extensionsDirs = json.extensionsDirs;
  }
  if (json.editor !== undefined) {
    if (json.editor !== "auto" && json.editor !== "code" && json.editor !== "cursor" && json.editor !== "codium") {
      throw new UserError(`Config ${filePath} editor must be auto, code, cursor, or codium.`);
    }
    config.editor = json.editor;
  }
  if (json.cacheDir !== undefined && json.cacheDir !== null) {
    if (typeof json.cacheDir !== "string") throw new UserError(`Config ${filePath} cacheDir must be a path.`);
    config.cacheDir = json.cacheDir;
  }
  return config;
}

export async function saveConfig(filePath: string, config: ConfigData): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, filePath);
}

export function pinOf(config: ConfigData, id: string): string | null {
  return config.pins[extensionIdKey(id)] ?? null;
}
