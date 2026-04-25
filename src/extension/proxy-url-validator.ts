/**
 * Validates proxy-related URLs before fetch() to reduce SSRF risk from hostile config.
 *
 * @module extension/proxy-url-validator
 */

export class ProxyUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyUrlValidationError";
  }
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) {
      return false;
    }
    const n = Number.parseInt(p, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) {
      return false;
    }
    octets.push(n);
  }
  const [a, b] = octets;
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === 127) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) {
    return true;
  }
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const h = host.split("%")[0]?.toLowerCase() ?? host.toLowerCase();
  if (h === "::1") {
    return true;
  }
  if (h.startsWith("fe80:")) {
    return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd")) {
    return true;
  }
  return false;
}

/** Hostname without `[` `]` so IPv6 literals match the same rules across runtimes. */
function hostForValidation(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Throws if the URL is not safe to fetch as a proxy or API base (scheme, host, private ranges).
 */
export function assertSafeProxyUrl(
  raw: string,
  options?: { allowPrivateNetworks?: boolean },
): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyUrlValidationError(`Invalid proxy URL: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProxyUrlValidationError(
      `Unsupported proxy URL scheme: ${url.protocol} - only https: and http: are allowed`,
    );
  }

  const hostname = url.hostname;
  if (hostname.length === 0) {
    throw new ProxyUrlValidationError(`Proxy URL has no hostname: ${raw}`);
  }

  if (options?.allowPrivateNetworks === true) {
    return;
  }

  const host = hostForValidation(hostname);

  if (host.toLowerCase() === "localhost") {
    throw new ProxyUrlValidationError(
      `Proxy URL points to a private/reserved network address: ${url.hostname}`,
    );
  }

  if (host.includes(":")) {
    if (isBlockedIpv6(host)) {
      throw new ProxyUrlValidationError(
        `Proxy URL points to a private/reserved network address: ${url.hostname}`,
      );
    }
    return;
  }

  if (isPrivateOrReservedIpv4(host)) {
    throw new ProxyUrlValidationError(
      `Proxy URL points to a private/reserved network address: ${url.hostname}`,
    );
  }
}
