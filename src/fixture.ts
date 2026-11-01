import { packVsix } from "./unpack.js";

/**
 * Offline demo pair. The IP is RFC 5737 documentation space (203.0.113.0/24),
 * not a live host. The package is a toy, not a copy of any real incident.
 */
function randomBlob(size: number, seed = 0x6d2b79f5): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const cleanExtension = `"use strict";
function activate() {
  return { hello: "world" };
}
function deactivate() {}
module.exports = { activate, deactivate };
`;

const maliciousExtension = `"use strict";
const { execFile } = require("child_process");
function activate() {
  eval("1+1");
  const dynamic = new Function("return 1");
  dynamic();
  execFile("uname", [], function () {});
  const endpoint = "http://203.0.113.10/stage";
  return { endpoint };
}
function deactivate() {}
module.exports = { activate, deactivate };
`;

export function cleanFixtureFiles(): Record<string, Uint8Array | string> {
  return {
    "package.json": JSON.stringify(
      {
        name: "hello",
        publisher: "goodpub",
        version: "1.0.0",
        description: "A quiet demo extension.",
        activationEvents: ["onCommand:goodpub.hello"],
        main: "./extension.js",
        contributes: {
          commands: [{ command: "goodpub.hello", title: "Hello" }],
        },
        capabilities: {
          untrustedWorkspaces: { supported: false },
        },
        dependencies: { "left-pad": "1.0.0" },
        scripts: { "vscode:prepublish": "tsc -p ./" },
      },
      null,
      2,
    ),
    "extension.js": cleanExtension,
    "README.md": "Hello from the clean fixture.\n",
  };
}

export function maliciousFixtureFiles(): Record<string, Uint8Array | string> {
  const native = new Uint8Array(64);
  native.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  return {
    "package.json": JSON.stringify(
      {
        name: "hello",
        publisher: "evilpub",
        version: "1.1.0",
        description: "A quiet demo extension.",
        activationEvents: ["*"],
        main: "./extension.js",
        contributes: {
          commands: [
            { command: "goodpub.hello", title: "Hello" },
            { command: "evilpub.collect", title: "Collect" },
          ],
        },
        capabilities: {
          untrustedWorkspaces: { supported: true },
        },
        dependencies: { "left-pad": "1.0.0", "evil-lib": "9.9.9" },
        scripts: {
          "vscode:prepublish": "tsc -p ./",
          postinstall: "node payload.js",
        },
        extensionDependencies: ["evilpub.helper"],
      },
      null,
      2,
    ),
    "extension.js": maliciousExtension,
    "README.md": "Hello from the malicious fixture.\n",
    "payload.bin": randomBlob(1024),
    "native.node": native,
  };
}

export function benignBumpFiles(): Record<string, Uint8Array | string> {
  const files = cleanFixtureFiles();
  const manifest = JSON.parse(String(files["package.json"])) as {
    version: string;
    dependencies: Record<string, string>;
  };
  manifest.version = "1.0.1";
  manifest.dependencies["left-pad"] = "1.0.1";
  files["package.json"] = JSON.stringify(manifest, null, 2);
  files["README.md"] = "Hello from the clean fixture.\nA small readme edit.\n";
  return files;
}

export function maliciousPair(): { from: Uint8Array; to: Uint8Array } {
  return {
    from: packVsix(cleanFixtureFiles()),
    to: packVsix(maliciousFixtureFiles()),
  };
}

export function benignPair(): { from: Uint8Array; to: Uint8Array } {
  return {
    from: packVsix(cleanFixtureFiles()),
    to: packVsix(benignBumpFiles()),
  };
}
