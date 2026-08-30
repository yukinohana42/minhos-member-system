import { accessGrantKey, memberRowKey, subscriptionRowKey } from "./keys";

type IdentityRecord = Readonly<Record<string, unknown>>;

export type SupplementalBlankProfileResponseIdPolicy =
  | { readonly kind: "reject" }
  | {
    readonly kind: "allow-exact-blank-for-existing-minhos-member-ids";
    readonly minhosMemberIds: ReadonlySet<string>;
  };

/** New/prospective Supplemental rows must always carry a Form response ID. */
export const REJECT_BLANK_PROFILE_RESPONSE_IDS: SupplementalBlankProfileResponseIdPolicy = {
  kind: "reject",
};

/**
 * Exact empty strings may only survive for the explicitly listed persisted
 * legacy rows. Whitespace-only and non-string cells are never legacy blanks.
 */
export function allowExistingBlankProfileResponseIds(
  minhosMemberIds: Iterable<string>,
): SupplementalBlankProfileResponseIdPolicy {
  return {
    kind: "allow-exact-blank-for-existing-minhos-member-ids",
    minhosMemberIds: new Set(minhosMemberIds),
  };
}

export function assertPersistedIdentityRows(sheetName: string, rows: ReadonlyArray<IdentityRecord>): void {
  switch (sheetName) {
    case "10_Members":
      assertMemberIdentityIntegrity(rows);
      return;
    case "20_Subscriptions":
      assertSubscriptionIdentityIntegrity(rows);
      return;
    case "21_AccessGrants":
      assertAccessGrantIdentityIntegrity(rows);
      return;
  }
}

export function assertMemberIdentityIntegrity(
  rows: ReadonlyArray<IdentityRecord>,
  expectedGhostSiteId?: string,
): void {
  validateMemberIdentities(rows, expectedGhostSiteId);
}

export function assertSupplementalIdentityIntegrity(
  supplementalRows: ReadonlyArray<IdentityRecord>,
  memberRows: ReadonlyArray<IdentityRecord>,
  blankProfileResponseIdPolicy: SupplementalBlankProfileResponseIdPolicy,
  expectedGhostSiteId?: string,
): void {
  const members = validateMemberIdentities(memberRows, expectedGhostSiteId);
  validateSupplementalIdentities(
    supplementalRows,
    memberIdentityLookup(members),
    blankProfileResponseIdPolicy,
  );
}

export interface CrossTableIdentityIntegrityInput {
  memberRows: ReadonlyArray<IdentityRecord>;
  subscriptionRows: ReadonlyArray<IdentityRecord>;
  accessGrantRows: ReadonlyArray<IdentityRecord>;
  supplementalRows: ReadonlyArray<IdentityRecord>;
  blankProfileResponseIdPolicy: SupplementalBlankProfileResponseIdPolicy;
  expectedGhostSiteId?: string;
  expectedStripeContext?: { stripeAccountId: string; livemode: boolean };
}

/**
 * Validate the complete immutable identity graph in one linear pass. A caller
 * must use this boundary before a repository read or prospective write so a
 * Members change cannot silently orphan or remap a dependent table.
 */
export function assertCrossTableIdentityIntegrity(input: CrossTableIdentityIntegrityInput): void {
  const members = validateMemberIdentities(input.memberRows, input.expectedGhostSiteId);
  const lookup = memberIdentityLookup(members);
  validateSubscriptionIdentities(input.subscriptionRows, input.expectedStripeContext, lookup);
  validateAccessGrantIdentities(input.accessGrantRows, input.expectedGhostSiteId, lookup);
  validateSupplementalIdentities(
    input.supplementalRows,
    lookup,
    input.blankProfileResponseIdPolicy,
  );
}

interface MemberIdentityLookup {
  byMinhosId: ReadonlyMap<string, ValidatedMemberIdentity>;
  byGhostId: ReadonlyMap<string, ValidatedMemberIdentity>;
}

function memberIdentityLookup(members: ReadonlyArray<ValidatedMemberIdentity>): MemberIdentityLookup {
  return {
    byMinhosId: new Map(members.map((member) => [member.minhosMemberId, member])),
    byGhostId: new Map(members.map((member) => [member.ghostMemberId, member])),
  };
}

