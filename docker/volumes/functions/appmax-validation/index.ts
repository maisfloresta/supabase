import {
  createOrGetAppmaxInstallation,
  createSupabaseAdminClient,
  getAppmaxAppId,
} from "../_shared/appmax.ts";
import { corsHeaders } from "../_shared/cors.ts";

const APPMAX_APP_ID = getAppmaxAppId();

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

async function createInstallation(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  req: Request,
  payload: ValidationPayload,
) {
  return createOrGetAppmaxInstallation(
    adminClient,
    req,
    {
      appId: payload.app_id,
      clientId: payload.client_id,
      clientSecret: payload.client_secret,
      externalKey: payload.external_key,
    },
    {
      contentType: req.headers.get("content-type"),
      receivedKeys: Object.keys(payload).sort(),
      source: "validation",
    },
  );
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
