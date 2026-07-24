import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../config/loader.js";
import type { TelemetryEvent } from "../domain/telemetry.js";
import { redactText } from "./redact.js";

export function appendTelemetry(path: string, event: TelemetryEvent): void {
  const full = expandHome(path);
  mkdirSync(dirname(full), { recursive: true });
  const line = JSON.stringify({
    ...event,
    meta: event.meta
      ? Object.fromEntries(
          Object.entries(event.meta).map(([k, v]) => [
            k,
            typeof v === "string" ? redactText(v) : v,
          ]),
        )
      : undefined,
  });
  appendFileSync(full, `${line}\n`, "utf8");
}

export function readTelemetryEvents(path: string, limit = 10_000): TelemetryEvent[] {
  const full = expandHome(path);
  if (!existsSync(full)) return [];
  const lines = readFileSync(full, "utf8").split("\n").filter(Boolean);
  const slice = lines.slice(-limit);
  const out: TelemetryEvent[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as TelemetryEvent);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}
