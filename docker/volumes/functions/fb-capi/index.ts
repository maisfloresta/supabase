const FB_ACCESS_TOKEN = Deno.env.get('FB_ACCESS_TOKEN');
const FB_PIXEL_ID = Deno.env.get('FB_PIXEL_ID') || '717937076662972';
const FB_API_URL = `https://graph.facebook.com/v21.0/${FB_PIXEL_ID}/events`;

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

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

const MAX_EVENTS_PER_REQUEST = 10;

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

    // Sanitize: only allow expected fields and event names
    const sanitized = events
      .filter((evt: Record<string, unknown>) =>
        typeof evt.event_name === 'string' && ALLOWED_EVENT_NAMES.has(evt.event_name),
      )
      .map((evt: Record<string, unknown>) => ({
        event_name: String(evt.event_name),
        event_time: Number(evt.event_time) || Math.floor(Date.now() / 1000),
        event_id: String(evt.event_id ?? '').slice(0, 200),
        event_source_url: String(evt.event_source_url ?? '').slice(0, 500),
        action_source: 'website',
        user_data: typeof evt.user_data === 'object' && evt.user_data !== null ? evt.user_data : {},
        custom_data: typeof evt.custom_data === 'object' && evt.custom_data !== null ? evt.custom_data : {},
      }));

    if (sanitized.length === 0) {
      return jsonResponse({ success: false, error: 'No valid events' }, 400, cors);
    }

    const fbRes = await fetch(`${FB_API_URL}?access_token=${FB_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: sanitized }),
    });

    const fbOk = fbRes.ok;
    // Don't leak Facebook's full response to the client
    await fbRes.text();

    return jsonResponse({ success: fbOk }, fbOk ? 200 : 502, cors);
  } catch {
    return jsonResponse({ success: false, error: 'Internal error' }, 500, cors);
  }
});
