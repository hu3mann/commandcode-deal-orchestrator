/**
 * Router control markers for the interactive Mod path.
 * Markers are stripped from the forwarded prompt (explicitly removable).
 * Classification/routing uses a cleaned copy without control markers.
 */

export type RoutingProfile = "cheapest" | "balanced" | "frontier";

export interface ParsedMarkers {
  /** Prompt with supported router control markers removed. */
  cleaned: string;
  /** Copy used only for route decision text (markers removed). */
  routingText: string;
  routeOff: boolean;
  routeOn: boolean;
  profile: RoutingProfile | null;
  modelOverride: string | null;
  /** True when any supported marker was present. */
  hadMarkers: boolean;
}

const MARKER_RE = /(?:^|\s)!(route-off|route-on|cheap|balanced|frontier|model=([^\s]+))(?=\s|$)/gi;

export function parseRouterMarkers(text: string): ParsedMarkers {
  let routeOff = false;
  let routeOn = false;
  let profile: RoutingProfile | null = null;
  let modelOverride: string | null = null;
  let hadMarkers = false;

  const cleaned = text
    .replace(MARKER_RE, (_full, token: string, modelId?: string) => {
      hadMarkers = true;
      const t = String(token).toLowerCase();
      if (t === "route-off") routeOff = true;
      else if (t === "route-on") routeOn = true;
      else if (t === "cheap") profile = "cheapest";
      else if (t === "balanced") profile = "balanced";
      else if (t === "frontier") profile = "frontier";
      else if (t.startsWith("model=") && modelId) modelOverride = modelId;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleaned,
    routingText: cleaned,
    routeOff,
    routeOn,
    profile,
    modelOverride,
    hadMarkers,
  };
}

/** Whether automatic routing should run for this prompt given session + markers. */
export function shouldAutoRoute(sessionEnabled: boolean, markers: ParsedMarkers): boolean {
  if (markers.routeOff) return false;
  if (markers.routeOn) return true;
  return sessionEnabled;
}
