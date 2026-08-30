import type { RunLease } from "./types";

export function isLeaseActive(lease: RunLease | null, nowMs: number): boolean {
  return Boolean(lease && lease.expiresAtMs > nowMs);
}

export function createLease(runId: string, nowMs: number, ttlMs: number, ownerId = runId): RunLease {
  if (ttlMs <= 0) throw new Error("Lease TTL must be positive");
  return { runId, ownerId, expiresAtMs: nowMs + ttlMs };
}

export function isLeaseHolder(lease: RunLease | null, runId: string, ownerId = runId): boolean {
  return lease?.runId === runId && (lease.ownerId ?? lease.runId) === ownerId;
}

export function canClearLease(lease: RunLease | null, runId: string, ownerId = runId): boolean {
  return isLeaseHolder(lease, runId, ownerId);
}
