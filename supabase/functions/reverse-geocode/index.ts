// Thin Deno.serve entry point -- same pattern as supabase/functions/
// parking-search/index.ts. All real decision-making (validation, calling
// reverseGeocodeCoordinates, classifying failures) lives in
// handleReverseGeocodeRequest.ts (src/edge-function/) -- fully testable on
// its own, with no Request/Response/Deno.serve coupling. This file only
// touches the HTTP-transport concerns that function can't own: CORS,
// method checking, and turning its {response, status} into a real
// Response.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleReverseGeocodeRequest, type HandleReverseGeocodeRequestDeps } from "../../../src/edge-function/handleReverseGeocodeRequest.ts";
import type { ReverseGeocodeCacheSupabaseClient } from "../../../src/geocoding/reverseGeocodeCoordinates.ts";

// Same CORS reasoning as parking-search/index.ts: this endpoint serves no
// private/user-specific data, and the frontend's final deployed origin
// isn't fixed yet.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const locationIqApiKey = Deno.env.get("LOCATIONIQ_API_KEY");

if (supabaseUrl === undefined || supabaseServiceRoleKey === undefined || locationIqApiKey === undefined) {
  throw new Error(
    "reverse-geocode: missing required environment variable(s) -- SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY should be auto-injected by Supabase; LOCATIONIQ_API_KEY must be set via `supabase secrets set` (already done for parking-search -- this function reuses the same project secret).",
  );
}

// service_role, not anon: reverse_geocode_cache has zero RLS policies by
// design (migrations/021), same reasoning as geocode_cache.
const rawClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const deps: HandleReverseGeocodeRequestDeps = {
  reverseGeocodeCacheClient: rawClient as unknown as ReverseGeocodeCacheSupabaseClient,
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
  const { response, status } = await handleReverseGeocodeRequest(deps, rawBody, new Date());

  return new Response(JSON.stringify(response), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
