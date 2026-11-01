import { mkdirSync, writeFileSync } from "node:fs";
import { maliciousPair } from "../dist/fixture.js";

const pair = maliciousPair();
mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("./fixtures/goodpub.hello-1.0.0.vsix", import.meta.url), pair.from);
writeFileSync(new URL("./fixtures/evilpub.hello-1.1.0.vsix", import.meta.url), pair.to);
process.stdout.write("wrote demo/fixtures/goodpub.hello-1.0.0.vsix and evilpub.hello-1.1.0.vsix\n");
