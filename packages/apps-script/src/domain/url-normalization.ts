/** Normalize the configured Ghost Admin base URL without making a request. */
export function normalizeGhostAdminUrl(input: string): string {
  const value = input.trim();
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/iu.exec(value);
  if (!match) throw new Error("GHOST_ADMIN_URL_MUST_USE_HTTPS");
  const rawHost = match[1] ?? "";
  if (!rawHost || /[@\s]/u.test(rawHost)) throw new Error("GHOST_ADMIN_URL_INVALID_HOST");
  const host = rawHost.toLowerCase().replace(/:443$/u, "");
  const path = (match[2] ?? "").replace(/\/+$/u, "");
  return `https://${host}${path}`;
}
