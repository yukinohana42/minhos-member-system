/**
 * Use one script-wide coordination primitive for every read/reconcile/write
 * transaction that touches the exception ledger.  Keeping the lock wrapper
 * here also makes the release-on-error guarantee independently testable.
 */
export function withScriptLock<T>(work: () => T, timeoutMs = 10_000): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs)) throw new Error("SCRIPT_COORDINATION_LOCK_BUSY");
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}
