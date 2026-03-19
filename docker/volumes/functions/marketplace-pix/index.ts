import {
  abacatePayRequest,
  buildMarketplaceOrderCode,
  createSupabaseAdminClient,
  getAuthenticatedUser,
  mapAbacatePayStatus,
  normalizeChargePayload,
} from '../_shared/abacatepay.ts';
import { corsHeaders } from '../_shared/cors.ts';
import {
  buildMarketplaceCartSignature,
  calculateMarketplaceCart,
  type MarketplaceCartInputItem,
} from '../_shared/marketplaceCatalog.ts';

const CHECKOUT_DESCRIPTION = 'Marketplace Mais Floresta';
const CHECKOUT_EXPIRATION_SECONDS = 60 * 60;

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  cpf: string;
  phone: string | null;
}

function jsonResponse(payload: { success: boolean; data?: unknown; error?: string }, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchProfile(adminClient: ReturnType<typeof createSupabaseAdminClient>, authUserId: string) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, email, full_name, cpf, phone')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (error) {
    throw new Error(`Não foi possível carregar o perfil do usuário: ${error.message}`);
  }

  return (data ?? null) as ProfileRow | null;
}

async function createPendingOrder(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    authUserId: string;
    profile: ProfileRow | null;
    totalCents: number;
    cartSignature: string;
    items: ReturnType<typeof calculateMarketplaceCart>['lineItems'];
  },
) {
  const externalId = buildMarketplaceOrderCode();
  const serializedItems = input.items.map((item) => ({
    productId: item.product.id,
    sku: (item.product as { sku?: string }).sku ?? null,
    name: item.product.name,
    description: item.product.description,
    category: item.product.category,
    quantity: item.quantity,
    unit_price_cents: item.unitPriceCents,
    total_cents: item.subtotalCents,
  }));

  const { data: order, error: orderError } = await adminClient
    .schema('abacatepay')
    .from('orders')
    .insert({
      auth_user_id: input.authUserId,
      profile_id: input.profile?.id ?? null,
      external_id: externalId,
      customer_name: input.profile?.full_name ?? null,
      customer_email: input.profile?.email ?? null,
      customer_tax_id: input.profile?.cpf ?? null,
      customer_phone: input.profile?.phone ?? null,
      order_status: 'pending',
      payment_status: 'pending',
      payment_method: 'pix',
      currency: 'BRL',
      total_cents: input.totalCents,
      items: serializedItems,
      provider_metadata: {
        source: 'maisfloresta-marketplace',
        cartSignature: input.cartSignature,
        marketplaceTotalCents: input.totalCents,
      },
    })
    .select('id, external_id')
    .single();

  if (orderError || !order) {
    throw new Error(`Não foi possível criar o pedido pendente: ${orderError?.message ?? 'sem retorno'}`);
  }

  const { error: itemsError } = await adminClient
    .schema('abacatepay')
    .from('order_items')
    .insert(
      serializedItems.map((item) => ({
        order_id: order.id,
        product_id: item.productId,
        sku: item.sku,
        product_name: item.name,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        total_cents: item.total_cents,
        raw_item: item,
      })),
    );

  if (itemsError) {
    throw new Error(`Não foi possível registrar os itens do pedido: ${itemsError.message}`);
  }

  return {
    id: Number(order.id),
    externalId: String(order.external_id),
  };
}

async function updateOrderAfterCreate(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  externalId: string,
  payload: Record<string, unknown>,
) {
  const charge = normalizeChargePayload(payload);
  const mappedStatus = mapAbacatePayStatus(charge.status);

  const updatePayload: Record<string, unknown> = {
    transparent_id: charge.id,
    payment_status: mappedStatus.paymentStatus,
    order_status: mappedStatus.orderStatus,
    dev_mode: charge.devMode,
    provider_response: payload,
    expires_at: charge.expiresAt,
    event_time: charge.updatedAt ?? charge.createdAt ?? null,
    last_error: null,
  };

  if (mappedStatus.paymentStatus === 'paid') {
    updatePayload.paid_amount_cents = charge.amountCents;
    updatePayload.paid_at = charge.updatedAt ?? charge.createdAt ?? new Date().toISOString();
  }

  const { error } = await adminClient
    .schema('abacatepay')
    .from('orders')
    .update(updatePayload)
    .eq('external_id', externalId);

  if (error) {
    throw new Error(`Não foi possível atualizar o pedido após criar o PIX: ${error.message}`);
  }
}

async function updateOrderAfterFailedCreate(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  externalId: string,
  message: string,
) {
  await adminClient
    .schema('abacatepay')
    .from('orders')
    .update({
      order_status: 'failed',
      payment_status: 'failed',
      last_error: message,
    })
    .eq('external_id', externalId);
}

