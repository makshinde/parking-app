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

When adding a new function, decide which category each input falls into
individually. A single function can have both kinds of input.

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

## Out of scope (v1)

- Individually owned/rented parking spaces (driveway rentals, etc., the
  SpotHero/Neighbor.com model). This data only exists inside private
  marketplace platforms, not public datasets, and would require a paid
  API integration. Revisit only if this moves beyond a hobby project.