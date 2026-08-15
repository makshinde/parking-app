-- Widens blockfaces.side_of_street from the 4 cardinal directions to all 8
-- compass directions. Live-verified against Paid_Area_Curb_Spaces and
-- SDOT_Pay_Stations (services.arcgis.com/ZOyb2t4B0UYuYNYH): SIDE is not
-- limited to N/S/E/W in the real data -- roughly 40-50% of real records
-- report an intercardinal side (NE/NW/SE/SW), reflecting Seattle's many
-- diagonal streets (e.g. downtown's diagonal grid, Ballard Ave). These are
-- real, meaningfully-represented values, not rare/invalid outliers, so the
-- constraint (and resolveBlockfaceSides.ts's Side type) is corrected to
-- model them rather than rejecting or silently dropping that data.
-- Postgres auto-names an inline column CHECK as <table>_<column>_check
-- when no explicit CONSTRAINT name is given, which is what schema.sql's
-- original side_of_street CHECK produces.
ALTER TABLE blockfaces DROP CONSTRAINT blockfaces_side_of_street_check;

ALTER TABLE blockfaces ADD CONSTRAINT blockfaces_side_of_street_check
  CHECK (side_of_street IN ('N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'));