async function syncOrderFromCharge(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  payload: Record<string, unknown>,
  fallbackAmountCents?: number,
) {
  const charge = normalizeChargePayload(payload, fallbackAmountCents);
  const mappedStatus = mapAbacatePayStatus(charge.status);

  const updatePayload: Record<string, unknown> = {
    payment_status: mappedStatus.paymentStatus,
    order_status: mappedStatus.orderStatus,
    dev_mode: charge.devMode,
    provider_response: payload,
    expires_at: charge.expiresAt,
    event_time: charge.updatedAt ?? charge.createdAt ?? null,
    last_error: null,
  };

  if (mappedStatus.paymentStatus === 'paid') {
    updatePayload.paid_amount_cents = charge.amountCents;
    updatePayload.paid_at = charge.updatedAt ?? charge.createdAt ?? new Date().toISOString();
  }

  const { error } = await adminClient
    .schema('abacatepay')
    .from('orders')
    .update(updatePayload)
    .eq('transparent_id', charge.id);

  if (error) {
    throw new Error(`Não foi possível sincronizar o status do pedido: ${error.message}`);
  }

  return charge;
}

async function createPixCharge(reqBody: Record<string, unknown>, req: Request) {
  const user = await getAuthenticatedUser(req);
  const adminClient = createSupabaseAdminClient();
  const rawItems = reqBody.items;

  if (!Array.isArray(rawItems)) {
    throw new Error('Itens do carrinho inválidos.');
  }

  const items = rawItems.map((item) => {
    if (!isObject(item)) {
      throw new Error('Item do carrinho inválido.');
    }

    return {
      productId: Number(item.productId),
      quantity: Number(item.quantity),
    } satisfies MarketplaceCartInputItem;
  });

  const profile = await fetchProfile(adminClient, user.id);
  const { lineItems, totalCents } = calculateMarketplaceCart(items);
  const cartSignature = buildMarketplaceCartSignature(items);
  const pendingOrder = await createPendingOrder(adminClient, {
    authUserId: user.id,
    profile,
    totalCents,
    cartSignature,
    items: lineItems,
  });

  try {
    const createPayload = await abacatePayRequest('/v1/pixQrCode/create', {
      method: 'POST',
      body: JSON.stringify({
        amount: totalCents,
        description: CHECKOUT_DESCRIPTION,
        expiresIn: CHECKOUT_EXPIRATION_SECONDS,
        metadata: {
          source: 'maisfloresta-marketplace',
          marketplaceOrderId: String(pendingOrder.id),
          marketplaceOrderCode: pendingOrder.externalId,
          marketplaceTotalCents: String(totalCents),
          cartSignature,
          userId: user.id,
          userEmail: user.email ?? '',
        },
      }),
    });

    if (!createPayload || !isObject(createPayload.data)) {
      throw new Error('Resposta inválida ao gerar o PIX.');
    }

    await updateOrderAfterCreate(adminClient, pendingOrder.externalId, createPayload.data);

    return normalizeChargePayload(createPayload.data, totalCents);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado ao gerar o PIX.';
    await updateOrderAfterFailedCreate(adminClient, pendingOrder.externalId, message);
    throw error;
  }
}

async function getPixStatus(reqBody: Record<string, unknown>, req: Request) {
  await getAuthenticatedUser(req);
  const adminClient = createSupabaseAdminClient();

  if (typeof reqBody.pixId !== 'string' || !reqBody.pixId.trim()) {
    throw new Error('ID do PIX inválido.');
  }

  const query = new URLSearchParams({ id: reqBody.pixId.trim() });
  const statusPayload = await abacatePayRequest(`/v1/pixQrCode/check?${query.toString()}`, {
    method: 'GET',
  });

  if (!statusPayload || !isObject(statusPayload.data)) {
    throw new Error('Resposta inválida ao consultar o PIX.');
  }

  return syncOrderFromCharge(adminClient, statusPayload.data);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Método não suportado.', 405);
  }

  try {
    const reqBody = (await req.json()) as Record<string, unknown>;
    const action = reqBody.action;

    if (action === 'create') {
      const data = await createPixCharge(reqBody, req);
      return jsonResponse({ success: true, data });
    }

    if (action === 'status') {
      const data = await getPixStatus(reqBody, req);
      return jsonResponse({ success: true, data });
    }

    return errorResponse('Ação inválida para o checkout PIX.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado no checkout PIX.';
    const isAuthError = message.includes('autenticado') || message.includes('Sessão');
    const isServerError =
      message.includes('Variável de ambiente ausente') ||
      message.includes('Falha ao comunicar com a AbacatePay') ||
      message.includes('Resposta inválida') ||
      message.includes('Não foi possível');

    return errorResponse(message, isAuthError ? 401 : isServerError ? 500 : 400);
  }
});
