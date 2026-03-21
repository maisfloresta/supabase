import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptSecret } from '../_shared/appmax.ts';

const ABACATEPAY_API_URL = 'https://api.abacatepay.com';
const APPMAX_API_URL = Deno.env.get('APPMAX_API_URL') ?? 'https://api.appmax.com.br';
const APPMAX_AUTH_URL = Deno.env.get('APPMAX_AUTH_URL') ?? 'https://auth.appmax.com.br/oauth2/token';
const APPMAX_SOFT_DESCRIPTOR = (Deno.env.get('APPMAX_SOFT_DESCRIPTOR') ?? 'MAISFLORESTA').slice(0, 13);
const CHECKOUT_DESCRIPTION = 'Receba Sementes - Mais Floresta';
const CHECKOUT_EXPIRATION_SECONDS = 60 * 60; // 1 hour
const FREIGHT_CENTS = 2500; // R$ 25,00
const APPMAX_MAX_INSTALLMENTS = 12;

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

function mapAppmaxStatus(status: string | null | undefined) {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'aprovado':
    case 'integrado':
    case 'pendente_integracao':
    case 'pendente_integracao_em_analise':
      return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'autorizado':
    case 'pendente':
      return { paymentStatus: 'pending', orderStatus: 'pending' };
    case 'cancelado':
    case 'recusado_por_risco':
      return { paymentStatus: 'cancelled', orderStatus: 'cancelled' };
    case 'estornado':
    case 'chargeback_em_tratativa':
    case 'chargeback_em_disputa':
    case 'chargeback_perdido':
    case 'chargeback_vencido':
      return { paymentStatus: 'refunded', orderStatus: 'refunded' };
    default:
      return { paymentStatus: 'pending', orderStatus: 'pending' };
  }
}

