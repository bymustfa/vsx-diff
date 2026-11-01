import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "bin/vsx-diff.js",
  "compare",
  "demo/fixtures/goodpub.hello-1.0.0.vsix",
  "demo/fixtures/evilpub.hello-1.1.0.vsix",
  "--no-color",
], { encoding: "utf8" });

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);

const required = [
  "HIGH",
  "evilpub",
  "postinstall",
  "activationEvents",
  "203.0.113.10",
  "native.node",
  "payload.bin",
];
for (const bit of required) {
  if (!result.stdout.includes(bit)) {
    process.stderr.write(`demo output missing ${bit}\n`);
    process.exit(1);
  }
}
