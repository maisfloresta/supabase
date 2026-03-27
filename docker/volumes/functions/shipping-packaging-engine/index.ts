import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const internalToken = Deno.env.get('WEBHOOK_SHARED_TOKEN') ?? ''

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrderItem {
  sku: string | null
  name: string
  qty: number
  price_cents: number
  weight_g: number
  h_cm: number
  w_cm: number
  l_cm: number
}

interface Dimensions {
  height_cm: number
  width_cm: number
  length_cm: number
  weight_grams: number | null
}

interface EvalStep {
  step: string
  matched: boolean
  detail: string
}

interface EngineResult {
  dimensions: Dimensions
  applied_rule: { id: number; name: string; type: string } | null
  evaluation: EvalStep[]
}

interface PackagingRule {
  id: number
  name: string
  rule_type: string
  priority: number
  match_skus: string[]
  match_category_id: number | null
  match_category_ids: number[]
  height_cm: number
  width_cm: number
  length_cm: number
  weight_grams_override: number | null
  active: boolean
}

interface CategoryMap {
  sku: string
  category_id: number
}

interface Containment {
  container_category_id: number
  contained_category_id: number
  max_qty: number | null
}

interface Category {
  id: number
  slug: string
  name: string
}

// ─── Engine Core ────────────────────────────────────────────────────────────

async function loadEngineData(supabase: SupabaseClient) {
  const [rulesRes, catsRes, mapsRes, contRes] = await Promise.all([
    supabase.schema('shipping').from('packaging_rules')
      .select('*').eq('active', true).order('priority', { ascending: true }),
    supabase.schema('shipping').from('product_categories')
      .select('*').eq('active', true),
    supabase.schema('shipping').from('product_category_map').select('sku, category_id'),
    supabase.schema('shipping').from('packaging_containment')
      .select('container_category_id, contained_category_id, max_qty').eq('active', true),
  ])

  return {
    rules: (rulesRes.data ?? []) as PackagingRule[],
    categories: (catsRes.data ?? []) as Category[],
    categoryMaps: (mapsRes.data ?? []) as CategoryMap[],
    containments: (contRes.data ?? []) as Containment[],
  }
}

