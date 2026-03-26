import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hmac } from 'https://deno.land/x/hmac@v2.0.1/mod.ts';

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

function mapEventToStatus(event: string) {
  switch (event) {
    case 'transparent.completed': return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'transparent.refunded': return { paymentStatus: 'refunded', orderStatus: 'refunded' };
    case 'transparent.disputed': return { paymentStatus: 'disputed', orderStatus: 'disputed' };
    case 'transparent.lost': return { paymentStatus: 'expired', orderStatus: 'expired' };
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

    // AbacatePay sends: { event: "transparent.completed", data: { id, status, amount, ... } }
    const event = body.event ?? body.type ?? '';
    const data = body.data ?? body;
    const transparentId = data.id ?? data.pixId ?? data.transparent_id ?? '';

    if (!transparentId) {
      console.error('[abacatepay-webhook] No transparent ID found in payload');
      return jsonResponse({ success: true, message: 'No ID to process' });
    }

    // Map from event name first, fallback to data.status
    const mapped = mapEventToStatus(event) ?? mapStatus(data.status);

    if (!mapped) {
      console.log(`[abacatepay-webhook] Ignoring unknown event: ${event}`);
      return jsonResponse({ success: true, message: 'Event ignored' });
    }
    const admin = createAdminClient();

    // Get current order
    const { data: order } = await admin
      .from('quiz_orders')
      .select('id, order_code, payment_status, customer_name, customer_phone, total_cents, provider_response')
      .eq('transparent_id', transparentId)
      .maybeSingle();

    if (!order) {
      console.log(`[abacatepay-webhook] No order found for transparent_id=${transparentId}`);
      return jsonResponse({ success: true, message: 'Order not found' });
    }

    const wasPaid = order.payment_status === 'paid';

    // Build update payload
    const updatePayload: Record<string, unknown> = {
      payment_status: mapped.paymentStatus,
      order_status: mapped.orderStatus,
      provider_response: {
        ...(typeof order.provider_response === 'object' && order.provider_response !== null ? order.provider_response : {}),
        abacatepay_webhook: data,
      },
    };

    if (mapped.paymentStatus === 'paid') {
      updatePayload.paid_amount_cents = data.amount ?? data.paidAmount ?? order.total_cents;
      updatePayload.paid_at = data.updatedAt ?? data.createdAt ?? new Date().toISOString();
      updatePayload.receipt_url = data.receiptUrl ?? null;
    }

    await admin
      .from('quiz_orders')
      .update(updatePayload)
      .eq('id', order.id);

    console.log(`[abacatepay-webhook] Order ${order.order_code} updated: ${order.payment_status} -> ${mapped.paymentStatus}`);

    // Notify N8N when payment transitions to paid
    if (mapped.paymentStatus === 'paid' && !wasPaid) {
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
            paidAt: updatePayload.paid_at ?? new Date().toISOString(),
          }),
        }).catch((err) => console.error('[abacatepay-webhook] N8N error:', err));
      }
    }

    return jsonResponse({ success: true, status: mapped.paymentStatus });
  } catch (err) {
    console.error('[abacatepay-webhook] Error:', err);
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
});
