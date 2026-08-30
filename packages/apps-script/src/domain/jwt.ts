export interface HmacSigner {
  signSha256(data: string, keyBytes: number[]): number[];
}

export function createGhostAdminJwt(
  adminApiKey: string,
  nowSeconds: number,
  signer: HmacSigner,
  ttlSeconds = 240,
): string {
  const separator = adminApiKey.indexOf(":");
  if (separator <= 0 || separator === adminApiKey.length - 1) throw new Error("INVALID_GHOST_ADMIN_API_KEY");
  if (ttlSeconds <= 0 || ttlSeconds > 300) throw new Error("GHOST_JWT_TTL_MUST_BE_AT_MOST_300_SECONDS");

  const keyId = adminApiKey.slice(0, separator);
  const secretHex = adminApiKey.slice(separator + 1);
  const secretBytes = hexToBytes(secretHex);
  const header = base64UrlUtf8(JSON.stringify({ alg: "HS256", typ: "JWT", kid: keyId }));
  const payload = base64UrlUtf8(
    JSON.stringify({ iat: Math.floor(nowSeconds), exp: Math.floor(nowSeconds) + ttlSeconds, aud: "/admin/" }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64UrlBytes(signer.signSha256(signingInput, secretBytes));
  return `${signingInput}.${signature}`;
}

export function hexToBytes(hex: string): number[] {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("INVALID_HEX_SECRET");
  const bytes: number[] = [];
  for (let offset = 0; offset < hex.length; offset += 2) bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
  return bytes;
}

export function base64UrlUtf8(value: string): string {
  return base64UrlBytes(utf8Bytes(value));
}

export function base64UrlBytes(bytes: number[]): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const combined = (a << 16) | (b << 8) | c;
    output += alphabet[(combined >> 18) & 63];
    output += alphabet[(combined >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(combined >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[combined & 63] : "=";
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}
