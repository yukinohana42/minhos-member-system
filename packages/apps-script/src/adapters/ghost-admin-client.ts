import { createGhostAdminJwt, type HmacSigner } from "../domain/jwt";
import { executeGetWithRetry, parseJson, queryString, type HttpTransport } from "../domain/http";
import { nextGhostPage } from "../domain/ghost-pagination";
import { validateGhostMembersPage } from "../domain/ghost-runtime-validation";
import type { GhostMembersPage } from "../domain/types";

export class GhostAdminClient {
  constructor(
    private readonly options: {
      adminUrl: string;
      adminApiKey: string;
      acceptVersion: string;
      transport: HttpTransport;
      signer: HmacSigner;
      retryRuntime: { sleep(ms: number): void; random(): number };
      nowSeconds: () => number;
    },
  ) {}

  getMembersPage(page: number): GhostMembersPage {
    const query = queryString({ limit: 100, include: "tiers,subscriptions", page });
    const response = executeGetWithRetry(
      {
        method: "get",
        url: `${this.options.adminUrl}/ghost/api/admin/members/?${query}`,
        headers: {
          Authorization: `Ghost ${createGhostAdminJwt(
            this.options.adminApiKey,
            this.options.nowSeconds(),
            this.options.signer,
          )}`,
          "Accept-Version": this.options.acceptVersion,
          Accept: "application/json",
        },
      },
      this.options.transport,
      this.options.retryRuntime,
    );
    const result = parseJson<unknown>(response, "ghost_members");
    validateGhostMembersPage(result);
    // Validate before returning so callers cannot persist a partial page and
    // accidentally treat it as a complete scan.
    nextGhostPage(result, page);
    return result;
  }
}
