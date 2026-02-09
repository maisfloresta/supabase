import { serve } from "https://deno.land/std@0.177.1/http/server.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://kong:8000"
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const sharedToken = Deno.env.get("WEBHOOK_SHARED_TOKEN") ?? ""
const yampiSecret = Deno.env.get("YAMPI_WEBHOOK_SECRET") ?? ""
const cartpandaSecret = Deno.env.get("CARTPANDA_WEBHOOK_SECRET") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-token, x-webhook-provider, x-webhook-event, x-webhook-id, x-yampi-hmac-sha256, x-cartpanda-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
}

type Provider = "yampi" | "cartpanda" | "unknown"

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function inferProvider(req: Request, payload: unknown): Provider {
  const url = new URL(req.url)
  const queryProvider = (
    url.searchParams.get("provider") ??
    url.searchParams.get("source") ??
    url.searchParams.get("platform") ??
    ""
  ).toLowerCase()

  const pathParts = url.pathname.split("/").filter(Boolean)
  const pathProvider = (pathParts[1] ?? "").toLowerCase()
  const headerProvider = (req.headers.get("x-webhook-provider") ?? "").toLowerCase()

  const candidates = [queryProvider, pathProvider, headerProvider]
  for (const candidate of candidates) {
    if (candidate === "yampi") return "yampi"
    if (candidate === "cartpanda") return "cartpanda"
  }

  if (req.headers.get("x-yampi-hmac-sha256")) return "yampi"
  if (req.headers.get("x-cartpanda-signature")) return "cartpanda"

  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>
    const explicit = String(obj.provider ?? obj.source ?? "").toLowerCase()
    if (explicit === "yampi") return "yampi"
    if (explicit === "cartpanda") return "cartpanda"
  }

  return "unknown"
}

function pickEventName(req: Request, payload: unknown): string | null {
  return (
    req.headers.get("x-webhook-event") ??
    req.headers.get("x-yampi-topic") ??
    req.headers.get("x-cartpanda-topic") ??
    (typeof payload === "object" && payload !== null
      ? String(
          (payload as Record<string, unknown>).event ??
            (payload as Record<string, unknown>).topic ??
            (payload as Record<string, unknown>).type ??
            "",
        ) || null
      : null)
  )
}

function pickExternalEventId(req: Request, payload: unknown): string | null {
  return (
    req.headers.get("x-webhook-id") ??
    req.headers.get("x-request-id") ??
    (typeof payload === "object" && payload !== null
      ? String(
          (payload as Record<string, unknown>).id ??
            (payload as Record<string, unknown>).event_id ??
            "",
        ) || null
      : null)
  )
}

function pickOrderId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const obj = payload as Record<string, unknown>
  const order = obj.order
  if (typeof order === "object" && order !== null) {
    const orderObj = order as Record<string, unknown>
    if (orderObj.id != null) return String(orderObj.id)
    if (orderObj.number != null) return String(orderObj.number)
  }
  const resource = obj.resource
  if (typeof resource === "object" && resource !== null) {
    const resourceObj = resource as Record<string, unknown>
    if (resourceObj.id != null) return String(resourceObj.id)
    if (resourceObj.number != null) return String(resourceObj.number)
  }
  if (obj.order_id != null) return String(obj.order_id)
  if (obj.checkout_id != null) return String(obj.checkout_id)
  if (obj.id != null) return String(obj.id)
  return null
}

function parseIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")
  if (!forwarded) return null
  return forwarded.split(",")[0]?.trim() || null
}

function extractSignature(req: Request): string | null {
  return (
    req.headers.get("x-yampi-hmac-sha256") ??
    req.headers.get("x-cartpanda-signature") ??
    req.headers.get("x-signature") ??
    null
  )
}

function hasProviderSecret(provider: Provider): boolean {
  if (provider === "yampi") return yampiSecret.length > 0
  if (provider === "cartpanda") return cartpandaSecret.length > 0
  return false
}

serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method === "GET") {
    return jsonResponse(200, {
      ok: true,
      endpoint: "/functions/v1/webhooks",
      accepted_methods: ["POST"],
      accepted_providers: ["yampi", "cartpanda"],
    })
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" })
  }

  if (!serviceRoleKey) {
    return jsonResponse(500, { error: "missing_service_role_key" })
  }

  const incomingToken =
    req.headers.get("x-webhook-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token") ??
    ""
  if (sharedToken && incomingToken !== sharedToken) {
    return jsonResponse(401, { error: "invalid_webhook_token" })
  }

  const rawBody = await req.text()
  let payload: unknown = null
  try {
    payload = rawBody ? JSON.parse(rawBody) : null
  } catch {
    payload = null
  }

  const provider = inferProvider(req, payload)
  const signature = extractSignature(req)

  if (provider !== "unknown" && hasProviderSecret(provider) && !signature) {
    return jsonResponse(401, {
      error: "missing_signature",
      provider,
    })
  }

  const headersObj = Object.fromEntries(req.headers.entries())
  const eventName = pickEventName(req, payload)
  const externalEventId = pickExternalEventId(req, payload)
  const externalOrderId = pickOrderId(payload)
  const sourceIp = parseIp(req)

  const response = await fetch(`${supabaseUrl}/rest/v1/webhook_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify([
      {
        provider,
        event_name: eventName,
        external_event_id: externalEventId,
        external_order_id: externalOrderId,
        signature,
        source_ip: sourceIp,
        headers: headersObj,
        payload,
        raw_body: rawBody || null,
        status: "received",
      },
    ]),
  })

  if (!response.ok) {
    const details = await response.text()
    return jsonResponse(500, {
      error: "failed_to_persist_webhook",
      status: response.status,
      details,
    })
  }

  const inserted = await response.json()
  const webhookId = Array.isArray(inserted) ? inserted[0]?.id : null

  let processing: unknown = null
  if (webhookId) {
    const processResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/process_webhook_event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ p_event_id: webhookId }),
    })

    if (processResponse.ok) {
      processing = await processResponse.json()
    } else {
      processing = {
        ok: false,
        error: "failed_to_process_webhook_event",
        status: processResponse.status,
        details: await processResponse.text(),
      }
    }
  }

  return jsonResponse(202, {
    ok: true,
    id: webhookId,
    provider,
    event_name: eventName,
    processing,
  })
})
