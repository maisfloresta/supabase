import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_APPMAX_APP_ID = "b6c8b0b4-ee85-4639-a249-4b1415aa42e7";
const DEFAULT_APPMAX_API_URL = "https://api.appmax.com.br";
const DEFAULT_APPMAX_AUTH_URL = "https://auth.appmax.com.br/oauth2/token";
const DEFAULT_APPMAX_AUTHORIZE_BASE_URL =
  "https://admin.appmax.com.br/appstore/integration";
const DEFAULT_APPMAX_SYSTEM_URL = "https://quiz.maisfloresta.cloud";
const DEFAULT_APPMAX_EXTERNAL_KEY = "quiz.maisfloresta.cloud";

export interface AppmaxInstallationPayload {
  appId: string;
  clientId: string;
  clientSecret: string;
  externalKey: string;
}

interface AppmaxInstallationMetadata {
  authorizeToken?: string | null;
  callbackUrl?: string | null;
  contentType?: string | null;
  redirectTo?: string | null;
  receivedKeys?: string[];
  source?: "validation" | "callback";
}

function toBase64(bytes: Uint8Array) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function getRequiredEnv(name: string) {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Variável de ambiente ausente: ${name}.`);
  }

  return value;
}

export function getSupabaseUrl() {
  return getRequiredEnv("SUPABASE_URL");
}

export function createSupabaseAdminClient() {
  return createClient(
    getSupabaseUrl(),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

export function getAppmaxAppId() {
  return Deno.env.get("APPMAX_APP_ID") ?? DEFAULT_APPMAX_APP_ID;
}

export function getAppmaxApiUrl() {
  return (Deno.env.get("APPMAX_API_URL") ?? DEFAULT_APPMAX_API_URL).replace(
    /\/$/,
    "",
  );
}

export function getAppmaxAuthUrl() {
  return Deno.env.get("APPMAX_AUTH_URL") ?? DEFAULT_APPMAX_AUTH_URL;
}

export function getAppmaxAuthorizeBaseUrl() {
  return (Deno.env.get("APPMAX_AUTHORIZE_BASE_URL") ??
    DEFAULT_APPMAX_AUTHORIZE_BASE_URL).replace(/\/$/, "");
}

export function getAppmaxSystemUrl() {
  return Deno.env.get("APPMAX_SYSTEM_URL") ?? DEFAULT_APPMAX_SYSTEM_URL;
}

export function getDefaultAppmaxExternalKey() {
  return Deno.env.get("APPMAX_DEFAULT_EXTERNAL_KEY") ??
    DEFAULT_APPMAX_EXTERNAL_KEY;
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayOfRecords(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function firstNonEmptyString(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractAppmaxErrorMessage(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return null;
  }

  const directMessage = firstNonEmptyString([
    payload.message,
    payload.error_description,
    payload.error,
    payload.detail,
  ]);

  if (directMessage) {
    return directMessage;
  }

  if (Array.isArray(payload.errors)) {
    const joinedErrors = payload.errors
      .map((item) =>
        isRecord(item)
          ? firstNonEmptyString([
            item.message,
            item.error,
            item.detail,
          ])
          : typeof item === "string"
          ? item.trim()
          : ""
      )
      .filter(Boolean)
      .join("; ");

    if (joinedErrors) {
      return joinedErrors;
    }
  }

  if (isRecord(payload.data)) {
    return extractAppmaxErrorMessage(payload.data);
  }

  return null;
}

async function parseResponsePayload(response: Response) {
  const rawText = await response.text();

  if (!rawText.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

async function parseAppmaxResponse(
  response: Response,
  failurePrefix: string,
) {
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail = extractAppmaxErrorMessage(payload) ?? response.statusText;
    throw new Error(`${failurePrefix}: ${detail || `HTTP ${response.status}`}`);
  }

  if (!payload) {
    throw new Error(`${failurePrefix}: resposta vazia da Appmax.`);
  }

  return payload;
}

async function getEncryptionKey() {
  const secret = Deno.env.get("APPMAX_INSTALLATION_ENCRYPTION_KEY") ??
    Deno.env.get("WEBHOOK_SHARED_TOKEN");

  if (!secret) {
    throw new Error(
      "Variável de ambiente ausente: APPMAX_INSTALLATION_ENCRYPTION_KEY ou WEBHOOK_SHARED_TOKEN.",
    );
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(secret),
  );

  return crypto.subtle.importKey(
    "raw",
    digest,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEncryptionKey();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plaintext),
  );

  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(ciphertext: string) {
  const [version, ivBase64, payloadBase64] = ciphertext.split(":");

  if (version !== "v1" || !ivBase64 || !payloadBase64) {
    throw new Error("Formato de segredo Appmax inválido.");
  }

  const key = await getEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivBase64) },
    key,
    fromBase64(payloadBase64),
  );

  return textDecoder.decode(plaintext);
}

export async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getClientIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }

  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip");
}

export function redactMerchantCredentials(input: {
  appId: string;
  externalKey: string;
  contentType: string | null;
  receivedKeys: string[];
  authorizeToken?: string | null;
  callbackUrl?: string | null;
  redirectTo?: string | null;
  source?: "validation" | "callback";
}) {
  return {
    app_id: input.appId,
    external_key: input.externalKey,
    content_type: input.contentType,
    received_keys: input.receivedKeys,
    source: input.source ?? "validation",
    authorize_token_present: Boolean(input.authorizeToken),
    callback_url: input.callbackUrl ?? null,
    redirect_to: input.redirectTo ?? null,
    merchant_client_id: "<encrypted>",
    merchant_client_secret: "<encrypted>",
  };
}

async function findExistingInstallation(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    appId: string;
    externalKey: string;
    credentialFingerprint: string;
  },
) {
  const { data, error } = await adminClient
    .schema("appmax")
    .from("installations")
    .select("external_id")
    .eq("app_id", input.appId)
    .eq("external_key", input.externalKey)
    .eq("credential_fingerprint", input.credentialFingerprint)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Não foi possível consultar a instalação Appmax: ${error.message}`,
    );
  }

  return data ? String(data.external_id) : null;
}

