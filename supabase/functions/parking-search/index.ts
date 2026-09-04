// Thin Deno.serve entry point. All real decision-making (validation,
// calling geocodeAddress/resolveRequestTime/the spatial RPCs/
// assembleSearchResults, classifying failures) lives in
// handleParkingSearchRequest.ts (src/edge-function/) -- fully testable on
// its own, with no Request/Response/Deno.serve coupling. This file only
// touches the HTTP-transport concerns that function can't own: CORS,
// method checking, and turning its {response, status} into a real
// Response.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  handleParkingSearchRequest,
  type HandleParkingSearchRequestDeps,
  type ParkingSearchRpcClient,
} from "../../../src/edge-function/handleParkingSearchRequest.ts";
import type { GeocodeCacheSupabaseClient } from "../../../src/geocoding/geocodeAddress.ts";
import type { OccupancyStatsSupabaseClient } from "../../../src/scoring/assembleSearchResults.ts";

// Standard Supabase Edge Function CORS boilerplate. Access-Control-Allow-
// Origin is deliberately "*", not a specific origin: this endpoint serves
// no private/user-specific data (a public search over public parking
// data), the real access gate is the anon key requirement on the function
// invocation itself, and the frontend's final deployed origin isn't fixed
// yet. Worth tightening later if/when it is -- a deliberate choice, not
// an oversight.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// Supabase platform into every deployed Edge Function's environment --
// LOCATIONIQ_API_KEY is the one genuinely custom secret, set via
// `supabase secrets set LOCATIONIQ_API_KEY=...` before deployment.
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const locationIqApiKey = Deno.env.get("LOCATIONIQ_API_KEY");

if (supabaseUrl === undefined || supabaseServiceRoleKey === undefined || locationIqApiKey === undefined) {
  throw new Error(
    "parking-search: missing required environment variable(s) -- SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY should be auto-injected by Supabase; LOCATIONIQ_API_KEY must be set via `supabase secrets set`.",
  );
}

// Constructed once at module scope, not per-request -- reused across warm
// invocations of the same isolate. Cast to three narrow DI interfaces
// (the same as-unknown-as pattern used throughout this project) rather
// than one combined type: GeocodeCacheSupabaseClient and
// OccupancyStatsSupabaseClient each declare an incompatible from()/
// select() shape of their own.
//
// service_role, not anon, for every table this function touches
// (geocode_cache, occupancy_stats, both RPCs) -- geocode_cache in
// particular has zero RLS policies by design (migrations/018) and is only
// ever meant to be read/written server-side.
const rawClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const deps: HandleParkingSearchRequestDeps = {
  geocodeCacheClient: rawClient as unknown as GeocodeCacheSupabaseClient,
  occupancyStatsClient: rawClient as unknown as OccupancyStatsSupabaseClient,
  rpcClient: rawClient as unknown as ParkingSearchRpcClient,
  locationIqApiKey,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const rawBody = await req.text();
  const { response, status } = await handleParkingSearchRequest(deps, rawBody, new Date());

  return new Response(JSON.stringify(response), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
