import { spawnSync } from "node:child_process";
import type { Runtime } from "./types.js";

export function createRuntime(partial?: Partial<Runtime>): Runtime {
  const base: Runtime = {
    stdout(chunk) {
      process.stdout.write(chunk);
    },
    stderr(chunk) {
      process.stderr.write(chunk);
    },
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    spawn(cmd, args, env) {
      const result = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 120_000 });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: `${result.stderr ?? ""}${result.error ? result.error.message : ""}`,
      };
    },
  };
  return {
    stdout: partial?.stdout ?? base.stdout,
    stderr: partial?.stderr ?? base.stderr,
    env: partial?.env ?? base.env,
    fetch: partial?.fetch ?? base.fetch,
    spawn: partial?.spawn ?? base.spawn,
  };
}
