import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import type { CheckReport, Runtime, SourcePreference } from "./types.js";
import { createRuntime } from "./runtime.js";
import { renderCheck, renderJson, renderMarkdown, renderTerminal } from "./report.js";
import {
  checkInstalled,
  diffRequest,
  extensionDirsFor,
  pinExtension,
  rollbackExtension,
  resolvePaths,
  setCooldown,
  unpinExtension,
} from "./service.js";
import { UserError, parseRiskLevel, riskAtLeast } from "./util.js";
import type { EditorName } from "./editors.js";

interface CommonOpts {
  config?: string;
  cacheDir?: string;
  source?: string;
  extensionsDir?: string[];
  noDefaultExtensionDirs?: boolean;
  editor?: string;
  timeout?: string;
  color?: boolean;
  forceColor?: boolean;
  preRelease?: boolean;
  from?: string;
  to?: string;
  left?: string;
  right?: string;
  json?: boolean;
  markdown?: boolean;
  failOn?: string;
  refresh?: boolean;
  dryRun?: boolean;
  minAge?: string;
}

function flagsOf(command: Command): CommonOpts {
  return command.optsWithGlobals();
}

function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addCommon(command: Command): Command {
  return command
    .option("--config <path>", "policy file (default: ~/.config/vsx-diff/config.json or $VSX_DIFF_CONFIG)")
    .option("--cache-dir <dir>", "VSIX cache (default: ~/.cache/vsx-diff or $VSX_DIFF_CACHE)")
    .option("--source <source>", "registry: auto, openvsx, or marketplace", "auto")
    .option("--extensions-dir <dir>", "additional directory of installed extensions", collect, [] as string[])
    .option("--no-default-extension-dirs", "do not scan ~/.vscode, ~/.cursor, or ~/.vscode-oss")
    .option("--editor <name>", "editor CLI: auto, code, cursor, or codium", "auto")
    .option("--timeout <ms>", "HTTP timeout in milliseconds", "60000")
    .option("--force-color", "colorize even when stdout is not a terminal")
    .option("--no-color", "disable color")
    .option("--pre-release", "include pre-release versions");
}

function parseSource(value: string | undefined): SourcePreference {
  const source = value ?? "auto";
  if (source === "auto" || source === "openvsx" || source === "marketplace") return source;
  throw new UserError(`--source must be auto, openvsx, or marketplace (got "${source}").`);
}

function parseEditor(value: string | undefined): "auto" | EditorName {
  const editor = value ?? "auto";
  if (editor === "auto" || editor === "code" || editor === "cursor" || editor === "codium") return editor;
  throw new UserError(`--editor must be auto, code, cursor, or codium (got "${editor}").`);
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number(value ?? "60000");
  if (!Number.isFinite(timeout) || timeout < 1) throw new UserError(`Invalid --timeout "${value ?? ""}".`);
  return timeout;
}

function useColor(opts: CommonOpts, runtime: Runtime, machine: boolean): boolean {
  if (machine) return false;
  if (opts.color === false) return false;
  if (opts.forceColor) return true;
  if (runtime.env.NO_COLOR) return false;
  if (runtime.env.FORCE_COLOR && runtime.env.FORCE_COLOR !== "0") return true;
  return process.stdout.isTTY === true;
}

async function commonContext(runtime: Runtime, opts: CommonOpts) {
  const paths = await resolvePaths(runtime.env, opts.config, opts.cacheDir);
  const extensionDirs = extensionDirsFor({
    env: runtime.env,
    flagged: opts.extensionsDir ?? [],
    config: paths.config,
    noDefaults: opts.noDefaultExtensionDirs === true,
  });
  return {
    ...paths,
    extensionDirs,
    source: parseSource(opts.source),
    editor: opts.editor ? parseEditor(opts.editor) : paths.config.editor,
    timeoutMs: parseTimeout(opts.timeout),
    preRelease: opts.preRelease === true,
  };
}

