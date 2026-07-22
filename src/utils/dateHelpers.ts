// JS Date.getDay() returns 0=Sunday..6=Saturday. Every day except Sunday
// already lines up with its ISO 8601 number, so Sunday is the only remapping.
export function jsDayToIsoDay(jsDay: number): number {
  if (!Number.isInteger(jsDay) || jsDay < 0 || jsDay > 6) {
    throw new RangeError(
      `jsDayToIsoDay: expected an integer 0-6 (Date.getDay() range), got ${jsDay}`,
    );
  }

  return jsDay === 0 ? 7 : jsDay;
}
