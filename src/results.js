'use strict';
// Business rules ported 1:1 from the source workbook (Presidential/Senate/House of Reps tabs).

const CONTESTS = {
  presidential: 'Presidential',
  senate: 'Senate',
  reps: 'House of Reps',
};
const FIELDS = ['pdp', 'apc', 'lp', 'accredited', 'valid', 'rejected'];

/** Status per the workbook's column M formula. Values are numbers or null. */
function computeStatus(r, registered) {
  const vals = FIELDS.map((f) => r[f]);
  const present = vals.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return 'Missing';
  if (present.length < 6) return 'Incomplete';
  const { pdp, apc, lp, accredited, valid, rejected } = r;
  const total = valid + rejected;
  if (
    vals.some((v) => v < 0 || !Number.isInteger(v)) ||
    pdp + apc + lp > valid ||
    total > accredited ||
    accredited > registered
  ) return 'Check figures';
  return 'Complete';
}

/** Returns {values, error}. Blank/null -> null ("unknown"), 0 is a confirmed zero. */
function parseInput(body) {
  const values = {};
  for (const f of FIELDS) {
    const raw = body[f];
    if (raw === null || raw === undefined || raw === '') { values[f] = null; continue; }
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { error: `${f} must be a whole number of 0 or more.` };
    values[f] = n;
  }
  const notes = String(body.notes ?? '').slice(0, 500);
  return { values, notes };
}

function decorate(row) {
  // row: joined polling unit + result columns
  const hasTotal = row.valid !== null && row.valid !== undefined && row.rejected !== null && row.rejected !== undefined;
  const total = hasTotal ? row.valid + row.rejected : null;
  const status = computeStatus(row, row.registered);
  const turnout = status === 'Complete' && row.registered > 0 ? total / row.registered : null;
  return { ...row, total, status, turnout };
}

module.exports = { CONTESTS, FIELDS, computeStatus, parseInput, decorate };
