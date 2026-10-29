/**
 * Canonical public base-URL resolution for generated links, OAuth callback
 * URLs, webhook URLs shown in admin screens, and origin-dependent sends.
 *
 * One deterministic precedence for every caller:
 *   1. NEXT_PUBLIC_APP_URL — the declared public URL of the deployment.
 *   2. AUTH_URL — NextAuth canonical URL; frequently set to the same value.
 *   3. RENDER_EXTERNAL_URL — injected by Render; bare hostnames get https://.
 *   4. VERCEL_URL — legacy platform signal; bare hostname gets https://.
 *
 * Values are normalized to a bare origin (scheme enforced, path/trailing
 * slash stripped). A loopback address only wins when it is the ONLY
 * candidate — a stale localhost AUTH_URL must not poison callback or webhook
 * URLs on a deployed service (H4). An unset/invalid env simply yields null;
 * callers fail closed and tell the operator which variable to set.
 */

export const PUBLIC_BASE_URL_ENV_ORDER = [
  "NEXT_PUBLIC_APP_URL",
  "AUTH_URL",
  "RENDER_EXTERNAL_URL",
  "VERCEL_URL",
] as const;

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * Accepts "https://app.example", "app.example" and "http://localhost:3000";
 * returns a clean origin or null when the value cannot produce an http(s) URL.
 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  // An explicit non-http(s) scheme ("ftp://", "javascript:") is garbage, not
  // a bare hostname — never prefix-upgrade it into a URL.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolvePublicBaseUrl(
  env: Record<string, string | undefined>
): string | null {
  const candidates = PUBLIC_BASE_URL_ENV_ORDER.map((key) =>
    normalizeBaseUrl(env[key])
  ).filter((origin): origin is string => origin !== null);
  const nonLoopback = candidates.filter(
    (origin) => !isLoopback(new URL(origin))
  );
  return nonLoopback[0] ?? candidates[0] ?? null;
}

/** Runtime resolver — reads process.env. Returns null when nothing is set. */
export function publicBaseUrl(): string | null {
  return resolvePublicBaseUrl(process.env);
}
