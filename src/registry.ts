import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Listing, Runtime, SourcePreference, VersionRef } from "./types.js";
import {
  MARKETPLACE,
  OPEN_VSX,
  USER_AGENT,
  UserError,
  errorMessage,
  isRecord,
  splitExtensionId,
} from "./util.js";
import { VERSION_ALIASES, isPreRelease, versionCompare } from "./version.js";

export function openVsxVsixUrl(namespace: string, name: string, version: string): string {
  const file = `${namespace}.${name}-${version}.vsix`;
  return `${OPEN_VSX}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/file/${encodeURIComponent(file)}`;
}

export function marketplaceVsixUrl(publisher: string, name: string, version: string): string {
  return `${MARKETPLACE}/_apis/public/gallery/publishers/${encodeURIComponent(publisher)}/vsextensions/${encodeURIComponent(name)}/${encodeURIComponent(version)}/vspackage`;
}

export function normalizePackageBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return new Uint8Array(gunzipSync(bytes));
  }
  return bytes;
}

export function isVsixMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function parseOpenVsxListing(json: unknown): Listing | null {
  if (!isRecord(json)) return null;
  if (typeof json.namespace !== "string" || typeof json.name !== "string" || typeof json.version !== "string") {
    return null;
  }
  const namespace = json.namespace;
  const name = json.name;
  const versions = new Map<string, VersionRef>();
  if (isRecord(json.allVersions)) {
    for (const key of Object.keys(json.allVersions)) {
      if (VERSION_ALIASES.has(key.toLowerCase())) continue;
      versions.set(key, {
        version: key,
        publishedAt: null,
        downloadUrl: openVsxVsixUrl(namespace, name, key),
        preRelease: isPreRelease(key),
        source: "openvsx",
        targetPlatform: null,
      });
    }
  }
  const downloadUrl = downloadFromOpenVsxFiles(json) ?? openVsxVsixUrl(namespace, name, json.version);
  const timestamp = typeof json.timestamp === "string" ? json.timestamp : null;
  const current: VersionRef = {
    version: json.version,
    publishedAt: timestamp,
    downloadUrl,
    preRelease: json.preRelease === true || isPreRelease(json.version),
    source: "openvsx",
    targetPlatform: typeof json.targetPlatform === "string" ? json.targetPlatform : null,
  };
  versions.set(current.version, current);
  return {
    id: `${namespace}.${name}`,
    namespace,
    name,
    source: "openvsx",
    versions: sortVersions([...versions.values()]),
  };
}

function downloadFromOpenVsxFiles(json: Record<string, unknown>): string | null {
  if (isRecord(json.files) && typeof json.files.download === "string") return json.files.download;
  if (isRecord(json.downloads)) {
    if (typeof json.downloads.universal === "string") return json.downloads.universal;
    for (const value of Object.values(json.downloads)) {
      if (typeof value === "string") return value;
    }
  }
  return null;
}

export function parseMarketplaceQuery(json: unknown): Listing | null {
  if (!isRecord(json) || !Array.isArray(json.results)) return null;
  const first = json.results[0];
  if (!isRecord(first) || !Array.isArray(first.extensions) || first.extensions.length === 0) return null;
  const extension = first.extensions[0];
  if (!isRecord(extension)) return null;
  const publisher = isRecord(extension.publisher) && typeof extension.publisher.publisherName === "string"
    ? extension.publisher.publisherName
    : null;
  const name = typeof extension.extensionName === "string" ? extension.extensionName : null;
  if (!publisher || !name || !Array.isArray(extension.versions)) return null;

  const byVersion = new Map<string, VersionRef>();
  for (const entry of extension.versions) {
    if (!isRecord(entry) || typeof entry.version !== "string") continue;
    const platform = typeof entry.targetPlatform === "string" ? entry.targetPlatform : null;
    const download = marketplaceFile(entry) ?? marketplaceVsixUrl(publisher, name, entry.version);
    const candidate: VersionRef = {
      version: entry.version,
      publishedAt: typeof entry.lastUpdated === "string" ? entry.lastUpdated : null,
      downloadUrl: download,
      preRelease: marketplacePreRelease(entry) || isPreRelease(entry.version),
      source: "marketplace",
      targetPlatform: platform,
    };
    const existing = byVersion.get(candidate.version);
    if (!existing || platformRank(candidate.targetPlatform) < platformRank(existing.targetPlatform)) {
      byVersion.set(candidate.version, candidate);
    }
  }
  if (byVersion.size === 0) return null;
  return {
    id: `${publisher}.${name}`,
    namespace: publisher,
    name,
    source: "marketplace",
    versions: sortVersions([...byVersion.values()]),
  };
}

