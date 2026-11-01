import { createColors } from "picocolors";
import type { CheckReport, DepChange, DiffReport, FieldChange, FileChange, RiskLevel, ScriptChange } from "./types.js";
import { formatBytes, formatDelta } from "./util.js";

const FILE_LIMIT = 30;
const DEP_LIMIT = 40;

export function renderJson(report: DiffReport | CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(`## vsx-diff \`${report.extensionId}\` \`${report.from.version}\` → \`${report.to.version}\``);
  lines.push("");
  lines.push(`**Risk: ${report.risk.level}** (score ${report.risk.score})`);
  lines.push("");
  lines.push(`- From: \`${report.from.version}\` (${report.from.source}${report.from.path ? `, ${report.from.path}` : ""})`);
  lines.push(`- To: \`${report.to.version}\` (${report.to.source}${report.to.path ? `, ${report.to.path}` : ""})`);
  if (report.from.publishedAt || report.to.publishedAt) {
    lines.push(`- Published: ${report.from.publishedAt ?? "unknown"} → ${report.to.publishedAt ?? "unknown"}`);
  }
  lines.push("");
  lines.push("### Why");
  lines.push("");
  for (const factor of report.risk.factors.length ? report.risk.factors : []) {
    lines.push(`- **+${factor.points} ${factor.severity}** ${factor.reason}`);
  }
  if (report.risk.factors.length === 0) {
    for (const reason of report.risk.reasons) lines.push(`- ${reason}`);
  }
  if (report.notes.length) {
    lines.push("");
    lines.push("### Notes");
    lines.push("");
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push("### package.json");
  lines.push("");
  lines.push("| Field | From | To | Note |");
  lines.push("| --- | --- | --- | --- |");
  if (report.manifest.length === 0) lines.push("| _(no changes)_ | | | |");
  for (const change of report.manifest) {
    lines.push(`| ${cell(change.field)} | ${cell(preview(change.from))} | ${cell(preview(change.to))} | ${cell(change.note ?? "")} |`);
  }
  lines.push("");
  lines.push("### npm scripts");
  lines.push("");
  lines.push(scriptTable(report.scripts));
  lines.push("");
  lines.push("### Dependencies");
  lines.push("");
  lines.push(depTable(report.dependencies));
  lines.push("");
  lines.push("### Files");
  lines.push("");
  lines.push(`Added ${report.files.added}, removed ${report.files.removed}, modified ${report.files.modified}, unchanged ${report.files.unchanged}.`);
  lines.push("");
  lines.push("| Change | Path | Size | Delta |");
  lines.push("| --- | --- | --- | --- |");
  const shown = report.files.changes.slice(0, 80);
  for (const change of shown) lines.push(fileRow(change));
  if (report.files.changes.length > shown.length) {
    lines.push(`| | _${report.files.changes.length - shown.length} more in JSON output_ | | |`);
  }
  lines.push("");
  lines.push("### Suspicious");
  lines.push("");
  if (report.suspicious.length === 0) lines.push("None.");
  for (const finding of report.suspicious) {
    lines.push(`- **${finding.severity}** \`${finding.path}\` (${finding.category}${finding.indicator ? `/${finding.indicator}` : ""}): ${finding.detail}`);
  }
  lines.push("");
  lines.push(`Report from vsx-diff. Risk score ${report.risk.score} (${report.risk.level}).`);
  lines.push("");
  return lines.join("\n");
}

function scriptTable(scripts: ScriptChange[]): string {
  if (scripts.length === 0) return "No script changes.";
  const lines = ["| Script | Change | From | To |", "| --- | --- | --- | --- |"];
  for (const script of scripts) {
    lines.push(`| ${cell(script.name)} | ${script.kind} | ${cell(script.from ?? "")} | ${cell(script.to ?? "")} |`);
  }
  return lines.join("\n");
}

function depTable(deps: DepChange[]): string {
  if (deps.length === 0) return "No dependency changes.";
  const lines = ["| Section | Package | Change | From | To |", "| --- | --- | --- | --- | --- |"];
  for (const dep of deps.slice(0, 80)) {
    lines.push(`| ${dep.section} | ${cell(dep.name)} | ${dep.kind} | ${cell(dep.from ?? "")} | ${cell(dep.to ?? "")} |`);
  }
  if (deps.length > 80) lines.push(`| | _${deps.length - 80} more in JSON output_ | | | |`);
  return lines.join("\n");
}

function fileRow(change: FileChange): string {
  const size = change.kind === "removed"
    ? formatBytes(change.sizeBefore ?? 0)
    : `${formatBytes(change.sizeBefore ?? 0)} → ${formatBytes(change.sizeAfter ?? 0)}`;
  return `| ${change.kind} | ${cell(change.path)} | ${cell(size)} | ${cell(formatDelta(change.delta))} |`;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderTerminal(report: DiffReport, color: boolean): string {
  const c = createColors(color);
  const paint = levelColor(c, report.risk.level);
  const lines: string[] = [];
  lines.push(`${c.bold("vsx-diff")}  ${c.cyan(report.extensionId)}`);
  lines.push(`${c.dim(report.from.version)} ${c.dim(`(${report.from.source})`)}  ${c.bold("→")}  ${c.bold(report.to.version)} ${c.dim(`(${report.to.source})`)}`);
  if (report.from.path || report.to.path) {
    lines.push(c.dim(`${report.from.path ?? "download"}  →  ${report.to.path ?? "download"}`));
  }
  if (report.from.publishedAt || report.to.publishedAt) {
    lines.push(c.dim(`published ${report.from.publishedAt ?? "unknown"}  →  ${report.to.publishedAt ?? "unknown"}`));
  }
  lines.push("");
  lines.push(`${c.bold("Risk")}  ${paint(c.bold(report.risk.level.toUpperCase()))}  ${c.dim(`score ${report.risk.score}`)}`);
  const factors = report.risk.factors.length
    ? report.risk.factors
    : report.risk.reasons.map((reason) => ({ points: 0, severity: "low" as const, reason }));
  for (const factor of factors) {
    const tag = factor.points > 0 ? c.dim(`+${String(factor.points).padStart(3, " ")}`) : c.dim("    ");
    lines.push(`  ${tag}  ${levelColor(c, factor.severity)(factor.severity.padEnd(6, " "))}  ${factor.reason}`);
  }
  if (report.notes.length) {
    lines.push("");
    lines.push(c.bold("Notes"));
    for (const note of report.notes) lines.push(`  ${c.dim("·")} ${note}`);
  }

  lines.push("");
  lines.push(c.bold("Manifest"));
  if (report.manifest.length === 0) lines.push(c.dim("  no package.json field changes"));
  for (const change of report.manifest) lines.push(`  ${formatField(change, c)}`);

  lines.push("");
  lines.push(c.bold("Lifecycle scripts"));
  if (report.scripts.length === 0) lines.push(c.dim("  no script changes"));
  for (const script of report.scripts) {
    const value = script.kind === "removed" ? script.from ?? "" : script.to ?? "";
    lines.push(`  ${kindGlyph(script.kind, c)}  ${c.bold(script.name)}  ${c.dim(value)}`);
  }

  lines.push("");
  lines.push(c.bold("Dependencies"));
  if (report.dependencies.length === 0) lines.push(c.dim("  no dependency changes"));
  for (const dep of report.dependencies.slice(0, DEP_LIMIT)) {
    const version = dep.kind === "bumped" ? `${dep.from} → ${dep.to}` : (dep.to ?? dep.from ?? "");
    lines.push(`  ${kindGlyph(dep.kind === "bumped" ? "changed" : dep.kind, c)}  ${c.dim(dep.section)}  ${dep.name}@${version}`);
  }
  if (report.dependencies.length > DEP_LIMIT) {
    lines.push(c.dim(`  … ${report.dependencies.length - DEP_LIMIT} more`));
  }

  lines.push("");
  lines.push(`${c.bold("Files")}  ${c.green(`+${report.files.added}`)}  ${c.yellow(`~${report.files.modified}`)}  ${c.red(`-${report.files.removed}`)}  ${c.dim(`${report.files.unchanged} unchanged`)}`);
  for (const change of report.files.changes.slice(0, FILE_LIMIT)) {
    const size = change.kind === "added"
      ? formatBytes(change.sizeAfter ?? 0)
      : change.kind === "removed"
        ? formatBytes(change.sizeBefore ?? 0)
        : `${formatBytes(change.sizeBefore ?? 0)} → ${formatBytes(change.sizeAfter ?? 0)} (${formatDelta(change.delta)})`;
    lines.push(`  ${kindGlyph(change.kind, c)}  ${change.path}  ${c.dim(size)}`);
  }
  if (report.files.changes.length > FILE_LIMIT) {
    lines.push(c.dim(`  … ${report.files.changes.length - FILE_LIMIT} more (see --json)`));
  }

  lines.push("");
  lines.push(c.bold("Suspicious"));
  if (report.suspicious.length === 0) lines.push(c.dim("  none"));
  for (const finding of report.suspicious) {
    lines.push(`  ${levelColor(c, finding.severity)(finding.severity.padEnd(6, " "))}  ${c.bold(finding.path)}`);
    lines.push(`         ${finding.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatField(change: FieldChange, c: ReturnType<typeof createColors>): string {
  const from = preview(change.from) || "∅";
  const to = preview(change.to) || "∅";
  const note = change.note ? c.dim(`  (${change.note})`) : "";
  if (change.field === "contributes" || change.field === "activationEvents" || change.field === "capabilities") {
    return `${c.dim(change.field.padEnd(24, " "))} ${change.note ?? `${from} → ${to}`}`;
  }
  return `${c.dim(change.field.padEnd(24, " "))} ${from} → ${to}${note}`;
}

function kindGlyph(kind: string, c: ReturnType<typeof createColors>): string {
  if (kind === "added") return c.green("+");
  if (kind === "removed") return c.red("-");
  return c.yellow("~");
}

function levelColor(c: ReturnType<typeof createColors>, level: RiskLevel): (text: string) => string {
  if (level === "high") return c.red;
  if (level === "medium") return c.yellow;
  return c.green;
}

export function renderCheck(report: CheckReport, color: boolean): string {
  const c = createColors(color);
  const lines: string[] = [];
  lines.push(`${c.bold("vsx-diff check")}  ${c.dim(report.minAge ? `cooldown ${report.minAge}` : "no cooldown")}`);
  lines.push(c.dim(report.extensionsDirs.join(", ") || "no extension directories"));
  lines.push("");
  if (report.extensions.length === 0) {
    lines.push("No installed extensions found.");
    lines.push("");
    return lines.join("\n");
  }
  const idWidth = Math.min(48, Math.max(12, ...report.extensions.map((row) => row.id.length)));
  for (const row of report.extensions) {
    const latest = row.latest ?? "—";
    const status = statusLabel(row.status, c);
    const because = row.reasons.length ? c.dim(`  ${row.reasons.join("; ")}`) : "";
    lines.push(`${row.id.padEnd(idWidth, " ")}  ${row.installed.padEnd(14, " ")} → ${latest.padEnd(14, " ")}  ${status}${because}`);
  }
  const counts = countStatuses(report);
  lines.push("");
  lines.push(c.dim(`${counts.allowed} allowed, ${counts.held} held, ${counts.upToDate} up to date, ${counts.unknown + counts.error} unresolved`));
  lines.push("");
  return lines.join("\n");
}

function statusLabel(status: CheckReport["extensions"][number]["status"], c: ReturnType<typeof createColors>): string {
  if (status === "allowed") return c.green("allowed");
  if (status === "held") return c.yellow("held");
  if (status === "up-to-date") return c.dim("up to date");
  if (status === "error") return c.red("error");
  return c.dim("unknown");
}

function countStatuses(report: CheckReport): { allowed: number; held: number; upToDate: number; unknown: number; error: number } {
  const counts = { allowed: 0, held: 0, upToDate: 0, unknown: 0, error: 0 };
  for (const row of report.extensions) {
    if (row.status === "allowed") counts.allowed += 1;
    else if (row.status === "held") counts.held += 1;
    else if (row.status === "up-to-date") counts.upToDate += 1;
    else if (row.status === "error") counts.error += 1;
    else counts.unknown += 1;
  }
  return counts;
}
