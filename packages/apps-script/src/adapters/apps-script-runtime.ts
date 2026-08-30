import type { HmacSigner } from "../domain/jwt";
import type { HttpRequest, HttpResponse, HttpTransport } from "../domain/http";

export class AppsScriptHttpTransport implements HttpTransport {
  fetch(request: HttpRequest): HttpResponse {
    if (request.method !== "get") throw new Error("READ_ONLY_CLIENT_REJECTED_NON_GET");
    const response = UrlFetchApp.fetch(request.url, {
      method: "get",
      headers: request.headers ?? {},
      followRedirects: true,
      muteHttpExceptions: true,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.getAllHeaders())) headers[key] = String(value);
    return {
      status: response.getResponseCode(),
      body: response.getContentText(),
      headers,
    };
  }
}

export class AppsScriptHmacSigner implements HmacSigner {
  signSha256(data: string, keyBytes: number[]): number[] {
    return Utilities.computeHmacSha256Signature(
      Utilities.newBlob(data).getBytes(),
      keyBytes.map(toSignedByte),
    ).map(toUnsignedByte);
  }
}

export const appsScriptRetryRuntime = {
  sleep(ms: number): void {
    Utilities.sleep(ms);
  },
  random(): number {
    return Math.random();
  },
};

function toSignedByte(value: number): number {
  return value > 127 ? value - 256 : value;
}

function toUnsignedByte(value: number): number {
  return value < 0 ? value + 256 : value;
}