export async function main(argv: string[], partial?: Partial<Runtime>): Promise<number> {
  const runtime = createRuntime(partial);
  let code = 0;
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => runtime.stdout(text),
    writeErr: (text) => runtime.stderr(text),
  });
  program
    .name("vsx-diff")
    .description("Diff a VS Code, Cursor, or VSCodium extension update and score the supply-chain risk.")
    .version(packageVersion());

  addCommon(program)
    .argument("[extensionId]", "publisher.name")
    .option("--from <version>", "base version (default: installed version, otherwise the previous release)")
    .option("--to <version>", "target version (default: latest)")
    .option("--left <vsix>", "older local VSIX, instead of an extension id")
    .option("--right <vsix>", "newer local VSIX")
    .option("--json", "print a JSON report")
    .option("--markdown", "print a Markdown report")
    .option("--fail-on <level>", "exit 1 when risk is at least low, medium, or high")
    .option("--refresh", "ignore the VSIX cache")
    .action(async (extensionId: string | undefined, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      if (!extensionId && !opts.left && !opts.right) {
        program.help();
        return;
      }
      code = await printDiff(runtime, opts, {
        extensionId,
        from: opts.from,
        to: opts.to,
        left: opts.left,
        right: opts.right,
        json: opts.json === true,
        markdown: opts.markdown === true,
        failOn: opts.failOn,
        refresh: opts.refresh === true,
      });
    });

  addCommon(program
    .command("compare")
    .description("Compare two local VSIX files, fully offline")
    .argument("<left>", "older .vsix")
    .argument("<right>", "newer .vsix")
    .option("--json", "print a JSON report")
    .option("--markdown", "print a Markdown report")
    .option("--fail-on <level>", "exit 1 when risk is at least low, medium, or high"))
    .action(async (left: string, right: string, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      code = await printDiff(runtime, opts, {
        left,
        right,
        json: opts.json === true,
        markdown: opts.markdown === true,
        failOn: opts.failOn,
        refresh: false,
      });
    });

  addCommon(program
    .command("pin")
    .description("Remember publisher.name@version and install that VSIX when an editor CLI is available")
    .argument("<spec>", "publisher.name@1.2.3")
    .option("--dry-run", "print the install command without writing policy or calling the editor"))
    .action(async (spec: string, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const result = await pinExtension({
        runtime,
        spec,
        configPath: ctx.configPath,
        config: ctx.config,
        cacheDir: ctx.cacheDir,
        dryRun: opts.dryRun === true,
        editor: ctx.editor,
        source: ctx.source,
        timeoutMs: ctx.timeoutMs,
      });
      runtime.stdout(result.message);
      code = result.exitCode;
    });

  addCommon(program
    .command("unpin")
    .description("Remove a pinned extension version")
    .argument("<extensionId>", "publisher.name"))
    .action(async (extensionId: string, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const result = await unpinExtension(ctx.configPath, ctx.config, extensionId);
      runtime.stdout(result.message);
      code = result.exitCode;
    });

  addCommon(program
    .command("rollback")
    .description("Install an older VSIX with code, cursor, or codium, and pin it")
    .argument("<extensionId>", "publisher.name")
    .option("--to <version>", "version to install (default: the release before the installed one)")
    .option("--dry-run", "print the install command without calling the editor"))
    .action(async (extensionId: string, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const result = await rollbackExtension({
        runtime,
        id: extensionId,
        to: opts.to,
        configPath: ctx.configPath,
        config: ctx.config,
        cacheDir: ctx.cacheDir,
        dryRun: opts.dryRun === true,
        editor: ctx.editor,
        source: ctx.source,
        timeoutMs: ctx.timeoutMs,
        extensionDirs: ctx.extensionDirs,
        preRelease: ctx.preRelease,
      });
      runtime.stdout(result.message);
      code = result.exitCode;
    });

  addCommon(program
    .command("cooldown")
    .description("Require updates to be at least this old (alias of policy set --min-age)")
    .argument("<days>", "7, 7d, 48h, 1w, or 0 to clear")
    .option("--dry-run", "show the change without writing the policy file"))
    .action(async (days: string, _opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const result = await setCooldown({
        runtime,
        value: days,
        configPath: ctx.configPath,
        config: ctx.config,
        dryRun: opts.dryRun === true,
        editor: ctx.editor,
      });
      runtime.stdout(result.message);
      code = result.exitCode;
    });

  const policy = program.command("policy").description("Show or update the local cooldown and pins");
  addCommon(policy
    .command("show")
    .description("Print the policy file"))
    .action(async (_opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      runtime.stdout(`${ctx.configPath}\n${JSON.stringify(ctx.config, null, 2)}\n`);
      code = 0;
    });
  addCommon(policy
    .command("set")
    .description("Set the minimum release age")
    .requiredOption("--min-age <duration>", "7d, 48h, 1w, or 0 to clear")
    .option("--dry-run", "show the change without writing the policy file"))
    .action(async (_opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const result = await setCooldown({
        runtime,
        value: opts.minAge ?? "",
        configPath: ctx.configPath,
        config: ctx.config,
        dryRun: opts.dryRun === true,
        editor: ctx.editor,
      });
      runtime.stdout(result.message);
      code = result.exitCode;
    });

  addCommon(program
    .command("check")
    .description("List installed extensions and say which updates are allowed, pinned, or still in cooldown")
    .option("--json", "print JSON")
    .option("--fail-on <status>", "exit 1 if any row is allowed or held"))
    .action(async (_opts: CommonOpts, command: Command) => {
      const opts = flagsOf(command);
      const ctx = await commonContext(runtime, opts);
      const report = await checkInstalled({
        runtime,
        extensionDirs: ctx.extensionDirs,
        source: ctx.source,
        config: ctx.config,
        timeoutMs: ctx.timeoutMs,
        preRelease: ctx.preRelease,
      });
      runtime.stdout(opts.json ? renderJson(report) : renderCheck(report, useColor(opts, runtime, false)));
      code = checkExit(report, opts.failOn);
    });

  program.addHelpText("after", `
Examples:
  $ vsx-diff EditorConfig.EditorConfig
  $ vsx-diff EditorConfig.EditorConfig --from 0.16.6 --to 0.18.2
  $ vsx-diff compare old.vsix new.vsix --fail-on high
  $ vsx-diff --left old.vsix --right new.vsix --markdown
  $ vsx-diff pin publisher.name@1.2.3 --dry-run
  $ vsx-diff cooldown 7
  $ vsx-diff policy set --min-age 7d
  $ vsx-diff check
`);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    runtime.stderr(`${message}\n`);
    return error instanceof UserError ? error.exitCode : 2;
  }
  return code;
}

