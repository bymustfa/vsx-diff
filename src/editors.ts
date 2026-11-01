import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Runtime } from "./types.js";

export const EDITOR_BINARIES = ["cursor", "code", "codium"] as const;
export type EditorName = (typeof EDITOR_BINARIES)[number];

export interface EditorCli {
  name: EditorName;
  path: string;
}

export async function findEditor(
  preference: "auto" | EditorName,
  env: NodeJS.ProcessEnv,
): Promise<EditorCli | null> {
  const names: EditorName[] = preference === "auto" ? [...EDITOR_BINARIES] : [preference];
  for (const name of names) {
    const found = await findOnPath(name, env);
    if (found) return { name, path: found };
  }
  return null;
}

async function findOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try the next directory
      }
    }
  }
  return null;
}

export function installCommand(editor: EditorCli, vsixPath: string): { bin: string; args: string[]; display: string } {
  const args = ["--install-extension", vsixPath, "--force"];
  return {
    bin: editor.path,
    args,
    display: `${editor.name} --install-extension ${vsixPath} --force`,
  };
}

export function runInstall(runtime: Runtime, editor: EditorCli, vsixPath: string): { ok: boolean; detail: string; display: string } {
  const command = installCommand(editor, vsixPath);
  const result = runtime.spawn(command.bin, command.args, runtime.env);
  const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return {
    ok: result.status === 0,
    detail: detail || `editor CLI exited ${result.status ?? "unknown"}`,
    display: command.display,
  };
}

export function missingEditorMessage(): string {
  return "No editor CLI found on PATH (looked for cursor, code, and codium).";
}
