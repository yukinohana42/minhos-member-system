import { afterEach, describe, expect, it, vi } from "vitest";
import { withScriptLock } from "../src/adapters/script-lock";

afterEach(() => vi.unstubAllGlobals());

describe("shared exception-ledger coordination lock", () => {
  it("executes while held and always releases, including on failure", () => {
    let held = false;
    let releases = 0;
    vi.stubGlobal("LockService", {
      getScriptLock: () => ({
        tryLock: () => { held = true; return true; },
        releaseLock: () => { held = false; releases += 1; },
      }),
    });

    expect(withScriptLock(() => { expect(held).toBe(true); return "done"; })).toBe("done");
    expect(held).toBe(false);
    expect(() => withScriptLock(() => { expect(held).toBe(true); throw new Error("boom"); })).toThrow("boom");
    expect(held).toBe(false);
    expect(releases).toBe(2);
  });

  it("does not enter the transaction when another Form/sync writer holds the lock", () => {
    const work = vi.fn();
    vi.stubGlobal("LockService", {
      getScriptLock: () => ({ tryLock: () => false, releaseLock: vi.fn() }),
    });
    expect(() => withScriptLock(work)).toThrow("SCRIPT_COORDINATION_LOCK_BUSY");
    expect(work).not.toHaveBeenCalled();
  });
});
