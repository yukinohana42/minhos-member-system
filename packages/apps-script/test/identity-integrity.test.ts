import { describe, expect, it } from "vitest";
import { definitionFor } from "../src/adapters/sheet-schema";
import { SheetsRepository } from "../src/adapters/sheets-repository";
import {
  REJECT_BLANK_PROFILE_RESPONSE_IDS,
  allowExistingBlankProfileResponseIds,
  assertAccessGrantIdentityIntegrity,
  assertCrossTableIdentityIntegrity,
  assertMemberIdentityIntegrity,
  assertSupplementalIdentityIntegrity,
  assertSubscriptionIdentityIntegrity,
} from "../src/domain/identity-integrity";
import type { AccessGrantRow, MemberRow, SheetRecord, SubscriptionRow } from "../src/domain/types";
import { FakeSheet, FakeSpreadsheet } from "./helpers/fake-spreadsheet";

describe("persisted immutable identity integrity", () => {
  it("rejects blank, duplicate, mismatched, or wrong-site Member identities with specific errors", () => {
    const valid = member("gm_1", "mm_1");
    expect(() => assertMemberIdentityIntegrity([valid], "site")).not.toThrow();
    expect(() => assertMemberIdentityIntegrity([{ ...valid, minhos_member_id: "" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:MINHOS_MEMBER_ID_BLANK");
    expect(() => assertMemberIdentityIntegrity([{ ...valid, ghost_member_id: "" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:GHOST_MEMBER_ID_BLANK");
    expect(() => assertMemberIdentityIntegrity([{ ...valid, ghost_site_id: "" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:GHOST_SITE_ID_BLANK");
    expect(() => assertMemberIdentityIntegrity([{ ...valid, member_row_key: "ghost:site:wrong" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:MEMBER_ROW_KEY_MISMATCH");
    expect(() => assertMemberIdentityIntegrity([{ ...valid, ghost_site_id: "other", member_row_key: "ghost:other:gm_1" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:GHOST_SITE_MISMATCH");
    expect(() => assertMemberIdentityIntegrity([valid, member("gm_2", "mm_1")], "site"))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_3:DUPLICATE_MINHOS_MEMBER_ID");
  });

  it("leaves a corrupt legacy Member row byte-for-byte unchanged before upsert can reissue an ID", () => {
    const spreadsheet = new FakeSpreadsheet();
    const sheet = new FakeSheet("10_Members");
    const columns = definitionFor("10_Members").columns;
    const corrupt: MemberRow = { ...member("gm_legacy", "mm_legacy"), minhos_member_id: "" };
    sheet.seed([columns, columns.map((column) => corrupt[column] ?? "")]);
    spreadsheet.sheets.set("10_Members", sheet);
    const before = sheet.matrix();
    const repository = new SheetsRepository(
      "identity-test",
      spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
    );

    expect(() => repository.upsert("10_Members", [member("gm_new", "mm_new")]))
      .toThrow("IDENTITY_INTEGRITY:10_Members:row_2:MINHOS_MEMBER_ID_BLANK");
    expect(sheet.matrix()).toEqual(before);
    expect(sheet.operations).toEqual([]);
  });

  it("applies analogous minimum composite identity checks to Subscriptions and AccessGrants", () => {
    const subscription = subscriptionRow();
    expect(() => assertSubscriptionIdentityIntegrity([subscription], {
      stripeAccountId: "acct", livemode: false,
    })).not.toThrow();
    expect(() => assertSubscriptionIdentityIntegrity([{
      ...subscription, subscription_row_key: "stripe:acct:false:sub_wrong",
    }])).toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_2:SUBSCRIPTION_ROW_KEY_MISMATCH");
    expect(() => assertSubscriptionIdentityIntegrity([
      subscription, { ...subscription, subscription_row_key: "stripe:other:false:sub_1", stripe_account_id: "other" },
    ])).toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_3:DUPLICATE_STRIPE_SUBSCRIPTION_ID");

    const grant = grantRow();
    expect(() => assertAccessGrantIdentityIntegrity([grant], "site")).not.toThrow();
    expect(() => assertAccessGrantIdentityIntegrity([{
      ...grant, grant_key: "ghost:other:gm_1:tier_1:comped",
    }], "site")).toThrow("IDENTITY_INTEGRITY:21_AccessGrants:row_2:GHOST_SITE_MISMATCH");
    expect(() => assertAccessGrantIdentityIntegrity([{ ...grant, minhos_member_id: "" }], "site"))
      .toThrow("IDENTITY_INTEGRITY:21_AccessGrants:row_2:MINHOS_MEMBER_ID_BLANK");
  });

  it("distinguishes never-projected Subscriptions from historical projection tombstones", () => {
    const members = [member("gm_1", "mm_1"), member("gm_2", "mm_2")];
    const projected = projectedSubscription("sub_1", "gm_1", "mm_1");
    const tombstone = {
      ...projectedSubscription("sub_tombstone", "gm_2", "mm_2"),
      source_present_ghost: false,
      source_missing_since: "2026-08-29T00:00:00.000Z",
      last_seen_ghost_run_id: "run_previous",
    };
    expect(() => assertCrossTableIdentityIntegrity({
      memberRows: members,
      subscriptionRows: [subscriptionRow("sub_stripe_only"), projected, tombstone],
      accessGrantRows: [grantRow("gm_1", "mm_1")],
      supplementalRows: [],
      blankProfileResponseIdPolicy: REJECT_BLANK_PROFILE_RESPONSE_IDS,
      expectedGhostSiteId: "site",
      expectedStripeContext: { stripeAccountId: "acct", livemode: false },
    })).not.toThrow();

    for (const [row, error] of [
      [projectedSubscription("sub_orphan", "gm_1", "mm_missing"), "MINHOS_MEMBER_ID_ORPHAN"],
      [projectedSubscription("sub_wrong_pair", "gm_2", "mm_1"), "MEMBER_ID_PAIR_MISMATCH"],
      [{ ...projectedSubscription("sub_partial", "gm_1", "mm_1"), minhos_member_id: "" }, "MEMBER_ID_PAIR_PARTIAL"],
      [{ ...subscriptionRow("sub_blank_projection"), source_present_ghost: true }, "GHOST_PROJECTION_MEMBER_IDS_BLANK"],
      [{ ...subscriptionRow("sub_history_without_pair"), last_seen_ghost_run_id: "run_previous" }, "GHOST_PROJECTION_HISTORY_MEMBER_IDS_BLANK"],
      [{
        ...projectedSubscription("sub_pair_without_history", "gm_1", "mm_1"),
        source_present_ghost: false,
        last_seen_ghost_run_id: "",
      }, "GHOST_PROJECTION_HISTORY_RUN_ID_BLANK"],
    ] as const) {
      expect(() => assertCrossTableIdentityIntegrity({
        memberRows: members,
        subscriptionRows: [row],
        accessGrantRows: [],
        supplementalRows: [],
        blankProfileResponseIdPolicy: REJECT_BLANK_PROFILE_RESPONSE_IDS,
      })).toThrow(`IDENTITY_INTEGRITY:20_Subscriptions:row_2:${error}`);
    }

    for (const [row, error] of [
      [grantRow("gm_1", "mm_missing"), "MINHOS_MEMBER_ID_ORPHAN"],
      [grantRow("gm_2", "mm_1"), "MEMBER_ID_PAIR_MISMATCH"],
    ] as const) {
      expect(() => assertCrossTableIdentityIntegrity({
        memberRows: members,
        subscriptionRows: [],
        accessGrantRows: [row],
        supplementalRows: [],
        blankProfileResponseIdPolicy: REJECT_BLANK_PROFILE_RESPONSE_IDS,
      })).toThrow(`IDENTITY_INTEGRITY:21_AccessGrants:row_2:${error}`);
    }
  });

  it("reports cross-table failures by sheet and row without echoing identity values", () => {
    let message = "";
    try {
      assertCrossTableIdentityIntegrity({
        memberRows: [member("gm_1", "mm_1")],
        subscriptionRows: [projectedSubscription(
          "sub_sensitive",
          "sensitive-ghost-identifier",
          "sensitive-minhos-identifier",
        )],
        accessGrantRows: [],
        supplementalRows: [],
        blankProfileResponseIdPolicy: REJECT_BLANK_PROFILE_RESPONSE_IDS,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("IDENTITY_INTEGRITY:20_Subscriptions:row_2:MINHOS_MEMBER_ID_ORPHAN");
    expect(message).not.toContain("sensitive");
  });

  it("requires every Supplemental minhos/ghost pair to resolve to the same unique Member", () => {
    const members = [member("gm_1", "mm_1"), member("gm_2", "mm_2")];
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental("mm_1", "gm_1", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).not.toThrow();
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental("mm_missing", "gm_1", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MINHOS_MEMBER_ID_ORPHAN");
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental("mm_1", "gm_missing", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:GHOST_MEMBER_ID_ORPHAN");
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental("mm_1", "gm_2", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MEMBER_ID_PAIR_MISMATCH");
  });

  it("rejects Supplemental whitespace, non-string IDs, and global response-ID collisions without echoing values", () => {
    const members = [member("gm_1", "mm_1"), member("gm_2", "mm_2")];
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental(" mm_1", "gm_1", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MINHOS_MEMBER_ID_WHITESPACE");
    expect(() => assertSupplementalIdentityIntegrity(
      [{ ...supplemental("mm_1", "gm_1", "response_1"), ghost_member_id: 123 }],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:GHOST_MEMBER_ID_NON_STRING");
    expect(() => assertSupplementalIdentityIntegrity(
      [{ ...supplemental("mm_1", "gm_1", "response_1"), profile_response_id: false }],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:PROFILE_RESPONSE_ID_NON_STRING");
    expect(() => assertSupplementalIdentityIntegrity(
      [supplemental("mm_1", "gm_1", "response_1"), supplemental("mm_2", "gm_2", "response_1")],
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_3:DUPLICATE_PROFILE_RESPONSE_ID");

    let message = "";
    try {
      assertSupplementalIdentityIntegrity(
        [supplemental("mm_1", "gm_1", " sensitive-response-id ")],
        members,
        REJECT_BLANK_PROFILE_RESPONSE_IDS,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("IDENTITY_INTEGRITY:40_Supplemental:row_2:PROFILE_RESPONSE_ID_WHITESPACE");
    expect(message).not.toContain("sensitive-response-id");
  });

  it("allows only explicitly listed exact-empty legacy response IDs while rejecting new blanks", () => {
    const members = [member("gm_1", "mm_1")];
    const legacy = supplemental("mm_1", "gm_1", "");
    expect(() => assertSupplementalIdentityIntegrity(
      [legacy], members, REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:PROFILE_RESPONSE_ID_BLANK");
    expect(() => assertSupplementalIdentityIntegrity(
      [legacy], members, allowExistingBlankProfileResponseIds(["mm_1"]),
    )).not.toThrow();
    expect(() => assertSupplementalIdentityIntegrity(
      [{ ...legacy, profile_response_id: " " }],
      members,
      allowExistingBlankProfileResponseIds(["mm_1"]),
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:PROFILE_RESPONSE_ID_BLANK");
  });

  it("validates a 1,000-row Members/Supplemental table and reports the final physical row", () => {
    const members = Array.from({ length: 1_000 }, (_, index) => member(`gm_${index}`, `mm_${index}`));
    const supplementalRows = Array.from(
      { length: 1_000 },
      (_, index) => supplemental(`mm_${index}`, `gm_${index}`, `response_${index}`),
    );
    expect(() => assertSupplementalIdentityIntegrity(
      supplementalRows,
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).not.toThrow();

    supplementalRows[999] = supplemental("mm_999", "gm_999", "response_0");
    expect(() => assertSupplementalIdentityIntegrity(
      supplementalRows,
      members,
      REJECT_BLANK_PROFILE_RESPONSE_IDS,
    )).toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_1001:DUPLICATE_PROFILE_RESPONSE_ID");
  });

  it("validates 1,000-row Subscription and AccessGrant references with indexed lookups", () => {
    const members = Array.from({ length: 1_000 }, (_, index) => member(`gm_${index}`, `mm_${index}`));
    const subscriptions = Array.from(
      { length: 1_000 },
      (_, index) => projectedSubscription(`sub_${index}`, `gm_${index}`, `mm_${index}`),
    );
    const grants = Array.from(
      { length: 1_000 },
      (_, index) => grantRow(`gm_${index}`, `mm_${index}`, `tier_${index}`),
    );
    const input = {
      memberRows: members,
      subscriptionRows: subscriptions,
      accessGrantRows: grants,
      supplementalRows: [],
      blankProfileResponseIdPolicy: REJECT_BLANK_PROFILE_RESPONSE_IDS,
    };
    expect(() => assertCrossTableIdentityIntegrity(input)).not.toThrow();

    subscriptions[999] = projectedSubscription("sub_999", "gm_0", "mm_999");
    expect(() => assertCrossTableIdentityIntegrity(input))
      .toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_1001:MEMBER_ID_PAIR_MISMATCH");
  });
});

describe("SheetsRepository Supplemental identity boundary", () => {
  it("rejects corrupt Supplemental reads, including raw non-string cells, without mutating either table", () => {
    const { repository, spreadsheet } = repositoryWithMembers([
      member("gm_1", "mm_1"), member("gm_2", "mm_2"),
    ]);
    const supplementalSheet = spreadsheet.sheets.get("40_Supplemental")!;
    seedSheetRows(supplementalSheet, "40_Supplemental", [
      supplemental("mm_1", "gm_2", "response_1"),
    ]);
    const before = supplementalSheet.matrix();
    const operationsBefore = [...supplementalSheet.operations];

    expect(() => repository.read<SheetRecord>("40_Supplemental"))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MEMBER_ID_PAIR_MISMATCH");
    expect(() => repository.read<MemberRow>("10_Members"))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MEMBER_ID_PAIR_MISMATCH");
    expect(supplementalSheet.matrix()).toEqual(before);
    expect(supplementalSheet.operations).toEqual(operationsBefore);

    seedSheetRows(supplementalSheet, "40_Supplemental", [{
      ...supplemental("mm_1", "gm_1", "response_1"),
      profile_response_id: 123,
    }]);
    expect(() => repository.read<SheetRecord>("40_Supplemental"))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:PROFILE_RESPONSE_ID_NON_STRING");
  });

  it("guards generic and formula-authorized inserts before grid or cell mutation", () => {
    for (const [insert, expectedError] of [
      [
        (repository: SheetsRepository) => repository.insertIfAbsent("40_Supplemental", {
          minhos_member_id: "mm_orphan", ghost_member_id: "gm_1", profile_response_id: "response_generic",
        }),
        "SUPPLEMENTAL_GENERIC_WRITE_FORBIDDEN",
      ],
      [
        (repository: SheetsRepository) => repository.insertSupplementalIfAbsent({
          minhos_member_id: "mm_1", ghost_member_id: " gm_1", profile_response_id: "response_formula_path",
        }),
        "IDENTITY_INTEGRITY:40_Supplemental:row_2:GHOST_MEMBER_ID_WHITESPACE",
      ],
    ] as const) {
      const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
      const supplementalSheet = spreadsheet.sheets.get("40_Supplemental")!;
      const before = supplementalSheet.matrix();
      const operationsBefore = [...supplementalSheet.operations];
      expect(() => insert(repository)).toThrow(expectedError);
      expect(supplementalSheet.matrix()).toEqual(before);
      expect(supplementalSheet.operations).toEqual(operationsBefore);
    }
  });

  it("forbids generic replace, upsert, and in-place prospective Supplemental writes", () => {
    const invalid = supplemental("mm_1", "gm_missing", "response_1");
    const mutations: Array<(repository: SheetsRepository) => unknown> = [
      (repository) => repository.replace("40_Supplemental", [invalid]),
      (repository) => repository.upsert("40_Supplemental", [invalid]),
      (repository) => repository.upsertOwnedRowsInPlace(
        "40_Supplemental",
        [invalid],
        ["ghost_member_id", "profile_response_id"],
      ),
    ];
    for (const mutate of mutations) {
      const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
      const supplementalSheet = spreadsheet.sheets.get("40_Supplemental")!;
      const before = supplementalSheet.matrix();
      const operationsBefore = [...supplementalSheet.operations];
      expect(() => mutate(repository))
        .toThrow("SUPPLEMENTAL_GENERIC_WRITE_FORBIDDEN");
      expect(supplementalSheet.matrix()).toEqual(before);
      expect(supplementalSheet.operations).toEqual(operationsBefore);
    }

    const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
    const supplementalSheet = spreadsheet.sheets.get("40_Supplemental")!;
    const before = supplementalSheet.matrix();
    const operationsBefore = [...supplementalSheet.operations];
    expect(() => repository.insertSupplementalIfAbsent(invalid))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:GHOST_MEMBER_ID_ORPHAN");
    expect(supplementalSheet.matrix()).toEqual(before);
    expect(supplementalSheet.operations).toEqual(operationsBefore);
  });

  it("does not let a Members mutation orphan or remap an existing Supplemental row", () => {
    const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
    expect(repository.insertSupplementalIfAbsent({
      ...supplemental("mm_1", "gm_1", "response_1"),
      override_affiliation: "operator-owned",
      ops_note: "preserve",
    })).toBe(true);
    const membersSheet = spreadsheet.sheets.get("10_Members")!;
    const supplementalSheet = spreadsheet.sheets.get("40_Supplemental")!;
    const membersBefore = membersSheet.matrix();
    const supplementalBefore = supplementalSheet.matrix();
    const memberOperationsBefore = [...membersSheet.operations];
    const supplementalOperationsBefore = [...supplementalSheet.operations];

    expect(() => repository.replace("10_Members", [member("gm_2", "mm_2")]))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_2:MINHOS_MEMBER_ID_ORPHAN");
    expect(membersSheet.matrix()).toEqual(membersBefore);
    expect(supplementalSheet.matrix()).toEqual(supplementalBefore);
    expect(membersSheet.operations).toEqual(memberOperationsBefore);
    expect(supplementalSheet.operations).toEqual(supplementalOperationsBefore);
  });

  it("keeps a same-response insert idempotent and preserves formulas/operator cells byte-for-byte", () => {
    const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
    const row = {
      ...supplemental("mm_1", "gm_1", "response_1"),
      form_affiliation: "form",
      override_affiliation: "operator-owned",
      ops_note: "operator-note",
    };
    expect(repository.insertSupplementalIfAbsent(row)).toBe(true);
    const sheet = spreadsheet.sheets.get("40_Supplemental")!;
    const before = sheet.matrix();
    const operationsBefore = [...sheet.operations];

    expect(repository.insertSupplementalIfAbsent(row)).toBe(false);
    expect(sheet.matrix()).toEqual(before);
    expect(sheet.operations).toEqual(operationsBefore);
    const columns = definitionFor("40_Supplemental").columns;
    expect(sheet.cell(2, columns.indexOf("effective_affiliation") + 1))
      .toBe('=IF(J2<>"",J2,G2)');
    expect(sheet.cell(2, columns.indexOf("ops_note") + 1)).toBe("operator-note");
  });

  it("preserves exact-empty persisted legacy rows while forbidding generic creation or clearing", () => {
    const { repository, spreadsheet } = repositoryWithMembers([
      member("gm_1", "mm_1"), member("gm_2", "mm_2"),
    ]);
    const sheet = spreadsheet.sheets.get("40_Supplemental")!;
    seedSheetRows(sheet, "40_Supplemental", [supplemental("mm_1", "gm_1", "")]);
    expect(repository.read<SheetRecord>("40_Supplemental")).toHaveLength(1);

    const before = sheet.matrix();
    const operationsBefore = [...sheet.operations];
    expect(() => repository.insertSupplementalIfAbsent(supplemental("mm_2", "gm_2", "")))
      .toThrow("IDENTITY_INTEGRITY:40_Supplemental:row_3:PROFILE_RESPONSE_ID_BLANK");
    expect(sheet.matrix()).toEqual(before);
    expect(sheet.operations).toEqual(operationsBefore);

    seedSheetRows(sheet, "40_Supplemental", [supplemental("mm_1", "gm_1", "response_1")]);
    expect(() => repository.upsert("40_Supplemental", [{
      minhos_member_id: "mm_1", profile_response_id: "",
    }], ["profile_response_id"]))
      .toThrow("SUPPLEMENTAL_GENERIC_WRITE_FORBIDDEN");
  });

  it("does not leave a partial Supplemental row when its single setValues write fails", () => {
    const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
    const sheet = spreadsheet.sheets.get("40_Supplemental")!;
    const before = sheet.matrix();
    const operationsBefore = [...sheet.operations];
    sheet.failNextSetValues = true;

    expect(() => repository.insertSupplementalIfAbsent(
      supplemental("mm_1", "gm_1", "response_failed_write"),
    )).toThrow("simulated write failure");
    expect(sheet.matrix()).toEqual(before);
    expect(sheet.operations.slice(0, operationsBefore.length)).toEqual(operationsBefore);
    expect(sheet.operations.slice(operationsBefore.length)).toEqual(["setValues:2:1:1:18"]);
    expect(sheet.matrix().some((row) => row.includes("response_failed_write"))).toBe(false);
  });
});

describe("SheetsRepository Subscription/AccessGrant identity boundary", () => {
  it("fails full preflight and reads closed on a persisted wrong pair without Sheet mutation", () => {
    const { repository, spreadsheet } = repositoryWithMembers([
      member("gm_1", "mm_1"), member("gm_2", "mm_2"),
    ]);
    const subscriptionSheet = spreadsheet.sheets.get("20_Subscriptions")!;
    seedSheetRows(subscriptionSheet, "20_Subscriptions", [
      projectedSubscription("sub_1", "gm_2", "mm_1"),
    ]);
    const before = workbookSnapshot(spreadsheet);

    expect(() => repository.read<SubscriptionRow>("20_Subscriptions"))
      .toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_2:MEMBER_ID_PAIR_MISMATCH");
    expect(() => repository.read<MemberRow>("10_Members"))
      .toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_2:MEMBER_ID_PAIR_MISMATCH");
    expect(() => repository.preflightIdentityIntegrity())
      .toThrow("IDENTITY_INTEGRITY:20_Subscriptions:row_2:MEMBER_ID_PAIR_MISMATCH");
    expect(workbookSnapshot(spreadsheet)).toEqual(before);
  });

  it("rejects prospective orphan, wrong-pair, and one-blank writes before mutation", () => {
    for (const [incoming, expectedError] of [
      [projectedSubscription("sub_orphan", "gm_1", "mm_missing"), "MINHOS_MEMBER_ID_ORPHAN"],
      [projectedSubscription("sub_wrong_pair", "gm_2", "mm_1"), "MEMBER_ID_PAIR_MISMATCH"],
      [{ ...projectedSubscription("sub_partial", "gm_1", "mm_1"), ghost_member_id: "" }, "MEMBER_ID_PAIR_PARTIAL"],
    ] as const) {
      const { repository, spreadsheet } = repositoryWithMembers([
        member("gm_1", "mm_1"), member("gm_2", "mm_2"),
      ]);
      const before = workbookSnapshot(spreadsheet);
      expect(() => repository.upsert("20_Subscriptions", [incoming]))
        .toThrow(`IDENTITY_INTEGRITY:20_Subscriptions:row_2:${expectedError}`);
      expect(workbookSnapshot(spreadsheet)).toEqual(before);
    }

    const { repository, spreadsheet } = repositoryWithMembers([member("gm_1", "mm_1")]);
    const before = workbookSnapshot(spreadsheet);
    expect(() => repository.insertIfAbsent("21_AccessGrants", grantRow("gm_missing", "mm_1")))
      .toThrow("IDENTITY_INTEGRITY:21_AccessGrants:row_2:GHOST_MEMBER_ID_ORPHAN");
    expect(workbookSnapshot(spreadsheet)).toEqual(before);
  });

  it("does not let a Members mutation orphan or remap a Subscription or AccessGrant", () => {
    for (const dependent of ["subscription", "grant"] as const) {
      const { repository, spreadsheet } = repositoryWithMembers([
        member("gm_1", "mm_1"), member("gm_2", "mm_2"),
      ]);
      if (dependent === "subscription") {
        repository.replace("20_Subscriptions", [projectedSubscription("sub_1", "gm_1", "mm_1")]);
      } else {
        repository.replace("21_AccessGrants", [grantRow("gm_1", "mm_1")]);
      }

      for (const [prospectiveMembers, expectedError] of [
        [[member("gm_2", "mm_2")], "MINHOS_MEMBER_ID_ORPHAN"],
        [[member("gm_2", "mm_1"), member("gm_1", "mm_2")], "MEMBER_ID_PAIR_MISMATCH"],
      ] as const) {
        const before = workbookSnapshot(spreadsheet);
        expect(() => repository.replace("10_Members", [...prospectiveMembers]))
          .toThrow(`IDENTITY_INTEGRITY:${dependent === "subscription" ? "20_Subscriptions" : "21_AccessGrants"}:row_2:${expectedError}`);
        expect(workbookSnapshot(spreadsheet)).toEqual(before);
      }
    }
  });

  it("accepts current and tombstoned projection pairs plus a never-projected Stripe-only blank pair", () => {
    const { repository } = repositoryWithMembers([member("gm_1", "mm_1")]);
    expect(() => repository.replace("20_Subscriptions", [
      subscriptionRow("sub_stripe_only"),
      projectedSubscription("sub_projected", "gm_1", "mm_1"),
      {
        ...projectedSubscription("sub_tombstone", "gm_1", "mm_1"),
        source_present_ghost: false,
        source_missing_since: "2026-08-29T00:00:00.000Z",
        last_seen_ghost_run_id: "run_previous",
      },
    ])).not.toThrow();
    expect(() => repository.replace("21_AccessGrants", [grantRow("gm_1", "mm_1")])).not.toThrow();
    expect(repository.read<SubscriptionRow>("20_Subscriptions")).toHaveLength(3);
    expect(repository.read<AccessGrantRow>("21_AccessGrants")).toHaveLength(1);
  });
});

function supplemental(minhosMemberId: string, ghostMemberId: string, responseId: string): SheetRecord {
  return {
    minhos_member_id: minhosMemberId,
    ghost_member_id: ghostMemberId,
    profile_response_id: responseId,
  };
}

function repositoryWithMembers(members: MemberRow[]): {
  repository: SheetsRepository;
  spreadsheet: FakeSpreadsheet;
} {
  const spreadsheet = new FakeSpreadsheet();
  const repository = new SheetsRepository(
    "identity-test",
    spreadsheet as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet,
  );
  repository.initialize();
  repository.replace("10_Members", members);
  return { repository, spreadsheet };
}

function seedSheetRows(sheet: FakeSheet, sheetName: string, rows: SheetRecord[]): void {
  const columns = definitionFor(sheetName).columns;
  sheet.seed([columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]);
}

function member(ghostMemberId: string, minhosMemberId: string): MemberRow {
  return {
    member_row_key: `ghost:site:${ghostMemberId}`, minhos_member_id: minhosMemberId, ghost_site_id: "site",
    ghost_member_id: ghostMemberId, member_uuid: "uuid", email: "member@example.invalid", name: "Member",
    ghost_member_status: "paid", ghost_access_state: "paid", tier_ids: "tier", stripe_customer_ids: "cus",
    stripe_customer_count: 1, qualifying_entitlement_count: 1, profile_status: "not_submitted", ops_flags: "",
    primary_ops_state: "OK", created_at: "", updated_at: "", last_synced_at: "", source_present_ghost: true,
    source_missing_since: "", last_seen_ghost_run_id: "run", source_record_hash: "hash",
  };
}

function subscriptionRow(subscriptionId = "sub_1"): SubscriptionRow {
  return {
    subscription_row_key: `stripe:acct:false:${subscriptionId}`, environment: "test", livemode: false,
    stripe_account_id: "acct", stripe_subscription_id: subscriptionId, stripe_customer_id: "cus_1",
    ghost_member_id: "", minhos_member_id: "", stripe_product_id: "prod", stripe_price_id: "price",
    ghost_price_id: "", ghost_tier_id: "", tier_name: "", unit_amount_minor: 100, currency: "jpy",
    billing_interval: "month", stripe_status: "active", ghost_projected_status: "", status_match: "",
    collection_method: "charge_automatically", pause_collection_behavior: "", cancel_at_period_end: false,
    start_date: "", current_period_start: "", current_period_end: "", canceled_at: "", ended_at: "",
    latest_invoice_id: "", latest_invoice_status: "", open_invoice_count: 0, last_invoice_paid_at: "",
    last_payment_failure_at: "", source_present_stripe: true, source_present_ghost: false,
    source_missing_since: "", last_seen_stripe_run_id: "run", last_seen_ghost_run_id: "", last_synced_at: "",
  };
}

function projectedSubscription(
  subscriptionId: string,
  ghostMemberId: string,
  minhosMemberId: string,
): SubscriptionRow {
  return {
    ...subscriptionRow(subscriptionId),
    ghost_member_id: ghostMemberId,
    minhos_member_id: minhosMemberId,
    ghost_projected_status: "active",
    status_match: "match",
    source_present_ghost: true,
    last_seen_ghost_run_id: "run",
  };
}

function grantRow(
  ghostMemberId = "gm_1",
  minhosMemberId = "mm_1",
  tierId = "tier_1",
): AccessGrantRow {
  return {
    grant_key: `ghost:site:${ghostMemberId}:${tierId}:comped`, minhos_member_id: minhosMemberId,
    ghost_member_id: ghostMemberId, tier_id: tierId, grant_kind: "comped", starts_at: "", expires_at: "", grant_reason: "approved",
    approved_by: "owner", source_present_ghost: true, source_missing_since: "", last_seen_ghost_run_id: "run",
    last_synced_at: "",
  };
}

function workbookSnapshot(spreadsheet: FakeSpreadsheet): Record<string, { matrix: unknown[][]; operations: string[] }> {
  return Object.fromEntries([...spreadsheet.sheets.entries()].map(([name, sheet]) => [name, {
    matrix: sheet.matrix(),
    operations: [...sheet.operations],
  }]));
}
