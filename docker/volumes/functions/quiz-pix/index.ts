import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ABACATEPAY_API_URL = 'https://api.abacatepay.com';
const CHECKOUT_DESCRIPTION = 'Receba Sementes - Mais Floresta';
const CHECKOUT_EXPIRATION_SECONDS = 60 * 60; // 1 hour

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

function createAdminClient() {
  return createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

function buildOrderCode() {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `MF-QUIZ-${stamp}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function mapStatus(status: string | null | undefined) {
  switch ((status ?? '').toUpperCase()) {
    case 'PAID': return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'REFUNDED': return { paymentStatus: 'refunded', orderStatus: 'refunded' };
    case 'DISPUTED': return { paymentStatus: 'disputed', orderStatus: 'disputed' };
    case 'CANCELLED': return { paymentStatus: 'cancelled', orderStatus: 'cancelled' };
    case 'EXPIRED': return { paymentStatus: 'expired', orderStatus: 'expired' };
    default: return { paymentStatus: 'pending', orderStatus: 'pending' };
  }
}

// ─── Product catalog (matches UpsellScreen) ───

interface CatalogItem {
  id: number;
  name: string;
  options: { label: string; subtitle: string; priceCents: number }[];
}

const CATALOG: Record<string, CatalogItem> = {
  mix: {
    id: 1,
    name: 'Mix Sementes Ipê 5 Cores',
    options: [
      { label: 'Starter', subtitle: '50 sementes', priceCents: 3990 },
      { label: 'Popular', subtitle: '100 sementes', priceCents: 6990 },
      { label: 'Completo', subtitle: '200 sementes', priceCents: 11990 },
    ],
  },
  bandeja: {
    id: 2,
    name: 'Bandeja Germinadora',
    options: [
      { label: '1 Bandeja', subtitle: 'Até 40 sementes', priceCents: 2990 },
      { label: '2 Bandejas', subtitle: 'Até 80 sementes', priceCents: 4990 },
      { label: '3 Bandejas', subtitle: 'Até 120 sementes', priceCents: 6990 },
    ],
  },
  fertilizante: {
    id: 3,
    name: 'Kit Fertilizante + Fungicida',
    options: [
      { label: '1 Kit', subtitle: 'Até 100 mudas', priceCents: 2990 },
      { label: '2 Kits', subtitle: 'Até 200 mudas', priceCents: 4990 },
      { label: '3 Kits', subtitle: 'Até 300 mudas', priceCents: 6990 },
    ],
  },
};

const GIFT_THRESHOLD_CENTS = 12000; // R$ 120

interface CartInput {
  mix?: number | null;       // option index (0, 1, 2) or null
  bandeja?: number | null;
  fertilizante?: number | null;
}

function validateAndCalculateCart(cart: CartInput) {
  const lineItems: { productId: number; name: string; optionLabel: string; quantity: number; unitPriceCents: number; totalCents: number }[] = [];
  let totalCents = 0;

  for (const [key, optionIndex] of Object.entries(cart)) {
    if (optionIndex === null || optionIndex === undefined) continue;
    const product = CATALOG[key];
    if (!product) throw new Error(`Produto desconhecido: ${key}`);
    const idx = Number(optionIndex);
    if (isNaN(idx) || idx < 0 || idx >= product.options.length) {
      throw new Error(`Opção inválida para ${product.name}`);
    }
    const option = product.options[idx];
    lineItems.push({
      productId: product.id,
      name: product.name,
      optionLabel: option.label,
      quantity: 1,
      unitPriceCents: option.priceCents,
      totalCents: option.priceCents,
    });
    totalCents += option.priceCents;
  }

  if (lineItems.length === 0) {
    throw new Error('Nenhum item selecionado.');
  }

  const hasGift = totalCents >= GIFT_THRESHOLD_CENTS;
  const freeShipping = lineItems.length === 3;

  return { lineItems, totalCents, hasGift, freeShipping };
}

// ─── AbacatePay API ───

async function abacatePayRequest(path: string, init: RequestInit) {
  const apiKey = getEnv('ABACATEPAY_API_KEY');
  const response = await fetch(`${ABACATEPAY_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok) {
    const msg = (payload as any)?.error || (payload as any)?.message || 'Falha ao comunicar com a AbacatePay.';
    throw new Error(typeof msg === 'string' ? msg : 'Falha ao comunicar com a AbacatePay.');
  }

  return payload;
}

// ─── Actions ───

interface CreateInput {
  customerName: string;
  customerPhone: string;
  customerRegion?: string;
  selectedColor?: string;
  quizAnswers?: Record<string, unknown>;
  cart: CartInput;
}

async function createPixCharge(input: CreateInput) {
  const admin = createAdminClient();
  const { lineItems, totalCents, hasGift, freeShipping } = validateAndCalculateCart(input.cart);
  const orderCode = buildOrderCode();

  // 1. Create pending order in DB
  const { data: order, error: orderError } = await admin
    .from('quiz_orders')
    .insert({
      order_code: orderCode,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      customer_region: input.customerRegion ?? null,
      selected_color: input.selectedColor ?? null,
      quiz_answers: input.quizAnswers ?? {},
      items: lineItems,
      total_cents: totalCents,
      has_gift: hasGift,
      free_shipping: freeShipping,
    })
    .select('id, order_code')
    .single();

  if (orderError || !order) {
    throw new Error(`Não foi possível criar o pedido: ${orderError?.message ?? 'sem retorno'}`);
  }

  // 2. Create PIX charge in AbacatePay
  try {
    const createPayload = await abacatePayRequest('/v1/pixQrCode/create', {
      method: 'POST',
      body: JSON.stringify({
        amount: totalCents,
        description: CHECKOUT_DESCRIPTION,
        expiresIn: CHECKOUT_EXPIRATION_SECONDS,
        metadata: {
          source: 'quiz-recebasementes',
          quizOrderId: String(order.id),
          quizOrderCode: String(order.order_code),
          totalCents: String(totalCents),
          customerName: input.customerName,
          customerPhone: input.customerPhone,
        },
      }),
    });

    const chargeData = (createPayload as any)?.data;
    if (!chargeData?.id) {
      throw new Error('Resposta inválida ao gerar o PIX.');
    }

    const mapped = mapStatus(chargeData.status);

    // 3. Update order with AbacatePay response
    await admin
      .from('quiz_orders')
      .update({
        transparent_id: chargeData.id,
        pix_br_code: chargeData.brCode ?? null,
        pix_qr_base64: chargeData.brCodeBase64 ?? null,
        payment_status: mapped.paymentStatus,
        order_status: mapped.orderStatus,
        dev_mode: Boolean(chargeData.devMode),
        provider_response: chargeData,
        expires_at: chargeData.expiresAt ?? null,
      })
      .eq('order_code', orderCode);

    return {
      orderCode: order.order_code,
      pixId: chargeData.id,
      amountCents: totalCents,
      brCode: chargeData.brCode ?? '',
      brCodeBase64: chargeData.brCodeBase64 ?? null,
      status: (chargeData.status ?? 'PENDING').toUpperCase(),
      expiresAt: chargeData.expiresAt ?? null,
      hasGift,
      freeShipping,
      items: lineItems,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro inesperado ao gerar PIX.';
    await admin
      .from('quiz_orders')
      .update({ order_status: 'failed', payment_status: 'failed', last_error: message })
      .eq('order_code', orderCode);
    throw err;
  }
}

async function checkPixStatus(pixId: string) {
  const admin = createAdminClient();

  const query = new URLSearchParams({ id: pixId });
  const statusPayload = await abacatePayRequest(`/v1/pixQrCode/check?${query.toString()}`, {
    method: 'GET',
  });

  const chargeData = (statusPayload as any)?.data;
  if (!chargeData) {
    throw new Error('Resposta inválida ao consultar o PIX.');
  }

  const mapped = mapStatus(chargeData.status);

  // Update order in DB
  const updatePayload: Record<string, unknown> = {
    payment_status: mapped.paymentStatus,
    order_status: mapped.orderStatus,
    dev_mode: Boolean(chargeData.devMode),
    provider_response: chargeData,
  };

  if (mapped.paymentStatus === 'paid') {
    updatePayload.paid_amount_cents = chargeData.amount ?? chargeData.paidAmount ?? null;
    updatePayload.paid_at = chargeData.updatedAt ?? chargeData.createdAt ?? new Date().toISOString();
    updatePayload.receipt_url = chargeData.receiptUrl ?? null;
  }

  if (chargeData.id) {
    await admin
      .from('quiz_orders')
      .update(updatePayload)
      .eq('transparent_id', chargeData.id);
  }

  return {
    pixId: chargeData.id ?? pixId,
    status: (chargeData.status ?? 'PENDING').toUpperCase(),
    amountCents: chargeData.amount ?? 0,
    paidAmount: chargeData.paidAmount ?? null,
  };
}

// ─── Handler ───

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Método não suportado.', 405);
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action;

    if (action === 'create') {
      const data = await createPixCharge({
        customerName: String(body.customerName ?? ''),
        customerPhone: String(body.customerPhone ?? ''),
        customerRegion: body.customerRegion ? String(body.customerRegion) : undefined,
        selectedColor: body.selectedColor ? String(body.selectedColor) : undefined,
        quizAnswers: typeof body.quizAnswers === 'object' ? (body.quizAnswers as Record<string, unknown>) : undefined,
        cart: (body.cart ?? {}) as CartInput,
      });
      return jsonResponse({ success: true, data });
    }

    if (action === 'status') {
      if (typeof body.pixId !== 'string' || !body.pixId.trim()) {
        throw new Error('ID do PIX inválido.');
      }
      const data = await checkPixStatus(body.pixId.trim());
      return jsonResponse({ success: true, data });
    }

    return errorResponse('Ação inválida.', 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro inesperado.';
    const status = message.includes('Variável de ambiente') || message.includes('Falha ao comunicar') ? 500 : 400;
    return errorResponse(message, status);
  }
});