async function printDiff(
  runtime: Runtime,
  opts: CommonOpts,
  diff: {
    extensionId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    left?: string | undefined;
    right?: string | undefined;
    json: boolean;
    markdown: boolean;
    failOn?: string | undefined;
    refresh: boolean;
  },
): Promise<number> {
  if (diff.json && diff.markdown) throw new UserError("Pass only one of --json or --markdown.");
  const ctx = await commonContext(runtime, opts);
  const report = await diffRequest({
    runtime,
    extensionId: diff.extensionId,
    from: diff.from,
    to: diff.to,
    left: diff.left,
    right: diff.right,
    source: ctx.source,
    cacheDir: ctx.cacheDir,
    extensionDirs: ctx.extensionDirs,
    refresh: diff.refresh,
    preRelease: ctx.preRelease,
    timeoutMs: ctx.timeoutMs,
  });
  if (diff.json) runtime.stdout(renderJson(report));
  else if (diff.markdown) runtime.stdout(renderMarkdown(report));
  else runtime.stdout(renderTerminal(report, useColor(opts, runtime, false)));
  if (!diff.failOn) return 0;
  return riskAtLeast(report.risk.level, parseRiskLevel(diff.failOn)) ? 1 : 0;
}

function checkExit(report: CheckReport, failOn: string | undefined): number {
  if (!failOn) return 0;
  const status = failOn.toLowerCase();
  if (status !== "allowed" && status !== "held") {
    throw new UserError(`check --fail-on must be allowed or held (got "${failOn}").`);
  }
  return report.extensions.some((row) => row.status === status) ? 1 : 0;
}
