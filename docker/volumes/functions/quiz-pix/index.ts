import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptSecret } from '../_shared/appmax.ts';
import {
  extractStoredMetaPurchaseStatus,
  extractStoredMetaTracking,
  mergeStoredMetaPurchaseStatus,
  mergeStoredMetaTracking,
  sendMetaPurchaseEvent,
  type MetaTrackingRecord,
} from '../_shared/meta.ts';
import { syncQuizLogisticsForOrder } from '../_shared/quizLogistics.ts';

const ABACATEPAY_API_URL = 'https://api.abacatepay.com';
const APPMAX_API_URL = Deno.env.get('APPMAX_API_URL') ?? 'https://api.appmax.com.br';
const APPMAX_AUTH_URL = Deno.env.get('APPMAX_AUTH_URL') ?? 'https://auth.appmax.com.br/oauth2/token';
const APPMAX_EXTERNAL_KEY = (Deno.env.get('APPMAX_DEFAULT_EXTERNAL_KEY') ?? 'quiz.maisfloresta.cloud').trim();
// The canonical Appmax App ID (UUID). Falls back to the legacy numeric
// `APPMAX_VALIDATION_APP_ID` only if `APPMAX_APP_ID` is not set, so stale
// installation rows bound to the old numeric app_id are ignored.
const APPMAX_APP_ID = (Deno.env.get('APPMAX_APP_ID')?.trim())
  || (Deno.env.get('APPMAX_VALIDATION_APP_ID')?.trim())
  || null;
const APPMAX_SOFT_DESCRIPTOR = (Deno.env.get('APPMAX_SOFT_DESCRIPTOR') ?? 'MAISFLORESTA').slice(0, 13);
const CHECKOUT_DESCRIPTION = 'Receba Sementes - Mais Floresta';
const CHECKOUT_EXPIRATION_SECONDS = 60 * 60; // 1 hour
const FREIGHT_CENTS = 2500; // R$ 25,00
const APPMAX_MAX_INSTALLMENTS = 12;
const APPMAX_INSTALLMENT_FEE_RATE = 0.0219;

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const allowed = isOriginAllowed(req);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

function isOriginAllowed(req: Request) {
  if (ALLOWED_ORIGINS.length === 0) {
    return true;
  }

  const origin = req.headers.get('origin') ?? '';
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Allow any *.maisfloresta.cloud subdomain and Lovable preview domains
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith('.maisfloresta.cloud') || host.endsWith('.lovable.app') || host.endsWith('.lovableproject.com')) {
      return true;
    }
  } catch { /* invalid origin */ }

  return false;
}

// ── Rate limiter (per order code / per IP, per instance) ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(key: string, maxRequests = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxRequests;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

// ── CPF validation (server-side) ──
function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(digits[i]) * (t + 1 - i);
    const remainder = (sum * 10) % 11;
    if ((remainder === 10 ? 0 : remainder) !== Number(digits[t])) return false;
  }
  return true;
}

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

function createAdminClient() {
  return createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

// Note: jsonResponse/errorResponse now accept cors parameter
let _currentCors: Record<string, string> = {};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ..._currentCors, 'Content-Type': 'application/json' },
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

function summarizeAppmaxLogPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return payload;
  }

  return {
    error: firstString([
      payload.error,
      payload.error_description,
      payload.message,
      isRecord(payload.errors) ? payload.errors.message : null,
    ]),
    status: firstString([
      payload.status,
      isRecord(payload.data) ? payload.data.status : null,
    ]),
    code: firstString([
      payload.code,
      isRecord(payload.error) ? (payload.error as Record<string, unknown>).code : null,
    ]),
  };
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

function calculateCardChargeTotalCents(totalCents: number, installments: number) {
  if (installments <= 1) {
    return totalCents;
  }

  return Math.round(totalCents * (1 + (APPMAX_INSTALLMENT_FEE_RATE * installments)));
}

function buildInstallmentLabel(installments: number, installmentCents: number, totalCents: number) {
  if (installments === 1) {
    return `1x de ${formatPrice(totalCents)} à vista`;
  }

  return `${installments}x de ${formatPrice(installmentCents)} | Total ${formatPrice(totalCents)}`;
}

