const MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

function parseMoney(value, { allowZero = false } = {}) {
  const raw = typeof value === 'number'
    ? String(value)
    : String(value ?? '').trim();

  if (!MONEY_RE.test(raw)) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || (!allowZero && parsed <= 0)) return null;

  return Math.round(parsed * 100) / 100;
}

function parsePositiveMoney(value) {
  return parseMoney(value, { allowZero: false });
}

function parseNonNegativeMoney(value) {
  return parseMoney(value, { allowZero: true });
}

module.exports = {
  parseMoney,
  parsePositiveMoney,
  parseNonNegativeMoney,
};