function validateSupplementalIdentities(
  supplementalRows: ReadonlyArray<IdentityRecord>,
  members: MemberIdentityLookup,
  blankProfileResponseIdPolicy: SupplementalBlankProfileResponseIdPolicy,
): void {
  const supplementalMinhosIds = new Set<string>();
  const supplementalGhostIds = new Set<string>();
  const responseIds = new Set<string>();

  forEachPopulatedRow(supplementalRows, (row, rowNumber) => {
    const minhosMemberId = stableId(row.minhos_member_id, "40_Supplemental", rowNumber, "MINHOS_MEMBER_ID");
    const ghostMemberId = stableId(row.ghost_member_id, "40_Supplemental", rowNumber, "GHOST_MEMBER_ID");
    unique(supplementalMinhosIds, minhosMemberId, "40_Supplemental", rowNumber, "MINHOS_MEMBER_ID");
    unique(supplementalGhostIds, ghostMemberId, "40_Supplemental", rowNumber, "GHOST_MEMBER_ID");

    assertMemberPair("40_Supplemental", rowNumber, minhosMemberId, ghostMemberId, members);

    const responseId = profileResponseId(
      row.profile_response_id,
      minhosMemberId,
      rowNumber,
      blankProfileResponseIdPolicy,
    );
    if (responseId !== null) {
      unique(responseIds, responseId, "40_Supplemental", rowNumber, "PROFILE_RESPONSE_ID");
    }
  });
}

interface ValidatedMemberIdentity {
  minhosMemberId: string;
  ghostMemberId: string;
}

function validateMemberIdentities(
  rows: ReadonlyArray<IdentityRecord>,
  expectedGhostSiteId?: string,
): ValidatedMemberIdentity[] {
  const memberKeys = new Set<string>();
  const ghostMemberIds = new Set<string>();
  const minhosMemberIds = new Set<string>();
  const identities: ValidatedMemberIdentity[] = [];
  forEachPopulatedRow(rows, (row, rowNumber) => {
    const memberKey = stableId(row.member_row_key, "10_Members", rowNumber, "MEMBER_ROW_KEY");
    const minhosMemberId = stableId(row.minhos_member_id, "10_Members", rowNumber, "MINHOS_MEMBER_ID");
    const ghostSiteId = stableId(row.ghost_site_id, "10_Members", rowNumber, "GHOST_SITE_ID");
    const ghostMemberId = stableId(row.ghost_member_id, "10_Members", rowNumber, "GHOST_MEMBER_ID");
    if (expectedGhostSiteId !== undefined && ghostSiteId !== expectedGhostSiteId) {
      fail("10_Members", rowNumber, "GHOST_SITE_MISMATCH");
    }
    if (safeMemberRowKey(ghostSiteId, ghostMemberId) !== memberKey) {
      fail("10_Members", rowNumber, "MEMBER_ROW_KEY_MISMATCH");
    }
    unique(memberKeys, memberKey, "10_Members", rowNumber, "MEMBER_ROW_KEY");
    unique(ghostMemberIds, ghostMemberId, "10_Members", rowNumber, "GHOST_MEMBER_ID");
    unique(minhosMemberIds, minhosMemberId, "10_Members", rowNumber, "MINHOS_MEMBER_ID");
    identities.push({ minhosMemberId, ghostMemberId });
  });
  return identities;
}

export function assertSubscriptionIdentityIntegrity(
  rows: ReadonlyArray<IdentityRecord>,
  expected?: { stripeAccountId: string; livemode: boolean },
): void {
  validateSubscriptionIdentities(rows, expected);
}

