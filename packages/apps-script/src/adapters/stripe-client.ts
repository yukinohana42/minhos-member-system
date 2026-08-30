import {
  executeGetWithRetry,
  parseJson,
  type HttpResponse,
  type HttpTransport,
} from "../domain/http";
import type {
  StripeChargeRaw,
  StripeDisputeRaw,
  StripeInvoiceRaw,
  StripeList,
  StripePaymentIntentRaw,
  StripeRefundRaw,
  StripeSubscriptionRaw,
} from "../domain/types";
import { validateStripeRuntimeList, validateStripeRuntimeResponse } from "../domain/stripe-runtime-validation";

export class StripeReadOnlyClient {
  private readonly apiBase = "https://api.stripe.com/v1";

  constructor(
    private readonly options: {
      restrictedKey: string;
      apiVersion: string;
      transport: HttpTransport;
      retryRuntime: { sleep(ms: number): void; random(): number };
    },
  ) {}

  getAccount(): { id: string } {
    return this.getObject<{ id: string }>("/account", "stripe_account");
  }

  listSubscriptions(startingAfter?: string): StripeList<StripeSubscriptionRaw> {
    return this.getList<StripeSubscriptionRaw>(
      "/subscriptions",
      [
        ["limit", "100"],
        ["status", "all"],
        ["starting_after", startingAfter],
        ["expand[]", "data.latest_invoice"],
        ["expand[]", "data.latest_invoice.payment_intent"],
        ["expand[]", "data.customer"],
      ],
      "stripe_subscriptions",
    );
  }

  listOpenInvoices(startingAfter?: string): StripeList<StripeInvoiceRaw> {
    return this.getList<StripeInvoiceRaw>(
      "/invoices",
      [
        ["limit", "100"],
        ["status", "open"],
        ["starting_after", startingAfter],
        ["expand[]", "data.subscription"],
        ["expand[]", "data.payment_intent"],
      ],
      "stripe_open_invoices",
    );
  }

  listRefunds(createdGte: number, startingAfter?: string): StripeList<StripeRefundRaw> {
    return this.getList<StripeRefundRaw>(
      "/refunds",
      [
        ["limit", "100"],
        ["created[gte]", String(createdGte)],
        ["starting_after", startingAfter],
        ["expand[]", "data.charge"],
        ["expand[]", "data.payment_intent"],
      ],
      "stripe_refunds",
    );
  }

  listDisputes(createdGte?: number, startingAfter?: string): StripeList<StripeDisputeRaw> {
    return this.getList<StripeDisputeRaw>(
      "/disputes",
      [
        ["limit", "100"],
        ["created[gte]", createdGte === undefined ? undefined : String(createdGte)],
        ["starting_after", startingAfter],
        ["expand[]", "data.charge"],
        ["expand[]", "data.payment_intent"],
      ],
      "stripe_disputes",
    );
  }

  retrieveCharge(id: string): StripeChargeRaw {
    return this.getObject<StripeChargeRaw>(`/charges/${encodeURIComponent(id)}`, "stripe_charge");
  }

  retrievePaymentIntent(id: string): StripePaymentIntentRaw {
    return this.getObject<StripePaymentIntentRaw>(
      `/payment_intents/${encodeURIComponent(id)}`,
      "stripe_payment_intent",
    );
  }

  retrieveInvoice(id: string): StripeInvoiceRaw {
    return this.getObject<StripeInvoiceRaw>(`/invoices/${encodeURIComponent(id)}`, "stripe_invoice");
  }

  retrieveRefund(id: string): StripeRefundRaw {
    return this.getObject<StripeRefundRaw>(`/refunds/${encodeURIComponent(id)}`, "stripe_refund");
  }

  retrieveDispute(id: string): StripeDisputeRaw {
    return this.getObject<StripeDisputeRaw>(`/disputes/${encodeURIComponent(id)}`, "stripe_dispute");
  }

  retrieveProduct(id: string): Record<string, unknown> {
    return this.getObject<Record<string, unknown>>(`/products/${encodeURIComponent(id)}`, "stripe_product");
  }

  retrievePrice(id: string): Record<string, unknown> {
    return this.getObject<Record<string, unknown>>(`/prices/${encodeURIComponent(id)}`, "stripe_price");
  }

  private getObject<T>(path: string, shapeName: string): T {
    const result = parseJson<unknown>(this.get(path), shapeName);
    validateStripeRuntimeResponse(shapeName, result);
    return result as T;
  }

  private getList<T>(
    path: string,
    pairs: Array<[string, string | undefined]>,
    shapeName: string,
  ): StripeList<T> {
    const query = pairs
      .filter((pair): pair is [string, string] => pair[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const result = parseJson<unknown>(this.get(`${path}?${query}`), shapeName);
    validateStripeRuntimeList(shapeName, result);
    return result as StripeList<T>;
  }

  private get(path: string): HttpResponse {
    return executeGetWithRetry(
      {
        method: "get",
        url: `${this.apiBase}${path}`,
        headers: {
          Authorization: `Bearer ${this.options.restrictedKey}`,
          "Stripe-Version": this.options.apiVersion,
          Accept: "application/json",
        },
      },
      this.options.transport,
      this.options.retryRuntime,
    );
  }
}
