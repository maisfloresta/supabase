import { createSupabaseAdminClient, getClientIp } from "../_shared/appmax.ts";
import { corsHeaders } from "../_shared/cors.ts";

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function sanitizeHeaders(headers: Headers) {
  const allowedHeaders = [
    "content-type",
    "user-agent",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "x-request-id",
  ];

  return Object.fromEntries(
    allowedHeaders
      .map((name) => [name, headers.get(name)])
      .filter(([, value]) => value),
  );
}

async function parseWebhookBody(req: Request) {
  const rawBody = await req.text();

  if (!rawBody.trim()) {
    return { rawBody: null, payload: null };
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return {
        rawBody,
        payload: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Keep the raw body for troubleshooting when the provider sends a non-JSON payload.
  }

  return { rawBody, payload: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "appmax-webhook",
      method: "POST",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Método não suportado.", 405);
  }

  try {
    const adminClient = createSupabaseAdminClient();
    const { rawBody, payload } = await parseWebhookBody(req);
    const eventName = typeof payload?.event === "string"
      ? payload.event
      : typeof payload?.type === "string"
      ? payload.type
      : null;

    const { error } = await adminClient
      .schema("appmax")
      .from("webhook_events")
      .insert({
        event_name: eventName,
        source_ip: getClientIp(req),
        user_agent: req.headers.get("user-agent"),
        content_type: req.headers.get("content-type"),
        headers: sanitizeHeaders(req.headers),
        payload,
        raw_body: rawBody,
      });

    if (error) {
      throw new Error(
        `Não foi possível registrar o webhook da Appmax: ${error.message}`,
      );
    }

    return jsonResponse({ success: true }, 200);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Erro inesperado no webhook da Appmax.";
    const isServerError = message.includes("Variável de ambiente ausente") ||
      message.includes("Não foi possível registrar");

    return errorResponse(message, isServerError ? 500 : 400);
  }
});
