import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function jsonResponse(payload: Record<string, unknown>, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}

// ── Simple in-memory rate limiter (per phone, per instance) ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 3;        // max requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

// ── Validation helpers ──
function sanitizeString(val: unknown, maxLen = 200): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizePhone(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const digits = val.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 11) return null;
  return digits;
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405, cors);
  }

  try {
    const body = await req.json();

    const nome = sanitizeString(body.nome, 100);
    if (!nome) {
      return jsonResponse({ success: false, error: 'nome é obrigatório' }, 400, cors);
    }

    const telefone = sanitizePhone(body.telefone);
    if (!telefone) {
      return jsonResponse({ success: false, error: 'telefone inválido' }, 400, cors);
    }

    // Rate limit by phone number
    if (isRateLimited(telefone)) {
      return jsonResponse({ success: false, error: 'Muitas tentativas. Aguarde um momento.' }, 429, cors);
    }

    const espaco = sanitizeString(body.espaco, 50);
    const cor = sanitizeString(body.cor, 50);
    const experiencia = sanitizeString(body.experiencia, 50);
    const motivacao = sanitizeString(body.motivacao, 200);
    const tempo = sanitizeString(body.tempo, 50);
    const solo = sanitizeString(body.solo, 50);
    const regiao = sanitizeString(body.regiao, 50);

    const admin = createAdminClient();

    const { data: lead, error: leadError } = await admin
      .from('quiz_leads')
      .insert({
        nome,
        telefone,
        espaco,
        cor,
        experiencia,
        motivacao,
        tempo,
        solo,
        regiao,
        quiz_answers: { espaco, cor, experiencia, motivacao, tempo, solo, regiao },
      })
      .select('id')
      .single();

    if (leadError) {
      console.error('Failed to save lead:', leadError.message);
    }

    // Forward to BotConversa webhook if configured
    const webhookUrl = Deno.env.get('BOTCONVERSA_WEBHOOK_URL');
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, telefone }),
      }).catch(() => {
        // silently fail
      });
    }

    return jsonResponse({ success: true, leadId: lead?.id ?? null }, 200, cors);
  } catch {
    return jsonResponse({ success: false, error: 'Erro interno' }, 500, cors);
  }
});
