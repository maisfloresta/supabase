import {
  createAppmaxAppAccessToken,
  createOrGetAppmaxInstallation,
  createSupabaseAdminClient,
  generateAppmaxMerchantCredentials,
  getAppmaxAppId,
  getAppmaxSystemUrl,
  getDefaultAppmaxExternalKey,
} from "../_shared/appmax.ts";
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

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

  return {};
}

function wantsJson(req: Request, url: URL) {
  const format = url.searchParams.get("format") ?? url.searchParams.get("mode");
  if (format === "json") {
    return true;
  }

  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function normalizeRedirectTo(value: string) {
  const systemUrl = new URL(getAppmaxSystemUrl());
  const rawValue = value.trim();

  if (!rawValue) {
    return systemUrl.toString();
  }

  let candidate: URL;

  try {
    candidate = rawValue.startsWith("/")
      ? new URL(rawValue, systemUrl)
      : new URL(rawValue);
  } catch {
    throw new Error("redirect_to inválido.");
  }

  if (candidate.origin !== systemUrl.origin) {
    throw new Error("redirect_to deve usar o mesmo domínio da URL do sistema.");
  }

  return candidate.toString();
}

function getTokenFromInput(
  url: URL,
  body: Record<string, unknown>,
) {
  return asTrimmedString(
    body.token ??
      body.hash ??
      body.authorization_token ??
      body.authorizationToken ??
      body.code ??
      url.searchParams.get("token") ??
      url.searchParams.get("hash") ??
      url.searchParams.get("authorization_token") ??
      url.searchParams.get("authorizationToken") ??
      url.searchParams.get("code"),
  );
}

function buildRedirectUrl(
  redirectTo: string,
  input: {
    status: "success" | "error";
    externalId?: string | null;
    externalKey: string;
    message?: string;
  },
) {
  const redirectUrl = new URL(redirectTo);
  redirectUrl.searchParams.set("appmax_installation", input.status);
  redirectUrl.searchParams.set("appmax_external_key", input.externalKey);

  if (input.externalId) {
    redirectUrl.searchParams.set("appmax_external_id", input.externalId);
  }

  if (input.message) {
    redirectUrl.searchParams.set("appmax_message", input.message);
  }

  return redirectUrl.toString();
}

function buildHtmlShell(input: {
  title: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
  tone: "success" | "error";
}) {
  const accent = input.tone === "success" ? "#355e3b" : "#8a3b2e";
  const background = input.tone === "success"
    ? "linear-gradient(135deg, #f8fbf3, #edf4e7)"
    : "linear-gradient(135deg, #fff7f4, #f8ebe7)";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: ${background};
        font-family: Arial, sans-serif;
        color: #1d2a1f;
      }
      main {
        width: min(92vw, 38rem);
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid rgba(29, 42, 31, 0.12);
        border-radius: 24px;
        padding: 2rem;
        box-shadow: 0 20px 60px rgba(29, 42, 31, 0.12);
      }
      h1 { margin-top: 0; font-size: 1.75rem; }
      p { line-height: 1.6; }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 1rem;
        padding: 0.85rem 1.2rem;
        border-radius: 999px;
        background: ${accent};
        color: #fff;
        text-decoration: none;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${input.title}</h1>
      <p>${input.description}</p>
      <a href="${input.actionUrl}">${input.actionLabel}</a>
    </main>
  </body>
</html>`;
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

  if (req.method !== "GET" && req.method !== "POST") {
    return errorResponse("Método não suportado.", 405);
  }

  const url = new URL(req.url);
  const body = req.method === "POST" ? await parseBody(req) : {};
  const externalKey = asTrimmedString(
    body.external_key ?? url.searchParams.get("external_key"),
  ) || getDefaultAppmaxExternalKey();
  const redirectTo = normalizeRedirectTo(
    asTrimmedString(body.redirect_to ?? url.searchParams.get("redirect_to")) ||
      getAppmaxSystemUrl(),
  );
  const appmaxError = asTrimmedString(
    body.error_description ??
      body.error ??
      url.searchParams.get("error_description") ??
      url.searchParams.get("error"),
  );

  if (appmaxError) {
    const redirectUrl = buildRedirectUrl(redirectTo, {
      status: "error",
      externalKey,
      message: appmaxError,
    });

    if (wantsJson(req, url)) {
      return jsonResponse({
        success: false,
        error: appmaxError,
        redirect_to: redirectUrl,
      }, 400);
    }

    return htmlResponse(buildHtmlShell({
      title: "Instalacao Appmax interrompida",
      description: appmaxError,
      actionLabel: "Voltar ao sistema",
      actionUrl: redirectUrl,
      tone: "error",
    }), 400);
  }

  try {
    const authorizeToken = getTokenFromInput(url, body);

    if (!authorizeToken) {
      throw new Error(
        "A Appmax nao retornou o token da instalacao no callback.",
      );
    }

    const accessToken = await createAppmaxAppAccessToken();
    const merchantCredentials = await generateAppmaxMerchantCredentials(
      accessToken,
      authorizeToken,
    );
    const adminClient = createSupabaseAdminClient();
    const externalId = await createOrGetAppmaxInstallation(
      adminClient,
      req,
      {
        appId: getAppmaxAppId(),
        clientId: merchantCredentials.clientId,
        clientSecret: merchantCredentials.clientSecret,
        externalKey,
      },
      {
        authorizeToken,
        callbackUrl: req.url,
        contentType: req.headers.get("content-type"),
        redirectTo,
        receivedKeys: [
          ...Object.keys(body),
          ...Array.from(url.searchParams.keys()),
        ].sort(),
        source: "callback",
      },
    );
    const redirectUrl = buildRedirectUrl(redirectTo, {
      status: "success",
      externalId,
      externalKey,
    });

    if (wantsJson(req, url)) {
      return jsonResponse({
        success: true,
        external_id: externalId,
        external_key: externalKey,
        redirect_to: redirectUrl,
      });
    }

    return htmlResponse(buildHtmlShell({
      title: "Appmax instalada com sucesso",
      description:
        "As credenciais do merchant foram registradas com seguranca. Voce ja pode voltar para o sistema.",
      actionLabel: "Voltar ao sistema",
      actionUrl: redirectUrl,
      tone: "success",
    }));
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Erro inesperado ao concluir a instalacao Appmax.";
    const redirectUrl = buildRedirectUrl(redirectTo, {
      status: "error",
      externalKey,
      message,
    });
    const isServerError = message.includes("Variável de ambiente ausente") ||
      message.includes("Nao foi possivel obter o token") ||
      message.includes("Nao foi possivel gerar as credenciais") ||
      message.includes("Não foi possível");

    if (wantsJson(req, url)) {
      return jsonResponse({
        success: false,
        error: message,
        redirect_to: redirectUrl,
      }, isServerError ? 500 : 400);
    }

    return htmlResponse(buildHtmlShell({
      title: "Falha ao concluir a instalacao Appmax",
      description: message,
      actionLabel: "Voltar ao sistema",
      actionUrl: redirectUrl,
      tone: "error",
    }), isServerError ? 500 : 400);
  }
});