function marketplaceFile(version: Record<string, unknown>): string | null {
  if (!Array.isArray(version.files)) return null;
  for (const file of version.files) {
    if (!isRecord(file)) continue;
    if (file.assetType === "Microsoft.VisualStudio.Services.VSIXPackage" && typeof file.source === "string") {
      return absoluteMarketplace(file.source);
    }
  }
  return null;
}

function absoluteMarketplace(source: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) return source;
  if (source.startsWith("/")) return `${MARKETPLACE}${source}`;
  return source;
}

function marketplacePreRelease(version: Record<string, unknown>): boolean {
  if (!Array.isArray(version.properties)) return false;
  return version.properties.some((property) => {
    if (!isRecord(property)) return false;
    return property.key === "Microsoft.VisualStudio.Code.PreRelease" && property.value === "true";
  });
}

function platformRank(platform: string | null): number {
  if (!platform || platform === "universal") return 0;
  return 1;
}

export function sortVersions(versions: VersionRef[]): VersionRef[] {
  return [...versions].sort((a, b) => versionCompare(b.version, a.version) || platformRank(a.targetPlatform) - platformRank(b.targetPlatform));
}

export function selectLatest(versions: VersionRef[], includePreRelease: boolean): VersionRef | null {
  const pool = includePreRelease ? versions : versions.filter((version) => !version.preRelease);
  return pool[0] ?? versions[0] ?? null;
}

export function selectPrevious(versions: VersionRef[], latest: VersionRef, includePreRelease: boolean): VersionRef | null {
  const pool = (includePreRelease ? versions : versions.filter((version) => !version.preRelease))
    .filter((version) => version.version !== latest.version);
  return pool[0] ?? null;
}

export function selectVersion(versions: VersionRef[], version: string): VersionRef | null {
  return versions.find((item) => item.version === version)
    ?? versions.find((item) => versionCompare(item.version, version) === 0)
    ?? null;
}

export class RegistryClient {
  constructor(
    private readonly runtime: Runtime,
    private readonly timeoutMs: number,
  ) {}

  async getListing(rawId: string, preference: SourcePreference): Promise<Listing> {
    const errors: string[] = [];
    if (preference !== "marketplace") {
      try {
        const listing = await this.fromOpenVsx(rawId);
        if (listing) return listing;
        errors.push("Open VSX has no such extension");
      } catch (error) {
        errors.push(`Open VSX: ${errorMessage(error)}`);
        if (preference === "openvsx") throw new UserError(errors.join("; "));
      }
    }
    if (preference !== "openvsx") {
      try {
        const listing = await this.fromMarketplace(rawId);
        if (listing) return listing;
        errors.push("VS Code Marketplace has no such extension");
      } catch (error) {
        errors.push(`Marketplace: ${errorMessage(error)}`);
      }
    }
    throw new UserError(`Could not resolve ${rawId}. ${errors.join("; ")}`);
  }

  async enrich(listing: Listing, version: VersionRef): Promise<VersionRef> {
    if (version.source !== "openvsx" || version.publishedAt) return version;
    const json = await this.getJson(
      `${OPEN_VSX}/api/${encodeURIComponent(listing.namespace)}/${encodeURIComponent(listing.name)}/${encodeURIComponent(version.version)}`,
    );
    if (!json) return version;
    const download = downloadFromOpenVsxFiles(json);
    return {
      ...version,
      publishedAt: typeof json.timestamp === "string" ? json.timestamp : version.publishedAt,
      downloadUrl: download ?? version.downloadUrl,
      preRelease: json.preRelease === true || version.preRelease,
    };
  }

