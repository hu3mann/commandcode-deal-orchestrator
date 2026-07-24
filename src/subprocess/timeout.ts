export function withTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  return {
    signal: c.signal,
    clear: () => clearTimeout(t),
  };
}
