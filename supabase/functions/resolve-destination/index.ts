// Thin Deno.serve entry point -- same pattern as destination-autocomplete/
// index.ts and reverse-geocode/index.ts. All real decision-making
// (validation, calling resolveDestinationCoordinates, classifying
// failures) lives in handleResolveDestinationRequest.ts (src/edge-function/)
// -- fully testable on its own, with no Request/Response/Deno.serve
// coupling. This file only touches the HTTP-transport concerns that
// function can't own: CORS, method checking, and turning its
// {response, status} into a real Response.
//
// No Supabase client is constructed here at all -- same reasoning as
// destination-autocomplete/index.ts: this endpoint has no cache table and
// needs no database access whatsoever (see resolveDestinationCoordinates.ts's
// own header comment for why no persistent cache was built).
import {
  handleResolveDestinationRequest,
  type HandleResolveDestinationRequestDeps,
} from "../../../src/edge-function/handleResolveDestinationRequest.ts";

// Same CORS reasoning as the other Edge Functions: this endpoint serves no
// private/user-specific data, and the frontend's final deployed origin
// isn't fixed yet.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const googlePlacesApiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");

if (googlePlacesApiKey === undefined) {
  throw new Error(
    "resolve-destination: missing required environment variable GOOGLE_PLACES_API_KEY -- must be set via `supabase secrets set` (already done for destination-autocomplete -- this function reuses the same project secret).",
  );
}

const deps: HandleResolveDestinationRequestDeps = { googlePlacesApiKey };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const rawBody = await req.text();
  const { response, status } = await handleResolveDestinationRequest(deps, rawBody);

  return new Response(JSON.stringify(response), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
