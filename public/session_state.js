// The session's derived-state seam.
//
// A session is a plain data bag (`messages`, `ledger`, `consumed`, plus a few
// one-shot notice flags). `messages` is the canonical, append-only transcript
// and is written only by the controller. Everything else here is *derived*
// state the engine computes while running a turn: the folded ledger, how much
// of the transcript it covers, the last provider usage report, and the flags
// that remember which continuity warning the reader has already been shown.
//
// Those writes used to be scattered through `streamTurn` as raw assignments.
// Concentrating them here gives the derived state one owner, so the eventual
// turn state machine can lift it without also lifting the engine, and so the
// "notify only on the transition" rule has a single home.
//
// Deliberately a leaf module: no imports, no DOM, no I/O. Pure data in, pure
// data out — the caller keeps the presentation (which notice to show).

/** Records the result of a fold. Returns true when a ledger was actually stored. */
export function applyFold(session, { ledger, consumedAfter }) {
  if (!ledger) return false;
  session.ledger = ledger;
  session.consumed = consumedAfter;
  return true;
}

/**
 * Clears the ledger and resets coverage to zero. Used when a user action
 * (e.g. deleting the pinned opening message) invalidates all ledger
 * bookkeeping so the next plan can re-pin from scratch.
 */
export function resetLedger(session) {
  session.ledger = "";
  session.consumed = 0;
  session.ledgerTruncated = false;
  session.ledgerOverflowReported = false;
  session.ledgerCondensedReported = false;
}

/**
 * Captures the derived state a reversible action has to be able to put back.
 *
 * `resetLedger` is destructive on purpose, but a UI action built on it can be
 * undone (deleting a message, then changing your mind), and an undo that
 * restores `messages` without restoring `consumed` leaves the coverage index
 * describing a different run of the transcript — so the next fold summarizes
 * messages the ledger already holds.
 */
export function captureLedgerState(session) {
  return {
    ledger: session.ledger,
    consumed: session.consumed,
    ledgerTruncated: session.ledgerTruncated,
    ledgerOverflowReported: session.ledgerOverflowReported,
    ledgerCondensedReported: session.ledgerCondensedReported,
  };
}

/** Puts back what `captureLedgerState` took. */
export function restoreLedgerState(session, snapshot) {
  if (!session || !snapshot) return false;
  session.ledger = snapshot.ledger;
  session.consumed = snapshot.consumed;
  session.ledgerTruncated = snapshot.ledgerTruncated;
  session.ledgerOverflowReported = snapshot.ledgerOverflowReported;
  session.ledgerCondensedReported = snapshot.ledgerCondensedReported;
  return true;
}

/** Stores the provider's usage report for the turn. */
export function noteUsage(session, usage) {
  session.lastUsage = usage;
}

/**
 * Stores the reconciliation of the app's estimate against the provider's bill:
 * billed input, cached tokens, reasoning tokens, and whether the output ceiling
 * was honoured. `lastUsage` is the raw provider document; this is the derived
 * reading of it, and it is what the context inspector shows.
 */
export function noteUsageReport(session, report) {
  session.lastUsageReport = report;
}

/**
 * Marks the ledger as lossy (cut off at the size ceiling). Unlike the two
 * latches below this is a plain marker, not a transition: the flag is never
 * cleared, so the caller keeps warning while the ledger stays at the ceiling.
 * (The flag itself is currently write-only; it is kept as the session's record
 * of lossiness for the turn state machine to consume.)
 */
export function markLedgerTruncated(session) {
  session.ledgerTruncated = true;
}

/**
 * Sets the "overflow was reported" latch. Returns true only when the value
 * changes, so the caller reports the transition rather than every turn.
 */
export function setOverflowReported(session, reported) {
  const next = Boolean(reported);
  const previous = Boolean(session.ledgerOverflowReported);
  session.ledgerOverflowReported = next;
  return previous !== next;
}

/** @see setOverflowReported — same transition rule for the condensed latch. */
export function setCondensedReported(session, reported) {
  const next = Boolean(reported);
  const previous = Boolean(session.ledgerCondensedReported);
  session.ledgerCondensedReported = next;
  return previous !== next;
}
