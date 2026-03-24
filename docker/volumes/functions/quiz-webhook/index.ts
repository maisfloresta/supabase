import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { nome, telefone, espaco, cor, experiencia, motivacao, tempo, solo, regiao } = body;

    if (!nome || typeof nome !== 'string' || nome.trim().length === 0) {
      return jsonResponse({ success: false, error: 'nome é obrigatório' }, 400);
    }

    const digits = (telefone ?? '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) {
      return jsonResponse({ success: false, error: 'telefone inválido' }, 400);
    }

    const admin = createAdminClient();

    // Save lead to quiz_leads table
    const { data: lead, error: leadError } = await admin
      .from('quiz_leads')
      .insert({
        nome: nome.trim(),
        telefone: digits,
        espaco: espaco ?? null,
        cor: cor ?? null,
        experiencia: experiencia ?? null,
        motivacao: motivacao ?? null,
        tempo: tempo ?? null,
        solo: solo ?? null,
        regiao: regiao ?? null,
        quiz_answers: {
          espaco: espaco ?? null,
          cor: cor ?? null,
          experiencia: experiencia ?? null,
          motivacao: motivacao ?? null,
          tempo: tempo ?? null,
          solo: solo ?? null,
          regiao: regiao ?? null,
        },
      })
      .select('id')
      .single();

    if (leadError) {
      console.error('Failed to save lead:', leadError);
    }

    // Also forward to BotConversa webhook if configured
    const webhookUrl = Deno.env.get('BOTCONVERSA_WEBHOOK_URL');
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome: nome.trim(), telefone: digits }),
        });
      } catch (err) {
        console.error('BotConversa webhook error:', err);
      }
    }

    return jsonResponse({ success: true, leadId: lead?.id ?? null });
  } catch (err) {
    console.error('quiz-webhook error:', err);
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
});
