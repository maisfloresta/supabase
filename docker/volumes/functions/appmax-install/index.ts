import {
  buildAppmaxAuthorizeUrl,
  createAppmaxAppAccessToken,
  createAppmaxAuthorizeToken,
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

function buildCallbackUrl(
  req: Request,
  externalKey: string,
  redirectTo: string,
) {
  const baseUrl = Deno.env.get("APPMAX_INSTALL_CALLBACK_URL")?.trim();
  const callbackUrl = baseUrl
    ? new URL(baseUrl)
    : new URL("/functions/v1/appmax-install-callback", new URL(req.url).origin);

  callbackUrl.searchParams.set("external_key", externalKey);
  callbackUrl.searchParams.set("redirect_to", redirectTo);

  return callbackUrl.toString();
}

function buildHtmlShell(input: {
  title: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
}) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(84, 133, 91, 0.14), transparent 36%),
          linear-gradient(135deg, #f8fbf3, #edf4e7);
        font-family: Arial, sans-serif;
        color: #1d2a1f;
      }
      main {
        width: min(92vw, 36rem);
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(84, 133, 91, 0.18);
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
        background: #355e3b;
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

  try {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await parseBody(req) : {};
    const externalKey = asTrimmedString(
      body.external_key ?? url.searchParams.get("external_key"),
    ) || getDefaultAppmaxExternalKey();
    const redirectTo = normalizeRedirectTo(
      asTrimmedString(body.redirect_to ?? url.searchParams.get("redirect_to")) ||
        getAppmaxSystemUrl(),
    );
    const callbackUrl = buildCallbackUrl(req, externalKey, redirectTo);
    const accessToken = await createAppmaxAppAccessToken();
    const authorizeToken = await createAppmaxAuthorizeToken(accessToken, {
      appId: getAppmaxAppId(),
      externalKey,
      callbackUrl,
    });
    const authorizeUrl = buildAppmaxAuthorizeUrl(authorizeToken);

    if (wantsJson(req, url) || req.method === "POST") {
      return jsonResponse({
        success: true,
        app_id: getAppmaxAppId(),
        external_key: externalKey,
        callback_url: callbackUrl,
        authorize_token: authorizeToken,
        authorize_url: authorizeUrl,
        redirect_to: redirectTo,
      });
    }

    if (url.searchParams.get("preview") === "1") {
      return htmlResponse(buildHtmlShell({
        title: "Instalar Appmax",
        description:
          "O link de autorização da Appmax foi gerado. Use o botão abaixo para abrir a tela de autorização do aplicativo.",
        actionLabel: "Abrir autorizacao",
        actionUrl: authorizeUrl,
      }));
    }

    return Response.redirect(authorizeUrl, 302);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Erro inesperado ao iniciar a instalação Appmax.";
    const isServerError = message.includes("Variável de ambiente ausente") ||
      message.includes("Não foi possível obter o token") ||
      message.includes("Não foi possível autorizar");

    return errorResponse(message, isServerError ? 500 : 400);
  }
});
