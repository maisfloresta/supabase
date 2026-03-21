import {
  createSupabaseAdminClient,
  encryptSecret,
  getClientIp,
  redactMerchantCredentials,
  sha256Hex,
} from "../_shared/appmax.ts";
import { corsHeaders } from "../_shared/cors.ts";

const APPMAX_APP_ID = Deno.env.get("APPMAX_APP_ID") ??
  "b6c8b0b4-ee85-4639-a249-4b1415aa42e7";

interface ValidationPayload {
  app_id: string;
  client_id: string;
  client_secret: string;
  external_key: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

async function parseBody(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    if (!isRecord(body)) {
      throw new Error("Payload JSON inválido.");
    }
    return body;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await req.formData();
    const body: Record<string, unknown> = {};

    for (const [key, value] of form.entries()) {
      body[key] = typeof value === "string" ? value : value.name;
    }

    return body;
  }

  const rawText = await req.text();
  if (!rawText.trim()) {
    throw new Error("Payload ausente.");
  }

  try {
    const body = JSON.parse(rawText) as unknown;
    if (!isRecord(body)) {
      throw new Error();
    }
    return body;
  } catch {
    const params = new URLSearchParams(rawText);
    const body: Record<string, unknown> = {};

    for (const [key, value] of params.entries()) {
      body[key] = value;
    }

    if (Object.keys(body).length === 0) {
      throw new Error("Formato de payload não suportado.");
    }

    return body;
  }
}

function normalizePayload(body: Record<string, unknown>): ValidationPayload {
  const payload = {
    app_id: asTrimmedString(body.app_id),
    client_id: asTrimmedString(body.client_id),
    client_secret: asTrimmedString(body.client_secret),
    external_key: asTrimmedString(body.external_key),
  };

  if (!payload.app_id) {
    throw new Error("Campo app_id é obrigatório.");
  }

  if (!payload.client_id) {
    throw new Error("Campo client_id é obrigatório.");
  }

  if (!payload.client_secret) {
    throw new Error("Campo client_secret é obrigatório.");
  }

  if (!payload.external_key) {
    throw new Error("Campo external_key é obrigatório.");
  }

  if (payload.app_id !== APPMAX_APP_ID) {
    throw new Error("app_id inválido para este endpoint.");
  }

  return payload;
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

async function createInstallation(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  req: Request,
  payload: ValidationPayload,
) {
  const credentialFingerprint = await sha256Hex(
    `${payload.client_id}:${payload.client_secret}`,
  );
  const existingExternalId = await findExistingInstallation(adminClient, {
    appId: payload.app_id,
    externalKey: payload.external_key,
    credentialFingerprint,
  });

  if (existingExternalId) {
    return existingExternalId;
  }

  const externalId = crypto.randomUUID();
  const merchantClientIdEncrypted = await encryptSecret(payload.client_id);
  const merchantClientSecretEncrypted = await encryptSecret(
    payload.client_secret,
  );
  const sourceIp = getClientIp(req);
  const userAgent = req.headers.get("user-agent");
  const requestContentType = req.headers.get("content-type");

  const { error } = await adminClient
    .schema("appmax")
    .from("installations")
    .insert({
      external_id: externalId,
      app_id: payload.app_id,
      external_key: payload.external_key,
      credential_fingerprint: credentialFingerprint,
      merchant_client_id_encrypted: merchantClientIdEncrypted,
      merchant_client_secret_encrypted: merchantClientSecretEncrypted,
      source_ip: sourceIp,
      user_agent: userAgent,
      payload: redactMerchantCredentials({
        appId: payload.app_id,
        externalKey: payload.external_key,
        contentType: requestContentType,
        receivedKeys: Object.keys(payload).sort(),
      }),
    });

  if (error) {
    if (error.code === "23505") {
      const concurrentExternalId = await findExistingInstallation(adminClient, {
        appId: payload.app_id,
        externalKey: payload.external_key,
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
      service: "appmax-validation",
      method: "POST",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Método não suportado.", 405);
  }

  try {
    const rawBody = await parseBody(req);
    const payload = normalizePayload(rawBody);
    const adminClient = createSupabaseAdminClient();
    const externalId = await createInstallation(adminClient, req, payload);

    return jsonResponse({ external_id: externalId }, 200);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Erro inesperado na validação Appmax.";
    const isServerError = message.includes("Variável de ambiente ausente") ||
      message.includes("Não foi possível consultar") ||
      message.includes("Não foi possível registrar");

    return errorResponse(message, isServerError ? 500 : 400);
  }
});
