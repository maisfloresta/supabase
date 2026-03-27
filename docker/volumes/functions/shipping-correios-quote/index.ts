import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const internalWebhookToken = Deno.env.get('WEBHOOK_SHARED_TOKEN') ?? ''

const CORREIOS_BASE = 'https://api.correios.com.br'

// ─── Packaging Rules Engine (inline) ────────────────────────────────────────

interface PkgDimensions { height_cm: number; width_cm: number; length_cm: number; weight_grams: number | null }

async function runPackagingEngine(
  supabase: ReturnType<typeof createClient>,
  order: Record<string, unknown>,
): Promise<PkgDimensions | null> {
  try {
    const items = (order.items ?? []) as Array<{ sku: string | null; name: string; qty: number }>

    const [rulesRes, catsRes, mapsRes, contRes] = await Promise.all([
      supabase.schema('shipping').from('packaging_rules').select('*').eq('active', true).order('priority', { ascending: true }),
      supabase.schema('shipping').from('product_categories').select('*').eq('active', true),
      supabase.schema('shipping').from('product_category_map').select('sku, category_id'),
      supabase.schema('shipping').from('packaging_containment').select('container_category_id, contained_category_id, max_qty').eq('active', true),
    ])

    const rules = rulesRes.data ?? []
    const categories = catsRes.data ?? []
    const categoryMaps = mapsRes.data ?? []
    const containments = contRes.data ?? []

    if (rules.length === 0) return null

    // Step 1: SKU Fixed (match_skus is a JSON array)
    const skuFixedRules = rules.filter((r: Record<string, unknown>) => r.rule_type === 'sku_fixed' && Array.isArray(r.match_skus) && (r.match_skus as string[]).length > 0)
    for (const rule of skuFixedRules) {
      const skus = (rule.match_skus ?? []) as string[]
      if (items.some(item => item.sku && skus.includes(item.sku))) {
        return { height_cm: Number(rule.height_cm), width_cm: Number(rule.width_cm), length_cm: Number(rule.length_cm), weight_grams: rule.weight_grams_override as number | null }
      }
    }

    // Step 2: Classify items
    const skuToCats = new Map<string, number[]>()
    for (const m of categoryMaps) { const e = skuToCats.get(m.sku) ?? []; e.push(m.category_id); skuToCats.set(m.sku, e) }
    const orderCatIds = new Set<number>()
    for (const item of items) { if (item.sku) { (skuToCats.get(item.sku) ?? []).forEach(c => orderCatIds.add(c)) } }

    // Step 3: Combination rules
    for (const rule of rules.filter((r: Record<string, unknown>) => r.rule_type === 'combination')) {
      const reqIds = (rule.match_category_ids ?? []) as number[]
      if (reqIds.length > 0 && reqIds.every((id: number) => orderCatIds.has(id))) {
        return { height_cm: Number(rule.height_cm), width_cm: Number(rule.width_cm), length_cm: Number(rule.length_cm), weight_grams: rule.weight_grams_override as number | null }
      }
    }

    // Step 4: Category base + containment
    const catBaseRules = rules.filter((r: Record<string, unknown>) => r.rule_type === 'category_base' && r.match_category_id)
    const applicable = catBaseRules.filter((r: Record<string, unknown>) => orderCatIds.has(r.match_category_id as number))
    if (applicable.length > 0) {
      const containedIds = new Set<number>()
      for (const c of containments) {
        if (orderCatIds.has(c.container_category_id) && orderCatIds.has(c.contained_category_id)) containedIds.add(c.contained_category_id)
      }
      const effective = applicable.filter((r: Record<string, unknown>) => !containedIds.has(r.match_category_id as number))
      const best = effective.length > 0 ? effective[0] : applicable[0]
      return { height_cm: Number(best.height_cm), width_cm: Number(best.width_cm), length_cm: Number(best.length_cm), weight_grams: best.weight_grams_override as number | null }
    }

    // Step 5: Fallback
    const fallback = rules.find((r: Record<string, unknown>) => r.rule_type === 'fallback')
    if (fallback) {
      return { height_cm: Number(fallback.height_cm), width_cm: Number(fallback.width_cm), length_cm: Number(fallback.length_cm), weight_grams: fallback.weight_grams_override as number | null }
    }

    return null
  } catch (e) {
    console.error('Packaging engine error (non-fatal):', e instanceof Error ? e.message : String(e))
    return null
  }
}

