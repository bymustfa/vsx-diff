import { strToU8, unzipSync, zipSync } from "fflate";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileBlob, Manifest, Snapshot } from "./types.js";
import { UserError, decodeUtf8, isRecord, sha256, toExtensionRelative } from "./util.js";

export function packVsix(files: Record<string, Uint8Array | string>): Uint8Array {
  const zipped: Record<string, Uint8Array> = {};
  for (const [filePath, content] of Object.entries(files)) {
    const rel = filePath.startsWith("extension/") ? filePath : `extension/${filePath}`;
    zipped[rel] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zipped, { level: 9 });
}

export function unpackVsix(bytes: Uint8Array): FileBlob[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Could not unpack VSIX (${message}).`);
  }
  const files: FileBlob[] = [];
  for (const [entryPath, data] of Object.entries(entries)) {
    const rel = toExtensionRelative(entryPath);
    if (!rel) continue;
    files.push({
      path: rel,
      size: data.byteLength,
      sha256: sha256(data),
      data,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function parseManifest(files: FileBlob[]): Manifest {
  const pkg = files.find((file) => file.path === "package.json");
  if (!pkg) throw new UserError("VSIX is missing extension/package.json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(pkg.data).replace(/^\uFEFF/, ""));
  } catch {
    throw new UserError("extension/package.json is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new UserError("extension/package.json is not an object.");
  return parsed;
}

export function snapshotFromFiles(
  files: FileBlob[],
  source: string,
  filePath: string | null,
  publishedAt: string | null,
): Snapshot {
  const manifest = parseManifest(files);
  const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "unknown";
  const name = typeof manifest.name === "string" ? manifest.name : "unknown";
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  return {
    extensionId: `${publisher}.${name}`,
    version,
    source,
    path: filePath,
    publishedAt,
    manifest,
    files,
  };
}

export function snapshotFromVsixBytes(
  bytes: Uint8Array,
  source: string,
  filePath: string | null,
  publishedAt: string | null,
): Snapshot {
  return snapshotFromFiles(unpackVsix(bytes), source, filePath, publishedAt);
}

export async function readDirectoryFiles(root: string): Promise<FileBlob[]> {
  const files: FileBlob[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const data = new Uint8Array(await readFile(abs));
        files.push({ path: rel, size: data.byteLength, sha256: sha256(data), data });
      }
    }
  }
  const info = await stat(root);
  if (!info.isDirectory()) throw new UserError(`${root} is not a directory.`);
  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function snapshotFromDirectory(root: string, source = "installed"): Promise<Snapshot> {
  const files = await readDirectoryFiles(root);
  return snapshotFromFiles(files, source, root, null);
}
