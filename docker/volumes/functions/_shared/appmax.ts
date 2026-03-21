import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
}) {
  return {
    app_id: input.appId,
    external_key: input.externalKey,
    content_type: input.contentType,
    received_keys: input.receivedKeys,
    merchant_client_id: "<encrypted>",
    merchant_client_secret: "<encrypted>",
  };
}
