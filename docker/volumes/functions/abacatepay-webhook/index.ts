import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hmac } from 'https://deno.land/x/hmac@v2.0.1/mod.ts';
import {
  extractStoredMetaPurchaseStatus,
  extractStoredMetaTracking,
  mergeStoredMetaPurchaseStatus,
  sendMetaPurchaseEvent,
} from '../_shared/meta.ts';
import { syncQuizLogisticsForOrder } from '../_shared/quizLogistics.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-abacatepay-signature',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function firstNumber(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Number(candidate.replace(',', '.'));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function extractWebhookData(payload: Record<string, unknown>) {
  const data = isRecord(payload.data) ? payload.data : {};
  const transparent = isRecord(data.transparent) ? data.transparent : data;
  const metadata = isRecord(transparent.metadata)
    ? transparent.metadata
    : isRecord(data.metadata)
      ? data.metadata
      : {};

  return {
    event: firstString([payload.event, payload.type, data.event, data.type]) ?? '',
    rawData: data,
    transparent,
    metadata,
    transparentId: firstString([
      transparent.id,
      transparent.externalId,
      data.id,
      data.pixId,
      data.transparent_id,
    ]),
    status: firstString([transparent.status, data.status]),
    amount: firstNumber([
      transparent.amount,
      transparent.paidAmount,
      data.amount,
      data.paidAmount,
    ]),
    paidAmount: firstNumber([
      transparent.paidAmount,
      data.paidAmount,
      transparent.amount,
      data.amount,
    ]),
    paidAt: firstString([
      transparent.updatedAt,
      data.updatedAt,
      transparent.createdAt,
      data.createdAt,
    ]),
    receiptUrl: firstString([transparent.receiptUrl, data.receiptUrl]),
  };
}

function mapEventToStatus(event: string) {
  switch (event) {
    case 'transparent.completed': return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'transparent.paid': return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'transparent.refunded': return { paymentStatus: 'refunded', orderStatus: 'refunded' };
    case 'transparent.disputed': return { paymentStatus: 'disputed', orderStatus: 'disputed' };
    case 'transparent.lost': return { paymentStatus: 'expired', orderStatus: 'expired' };
    case 'transparent.expired': return { paymentStatus: 'expired', orderStatus: 'expired' };
    case 'transparent.cancelled': return { paymentStatus: 'cancelled', orderStatus: 'cancelled' };
    default: return null;
  }
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  try {
    const rawBody = await req.text();

    // Validate signature if secret is set
    const secret = Deno.env.get('ABACATEPAY_WEBHOOK_SECRET');
    if (secret) {
      const signature = req.headers.get('x-abacatepay-signature') ?? '';
      const expected = hmac('sha256', secret, rawBody, 'utf8', 'hex');
      if (signature !== expected) {
        console.error('[abacatepay-webhook] Invalid signature');
        return jsonResponse({ success: false, error: 'Invalid signature' }, 401);
      }
    }

    const body = JSON.parse(rawBody);
    console.log('[abacatepay-webhook] Received:', JSON.stringify(body));

    const parsed = extractWebhookData(isRecord(body) ? body : {});
    const event = parsed.event;
    const transparentId = parsed.transparentId;
    const metadataQuizOrderId = firstNumber([parsed.metadata.quizOrderId]);
    const metadataQuizOrderCode = firstString([parsed.metadata.quizOrderCode]);

    if (!transparentId && !metadataQuizOrderId && !metadataQuizOrderCode) {
      console.error('[abacatepay-webhook] No order identifier found in payload');
      return jsonResponse({ success: true, message: 'No ID to process' });
    }

    const mapped = mapEventToStatus(event) ?? mapStatus(parsed.status);

    if (!mapped) {
      console.log(`[abacatepay-webhook] Ignoring unknown event: ${event}`);
      return jsonResponse({ success: true, message: 'Event ignored' });
    }

    const admin = createAdminClient();

    let order:
      | {
        id: number;
        order_code: string;
        transparent_id: string | null;
        payment_status: string | null;
        customer_name: string | null;
        customer_phone: string | null;
        customer_cpf: string | null;
        selected_color: string | null;
        items: unknown;
        total_cents: number | null;
        freight_cents: number | null;
        free_shipping: boolean | null;
        has_gift: boolean | null;
        shipping_cep: string | null;
        shipping_street: string | null;
        shipping_number: string | null;
        shipping_complement: string | null;
        shipping_neighborhood: string | null;
        shipping_city: string | null;
        shipping_state: string | null;
        provider_response: Record<string, unknown> | null;
        logistics_webhook_sent_at: string | null;
      }
      | null = null;

    if (transparentId) {
      const lookup = await admin
        .from('quiz_orders')
        .select('id, order_code, transparent_id, payment_status, customer_name, customer_phone, customer_cpf, selected_color, items, total_cents, freight_cents, free_shipping, has_gift, shipping_cep, shipping_street, shipping_number, shipping_complement, shipping_neighborhood, shipping_city, shipping_state, provider_response, logistics_webhook_sent_at')
        .eq('transparent_id', transparentId)
        .maybeSingle();
      order = lookup.data;
    }

    if (!order && metadataQuizOrderId !== null) {
      const lookup = await admin
        .from('quiz_orders')
        .select('id, order_code, transparent_id, payment_status, customer_name, customer_phone, customer_cpf, selected_color, items, total_cents, freight_cents, free_shipping, has_gift, shipping_cep, shipping_street, shipping_number, shipping_complement, shipping_neighborhood, shipping_city, shipping_state, provider_response, logistics_webhook_sent_at')
        .eq('id', metadataQuizOrderId)
        .maybeSingle();
      order = lookup.data;
    }

    if (!order && metadataQuizOrderCode) {
      const lookup = await admin
        .from('quiz_orders')
        .select('id, order_code, transparent_id, payment_status, customer_name, customer_phone, customer_cpf, selected_color, items, total_cents, freight_cents, free_shipping, has_gift, shipping_cep, shipping_street, shipping_number, shipping_complement, shipping_neighborhood, shipping_city, shipping_state, provider_response, logistics_webhook_sent_at')
        .eq('order_code', metadataQuizOrderCode)
        .maybeSingle();
      order = lookup.data;
    }

    if (!order) {
      console.log(`[abacatepay-webhook] No order found for transparent_id=${transparentId ?? 'missing'} order_code=${metadataQuizOrderCode ?? 'missing'} order_id=${metadataQuizOrderId ?? 'missing'}`);
      return jsonResponse({ success: true, message: 'Order not found' });
    }

    const wasPaid = order.payment_status === 'paid';

    const existingProviderResponse = isRecord(order.provider_response) ? order.provider_response : {};
    const existingAbacatePay = isRecord(existingProviderResponse.abacatepay)
      ? existingProviderResponse.abacatepay
      : {};

    const latestAbacatepaySnapshot = {
      ...existingAbacatePay,
      ...parsed.transparent,
      metadata: Object.keys(parsed.metadata).length > 0 ? parsed.metadata : existingAbacatePay.metadata ?? null,
    };

    const updatePayload: Record<string, unknown> = {
      payment_status: mapped.paymentStatus,
      order_status: mapped.orderStatus,
      transparent_id: transparentId ?? order.transparent_id,
      last_webhook_payload: body,
      provider_response: {
        ...existingProviderResponse,
        abacatepay: latestAbacatepaySnapshot,
        abacatepay_webhook: body,
      },
    };

    if (mapped.paymentStatus === 'paid') {
      updatePayload.paid_amount_cents = parsed.paidAmount ?? parsed.amount ?? order.total_cents;
      updatePayload.paid_at = parsed.paidAt ?? new Date().toISOString();
      updatePayload.receipt_url = parsed.receiptUrl ?? null;
    }

    await admin
      .from('quiz_orders')
      .update(updatePayload)
      .eq('id', order.id);

    console.log(`[abacatepay-webhook] Order ${order.order_code} updated: ${order.payment_status} -> ${mapped.paymentStatus}`);

    if (mapped.paymentStatus === 'paid') {
      if (!wasPaid) {
        const existingMeta = extractStoredMetaPurchaseStatus(order.provider_response);

        if (!existingMeta.purchaseSentAt) {
          const tracking = extractStoredMetaTracking(order.provider_response);
          const eventId = order.order_code;

          try {
            const metaResult = await sendMetaPurchaseEvent({
              orderCode: order.order_code,
              eventId,
              totalCents: Number(order.total_cents ?? 0),
              eventTime: String(updatePayload.paid_at ?? new Date().toISOString()),
              customerName: order.customer_name ?? undefined,
              customerPhone: order.customer_phone ?? undefined,
              customerEmail: tracking.customerEmail ?? undefined,
              customerCpf: order.customer_cpf ?? undefined,
              shippingZip: order.shipping_cep ?? undefined,
              shippingCity: order.shipping_city ?? undefined,
              shippingState: order.shipping_state ?? undefined,
              eventSourceUrl: tracking.pageUrl ?? undefined,
              clientIpAddress: tracking.clientIp ?? undefined,
              clientUserAgent: tracking.userAgent ?? undefined,
              fbp: tracking.fbp ?? undefined,
              fbc: tracking.fbc ?? undefined,
            });

            await admin
              .from('quiz_orders')
              .update({
                provider_response: mergeStoredMetaPurchaseStatus({
                  ...existingProviderResponse,
                  abacatepay: latestAbacatepaySnapshot,
                  abacatepay_webhook: body,
                }, {
                  purchaseEventId: metaResult.eventId,
                  purchaseSentAt: metaResult.sent ? new Date().toISOString() : null,
                  purchaseLastError: null,
                  purchaseLastResponse: metaResult.response ?? null,
                  purchaseSkippedReason: metaResult.skippedReason ?? null,
                }),
              })
              .eq('id', order.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Meta conversion failed.';
            console.error('[abacatepay-webhook] Meta purchase sync failed:', message);

            await admin
              .from('quiz_orders')
              .update({
                provider_response: mergeStoredMetaPurchaseStatus({
                  ...existingProviderResponse,
                  abacatepay: latestAbacatepaySnapshot,
                  abacatepay_webhook: body,
                }, {
                  purchaseEventId: eventId,
                  purchaseSentAt: null,
                  purchaseLastError: message,
                }),
              })
              .eq('id', order.id);
          }
        }

        const n8nPaidUrl = Deno.env.get('N8N_PIX_PAID_WEBHOOK_URL');
        if (n8nPaidUrl) {
          fetch(n8nPaidUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'pix_paid',
              orderCode: order.order_code,
              customerName: order.customer_name,
              customerPhone: order.customer_phone,
              totalCents: order.total_cents,
              paidAt: String(updatePayload.paid_at ?? new Date().toISOString()),
            }),
          }).catch((err) => console.error('[abacatepay-webhook] N8N error:', err));
        }
      }

      await syncQuizLogisticsForOrder(admin, {
        id: order.id,
        order_code: order.order_code,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        customer_cpf: order.customer_cpf,
        selected_color: order.selected_color,
        items: order.items,
        total_cents: order.total_cents,
        freight_cents: order.freight_cents,
        free_shipping: order.free_shipping,
        has_gift: order.has_gift,
        shipping_cep: order.shipping_cep,
        shipping_street: order.shipping_street,
        shipping_number: order.shipping_number,
        shipping_complement: order.shipping_complement,
        shipping_neighborhood: order.shipping_neighborhood,
        shipping_city: order.shipping_city,
        shipping_state: order.shipping_state,
        provider_response: {
          ...existingProviderResponse,
          abacatepay: latestAbacatepaySnapshot,
          abacatepay_webhook: body,
        },
        logistics_webhook_sent_at: order.logistics_webhook_sent_at,
      }, {
        source: 'abacatepay-webhook',
      });
    }

    return jsonResponse({ success: true, status: mapped.paymentStatus });
  } catch (err) {
    console.error('[abacatepay-webhook] Error:', err);
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
});