function validateSubscriptionIdentities(
  rows: ReadonlyArray<IdentityRecord>,
  expected?: { stripeAccountId: string; livemode: boolean },
  members?: MemberIdentityLookup,
): void {
  const rowKeys = new Set<string>();
  const subscriptionIds = new Set<string>();
  forEachPopulatedRow(rows, (row, rowNumber) => {
    const rowKey = stableId(row.subscription_row_key, "20_Subscriptions", rowNumber, "SUBSCRIPTION_ROW_KEY");
    const accountId = stableId(row.stripe_account_id, "20_Subscriptions", rowNumber, "STRIPE_ACCOUNT_ID");
    const subscriptionId = stableId(row.stripe_subscription_id, "20_Subscriptions", rowNumber, "STRIPE_SUBSCRIPTION_ID");
    stableId(row.stripe_customer_id, "20_Subscriptions", rowNumber, "STRIPE_CUSTOMER_ID");
    if (typeof row.livemode !== "boolean") fail("20_Subscriptions", rowNumber, "LIVEMODE_INVALID");
    const environment = stableId(row.environment, "20_Subscriptions", rowNumber, "ENVIRONMENT");
    if (environment !== (row.livemode ? "live" : "test")) {
      fail("20_Subscriptions", rowNumber, "ENVIRONMENT_MISMATCH");
    }
    if (expected && (accountId !== expected.stripeAccountId || row.livemode !== expected.livemode)) {
      fail("20_Subscriptions", rowNumber, "STRIPE_CONTEXT_MISMATCH");
    }
    if (safeSubscriptionRowKey(accountId, row.livemode, subscriptionId) !== rowKey) {
      fail("20_Subscriptions", rowNumber, "SUBSCRIPTION_ROW_KEY_MISMATCH");
    }
    if (typeof row.source_present_ghost !== "boolean") {
      fail("20_Subscriptions", rowNumber, "SOURCE_PRESENT_GHOST_INVALID");
    }
    const lastSeenGhostRunId = optionalStableId(
      row.last_seen_ghost_run_id,
      "20_Subscriptions",
      rowNumber,
      "LAST_SEEN_GHOST_RUN_ID",
    );
    const minhosMemberId = optionalStableId(
      row.minhos_member_id,
      "20_Subscriptions",
      rowNumber,
      "MINHOS_MEMBER_ID",
    );
    const ghostMemberId = optionalStableId(
      row.ghost_member_id,
      "20_Subscriptions",
      rowNumber,
      "GHOST_MEMBER_ID",
    );
    if ((minhosMemberId === null) !== (ghostMemberId === null)) {
      fail("20_Subscriptions", rowNumber, "MEMBER_ID_PAIR_PARTIAL");
    }
    if (minhosMemberId === null || ghostMemberId === null) {
      if (row.source_present_ghost) {
        fail("20_Subscriptions", rowNumber, "GHOST_PROJECTION_MEMBER_IDS_BLANK");
      }
      if (lastSeenGhostRunId !== null) {
        fail("20_Subscriptions", rowNumber, "GHOST_PROJECTION_HISTORY_MEMBER_IDS_BLANK");
      }
    } else {
      // last_seen_ghost_run_id is the durable discriminator between a Stripe-only
      // row that has never been projected (blank pair) and a historical Ghost
      // projection tombstone (retained pair). Current presence may change, but
      // projection history and its immutable Member pair must not disappear.
      if (lastSeenGhostRunId === null) {
        fail("20_Subscriptions", rowNumber, "GHOST_PROJECTION_HISTORY_RUN_ID_BLANK");
      }
      if (members) {
        assertMemberPair("20_Subscriptions", rowNumber, minhosMemberId, ghostMemberId, members);
      }
    }
    unique(rowKeys, rowKey, "20_Subscriptions", rowNumber, "SUBSCRIPTION_ROW_KEY");
    unique(subscriptionIds, subscriptionId, "20_Subscriptions", rowNumber, "STRIPE_SUBSCRIPTION_ID");
  });
}

export function assertAccessGrantIdentityIntegrity(
  rows: ReadonlyArray<IdentityRecord>,
  expectedGhostSiteId?: string,
): void {
  validateAccessGrantIdentities(rows, expectedGhostSiteId);
}

function validateAccessGrantIdentities(
  rows: ReadonlyArray<IdentityRecord>,
  expectedGhostSiteId?: string,
  members?: MemberIdentityLookup,
): void {
  const grantKeys = new Set<string>();
  forEachPopulatedRow(rows, (row, rowNumber) => {
    const grantKey = stableId(row.grant_key, "21_AccessGrants", rowNumber, "GRANT_KEY");
    const minhosMemberId = stableId(row.minhos_member_id, "21_AccessGrants", rowNumber, "MINHOS_MEMBER_ID");
    const ghostMemberId = stableId(row.ghost_member_id, "21_AccessGrants", rowNumber, "GHOST_MEMBER_ID");
    const tierId = stableId(row.tier_id, "21_AccessGrants", rowNumber, "TIER_ID");
    if (row.grant_kind !== "comped" && row.grant_kind !== "gift") {
      fail("21_AccessGrants", rowNumber, "GRANT_KIND_INVALID");
    }
    const parts = grantKey.split(":");
    const ghostSiteId = parts.length === 5 && parts[0] === "ghost" ? parts[1] ?? "" : "";
    if (!ghostSiteId) fail("21_AccessGrants", rowNumber, "GRANT_KEY_MALFORMED");
    if (expectedGhostSiteId !== undefined && ghostSiteId !== expectedGhostSiteId) {
      fail("21_AccessGrants", rowNumber, "GHOST_SITE_MISMATCH");
    }
    if (safeAccessGrantKey(ghostSiteId, ghostMemberId, tierId, row.grant_kind) !== grantKey) {
      fail("21_AccessGrants", rowNumber, "GRANT_KEY_MISMATCH");
    }
    if (members) {
      assertMemberPair("21_AccessGrants", rowNumber, minhosMemberId, ghostMemberId, members);
    }
    // Multiple grants per member are valid; only the exact composite key is unique.
    unique(grantKeys, grantKey, "21_AccessGrants", rowNumber, "GRANT_KEY");
  });
}

