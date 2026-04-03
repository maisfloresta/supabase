import {
  createSupabaseAdminClient,
  getClientIp,
} from "../_shared/appmax.ts";
import {
  extractStoredMetaPurchaseStatus,
  extractStoredMetaTracking,
  mergeStoredMetaPurchaseStatus,
  sendMetaPurchaseEvent,
} from "../_shared/meta.ts";
import { syncQuizLogisticsForOrder } from "../_shared/quizLogistics.ts";
import { corsHeaders } from "../_shared/cors.ts";

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function sanitizeHeaders(headers: Headers) {
  const allowedHeaders = [
    "content-type",
    "user-agent",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "x-request-id",
  ];

  return Object.fromEntries(
    allowedHeaders
      .map((name) => [name, headers.get(name)])
      .filter(([, value]) => value),
  );
}

function parseBearerToken(headerValue: string | null) {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.trim().split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

function getWebhookToken(req: Request) {
  const url = new URL(req.url);
  return firstString([
    req.headers.get("x-webhook-shared-token"),
    req.headers.get("x-appmax-webhook-token"),
    url.searchParams.get("webhookSecret"),
    url.searchParams.get("token"),
    parseBearerToken(req.headers.get("authorization")),
  ]);
}

function isWebhookAuthorized(req: Request) {
  const expectedToken = Deno.env.get("APPMAX_WEBHOOK_SECRET")?.trim();

  if (!expectedToken) {
    return true;
  }

  const receivedToken = getWebhookToken(req);
  return receivedToken === expectedToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function firstNumber(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate.replace(",", "."));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function toIntegerMoney(value: unknown) {
  const amount = firstNumber([value]);
  if (amount === null) {
    return null;
  }

  return Math.round(amount * 100);
}

function normalizeAppmaxTimestamp(value: string | null | undefined) {
  const trimmed = firstString([value]);
  if (!trimmed) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}-03:00`
    : trimmed;
  const parsed = Date.parse(normalized);

  return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function mapAppmaxStatus(status: string | null | undefined) {
  switch ((status ?? "").trim().toLowerCase()) {
    case "aprovado":
    case "integrado":
    case "pendente_integracao":
    case "pendente_integracao_em_analise":
      return { paymentStatus: "paid", orderStatus: "paid" };
    case "autorizado":
    case "pendente":
      return { paymentStatus: "pending", orderStatus: "pending" };
    case "cancelado":
    case "recusado_por_risco":
      return { paymentStatus: "cancelled", orderStatus: "cancelled" };
    case "estornado":
    case "chargeback_em_tratativa":
    case "chargeback_em_disputa":
    case "chargeback_perdido":
    case "chargeback_vencido":
      return { paymentStatus: "refunded", orderStatus: "refunded" };
    default:
      return { paymentStatus: "pending", orderStatus: "pending" };
  }
}

function mapAppmaxEvent(eventName: string | null | undefined) {
  switch ((eventName ?? "").trim().toLowerCase()) {
    case "order_paid":
    case "order_approved":
    case "order_integrated":
      return { paymentStatus: "paid", orderStatus: "paid" };
    case "order_authorized":
    case "order_authorized_with_delay":
    case "order_pending":
      return { paymentStatus: "pending", orderStatus: "pending" };
    case "order_cancelled":
    case "order_canceled":
    case "order_declined":
      return { paymentStatus: "cancelled", orderStatus: "cancelled" };
    case "order_refunded":
    case "order_chargeback":
      return { paymentStatus: "refunded", orderStatus: "refunded" };
    case "order_disputed":
      return { paymentStatus: "disputed", orderStatus: "disputed" };
    case "order_expired":
      return { paymentStatus: "expired", orderStatus: "expired" };
    default:
      return null;
  }
}

function mergeProviderResponse(existing: unknown, next: Record<string, unknown>) {
  const current = isRecord(existing) ? existing : {};
  return { ...current, ...next };
}

function extractAppmaxWebhookData(payload: Record<string, unknown>) {
  const data = isRecord(payload.data) ? payload.data : {};
  const paymentInfo = isRecord(data.payment_info) ? data.payment_info : {};
  const creditCard = isRecord(paymentInfo.credit_card)
    ? paymentInfo.credit_card
    : {};

  const productsTotalCents = toIntegerMoney(data.total);
  const freightCents = toIntegerMoney(data.freight_value) ?? 0;
  const interestCents = toIntegerMoney(data.interest) ?? 0;
  const discountCents = toIntegerMoney(data.discount) ?? 0;
  const totalCents = productsTotalCents === null && freightCents === 0 &&
      interestCents === 0 && discountCents === 0
    ? null
    : Math.max(
      0,
      (productsTotalCents ?? 0) + freightCents + interestCents - discountCents,
    );

  return {
    eventName: firstString([payload.event, payload.type]),
    eventType: firstString([payload.event_type]),
    orderId: firstNumber([data.order_id, data.id]),
    status: firstString([data.status]),
    paidAt: firstString([data.paid_at, data.integrated_at, data.created_at]),
    paidAtIso: normalizeAppmaxTimestamp(
      firstString([data.paid_at, data.integrated_at, data.created_at]),
    ),
    totalCents,
    notificationType: firstString([data.notification_type]),
    receiptUrl: firstString([data.receipt_url, data.receiptUrl]),
    cardBrand: firstString([creditCard.card_brand]),
    authorizationCode: firstString([creditCard.authorization_code]),
    nsu: firstString([creditCard.nsu]),
    installments: firstNumber([creditCard.installments]),
    rawData: data,
  };
}

async function findQuizOrderByAppmaxOrderId(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  appmaxOrderId: number,
) {
  const { data, error } = await adminClient
    .from("quiz_orders")
    .select(
      "id, order_code, payment_method, payment_status, order_status, customer_name, customer_phone, customer_cpf, selected_color, items, total_cents, freight_cents, free_shipping, has_gift, shipping_cep, shipping_street, shipping_number, shipping_complement, shipping_neighborhood, shipping_city, shipping_state, provider_response, logistics_webhook_sent_at, receipt_url",
    )
    .eq("payment_method", "card")
    .contains("provider_response", {
      appmax: {
        order: {
          data: {
            order: {
              id: appmaxOrderId,
            },
          },
        },
      },
    })
    .maybeSingle();

  if (error) {
    throw new Error(
      `Não foi possível localizar o pedido Appmax ${appmaxOrderId}: ${error.message}`,
    );
  }

  return data;
}

async function syncMetaPurchaseForOrder(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  order: {
    id: number;
    order_code: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_cpf: string | null;
    total_cents: number | null;
    shipping_cep: string | null;
    shipping_city: string | null;
    shipping_state: string | null;
    provider_response: unknown;
  },
  eventTime?: string | null,
) {
  const existingMeta = extractStoredMetaPurchaseStatus(order.provider_response);
  if (existingMeta.purchaseSentAt) {
    return order.provider_response;
  }

  const tracking = extractStoredMetaTracking(order.provider_response);
  const eventId = order.order_code;

  try {
    const result = await sendMetaPurchaseEvent({
      orderCode: order.order_code,
      eventId,
      totalCents: Number(order.total_cents ?? 0),
      eventTime,
      customerName: order.customer_name ?? undefined,
      customerPhone: order.customer_phone ?? undefined,
      customerEmail: tracking.customerEmail ?? undefined,
      customerCpf: order.customer_cpf ?? undefined,
      shippingCity: order.shipping_city ?? undefined,
      shippingState: order.shipping_state ?? undefined,
      shippingZip: order.shipping_cep ?? undefined,
      eventSourceUrl: tracking.pageUrl ?? undefined,
      clientIpAddress: tracking.clientIp ?? undefined,
      clientUserAgent: tracking.userAgent ?? undefined,
      fbp: tracking.fbp ?? undefined,
      fbc: tracking.fbc ?? undefined,
    });

    const nextProviderResponse = mergeStoredMetaPurchaseStatus(
      order.provider_response,
      {
        purchaseEventId: result.eventId,
        purchaseSentAt: result.sent ? new Date().toISOString() : null,
        purchaseLastError: null,
        purchaseLastResponse: result.response ?? null,
        purchaseSkippedReason: result.skippedReason ?? null,
      },
    );

    await adminClient
      .from("quiz_orders")
      .update({
        provider_response: nextProviderResponse,
      })
      .eq("id", order.id);

    return nextProviderResponse;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Meta conversion failed.";
    console.error("[appmax-webhook] Meta purchase sync failed:", message);

    const nextProviderResponse = mergeStoredMetaPurchaseStatus(
      order.provider_response,
      {
        purchaseEventId: eventId,
        purchaseSentAt: null,
        purchaseLastError: message,
      },
    );

    await adminClient
      .from("quiz_orders")
      .update({
        provider_response: nextProviderResponse,
      })
      .eq("id", order.id);

    return nextProviderResponse;
  }
}

async function parseWebhookBody(req: Request) {
  const rawBody = await req.text();

  if (!rawBody.trim()) {
    return { rawBody: null, payload: null };
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return {
        rawBody,
        payload: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Keep the raw body for troubleshooting when the provider sends a non-JSON payload.
  }

  return { rawBody, payload: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "appmax-webhook",
      method: "POST",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Método não suportado.", 405);
  }

  if (!isWebhookAuthorized(req)) {
    return errorResponse("Webhook não autorizado.", 401);
  }

  try {
    const adminClient = createSupabaseAdminClient();
    const { rawBody, payload } = await parseWebhookBody(req);
    const eventName = typeof payload?.event === "string"
      ? payload.event
      : typeof payload?.type === "string"
      ? payload.type
      : null;

    const { error } = await adminClient
      .schema("appmax")
      .from("webhook_events")
      .insert({
        event_name: eventName,
        source_ip: getClientIp(req),
        user_agent: req.headers.get("user-agent"),
        content_type: req.headers.get("content-type"),
        headers: sanitizeHeaders(req.headers),
        payload,
        raw_body: rawBody,
      });

    if (error) {
      throw new Error(
        `Não foi possível registrar o webhook da Appmax: ${error.message}`,
      );
    }

    if (!payload) {
      return jsonResponse({ success: true, message: "Payload vazio." }, 200);
    }

    const parsed = extractAppmaxWebhookData(payload);
    const mappedStatus = mapAppmaxEvent(parsed.eventName) ??
      mapAppmaxStatus(parsed.status);

    if (parsed.eventType && parsed.eventType !== "order") {
      return jsonResponse({
        success: true,
        message: "Evento sem atualização de pedido.",
      }, 200);
    }

    if (!parsed.orderId) {
      return jsonResponse({
        success: true,
        message: "Evento sem order_id.",
      }, 200);
    }

    const order = await findQuizOrderByAppmaxOrderId(adminClient, parsed.orderId);

    if (!order) {
      console.log(
        `[appmax-webhook] Nenhum quiz_order encontrado para order_id=${parsed.orderId}`,
      );
      return jsonResponse({ success: true, message: "Order not found." }, 200);
    }

    const wasPaid = order.payment_status === "paid";
    const shouldIgnorePendingDowngrade = wasPaid &&
      mappedStatus.paymentStatus === "pending";
    const effectiveStatus = shouldIgnorePendingDowngrade
      ? {
        paymentStatus: order.payment_status ?? "paid",
        orderStatus: order.order_status ?? "paid",
      }
      : mappedStatus;
    const existingProviderResponse = isRecord(order.provider_response)
      ? order.provider_response
      : {};
    const existingAppmax = isRecord(existingProviderResponse.appmax)
      ? existingProviderResponse.appmax
      : {};
    const paidAmountCents = parsed.totalCents ??
      firstNumber([existingAppmax.charged_total_cents]) ??
      order.total_cents;
    const paidAt = parsed.paidAtIso ?? new Date().toISOString();

    const mergedProviderResponse = mergeProviderResponse(order.provider_response, {
      appmax: {
        ...existingAppmax,
        status: parsed.status ?? existingAppmax.status ?? null,
        charged_total_cents: paidAmountCents,
        webhook_event: parsed.eventName,
        webhook_event_type: parsed.eventType,
        webhook_notification_type: parsed.notificationType,
        webhook_received_at: new Date().toISOString(),
        webhook_paid_at: parsed.paidAtIso ?? parsed.paidAt ?? null,
        webhook_order_id: parsed.orderId,
        webhook_card_brand: parsed.cardBrand,
        webhook_authorization_code: parsed.authorizationCode,
        webhook_nsu: parsed.nsu,
        webhook_installments: parsed.installments,
        webhook_payload: payload,
      },
      appmax_webhook: payload,
    });

    const updatePayload: Record<string, unknown> = {
      payment_status: effectiveStatus.paymentStatus,
      order_status: effectiveStatus.orderStatus,
      last_webhook_payload: payload,
      provider_response: mergedProviderResponse,
    };

    if (effectiveStatus.paymentStatus === "paid") {
      updatePayload.paid_amount_cents = paidAmountCents;
      updatePayload.paid_at = paidAt;
      updatePayload.receipt_url = parsed.receiptUrl ?? order.receipt_url ?? null;
      updatePayload.last_error = null;
    }

    const { error: updateError } = await adminClient
      .from("quiz_orders")
      .update(updatePayload)
      .eq("id", order.id);

    if (updateError) {
      throw new Error(
        `Não foi possível atualizar o pedido ${order.order_code}: ${updateError.message}`,
      );
    }

    if (effectiveStatus.paymentStatus === "paid") {
      const paidOrder = {
        ...order,
        payment_status: effectiveStatus.paymentStatus,
        order_status: effectiveStatus.orderStatus,
        provider_response: mergedProviderResponse,
      };
      let providerResponseForDownstream = mergedProviderResponse;

      providerResponseForDownstream = await syncMetaPurchaseForOrder(
        adminClient,
        {
          id: order.id,
          order_code: order.order_code,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          customer_cpf: order.customer_cpf,
          total_cents: order.total_cents ?? paidAmountCents,
          shipping_cep: order.shipping_cep,
          shipping_city: order.shipping_city,
          shipping_state: order.shipping_state,
          provider_response: mergedProviderResponse,
        },
        paidAt,
      );

      if (!wasPaid) {
        const n8nPaidUrl = Deno.env.get("N8N_PIX_PAID_WEBHOOK_URL");
        if (n8nPaidUrl) {
          fetch(n8nPaidUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "payment_paid",
              orderCode: order.order_code,
              customerName: order.customer_name ?? "",
              customerPhone: order.customer_phone ?? "",
              totalCents: order.total_cents ?? paidAmountCents ?? 0,
              paidAt,
            }),
          }).catch((err) =>
            console.error("[appmax-webhook] N8N paid webhook error:", err)
          );
        }
      }

      await syncQuizLogisticsForOrder(adminClient, {
        id: paidOrder.id,
        order_code: paidOrder.order_code,
        customer_name: paidOrder.customer_name,
        customer_phone: paidOrder.customer_phone,
        customer_cpf: paidOrder.customer_cpf,
        selected_color: paidOrder.selected_color,
        items: paidOrder.items,
        total_cents: paidOrder.total_cents ?? paidAmountCents,
        freight_cents: paidOrder.freight_cents,
        free_shipping: paidOrder.free_shipping,
        has_gift: paidOrder.has_gift,
        shipping_cep: paidOrder.shipping_cep,
        shipping_street: paidOrder.shipping_street,
        shipping_number: paidOrder.shipping_number,
        shipping_complement: paidOrder.shipping_complement,
        shipping_neighborhood: paidOrder.shipping_neighborhood,
        shipping_city: paidOrder.shipping_city,
        shipping_state: paidOrder.shipping_state,
        provider_response: providerResponseForDownstream,
        logistics_webhook_sent_at: paidOrder.logistics_webhook_sent_at,
      }, {
        source: "appmax-webhook",
      });
    }

    return jsonResponse({
      success: true,
      orderCode: order.order_code,
      paymentStatus: effectiveStatus.paymentStatus,
      orderStatus: effectiveStatus.orderStatus,
    }, 200);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Erro inesperado no webhook da Appmax.";
    const isServerError = message.includes("Variável de ambiente ausente") ||
      message.includes("Não foi possível registrar");

    return errorResponse(message, isServerError ? 500 : 400);
  }
});