function digitsOnly(value: string | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOfRecords(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function firstString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function firstNumber(candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim()) {
      const normalized = candidate.replace(',', '.');
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function findValueByKeys(input: unknown, keys: string[]): unknown {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findValueByKeys(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (!isRecord(input)) return undefined;

  for (const [key, value] of Object.entries(input)) {
    if (keys.includes(key)) {
      return value;
    }
  }

  for (const value of Object.values(input)) {
    const found = findValueByKeys(value, keys);
    if (found !== undefined) return found;
  }

  return undefined;
}

function toIntegerMoney(value: unknown) {
  const amount = firstNumber([value]);
  if (amount === null) return null;

  return Number.isInteger(amount) ? amount : Math.round(amount * 100);
}

function splitCustomerName(fullName: string) {
  const normalized = fullName.trim().replace(/\s+/g, ' ');
  const [firstName, ...rest] = normalized.split(' ').filter(Boolean);

  return {
    firstName: firstName || 'Cliente',
    lastName: rest.join(' ') || 'Mais Floresta',
  };
}

function formatPrice(cents: number) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function buildInstallmentLabel(installments: number, installmentCents: number, totalCents: number) {
  if (installments === 1) {
    return `1x de ${formatPrice(totalCents)} à vista`;
  }

  return `${installments}x de ${formatPrice(installmentCents)}`;
}

function buildCardInstallmentOptions(totalCents: number) {
  return Array.from({ length: APPMAX_MAX_INSTALLMENTS }, (_, index) => {
    const installments = index + 1;
    const installmentCents = Math.round(totalCents / installments);

    return {
      installments,
      totalCents,
      installmentCents,
      label: buildInstallmentLabel(installments, installmentCents, totalCents),
    };
  });
}

function buildCardDisabledConfig(reason: string) {
  return {
    enabled: false,
    reason,
    externalId: null,
    installments: [] as Array<{
      installments: number;
      totalCents: number;
      installmentCents: number;
      label: string;
    }>,
  };
}

function mergeProviderResponse(existing: unknown, next: Record<string, unknown>) {
  const current = isRecord(existing) ? existing : {};
  return { ...current, ...next };
}

function extractAppmaxStatus(payload: unknown) {
  return firstString([
    findValueByKeys(payload, ['status']),
    findValueByKeys(payload, ['order_status']),
    findValueByKeys(payload, ['payment_status']),
  ]);
}

function extractAppmaxReceiptUrl(payload: unknown) {
  return firstString([
    findValueByKeys(payload, ['receipt_url']),
    findValueByKeys(payload, ['receiptUrl']),
    findValueByKeys(payload, ['invoice_url']),
    findValueByKeys(payload, ['invoiceUrl']),
  ]);
}

function extractAppmaxPaymentId(payload: unknown) {
  return firstString([
    findValueByKeys(payload, ['payment_id']),
    findValueByKeys(payload, ['appmax_payment_id']),
    findValueByKeys(payload, ['id']),
  ]);
}

function extractAppmaxInstallmentOption(payload: unknown, installments: number, originalTotalCents: number) {
  const quotedInstallmentCents = toIntegerMoney(
    findValueByKeys(payload, ['installment_value', 'installment_amount', 'value_per_installment']),
  );
  const quotedTotalCents = toIntegerMoney(
    findValueByKeys(payload, ['total_value', 'amount_total', 'value_total', 'total']),
  );

  const installmentCents = quotedInstallmentCents ??
    (quotedTotalCents !== null ? Math.round(quotedTotalCents / installments) : null);
  const totalCents = quotedTotalCents ??
    (installmentCents !== null ? installmentCents * installments : null);

  if (installmentCents === null || totalCents === null) {
    return {
      installments,
      totalCents: originalTotalCents,
      installmentCents: Math.round(originalTotalCents / installments),
      label: buildInstallmentLabel(installments, Math.round(originalTotalCents / installments), originalTotalCents),
    };
  }

  return {
    installments,
    totalCents,
    installmentCents,
    label: buildInstallmentLabel(installments, installmentCents, totalCents),
  };
}

// ─── Product catalog (matches UpsellScreen) ───

const CATALOG: Record<string, { id: number; name: string; options: { label: string; subtitle: string; priceCents: number }[] }> = {
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
  mix?: number | null;
  bandeja?: number | null;
  fertilizante?: number | null;
}

interface ShippingAddress {
  cep: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
}

interface LineItem {
  productId: number;
  name: string;
  optionLabel: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

interface AppmaxInstallationRow {
  external_id: string;
  merchant_client_id_encrypted: string;
  merchant_client_secret_encrypted: string;
}

interface AppmaxMerchantCredentials {
  externalId: string;
  clientId: string;
  clientSecret: string;
}

function validateAndCalculateCart(cart: CartInput) {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;

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
    subtotalCents += option.priceCents;
  }

  if (lineItems.length === 0) {
    throw new Error('Nenhum item selecionado.');
  }

  const hasGift = subtotalCents >= GIFT_THRESHOLD_CENTS;
  const freeShipping = lineItems.length === 3;
  const freightCents = freeShipping ? 0 : FREIGHT_CENTS;
  const totalCents = subtotalCents + freightCents;

  return { lineItems, subtotalCents, totalCents, freightCents, hasGift, freeShipping };
}

// ─── AbacatePay API ───

async function abacatePayRequest(path: string, init: RequestInit, useV1Key = false) {
  const apiKey = useV1Key ? getEnv('ABACATEPAY_API_KEY_V1') : getEnv('ABACATEPAY_API_KEY');
  const response = await fetch(`${ABACATEPAY_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  console.error(`[AbacatePay] ${path} -> status=${response.status} response=${JSON.stringify(payload)}`);

  if (!response.ok) {
    const msg = (payload as any)?.error || (payload as any)?.message || 'Falha ao comunicar com a AbacatePay.';
    throw new Error(typeof msg === 'string' ? msg : 'Falha ao comunicar com a AbacatePay.');
  }

  return payload;
}

// ─── Appmax API ───

async function appmaxAuthRequest(credentials: AppmaxMerchantCredentials) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });

  const response = await fetch(APPMAX_AUTH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const payload = await response.json().catch(() => null);

  console.error(`[Appmax] auth -> status=${response.status} response=${JSON.stringify(payload)}`);

  if (!response.ok) {
    const msg = firstString([
      (payload as any)?.error_description,
      (payload as any)?.error,
      (payload as any)?.message,
    ]) ?? 'Falha ao autenticar com a Appmax.';
    throw new Error(msg);
  }

  const accessToken = firstString([
    (payload as any)?.access_token,
    (payload as any)?.data?.access_token,
    (payload as any)?.token,
  ]);

  if (!accessToken) {
    throw new Error('Resposta inválida da autenticação Appmax.');
  }

  return accessToken;
}

async function appmaxApiRequest(path: string, init: RequestInit, accessToken: string) {
  const response = await fetch(`${APPMAX_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => null);

  console.error(`[Appmax] ${path} -> status=${response.status} response=${JSON.stringify(payload)}`);

  if (!response.ok) {
    const msg = firstString([
      (payload as any)?.error,
      (payload as any)?.message,
      (payload as any)?.errors?.[0],
    ]) ?? 'Falha ao comunicar com a Appmax.';
    throw new Error(msg);
  }

  return payload;
}

async function getLatestAppmaxInstallation(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin
    .schema('appmax')
    .from('installations')
    .select('external_id, merchant_client_id_encrypted, merchant_client_secret_encrypted')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<AppmaxInstallationRow>();

  if (error) {
    throw new Error(`Não foi possível consultar a instalação Appmax: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return {
    externalId: data.external_id,
    clientId: await decryptSecret(data.merchant_client_id_encrypted),
    clientSecret: await decryptSecret(data.merchant_client_secret_encrypted),
  } satisfies AppmaxMerchantCredentials;
}

function buildAppmaxProducts(items: LineItem[]) {
  return items.map((item) => ({
    sku: String(item.productId),
    name: `${item.name} - ${item.optionLabel}`,
    quantity: item.quantity,
    unit_value: item.unitPriceCents,
    type: 'physical',
  }));
}

async function quoteAppmaxInstallments(accessToken: string, totalCents: number) {
  const quotes = await Promise.all(
    Array.from({ length: APPMAX_MAX_INSTALLMENTS }, (_, index) => index + 1).map(async (installments) => {
      try {
        const payload = await appmaxApiRequest(
          '/v1/payments/installments',
          {
            method: 'POST',
            body: JSON.stringify({
              installments,
              total_value: totalCents,
              settings: true,
            }),
          },
          accessToken,
        );

        return extractAppmaxInstallmentOption(payload, installments, totalCents);
      } catch (error) {
        console.error(`[quiz-pix] installments quote failed (${installments}x):`, error);
        return null;
      }
    }),
  );

  const parsedQuotes = quotes.filter((quote): quote is NonNullable<typeof quote> => quote !== null);
  return parsedQuotes.length > 0 ? parsedQuotes : buildCardInstallmentOptions(totalCents);
}

async function buildCardCheckoutConfig(admin: ReturnType<typeof createAdminClient>, totalCents: number) {
  const installation = await getLatestAppmaxInstallation(admin);

  if (!installation) {
    return buildCardDisabledConfig('O cartão Appmax será liberado assim que a instalação do aplicativo for concluída na Appmax.');
  }

  try {
    const accessToken = await appmaxAuthRequest(installation);
    const installments = await quoteAppmaxInstallments(accessToken, totalCents);

    return {
      enabled: true,
      reason: null,
      externalId: installation.externalId,
      installments,
    };
  } catch (error) {
    console.error('[quiz-pix] Appmax card config unavailable:', error);
    return buildCardDisabledConfig('O cartão está temporariamente indisponível. Tente novamente em instantes.');
  }
}

// ─── Actions ───

interface CreateInput {
  customerName: string;
  customerPhone: string;
  customerCpf: string;
  customerEmail?: string;
  customerRegion?: string;
  selectedColor?: string;
  quizAnswers?: Record<string, unknown>;
  cart: CartInput;
  shipping: ShippingAddress;
}

interface CardPaymentInput {
  orderCode: string;
  token: string;
  holderName: string;
  holderDocumentNumber: string;
  installments: number;
  customerIp?: string;
}

async function createPixCharge(input: CreateInput) {
  const admin = createAdminClient();
  const { lineItems, subtotalCents, totalCents, freightCents, hasGift, freeShipping } = validateAndCalculateCart(input.cart);
  const orderCode = buildOrderCode();

  // Validate shipping
  const s = input.shipping;
  if (!s.cep || !s.street || !s.number || !s.neighborhood || !s.city || !s.state) {
    throw new Error('Endereço de envio incompleto.');
  }

  // 1. Create pending order in DB
  const { data: order, error: orderError } = await admin
    .from('quiz_orders')
    .insert({
      order_code: orderCode,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      customer_cpf: input.customerCpf,
      customer_region: input.customerRegion ?? null,
      selected_color: input.selectedColor ?? null,
      quiz_answers: input.quizAnswers ?? {},
      items: lineItems,
      total_cents: totalCents,
      freight_cents: freightCents,
      has_gift: hasGift,
      free_shipping: freeShipping,
      shipping_cep: s.cep,
      shipping_street: s.street,
      shipping_number: s.number,
      shipping_complement: s.complement ?? null,
      shipping_neighborhood: s.neighborhood,
      shipping_city: s.city,
      shipping_state: s.state,
    })
    .select('id, order_code')
    .single();

  if (orderError || !order) {
    throw new Error(`Não foi possível criar o pedido: ${orderError?.message ?? 'sem retorno'}`);
  }

  const cardConfigPromise = buildCardCheckoutConfig(admin, totalCents).catch((error) => {
    console.error('[quiz-pix] Appmax card config failed:', error);
    return buildCardDisabledConfig('O cartão está temporariamente indisponível. Tente novamente em instantes.');
  });

  // 2. Create charge in AbacatePay (PIX)
  try {
    const createPayload = await abacatePayRequest('/v2/transparents/create', {
      method: 'POST',
      body: JSON.stringify({
        method: 'PIX',
        data: {
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
        },
      }),
    });

    const chargeData = (createPayload as any)?.data;
    if (!chargeData?.id) {
      throw new Error('Resposta inválida ao gerar o pagamento.');
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
        provider_response: {
          abacatepay: chargeData,
        },
        expires_at: chargeData.expiresAt ?? null,
      })
      .eq('order_code', orderCode);

    const card = await cardConfigPromise;

    return {
      orderCode: order.order_code,
      pixId: chargeData.id,
      subtotalCents,
      freightCents,
      amountCents: totalCents,
      brCode: chargeData.brCode ?? '',
      brCodeBase64: chargeData.brCodeBase64 ?? null,
      checkoutUrl: null,
      card,
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
    throw new Error('Resposta inválida ao consultar o pagamento.');
  }

  const { data: currentOrder } = await admin
    .from('quiz_orders')
    .select('payment_method, payment_status')
    .eq('transparent_id', chargeData.id ?? pixId)
    .maybeSingle();

  if (currentOrder?.payment_method === 'card') {
    return {
      pixId: chargeData.id ?? pixId,
      status: (chargeData.status ?? 'PENDING').toUpperCase(),
      amountCents: chargeData.amount ?? 0,
      paidAmount: chargeData.paidAmount ?? null,
    };
  }

  const mapped = mapStatus(chargeData.status);

  const updatePayload: Record<string, unknown> = {
    payment_status: mapped.paymentStatus,
    order_status: mapped.orderStatus,
    dev_mode: Boolean(chargeData.devMode),
    provider_response: {
      abacatepay: chargeData,
    },
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

async function processCardPayment(input: CardPaymentInput) {
  const admin = createAdminClient();

  if (!input.orderCode.trim()) {
    throw new Error('Pedido inválido.');
  }

  if (!input.token.trim()) {
    throw new Error('Token do cartão inválido.');
  }

  if (!input.holderName.trim()) {
    throw new Error('Nome do titular é obrigatório.');
  }

  const holderDocumentNumber = digitsOnly(input.holderDocumentNumber);
  if (holderDocumentNumber.length !== 11) {
    throw new Error('CPF do titular inválido.');
  }

  if (!Number.isInteger(input.installments) || input.installments < 1 || input.installments > APPMAX_MAX_INSTALLMENTS) {
    throw new Error('Parcelamento inválido.');
  }

  const { data: order, error: orderError } = await admin
    .from('quiz_orders')
    .select(`
      id,
      order_code,
      customer_name,
      customer_phone,
      customer_cpf,
      total_cents,
      freight_cents,
      shipping_cep,
      shipping_street,
      shipping_number,
      shipping_complement,
      shipping_neighborhood,
      shipping_city,
      shipping_state,
      items,
      payment_status,
      provider_response
    `)
    .eq('order_code', input.orderCode.trim())
    .single();

  if (orderError || !order) {
    throw new Error('Pedido não encontrado.');
  }

  if (order.payment_status === 'paid') {
    return {
      orderCode: order.order_code,
      status: 'APROVADO',
      paymentStatus: 'paid',
      orderStatus: 'paid',
      isPaid: true,
      receiptUrl: extractAppmaxReceiptUrl(order.provider_response),
      message: 'Pagamento já confirmado.',
    };
  }

  const installation = await getLatestAppmaxInstallation(admin);
  if (!installation) {
    throw new Error('A instalação Appmax ainda não foi concluída. Finalize a instalação do aplicativo e tente novamente.');
  }

  const accessToken = await appmaxAuthRequest(installation);
  const items = isArrayOfRecords(order.items) ? order.items : [];
  if (items.length === 0) {
    throw new Error('Pedido sem itens.');
  }

  const lineItems: LineItem[] = items.map((item) => ({
    productId: Number(item.productId ?? item.product_id ?? 0),
    name: String(item.name ?? ''),
    optionLabel: String(item.optionLabel ?? item.option_label ?? ''),
    quantity: Number(item.quantity ?? 1),
    unitPriceCents: Number(item.unitPriceCents ?? item.unit_price_cents ?? item.totalCents ?? item.total_cents ?? 0),
    totalCents: Number(item.totalCents ?? item.total_cents ?? item.unitPriceCents ?? item.unit_price_cents ?? 0),
  }));

  const shippingAddress: ShippingAddress = {
    cep: String(order.shipping_cep ?? ''),
    street: String(order.shipping_street ?? ''),
    number: String(order.shipping_number ?? ''),
    complement: order.shipping_complement ? String(order.shipping_complement) : undefined,
    neighborhood: String(order.shipping_neighborhood ?? ''),
    city: String(order.shipping_city ?? ''),
    state: String(order.shipping_state ?? ''),
  };

  const { firstName, lastName } = splitCustomerName(order.customer_name);
  const customerEmail = `${digitsOnly(order.customer_cpf)}@cliente.maisfloresta.cloud`;
  const customerIp = input.customerIp?.trim() || undefined;
  const appmaxProducts = buildAppmaxProducts(lineItems);

  const customerPayload = await appmaxApiRequest(
    '/v1/customers',
    {
      method: 'POST',
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        email: customerEmail,
        phone: digitsOnly(order.customer_phone),
        document_number: digitsOnly(order.customer_cpf),
        address: {
          postcode: digitsOnly(shippingAddress.cep),
          street: shippingAddress.street,
          number: shippingAddress.number,
          complement: shippingAddress.complement ?? '',
          district: shippingAddress.neighborhood,
          city: shippingAddress.city,
          state: shippingAddress.state,
        },
        ip: customerIp,
        products: appmaxProducts,
      }),
    },
    accessToken,
  );

  const customerId = firstNumber([
    findValueByKeys(customerPayload, ['customer_id']),
    findValueByKeys(customerPayload, ['id']),
  ]);

  if (!customerId) {
    throw new Error('A Appmax não retornou o customer_id do cliente.');
  }

  const orderPayload = await appmaxApiRequest(
    '/v1/orders',
    {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        products_value: Number(order.total_cents) - Number(order.freight_cents ?? 0),
        discount_value: 0,
        shipping_value: Number(order.freight_cents ?? 0),
        products: appmaxProducts,
      }),
    },
    accessToken,
  );

  const appmaxOrderId = firstNumber([
    findValueByKeys(orderPayload, ['order_id']),
    findValueByKeys(orderPayload, ['id']),
  ]);

  if (!appmaxOrderId) {
    throw new Error('A Appmax não retornou o order_id do pedido.');
  }

  const paymentPayload = await appmaxApiRequest(
    '/v1/payments/credit-card',
    {
      method: 'POST',
      body: JSON.stringify({
        order_id: appmaxOrderId,
        customer_id: customerId,
        payment_data: {
          credit_card: {
            token: input.token.trim(),
            holder_document_number: holderDocumentNumber,
            holder_name: input.holderName.trim(),
            installments: input.installments,
            soft_descriptor: APPMAX_SOFT_DESCRIPTOR,
          },
        },
      }),
    },
    accessToken,
  );

  const appmaxStatus = extractAppmaxStatus(paymentPayload) ?? 'pendente';
  const mappedStatus = mapAppmaxStatus(appmaxStatus);
  const receiptUrl = extractAppmaxReceiptUrl(paymentPayload);
  const appmaxPaymentId = extractAppmaxPaymentId(paymentPayload);
  const isPaid = mappedStatus.paymentStatus === 'paid';

  const providerResponse = mergeProviderResponse(order.provider_response, {
    abacatepay: isRecord(order.provider_response) ? (order.provider_response as any).abacatepay ?? null : null,
    appmax: {
      installation_external_id: installation.externalId,
      customer: customerPayload,
      order: orderPayload,
      payment: paymentPayload,
      payment_id: appmaxPaymentId,
      status: appmaxStatus,
    },
  });

  await admin
    .from('quiz_orders')
    .update({
      payment_method: 'card',
      payment_status: mappedStatus.paymentStatus,
      order_status: mappedStatus.orderStatus,
      paid_amount_cents: isPaid ? Number(order.total_cents) : null,
      paid_at: isPaid ? new Date().toISOString() : null,
      receipt_url: receiptUrl,
      provider_response: providerResponse,
      last_error: null,
    })
    .eq('id', order.id);

  const message = mappedStatus.paymentStatus === 'paid'
    ? 'Pagamento confirmado com sucesso.'
    : mappedStatus.paymentStatus === 'pending'
      ? 'Pagamento enviado para análise da operadora.'
      : 'O pagamento não foi aprovado.';

  return {
    orderCode: order.order_code,
    status: appmaxStatus.toUpperCase(),
    paymentStatus: mappedStatus.paymentStatus,
    orderStatus: mappedStatus.orderStatus,
    isPaid,
    receiptUrl,
    appmaxPaymentId,
    message,
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
      const shipping = (body.shipping ?? {}) as Record<string, unknown>;
      const data = await createPixCharge({
        customerName: String(body.customerName ?? ''),
        customerPhone: String(body.customerPhone ?? ''),
        customerCpf: String(body.customerCpf ?? ''),
        customerEmail: body.customerEmail ? String(body.customerEmail) : undefined,
        customerRegion: body.customerRegion ? String(body.customerRegion) : undefined,
        selectedColor: body.selectedColor ? String(body.selectedColor) : undefined,
        quizAnswers: typeof body.quizAnswers === 'object' ? (body.quizAnswers as Record<string, unknown>) : undefined,
        cart: (body.cart ?? {}) as CartInput,
        shipping: {
          cep: String(shipping.cep ?? ''),
          street: String(shipping.street ?? ''),
          number: String(shipping.number ?? ''),
          complement: shipping.complement ? String(shipping.complement) : undefined,
          neighborhood: String(shipping.neighborhood ?? ''),
          city: String(shipping.city ?? ''),
          state: String(shipping.state ?? ''),
        },
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

    if (action === 'card') {
      const data = await processCardPayment({
        orderCode: String(body.orderCode ?? ''),
        token: String(body.token ?? ''),
        holderName: String(body.holderName ?? ''),
        holderDocumentNumber: String(body.holderDocumentNumber ?? ''),
        installments: Number(body.installments ?? 0),
        customerIp: body.customerIp ? String(body.customerIp) : undefined,
      });
      return jsonResponse({ success: true, data });
    }

    return errorResponse('Ação inválida.', 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro inesperado.';
    const status = message.includes('Variável de ambiente') ||
        message.includes('Falha ao comunicar') ||
        message.includes('Não foi possível consultar a instalação Appmax')
      ? 500
      : 400;
    return errorResponse(message, status);
  }
});
