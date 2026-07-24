const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /bearer\s+[a-z0-9._-]+/gi,
  /sk-[a-z0-9]{10,}/gi,
  /xai-[a-z0-9]{10,}/gi,
  /password\s*[:=]\s*\S+/gi,
];

export function redactText(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function hashPath(p: string): string {
  // store paths as-is but never file contents
  return p;
}
