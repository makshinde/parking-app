// Inverse of jsDayToIsoDay (src/utils/dateHelpers.ts). Socrata's
// date_extract_dow returns 0=Sunday..6=Saturday -- live-verified against
// literal date expressions (see CLAUDE.md's Architecture section) -- the
// opposite of this project's ISO 8601 day-of-week convention
// (1=Monday..7=Sunday) used everywhere else, e.g. occupancy_stats.day_of_week
// and occupancy_stats_backfill_progress.iso_day. Every day except Sunday
// already lines up between the two conventions, so Sunday is the only
// remapping, same shape as jsDayToIsoDay itself.
export function isoDayToSocrataDow(isoDay: number): number {
  if (!Number.isInteger(isoDay) || isoDay < 1 || isoDay > 7) {
    throw new RangeError(`isoDayToSocrataDow: expected an integer 1-7 (ISO day-of-week), got ${isoDay}`);
  }

  return isoDay === 7 ? 0 : isoDay;
}