function buildCardInstallmentOptions(totalCents: number) {
  return Array.from({ length: APPMAX_MAX_INSTALLMENTS }, (_, index) => {
    const installments = index + 1;
    const chargedTotalCents = calculateCardChargeTotalCents(totalCents, installments);
    const installmentCents = Math.round(chargedTotalCents / installments);

    return {
      installments,
      totalCents: chargedTotalCents,
      installmentCents,
      label: buildInstallmentLabel(installments, installmentCents, chargedTotalCents),
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

function extractPixSelectionStatus(existing: unknown) {
  const current = isRecord(existing) && isRecord(existing.pix_selection)
    ? existing.pix_selection
    : {};

  return {
    selectedAt: firstString([current.selected_at, current.selectedAt]),
    webhookSentAt: firstString([current.webhook_sent_at, current.webhookSentAt]),
    webhookLastError: firstString([current.webhook_last_error, current.webhookLastError]),
  };
}

function mergePixSelectionStatus(existing: unknown, next: {
  selectedAt?: string | null;
  webhookSentAt?: string | null;
  webhookLastError?: string | null;
}) {
  const current = extractPixSelectionStatus(existing);

  return mergeProviderResponse(existing, {
    pix_selection: {
      selected_at: next.selectedAt ?? current.selectedAt ?? null,
      webhook_sent_at: next.webhookSentAt ?? current.webhookSentAt ?? null,
      webhook_last_error: next.webhookLastError ?? current.webhookLastError ?? null,
    },
  });
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
    const fallbackTotalCents = calculateCardChargeTotalCents(originalTotalCents, installments);
    const fallbackInstallmentCents = Math.round(fallbackTotalCents / installments);
    return {
      installments,
      totalCents: fallbackTotalCents,
      installmentCents: fallbackInstallmentCents,
      label: buildInstallmentLabel(installments, fallbackInstallmentCents, fallbackTotalCents),
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
  app_id: string;
  external_key: string;
  merchant_client_id_encrypted: string;
  merchant_client_secret_encrypted: string;
}

interface AppmaxMerchantCredentials {
  installationExternalId: string;
  installationAppId: string;
  externalKey: string;
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
  const preferV1Key = useV1Key || path.startsWith('/v1/');
  const apiKey = preferV1Key
    ? Deno.env.get('ABACATEPAY_API_KEY_V1') || getEnv('ABACATEPAY_API_KEY')
    : getEnv('ABACATEPAY_API_KEY');
  const response = await fetch(`${ABACATEPAY_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  const logMessage = `[AbacatePay] ${path} -> status=${response.status} response=${JSON.stringify(payload)}`;
  if (response.ok) {
    console.log(logMessage);
  } else {
    console.error(logMessage);
  }

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
  const loggedPayload = isRecord(payload)
    ? {
      ...payload,
      access_token: payload.access_token ? '<present>' : payload.access_token,
      refresh_token: payload.refresh_token ? '<present>' : payload.refresh_token,
    }
    : payload;

  console.error(`[Appmax] auth -> status=${response.status} response=${JSON.stringify(loggedPayload)}`);

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

  console.error(`[Appmax] ${path} -> status=${response.status} summary=${JSON.stringify(summarizeAppmaxLogPayload(payload))}`);

  if (!response.ok) {
    console.error(`[Appmax] ${path} FULL error body: ${JSON.stringify(payload)}`);
    const errorsField = (payload as any)?.errors;
    const msg = firstString([
      (payload as any)?.error,
      (payload as any)?.message,
      Array.isArray(errorsField) ? errorsField[0] : null,
      errorsField && typeof errorsField === 'object'
        ? (Array.isArray(Object.values(errorsField)[0])
          ? (Object.values(errorsField)[0] as unknown[])[0] as string
          : String(Object.values(errorsField)[0] ?? ''))
        : null,
    ]) ?? 'Falha ao comunicar com a Appmax.';
    throw new Error(msg);
  }

  return payload;
}

async function getLatestAppmaxInstallation(admin: ReturnType<typeof createAdminClient>) {
  let query = admin
    .schema('appmax')
    .from('installations')
    .select('external_id, app_id, external_key, merchant_client_id_encrypted, merchant_client_secret_encrypted')
    .eq('external_key', APPMAX_EXTERNAL_KEY)
    .order('created_at', { ascending: false })
    .limit(1);

  if (APPMAX_APP_ID) {
    query = query.eq('app_id', APPMAX_APP_ID);
  }

  const { data, error } = await query.maybeSingle<AppmaxInstallationRow>();

  if (error) {
    throw new Error(`Não foi possível consultar a instalação Appmax: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return {
    installationExternalId: data.external_id,
    installationAppId: data.app_id,
    externalKey: data.external_key,
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
  return buildCardInstallmentOptions(totalCents);
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
      externalId: installation.installationExternalId,
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
  tracking?: MetaTrackingRecord;
}

interface CardPaymentInput {
  orderCode: string;
  cardNumber: string;
  cardHolderName: string;
  cardExpirationMonth: string;
  cardExpirationYear: string;
  cardCvv: string;
  holderName: string;
  holderDocumentNumber: string;
  installments: number;
  customerIp?: string;
}

interface RequestContext {
  clientIp?: string;
  userAgent?: string;
}

interface PaidOrderSnapshot {
  id: number;
  order_code: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_cpf?: string | null;
  total_cents?: number | null;
  shipping_cep?: string | null;
  shipping_city?: string | null;
  shipping_state?: string | null;
  provider_response?: unknown;
}

function extractClientIp(req: Request) {
  const forwardedFor = req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-real-ip')
    ?? req.headers.get('x-forwarded-for')
    ?? '';

  return firstString([forwardedFor.split(',')[0]]) ?? undefined;
}

function extractRequestContext(req: Request): RequestContext {
  return {
    clientIp: extractClientIp(req),
    userAgent: firstString([req.headers.get('user-agent')]) ?? undefined,
  };
}

async function syncMetaPurchaseForOrder(
  admin: ReturnType<typeof createAdminClient>,
  order: PaidOrderSnapshot,
  eventTime?: string | null,
) {
  const existingMeta = extractStoredMetaPurchaseStatus(order.provider_response);
  if (existingMeta.purchaseSentAt) {
    return;
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

    await admin
      .from('quiz_orders')
      .update({
        provider_response: mergeStoredMetaPurchaseStatus(order.provider_response, {
          purchaseEventId: result.eventId,
          purchaseSentAt: result.sent ? new Date().toISOString() : null,
          purchaseLastError: null,
          purchaseLastResponse: result.response ?? null,
          purchaseSkippedReason: result.skippedReason ?? null,
        }),
      })
      .eq('id', order.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meta conversion failed.';
    console.error('[quiz-pix] Meta purchase sync failed:', message);

    await admin
      .from('quiz_orders')
      .update({
        provider_response: mergeStoredMetaPurchaseStatus(order.provider_response, {
          purchaseEventId: eventId,
          purchaseSentAt: null,
          purchaseLastError: message,
        }),
      })
      .eq('id', order.id);
  }
}

async function notifyPixSelection(orderCode: string) {
  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from('quiz_orders')
    .select('id, order_code, transparent_id, customer_name, customer_phone, total_cents, pix_br_code, pix_qr_base64, expires_at, items, provider_response')
    .eq('order_code', orderCode)
    .maybeSingle();

  if (error || !order) {
    throw new Error('Pedido não encontrado.');
  }

  const pixSelection = extractPixSelectionStatus(order.provider_response);
  if (pixSelection.webhookSentAt) {
    return {
      notified: false,
      alreadyNotified: true,
      orderCode: order.order_code,
    };
  }

  const selectedAt = new Date().toISOString();
  let mergedProviderResponse = mergePixSelectionStatus(order.provider_response, {
    selectedAt,
    webhookSentAt: pixSelection.webhookSentAt ?? null,
    webhookLastError: null,
  });

  const n8nWebhookUrl = Deno.env.get('N8N_PIX_WEBHOOK_URL');
  if (!n8nWebhookUrl) {
    await admin
      .from('quiz_orders')
      .update({
        payment_method: 'pix',
        provider_response: mergedProviderResponse,
      })
      .eq('id', order.id);

    return {
      notified: false,
      alreadyNotified: false,
      orderCode: order.order_code,
    };
  }

  try {
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'pix_created',
        orderCode: order.order_code,
        orderId: order.id,
        pixId: order.transparent_id,
        customerName: order.customer_name ?? '',
        customerPhone: order.customer_phone ?? '',
        totalCents: Number(order.total_cents ?? 0),
        brCode: order.pix_br_code ?? '',
        brCodeBase64: order.pix_qr_base64 ?? null,
        expiresAt: order.expires_at ?? null,
        items: order.items,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    mergedProviderResponse = mergePixSelectionStatus(mergedProviderResponse, {
      selectedAt,
      webhookSentAt: new Date().toISOString(),
      webhookLastError: null,
    });

    await admin
      .from('quiz_orders')
      .update({
        payment_method: 'pix',
        provider_response: mergedProviderResponse,
      })
      .eq('id', order.id);

    return {
      notified: true,
      alreadyNotified: false,
      orderCode: order.order_code,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro ao notificar PIX.';
    mergedProviderResponse = mergePixSelectionStatus(mergedProviderResponse, {
      selectedAt,
      webhookSentAt: null,
      webhookLastError: message,
    });

    await admin
      .from('quiz_orders')
      .update({
        payment_method: 'pix',
        provider_response: mergedProviderResponse,
      })
      .eq('id', order.id);

    throw new Error('Não foi possível notificar o fluxo de PIX.');
  }
}

async function createPixCharge(input: CreateInput, requestContext: RequestContext) {
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
      provider_response: mergeStoredMetaTracking(null, {
        ...(input.tracking ?? {}),
        customerEmail: input.customerEmail ?? null,
        userAgent: requestContext.userAgent ?? input.tracking?.userAgent ?? null,
        clientIp: requestContext.clientIp ?? input.tracking?.clientIp ?? null,
      }),
    })
    .select('id, order_code, provider_response')
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
        provider_response: mergeProviderResponse(order.provider_response, {
          abacatepay: chargeData,
        }),
        expires_at: chargeData.expiresAt ?? null,
      })
      .eq('order_code', orderCode);

    // Fire-and-forget: notify n8n for WhatsApp follow-up
    notifyPixSelection(orderCode).catch((err) => {
      console.error('[quiz-pix] Background PIX notification failed:', err);
    });

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
  let statusPayload: Record<string, unknown>;

  try {
    statusPayload = await abacatePayRequest(`/v2/transparents/get?${query.toString()}`, {
      method: 'GET',
    });
  } catch (error) {
    console.warn(`[quiz-pix] Falling back to legacy PIX status endpoint for ${pixId}:`, error);
    statusPayload = await abacatePayRequest(`/v1/pixQrCode/check?${query.toString()}`, {
      method: 'GET',
    });
  }

  const chargeData = (statusPayload as any)?.data;
  if (!chargeData) {
    throw new Error('Resposta inválida ao consultar o pagamento.');
  }

  const { data: currentOrder } = await admin
    .from('quiz_orders')
    .select('id, payment_method, payment_status, order_code, customer_name, customer_phone, customer_cpf, selected_color, items, total_cents, freight_cents, free_shipping, has_gift, shipping_cep, shipping_street, shipping_number, shipping_complement, shipping_neighborhood, shipping_city, shipping_state, provider_response, logistics_webhook_sent_at')
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
  const mergedProviderResponse = mergeProviderResponse(currentOrder?.provider_response, {
    abacatepay: chargeData,
  });

  // Never regress a terminal payment status (paid, refunded, etc.) back to pending
  const terminalStatuses = ['paid', 'refunded', 'disputed'];
  const alreadyTerminal = currentOrder && terminalStatuses.includes(currentOrder.payment_status);

  const updatePayload: Record<string, unknown> = {
    payment_status: alreadyTerminal ? currentOrder.payment_status : mapped.paymentStatus,
    order_status: alreadyTerminal ? currentOrder.payment_status : mapped.orderStatus,
    dev_mode: Boolean(chargeData.devMode),
    provider_response: mergedProviderResponse,
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

  if (mapped.paymentStatus === 'paid' && currentOrder) {
    if (currentOrder.payment_status !== 'paid') {
      await syncMetaPurchaseForOrder(admin, {
        id: currentOrder.id,
        order_code: currentOrder.order_code,
        customer_name: currentOrder.customer_name,
        customer_phone: currentOrder.customer_phone,
        customer_cpf: currentOrder.customer_cpf,
        total_cents: currentOrder.total_cents,
        shipping_cep: currentOrder.shipping_cep,
        shipping_city: currentOrder.shipping_city,
        shipping_state: currentOrder.shipping_state,
        provider_response: mergedProviderResponse,
      }, chargeData.updatedAt ?? chargeData.createdAt ?? new Date().toISOString());

      const n8nPaidUrl = Deno.env.get('N8N_PIX_PAID_WEBHOOK_URL');
      if (n8nPaidUrl) {
        fetch(n8nPaidUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'pix_paid',
            orderCode: currentOrder.order_code,
            customerName: currentOrder.customer_name ?? '',
            customerPhone: currentOrder.customer_phone ?? '',
            totalCents: currentOrder.total_cents ?? chargeData.amount ?? 0,
            paidAt: chargeData.updatedAt ?? chargeData.createdAt ?? new Date().toISOString(),
          }),
        }).catch((err) => console.error('[quiz-pix] N8N paid webhook error:', err));
      }
    }

    await syncQuizLogisticsForOrder(admin, {
      id: currentOrder.id,
      order_code: currentOrder.order_code,
      customer_name: currentOrder.customer_name,
      customer_phone: currentOrder.customer_phone,
      customer_cpf: currentOrder.customer_cpf,
      selected_color: currentOrder.selected_color,
      items: currentOrder.items,
      total_cents: currentOrder.total_cents,
      freight_cents: currentOrder.freight_cents,
      free_shipping: currentOrder.free_shipping,
      has_gift: currentOrder.has_gift,
      shipping_cep: currentOrder.shipping_cep,
      shipping_street: currentOrder.shipping_street,
      shipping_number: currentOrder.shipping_number,
      shipping_complement: currentOrder.shipping_complement,
      shipping_neighborhood: currentOrder.shipping_neighborhood,
      shipping_city: currentOrder.shipping_city,
      shipping_state: currentOrder.shipping_state,
      provider_response: mergedProviderResponse,
      logistics_webhook_sent_at: currentOrder.logistics_webhook_sent_at,
    }, {
      source: 'quiz-pix:status',
    });
  }

  return {
    pixId: chargeData.id ?? pixId,
    status: (chargeData.status ?? 'PENDING').toUpperCase(),
    amountCents: chargeData.amount ?? 0,
    paidAmount: chargeData.paidAmount ?? null,
  };
}

async function getOrderStatus(orderCode: string) {
  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from('quiz_orders')
    .select('order_code, transparent_id, payment_method, payment_status, order_status, total_cents, paid_amount_cents, receipt_url, last_error, expires_at')
    .eq('order_code', orderCode)
    .maybeSingle();

  if (error || !order) {
    throw new Error('Pedido não encontrado.');
  }

  return {
    orderCode: order.order_code,
    pixId: order.transparent_id ?? null,
    paymentMethod: order.payment_method ?? null,
    paymentStatus: order.payment_status ?? 'pending',
    orderStatus: order.order_status ?? 'pending',
    amountCents: Number(order.total_cents ?? 0),
    paidAmountCents: order.paid_amount_cents ?? null,
    receiptUrl: order.receipt_url ?? null,
    lastError: order.last_error ?? null,
    expiresAt: order.expires_at ?? null,
    isPaid: order.payment_status === 'paid',
  };
}

async function processCardPayment(input: CardPaymentInput) {
  const admin = createAdminClient();

  if (!input.orderCode.trim()) {
    throw new Error('Pedido inválido.');
  }

  const cardNumberDigits = digitsOnly(input.cardNumber);
  if (cardNumberDigits.length < 13 || cardNumberDigits.length > 19) {
    throw new Error('Número do cartão inválido.');
  }

  const cardExpirationMonth = digitsOnly(input.cardExpirationMonth).padStart(2, '0');
  if (!/^(0[1-9]|1[0-2])$/.test(cardExpirationMonth)) {
    throw new Error('Mês de validade inválido.');
  }

  const cardExpirationYearDigits = digitsOnly(input.cardExpirationYear);
  if (cardExpirationYearDigits.length !== 2 && cardExpirationYearDigits.length !== 4) {
    throw new Error('Ano de validade inválido.');
  }
  const cardExpirationYear = cardExpirationYearDigits.length === 4
    ? cardExpirationYearDigits.slice(-2)
    : cardExpirationYearDigits;

  const cardCvv = digitsOnly(input.cardCvv);
  if (cardCvv.length < 3 || cardCvv.length > 4) {
    throw new Error('CVV inválido.');
  }

  const cardHolderNameForToken = (input.cardHolderName || input.holderName).trim();
  if (cardHolderNameForToken.length < 3) {
    throw new Error('Nome impresso no cartão é obrigatório.');
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
      selected_color,
      total_cents,
      freight_cents,
      free_shipping,
      has_gift,
      shipping_cep,
      shipping_street,
      shipping_number,
      shipping_complement,
      shipping_neighborhood,
      shipping_city,
      shipping_state,
      items,
      payment_status,
      provider_response,
      logistics_webhook_sent_at
    `)
    .eq('order_code', input.orderCode.trim())
    .single();

  if (orderError || !order) {
    throw new Error('Pedido não encontrado.');
  }

  if (order.payment_status === 'paid') {
    await syncQuizLogisticsForOrder(admin, {
      id: order.id,
      order_code: order.order_code,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_cpf: order.customer_cpf,
      selected_color: order.selected_color,
      items: order.items,
      total_cents: Number(order.total_cents),
      freight_cents: Number(order.freight_cents ?? 0),
      free_shipping: order.free_shipping,
      has_gift: order.has_gift,
      shipping_cep: order.shipping_cep,
      shipping_street: order.shipping_street,
      shipping_number: order.shipping_number,
      shipping_complement: order.shipping_complement,
      shipping_neighborhood: order.shipping_neighborhood,
      shipping_city: order.shipping_city,
      shipping_state: order.shipping_state,
      provider_response: order.provider_response,
      logistics_webhook_sent_at: order.logistics_webhook_sent_at,
    }, {
      source: 'quiz-pix:card-existing',
    });

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
  const baseTotalCents = Number(order.total_cents);
  const freightCents = Number(order.freight_cents ?? 0);
  const chargedTotalCents = calculateCardChargeTotalCents(baseTotalCents, input.installments);
  const installmentFeeCents = chargedTotalCents - baseTotalCents;
  const chargedProductsValueCents = Math.max(0, baseTotalCents - freightCents + installmentFeeCents);

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
        products_value: chargedProductsValueCents,
        discount_value: 0,
        shipping_value: freightCents,
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

  const tokenizePayload = await appmaxApiRequest(
    '/v1/payments/tokenize',
    {
      method: 'POST',
      body: JSON.stringify({
        payment_data: {
          credit_card: {
            number: cardNumberDigits,
            cvv: cardCvv,
            expiration_month: cardExpirationMonth,
            expiration_year: cardExpirationYear,
            holder_name: cardHolderNameForToken,
          },
        },
      }),
    },
    accessToken,
  );

  const cardToken = firstString([
    findValueByKeys(tokenizePayload, ['token']),
    findValueByKeys(tokenizePayload, ['card_token']),
    findValueByKeys(tokenizePayload, ['credit_card_token']),
    findValueByKeys(tokenizePayload, ['id']),
  ]);

  if (!cardToken) {
    throw new Error('A Appmax não retornou o token do cartão.');
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
            token: cardToken,
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
      installation_external_id: installation.installationExternalId,
      installation_app_id: installation.installationAppId,
      installation_external_key: installation.externalKey,
      charged_total_cents: chargedTotalCents,
      installment_fee_cents: installmentFeeCents,
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
      paid_amount_cents: isPaid ? chargedTotalCents : null,
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

  // Notify N8N when card payment is confirmed (fire-and-forget)
  if (isPaid) {
    await syncMetaPurchaseForOrder(admin, {
      id: order.id,
      order_code: order.order_code,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_cpf: order.customer_cpf,
      total_cents: chargedTotalCents,
      shipping_cep: order.shipping_cep,
      shipping_city: order.shipping_city,
      shipping_state: order.shipping_state,
      provider_response: providerResponse,
    }, new Date().toISOString());

    const n8nPaidUrl = Deno.env.get('N8N_PIX_PAID_WEBHOOK_URL');
    if (n8nPaidUrl) {
      fetch(n8nPaidUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment_paid',
          orderCode: order.order_code,
          customerName: order.customer_name,
          customerPhone: order.customer_phone,
          totalCents: chargedTotalCents,
          baseTotalCents,
          installmentFeeCents,
          paidAt: new Date().toISOString(),
        }),
      }).catch((err) => console.error('[quiz-pix] N8N paid webhook error:', err));
    }

    await syncQuizLogisticsForOrder(admin, {
      id: order.id,
      order_code: order.order_code,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_cpf: order.customer_cpf,
      selected_color: order.selected_color,
      items: order.items,
      total_cents: chargedTotalCents,
      freight_cents: freightCents,
      free_shipping: order.free_shipping,
      has_gift: order.has_gift,
      shipping_cep: order.shipping_cep,
      shipping_street: order.shipping_street,
      shipping_number: order.shipping_number,
      shipping_complement: order.shipping_complement,
      shipping_neighborhood: order.shipping_neighborhood,
      shipping_city: order.shipping_city,
      shipping_state: order.shipping_state,
      provider_response: providerResponse,
      logistics_webhook_sent_at: order.logistics_webhook_sent_at,
    }, {
      source: 'quiz-pix:card-paid',
    });
  }

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
  _currentCors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: _currentCors });
  }

  if (req.method !== 'POST') {
    return errorResponse('Método não suportado.', 405);
  }

  if (!isOriginAllowed(req)) {
    return errorResponse('Origem não autorizada.', 403);
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action;
    const requestContext = extractRequestContext(req);
    const clientIpKey = requestContext.clientIp ?? 'unknown';

    if (action === 'create') {
      // Rate limit by CPF to prevent abuse
      const cpfKey = digitsOnly(String(body.customerCpf ?? ''));
      if (cpfKey && isRateLimited(`create:${cpfKey}`)) {
        return errorResponse('Muitas tentativas. Aguarde um momento.', 429);
      }
      if (isRateLimited(`create-ip:${clientIpKey}`, 12)) {
        return errorResponse('Muitas tentativas. Aguarde um momento.', 429);
      }

      // Server-side CPF validation
      const cpfDigits = digitsOnly(String(body.customerCpf ?? ''));
      if (!isValidCpf(cpfDigits)) {
        return errorResponse('CPF inválido.', 400);
      }

      // Validate phone
      const phoneDigits = digitsOnly(String(body.customerPhone ?? ''));
      if (phoneDigits.length < 10 || phoneDigits.length > 11) {
        return errorResponse('Telefone inválido.', 400);
      }

      // Validate name
      const customerName = String(body.customerName ?? '').trim();
      if (customerName.length < 2 || customerName.length > 100) {
        return errorResponse('Nome inválido.', 400);
      }

      const shipping = (body.shipping ?? {}) as Record<string, unknown>;
      const tracking = isRecord(body.tracking) ? body.tracking : {};
      const data = await createPixCharge({
        customerName,
        customerPhone: phoneDigits,
        customerCpf: cpfDigits,
        customerEmail: body.customerEmail ? String(body.customerEmail).trim().slice(0, 200) : undefined,
        customerRegion: body.customerRegion ? String(body.customerRegion).trim().slice(0, 50) : undefined,
        selectedColor: body.selectedColor ? String(body.selectedColor).trim().slice(0, 50) : undefined,
        quizAnswers: typeof body.quizAnswers === 'object' ? (body.quizAnswers as Record<string, unknown>) : undefined,
        tracking: isRecord(body.tracking)
          ? {
            fbp: tracking.fbp ? String(tracking.fbp).trim().slice(0, 255) : undefined,
            fbc: tracking.fbc ? String(tracking.fbc).trim().slice(0, 255) : undefined,
            fbclid: tracking.fbclid ? String(tracking.fbclid).trim().slice(0, 255) : undefined,
            gclid: tracking.gclid ? String(tracking.gclid).trim().slice(0, 255) : undefined,
            ttclid: tracking.ttclid ? String(tracking.ttclid).trim().slice(0, 255) : undefined,
            pageUrl: tracking.pageUrl ? String(tracking.pageUrl).trim().slice(0, 2000) : undefined,
            landingPageUrl: tracking.landingPageUrl ? String(tracking.landingPageUrl).trim().slice(0, 2000) : undefined,
            referrer: tracking.referrer ? String(tracking.referrer).trim().slice(0, 2000) : undefined,
            utmSource: tracking.utmSource ? String(tracking.utmSource).trim().slice(0, 255) : undefined,
            utmMedium: tracking.utmMedium ? String(tracking.utmMedium).trim().slice(0, 255) : undefined,
            utmCampaign: tracking.utmCampaign ? String(tracking.utmCampaign).trim().slice(0, 500) : undefined,
            utmContent: tracking.utmContent ? String(tracking.utmContent).trim().slice(0, 500) : undefined,
            utmTerm: tracking.utmTerm ? String(tracking.utmTerm).trim().slice(0, 500) : undefined,
            utmId: tracking.utmId ? String(tracking.utmId).trim().slice(0, 255) : undefined,
            campaignId: tracking.campaignId ? String(tracking.campaignId).trim().slice(0, 255) : undefined,
            adsetId: tracking.adsetId ? String(tracking.adsetId).trim().slice(0, 255) : undefined,
            adId: tracking.adId ? String(tracking.adId).trim().slice(0, 255) : undefined,
          }
          : undefined,
        cart: (body.cart ?? {}) as CartInput,
        shipping: {
          cep: digitsOnly(String(shipping.cep ?? '')).slice(0, 8),
          street: String(shipping.street ?? '').trim().slice(0, 200),
          number: String(shipping.number ?? '').trim().slice(0, 20),
          complement: shipping.complement ? String(shipping.complement).trim().slice(0, 100) : undefined,
          neighborhood: String(shipping.neighborhood ?? '').trim().slice(0, 100),
          city: String(shipping.city ?? '').trim().slice(0, 100),
          state: String(shipping.state ?? '').trim().slice(0, 2),
        },
      }, requestContext);
      return jsonResponse({ success: true, data });
    }

    if (action === 'status') {
      if (typeof body.pixId !== 'string' || !body.pixId.trim()) {
        return errorResponse('ID do PIX inválido.', 400);
      }

      // Rate limit status polling
      const pixKey = body.pixId.trim().slice(0, 100);
      if (isRateLimited(`status:${pixKey}`)) {
        return errorResponse('Muitas consultas. Aguarde um momento.', 429);
      }
      if (isRateLimited(`status-ip:${clientIpKey}`, 60)) {
        return errorResponse('Muitas consultas. Aguarde um momento.', 429);
      }

      const data = await checkPixStatus(pixKey);
      return jsonResponse({ success: true, data });
    }

    if (action === 'pix_selected') {
      const orderCode = String(body.orderCode ?? '').trim();
      if (!orderCode) {
        return errorResponse('Pedido inválido.', 400);
      }
      if (isRateLimited(`pix-selected-ip:${clientIpKey}`, 30)) {
        return errorResponse('Muitas tentativas. Aguarde um momento.', 429);
      }

      const data = await notifyPixSelection(orderCode);
      return jsonResponse({ success: true, data });
    }

    if (action === 'order_status') {
      const orderCode = String(body.orderCode ?? '').trim();
      if (!orderCode) {
        return errorResponse('Pedido inválido.', 400);
      }
      if (isRateLimited(`order-status:${orderCode}`, 30)) {
        return errorResponse('Muitas consultas. Aguarde um momento.', 429);
      }
      if (isRateLimited(`order-status-ip:${clientIpKey}`, 120)) {
        return errorResponse('Muitas consultas. Aguarde um momento.', 429);
      }
      const data = await getOrderStatus(orderCode);
      return jsonResponse({ success: true, data });
    }

    if (action === 'card') {
      const orderCode = String(body.orderCode ?? '').trim();
      if (orderCode && isRateLimited(`card:${orderCode}`)) {
        return errorResponse('Muitas tentativas de pagamento. Aguarde um momento.', 429);
      }
      if (isRateLimited(`card-ip:${clientIpKey}`, 12)) {
        return errorResponse('Muitas tentativas de pagamento. Aguarde um momento.', 429);
      }

      const data = await processCardPayment({
        orderCode,
        cardNumber: String(body.cardNumber ?? ''),
        cardHolderName: String(body.cardHolderName ?? '').trim().slice(0, 100),
        cardExpirationMonth: String(body.cardExpirationMonth ?? ''),
        cardExpirationYear: String(body.cardExpirationYear ?? ''),
        cardCvv: String(body.cardCvv ?? ''),
        holderName: String(body.holderName ?? '').trim().slice(0, 100),
        holderDocumentNumber: String(body.holderDocumentNumber ?? ''),
        installments: Number(body.installments ?? 0),
        customerIp: (body.customerIp
          ? String(body.customerIp).trim().slice(0, 45)
          : requestContext.clientIp?.slice(0, 45)) || undefined,
      });
      return jsonResponse({ success: true, data });
    }

    return errorResponse('Ação inválida.', 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro inesperado.';
    // Don't expose internal infrastructure details to the client
    const safeMessages = [
      'Nenhum item selecionado.',
      'Endereço de envio incompleto.',
      'CPF inválido.',
      'Telefone inválido.',
      'Nome inválido.',
      'Pedido inválido.',
      'Token do cartão inválido.',
      'Nome do titular é obrigatório.',
      'CPF do titular inválido.',
      'Parcelamento inválido.',
      'Pedido não encontrado.',
      'Pedido inválido.',
      'ID do PIX inválido.',
      'Pedido sem itens.',
      'Pagamento já confirmado.',
      'Resposta inválida ao gerar o pagamento.',
      'Resposta inválida ao consultar o pagamento.',
      'O pagamento não foi aprovado.',
      'O cartão está temporariamente indisponível. Tente novamente em instantes.',
      'Não foi possível notificar o fluxo de PIX.',
      'Origem não autorizada.',
    ];
    const isSafe = safeMessages.some(m => message.includes(m));
    const clientMessage = isSafe ? message : 'Erro ao processar a solicitação. Tente novamente.';
    if (!isSafe) console.error('[quiz-pix] Unhandled error:', message);
    return errorResponse(clientMessage, isSafe ? 400 : 500);
  }
});
