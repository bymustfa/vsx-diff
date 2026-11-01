import type {
  DepChange,
  DiffReport,
  FieldChange,
  FileBlob,
  FileChange,
  Manifest,
  RiskAssessment,
  RiskFactor,
  RiskLevel,
  ScriptChange,
  SideInfo,
  Snapshot,
  SuspiciousFinding,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import {
  asStringList,
  asStringMap,
  decodeUtf8,
  diffStringList,
  inNodeModules,
  isMediaPath,
  isPublicIpv4,
  isRecord,
  isScriptPath,
  looksMinified,
  nativeExtension,
  shannonEntropy,
  stableStringify,
  textStats,
} from "./util.js";

const HIGH_LIFECYCLE = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
]);

const MEDIUM_LIFECYCLE = new Set([
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
  "prepublishonly",
  "prepack",
  "postpack",
]);

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export function compareSnapshots(from: Snapshot, to: Snapshot, notes: string[] = []): DiffReport {
  const extensionId = to.extensionId !== "unknown.unknown" ? to.extensionId : from.extensionId;
  const extra = [...notes];
  if (from.extensionId !== to.extensionId) {
    extra.push(`Extension id changed from ${from.extensionId} to ${to.extensionId}.`);
  }
  const manifest = diffManifest(from.manifest, to.manifest);
  const scripts = diffScripts(from.manifest.scripts, to.manifest.scripts);
  const dependencies = diffDependencies(from.manifest, to.manifest);
  const fileDiff = diffFiles(from.files, to.files);
  const suspicious = findSuspicious(from.files, to.files, fileDiff.changes);
  const report: DiffReport = {
    schemaVersion: SCHEMA_VERSION,
    extensionId,
    from: sideOf(from),
    to: sideOf(to),
    risk: { level: "low", score: 0, reasons: [], factors: [] },
    manifest,
    scripts,
    dependencies,
    files: fileDiff,
    suspicious,
    notes: extra,
  };
  report.risk = assessRisk(report);
  return report;
}

function sideOf(snapshot: Snapshot): SideInfo {
  return {
    version: snapshot.version,
    source: snapshot.source,
    path: snapshot.path,
    publishedAt: snapshot.publishedAt,
  };
}

function diffManifest(from: Manifest, to: Manifest): FieldChange[] {
  const changes: FieldChange[] = [];
  pushScalar(changes, "name", from.name, to.name);
  pushScalar(changes, "publisher", from.publisher, to.publisher);
  pushScalar(changes, "version", from.version, to.version);
  pushScalar(changes, "displayName", from.displayName, to.displayName);
  pushScalar(changes, "description", from.description, to.description);
  pushScalar(changes, "main", from.main, to.main);
  pushScalar(changes, "browser", from.browser, to.browser);
  pushScalar(changes, "engines.vscode", from.engines?.vscode, to.engines?.vscode);

  const fromEvents = asStringList(from.activationEvents);
  const toEvents = asStringList(to.activationEvents);
  if (stableStringify(fromEvents) !== stableStringify(toEvents)) {
    const delta = diffStringList(fromEvents, toEvents);
    const bits = [
      delta.added.length ? `added ${delta.added.join(", ")}` : "",
      delta.removed.length ? `removed ${delta.removed.join(", ")}` : "",
    ].filter(Boolean);
    changes.push({
      field: "activationEvents",
      from: fromEvents,
      to: toEvents,
      note: bits.join("; ") || null,
    });
  }

  pushListField(changes, "extensionDependencies", from.extensionDependencies, to.extensionDependencies);
  pushListField(changes, "extensionPack", from.extensionPack, to.extensionPack);

  if (stableStringify(from.capabilities ?? null) !== stableStringify(to.capabilities ?? null)) {
    changes.push({
      field: "capabilities",
      from: from.capabilities ?? null,
      to: to.capabilities ?? null,
      note: capabilityNote(from, to),
    });
  }

  if (stableStringify(from.contributes ?? null) !== stableStringify(to.contributes ?? null)) {
    changes.push({
      field: "contributes",
      from: summarizeContributes(from.contributes),
      to: summarizeContributes(to.contributes),
      note: contributeNote(from.contributes, to.contributes),
    });
  }

  return changes;
}

