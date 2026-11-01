import { createHash } from "node:crypto";
import type { RiskLevel } from "./types.js";

export class UserError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "UserError";
    this.exitCode = exitCode;
  }
}

export const USER_AGENT = "vsx-diff/0.1.0";

export const OPEN_VSX = "https://open-vsx.org";

export const MARKETPLACE = "https://marketplace.visualstudio.com";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

export function shannonEntropy(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    freq[byte] = (freq[byte] ?? 0) + 1;
  }
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const count = freq[i] ?? 0;
    if (count === 0) continue;
    const p = count / data.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface TextStats {
  entropy: number;
  avgLineLength: number;
  whitespaceRatio: number;
  sampleBytes: number;
}

export function textStats(data: Uint8Array): TextStats {
  const sample = data.subarray(0, 65_536);
  const text = decodeUtf8(sample);
  const lines = text.length === 0 ? 1 : text.split(/\r?\n/).length;
  let whitespace = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) whitespace += 1;
  }
  return {
    entropy: shannonEntropy(sample),
    avgLineLength: text.length / lines,
    whitespaceRatio: text.length === 0 ? 0 : whitespace / text.length,
    sampleBytes: sample.length,
  };
}

/** Long lines plus high entropy is the usual shape of a minified or packed script. */
export function looksMinified(stats: TextStats): boolean {
  return stats.entropy >= 5.2 && stats.avgLineLength >= 180;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function splitExtensionId(id: string): { namespace: string; name: string } {
  const trimmed = id.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1 || trimmed.includes(" ")) {
    throw new UserError(`Extension id must look like publisher.name (got "${id}").`);
  }
  return { namespace: trimmed.slice(0, dot), name: trimmed.slice(dot + 1) };
}

export function extensionIdKey(id: string): string {
  return id.trim().toLowerCase();
}

export function splitPinSpec(spec: string): { id: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new UserError(`Expected publisher.name@1.2.3 (got "${spec}").`);
  }
  const id = spec.slice(0, at);
  const version = spec.slice(at + 1);
  splitExtensionId(id);
  if (!version.trim()) throw new UserError(`Missing version in "${spec}".`);
  return { id, version };
}

const DURATION = /^(\d+(?:\.\d+)?)(w|d|h|m)?$/;

/** Parse `7`, `7d`, `48h`, `1w`, or `30m` into milliseconds. Bare numbers are days. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) {
    throw new UserError(`Invalid duration "${input}". Use 7, 7d, 48h, 30m, or 1w.`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "d";
  if (!Number.isFinite(amount) || amount < 0) {
    throw new UserError(`Invalid duration "${input}".`);
  }
  const unitMs: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
  };
  return amount * (unitMs[unit] ?? 86_400_000);
}

export function canonicalDuration(input: string): string {
  const match = DURATION.exec(input.trim());
  if (!match) return input.trim();
  const amount = Number(match[1]);
  const unit = match[2] ?? "d";
  const rendered = Number.isInteger(amount) ? String(amount) : String(amount);
  return `${rendered}${unit}`;
}

export function formatAge(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s`;
  const minutes = Math.round(abs / 60_000);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(abs / 86_400_000);
  return `${days}d`;
}

export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const value = Math.abs(bytes);
  if (value < 1024) return `${sign}${value} B`;
  if (value < 1024 * 1024) return `${sign}${(value / 1024).toFixed(1)} KB`;
  return `${sign}${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDelta(bytes: number): string {
  const rendered = formatBytes(bytes);
  return bytes > 0 ? `+${rendered}` : rendered;
}

export function parseRiskLevel(value: string): RiskLevel {
  const level = value.toLowerCase();
  if (level === "low" || level === "medium" || level === "high") return level;
  throw new UserError(`--fail-on must be low, medium, or high (got "${value}").`);
}

export function riskAtLeast(actual: RiskLevel, threshold: RiskLevel): boolean {
  const rank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
  return rank[actual] >= rank[threshold];
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function diffStringList(from: string[], to: string[]): { added: string[]; removed: string[] } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    added: to.filter((item) => !fromSet.has(item)),
    removed: from.filter((item) => !toSet.has(item)),
  };
}

export function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

export function fileExtension(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}

const MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp",
  "ttf", "otf", "woff", "woff2", "eot",
  "mp3", "mp4", "ogg", "wav", "webm",
  "pdf", "wasm", "zip", "gz", "br", "7z", "rar", "jar", "svgz",
]);

const SOURCE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "mts", "cts",
]);

const NATIVE_EXTENSIONS = new Set(["node", "exe", "dll", "so", "dylib"]);

export function isMediaPath(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  const parts = base.split(".");
  return parts.some((part) => MEDIA_EXTENSIONS.has(part));
}

export function isScriptPath(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(fileExtension(filePath));
}

export function nativeExtension(filePath: string): string | null {
  const parts = basename(filePath).toLowerCase().split(".");
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part && NATIVE_EXTENSIONS.has(part)) return part;
  }
  return null;
}

export function inNodeModules(filePath: string): boolean {
  return filePath === "node_modules" || filePath.startsWith("node_modules/") || filePath.includes("/node_modules/");
}

export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

export function safeZipPath(entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

export function toExtensionRelative(entryPath: string): string | null {
  const safe = safeZipPath(entryPath);
  if (!safe) return null;
  if (safe === "extension") return null;
  if (safe.startsWith("extension/")) return safe.slice("extension/".length);
  if (safe === "[Content_Types].xml" || safe === "extension.vsixmanifest") return null;
  return safe;
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  }
  if (items.length === 0) return [];
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
