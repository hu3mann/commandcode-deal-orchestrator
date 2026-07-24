import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cli = join(process.cwd(), "dist", "cli.js");
if (!existsSync(cli)) {
  process.exit(0);
}
const raw = readFileSync(cli, "utf8");
if (!raw.startsWith("#!")) {
  writeFileSync(cli, `#!/usr/bin/env node\n${raw}`);
}
chmodSync(cli, 0o755);