function pushScalar(changes: FieldChange[], field: string, from: unknown, to: unknown): void {
  const left = from === undefined ? null : from;
  const right = to === undefined ? null : to;
  if (stableStringify(left) === stableStringify(right)) return;
  changes.push({ field, from: left, to: right, note: null });
}

function pushListField(
  changes: FieldChange[],
  field: string,
  from: unknown,
  to: unknown,
): void {
  const left = asStringList(from);
  const right = asStringList(to);
  if (stableStringify(left) === stableStringify(right)) return;
  const delta = diffStringList(left, right);
  const bits = [
    delta.added.length ? `added ${delta.added.join(", ")}` : "",
    delta.removed.length ? `removed ${delta.removed.join(", ")}` : "",
  ].filter(Boolean);
  changes.push({ field, from: left, to: right, note: bits.join("; ") || null });
}

function capabilityNote(from: Manifest, to: Manifest): string {
  const before = untrustedSupport(from);
  const after = untrustedSupport(to);
  if (before !== after) {
    return `untrustedWorkspaces.supported ${String(before)} → ${String(after)}`;
  }
  return "capabilities changed";
}

function untrustedSupport(manifest: Manifest): boolean | "limited" | "unset" {
  const value = manifest.capabilities?.untrustedWorkspaces?.supported;
  if (value === true || value === false || value === "limited") return value;
  return "unset";
}

function summarizeContributes(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const counts: Record<string, number> = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) counts[key] = child.length;
    else if (isRecord(child)) counts[key] = Object.keys(child).length;
    else counts[key] = 1;
  }
  return counts;
}

function commandIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.commands)) return [];
  const ids: string[] = [];
  for (const command of value.commands) {
    if (isRecord(command) && typeof command.command === "string") ids.push(command.command);
  }
  return ids;
}

function contributeNote(from: unknown, to: unknown): string {
  const left = summarizeContributes(from);
  const right = summarizeContributes(to);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const parts: string[] = [];
  for (const key of [...keys].sort()) {
    const before = left[key] ?? 0;
    const after = right[key] ?? 0;
    if (before !== after) parts.push(`${key} ${before} → ${after}`);
  }
  const commands = diffStringList(commandIds(from), commandIds(to));
  if (commands.added.length) parts.push(`commands added ${commands.added.join(", ")}`);
  if (commands.removed.length) parts.push(`commands removed ${commands.removed.join(", ")}`);
  return parts.join("; ") || "contribution contents changed";
}

function diffScripts(
  from: Record<string, string> | undefined,
  to: Record<string, string> | undefined,
): ScriptChange[] {
  const left = asStringMap(from);
  const right = asStringMap(to);
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const changes: ScriptChange[] = [];
  for (const name of names) {
    const before = left[name] ?? null;
    const after = right[name] ?? null;
    if (before === after) continue;
    const kind = before === null ? "added" : after === null ? "removed" : "changed";
    changes.push({ name, kind, from: before, to: after });
  }
  return changes;
}

function diffDependencies(from: Manifest, to: Manifest): DepChange[] {
  const changes: DepChange[] = [];
  for (const section of DEP_SECTIONS) {
    const left = asStringMap(from[section]);
    const right = asStringMap(to[section]);
    const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const name of names) {
      const before = left[name] ?? null;
      const after = right[name] ?? null;
      if (before === after) continue;
      const kind = before === null ? "added" : after === null ? "removed" : "bumped";
      changes.push({ section, name, kind, from: before, to: after });
    }
  }
  return changes;
}

