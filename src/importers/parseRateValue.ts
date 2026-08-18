export interface ParsedRateValue {
  rate: number | null;
  note: string | null;
}

// off_street_facilities' rate field (Public Garages and Parking Lots
// dataset) is a free-text string, not a structured number -- most values are
// plain numeric strings ("3", "4.9"), but some are genuine non-numeric text
// ("Permit only", "Call for rates") that describes real pricing information
// which shouldn't be discarded just because it doesn't parse as a number.
//
// A negative value (e.g. "-5") is deliberately treated the same as
// non-numeric text, not clamped to 0 or treated as a parse success: per
// CLAUDE.md's clamp-vs-throw convention, clamping only makes sense when
// there's a meaningful "nearest valid value" for an imprecise-but-real
// estimate. A negative rate has no such nearest value -- an hourly rate is
// never actually negative, so "-5" isn't a slightly-off real price the way a
// days_in_future of -3 might be a slightly-off day count. This function
// never throws, though (unlike a true structurally-invalid case), since it's
// parsing free text from an external dataset, not validating an internal
// input -- so the original text is preserved as `note` instead, same as any
// other non-numeric value, rather than raising an error.
export function parseRateValue(rawValue: string | null): ParsedRateValue {
  if (rawValue === null || rawValue.trim() === "") {
    return { rate: null, note: null };
  }

  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);

  if (Number.isFinite(parsed) && parsed > 0) {
    return { rate: parsed, note: null };
  }

  return { rate: null, note: rawValue };
}
