export function memberRowKey(ghostSiteId: string, ghostMemberId: string): string {
  requireKeyPart("ghostSiteId", ghostSiteId);
  requireKeyPart("ghostMemberId", ghostMemberId);
  return `ghost:${ghostSiteId}:${ghostMemberId}`;
}

export function subscriptionRowKey(
  stripeAccountId: string,
  livemode: boolean,
  stripeSubscriptionId: string,
): string {
  requireKeyPart("stripeAccountId", stripeAccountId);
  requireKeyPart("stripeSubscriptionId", stripeSubscriptionId);
  return `stripe:${stripeAccountId}:${String(livemode)}:${stripeSubscriptionId}`;
}

export function accessGrantKey(
  ghostSiteId: string,
  ghostMemberId: string,
  tierId: string,
  grantKind: string,
): string {
  [ghostSiteId, ghostMemberId, tierId, grantKind].forEach((value, index) =>
    requireKeyPart(["ghostSiteId", "ghostMemberId", "tierId", "grantKind"][index] ?? "key", value),
  );
  return `ghost:${ghostSiteId}:${ghostMemberId}:${tierId}:${grantKind}`;
}

export function billingSignalKey(objectType: string, stripeObjectId: string): string {
  requireKeyPart("objectType", objectType);
  requireKeyPart("stripeObjectId", stripeObjectId);
  return `stripe:${objectType}:${stripeObjectId}`;
}

export function exceptionKey(exceptionType: string, ...identifiers: Array<string | null | undefined>): string {
  requireKeyPart("exceptionType", exceptionType);
  const parts = identifiers.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return [exceptionType, ...parts].join(":");
}

function requireKeyPart(name: string, value: string): void {
  if (!value.trim() || value.includes(":")) {
    throw new Error(`${name} must be non-empty and must not contain ':'`);
  }
}
