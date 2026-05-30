// CORS headers and JSON error response, shared across actions and the invoke path.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function errResponse(message: string, status = 500): Response {
  return new Response(
    JSON.stringify({ error: true, message }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
