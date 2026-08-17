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

- 418 of the pay-station SEGKEYs have only one recorded side, meaning
  we don't yet know whether the other side of those blocks genuinely
  has no paid parking, or whether it's a real gap in the source data.
  Must be resolved when writing the import/aggregation script, don't
  silently assume "no paid parking" for missing sides without checking
  against curb-spaces SPACETYPE='PS' rows for that ELMNTKEY first.
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
  blockfaces.hourly_rate_usd alone, which only holds a representative
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