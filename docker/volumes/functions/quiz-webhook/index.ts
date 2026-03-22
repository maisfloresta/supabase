const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  const webhookUrl = Deno.env.get('BOTCONVERSA_WEBHOOK_URL');
  if (!webhookUrl) {
    console.error('BOTCONVERSA_WEBHOOK_URL not configured');
    return jsonResponse({ success: false, error: 'Webhook not configured' }, 500);
  }

  try {
    const { nome, telefone } = await req.json();

    if (!nome || typeof nome !== 'string' || nome.trim().length === 0) {
      return jsonResponse({ success: false, error: 'nome é obrigatório' }, 400);
    }

    const digits = (telefone ?? '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) {
      return jsonResponse({ success: false, error: 'telefone inválido' }, 400);
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome.trim(), telefone: digits }),
    });

    if (!res.ok) {
      console.error(`Webhook returned ${res.status}: ${await res.text()}`);
      return jsonResponse({ success: false, error: 'Webhook failed' }, 502);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('quiz-webhook error:', err);
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
});
