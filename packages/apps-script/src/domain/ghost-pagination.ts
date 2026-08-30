import type { GhostMembersPage } from "./types";

/**
 * Ghost mark-and-sweep is only safe when every page is proven to have been
 * visited. Treat pagination metadata as part of the API schema, not as an
 * optional optimisation.
 */
export function nextGhostPage(result: GhostMembersPage, requestedPage: number): number | null {
  const pagination = result.meta?.pagination;
  if (!pagination) throw new Error("SCHEMA_MISMATCH:ghost_members.meta.pagination");

  const { page, pages, next } = pagination;
  if (
    typeof page !== "number" ||
    typeof pages !== "number" ||
    !Number.isInteger(page) ||
    !Number.isInteger(pages) ||
    page !== requestedPage ||
    pages < 1 ||
    page < 1 ||
    page > pages
  ) {
    throw new Error("SCHEMA_MISMATCH:ghost_members.meta.pagination.bounds");
  }

  if (typeof next === "number" && next <= requestedPage) {
    throw new Error("PAGINATION_NO_PROGRESS:ghost_members");
  }

  const expectedNext = page < pages ? page + 1 : null;
  if (next !== expectedNext) {
    throw new Error("SCHEMA_MISMATCH:ghost_members.meta.pagination.next");
  }
  return expectedNext;
}
