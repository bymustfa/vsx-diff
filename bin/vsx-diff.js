#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
