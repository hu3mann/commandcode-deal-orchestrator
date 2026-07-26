import type { FailureCause } from "./types.js";

export class ModRouteError extends Error {
  readonly code: string;
  readonly causeKind: FailureCause;

  constructor(message: string, causeKind: FailureCause = "unknown", code = "MOD_ROUTE_ERROR") {
    super(message);
    this.name = "ModRouteError";
    this.code = code;
    this.causeKind = causeKind;
  }
}

export function formatRouteWarning(cause: FailureCause, detail?: string): string {
  const base = {
    timeout: "ccroute route timed out; keeping current session model",
    inventory: "ccroute route failed (model inventory); keeping current session model",
    pricing: "ccroute route failed (pricing/deals); keeping current session model",
    compatibility: "ccroute Mod compatibility issue; automatic routing disabled",
    malformed_json: "ccroute returned malformed route JSON; keeping current session model",
    unavailable_override: "explicit model override unavailable; refusing switch",
    no_eligible_route: "no eligible route; keeping current session model",
    spawn: "could not invoke ccroute decide; keeping current session model",
    unknown: "ccroute route failed; keeping current session model",
  }[cause];
  return detail ? `${base} (${detail})` : base;
}
