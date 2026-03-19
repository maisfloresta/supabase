import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const ABACATEPAY_API_URL = 'https://api.abacatepay.com';
export const ABACATEPAY_WEBHOOK_PUBLIC_KEY =
  't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

export interface MarketplacePixCharge {
  id: string;
  amountCents: number;
  status: string;
  brCode: string;
  brCodeBase64: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  devMode: boolean;
  metadata: Record<string, unknown> | null;
}

export interface AbacatePayTransparentData {
  id?: string;
  externalId?: string | null;
  amount?: number;
  paidAmount?: number | null;
  platformFee?: number | null;
  status?: string | null;
  devMode?: boolean;
  receiptUrl?: string | null;
  customerId?: string | null;
  methods?: string[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AbacatePayCustomerData {
  id?: string;
  name?: string | null;
  email?: string | null;
  taxId?: string | null;
  cellphone?: string | null;
}

export interface AbacatePayWebhookPayload {
  event?: string;
  apiVersion?: number;
  devMode?: boolean;
  data?: {
    transparent?: AbacatePayTransparentData;
    customer?: AbacatePayCustomerData | null;
    reason?: string | null;
    [key: string]: unknown;
  };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function getFirstAvailableEnv(names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) {
      return value;
    }
  }

  throw new Error(`Variável de ambiente ausente: ${names.join(' ou ')}.`);
}

export function getRequiredEnv(name: string) {
  return getFirstAvailableEnv([name]);
}

export function getSupabaseUrl() {
  return getRequiredEnv('SUPABASE_URL');
}

export function getSupabaseAnonKey() {
  return getFirstAvailableEnv(['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_OR_ANON_KEY']);
}

export function createSupabaseAdminClient() {
  return createClient(getSupabaseUrl(), getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

export function createSupabaseUserClient(authHeader: string) {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
}

export async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');

  if (!authHeader) {
    throw new Error('Usuário não autenticado.');
  }

  const supabase = createSupabaseUserClient(authHeader);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error('Sessão inválida para criar cobrança PIX.');
  }

  return user;
}

export function asJsonRecord(value: unknown): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

export function normalizeChargePayload(
  payload: Record<string, unknown>,
  fallbackAmountCents?: number,
): MarketplacePixCharge {
  const metadata = asJsonRecord(payload.metadata);
  const metadataAmount = typeof metadata?.marketplaceTotalCents === 'number'
    ? metadata.marketplaceTotalCents
    : null;

  return {
    id: String(payload.id ?? ''),
    amountCents:
      metadataAmount ??
      (typeof fallbackAmountCents === 'number'
        ? fallbackAmountCents
        : typeof payload.amount === 'number'
          ? payload.amount
          : 0),
    status: typeof payload.status === 'string' ? payload.status.toUpperCase() : 'UNKNOWN',
    brCode: typeof payload.brCode === 'string' ? payload.brCode : '',
    brCodeBase64: typeof payload.brCodeBase64 === 'string' ? payload.brCodeBase64 : null,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    devMode: Boolean(payload.devMode),
    metadata,
  };
}

export function extractAbacatePayError(payload: Record<string, unknown> | null, fallback: string) {
  if (!payload) {
    return fallback;
  }

  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    if (typeof firstError === 'string') {
      return firstError;
    }
    if (typeof firstError === 'object' && firstError !== null && 'message' in firstError) {
      const message = (firstError as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }
  }

  return fallback;
}

export async function abacatePayRequest(path: string, init: RequestInit) {
  const apiKey = getRequiredEnv('ABACATEPAY_API_KEY');

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
    throw new Error(extractAbacatePayError(payload, 'Falha ao comunicar com a AbacatePay.'));
  }

  return payload;
}

export function buildMarketplaceOrderCode() {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `MF-ABA-${stamp}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export function mapAbacatePayStatus(status: string | null | undefined) {
  const normalized = status?.toUpperCase() ?? 'PENDING';

  switch (normalized) {
    case 'PAID':
      return { paymentStatus: 'paid', orderStatus: 'paid' };
    case 'REFUNDED':
      return { paymentStatus: 'refunded', orderStatus: 'refunded' };
    case 'DISPUTED':
      return { paymentStatus: 'disputed', orderStatus: 'disputed' };
    case 'CANCELLED':
      return { paymentStatus: 'cancelled', orderStatus: 'cancelled' };
    case 'EXPIRED':
      return { paymentStatus: 'expired', orderStatus: 'expired' };
    default:
      return { paymentStatus: 'pending', orderStatus: 'pending' };
  }
}

export function buildWebhookEventKey(payload: AbacatePayWebhookPayload) {
  const event = payload.event ?? 'unknown';
  const transparent = payload.data?.transparent;
  const transparentId = transparent?.id ?? 'unknown';
  const updatedAt = transparent?.updatedAt ?? 'unknown';
  return `${event}:${transparentId}:${updatedAt}`;
}

async function computeHmacBase64(rawBody: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(ABACATEPAY_WEBHOOK_PUBLIC_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const bytes = new Uint8Array(signature);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

export async function verifyAbacatePayWebhookSignature(rawBody: string, signatureFromHeader: string | null) {
  if (!signatureFromHeader) {
    return false;
  }

  const expectedSignature = await computeHmacBase64(rawBody);
  return timingSafeEqual(expectedSignature, signatureFromHeader);
}
