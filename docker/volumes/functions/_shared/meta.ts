const META_GRAPH_API_BASE = 'https://graph.facebook.com';
const DEFAULT_META_GRAPH_API_VERSION = 'v21.0';
const textEncoder = new TextEncoder();

export interface MetaTrackingRecord {
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  ttclid?: string | null;
  pageUrl?: string | null;
  landingPageUrl?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  utmId?: string | null;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  userAgent?: string | null;
  clientIp?: string | null;
  customerEmail?: string | null;
}

export interface MetaPurchaseEventInput {
  orderCode: string;
  eventId?: string | null;
  totalCents: number;
  eventTime?: string | number | Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerCpf?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingZip?: string | null;
  eventSourceUrl?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

export interface MetaPurchaseSendResult {
  sent: boolean;
  eventId: string;
  skippedReason?: string;
  response?: unknown;
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

function digitsOnly(value: string | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeName(value: string | null | undefined) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

function normalizeEmail(value: string | null | undefined) {
  return normalizeText(value);
}

function normalizePhone(value: string | null | undefined) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function normalizeZip(value: string | null | undefined) {
  return digitsOnly(value);
}

function splitCustomerName(fullName: string | null | undefined) {
  const normalized = String(fullName ?? '').trim().replace(/\s+/g, ' ');
  const [firstName, ...rest] = normalized.split(' ').filter(Boolean);

  return {
    firstName: firstName || '',
    lastName: rest.join(' '),
  };
}

function toUnixTimestamp(value: string | number | Date | null | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return Math.floor(Date.now() / 1000);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function maybeHashValue(
  userData: Record<string, unknown>,
  key: string,
  value: string | null | undefined,
  normalizer: (value: string | null | undefined) => string,
) {
  const normalized = normalizer(value);
  if (!normalized) return;
  userData[key] = [await sha256Hex(normalized)];
}

function getMetaConfig() {
  const pixelId = Deno.env.get('FB_PIXEL_ID')?.trim();
  const accessToken = Deno.env.get('FB_ACCESS_TOKEN')?.trim();

  if (!pixelId || !accessToken) {
    return null;
  }

  return {
    pixelId,
    accessToken,
    apiVersion: Deno.env.get('FB_GRAPH_API_VERSION')?.trim() || DEFAULT_META_GRAPH_API_VERSION,
    testEventCode: Deno.env.get('FB_TEST_EVENT_CODE')?.trim() || undefined,
  };
}

export function extractStoredMetaTracking(providerResponse: unknown): MetaTrackingRecord {
  const provider = isRecord(providerResponse) ? providerResponse : {};
  const tracking = isRecord(provider.tracking) ? provider.tracking : {};

  return {
    fbp: firstString([tracking.fbp]),
    fbc: firstString([tracking.fbc]),
    fbclid: firstString([tracking.fbclid]),
    gclid: firstString([tracking.gclid]),
    ttclid: firstString([tracking.ttclid]),
    pageUrl: firstString([tracking.pageUrl]),
    landingPageUrl: firstString([tracking.landingPageUrl]),
    referrer: firstString([tracking.referrer]),
    utmSource: firstString([tracking.utmSource]),
    utmMedium: firstString([tracking.utmMedium]),
    utmCampaign: firstString([tracking.utmCampaign]),
    utmContent: firstString([tracking.utmContent]),
    utmTerm: firstString([tracking.utmTerm]),
    utmId: firstString([tracking.utmId]),
    campaignId: firstString([tracking.campaignId]),
    adsetId: firstString([tracking.adsetId]),
    adId: firstString([tracking.adId]),
    userAgent: firstString([tracking.userAgent]),
    clientIp: firstString([tracking.clientIp]),
    customerEmail: firstString([tracking.customerEmail]),
  };
}

export function mergeStoredMetaTracking(providerResponse: unknown, nextTracking: MetaTrackingRecord) {
  const current = isRecord(providerResponse) ? providerResponse : {};
  const existingTracking = isRecord(current.tracking) ? current.tracking : {};

  return {
    ...current,
    tracking: {
      ...existingTracking,
      ...Object.fromEntries(
        Object.entries(nextTracking).filter(([, value]) => value !== null && value !== undefined && value !== ''),
      ),
    },
  };
}

export function extractStoredMetaPurchaseStatus(providerResponse: unknown) {
  const provider = isRecord(providerResponse) ? providerResponse : {};
  const meta = isRecord(provider.meta) ? provider.meta : {};

  return {
    purchaseEventId: firstString([meta.purchaseEventId]),
    purchaseSentAt: firstString([meta.purchaseSentAt]),
  };
}

export function mergeStoredMetaPurchaseStatus(providerResponse: unknown, nextMeta: Record<string, unknown>) {
  const current = isRecord(providerResponse) ? providerResponse : {};
  const existingMeta = isRecord(current.meta) ? current.meta : {};

  return {
    ...current,
    meta: {
      ...existingMeta,
      ...nextMeta,
    },
  };
}

export async function sendMetaPurchaseEvent(input: MetaPurchaseEventInput): Promise<MetaPurchaseSendResult> {
  const config = getMetaConfig();
  const eventId = String(input.eventId ?? input.orderCode).trim() || input.orderCode;

  if (!config) {
    return {
      sent: false,
      eventId,
      skippedReason: 'missing_config',
    };
  }

  const { firstName, lastName } = splitCustomerName(input.customerName);
  const userData: Record<string, unknown> = {};

  if (input.clientIpAddress) {
    userData.client_ip_address = input.clientIpAddress;
  }

  if (input.clientUserAgent) {
    userData.client_user_agent = input.clientUserAgent;
  }

  if (input.fbp) {
    userData.fbp = input.fbp;
  }

  if (input.fbc) {
    userData.fbc = input.fbc;
  }

  await Promise.all([
    maybeHashValue(userData, 'em', input.customerEmail, normalizeEmail),
    maybeHashValue(userData, 'ph', input.customerPhone, normalizePhone),
    maybeHashValue(userData, 'fn', firstName, normalizeName),
    maybeHashValue(userData, 'ln', lastName, normalizeName),
    maybeHashValue(userData, 'ct', input.shippingCity, normalizeName),
    maybeHashValue(userData, 'st', input.shippingState, normalizeName),
    maybeHashValue(userData, 'zp', input.shippingZip, normalizeZip),
    maybeHashValue(userData, 'external_id', input.customerCpf || input.orderCode, normalizeText),
    maybeHashValue(userData, 'country', 'br', normalizeText),
  ]);

  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: 'Purchase',
        event_time: toUnixTimestamp(input.eventTime),
        event_id: eventId,
        action_source: 'website',
        event_source_url: input.eventSourceUrl ?? undefined,
        user_data: userData,
        custom_data: {
          value: Number((input.totalCents / 100).toFixed(2)),
          currency: 'BRL',
          content_name: 'Kit de Sementes Ipê',
          content_type: 'product_group',
          order_id: input.orderCode,
        },
      },
    ],
  };

  if (config.testEventCode) {
    payload.test_event_code = config.testEventCode;
  }

  const response = await fetch(
    `${META_GRAPH_API_BASE}/${config.apiVersion}/${config.pixelId}/events?access_token=${encodeURIComponent(config.accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  const raw = await response.text();
  let parsed: unknown = raw;

  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!response.ok) {
    const parsedRecord = isRecord(parsed) ? parsed : {};
    const parsedError = isRecord(parsedRecord.error) ? parsedRecord.error : {};
    const message = firstString([
      parsedError.message,
      parsedRecord.message,
      response.statusText,
      raw,
    ]) ?? 'Meta Conversions API request failed.';
    throw new Error(message);
  }

  return {
    sent: true,
    eventId,
    response: parsed,
  };
}