// Token cache (Correios tokens last ~1h, we refresh at 50 min)
let cachedToken: string | null = null
let tokenExpiresAt = 0

// ─── Auth helpers ───────────────────────────────────────────────────────────

function parseBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null
  const [scheme, token] = headerValue.trim().split(/\s+/, 2)
  if (!scheme || !token) return null
  if (scheme.toLowerCase() !== 'bearer') return null
  return token
}

function isAuthorizedRequest(req: Request): boolean {
  if (!internalWebhookToken) return false
  const directToken = req.headers.get('x-webhook-shared-token')
  if (directToken && directToken === internalWebhookToken) return true
  const bearerToken = parseBearerToken(req.headers.get('authorization'))
  if (bearerToken && bearerToken === internalWebhookToken) return true
  return false
}

// ─── Correios Auth ──────────────────────────────────────────────────────────

interface CorreiosCredentials {
  cnpj: string
  senha: string
  cartaoPostagem: string
}

async function getCorreiosCredentials(supabase: ReturnType<typeof createClient>): Promise<CorreiosCredentials> {
  const { data, error } = await supabase
    .schema('shipping')
    .from('settings')
    .select('key, value')
    .is('store_id', null)
    .in('key', ['correios_cnpj', 'correios_senha', 'correios_cartao_postagem'])

  if (error) throw new Error(`Failed to load Correios credentials: ${error.message}`)
  if (!data || data.length < 3) throw new Error('Correios credentials not configured in shipping.settings')

  const map = Object.fromEntries(data.map((r: { key: string; value: unknown }) => [r.key, r.value]))
  return {
    cnpj: String(map.correios_cnpj ?? '').replace(/"/g, ''),
    senha: String(map.correios_senha ?? '').replace(/"/g, ''),
    cartaoPostagem: String(map.correios_cartao_postagem ?? '').replace(/"/g, ''),
  }
}

async function getCorreiosToken(creds: CorreiosCredentials): Promise<string> {
  const now = Date.now()
  if (cachedToken && now < tokenExpiresAt) return cachedToken

  console.log('Correios: authenticating...')
  const basicAuth = btoa(`${creds.cnpj}:${creds.senha}`)

  const resp = await fetch(`${CORREIOS_BASE}/token/v1/autentica/cartaopostagem`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ numero: creds.cartaoPostagem }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Correios auth failed (${resp.status}): ${body}`)
  }

  const json = await resp.json()
  cachedToken = json.token
  // Refresh 10 min before expiry (token usually valid 1h)
  tokenExpiresAt = now + 50 * 60 * 1000
  console.log('Correios: authenticated OK')
  return cachedToken!
}

// ─── Correios Quote ─────────────────────────────────────────────────────────

interface QuoteParams {
  cepOrigem: string
  cepDestino: string
  peso: number      // kg (e.g. 0.5)
  comprimento: number // cm
  largura: number     // cm
  altura: number      // cm
  valorDeclarado?: number // R$ (optional)
}

interface ServiceQuote {
  serviceCode: string
  serviceName: string
  priceCents: number
  priceRaw: string
  deliveryDays: number
  maxDate: string | null
  error: string | null
  rawPrice: Record<string, unknown>
  rawDeadline: Record<string, unknown>
}

const SERVICE_MAP: Record<string, string> = {
  '04227': 'Mini Envios',
  '03298': 'PAC',
  '03220': 'SEDEX',
}

async function quoteCorreios(token: string, params: QuoteParams): Promise<ServiceQuote[]> {
  const serviceCodes = Object.keys(SERVICE_MAP)
  const results: ServiceQuote[] = []

  // Build all fetch promises (price + deadline for each service)
  const fetches: Array<{ code: string; type: 'price' | 'deadline'; promise: Promise<Response> }> = []

  for (const code of serviceCodes) {
    // Price URL
    let priceUrl = `${CORREIOS_BASE}/preco/v1/nacional/${code}?` +
      `cepOrigem=${params.cepOrigem}&cepDestino=${params.cepDestino}` +
      `&psObjeto=${params.peso}&tpObjeto=2` +
      `&comprimento=${params.comprimento}&largura=${params.largura}&altura=${params.altura}`

    // Valor Declarado: different service codes per carrier
    // SEDEX = 019, PAC = 064, Mini Envios = not supported
    if (params.valorDeclarado && params.valorDeclarado > 30) {
      const vdCode = code === '03220' ? '019' : code === '03298' ? '064' : null
      if (vdCode) {
        priceUrl += `&vlDeclarado=${params.valorDeclarado}&servicosAdicionais=${vdCode}`
      }
    }

    // Deadline URL
    const deadlineUrl = `${CORREIOS_BASE}/prazo/v1/nacional/${code}?` +
      `cepOrigem=${params.cepOrigem}&cepDestino=${params.cepDestino}`

    const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }

    fetches.push({ code, type: 'price', promise: fetch(priceUrl, { headers }) })
    fetches.push({ code, type: 'deadline', promise: fetch(deadlineUrl, { headers }) })
  }

  // Execute all in parallel
  const responses = await Promise.allSettled(fetches.map(f => f.promise))

  // Group results by service code
  const byCode: Record<string, { priceData?: Record<string, unknown>; deadlineData?: Record<string, unknown>; priceError?: string; deadlineError?: string }> = {}

  for (let i = 0; i < fetches.length; i++) {
    const { code, type } = fetches[i]
    if (!byCode[code]) byCode[code] = {}

    const result = responses[i]
    if (result.status === 'rejected') {
      if (type === 'price') byCode[code].priceError = String(result.reason)
      else byCode[code].deadlineError = String(result.reason)
      continue
    }

    const resp = result.value
    const text = await resp.text()
    try {
      const json = JSON.parse(text)
      if (type === 'price') {
        if (!resp.ok) byCode[code].priceError = json.msgs?.[0]?.texto || `HTTP ${resp.status}`
        else byCode[code].priceData = json
      } else {
        if (!resp.ok) byCode[code].deadlineError = json.msgs?.[0]?.texto || `HTTP ${resp.status}`
        else byCode[code].deadlineData = json
      }
    } catch {
      if (type === 'price') byCode[code].priceError = `Parse error: ${text.substring(0, 200)}`
      else byCode[code].deadlineError = `Parse error: ${text.substring(0, 200)}`
    }
  }

  // Assemble results
  for (const code of serviceCodes) {
    const data = byCode[code] || {}
    const hasError = data.priceError || data.deadlineError

    const priceStr = String(data.priceData?.pcFinal ?? '0').replace(',', '.')
    const priceCents = Math.round(parseFloat(priceStr) * 100) || 0
    const deliveryDays = Number(data.deadlineData?.prazoEntrega) || 0
    const maxDate = data.deadlineData?.dataMaxima ? String(data.deadlineData.dataMaxima) : null

    results.push({
      serviceCode: code,
      serviceName: SERVICE_MAP[code] || code,
      priceCents,
      priceRaw: String(data.priceData?.pcFinal ?? '0'),
      deliveryDays,
      maxDate,
      error: hasError ? `${data.priceError || ''} ${data.deadlineError || ''}`.trim() : null,
      rawPrice: (data.priceData ?? {}) as Record<string, unknown>,
      rawDeadline: (data.deadlineData ?? {}) as Record<string, unknown>,
    })
  }

  return results
}

// ─── Main Handler ───────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-shared-token',
        },
      })
    }

    if (req.method !== 'POST') {
      return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
    }

    if (!isAuthorizedRequest(req)) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
    }

    const body = await req.json()
    const { action } = body

    const supabase = createClient(supabaseUrl, supabaseKey)

    // ── Action: quote ── Quote a single order or arbitrary package
    if (action === 'quote') {
      return await handleQuote(supabase, body)
    }

    // ── Action: quote_order ── Quote an existing unified_order by ID
    if (action === 'quote_order') {
      return await handleQuoteOrder(supabase, body)
    }

    // ── Action: bulk_quote ── Quote multiple orders at once
    if (action === 'bulk_quote') {
      return await handleBulkQuote(supabase, body)
    }

    return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400)

  } catch (error) {
    const msg = error instanceof Error ? error.message : (typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error))
    console.error('shipping-correios-quote fatal:', msg)
    return jsonResponse({ success: false, error: msg }, 500)
  }
})

// ─── Action Handlers ────────────────────────────────────────────────────────

async function handleQuote(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const { cepDestino, peso, comprimento, largura, altura, valorDeclarado, cepOrigem } = body

  if (!cepDestino || !peso) {
    return jsonResponse({ success: false, error: 'cepDestino and peso are required' }, 400)
  }

  // Get sender ZIP from settings if not provided
  let senderZip = cepOrigem ? String(cepOrigem) : null
  if (!senderZip) {
    const { data } = await supabase
      .schema('shipping')
      .from('settings')
      .select('value')
      .is('store_id', null)
      .eq('key', 'sender_zip')
      .maybeSingle()
    senderZip = data?.value ? String(data.value).replace(/"/g, '') : '29101110'
  }

  const creds = await getCorreiosCredentials(supabase)
  const token = await getCorreiosToken(creds)

  const quotes = await quoteCorreios(token, {
    cepOrigem: senderZip!,
    cepDestino: String(cepDestino).replace(/\D/g, ''),
    peso: Number(peso),
    comprimento: Number(comprimento) || 16,
    largura: Number(largura) || 11,
    altura: Number(altura) || 2,
    valorDeclarado: valorDeclarado ? Number(valorDeclarado) : undefined,
  })

  return jsonResponse({ success: true, quotes })
}

async function handleQuoteOrder(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const { order_id } = body
  if (!order_id) return jsonResponse({ success: false, error: 'order_id is required' }, 400)

  // Fetch the order
  const { data: order, error: orderErr } = await supabase
    .schema('shipping')
    .from('unified_orders')
    .select('*')
    .eq('id', order_id)
    .single()

  if (orderErr || !order) {
    return jsonResponse({ success: false, error: `Order not found: ${orderErr?.message ?? 'null'}` }, 404)
  }

  // ── Packaging Rules Engine: recalculate dimensions ──
  const engineResult = await runPackagingEngine(supabase, order)

  let pkgHeight = Number(order.package_height_cm) || 2
  let pkgWidth = Number(order.package_width_cm) || 11
  let pkgLength = Number(order.package_length_cm) || 16
  let pkgWeight = order.package_weight_grams || 300

  if (engineResult) {
    pkgHeight = engineResult.height_cm
    pkgWidth = engineResult.width_cm
    pkgLength = engineResult.length_cm
    if (engineResult.weight_grams !== null) pkgWeight = engineResult.weight_grams

    // Update order with recalculated dimensions
    const updateData: Record<string, unknown> = {
      package_height_cm: pkgHeight,
      package_width_cm: pkgWidth,
      package_length_cm: pkgLength,
    }
    if (engineResult.weight_grams !== null) updateData.package_weight_grams = pkgWeight
    await supabase.schema('shipping').from('unified_orders').update(updateData).eq('id', order.id)
  }

  // Get sender ZIP
  const { data: senderSetting } = await supabase
    .schema('shipping')
    .from('settings')
    .select('value')
    .is('store_id', null)
    .eq('key', 'sender_zip')
    .maybeSingle()
  const senderZip = senderSetting?.value ? String(senderSetting.value).replace(/"/g, '') : '29101110'

  const creds = await getCorreiosCredentials(supabase)
  const token = await getCorreiosToken(creds)

  // Convert weight from grams to kg
  const pesoKg = pkgWeight / 1000
  // Valor declarado from total_cents to R$
  const valorDeclarado = (order.total_cents || 0) / 100

  const quotes = await quoteCorreios(token, {
    cepOrigem: senderZip,
    cepDestino: String(order.shipping_zip).replace(/\D/g, ''),
    peso: pesoKg,
    comprimento: pkgLength,
    largura: pkgWidth,
    altura: pkgHeight,
    valorDeclarado: valorDeclarado > 0 ? valorDeclarado : undefined,
  })

  // Save quotes to shipping.quotes table
  const quotesToInsert = quotes.map(q => ({
    order_id: order.id,
    carrier_provider: 'correios',
    carrier_name: `Correios ${q.serviceName}`,
    carrier_service_code: q.serviceCode,
    price_cents: q.priceCents,
    discount_cents: 0,
    final_price_cents: q.priceCents,
    delivery_min_days: q.deliveryDays,
    delivery_max_days: q.deliveryDays,
    selected: false,
    auto_selected: false,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    raw_response: { price: q.rawPrice, deadline: q.rawDeadline, error: q.error },
  }))

  // Delete old quotes for this order before inserting new ones
  await supabase
    .schema('shipping')
    .from('quotes')
    .delete()
    .eq('order_id', order.id)

  const { error: insertErr } = await supabase
    .schema('shipping')
    .from('quotes')
    .insert(quotesToInsert)

  if (insertErr) {
    console.error('Error inserting quotes:', insertErr)
    return jsonResponse({ success: false, error: `Failed to save quotes: ${JSON.stringify(insertErr)}` }, 500)
  }

  // Update order status to 'quoted' if it was 'pending'
  if (order.status === 'pending') {
    await supabase
      .schema('shipping')
      .from('unified_orders')
      .update({ status: 'quoted', quoted_at: new Date().toISOString() })
      .eq('id', order.id)
  }

  return jsonResponse({
    success: true,
    order_id: order.id,
    quotes: quotes.map(q => ({
      serviceName: q.serviceName,
      serviceCode: q.serviceCode,
      priceCents: q.priceCents,
      priceFormatted: `R$ ${(q.priceCents / 100).toFixed(2).replace('.', ',')}`,
      deliveryDays: q.deliveryDays,
      maxDate: q.maxDate,
      error: q.error,
    })),
  })
}

async function handleBulkQuote(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const { order_ids } = body
  if (!order_ids || !Array.isArray(order_ids) || order_ids.length === 0) {
    return jsonResponse({ success: false, error: 'order_ids array is required' }, 400)
  }

  if (order_ids.length > 50) {
    return jsonResponse({ success: false, error: 'Max 50 orders per batch' }, 400)
  }

  const results: Array<{ order_id: string; status: string; error?: string }> = []

  // Process each order sequentially (Correios API rate limiting)
  for (const orderId of order_ids) {
    try {
      const resp = await handleQuoteOrder(supabase, { order_id: orderId })
      const respBody = await resp.json()
      results.push({
        order_id: String(orderId),
        status: respBody.success ? 'quoted' : 'error',
        error: respBody.error,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ order_id: String(orderId), status: 'error', error: msg })
    }

    // Small delay between orders to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  const quoted = results.filter(r => r.status === 'quoted').length
  const errors = results.filter(r => r.status === 'error').length

  return jsonResponse({
    success: true,
    message: `Bulk quote completed: ${quoted} quoted, ${errors} errors`,
    quoted,
    errors,
    total: results.length,
    results,
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
