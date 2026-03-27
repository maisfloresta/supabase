import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const internalWebhookToken = Deno.env.get('WEBHOOK_SHARED_TOKEN') ?? ''

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

serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 405,
      })
    }

    if (!isAuthorizedRequest(req)) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    console.log('Shipping Order Unifier - Starting')

    const supabase = createClient(supabaseUrl, supabaseKey)
    const results: Array<{ source: string; order_id: string; status: string; error?: string }> = []

    // =========================================================================
    // 1. Unificar pedidos Yampi pagos ainda não processados
    // =========================================================================
    const { data: yampiOrders, error: yampiError } = await supabase
      .rpc('get_pending_yampi_shipping_orders')

    if (yampiError) {
      console.error('Error fetching Yampi orders:', yampiError)
    } else if (yampiOrders && yampiOrders.length > 0) {
      console.log(`Found ${yampiOrders.length} pending Yampi orders`)

      for (const order of yampiOrders) {
        try {
          // Buscar itens do pedido
          const { data: items } = await supabase
            .schema('yampi')
            .from('order_items')
            .select('item_sku, title, quantity, unit_price_cents, raw')
            .eq('merchant_id', order.merchant_id)
            .eq('yampi_order_id', order.yampi_order_id)

          // Buscar dimensões dos produtos e montar itens
          const unifiedItems = await buildUnifiedItems(supabase, items ?? [], 'yampi')

          // Calcular dimensões do pacote
          const pkg = calculatePackageDimensions(unifiedItems)

          // Resolver store_id via store_external_links
          const storeId = await resolveStoreId(supabase, 'yampi', order.merchant_id.toString())

          const { error: insertError } = await supabase
            .schema('shipping')
            .from('unified_orders')
            .insert({
              store_id: storeId,
              source_platform: 'yampi',
              source_order_id: order.yampi_order_id.toString(),
              source_order_number: order.order_number?.toString(),
              source_event_id: order.integration_event_id,
              customer_name: order.customer_name,
              customer_email: order.customer_email,
              customer_phone: order.customer_phone,
              customer_cpf: order.customer_cpf,
              shipping_name: order.shipping_name,
              shipping_address: order.shipping_address,
              shipping_number: order.shipping_number,
              shipping_complement: order.shipping_complement,
              shipping_neighborhood: order.shipping_neighborhood,
              shipping_city: order.shipping_city,
              shipping_state: order.shipping_state,
              shipping_zip: order.shipping_zip,
              shipping_country: order.shipping_country ?? 'BR',
              items: unifiedItems,
              package_weight_grams: pkg.weight_grams,
              package_height_cm: pkg.height_cm,
              package_width_cm: pkg.width_cm,
              package_length_cm: pkg.length_cm,
              total_cents: order.total_cents ?? 0,
              shipping_cents: order.shipping_cents ?? 0,
              status: 'pending',
            })

          if (insertError) {
            // Unique constraint = já foi unificado (race condition)
            if (insertError.code === '23505') {
              results.push({ source: 'yampi', order_id: order.yampi_order_id.toString(), status: 'skipped_duplicate' })
            } else {
              throw insertError
            }
          } else {
            results.push({ source: 'yampi', order_id: order.yampi_order_id.toString(), status: 'unified' })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err))
          console.error(`Error unifying Yampi order ${order.yampi_order_id}:`, msg)
          results.push({ source: 'yampi', order_id: order.yampi_order_id?.toString(), status: 'error', error: msg })
        }
      }
    }

    // =========================================================================
    // 2. Unificar pedidos CartPanda pagos ainda não processados
    // =========================================================================
    const { data: cartpandaOrders, error: cartpandaError } = await supabase
      .rpc('get_pending_cartpanda_shipping_orders')

    if (cartpandaError) {
      console.error('Error fetching CartPanda orders:', cartpandaError)
    } else if (cartpandaOrders && cartpandaOrders.length > 0) {
      console.log(`Found ${cartpandaOrders.length} pending CartPanda orders`)

      for (const order of cartpandaOrders) {
        try {
          // Buscar itens do pedido
          const { data: items } = await supabase
            .schema('cartpanda')
            .from('order_items')
            .select('sku, title, name, quantity, unit_price_cents, raw')
            .eq('shop_id', order.shop_id)
            .eq('cartpanda_order_id', order.cartpanda_order_id)

          const unifiedItems = await buildUnifiedItems(supabase, items ?? [], 'cartpanda')
          const pkg = calculatePackageDimensions(unifiedItems)
          const storeId = await resolveStoreId(supabase, 'cartpanda', order.shop_id.toString())

          const { error: insertError } = await supabase
            .schema('shipping')
            .from('unified_orders')
            .insert({
              store_id: storeId,
              source_platform: 'cartpanda',
              source_order_id: order.cartpanda_order_id.toString(),
              source_order_number: order.order_number?.toString(),
              source_event_id: order.integration_event_id,
              customer_name: order.customer_name,
              customer_email: order.customer_email,
              customer_phone: order.customer_phone,
              customer_cpf: order.customer_cpf,
              shipping_name: order.shipping_name,
              shipping_address: order.shipping_address,
              shipping_number: order.shipping_number,
              shipping_complement: order.shipping_complement,
              shipping_neighborhood: order.shipping_neighborhood,
              shipping_city: order.shipping_city,
              shipping_state: order.shipping_state,
              shipping_zip: order.shipping_zip,
              shipping_country: order.shipping_country ?? 'BR',
              items: unifiedItems,
              package_weight_grams: pkg.weight_grams,
              package_height_cm: pkg.height_cm,
              package_width_cm: pkg.width_cm,
              package_length_cm: pkg.length_cm,
              total_cents: order.total_cents ?? 0,
              shipping_cents: order.shipping_cents ?? 0,
              status: 'pending',
            })

          if (insertError) {
            if (insertError.code === '23505') {
              results.push({ source: 'cartpanda', order_id: order.cartpanda_order_id.toString(), status: 'skipped_duplicate' })
            } else {
              throw insertError
            }
          } else {
            results.push({ source: 'cartpanda', order_id: order.cartpanda_order_id.toString(), status: 'unified' })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error'
          console.error(`Error unifying CartPanda order ${order.cartpanda_order_id}:`, msg)
          results.push({ source: 'cartpanda', order_id: order.cartpanda_order_id?.toString(), status: 'error', error: msg })
        }
      }
    }

    const unified = results.filter((r) => r.status === 'unified').length
    const errors = results.filter((r) => r.status === 'error').length

    console.log(`Shipping Order Unifier - Done. Unified: ${unified}, Errors: ${errors}, Total: ${results.length}`)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Order unification completed',
        unified,
        errors,
        total: results.length,
        results,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error'
    console.error('Shipping Order Unifier - Fatal error:', msg)
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// =============================================================================
// Helpers
// =============================================================================

interface UnifiedItem {
  sku: string | null
  name: string
  qty: number
  price_cents: number
  weight_g: number
  h_cm: number
  w_cm: number
  l_cm: number
}

interface PackageDimensions {
  weight_grams: number
  height_cm: number
  width_cm: number
  length_cm: number
}

async function buildUnifiedItems(
  supabase: ReturnType<typeof createClient>,
  items: Array<Record<string, unknown>>,
  source: 'yampi' | 'cartpanda'
): Promise<UnifiedItem[]> {
  const unifiedItems: UnifiedItem[] = []

  for (const item of items) {
    const sku = source === 'yampi'
      ? (item.item_sku as string | null)
      : (item.sku as string | null)

    const name = (item.title as string) || (item.name as string) || 'Produto'
    const qty = (item.quantity as number) || 1
    const priceCents = (item.unit_price_cents as number) || 0

    // Tentar buscar dimensões do catálogo
    let dims = { weight_g: 0, h_cm: 0, w_cm: 0, l_cm: 0 }

    if (sku) {
      const { data: productDim } = await supabase
        .schema('shipping')
        .from('product_dimensions')
        .select('weight_grams, height_cm, width_cm, length_cm')
        .eq('sku', sku)
        .eq('active', true)
        .limit(1)
        .maybeSingle()

      if (productDim) {
        dims = {
          weight_g: productDim.weight_grams || 0,
          h_cm: Number(productDim.height_cm) || 0,
          w_cm: Number(productDim.width_cm) || 0,
          l_cm: Number(productDim.length_cm) || 0,
        }
      }
    }

    unifiedItems.push({
      sku,
      name,
      qty,
      price_cents: priceCents,
      ...dims,
    })
  }

  return unifiedItems
}

function calculatePackageDimensions(items: UnifiedItem[]): PackageDimensions {
  if (items.length === 0) {
    // Dimensões mínimas padrão para Correios
    return { weight_grams: 300, height_cm: 2, width_cm: 11, length_cm: 16 }
  }

  let totalWeight = 0
  let maxHeight = 0
  let maxWidth = 0
  let maxLength = 0

  for (const item of items) {
    totalWeight += (item.weight_g || 0) * item.qty
    // Para dimensões, usa o maior item (empilhamento simplificado)
    maxHeight = Math.max(maxHeight, item.h_cm || 0)
    maxWidth = Math.max(maxWidth, item.w_cm || 0)
    maxLength = Math.max(maxLength, item.l_cm || 0)
  }

  // Se vários itens, soma altura (empilhamento vertical)
  const totalItems = items.reduce((sum, i) => sum + i.qty, 0)
  if (totalItems > 1 && maxHeight > 0) {
    maxHeight = items.reduce((sum, i) => sum + (i.h_cm || 0) * i.qty, 0)
  }

  // Aplicar mínimos do Correios
  return {
    weight_grams: Math.max(totalWeight, 300),       // mínimo 300g
    height_cm: Math.max(maxHeight, 2),               // mínimo 2cm
    width_cm: Math.max(maxWidth, 11),                // mínimo 11cm
    length_cm: Math.max(maxLength, 16),              // mínimo 16cm
  }
}

// Cache de store_id para evitar consultas repetidas
const storeIdCache = new Map<string, string | null>()

async function resolveStoreId(
  supabase: ReturnType<typeof createClient>,
  source: string,
  externalStoreId: string
): Promise<string | null> {
  const cacheKey = `${source}:${externalStoreId}`

  if (storeIdCache.has(cacheKey)) {
    return storeIdCache.get(cacheKey)!
  }

  const { data } = await supabase
    .schema('integrations')
    .from('store_external_links')
    .select('store_id')
    .eq('source', source)
    .eq('external_store_id', externalStoreId)
    .maybeSingle()

  const storeId = data?.store_id ?? null
  storeIdCache.set(cacheKey, storeId)
  return storeId
}
