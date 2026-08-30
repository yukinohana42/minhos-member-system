import { describe, expect, it } from "vitest";
import { GhostAdminClient } from "../src/adapters/ghost-admin-client";
import { StripeReadOnlyClient } from "../src/adapters/stripe-client";
import { executeGetWithRetry, HttpBudgetExceeded, HttpFailure, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/domain/http";
import { createGhostAdminJwt } from "../src/domain/jwt";
import { backupPolicy, backupSpreadsheet, planBackupDeletions, shouldRetainBackup } from "../src/adapters/backup";

describe("read-only API contracts", () => {
  it("always requests Stripe subscriptions with status=all and cursor pagination using GET", () => {
    const transport = new QueueTransport([
      { status: 200, body: JSON.stringify({ object: "list", data: [], has_more: false }), headers: {} },
      { status: 200, body: JSON.stringify({ object: "list", data: [], has_more: false }), headers: {} },
    ]);
    const client = new StripeReadOnlyClient({
      restrictedKey: "restricted-placeholder",
      apiVersion: "fixed-version",
      transport,
      retryRuntime: noWait,
    });
    client.listSubscriptions("sub_previous");
    client.listOpenInvoices("in_previous");
    const subscriptionRequest = transport.requests[0]!;
    expect(subscriptionRequest.method).toBe("get");
    expect(subscriptionRequest.url).toContain("status=all");
    expect(subscriptionRequest.url).toContain("starting_after=sub_previous");
    expect(subscriptionRequest.url).toContain("expand%5B%5D=data.latest_invoice");
    expect(subscriptionRequest.url).not.toContain("price.product");
    expect(subscriptionRequest.headers?.["Stripe-Version"]).toBe("fixed-version");
    expect(transport.requests[1]?.url).toContain("status=open");
  });

  it("scans the complete Dispute history once, then supports a watermarked scan", () => {
    const transport = new QueueTransport([
      { status: 200, body: JSON.stringify({ object: "list", data: [], has_more: false }), headers: {} },
      { status: 200, body: JSON.stringify({ object: "list", data: [], has_more: false }), headers: {} },
    ]);
    const client = stripeClient(transport);
    client.listDisputes(undefined, "dp_previous");
    client.listDisputes(1_700_000_000, "dp_recent");
    expect(transport.requests[0]?.url).not.toContain("created%5Bgte%5D");
    expect(transport.requests[0]?.url).toContain("starting_after=dp_previous");
    expect(transport.requests[1]?.url).toContain("created%5Bgte%5D=1700000000");
  });

  it("rejects malformed Stripe endpoint payloads before nested IDs/status/items reach mappers", () => {
    const invalidSubscriptions = [
      subscriptionPayload({ status: "future_status" }),
      subscriptionPayload({ items: { data: [] } }),
      subscriptionPayload({ items: { data: [{ price: { id: "price", product: "" } }] } }),
      subscriptionPayload({ latest_invoice: "in_unexpanded" }),
    ];
    for (const item of invalidSubscriptions) {
      const transport = new QueueTransport([{
        status: 200, body: JSON.stringify({ object: "list", data: [item], has_more: false }), headers: {},
      }]);
      const client = stripeClient(transport);
      expect(() => client.listSubscriptions()).toThrow(/SCHEMA_MISMATCH:stripe_subscription/);
    }

    const invalidObjects: Array<{ body: Record<string, unknown>; invoke: (client: StripeReadOnlyClient) => unknown }> = [
      {
        body: { id: "in_1", status: "open", customer: "cus_1", payment_intent: { id: "" } },
        invoke: (client) => client.retrieveInvoice("in_1"),
      },
      {
        body: { id: "re_1", status: "succeeded", amount: 100, currency: "jpy", charge: { id: "" } },
        invoke: (client) => client.retrieveRefund("re_1"),
      },
      {
        body: {
          id: "re_2", status: "succeeded", amount: 100, currency: "jpy",
          charge: { id: "ch_1", amount: 100 },
        },
        invoke: (client) => client.retrieveRefund("re_2"),
      },
      {
        body: { id: "price_1" },
        invoke: (client) => client.retrievePrice("price_1"),
      },
    ];
    for (const testCase of invalidObjects) {
      const transport = new QueueTransport([{ status: 200, body: JSON.stringify(testCase.body), headers: {} }]);
      expect(() => testCase.invoke(stripeClient(transport))).toThrow(/SCHEMA_MISMATCH:stripe_/);
    }
  });

  it("paginates Ghost members by page with include=tiers,subscriptions and a short-lived JWT", () => {
    const transport = new QueueTransport([
      { status: 200, body: JSON.stringify({ members: [], meta: { pagination: { page: 2, pages: 2, next: null } } }), headers: {} },
    ]);
    const client = new GhostAdminClient({
      adminUrl: "https://example.invalid",
      adminApiKey: ["EXAMPLE", "00112233"].join(":"),
      acceptVersion: "v5.0",
      transport,
      signer: { signSha256: () => [1, 2, 3] },
      retryRuntime: noWait,
      nowSeconds: () => 1000,
    });
    client.getMembersPage(2);
    expect(transport.requests[0]?.method).toBe("get");
    expect(transport.requests[0]?.url).toContain("page=2");
    expect(transport.requests[0]?.url).toContain("include=tiers%2Csubscriptions");
    expect(transport.requests[0]?.headers?.["Accept-Version"]).toBe("v5.0");
  });

  it("stops a Ghost scan when pagination metadata is missing or corrupt", () => {
    for (const body of [
      { members: [] },
      { members: [], meta: { pagination: { page: 1, pages: 2, next: null } } },
      { members: [], meta: { pagination: { page: 2, pages: 1, next: null } } },
    ]) {
      const transport = new QueueTransport([{ status: 200, body: JSON.stringify(body), headers: {} }]);
      const client = new GhostAdminClient({
        adminUrl: "https://example.invalid",
        adminApiKey: ["EXAMPLE", "00112233"].join(":"),
        acceptVersion: "v5.0",
        transport,
        signer: { signSha256: () => [1, 2, 3] },
        retryRuntime: noWait,
        nowSeconds: () => 1000,
      });
      expect(() => client.getMembersPage(1)).toThrow(/SCHEMA_MISMATCH:ghost_members\.meta\.pagination/);
    }
  });

  it("fails closed on malformed nested Ghost member/tier/subscription/customer shapes", () => {
    const baseMember = {
      id: "member_1", email: "member@example.invalid", status: "paid", comped: false,
      tiers: [{ id: "tier_1", name: "Tier" }], subscriptions: [],
    };
    const invalidMembers = [
      { ...baseMember, status: "future" },
      { ...baseMember, tiers: [{ name: "missing id" }] },
      { ...baseMember, subscriptions: [{ id: "sub_1", status: "active", customer: "cus_1", price: { id: "price_1" } }] },
      { ...baseMember, subscriptions: [{ id: "sub_1", status: "active", customer: { id: "cus_1" }, price: { id: "price_1" } }] },
      { ...baseMember, subscriptions: [{ id: "", status: "active", type: "gift" }] },
      { ...baseMember, subscriptions: [{ id: "", status: "active", customer: { id: "" }, type: "regular" }] },
    ];
    for (const member of invalidMembers) {
      const transport = new QueueTransport([{
        status: 200,
        body: JSON.stringify({ members: [member], meta: { pagination: { page: 1, pages: 1, next: null } } }),
        headers: {},
      }]);
      expect(() => ghostClient(transport).getMembersPage(1)).toThrow(/SCHEMA_MISMATCH:ghost_members\.members\.0/);
    }

    const allowedSynthetic = {
      ...baseMember,
      status: "comped",
      comped: true,
      subscriptions: [{
        id: "", status: "active", customer: { id: "", name: null, email: null },
        price: { id: "", price_id: "", nickname: "Complimentary" },
      }],
    };
    const transport = new QueueTransport([{
      status: 200,
      body: JSON.stringify({ members: [allowedSynthetic], meta: { pagination: { page: 1, pages: 1, next: null } } }),
      headers: {},
    }]);
    expect(ghostClient(transport).getMembersPage(1).members[0]?.id).toBe("member_1");
  });

  it("honors Retry-After on 429, retries 5xx/timeout, and stops immediately on 401", () => {
    const waits: number[] = [];
    const retrying = new QueueTransport([
      { status: 429, body: "{}", headers: { "Retry-After": "2" } },
      { status: 500, body: "{}", headers: {} },
      { status: 200, body: "{}", headers: {} },
    ]);
    const response = executeGetWithRetry(
      { method: "get", url: "https://example.invalid" },
      retrying,
      { sleep: (ms) => waits.push(ms), random: () => 0 },
    );
    expect(response.status).toBe(200);
    expect(waits).toEqual([2000, 1000]);

    const denied = new QueueTransport([{ status: 401, body: "{}", headers: {} }]);
    expect(() => executeGetWithRetry({ method: "get", url: "https://example.invalid" }, denied, noWait)).toThrow(HttpFailure);
    expect(denied.requests).toHaveLength(1);
  });

  it("yields without sleeping when Retry-After exceeds the remaining runtime budget", () => {
    const waits: number[] = [];
    const transport = new QueueTransport([{ status: 429, body: "{}", headers: { "Retry-After": "60" } }]);
    expect(() => executeGetWithRetry(
      { method: "get", url: "https://example.invalid" },
      transport,
      { sleep: (ms) => waits.push(ms), random: () => 0, remainingMs: () => 20_000 },
    )).toThrow(HttpBudgetExceeded);
    expect(waits).toEqual([]);
    expect(transport.requests).toHaveLength(1);
  });

  it("creates HS256 Ghost claims with aud=/admin/ and expiry within five minutes", () => {
    const token = createGhostAdminJwt("kid:00112233", 1000, { signSha256: () => [1, 2, 3] });
    const [headerPart, payloadPart, signature] = token.split(".");
    const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: "HS256", typ: "JWT", kid: "kid" });
    expect(payload).toMatchObject({ iat: 1000, exp: 1240, aud: "/admin/" });
    expect(signature).toBe("AQID");
    expect(() => createGhostAdminJwt("kid:00112233", 1000, { signSha256: () => [] }, 301)).toThrow(/300/);
  });

  it("applies the 35-day backup retention boundary", () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    expect(shouldRetainBackup(new Date("2026-07-24T00:00:00.000Z"), now)).toBe(true);
    expect(shouldRetainBackup(new Date("2026-07-23T23:59:59.999Z"), now)).toBe(false);
  });

  it("validates backup retention and protects minimum generations with a deletion cap", () => {
    expect(() => backupPolicy("daily", 0)).toThrow("BACKUP_RETENTION_DAYS_OUT_OF_SAFE_RANGE");
    expect(() => backupPolicy("monthly", 35.5)).toThrow("BACKUP_RETENTION_DAYS_OUT_OF_SAFE_RANGE");
    expect(() => backupPolicy("daily", 3651)).toThrow("BACKUP_RETENTION_DAYS_OUT_OF_SAFE_RANGE");
    expect(() => backupSpreadsheet({
      spreadsheetId: "never-read", backupFolderId: "never-read", retentionDays: 0, kind: "daily", now: new Date(),
    })).toThrow("BACKUP_RETENTION_DAYS_OUT_OF_SAFE_RANGE");

    const now = new Date("2026-08-28T00:00:00.000Z");
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      id: `backup_${index}`,
      createdAt: new Date(now.getTime() - index * 40 * 86_400_000),
    }));
    const daily = planBackupDeletions(candidates, now, backupPolicy("daily", 35));
    const monthly = planBackupDeletions(candidates, now, backupPolicy("monthly", 35));
    expect(daily).toHaveLength(10);
    expect(daily).not.toContain("backup_0");
    expect(daily).not.toContain("backup_6");
    expect(monthly).toHaveLength(2);
    expect(monthly).not.toContain("backup_2");
  });
});

const noWait = { sleep: (_ms: number) => undefined, random: () => 0 };

class QueueTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: HttpResponse[]) {}

  fetch(request: HttpRequest): HttpResponse {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No queued response");
    return response;
  }
}

function stripeClient(transport: HttpTransport): StripeReadOnlyClient {
  return new StripeReadOnlyClient({
    restrictedKey: "restricted-placeholder",
    apiVersion: "fixed-version",
    transport,
    retryRuntime: noWait,
  });
}

function ghostClient(transport: HttpTransport): GhostAdminClient {
  return new GhostAdminClient({
    adminUrl: "https://example.invalid",
    adminApiKey: ["EXAMPLE", "00112233"].join(":"),
    acceptVersion: "v5.0",
    transport,
    signer: { signSha256: () => [1, 2, 3] },
    retryRuntime: noWait,
    nowSeconds: () => 1000,
  });
}

function subscriptionPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    livemode: false,
    items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
    ...overrides,
  };
}