export async function createOrGetAppmaxInstallation(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  req: Request,
  payload: AppmaxInstallationPayload,
  metadata: AppmaxInstallationMetadata = {},
) {
  const credentialFingerprint = await sha256Hex(
    `${payload.clientId}:${payload.clientSecret}`,
  );
  const existingExternalId = await findExistingInstallation(adminClient, {
    appId: payload.appId,
    externalKey: payload.externalKey,
    credentialFingerprint,
  });

  if (existingExternalId) {
    return existingExternalId;
  }

  const externalId = crypto.randomUUID();
  const merchantClientIdEncrypted = await encryptSecret(payload.clientId);
  const merchantClientSecretEncrypted = await encryptSecret(
    payload.clientSecret,
  );

  const { error } = await adminClient
    .schema("appmax")
    .from("installations")
    .insert({
      external_id: externalId,
      app_id: payload.appId,
      external_key: payload.externalKey,
      credential_fingerprint: credentialFingerprint,
      merchant_client_id_encrypted: merchantClientIdEncrypted,
      merchant_client_secret_encrypted: merchantClientSecretEncrypted,
      source_ip: getClientIp(req),
      user_agent: req.headers.get("user-agent"),
      payload: redactMerchantCredentials({
        appId: payload.appId,
        externalKey: payload.externalKey,
        contentType: metadata.contentType ?? req.headers.get("content-type"),
        receivedKeys: metadata.receivedKeys ?? [],
        authorizeToken: metadata.authorizeToken,
        callbackUrl: metadata.callbackUrl,
        redirectTo: metadata.redirectTo,
        source: metadata.source,
      }),
    });

  if (error) {
    if (error.code === "23505") {
      const concurrentExternalId = await findExistingInstallation(adminClient, {
        appId: payload.appId,
        externalKey: payload.externalKey,
        credentialFingerprint,
      });

      if (concurrentExternalId) {
        return concurrentExternalId;
      }
    }

    throw new Error(
      `Não foi possível registrar a instalação Appmax: ${error.message}`,
    );
  }

  return externalId;
}

export async function createAppmaxAppAccessToken() {
  const response = await fetch(getAppmaxAuthUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: getRequiredEnv("APPMAX_APP_CLIENT_ID"),
      client_secret: getRequiredEnv("APPMAX_APP_CLIENT_SECRET"),
    }),
  });
  const payload = await parseAppmaxResponse(
    response,
    "Não foi possível obter o token do aplicativo Appmax",
  );

  if (!isRecord(payload)) {
    throw new Error("Não foi possível obter o token do aplicativo Appmax: resposta inválida.");
  }

  const accessToken = asTrimmedString(payload.access_token);

  if (!accessToken) {
    throw new Error("Não foi possível obter o token do aplicativo Appmax: access_token ausente.");
  }

  return accessToken;
}

export async function createAppmaxAuthorizeToken(
  accessToken: string,
  input: {
    appId: string;
    externalKey: string;
    callbackUrl: string;
  },
) {
  const response = await fetch(`${getAppmaxApiUrl()}/app/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      app_id: input.appId,
      external_key: input.externalKey,
      url_callback: input.callbackUrl,
    }),
  });
  const payload = await parseAppmaxResponse(
    response,
    "Não foi possível autorizar a instalação do aplicativo Appmax",
  );

  if (!isRecord(payload)) {
    throw new Error("Não foi possível autorizar a instalação do aplicativo Appmax: resposta inválida.");
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const token = firstNonEmptyString([
    data?.token,
    payload.token,
  ]);

  if (!token) {
    throw new Error("Não foi possível autorizar a instalação do aplicativo Appmax: token ausente.");
  }

  return token;
}

export function buildAppmaxAuthorizeUrl(token: string) {
  return `${getAppmaxAuthorizeBaseUrl()}/${encodeURIComponent(token)}`;
}

export async function generateAppmaxMerchantCredentials(
  accessToken: string,
  token: string,
) {
  const response = await fetch(`${getAppmaxApiUrl()}/app/client/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ token }),
  });
  const payload = await parseAppmaxResponse(
    response,
    "Não foi possível gerar as credenciais do merchant Appmax",
  );

  if (!isRecord(payload)) {
    throw new Error("Não foi possível gerar as credenciais do merchant Appmax: resposta inválida.");
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const client = data && isRecord(data.client) ? data.client : null;
  const clientId = firstNonEmptyString([
    client?.client_id,
    data?.client_id,
    payload.client_id,
  ]);
  const clientSecret = firstNonEmptyString([
    client?.client_secret,
    data?.client_secret,
    payload.client_secret,
  ]);

  if (!clientId || !clientSecret) {
    throw new Error("Não foi possível gerar as credenciais do merchant Appmax: client_id ou client_secret ausentes.");
  }

  return { clientId, clientSecret };
}