function stableId(value: unknown, sheet: string, row: number, field: string): string {
  if (typeof value !== "string") fail(sheet, row, `${field}_NON_STRING`);
  if (!value.trim()) fail(sheet, row, `${field}_BLANK`);
  if (value !== value.trim()) fail(sheet, row, `${field}_WHITESPACE`);
  return value;
}

function optionalStableId(value: unknown, sheet: string, row: number, field: string): string | null {
  if (typeof value !== "string") fail(sheet, row, `${field}_NON_STRING`);
  if (value === "") return null;
  if (!value.trim()) fail(sheet, row, `${field}_BLANK`);
  if (value !== value.trim()) fail(sheet, row, `${field}_WHITESPACE`);
  return value;
}

function assertMemberPair(
  sheet: string,
  row: number,
  minhosMemberId: string,
  ghostMemberId: string,
  members: MemberIdentityLookup,
): void {
  const memberByMinhosId = members.byMinhosId.get(minhosMemberId);
  const memberByGhostId = members.byGhostId.get(ghostMemberId);
  if (!memberByMinhosId) fail(sheet, row, "MINHOS_MEMBER_ID_ORPHAN");
  if (!memberByGhostId) fail(sheet, row, "GHOST_MEMBER_ID_ORPHAN");
  if (memberByMinhosId !== memberByGhostId) fail(sheet, row, "MEMBER_ID_PAIR_MISMATCH");
}

function profileResponseId(
  value: unknown,
  minhosMemberId: string,
  rowNumber: number,
  policy: SupplementalBlankProfileResponseIdPolicy,
): string | null {
  if (typeof value !== "string") {
    fail("40_Supplemental", rowNumber, "PROFILE_RESPONSE_ID_NON_STRING");
  }
  if (value === "") {
    if (
      policy.kind === "allow-exact-blank-for-existing-minhos-member-ids" &&
      policy.minhosMemberIds.has(minhosMemberId)
    ) {
      return null;
    }
    fail("40_Supplemental", rowNumber, "PROFILE_RESPONSE_ID_BLANK");
  }
  if (!value.trim()) fail("40_Supplemental", rowNumber, "PROFILE_RESPONSE_ID_BLANK");
  if (value !== value.trim()) fail("40_Supplemental", rowNumber, "PROFILE_RESPONSE_ID_WHITESPACE");
  return value;
}

function forEachPopulatedRow(
  rows: ReadonlyArray<IdentityRecord>,
  visit: (row: IdentityRecord, rowNumber: number) => void,
): void {
  rows.forEach((row, index) => {
    if (!isBlankRow(row)) visit(row, index + 2);
  });
}

function isBlankRow(row: IdentityRecord): boolean {
  return Object.values(row).every((value) => value === "" || value === null || value === undefined);
}

function unique(seen: Set<string>, value: string, sheet: string, row: number, field: string): void {
  if (seen.has(value)) fail(sheet, row, `DUPLICATE_${field}`);
  seen.add(value);
}

function safeMemberRowKey(siteId: string, memberId: string): string {
  try { return memberRowKey(siteId, memberId); } catch { return ""; }
}

function safeSubscriptionRowKey(accountId: string, livemode: boolean, subscriptionId: string): string {
  try { return subscriptionRowKey(accountId, livemode, subscriptionId); } catch { return ""; }
}

function safeAccessGrantKey(siteId: string, memberId: string, tierId: string, kind: string): string {
  try { return accessGrantKey(siteId, memberId, tierId, kind); } catch { return ""; }
}

function fail(sheet: string, row: number, reason: string): never {
  throw new Error(`IDENTITY_INTEGRITY:${sheet}:row_${row}:${reason}`);
}
