// Socrata dataset IDs for each year's Paid Parking Occupancy archive.
// Each entry has been live-verified directly against the real Socrata API
// (a request against the ID actually returns records from that year) --
// dataset IDs are opaque, unpredictable codes with no relationship to the
// year they cover, so a new year's ID must never be guessed or assumed to
// follow the same pattern as an existing one. See CLAUDE.md's Known open
// questions for which "prior year" lookups this currently supports.
const YEARLY_ARCHIVE_DATASET_IDS: Readonly<Record<number, string>> = {
  2020: "wtpb-jp8d",
  2025: "7c2e-uany",
};

export function resolveYearlyArchiveDatasetId(year: number): string {
  const datasetId = YEARLY_ARCHIVE_DATASET_IDS[year];
  if (datasetId === undefined) {
    const availableYears = Object.keys(YEARLY_ARCHIVE_DATASET_IDS)
      .map(Number)
      .sort((a, b) => a - b)
      .join(", ");
    throw new Error(
      `resolveYearlyArchiveDatasetId: no live-verified Socrata dataset ID for year ${year}. Available years: ${availableYears}. Live-verify the real dataset ID against Socrata before adding a new year -- never guess or assume it follows the same naming pattern as an existing year.`,
    );
  }
  return datasetId;
}

// Only the calendar year matters here (used to look up a yearly archive
// dataset ID for "the same date one year prior"), not any finer date
// arithmetic, so this is plain subtraction rather than a full date library
// call. Uses getUTCFullYear(), not getFullYear(): a year boundary is the one
// case where local-vs-UTC actually matters here (a date within a few hours
// of Dec 31/Jan 1 could resolve to a different year depending on the
// server's local timezone), the same reasoning blockfaceLookup.ts's
// getIsoDayOfWeek uses getUTCDay() instead of getDay().
export function getPriorYear(targetDate: Date): number {
  if (Number.isNaN(targetDate.getTime())) {
    throw new RangeError("getPriorYear: targetDate is an invalid Date");
  }
  return targetDate.getUTCFullYear() - 1;
}