export function runEngine(
  items: OrderItem[],
  rules: PackagingRule[],
  categories: Category[],
  categoryMaps: CategoryMap[],
  containments: Containment[],
): EngineResult {
  const evaluation: EvalStep[] = []
  const catById = new Map(categories.map(c => [c.id, c]))

  // ── Step 1: SKU Fixed ──
  const skuFixedRules = rules.filter(r => r.rule_type === 'sku_fixed' && (r.match_skus ?? []).length > 0)
  let skuMatch: PackagingRule | null = null
  let matchedSku = ''

  for (const rule of skuFixedRules) {
    const skus = (rule.match_skus ?? []) as string[]
    const found = items.find(item => item.sku && skus.includes(item.sku))
    if (found) {
      skuMatch = rule
      matchedSku = found.sku!
      break
    }
  }

  if (skuMatch) {
    evaluation.push({
      step: 'sku_fixed',
      matched: true,
      detail: `SKU "${matchedSku}" encontrado → regra "${skuMatch.name}" (${skuMatch.height_cm}x${skuMatch.width_cm}x${skuMatch.length_cm})`,
    })
    return {
      dimensions: {
        height_cm: Number(skuMatch.height_cm),
        width_cm: Number(skuMatch.width_cm),
        length_cm: Number(skuMatch.length_cm),
        weight_grams: skuMatch.weight_grams_override,
      },
      applied_rule: { id: skuMatch.id, name: skuMatch.name, type: 'sku_fixed' },
      evaluation,
    }
  }

  evaluation.push({ step: 'sku_fixed', matched: false, detail: 'Nenhum SKU fixo encontrado' })

  // ── Step 2: Classify items by category ──
  const skuToCats = new Map<string, number[]>()
  for (const m of categoryMaps) {
    const existing = skuToCats.get(m.sku) ?? []
    existing.push(m.category_id)
    skuToCats.set(m.sku, existing)
  }

  const orderCategoryIds = new Set<number>()
  const unmappedSkus: string[] = []

  for (const item of items) {
    if (!item.sku) { unmappedSkus.push(item.name); continue }
    const cats = skuToCats.get(item.sku)
    if (cats) {
      cats.forEach(c => orderCategoryIds.add(c))
    } else {
      unmappedSkus.push(item.sku)
    }
  }

  const catNames = [...orderCategoryIds].map(id => catById.get(id)?.name ?? `ID:${id}`).join(', ')
  const classDetail = catNames
    ? `Categorias no pedido: ${catNames}` + (unmappedSkus.length ? `. SKUs sem categoria: ${unmappedSkus.join(', ')}` : '')
    : `Nenhum item mapeado a categoria` + (unmappedSkus.length ? `. SKUs: ${unmappedSkus.join(', ')}` : '')

  evaluation.push({ step: 'classificacao', matched: orderCategoryIds.size > 0, detail: classDetail })

  // ── Step 3: Combination rules ──
  const combinationRules = rules.filter(r => r.rule_type === 'combination')
  let comboMatch: PackagingRule | null = null

  for (const rule of combinationRules) {
    const requiredIds = (rule.match_category_ids ?? []) as number[]
    if (requiredIds.length === 0) continue
    const allPresent = requiredIds.every(id => orderCategoryIds.has(id))
    if (allPresent) {
      comboMatch = rule
      break
    }
  }

  if (comboMatch) {
    const reqNames = ((comboMatch.match_category_ids ?? []) as number[])
      .map(id => catById.get(id)?.name ?? `ID:${id}`).join(' + ')
    evaluation.push({
      step: 'combinacao',
      matched: true,
      detail: `Combinacao "${reqNames}" encontrada → regra "${comboMatch.name}"`,
    })
    return {
      dimensions: {
        height_cm: Number(comboMatch.height_cm),
        width_cm: Number(comboMatch.width_cm),
        length_cm: Number(comboMatch.length_cm),
        weight_grams: comboMatch.weight_grams_override,
      },
      applied_rule: { id: comboMatch.id, name: comboMatch.name, type: 'combination' },
      evaluation,
    }
  }

  evaluation.push({ step: 'combinacao', matched: false, detail: 'Nenhuma combinacao especifica encontrada' })

  // ── Step 4: Category base + Containment ──
  const categoryBaseRules = rules.filter(r => r.rule_type === 'category_base' && r.match_category_id)

  // Find applicable category rules
  const applicableRules = categoryBaseRules.filter(r => orderCategoryIds.has(r.match_category_id!))

  if (applicableRules.length > 0) {
    // Apply containment: find which categories are "contained" by others present
    const containedCategoryIds = new Set<number>()
    for (const cont of containments) {
      if (orderCategoryIds.has(cont.container_category_id) && orderCategoryIds.has(cont.contained_category_id)) {
        containedCategoryIds.add(cont.contained_category_id)
      }
    }

    const containmentDetail = containedCategoryIds.size > 0
      ? `Contencao aplicada: ${[...containedCategoryIds].map(id => catById.get(id)?.name ?? id).join(', ')} contido(s)`
      : 'Nenhuma contencao aplicavel'

    // Filter out rules for contained categories
    const effectiveRules = applicableRules.filter(r => !containedCategoryIds.has(r.match_category_id!))

    // Use the best rule (lowest priority number) among effective
    const bestRule = effectiveRules.length > 0
      ? effectiveRules[0]  // already sorted by priority
      : applicableRules[0] // if all contained, use the container's rule (highest priority among applicable)

    const bestCatName = catById.get(bestRule.match_category_id!)?.name ?? ''

    evaluation.push({
      step: 'categoria_base',
      matched: true,
      detail: `${containmentDetail}. Regra base: "${bestRule.name}" (${bestCatName}) → ${bestRule.height_cm}x${bestRule.width_cm}x${bestRule.length_cm}`,
    })

    return {
      dimensions: {
        height_cm: Number(bestRule.height_cm),
        width_cm: Number(bestRule.width_cm),
        length_cm: Number(bestRule.length_cm),
        weight_grams: bestRule.weight_grams_override,
      },
      applied_rule: { id: bestRule.id, name: bestRule.name, type: 'category_base' },
      evaluation,
    }
  }

  evaluation.push({ step: 'categoria_base', matched: false, detail: 'Nenhuma regra de categoria aplicavel' })

  // ── Step 5: Fallback ──
  const fallbackRule = rules.find(r => r.rule_type === 'fallback')

  if (fallbackRule) {
    evaluation.push({
      step: 'fallback',
      matched: true,
      detail: `Usando regra padrao "${fallbackRule.name}" → ${fallbackRule.height_cm}x${fallbackRule.width_cm}x${fallbackRule.length_cm}`,
    })
    return {
      dimensions: {
        height_cm: Number(fallbackRule.height_cm),
        width_cm: Number(fallbackRule.width_cm),
        length_cm: Number(fallbackRule.length_cm),
        weight_grams: fallbackRule.weight_grams_override,
      },
      applied_rule: { id: fallbackRule.id, name: fallbackRule.name, type: 'fallback' },
      evaluation,
    }
  }

  // Ultimate fallback (no rules in DB at all)
  evaluation.push({ step: 'fallback', matched: false, detail: 'Nenhuma regra fallback configurada. Usando dimensoes minimas.' })
  return {
    dimensions: { height_cm: 2, width_cm: 11, length_cm: 16, weight_grams: null },
    applied_rule: null,
    evaluation,
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

function isAuthorized(req: Request): boolean {
  if (!internalToken) return false
  const direct = req.headers.get('x-webhook-shared-token')
  if (direct === internalToken) return true
  const auth = req.headers.get('authorization')
  if (auth) {
    const [, token] = auth.split(/\s+/, 2)
    if (token === internalToken) return true
  }
  return false
}

// ─── Handler ────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-shared-token',
      },
    })
  }

  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)
  if (!isAuthorized(req)) return json({ success: false, error: 'Unauthorized' }, 401)

  try {
    const body = await req.json()
    const { action } = body
    const supabase = createClient(supabaseUrl, supabaseKey)

    if (action === 'calculate') {
      // Direct calculation with provided items
      const { items } = body
      if (!items || !Array.isArray(items)) {
        return json({ success: false, error: 'items array is required' }, 400)
      }
      const data = await loadEngineData(supabase)
      const result = runEngine(items, data.rules, data.categories, data.categoryMaps, data.containments)
      return json({ success: true, ...result })
    }

    if (action === 'calculate_order') {
      // Calculate for an existing order and optionally update it
      const { order_id, update } = body
      if (!order_id) return json({ success: false, error: 'order_id is required' }, 400)

      const { data: order, error: orderErr } = await supabase
        .schema('shipping')
        .from('unified_orders')
        .select('id, items, package_weight_grams, package_height_cm, package_width_cm, package_length_cm')
        .eq('id', order_id)
        .single()

      if (orderErr || !order) {
        return json({ success: false, error: `Order not found: ${orderErr?.message ?? 'null'}` }, 404)
      }

      const items = (order.items ?? []) as OrderItem[]
      const data = await loadEngineData(supabase)
      const result = runEngine(items, data.rules, data.categories, data.categoryMaps, data.containments)

      // Optionally update the order with new dimensions
      if (update) {
        const updateData: Record<string, unknown> = {
          package_height_cm: result.dimensions.height_cm,
          package_width_cm: result.dimensions.width_cm,
          package_length_cm: result.dimensions.length_cm,
        }
        if (result.dimensions.weight_grams !== null) {
          updateData.package_weight_grams = result.dimensions.weight_grams
        }

        const { error: updateErr } = await supabase
          .schema('shipping')
          .from('unified_orders')
          .update(updateData)
          .eq('id', order_id)

        if (updateErr) {
          console.error('Failed to update order dimensions:', updateErr)
        }
      }

      return json({
        success: true,
        order_id,
        previous: {
          height_cm: order.package_height_cm,
          width_cm: order.package_width_cm,
          length_cm: order.package_length_cm,
          weight_grams: order.package_weight_grams,
        },
        ...result,
      })
    }

    return json({ success: false, error: `Unknown action: ${action}` }, 400)
  } catch (error) {
    const msg = error instanceof Error ? error.message : JSON.stringify(error)
    console.error('packaging-engine error:', msg)
    return json({ success: false, error: msg }, 500)
  }
})

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