  async download(version: VersionRef, cacheDir: string, refresh: boolean, listing: Listing): Promise<{ filePath: string; bytes: Uint8Array }> {
    const dest = path.join(cacheDir, sanitize(listing.id), `${sanitize(version.version)}-${version.source}.vsix`);
    if (!refresh) {
      const cached = await readCached(dest);
      if (cached) {
        this.runtime.stderr(`cache hit ${dest}\n`);
        return { filePath: dest, bytes: cached };
      }
    }
    this.runtime.stderr(`download ${version.source} ${listing.id}@${version.version}\n`);
    let bytes = await this.fetchPackage(version.downloadUrl);
    if (!isVsixMagic(bytes) && version.source === "openvsx") {
      const detail = await this.openVsxVersion(listing.namespace, listing.name, version.version);
      if (detail && detail !== version.downloadUrl) {
        this.runtime.stderr(`retry download ${detail}\n`);
        bytes = await this.fetchPackage(detail);
      }
    }
    if (!isVsixMagic(bytes)) {
      throw new UserError(`Download for ${listing.id}@${version.version} was not a VSIX archive.`);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    return { filePath: dest, bytes };
  }

  private async fromOpenVsx(rawId: string): Promise<Listing | null> {
    const { namespace, name } = splitExtensionId(rawId);
    const direct = await this.getJson(`${OPEN_VSX}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    const parsed = direct ? parseOpenVsxListing(direct) : null;
    if (parsed) return parsed;
    const found = await this.searchOpenVsx(rawId);
    if (!found) return null;
    const json = await this.getJson(`${OPEN_VSX}/api/${encodeURIComponent(found.namespace)}/${encodeURIComponent(found.name)}`);
    return json ? parseOpenVsxListing(json) : null;
  }

  private async searchOpenVsx(rawId: string): Promise<{ namespace: string; name: string } | null> {
    const url = `${OPEN_VSX}/api/-/search?query=${encodeURIComponent(rawId)}&size=10`;
    const json = await this.getJson(url);
    if (!isRecord(json) || !Array.isArray(json.extensions)) return null;
    const target = rawId.toLowerCase();
    for (const entry of json.extensions) {
      if (!isRecord(entry) || typeof entry.namespace !== "string" || typeof entry.name !== "string") continue;
      const id = `${entry.namespace}.${entry.name}`.toLowerCase();
      if (id === target) return { namespace: entry.namespace, name: entry.name };
    }
    return null;
  }

  private async openVsxVersion(namespace: string, name: string, version: string): Promise<string | null> {
    const json = await this.getJson(
      `${OPEN_VSX}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    );
    if (!json) return null;
    return downloadFromOpenVsxFiles(json);
  }

  private async fromMarketplace(rawId: string): Promise<Listing | null> {
    const { namespace, name } = splitExtensionId(rawId);
    const body = {
      filters: [
        {
          criteria: [{ filterType: 7, value: `${namespace}.${name}` }],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      flags: 0x1 | 0x2 | 0x10 | 0x80,
    };
    const response = await this.runtime.fetch(`${MARKETPLACE}/_apis/public/gallery/extensionquery`, {
      method: "POST",
      redirect: "follow",
      headers: {
        accept: "application/json;api-version=3.0-preview.1",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from the VS Code Marketplace`);
    }
    return parseMarketplaceQuery(await response.json() as unknown);
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    const response = await this.runtime.fetch(url, {
      redirect: "follow",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const json = await response.json() as unknown;
    return isRecord(json) ? json : null;
  }

  private async fetchPackage(url: string): Promise<Uint8Array> {
    const response = await this.runtime.fetch(url, {
      redirect: "follow",
      headers: { accept: "application/octet-stream,*/*", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new UserError(`HTTP ${response.status} downloading ${url}`);
    return normalizePackageBytes(new Uint8Array(await response.arrayBuffer()));
  }
}

async function readCached(filePath: string): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    return isVsixMagic(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._+-]+/g, "_");
}
