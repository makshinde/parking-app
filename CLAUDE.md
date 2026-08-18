# Parking Availability App

A hobby project to find likely parking availability near a destination,
using historical city data, OpenStreetMap, and an LLM synthesis layer.
Intended to be public on GitHub and used by others, so code should be
written to a production-quality standard, not throwaway hobby code.

## Conventions

- Write TypeScript with clear types, no `any` unless unavoidable.
- Every function that contains logic (not simple pass-through code)
  should have accompanying tests covering normal cases, edge cases,
  and invalid input.
- Never hardcode secrets or API keys. Use environment variables and
  keep a `.env.example` file updated when new variables are added.
- Keep functions small and single-purpose. Prefer several small,
  well-named functions over one large function.
- Add a short comment explaining the "why" for any non-obvious logic,
  especially scoring formulas or thresholds.
- Follow standard formatting (Prettier defaults).
- Day-of-week values are ISO 8601 (1=Monday..7=Sunday) everywhere in this
  project, matching the database schema. JavaScript's native Date.getDay()
  returns 0=Sunday..6=Saturday, so any code converting a JS Date into a
  day-of-week for querying the database MUST use the shared
  jsDayToIsoDay() helper (see src/utils/dateHelpers.ts), never inline math.
- Relative imports in src/ MUST include the explicit `.ts` extension (e.g.
  `from "./assembleBlockface.ts"`, not `from "./assembleBlockface"`). Vite/
  Vitest resolve extensionless imports fine, so this is easy to miss, but
  standalone scripts run directly via `node` (e.g. import-blockfaces.ts) use
  Node's native ESM resolver, which does no extension-guessing and fails
  with ERR_MODULE_NOT_FOUND on an extensionless specifier. tsconfig.json's
  `allowImportingTsExtensions` permits this alongside the project's
  `moduleResolution: "Bundler"` setting.

## Pricing data — read before touching anything rate-related

**`blockfaces.starting_rate_usd` is ONLY the first weekday morning tier's
rate.** It is NOT a representative price, NOT an average, and NOT "the" rate
for a blockface. A paid blockface can have up to 3 rate tiers per day-type
(WKD/SAT/SUN), each with its own time window and rate (see `rate_tiers`,
`migrations/003_add_rate_tiers.sql`) -- e.g. $2.50 8-11am, $1.50 11am-5pm, $1
5-8pm on weekdays, with a completely different Saturday schedule and no
Sunday charge at all. `starting_rate_usd` only ever captures the first of
those numbers.

**Any future frontend or API work that displays or otherwise surfaces
pricing to an end user MUST pull and show the full schedule from
`rate_tiers` for the relevant day/time, never `starting_rate_usd` alone.**
Showing `starting_rate_usd` by itself as "the" rate would be actively
misleading -- a user could see "$2.50" and park expecting that price at
5pm, when the real rate then is $1. `starting_rate_usd` exists only for
quick display/filtering/sorting use cases (e.g. "blocks starting under $2"),
never as a final price shown to a user without the full schedule alongside
it.

## Architecture

- Frontend: built separately in Lovable
- Backend: Supabase Edge Functions (TypeScript)
- Database: Supabase Postgres with PostGIS
- Data sources: Seattle SDOT open data (historical), OpenStreetMap
  Nominatim (geocoding) and Overpass API (off-street lots)
- LLM: used only for final synthesis of structured results into
  plain language, not for any core calculation
