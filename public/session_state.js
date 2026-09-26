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
}

/** Stores the provider's usage report for the turn. */
export function noteUsage(session, usage) {
  session.lastUsage = usage;
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