function diffFiles(from: FileBlob[], to: FileBlob[]): DiffReport["files"] {
  const left = new Map(from.map((file) => [file.path, file]));
  const right = new Map(to.map((file) => [file.path, file]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes: FileChange[] = [];
  let unchanged = 0;
  for (const filePath of paths) {
    const before = left.get(filePath);
    const after = right.get(filePath);
    if (before && after && before.sha256 === after.sha256) {
      unchanged += 1;
      continue;
    }
    if (!before && after) {
      changes.push({
        path: filePath,
        kind: "added",
        sizeBefore: null,
        sizeAfter: after.size,
        delta: after.size,
        sha256Before: null,
        sha256After: after.sha256,
      });
    } else if (before && !after) {
      changes.push({
        path: filePath,
        kind: "removed",
        sizeBefore: before.size,
        sizeAfter: null,
        delta: -before.size,
        sha256Before: before.sha256,
        sha256After: null,
      });
    } else if (before && after) {
      changes.push({
        path: filePath,
        kind: "modified",
        sizeBefore: before.size,
        sizeAfter: after.size,
        delta: after.size - before.size,
        sha256Before: before.sha256,
        sha256After: after.sha256,
      });
    }
  }
  const rank = { added: 0, modified: 1, removed: 2 };
  changes.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
  return {
    added: changes.filter((change) => change.kind === "added").length,
    removed: changes.filter((change) => change.kind === "removed").length,
    modified: changes.filter((change) => change.kind === "modified").length,
    unchanged,
    changes,
  };
}

function findSuspicious(from: FileBlob[], to: FileBlob[], changes: FileChange[]): SuspiciousFinding[] {
  const left = new Map(from.map((file) => [file.path, file]));
  const right = new Map(to.map((file) => [file.path, file]));
  const findings: SuspiciousFinding[] = [];
  for (const change of changes) {
    if (change.kind === "removed") continue;
    const after = right.get(change.path);
    if (!after) continue;
    const before = left.get(change.path);
    const vendored = inNodeModules(change.path);

    const native = nativeExtension(change.path);
    if (native && change.kind === "added") {
      findings.push({
        path: change.path,
        category: "native-binary",
        severity: "high",
        indicator: native,
        points: vendored ? 40 : 60,
        detail: `New native binary (.${native}). Native code runs outside the JavaScript sandbox.`,
      });
    } else if (native && change.kind === "modified") {
      findings.push({
        path: change.path,
        category: "native-binary",
        severity: "medium",
        indicator: native,
        points: 25,
        detail: `Native binary (.${native}) contents changed.`,
      });
    }

    if (!isMediaPath(change.path) && !isScriptPath(change.path) && change.kind === "added") {
      const sample = after.data.subarray(0, 65_536);
      const entropy = shannonEntropy(sample);
      if (after.size >= 512 && entropy >= 7.5) {
        findings.push({
          path: change.path,
          category: "high-entropy",
          severity: vendored ? "low" : "medium",
          indicator: null,
          points: vendored ? 10 : 35,
          detail: `Shannon entropy ${entropy.toFixed(2)} bits/byte on ${sample.byteLength} sampled bytes (threshold 7.5). Random-looking content is unusual outside images, fonts, archives, and wasm.`,
        });
      }
    }

    // Vendored libraries are covered by the dependency diff. Scanning them
    // flags semver fixtures and README URLs that the extension author did not write.
    if (isScriptPath(change.path) && !vendored) {
      const afterStats = textStats(after.data);
      const beforeStats = before ? textStats(before.data) : null;
      const afterMin = looksMinified(afterStats);
      const beforeMin = beforeStats ? looksMinified(beforeStats) : false;
      if (afterMin && !beforeMin && !vendored) {
        findings.push({
          path: change.path,
          category: "minified",
          severity: "medium",
          indicator: null,
          points: 30,
          detail: `Script looks minified or obfuscated: Shannon entropy ${afterStats.entropy.toFixed(2)} bits/byte and average line length ${afterStats.avgLineLength.toFixed(0)} (thresholds 5.2 and 180).`,
        });
      }
      findings.push(...scriptIndicators(change.path, before?.data ?? null, after.data, afterMin || beforeMin, vendored));
    }
  }
  const severityRank: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.points - a.points || a.path.localeCompare(b.path));
  return findings;
}

function scriptIndicators(
  filePath: string,
  before: Uint8Array | null,
  after: Uint8Array,
  minified: boolean,
  vendored: boolean,
): SuspiciousFinding[] {
  const next = decodeUtf8(after.subarray(0, 262_144));
  const prev = before ? decodeUtf8(before.subarray(0, 262_144)) : "";
  const findings: SuspiciousFinding[] = [];
  const scanned = after.byteLength > 262_144 ? " Scanned the first 256KB." : "";

  const flags: Array<{ id: string; pattern: RegExp; severity: RiskLevel; points: number; detail: string }> = [
    {
      id: "child_process",
      pattern: /\bchild_process\b/,
      severity: "medium",
      points: 30,
      detail: "New child_process reference. The extension can spawn local processes.",
    },
    {
      id: "eval",
      pattern: /\beval\s*\(/,
      severity: "high",
      points: 55,
      detail: "New eval( call. The extension can execute a string as code.",
    },
    {
      id: "new_function",
      pattern: /\bnew\s+Function\b/,
      severity: "high",
      points: 55,
      detail: "New Function constructor. The extension can compile a string into code.",
    },
  ];

  for (const flag of flags) {
    const introduced = flag.pattern.test(next) && !flag.pattern.test(prev);
    flag.pattern.lastIndex = 0;
    if (!introduced) continue;
    const severity = vendored ? "low" : flag.severity;
    const points = vendored ? Math.min(10, flag.points) : flag.points;
    findings.push({
      path: filePath,
      category: "indicator",
      severity,
      indicator: flag.id,
      points,
      detail: `${flag.detail}${vendored ? " Matched inside node_modules, so this is weighted lower." : ""}${scanned}`,
    });
  }

  if (!minified) {
    const newUrls = newlyMatched(prev, next, /\bhttps?:\/\/[^\s"'`<>)\]]+/gi)
      .map((url) => url.replace(/[.,;:]+$/, ""))
      .filter((url) => !/^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(url));
    const uniqueUrls = [...new Set(newUrls)].slice(0, 5);
    if (uniqueUrls.length) {
      findings.push({
        path: filePath,
        category: "indicator",
        severity: "low",
        indicator: "url",
        points: vendored ? 4 : 8,
        detail: `New URL${uniqueUrls.length > 1 ? "s" : ""}: ${uniqueUrls.join(", ")}.${scanned}`,
      });
    }

    const newIps = newlyMatched(
      prev,
      next,
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    ).filter(isPublicIpv4);
    const uniqueIps = [...new Set(newIps)].slice(0, 5);
    if (uniqueIps.length) {
      findings.push({
        path: filePath,
        category: "indicator",
        severity: vendored ? "low" : "medium",
        indicator: "ipv4",
        points: vendored ? 8 : 25,
        detail: `New raw IP${uniqueIps.length > 1 ? "s" : ""}: ${uniqueIps.join(", ")}. Hard-coded addresses are a common callback pattern.${scanned}`,
      });
    }
  }

  return findings;
}

function newlyMatched(before: string, after: string, pattern: RegExp): string[] {
  const next = after.match(pattern) ?? [];
  const prev = new Set(before.match(pattern) ?? []);
  return next.filter((match) => !prev.has(match));
}

export function assessRisk(report: DiffReport): RiskAssessment {
  const factors: RiskFactor[] = [];

  for (const change of report.manifest) {
    if (change.field === "publisher" && change.from !== change.to) {
      factors.push({
        points: 100,
        severity: "high",
        reason: `Publisher changed from ${String(change.from)} to ${String(change.to)}. A publisher change means a different account now ships this extension.`,
      });
    }
    if (change.field === "main" || change.field === "browser") {
      factors.push({
        points: 25,
        severity: "medium",
        reason: `${change.field} entry changed from ${String(change.from)} to ${String(change.to)}.`,
      });
    }
    if (change.field === "activationEvents") {
      const added = diffStringList(asStringList(change.from), asStringList(change.to)).added;
      if (added.includes("*")) {
        factors.push({
          points: 80,
          severity: "high",
          reason: `activationEvents added "*", so the extension activates on every event.`,
        });
      }
      for (const event of added) {
        if (event === "*") continue;
        if (event === "onStartupFinished" || event === "onStartup") {
          factors.push({
            points: 40,
            severity: "medium",
            reason: `activationEvents added "${event}", so the extension runs as the editor starts.`,
          });
        } else {
          factors.push({
            points: 8,
            severity: "low",
            reason: `activationEvents added "${event}".`,
          });
        }
      }
      if (added.length === 0 && asStringList(change.from).length > 0 && asStringList(change.to).length === 0) {
        factors.push({
          points: 10,
          severity: "low",
          reason: "activationEvents removed. The editor may infer a broader activation from contributes.",
        });
      }
    }
    if (change.field === "extensionDependencies" || change.field === "extensionPack") {
      const added = diffStringList(asStringList(change.from), asStringList(change.to)).added;
      if (added.length) {
        factors.push({
          points: 20,
          severity: "medium",
          reason: `${change.field} added ${added.join(", ")}. Installing this update pulls in more extensions.`,
        });
      }
    }
    if (change.field === "capabilities") {
      const before = supportOf(change.from);
      const after = supportOf(change.to);
      if (after === true && before !== true) {
        factors.push({
          points: 30,
          severity: "medium",
          reason: "untrustedWorkspaces.supported is now true, so the extension may run in untrusted workspaces.",
        });
      } else {
        factors.push({
          points: 10,
          severity: "low",
          reason: change.note ?? "capabilities changed.",
        });
      }
    }
    if (change.field === "contributes") {
      factors.push({
        points: 5,
        severity: "low",
        reason: `contributes changed${change.note ? `: ${change.note}` : ""}.`,
      });
    }
  }

  for (const script of report.scripts) {
    if (script.kind === "removed") continue;
    const key = script.name.toLowerCase();
    if (HIGH_LIFECYCLE.has(key)) {
      factors.push({
        points: 70,
        severity: "high",
        reason: `npm lifecycle script ${script.kind}: ${script.name}${script.to ? ` (${script.to})` : ""}. Install scripts run when the package is installed.`,
      });
    } else if (MEDIUM_LIFECYCLE.has(key)) {
      factors.push({
        points: 30,
        severity: "medium",
        reason: `npm lifecycle script ${script.kind}: ${script.name}${script.to ? ` (${script.to})` : ""}.`,
      });
    }
  }

  let depPoints = 0;
  const depCap = 24;
  for (const dep of report.dependencies) {
    let points = 0;
    if (dep.kind === "added") points = dep.section === "dependencies" ? 10 : 4;
    else if (dep.kind === "bumped" && dep.section === "dependencies") points = 2;
    else if (dep.kind === "bumped") points = 1;
    else points = 1;
    if (depPoints >= depCap) continue;
    points = Math.min(points, depCap - depPoints);
    depPoints += points;
    const label = `${dep.section} ${dep.kind}: ${dep.name}${dep.to ? `@${dep.to}` : ""}`;
    factors.push({ points, severity: "low", reason: label });
  }

  for (const finding of report.suspicious) {
    factors.push({
      points: finding.points,
      severity: finding.severity,
      reason: `${finding.path}: ${finding.detail}`,
    });
  }

  return finalizeRisk(factors);
}

function supportOf(value: unknown): boolean | "limited" | "unset" {
  if (!isRecord(value)) return "unset";
  const untrusted = value.untrustedWorkspaces;
  if (!isRecord(untrusted)) return "unset";
  const supported = untrusted.supported;
  if (supported === true || supported === false || supported === "limited") return supported;
  return "unset";
}

function finalizeRisk(factors: RiskFactor[]): RiskAssessment {
  // Low findings are real, but a wall of new URLs or patch bumps should not
  // drown a report or flip the score to high by itself.
  let lowBudget = 30;
  const capped: RiskFactor[] = [];
  for (const factor of factors) {
    if (factor.severity !== "low") {
      capped.push(factor);
      continue;
    }
    const points = Math.min(factor.points, lowBudget);
    lowBudget -= points;
    if (points <= 0) continue;
    capped.push({ ...factor, points });
  }
  const score = capped.reduce((sum, factor) => sum + factor.points, 0);
  const rank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
  let level: RiskLevel = "low";
  for (const factor of capped) {
    if (rank[factor.severity] > rank[level]) level = factor.severity;
  }
  if (level === "low" && score >= 25) level = "medium";
  const mediumScore = capped
    .filter((factor) => factor.severity === "medium")
    .reduce((sum, factor) => sum + factor.points, 0);
  if (level !== "high" && mediumScore >= 90) level = "high";
  const sorted = [...capped].sort((a, b) => b.points - a.points || rank[a.severity] - rank[b.severity]);
  if (sorted.length === 0) {
    return {
      level: "low",
      score: 0,
      reasons: ["No risky changes detected."],
      factors: [],
    };
  }
  return { level, score, reasons: sorted.map((factor) => factor.reason), factors: sorted };
}