- Predictions are precomputed by a periodic batch aggregation job that
  populates occupancy_stats; the Edge Function reads directly from that
  table at request time, giving fast, millisecond-level responses rather
  than live-querying Socrata per request.

  occupancy_stats (schema.sql, migrations/002's comment references it as
  predating the migrations/ tracking system) is the actively-used,
  **primary storage for these precomputed predictions** -- not an unused
  or optional layer. It does need populating via the batch job described
  below before predictions can work; that batch job has not yet been
  built as of this note.

  For each blockface/day-of-week/hour bucket, the batch job:
  1. Pulls that bucket's full year of matching readings using server-side
     day-of-week and hour filtering (Socrata's date_extract_dow and
     date_extract_hh), not a narrow date window -- live-verified to work
     correctly, including combined with a date-range and sourceelementkey
     filter in a single $where clause, across all three relevant datasets
     (rke9-rsvs, wtpb-jp8d, and 7c2e-uany). 91 queries per year cover
     every day-of-week/hour bucket combination in scope.
  2. Normalizes and weights those raw readings using the already-built
     aggregation functions: normalizeReading (blockface matching,
     isoDay/hour/ageInDays/occupancyRatio per reading), calculateRecencyWeight
     (recency + seasonal weighting per reading, computed from each
     reading's own real date), calculateWeightedStats (weighted mean/stdDev
     across that bucket's full year of matching readings),
     calculateOccupancyRatio, and jsDayToIsoDay.
  3. Writes the resulting mean/stdDev/sample_count into occupancy_stats --
     but only when that bucket's reading count is at least
     MIN_READINGS_PER_BUCKET (30); below that, no row is written for the
     bucket at all, rather than writing a mean/stdDev backed by too little
     data. This number comes from live-querying the real distribution of
     readings-per-bucket (2025 archive, several real blockface/day/hour
     combinations, both a common bucket -- Monday 9am, 1529 blockfaces --
     and a rarer one -- Monday 8pm, 258 blockfaces): the distribution is
     essentially bimodal, not a smooth taper. A bucket either has zero
     readings (the blockface genuinely doesn't operate that day/hour -- e.g.
     confirmed zero Sunday readings for several elements) or, if it operates
     at all, has at least 60 readings in the common bucket and 120 in the
     rarer one, with the bulk of buckets in the 400-2760+ range and fewer
     than 1% of non-empty buckets falling below 150. 30 sits comfortably
     below every real non-empty bucket actually observed (roughly half the
     lowest one seen), leaving margin for a blockface with only partial-year
     coverage (e.g. newly added mid-year, or affected by one of the
     documented Socrata data gaps) to still clear the bar, while still
     rejecting a handful of stray readings from a data glitch as
     insufficient to write a confident statistic from.

  Deliberately no hard window (e.g. "only readings within N days of the
  seasonal anniversary") -- a hard cutoff would arbitrarily discard
  meaningful nearby-season data and flatten everything inside the window to
  equal weight, when calculateRecencyWeight's existing seasonal decay
  already handles "closer to the anniversary matters more" more precisely,
  per each reading's actual date: live-verified, a reading 30 days from the
  seasonal anniversary still retains about 25% of peak seasonal weight, not
  zero, so it's still meaningfully counted at a reduced weight rather than
  discarded outright by an arbitrary cutoff.

  The batch job needs a Socrata app token (free, registered at
  data.seattle.gov), given the real request volume involved --
  unauthenticated requests are much more aggressively rate-limited. The job
  should also be resumable rather than requiring a full restart if
  interrupted partway through, given how long a full run across all
  blockfaces and years of history is likely to take.

## Handling invalid input

Two categories, handled differently:

- Continuous/estimated inputs (things like counts, ratios, or "roughly N
  days from now") get clamped to the valid range and logged as a warning,
  since an out-of-range value likely still reflects real, if imprecise,
  intent. The function keeps running and returns a best-effort result.
- Discrete/categorical inputs (things with a fixed, exact set of valid
  values, like day-of-week) throw an error on invalid input instead of
  clamping, since there's no meaningful "nearest valid value" and an
  out-of-range value signals a real bug upstream, not imprecision.

The clamp-vs-throw split isn't strictly about data type, though: a
continuous/estimated input still throws instead of clamping when the value
is structurally invalid (NaN, Infinity, or anything else with no meaningful
"nearest valid" interpretation), as opposed to merely out-of-range (a
days_in_future of 30, or a std_dev of 1.5). A structurally invalid value has
nothing sensible to clamp toward, same reasoning as the discrete/categorical
case, just triggered by the kind of invalidity rather than the kind of data.
reprojectCoordinates.ts's RangeError on non-finite x/y is the first example
of this: x and y are continuous (any finite number could be a real
coordinate), but NaN/Infinity get rejected, not clamped.

When adding a new function, decide which category each input falls into
individually, and within continuous/estimated inputs, whether an invalid
value is out-of-range (clamp) or structurally invalid (throw). A single
function can have multiple kinds of input.

## Known open questions

- RESOLVED (was: "418 of the pay-station SEGKEYs have only one recorded
  side"): the full live import run (import-blockfaces.ts, no --limit)
  resolved this. Of the single-sided segments, only 29 were genuine
  DATA_GAP cases (curb-spaces shows SPACETYPE='PS' evidence but no matching
  pay-station record); the rest resolved cleanly as either UNPAID_CONFIRMED
  (confirmed no paid parking on that side) or PAID (a pay station did exist,
  just not flagged by the original 418 estimate's method). 29 is the real,
  current count of unresolved DATA_GAP blockfaces -- see
  resolveBlockfaceSides.ts's console.warn output for exactly which ones.
- off_street_facilities data (Public Garages and Parking Lots dataset) has
  only ~2-4% coverage on rate, operator, and facility_type fields, and 0%
  on payment_type. Capacity (99%) and address (97%) are reliable. Any code
  using this table must handle rate/operator as legitimately absent for
  most rows, not treat nulls as a bug.
- parkingspacecount for a given blockface (sourceelementkey) is not stable
  across years in the Paid Parking Occupancy data (verified example:
  element 1029 was 8 spaces in 2020, 7 in 2025). Any occupancy aggregation
  MUST use the parkingspacecount from the same row being aggregated, never
  a cached or separately-joined value, or ratios will be silently wrong.
- There is a real, verified data gap in 2026 Paid Parking Occupancy data
  between 2026-04-01 and 2026-07-02 (roughly 3 months), plus smaller
  ~34-hour gaps at every year boundary between archives. Aggregation logic
  and confidence scoring must account for genuinely missing coverage, not
  assume continuous data.
- The Seattle Streets FeatureServer (the source for street name and cross
  streets) has no SEGKEY field at all -- it's keyed by COMPKEY. Verified
  live that Streets.COMPKEY equals the SEGKEY used in Paid Area Curb Spaces
  and SDOT Pay Stations (e.g. SEGKEY 3018 matches COMPKEY 3018 = "20TH AVE
  NW between NW MARKET ST and NW 56TH ST", consistent with curb-spaces'
  BLOCKID "NW20-55"; SEGKEY 2535 matches COMPKEY 2535 = "18TH AVE between E
  JEFFERSON ST and E CHERRY ST", consistent with that pay station's
  PAIDAREA "Cherry Hill"). Code joining these datasets must match
  Streets.COMPKEY against the parking datasets' SEGKEY, not look for a
  SEGKEY field on Streets.
- SDOT Pay Stations records can have up to 3 rate tiers per day-type (WKD,
  SAT, SUN), each with its own rate/start/end (WKD_RATE1..3,
  WKD_START1/END1..3, and equivalents for SAT_*/SUN_*, start/end given as
  minutes since midnight). A day-type with no paid parking there has all
  its RATE fields null (e.g. SUN_RATE1-3 null at a location with no Sunday
  charge) -- that's normal, not missing data. This is modeled by the
  rate_tiers table (see migrations/003_add_rate_tiers.sql), not by
  blockfaces.starting_rate_usd alone, which only holds a representative
  summary (the first weekday tier's rate) for quick display/filtering.
- SIDE values in Paid Area Curb Spaces and SDOT Pay Stations are not limited
  to the 4 cardinal directions (N/S/E/W). Live-verified: a 2,000-record
  curb-spaces sample and the full ~1,600-row pay-stations dataset both show
  roughly 40-50% of records reporting an intercardinal side (NE/NW/SE/SW),
  reflecting Seattle's many diagonal streets (e.g. downtown's diagonal grid,
  Ballard Ave) -- not rare outliers. blockfaces.side_of_street and
  resolveBlockfaceSides.ts's Side type model all 8 directions (see
  migrations/006_expand_side_of_street_directions.sql); code must not assume
  only 4 are possible.
- The full live import run (import-blockfaces.ts, no --limit) skipped 48
  ELMNTKEYs. None of these are in scope to fix right now -- documented here
  as known, small, real gaps, not silently dropped data:
  1. The majority are duplicate pay-station records for the same
     ELMNTKEY/side. resolveBlockfaceSides.ts's assertNoDuplicatePayStationSides
     currently rejects any duplicate outright (throws), on the reasoning that
     a segment should have at most one pay-station record per side and more
     than one signals a bad join. But earlier live analysis of duplicates
     showed that, for a given ELMNTKEY, duplicate pay-station records tend to
     have matching rates -- i.e. often genuinely the same real-world pay
     station appearing twice in the source data, not a join bug. Worth
     considering relaxing this check to accept duplicates when their rates
     agree, and only reject when they genuinely conflict (different rates for
     the same ELMNTKEY/side). Not done yet -- these ELMNTKEYs are still
     skipped as-is.
  2. A handful of ELMNTKEYs have a SEGKEY with no matching Streets record.
     This is a genuine small gap in the source city data (Seattle Streets
     simply doesn't have a row for that COMPKEY) -- not something fixable in
     our code, since there's no street name/cross-streets/geometry to
     assemble a blockface from.
  3. Two one-off anomalies worth a closer look eventually, but not urgent:
     one record with SIDE="C", which isn't one of the 8 valid compass
     directions; and one record with a rate set but no matching time window
     (SAT_RATE1 present, SAT_START1/SAT_END1 both null) -- extractRateTiers
     in assembleBlockface.ts currently throws on exactly this shape (rate
     without start/end), which is why it's skipped rather than assembled
     with a guessed time window.
- The Public Garages and Parking Lots FeatureServer has two overlapping name
  fields, DEA_FACILITY_NAME and FAC_NAME, not one. Live-verified against a
  700-record sample (the full live dataset): DEA_FACILITY_NAME is populated
  for 99.7% of records, FAC_NAME for 98.9%, and zero records are missing
  both. Where the two disagree (22 of 700 records), the difference is almost
  always cosmetic formatting (e.g. "AMAZON PHASE 1B - 81866" vs "AMAZON
  PHASE 1B #81866"), not a substantive naming conflict. import-off-street-
  facilities.ts's mapFeatureToFacility() prefers DEA_FACILITY_NAME, falling
  back to FAC_NAME only when it's absent, since DEA_FACILITY_NAME has
  slightly higher coverage and reads as the more canonical business-license
  name in the cases where they differ.
- BUSLIC_LOCATION_ID (used as off_street_facilities.source_facility_id, see
  schema.sql) is 100% populated in that same 700-record sample but not
  always unique -- only 685 of 700 records have a distinct value. Every
  duplicate found was verified to be the same physical facility recorded
  twice in the source data (identical name, address, and geometry; only
  OBJECTID/GlobalID differ), not two different facilities sharing an ID.
  This is harmless under import-off-street-facilities.ts's upsert pattern
  (ON CONFLICT (source_facility_id) DO UPDATE): re-upserting a duplicate
  under the same key just overwrites the row with identical data, so 700
  raw records correctly collapse into 685 real rows. Not deduplicated in
  code, since the upsert already produces the correct result on its own.
- Socrata's Paid Parking Occupancy dataset (rke9-rsvs and its yearly
  archives) returns numeric fields -- paidoccupancy, parkingspacecount,
  and others -- as strings, not numbers (live-verified, e.g.
  "paidoccupancy": "1"). Whatever code eventually reads raw rows from this
  dataset must explicitly parse these fields to numbers before passing them
  to calculateOccupancyRatio.ts or calculateRecencyWeight.ts, both of which
  expect real numbers, not numeric strings -- do not assume Socrata's JSON
  API returns numbers already.
- resolveYearlyArchiveDatasetId (src/aggregation/resolveYearlyArchive.ts)
  only has live-verified Socrata dataset IDs for 2020 ("wtpb-jp8d") and
  2025 ("7c2e-uany"). The live on-demand prediction flow's "5-day window
  centered on the same date one year prior" (see Architecture section)
  only works today for requests where that prior year is 2020 or 2025 --
  any other year throws rather than guessing. Real time will require
  adding more years going forward (2026 becomes "last year" starting in
  2027, and so on); each new year's dataset ID MUST be live-verified
  directly against the real Socrata catalog before being added to the
  map, never guessed or assumed to follow the same naming pattern as an
  existing year -- Socrata dataset IDs are opaque codes with no
  relationship to the year they cover.

## Out of scope (v1)

- Individually owned/rented parking spaces (driveway rentals, etc., the
  SpotHero/Neighbor.com model). This data only exists inside private
  marketplace platforms, not public datasets, and would require a paid
  API integration. Revisit only if this moves beyond a hobby project.

## Future ideas (not in scope for v1)

- Computer-vision-based live occupancy detection using SDOT's public traffic
  camera feeds (~200 cameras citywide via the "Traffic Cameras" dataset on
  Seattle GIS). Would require an object detection model (e.g. YOLO, either
  off-the-shelf for general car detection or fine-tuned on labeled parking
  images), inference infrastructure, and a reliable refresh cycle. Not
  pursued for v1 because camera coverage (~200 cameras, positioned for
  traffic/congestion monitoring) is much sparser than the ~1,500+ blockfaces
  already covered by the verified SDOT parking datasets, and cameras aren't
  necessarily angled to see curb-side parking clearly. Worth revisiting only
  if scope narrows to a small, specific area with confirmed good camera
  coverage of the actual parking spaces, where it could offer real-time
  ground truth the statistical approach can't. A lighter-weight interim
  idea: link to the nearest traffic camera image next to a predicted block,
  so a person can visually spot-check the prediction themselves before
  walking over.

## Git workflow

Use a branch and PR for anything that changes logic, either going forward
(new or modified functions, schema or migration changes, new conventions
future code must follow) or retrospectively (changing how existing code
behaves). Commit directly to main for documentation-only changes that don't
affect behavior, like adding a "known open question" or "future idea" note,
typo fixes, or comment clarifications. When in doubt about which category a
change falls into, ask rather than assume.

When deciding whether to bundle two related changes into one PR or keep them
as separate PRs, the deciding factor is shared purpose, not shared file or
timing. If two changes are independently motivated -- each would make sense
to review or revert on its own -- keep them as separate PRs even if they
touch the same file in the same session.

After completing a meaningful, working change (a new feature, a bug 
fix, a refactor, or a completed step in a larger task), do the 
following automatically without waiting to be asked:

1. Run `git status` and `git diff` to review what changed.
2. Stage only the relevant files with `git add`, never use `git add .` 
   blindly if unrelated or unfinished files are also present.
3. Write a commit message that describes what changed and why, in 
   this format:
   - First line: a short summary (under 60 characters), imperative 
     mood, e.g. "Add rate table validation for pay stations"
   - If needed, a blank line followed by 1-3 lines of additional 
     context
4. Commit with that message.
5. Push to GitHub.

Do NOT commit after every small edit. Batch related changes into one 
logical commit that represents a complete, working unit of work.

Before every commit, confirm no .env files, API keys, Supabase 
credentials, or other secrets are included in the staged changes. If 
anything suspicious is staged, stop and flag it instead of committing.
This repo is public, so anything committed is visible immediately, not just for this session, always.

If a change leaves the app in a broken or non-functional state, do 
not commit it yet. Wait until it's working again.