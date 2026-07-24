import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type RoutingConfig, RoutingConfigSchema } from "./schemas.js";

const here = dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  // dist/config -> package root; src/config -> package root
  const candidates = [join(here, "../.."), join(here, "../../..")];
  for (const c of candidates) {
    try {
      readFileSync(join(c, "package.json"), "utf8");
      return c;
    } catch {
      /* try next */
    }
  }
  return join(here, "../..");
}

export function loadDefaultRoutingConfig(): RoutingConfig {
  const path = join(packageRoot(), "config", "routing.default.yaml");
  const raw = parseYaml(readFileSync(path, "utf8"));
  return RoutingConfigSchema.parse(raw);
}

export function seedModelsPath(): string {
  return join(packageRoot(), "config", "models.seed.json");
}

export function seedDealsPath(): string {
  return join(packageRoot(), "config", "deals.seed.json");
}
