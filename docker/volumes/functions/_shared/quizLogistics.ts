import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractStoredMetaTracking } from './meta.ts';

const DEFAULT_QUIZ_LOGISTICS_WEBHOOK_URL = 'https://n8n.maisfloresta.cloud/webhook/quiz-logistica-pedido-pago';
const QUIZ_LOGISTICS_CLAIM_STALE_MS = 5 * 60_000;
const MAX_LOGISTICS_RESPONSE_LENGTH = 1000;

type AdminClient = ReturnType<typeof createClient>;

export interface QuizLogisticsOrderSnapshot {
  id: number;
  order_code: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_cpf?: string | null;
  selected_color?: string | null;
  items?: unknown;
  total_cents?: number | null;
  freight_cents?: number | null;
  free_shipping?: boolean | null;
  has_gift?: boolean | null;
  shipping_cep?: string | null;
  shipping_street?: string | null;
  shipping_number?: string | null;
  shipping_complement?: string | null;
  shipping_neighborhood?: string | null;
  shipping_city?: string | null;
  shipping_state?: string | null;
  provider_response?: unknown;
  logistics_webhook_sent_at?: string | null;
}

interface QuizLogisticsLineItem {
  productId: number;
  name: string;
  optionLabel: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

interface SyncQuizLogisticsOptions {
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOfRecords(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function firstString(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function digitsOnly(value: string | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeItems(items: unknown): QuizLogisticsLineItem[] {
  if (!isArrayOfRecords(items)) {
    return [];
  }

  return items
    .map((item) => ({
      productId: Number(item.productId ?? item.product_id ?? 0),
      name: String(item.name ?? item.product_name ?? ''),
      optionLabel: String(item.optionLabel ?? item.option_label ?? ''),
      quantity: Number(item.quantity ?? 1),
      unitPriceCents: Number(
        item.unitPriceCents ??
          item.unit_price_cents ??
          item.totalCents ??
          item.total_cents ??
          0,
      ),
      totalCents: Number(
        item.totalCents ??
          item.total_cents ??
          item.unitPriceCents ??
          item.unit_price_cents ??
          0,
      ),
    }))
    .filter((item) => item.productId > 0 || item.name.length > 0);
}

function buildCartFromItems(items: QuizLogisticsLineItem[]) {
  const cart: Record<string, number | null> = {
    mix: null,
    bandeja: null,
    fertilizante: null,
  };

  for (const item of items) {
    const optionLabel = item.optionLabel.trim().toLowerCase();
    const productName = item.name.trim().toLowerCase();

    if (item.productId === 1 || productName.includes('mix sementes')) {
      if (optionLabel === 'starter') cart.mix = 0;
      if (optionLabel === 'popular') cart.mix = 1;
      if (optionLabel === 'completo') cart.mix = 2;
      continue;
    }

    if (item.productId === 2 || productName.includes('bandeja')) {
      if (optionLabel === '1 bandeja') cart.bandeja = 0;
      if (optionLabel === '2 bandejas') cart.bandeja = 1;
      if (optionLabel === '3 bandejas') cart.bandeja = 2;
      continue;
    }

    if (item.productId === 3 || productName.includes('fertilizante')) {
      if (optionLabel === '1 kit') cart.fertilizante = 0;
      if (optionLabel === '2 kits') cart.fertilizante = 1;
      if (optionLabel === '3 kits') cart.fertilizante = 2;
    }
  }

  return cart;
}

function extractStoredQuizLogistics(providerResponse: unknown) {
  const provider = isRecord(providerResponse) ? providerResponse : {};
  const logistics = isRecord(provider.logistics) ? provider.logistics : {};

  return {
    sentAt: firstString([logistics.sentAt]),
  };
}

function mergeStoredQuizLogistics(providerResponse: unknown, nextLogistics: Record<string, unknown>) {
  const provider = isRecord(providerResponse) ? providerResponse : {};
  const logistics = isRecord(provider.logistics) ? provider.logistics : {};

  return {
    ...provider,
    logistics: {
      ...logistics,
      ...Object.fromEntries(
        Object.entries(nextLogistics).filter(([, value]) => value !== undefined),
      ),
    },
  };
}

function buildQuizLogisticsPayload(order: QuizLogisticsOrderSnapshot) {
  const items = normalizeItems(order.items);
  const tracking = extractStoredMetaTracking(order.provider_response);
  const totalCents = Number(order.total_cents ?? 0);
  const freightCents = Number(order.freight_cents ?? 0);
  const subtotalCents = Math.max(0, totalCents - freightCents);

  return {
    orderCode: order.order_code,
    customerName: order.customer_name ?? '',
    customerPhone: digitsOnly(order.customer_phone ?? ''),
    customerCpf: digitsOnly(order.customer_cpf ?? ''),
    customerEmail: tracking.customerEmail ?? '',
    selectedColor: order.selected_color ?? '',
    cart: buildCartFromItems(items),
    shipping: {
      cep: digitsOnly(order.shipping_cep ?? ''),
      street: order.shipping_street ?? '',
      number: order.shipping_number ?? '',
      complement: order.shipping_complement ?? '',
      neighborhood: order.shipping_neighborhood ?? '',
      city: order.shipping_city ?? '',
      state: order.shipping_state ?? '',
    },
    items,
    subtotalCents,
    freightCents,
    amountCents: totalCents,
    freeShipping: Boolean(order.free_shipping),
    hasGift: Boolean(order.has_gift),
  };
}

async function claimQuizLogisticsSend(admin: AdminClient, orderId: number) {
  const claimToken = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - QUIZ_LOGISTICS_CLAIM_STALE_MS).toISOString();

  const { data, error } = await admin
    .from('quiz_orders')
    .update({
      logistics_webhook_claim_token: claimToken,
      logistics_webhook_claimed_at: claimedAt,
      logistics_webhook_last_error: null,
    })
    .eq('id', orderId)
    .is('logistics_webhook_sent_at', null)
    .or(`logistics_webhook_claimed_at.is.null,logistics_webhook_claimed_at.lt.${staleBefore}`)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Não foi possível reservar o envio da logística: ${error.message}`);
  }

  return data ? { claimToken, claimedAt } : null;
}

async function finalizeQuizLogisticsSend(
  admin: AdminClient,
  orderId: number,
  claimToken: string,
  payload: {
    providerResponse: unknown;
    sentAt?: string | null;
    lastError?: string | null;
  },
) {
  const updatePayload: Record<string, unknown> = {
    provider_response: payload.providerResponse,
    logistics_webhook_claim_token: null,
    logistics_webhook_claimed_at: null,
    logistics_webhook_last_error: payload.lastError ?? null,
  };

  if (payload.sentAt) {
    updatePayload.logistics_webhook_sent_at = payload.sentAt;
  }

  const { error } = await admin
    .from('quiz_orders')
    .update(updatePayload)
    .eq('id', orderId)
    .eq('logistics_webhook_claim_token', claimToken);

  if (error) {
    console.error('[quiz-logistics] finalize failed:', error.message);
  }
}

export async function syncQuizLogisticsForOrder(
  admin: AdminClient,
  order: QuizLogisticsOrderSnapshot,
  options: SyncQuizLogisticsOptions,
) {
  const storedStatus = extractStoredQuizLogistics(order.provider_response);
  if (order.logistics_webhook_sent_at || storedStatus.sentAt) {
    return { sent: false, skippedReason: 'already_sent' };
  }

  const claim = await claimQuizLogisticsSend(admin, order.id);
  if (!claim) {
    return { sent: false, skippedReason: 'already_claimed_or_sent' };
  }

  const attemptedAt = new Date().toISOString();
  const logisticsUrl =
    Deno.env.get('N8N_QUIZ_LOGISTICS_WEBHOOK_URL')?.trim() ||
    DEFAULT_QUIZ_LOGISTICS_WEBHOOK_URL;
  const payload = buildQuizLogisticsPayload(order);

  try {
    const response = await fetch(logisticsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const responseBody = (await response.text()).slice(0, MAX_LOGISTICS_RESPONSE_LENGTH);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${responseBody || 'sem corpo'}`);
    }

    const sentAt = new Date().toISOString();

    await finalizeQuizLogisticsSend(admin, order.id, claim.claimToken, {
      sentAt,
      lastError: null,
      providerResponse: mergeStoredQuizLogistics(order.provider_response, {
        webhookUrl: logisticsUrl,
        source: options.source,
        lastAttemptAt: attemptedAt,
        lastStatusCode: response.status,
        lastResponseBody: responseBody,
        lastError: null,
        sentAt,
      }),
    });

    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao disparar a logística.';
    console.error('[quiz-logistics] sync failed:', message);

    await finalizeQuizLogisticsSend(admin, order.id, claim.claimToken, {
      lastError: message,
      providerResponse: mergeStoredQuizLogistics(order.provider_response, {
        webhookUrl: logisticsUrl,
        source: options.source,
        lastAttemptAt: attemptedAt,
        lastError: message,
      }),
    });

    return { sent: false, error: message };
  }
}
