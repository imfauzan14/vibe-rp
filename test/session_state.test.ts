// The derived-session-state seam. These functions used to be inline
// assignments inside `streamTurn`; concentrating them gives the fold result,
// the usage report and the three continuity latches one owner. The transition
// rules are the load-bearing part: the reader must be warned once per state
// change, not once per turn.
import { describe, test, expect } from "bun:test";
import {
  applyFold,
  resetLedger,
  noteUsage,
  markLedgerTruncated,
  setOverflowReported,
  setCondensedReported,
  ledgerDescribes,
  resetLedgerIfInvalidated,
} from "../public/session_state.js";

describe("applyFold", () => {
  test("stores the ledger and the covered index when a ledger was produced", () => {
    const session = { ledger: "", consumed: 1 };
    const stored = applyFold(session, { ledger: "folded facts", consumedAfter: 7 });
    expect(stored).toBe(true);
    expect(session.ledger).toBe("folded facts");
    expect(session.consumed).toBe(7);
  });

  test("is a no-op when the fold produced no ledger", () => {
    const session = { ledger: "prior", consumed: 3 };
    const stored = applyFold(session, { ledger: "", consumedAfter: 9 });
    expect(stored).toBe(false);
    expect(session.ledger).toBe("prior");
    expect(session.consumed).toBe(3);
  });
});

describe("resetLedger", () => {
  test("clears ledger, consumed, and notice latches regardless of prior state", () => {
    const session = {
      ledger: "prior facts",
      consumed: 7,
      ledgerTruncated: true,
      ledgerOverflowReported: true,
      ledgerCondensedReported: true,
    };
    resetLedger(session);
    expect(session.ledger).toBe("");
    expect(session.consumed).toBe(0);
    expect(session.ledgerTruncated).toBe(false);
    expect(session.ledgerOverflowReported).toBe(false);
    expect(session.ledgerCondensedReported).toBe(false);
  });

  test("is idempotent on an already-empty session", () => {
    const session = { ledger: "", consumed: 0 };
    resetLedger(session);
    expect(session.ledger).toBe("");
    expect(session.consumed).toBe(0);
  });
});

describe("noteUsage", () => {
  test("records the provider usage report", () => {
    const session = {};
    noteUsage(session, { prompt_tokens: 10, completion_tokens: 4 });
    expect(session.lastUsage).toEqual({ prompt_tokens: 10, completion_tokens: 4 });
  });
});

describe("markLedgerTruncated", () => {
  test("sets the lossy marker and never clears it", () => {
    const session = {};
    markLedgerTruncated(session);
    expect(session.ledgerTruncated).toBe(true);
    markLedgerTruncated(session);
    expect(session.ledgerTruncated).toBe(true);
  });
});

describe("transition latches", () => {
  test("overflow latch reports true only on the change", () => {
    const session = {};
    expect(setOverflowReported(session, true)).toBe(true);   // off -> on
    expect(setOverflowReported(session, true)).toBe(false);  // already on
    expect(setOverflowReported(session, false)).toBe(true);  // on -> off
    expect(setOverflowReported(session, false)).toBe(false); // already off
  });

  test("condensed latch reports true only on the change", () => {
    const session = {};
    expect(setCondensedReported(session, true)).toBe(true);
    expect(setCondensedReported(session, true)).toBe(false);
    expect(setCondensedReported(session, false)).toBe(true);
    expect(setCondensedReported(session, false)).toBe(false);
  });

  test("the two latches are independent", () => {
    const session = {};
    setOverflowReported(session, true);
    expect(session.ledgerCondensedReported).toBeUndefined();
    expect(setCondensedReported(session, true)).toBe(true);
    expect(session.ledgerOverflowReported).toBe(true);
  });
});

describe("ledgerDescribes and resetLedgerIfInvalidated", () => {
  test("reports false when session has no ledger", () => {
    const session = { ledger: "", consumed: 5 };
    expect(ledgerDescribes(session, 2)).toBe(false);
    expect(resetLedgerIfInvalidated(session, 2)).toBe(false);
  });

  test("reports true for an edit inside [1, consumed)", () => {
    const session = { ledger: "fact", consumed: 4 };
    expect(ledgerDescribes(session, 0)).toBe(false); // pinned opener edit does not invalidate
    expect(ledgerDescribes(session, 1)).toBe(true);
    expect(ledgerDescribes(session, 3)).toBe(true);
    expect(ledgerDescribes(session, 4)).toBe(false); // live tail edit does not invalidate
  });

  test("reports true for deleting the pinned opening (idx: 0) when consumed > 1", () => {
    const session = { ledger: "fact", consumed: 3 };
    expect(ledgerDescribes(session, 0, { removes: true })).toBe(true);
    const emptySess = { ledger: "fact", consumed: 1 };
    expect(ledgerDescribes(emptySess, 0, { removes: true })).toBe(false);
  });

  test("resetLedgerIfInvalidated clears the ledger only when invalidated", () => {
    const session = { ledger: "fact", consumed: 4 };
    expect(resetLedgerIfInvalidated(session, 5)).toBe(false);
    expect(session.ledger).toBe("fact");
    expect(resetLedgerIfInvalidated(session, 2)).toBe(true);
    expect(session.ledger).toBe("");
    expect(session.consumed).toBe(0);
  });
});
