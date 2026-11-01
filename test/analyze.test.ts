import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compareSnapshots } from "../src/analyze.js";
import { benignPair, maliciousPair } from "../src/fixture.js";
import { packVsix, snapshotFromVsixBytes } from "../src/unpack.js";
import { isVsixMagic, normalizePackageBytes, parseMarketplaceQuery, parseOpenVsxListing } from "../src/registry.js";
import { parseFolderName } from "../src/installed.js";
import { decideUpdate } from "../src/policy.js";
import { shannonEntropy, parseDuration, canonicalDuration } from "../src/util.js";

describe("heuristics", () => {
  it("measures Shannon entropy", () => {
    const uniform = new Uint8Array(256);
    for (let i = 0; i < uniform.length; i++) uniform[i] = i;
    expect(shannonEntropy(uniform)).toBeCloseTo(8, 5);
    expect(shannonEntropy(new Uint8Array(64).fill(97))).toBe(0);
  });

  it("parses durations in days by default", () => {
    expect(parseDuration("7")).toBe(7 * 86_400_000);
    expect(parseDuration("48h")).toBe(48 * 3_600_000);
    expect(canonicalDuration("7")).toBe("7d");
    expect(() => parseDuration("soon")).toThrow(/duration/i);
  });

  it("parses installed extension folder names", () => {
    expect(parseFolderName("good.hello-1.2.3")).toEqual({ id: "good.hello", version: "1.2.3" });
    expect(parseFolderName("ms-vscode.cpptools-1.23.5-linux-x64")).toEqual({
      id: "ms-vscode.cpptools",
      version: "1.23.5",
    });
    expect(parseFolderName("extensions.json")).toBeNull();
  });
});

describe("compare", () => {
  it("scores the malicious fixture as high", () => {
    const pair = maliciousPair();
    const report = compareSnapshots(
      snapshotFromVsixBytes(pair.from, "file", "clean.vsix", null),
      snapshotFromVsixBytes(pair.to, "file", "malicious.vsix", null),
    );
    expect(report.risk.level).toBe("high");
    expect(report.risk.score).toBeGreaterThanOrEqual(100);
    const text = report.risk.reasons.join("\n");
    expect(text).toMatch(/Publisher changed from goodpub to evilpub/);
    expect(text).toMatch(/activationEvents added "\*"/);
    expect(text).toMatch(/postinstall/);
    expect(text).toContain("child_process");
    expect(text).toContain("eval");
    expect(text).toContain("Function constructor");
    expect(text).toContain("203.0.113.10");
    expect(report.suspicious.some((finding) => finding.category === "native-binary")).toBe(true);
    expect(report.suspicious.some((finding) => finding.category === "high-entropy")).toBe(true);
    expect(report.scripts.some((script) => script.name === "postinstall" && script.kind === "added")).toBe(true);
    expect(report.dependencies.some((dep) => dep.name === "evil-lib" && dep.kind === "added")).toBe(true);
    expect(report.files.added).toBeGreaterThanOrEqual(2);
  });

  it("scores a version bump and readme edit as low", () => {
    const pair = benignPair();
    const report = compareSnapshots(
      snapshotFromVsixBytes(pair.from, "file", "a.vsix", null),
      snapshotFromVsixBytes(pair.to, "file", "b.vsix", null),
    );
    expect(report.risk.level).toBe("low");
    expect(report.manifest.some((change) => change.field === "version" && change.to === "1.0.1")).toBe(true);
    expect(report.files.modified).toBeGreaterThanOrEqual(1);
  });

  it("does not treat vendored node_modules scripts as extension behavior", () => {
    const base = packVsix({
      "package.json": JSON.stringify({ name: "hello", publisher: "good", version: "1.0.0", main: "./ext.js" }),
      "ext.js": "function activate(){ return 1 }\n",
    });
    const next = packVsix({
      "package.json": JSON.stringify({ name: "hello", publisher: "good", version: "1.1.0", main: "./ext.js" }),
      "ext.js": "function activate(){ return 1 }\n",
      "node_modules/semver/functions/coerce.js": "const example = '1.2.3.4';\nrequire('child_process');\n",
    });
    const report = compareSnapshots(
      snapshotFromVsixBytes(base, "file", null, null),
      snapshotFromVsixBytes(next, "file", null, null),
    );
    expect(report.suspicious).toEqual([]);
    expect(report.files.added).toBe(1);
  });

  it("ignores private IP addresses and reports public ones", () => {
    const base = packVsix({
      "package.json": JSON.stringify({ name: "hello", publisher: "good", version: "1.0.0", main: "./ext.js" }),
      "ext.js": "function activate(){ return 1 }\n",
    });
    const next = packVsix({
      "package.json": JSON.stringify({ name: "hello", publisher: "good", version: "1.0.1", main: "./ext.js" }),
      "ext.js": "const local = '10.0.0.8'; const dns = '8.8.8.8';\n",
    });
    const report = compareSnapshots(
      snapshotFromVsixBytes(base, "file", null, null),
      snapshotFromVsixBytes(next, "file", null, null),
    );
    const text = JSON.stringify(report.suspicious);
    expect(text).toContain("8.8.8.8");
    expect(text).not.toContain("10.0.0.8");
    expect(report.risk.level).not.toBe("high");
  });

  it("gunzips marketplace downloads before unpacking", () => {
    const pair = benignPair();
    const gzipped = gzipSync(pair.from);
    const bytes = normalizePackageBytes(gzipped);
    expect(isVsixMagic(bytes)).toBe(true);
    expect(snapshotFromVsixBytes(bytes, "file", null, null).version).toBe("1.0.0");
  });
});

