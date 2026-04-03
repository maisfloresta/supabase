const FB_ACCESS_TOKEN = Deno.env.get('FB_ACCESS_TOKEN')?.trim();
const FB_PIXEL_ID = Deno.env.get('FB_PIXEL_ID')?.trim() || '717937076662972';
const FB_GRAPH_API_VERSION = Deno.env.get('FB_GRAPH_API_VERSION')?.trim() || 'v21.0';
const FB_TEST_EVENT_CODE = Deno.env.get('FB_TEST_EVENT_CODE')?.trim() || undefined;
const FB_FETCH_TIMEOUT_MS = Number(Deno.env.get('FB_CAPI_TIMEOUT_MS') ?? '4000');
const FB_API_URL = `https://graph.facebook.com/${FB_GRAPH_API_VERSION}/${FB_PIXEL_ID}/events`;

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const HASHED_USER_DATA_KEYS = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'] as const;
const STRONG_MATCH_KEYS = ['fbp', 'fbc', 'em', 'ph', 'external_id'] as const;
const MAX_EVENTS_PER_REQUEST = 10;

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

const ALLOWED_EVENT_NAMES = new Set([
  'PageView', 'Lead', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase',
  'ViewContent', 'AddToCart', 'CompleteRegistration',
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, maxLength = 500) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function normalizeIdentifierList(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .map((entry) => normalizeString(entry, 256))
    .filter((entry): entry is string => Boolean(entry));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUserData(input: unknown) {
  if (!isRecord(input)) return {};

  const userData: JsonRecord = {};

  const fbp = normalizeString(input.fbp, 255);
  if (fbp) userData.fbp = fbp;

  const fbc = normalizeString(input.fbc, 255);
  if (fbc) userData.fbc = fbc;

  const clientUserAgent = normalizeString(input.client_user_agent, 1024);
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;

  const clientIpAddress = normalizeString(input.client_ip_address, 64);
  if (clientIpAddress) userData.client_ip_address = clientIpAddress;

  for (const key of HASHED_USER_DATA_KEYS) {
    const normalized = normalizeIdentifierList(input[key]);
    if (normalized) {
      userData[key] = normalized;
    }
  }

  return userData;
}

function hasStrongMatchKey(userData: JsonRecord) {
  return STRONG_MATCH_KEYS.some((key) => {
    const value = userData[key];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.length > 0;
  });
}

function extractErrorMessage(parsed: unknown, fallback: string) {
  if (isRecord(parsed)) {
    const error = isRecord(parsed.error) ? parsed.error : {};
    const message = normalizeString(error.message) ?? normalizeString(parsed.message);
    if (message) return message;
  }

  return normalizeString(fallback, 1000) ?? 'unknown_error';
}

function jsonResponse(payload: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405, cors);
  }

  if (!FB_ACCESS_TOKEN) {
    return jsonResponse({ success: false, error: 'Service misconfigured' }, 500, cors);
  }

  try {
    const body = await req.json();
    const events = body?.events;

    if (!Array.isArray(events) || events.length === 0) {
      return jsonResponse({ success: false, error: 'No events provided' }, 400, cors);
    }

    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return jsonResponse({ success: false, error: 'Too many events' }, 400, cors);
    }

    const sanitized = events
      .filter((evt: Record<string, unknown>) =>
        typeof evt.event_name === 'string' && ALLOWED_EVENT_NAMES.has(evt.event_name),
      )
      .map((evt: Record<string, unknown>) => {
        const eventId = normalizeString(evt.event_id, 200);
        const eventSourceUrl = normalizeString(evt.event_source_url, 500);
        const userData = normalizeUserData(evt.user_data);
        const customData = isRecord(evt.custom_data) ? evt.custom_data : {};

        return {
          event_name: String(evt.event_name),
          event_time: Number(evt.event_time) || Math.floor(Date.now() / 1000),
          ...(eventId ? { event_id: eventId } : {}),
          ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
          action_source: 'website',
          user_data: userData,
          custom_data: customData,
        };
      });

    if (sanitized.length === 0) {
      return jsonResponse({ success: false, error: 'No valid events' }, 400, cors);
    }

    const sendableEvents = sanitized.filter((event) => hasStrongMatchKey(event.user_data));
    const skippedEvents = sanitized.length - sendableEvents.length;

    if (sendableEvents.length === 0) {
      return jsonResponse({
        success: true,
        sent: 0,
        skipped: skippedEvents,
        skip_reason: 'insufficient_match_keys',
      }, 200, cors);
    }

    const payload: JsonRecord = { data: sendableEvents };
    if (FB_TEST_EVENT_CODE) {
      payload.test_event_code = FB_TEST_EVENT_CODE;
    }

    let fbRes: Response;
    try {
      fbRes = await fetch(`${FB_API_URL}?access_token=${encodeURIComponent(FB_ACCESS_TOKEN)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FB_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fb-capi] Meta request failed: ${message}`);
      return jsonResponse({ success: false, error: 'Meta request failed' }, 502, cors);
    }

    const raw = await fbRes.text();
    let parsed: unknown = raw;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }

    if (!fbRes.ok) {
      const message = extractErrorMessage(parsed, raw || fbRes.statusText);
      console.error(`[fb-capi] Meta API error (${fbRes.status}): ${message}`);
      return jsonResponse(
        {
          success: false,
          error: fbRes.status === 400 ? 'Meta rejected the event payload' : 'Meta request failed',
        },
        fbRes.status === 400 ? 422 : 502,
        cors,
      );
    }

    return jsonResponse({ success: true, sent: sendableEvents.length, skipped: skippedEvents }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fb-capi] Internal error: ${message}`);
    return jsonResponse({ success: false, error: 'Internal error' }, 500, cors);
  }
});
