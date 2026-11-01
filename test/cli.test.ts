import { mkdtemp, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { benignPair, maliciousPair } from "../src/fixture.js";
import type { Runtime } from "../src/types.js";

function capture(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, spawn?: Runtime["spawn"]) {
  let stdout = "";
  let stderr = "";
  const runtime: Partial<Runtime> = {
    env,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  };
  if (fetchImpl) runtime.fetch = fetchImpl;
  if (spawn) runtime.spawn = spawn;
  return {
    runtime,
    output: () => ({ stdout, stderr }),
  };
}

async function sandbox(): Promise<{ dir: string; env: NodeJS.ProcessEnv; config: string; cache: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vsx-diff-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  return {
    dir,
    config: path.join(dir, "config.json"),
    cache: path.join(dir, "cache"),
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      PATH: bin,
      XDG_CONFIG_HOME: dir,
      XDG_CACHE_HOME: dir,
      NO_COLOR: "1",
    },
  };
}

describe("cli", () => {
  it("prints help", async () => {
    const box = await sandbox();
    const cap = capture(box.env);
    const code = await main(["node", "vsx-diff", "--help"], cap.runtime);
    expect(code).toBe(0);
    expect(cap.output().stdout).toContain("publisher.name");
    expect(cap.output().stdout).toContain("cooldown");
  });

  it("compares local VSIX files offline and fails CI at high risk", async () => {
    const box = await sandbox();
    const pair = maliciousPair();
    const left = path.join(box.dir, "clean.vsix");
    const right = path.join(box.dir, "malicious.vsix");
    await writeFile(left, pair.from);
    await writeFile(right, pair.to);
    const cap = capture(box.env, () => {
      throw new Error("network should not be used");
    });
    const code = await main([
      "node", "vsx-diff", "compare", left, right, "--json", "--fail-on", "high",
      "--config", box.config, "--cache-dir", box.cache,
    ], cap.runtime);
    expect(code).toBe(1);
    const report = JSON.parse(cap.output().stdout) as { risk: { level: string }; extensionId: string };
    expect(report.risk.level).toBe("high");
    expect(report.extensionId).toBe("evilpub.hello");

    const markdown = capture(box.env);
    const mdCode = await main([
      "node", "vsx-diff", "--left", left, "--right", right, "--markdown", "--no-color",
      "--config", box.config,
    ], markdown.runtime);
    expect(mdCode).toBe(0);
    expect(markdown.output().stdout).toContain("**Risk: high**");
    expect(markdown.output().stdout).toContain("postinstall");
  });

  it("falls back to a dry-run when pin and cooldown have no editor CLI", async () => {
    const box = await sandbox();
    const cap = capture(box.env, () => {
      throw new Error("pin without an editor CLI should not download");
    });
    const code = await main([
      "node", "vsx-diff", "pin", "good.hello@1.2.3",
      "--config", box.config, "--cache-dir", box.cache,
    ], cap.runtime);
    expect(code).toBe(0);
    const text = cap.output().stdout;
    expect(text).toMatch(/Pinned good.hello to 1.2.3/);
    expect(text).toMatch(/No editor CLI found/);
    expect(text).toMatch(/Dry-run: editor install was not performed/);
    expect(text).toMatch(/code --install-extension/);
    const saved = JSON.parse(await readFile(box.config, "utf8")) as { pins: Record<string, string> };
    expect(saved.pins["good.hello"]).toBe("1.2.3");

    const cool = capture(box.env);
    const coolCode = await main(["node", "vsx-diff", "cooldown", "7", "--config", box.config], cool.runtime);
    expect(coolCode).toBe(0);
    expect(cool.output().stdout).toMatch(/at least 7d/);
    expect(cool.output().stdout).toMatch(/extensions.autoUpdate/);
    expect(cool.output().stdout).toMatch(/Dry-run: could not ask the editor/);
    const after = JSON.parse(await readFile(box.config, "utf8")) as { minAge: string };
    expect(after.minAge).toBe("7d");
  });

  it("runs the editor CLI for rollback when one is on PATH", async () => {
    const box = await sandbox();
    const cursor = path.join(box.dir, "bin", "cursor");
    const log = path.join(box.dir, "cursor.log");
    await writeFile(cursor, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`);
    await chmod(cursor, 0o755);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://open-vsx.org/api/good/hello") {
        return Response.json({
          namespace: "good",
          name: "hello",
          version: "1.2.0",
          timestamp: "2026-01-01T00:00:00.000Z",
          files: { download: "https://example.test/good.hello-1.2.0.vsix" },
          allVersions: { "1.2.0": "x", "1.0.0": "y" },
        });
      }
      return new Response("no", { status: 404 });
    };
    const cap = capture(box.env, fetchImpl);
    const code = await main([
      "node", "vsx-diff", "rollback", "good.hello", "--to", "1.0.0", "--dry-run",
      "--config", box.config, "--cache-dir", box.cache, "--no-default-extension-dirs",
    ], cap.runtime);
    expect(code).toBe(0);
    expect(cap.output().stdout).toMatch(/Dry-run: would pin good.hello to 1.0.0/);
    expect(cap.output().stdout).toMatch(/cursor --install-extension/);
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });

  it("checks installed extensions against a mocked registry", async () => {
    const box = await sandbox();
    const extDir = path.join(box.dir, "extensions");
    await mkdir(path.join(extDir, "good.hello-1.0.0"), { recursive: true });
    await writeFile(path.join(extDir, "good.hello-1.0.0", "package.json"), JSON.stringify({
      name: "hello",
      publisher: "good",
      version: "1.0.0",
    }));
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/good/hello")) {
        return Response.json({
          namespace: "good",
          name: "hello",
          version: "1.2.0",
          timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          files: { download: "https://example.test/hello.vsix" },
          allVersions: { "1.2.0": "a", "1.0.0": "b" },
        });
      }
      return new Response("no", { status: 404 });
    };
    const cap = capture({ ...box.env, PATH: box.dir }, fetchImpl);
    const code = await main([
      "node", "vsx-diff", "cooldown", "7", "--config", box.config,
    ], capture(box.env).runtime);
    expect(code).toBe(0);
    const check = await main([
      "node", "vsx-diff", "check", "--json", "--fail-on", "held",
      "--config", box.config,
      "--extensions-dir", extDir,
      "--no-default-extension-dirs",
    ], cap.runtime);
    expect(check).toBe(1);
    const report = JSON.parse(cap.output().stdout) as { extensions: Array<{ status: string; reasons: string[] }> };
    expect(report.extensions[0]?.status).toBe("held");
    expect(report.extensions[0]?.reasons.join(" ")).toMatch(/cooldown/);
  });

  it("downloads two versions from Open VSX and then uses the cache", async () => {
    const box = await sandbox();
    const pair = maliciousPair();
    let downloads = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://open-vsx.org/api/good/hello") {
        return Response.json({
          namespace: "good",
          name: "hello",
          version: "1.1.0",
          timestamp: "2026-04-01T00:00:00.000Z",
          preRelease: false,
          files: { download: "https://open-vsx.org/api/good/hello/1.1.0/file/good.hello-1.1.0.vsix" },
          allVersions: {
            "1.1.0": "https://open-vsx.org/api/good/hello/1.1.0",
            "1.0.0": "https://open-vsx.org/api/good/hello/1.0.0",
          },
        });
      }
      if (url.endsWith("good.hello-1.0.0.vsix")) {
        downloads += 1;
        return new Response(pair.from);
      }
      if (url.endsWith("good.hello-1.1.0.vsix")) {
        downloads += 1;
        return new Response(pair.to);
      }
      return new Response(`unexpected ${url}`, { status: 404 });
    };
    const args = [
      "node", "vsx-diff", "good.hello", "--from", "1.0.0", "--to", "1.1.0", "--json",
      "--config", box.config, "--cache-dir", box.cache, "--no-default-extension-dirs",
    ];
    const first = capture(box.env, fetchImpl);
    expect(await main(args, first.runtime)).toBe(0);
    expect(JSON.parse(first.output().stdout).risk.level).toBe("high");
    expect(downloads).toBe(2);
    const second = capture(box.env, fetchImpl);
    expect(await main(args, second.runtime)).toBe(0);
    expect(downloads).toBe(2);
    expect(second.output().stderr).toContain("cache hit");
  });

  it("falls back to the marketplace when Open VSX 404s", async () => {
    const box = await sandbox();
    const pair = benignPair();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://open-vsx.org/")) return new Response("missing", { status: 404 });
      if (url.includes("extensionquery")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          results: [{
            extensions: [{
              publisher: { publisherName: "good" },
              extensionName: "hello",
              versions: [
                {
                  version: "1.0.1",
                  lastUpdated: "2026-03-02T00:00:00.000Z",
                  files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: "https://example.test/new.vsix" }],
                },
                {
                  version: "1.0.0",
                  lastUpdated: "2026-03-01T00:00:00.000Z",
                  files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: "https://example.test/old.vsix" }],
                },
              ],
            }],
          }],
        });
      }
      if (url === "https://example.test/old.vsix") return new Response(pair.from);
      if (url === "https://example.test/new.vsix") return new Response(pair.to);
      return new Response("no", { status: 404 });
    };
    const cap = capture(box.env, fetchImpl);
    const code = await main([
      "node", "vsx-diff", "good.hello", "--from", "1.0.0", "--to", "1.0.1", "--no-color",
      "--config", box.config, "--cache-dir", box.cache, "--no-default-extension-dirs", "--fail-on", "high",
    ], cap.runtime);
    expect(code).toBe(0);
    expect(cap.output().stdout).toContain("LOW");
    expect(cap.output().stdout).toContain("VS Code Marketplace");
  });
});