describe("registries", () => {
  it("parses an Open VSX listing and skips the latest alias", () => {
    const listing = parseOpenVsxListing({
      namespace: "good",
      name: "hello",
      version: "1.2.0",
      timestamp: "2026-01-02T00:00:00.000Z",
      preRelease: false,
      files: { download: "https://example.test/hello-1.2.0.vsix" },
      allVersions: {
        latest: "https://example.test/latest",
        "1.2.0": "https://example.test/1.2.0",
        "1.0.0": "https://example.test/1.0.0",
      },
    });
    expect(listing?.id).toBe("good.hello");
    expect(listing?.versions.map((version) => version.version)).toEqual(["1.2.0", "1.0.0"]);
    expect(listing?.versions[0]?.downloadUrl).toBe("https://example.test/hello-1.2.0.vsix");
    expect(listing?.versions[0]?.publishedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("parses a marketplace query and prefers a universal package", () => {
    const listing = parseMarketplaceQuery({
      results: [{
        extensions: [{
          publisher: { publisherName: "good" },
          extensionName: "hello",
          versions: [
            {
              version: "1.2.0",
              lastUpdated: "2026-02-01T00:00:00.000Z",
              targetPlatform: "linux-x64",
              files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: "https://example.test/linux.vsix" }],
            },
            {
              version: "1.2.0",
              lastUpdated: "2026-02-01T00:00:00.000Z",
              targetPlatform: "universal",
              files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: "https://example.test/universal.vsix" }],
            },
          ],
        }],
      }],
    });
    expect(listing?.versions).toHaveLength(1);
    expect(listing?.versions[0]?.downloadUrl).toBe("https://example.test/universal.vsix");
    expect(listing?.source).toBe("marketplace");
  });
});

describe("policy decisions", () => {
  const now = Date.parse("2026-11-01T00:00:00.000Z");

  it("holds a two-day-old update when the cooldown is 7 days", () => {
    const decision = decideUpdate({
      installed: "1.0.0",
      latest: "1.2.0",
      publishedAt: "2026-10-30T00:00:00.000Z",
      now,
      minAge: "7d",
      pin: null,
    });
    expect(decision.status).toBe("held");
    expect(decision.reasons.join(" ")).toMatch(/cooldown 7d/);
  });

  it("allows an update older than the cooldown and holds pins", () => {
    expect(decideUpdate({
      installed: "1.0.0",
      latest: "1.2.0",
      publishedAt: "2026-09-01T00:00:00.000Z",
      now,
      minAge: "7d",
      pin: null,
    }).status).toBe("allowed");

    const pinned = decideUpdate({
      installed: "1.0.0",
      latest: "1.2.0",
      publishedAt: "2026-09-01T00:00:00.000Z",
      now,
      minAge: "7d",
      pin: "1.0.0",
    });
    expect(pinned.status).toBe("held");
    expect(pinned.reasons.join(" ")).toMatch(/pinned to 1.0.0/);
  });

  it("reports up to date when installed matches latest", () => {
    expect(decideUpdate({
      installed: "1.2.0",
      latest: "1.2.0",
      publishedAt: "2026-10-01T00:00:00.000Z",
      now,
      minAge: "7d",
      pin: null,
    }).status).toBe("up-to-date");
  });
});
