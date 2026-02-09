import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: 'integrations' },
})

type JsonObject = Record<string, unknown>

interface IntegrationEventRow {
  id: number
  source: string
  event_type: string
  external_entity_id: string | null
  payload: unknown
}

serve(async () => {
  try {
    console.log('Jobs Runner - Starting job processing')

    const workerId = `worker_${crypto.randomUUID().slice(0, 8)}`

    const { data: pendingJobs, error: fetchError } = await supabase
      .from('jobs')
      .select(`
        *,
        integration_events (*)
      `)
      .eq('status', 'queued')
      .lte('run_after', new Date().toISOString())
      .order('priority', { ascending: true })
      .order('id', { ascending: true })
      .limit(10)

    if (fetchError) {
      console.error('Error fetching pending jobs:', fetchError)
      throw fetchError
    }

    if (!pendingJobs || pendingJobs.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No pending jobs to process',
          processed: 0,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    const results = []

    for (const job of pendingJobs) {
      try {
        const { data: lockedJob, error: lockError } = await supabase
          .from('jobs')
          .update({
            status: 'processing',
            locked_at: new Date().toISOString(),
            locked_by: workerId,
            attempts: job.attempts + 1,
          })
          .eq('id', job.id)
          .eq('status', 'queued')
          .select('id')
          .maybeSingle()

        if (lockError) throw lockError
        if (!lockedJob) continue

        const event = normalizeIntegrationEvent(job.integration_events)
        if (!event) throw new Error('Event not found for job')

        let normalized
        if (event.source === 'yampi') {
          normalized = await processYampiEvent(event)
        } else if (event.source === 'cartpanda') {
          normalized = await processCartPandaEvent(event)
        } else {
          throw new Error(`Unknown source: ${event.source}`)
        }

        await supabase
          .from('jobs')
          .update({
            status: 'done',
            locked_at: null,
            locked_by: null,
            last_error: null,
          })
          .eq('id', job.id)

        await supabase
          .from('integration_events')
          .update({
            status: 'processed',
            processed_at: new Date().toISOString(),
            error: null,
          })
          .eq('id', event.id)

        results.push({ job_id: job.id, status: 'done', normalized })
      } catch (error) {
        const newStatus = job.attempts + 1 >= job.max_attempts ? 'dead' : 'failed'
        const backoffMinutes = Math.pow(2, job.attempts)
        const runAfter = new Date(Date.now() + backoffMinutes * 60 * 1000)
        const errorMessage = getErrorMessage(error)

        await supabase
          .from('jobs')
          .update({
            status: newStatus,
            last_error: errorMessage,
            locked_at: null,
            locked_by: null,
            run_after: newStatus === 'failed' ? runAfter.toISOString() : undefined,
          })
          .eq('id', job.id)

        if (newStatus === 'dead') {
          await supabase
            .from('integration_events')
            .update({
              status: 'failed',
              error: errorMessage,
            })
            .eq('id', job.event_id)
        }

        results.push({ job_id: job.id, status: newStatus, error: errorMessage })
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Job processing completed',
        worker_id: workerId,
        processed: results.length,
        results,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: getErrorMessage(error),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})

async function processYampiEvent(event: IntegrationEventRow) {
  const payload = asObject(event.payload)
  if (!payload) throw new Error('Invalid payload format')

  const resource = asObject(payload.resource) ?? asObject(payload.order) ?? payload

  const merchantId = toInt(
    firstString([
      resource?.merchant_id,
      getPath(payload, ['merchant', 'id']),
      getPath(resource, ['merchant', 'id']),
    ])
  )

  const yampiOrderId = toInt(
    firstString([resource?.id, resource?.order_id, payload.id, payload.order_id, event.external_entity_id])
  )

  if (!merchantId) throw new Error('Missing merchant_id in Yampi payload')
  if (!yampiOrderId) throw new Error('Missing order_id in Yampi payload')

  const yampi = supabase.schema('yampi')

  const customerRefId = await upsertYampiCustomer(yampi, merchantId, resource)

  const firstTx = firstArrayObject(getPath(resource, ['transactions', 'data']))
  const firstTxPayment = asObject(getPath(firstTx, ['payment', 'data']))
  const firstPayment = firstArrayObject(resource.payments)

  const orderPayload = {
    integration_event_id: event.id,
    merchant_id: merchantId,
    yampi_order_id: yampiOrderId,
    order_number: toInt(firstString([resource.number, resource.order_number])),
    yampi_customer_ref_id: customerRefId,
    event_name: firstString([payload.event, event.event_type]) ?? event.event_type,
    event_time: parseDate(payload.time),
    status_alias: firstString([getPath(resource, ['status', 'data', 'alias']), firstTx?.status]),
    status_name: firstString([getPath(resource, ['status', 'data', 'name'])]),
    payment_alias: firstString([firstPayment?.alias, firstTxPayment?.alias]),
    payment_status: firstString([firstTx?.status, getPath(resource, ['status', 'data', 'alias'])]),
    shipment_service: firstString([resource.shipment_service]),
    shipment_service_id: firstString([resource.shipment_service_id]),
    track_code: firstString([resource.track_code]),
    track_url: firstString([resource.track_url]),
    currency: normalizeCurrencyCode(firstString([resource.currency, payload.currency])),
    total_cents: moneyToCents(resource.value_total) ?? 0,
    products_cents: moneyToCents(resource.value_products) ?? 0,
    shipping_cents: moneyToCents(resource.value_shipment) ?? 0,
    discount_cents: moneyToCents(resource.value_discount) ?? 0,
    utm_source: firstString([resource.utm_source]),
    utm_campaign: firstString([resource.utm_campaign]),
    utm_medium: firstString([resource.utm_medium]),
    utm_content: firstString([resource.utm_content]),
    utm_term: firstString([resource.utm_term]),
    ip: firstString([resource.ip]),
    device: firstString([resource.device]),
    source_created_at: parseDate(resource.created_at),
    source_updated_at: parseDate(resource.updated_at),
    raw: payload,
  }

  const { data: orderRow, error: upsertOrderError } = await yampi
    .from('orders')
    .upsert(orderPayload, { onConflict: 'merchant_id,yampi_order_id' })
    .select('id')
    .single()

  if (upsertOrderError) throw upsertOrderError

  await upsertYampiAddress(yampi, merchantId, yampiOrderId, 'shipping', getPath(resource, ['shipping_address', 'data']))
  await upsertYampiAddress(yampi, merchantId, yampiOrderId, 'pickup', getPath(resource, ['pickup_address', 'data']))

  await replaceYampiItems(yampi, merchantId, yampiOrderId, asArray(getPath(resource, ['items', 'data'])) ?? [])
  await replaceYampiTransactions(
    yampi,
    merchantId,
    yampiOrderId,
    asArray(getPath(resource, ['transactions', 'data'])) ?? []
  )
  await replaceYampiMetadata(yampi, merchantId, yampiOrderId, asArray(getPath(resource, ['metadata', 'data'])) ?? [])

  return {
    source: 'yampi',
    order_id: yampiOrderId,
    merchant_id: merchantId,
    yampi_order_row_id: orderRow.id,
    customer_ref_id: customerRefId,
  }
}

async function processCartPandaEvent(event: IntegrationEventRow) {
  const payload = asObject(event.payload)
  if (!payload) throw new Error('Invalid payload format')

  const order = asObject(payload.order) ?? payload

  const shopId = toInt(
    firstString([
      order?.shop_id,
      getPath(payload, ['webhook', 'shop_id']),
      getPath(payload, ['shop', 'id']),
      getPath(payload, ['shop_info', 'id']),
    ])
  )

  const cartpandaOrderId = toInt(
    firstString([order?.id, order?.order_id, payload.id, payload.order_id, event.external_entity_id])
  )

  if (!shopId) throw new Error('Missing shop_id in CartPanda payload')
  if (!cartpandaOrderId) throw new Error('Missing order_id in CartPanda payload')

  const cartpanda = supabase.schema('cartpanda')

  const customerRefId = await upsertCartPandaCustomer(cartpanda, shopId, asObject(order.customer))

  const payment = asObject(order.payment)
  const firstTx = firstArrayObject(order.transactions) ?? firstArrayObject(order.all_payments)

  const orderPayload = {
    integration_event_id: event.id,
    shop_id: shopId,
    cartpanda_order_id: cartpandaOrderId,
    order_name: firstString([order.name]),
    order_number: firstString([order.order_number, order.number]),
    customer_ref_id: customerRefId,
    event_name: firstString([payload.event, event.event_type]) ?? event.event_type,
    event_time: parseDate(firstString([payload.time, order.processed_at, order.created_at])),
    order_status: firstString([order.status_id]),
    fulfillment_status: firstString([order.fulfillment_status]),
    payment_status: firstString([order.payment_status, payment?.status_id, payment?.actual_status_id, firstTx?.status]),
    payment_type: firstString([order.payment_type, payment?.type, firstTx?.type]),
    payment_gateway: firstString([order.payment_gateway, payment?.gateway, firstTx?.gateway]),
    currency: normalizeCurrencyCode(firstString([payment?.currency, order.currency, order.presentment_currency])),
    subtotal_cents:
      moneyToCents(order.subtotal_price) ?? moneyToCents(order.subtotal_price_in_decimal) ?? 0,
    products_cents:
      moneyToCents(order.total_line_items_price) ?? moneyToCents(order.total_line_items_price_set) ?? 0,
    shipping_cents:
      moneyToCents(getPath(order, ['orders_shippings', 'price'])) ??
      moneyToCents(getPath(order, ['orders_shippings', 'actual_price_paid'])) ??
      0,
    discount_cents:
      moneyToCents(order.total_discounts) ?? moneyToCents(order.total_discounts_set) ?? 0,
    tax_cents: moneyToCents(order.total_tax) ?? moneyToCents(order.total_tax_set) ?? 0,
    total_cents:
      moneyToCents(order.total_price) ??
      moneyToCents(order.total_price_in_decimal) ??
      moneyToCents(order.total_price_set) ??
      moneyToCents(order.total_price_without_tax) ??
      0,
    installments: toInt(firstString([order.no_of_installments, payment?.no_of_installments])) ?? 1,
    installments_rate: firstString([order.installments_rate, payment?.installments_rate]),
    email: firstString([order.email]),
    phone: firstString([order.phone]),
    browser_ip: firstString([order.browser_ip]),
    source_name: firstString([order.source_name]),
    tracking_number: firstString([order.tracking_number]),
    tracking_numbers: firstString([order.tracking_numbers]),
    pix_code: firstString([order.pix_code, payment?.pix_code]),
    pix_limit_at: parseDate(firstString([order.pix_limit_date, payment?.pix_limit_date])),
    boleto_link: firstString([order.boleto_link, payment?.boleto_link]),
    boleto_limit_at: parseDate(firstString([order.boleto_limit_date, payment?.boleto_limit_date])),
    thank_you_page: firstString([order.thank_you_page]),
    checkout_link: firstString([order.checkout_link, payload.checkout_link]),
    processed_at: parseDate(order.processed_at),
    cancelled_at: parseDate(order.cancelled_at),
    closed_at: parseDate(order.closed_at),
    source_created_at: parseDate(order.created_at),
    source_updated_at: parseDate(order.updated_at),
    raw: payload,
  }

  const { data: orderRow, error: upsertOrderError } = await cartpanda
    .from('orders')
    .upsert(orderPayload, { onConflict: 'shop_id,cartpanda_order_id' })
    .select('id')
    .single()

  if (upsertOrderError) throw upsertOrderError

  await upsertCartPandaAddress(
    cartpanda,
    shopId,
    cartpandaOrderId,
    'shipping',
    asObject(order.address) ?? asObject(order.shipping_address)
  )
  await upsertCartPandaAddress(
    cartpanda,
    shopId,
    cartpandaOrderId,
    'billing',
    asObject(order.billing_address)
  )

  await replaceCartPandaItems(cartpanda, shopId, cartpandaOrderId, asArray(order.line_items) ?? [])
  await replaceCartPandaTransactions(cartpanda, shopId, cartpandaOrderId, order, payment)
  await replaceCartPandaMetadata(cartpanda, shopId, cartpandaOrderId, payload, order)

  return {
    source: 'cartpanda',
    order_id: cartpandaOrderId,
    shop_id: shopId,
    cartpanda_order_row_id: orderRow.id,
    customer_ref_id: customerRefId,
  }
}

async function upsertYampiCustomer(yampi: any, merchantId: number, resource: JsonObject): Promise<number | null> {
  const customer = asObject(getPath(resource, ['customer', 'data']))
  if (!customer) return null

  const yampiCustomerId = toInt(firstString([customer.id]))
  if (!yampiCustomerId) return null

  const phone = asObject(customer.phone)

  const payload = {
    merchant_id: merchantId,
    yampi_customer_id: yampiCustomerId,
    name: firstString([customer.name]),
    first_name: firstString([customer.first_name]),
    last_name: firstString([customer.last_name]),
    email: firstString([customer.email]),
    cpf: firstString([customer.cpf]),
    phone_full_number: firstString([phone?.full_number]),
    phone_area_code: firstString([phone?.area_code]),
    phone_number: firstString([phone?.number]),
    utm_source: firstString([customer.utm_source]),
    utm_campaign: firstString([customer.utm_campaign]),
    ip: firstString([customer.ip]),
    raw: customer,
    last_seen_at: new Date().toISOString(),
  }

  const { data, error } = await yampi
    .from('customers')
    .upsert(payload, { onConflict: 'merchant_id,yampi_customer_id' })
    .select('id')
    .single()

  if (error) throw error

  return typeof data.id === 'number' ? data.id : Number(data.id)
}

async function upsertCartPandaCustomer(
  cartpanda: any,
  shopId: number,
  customer: JsonObject | null
): Promise<number | null> {
  if (!customer) return null

  const cartpandaCustomerId = toInt(firstString([customer.id]))
  if (!cartpandaCustomerId) return null

  const payload = {
    shop_id: shopId,
    cartpanda_customer_id: cartpandaCustomerId,
    first_name: firstString([customer.first_name]),
    last_name: firstString([customer.last_name]),
    full_name: firstString([customer.full_name, customer.name]),
    email: firstString([customer.email]),
    phone: firstString([customer.phone]),
    cpf: firstString([customer.cpf]),
    cnpj: firstString([customer.cnpj]),
    source: firstString([customer.source]),
    raw: customer,
    last_seen_at: new Date().toISOString(),
  }

  const { data, error } = await cartpanda
    .from('customers')
    .upsert(payload, { onConflict: 'shop_id,cartpanda_customer_id' })
    .select('id')
    .single()

  if (error) throw error

  return typeof data.id === 'number' ? data.id : Number(data.id)
}

async function upsertYampiAddress(
  yampi: any,
  merchantId: number,
  yampiOrderId: number,
  addressType: 'shipping' | 'pickup',
  rawAddress: unknown
) {
  const address = asObject(rawAddress)
  if (!address) return

  if (Object.keys(address).length === 0) return

  const payload = {
    merchant_id: merchantId,
    yampi_order_id: yampiOrderId,
    address_type: addressType,
    receiver: firstString([address.receiver]),
    zipcode: firstString([address.zip_code, address.zipcode]),
    street: firstString([address.street]),
    street_number: firstString([address.number]),
    complement: firstString([address.complement]),
    reference: firstString([address.reference]),
    neighborhood: firstString([address.neighborhood]),
    city: firstString([address.city]),
    state: firstString([address.state, address.uf]),
    country: firstString([address.country]),
    full_address: firstString([address.full_address]),
    raw: address,
  }

  const { error } = await yampi
    .from('order_addresses')
    .upsert(payload, { onConflict: 'merchant_id,yampi_order_id,address_type' })

  if (error) throw error
}

async function upsertCartPandaAddress(
  cartpanda: any,
  shopId: number,
  cartpandaOrderId: number,
  addressType: 'shipping' | 'billing',
  rawAddress: JsonObject | null
) {
  if (!rawAddress) return
  if (Object.keys(rawAddress).length === 0) return

  const payload = {
    shop_id: shopId,
    cartpanda_order_id: cartpandaOrderId,
    address_type: addressType,
    name: firstString([rawAddress.name]),
    first_name: firstString([rawAddress.first_name]),
    last_name: firstString([rawAddress.last_name]),
    company: firstString([rawAddress.company]),
    phone: firstString([rawAddress.phone]),
    address1: firstString([rawAddress.address1]),
    address2: firstString([rawAddress.address2]),
    address: firstString([rawAddress.address]),
    house_no: firstString([rawAddress.house_no]),
    compartment: firstString([rawAddress.compartment]),
    neighborhood: firstString([rawAddress.neighborhood]),
    city: firstString([rawAddress.city]),
    province: firstString([rawAddress.province]),
    province_code: firstString([rawAddress.province_code]),
    country: firstString([rawAddress.country]),
    country_code: firstString([rawAddress.country_code]),
    zip: firstString([rawAddress.zip]),
    raw: rawAddress,
  }

  const { error } = await cartpanda
    .from('order_addresses')
    .upsert(payload, { onConflict: 'shop_id,cartpanda_order_id,address_type' })

  if (error) throw error
}

async function replaceYampiItems(yampi: any, merchantId: number, yampiOrderId: number, rawItems: unknown[]) {
  const { error: deleteError } = await yampi
    .from('order_items')
    .delete()
    .eq('merchant_id', merchantId)
    .eq('yampi_order_id', yampiOrderId)

  if (deleteError) throw deleteError

  const itemsPayload = rawItems
    .map((itemRaw) => {
      const item = asObject(itemRaw)
      if (!item) return null

      const yampiItemId = toInt(firstString([item.id]))
      if (!yampiItemId) return null

      const skuData = asObject(getPath(item, ['sku', 'data']))

      return {
        merchant_id: merchantId,
        yampi_order_id: yampiOrderId,
        yampi_item_id: yampiItemId,
        product_id: toInt(firstString([item.product_id])),
        sku_id: toInt(firstString([item.sku_id])),
        item_sku: firstString([item.item_sku]),
        title: firstString([skuData?.title, item.bundle_name, item.item_sku]) ?? 'Item Yampi',
        bundle_id: toInt(firstString([item.bundle_id])),
        bundle_name: firstString([item.bundle_name]),
        quantity: toInt(firstString([item.quantity])) ?? 1,
        unit_price_cents: moneyToCents(item.price) ?? 0,
        shipment_cost_cents: moneyToCents(item.shipment_cost) ?? 0,
        is_digital: toBool(item.is_digital),
        gift: toBool(item.gift),
        raw: item,
      }
    })
    .filter((x) => x !== null)

  if (itemsPayload.length === 0) return

  const { error: insertError } = await yampi.from('order_items').insert(itemsPayload)
  if (insertError) throw insertError
}

async function replaceCartPandaItems(
  cartpanda: any,
  shopId: number,
  cartpandaOrderId: number,
  rawItems: unknown[]
) {
  const { error: deleteError } = await cartpanda
    .from('order_items')
    .delete()
    .eq('shop_id', shopId)
    .eq('cartpanda_order_id', cartpandaOrderId)

  if (deleteError) throw deleteError

  const itemsPayload = rawItems
    .map((itemRaw) => {
      const item = asObject(itemRaw)
      if (!item) return null

      const cartpandaItemId = toInt(firstString([item.id]))
      if (!cartpandaItemId) return null

      return {
        shop_id: shopId,
        cartpanda_order_id: cartpandaOrderId,
        cartpanda_item_id: cartpandaItemId,
        product_id: toInt(firstString([item.product_id])),
        variant_id: toInt(firstString([item.variant_id])),
        sku: firstString([item.sku]),
        title: firstString([item.title]),
        variant_title: firstString([item.variant_title]),
        name: firstString([item.name]),
        quantity: toInt(firstString([item.quantity])) ?? 1,
        unit_price_cents: moneyToCents(item.price) ?? moneyToCents(item.price_in_decimal) ?? 0,
        requires_shipping: toBool(item.requires_shipping),
        is_digital: toBool(item.is_digital),
        status_id: firstString([item.status_id]),
        shipping_method: firstString([item.shipping_method]),
        raw: item,
      }
    })
    .filter((x) => x !== null)

  if (itemsPayload.length === 0) return

  const { error: insertError } = await cartpanda.from('order_items').insert(itemsPayload)
  if (insertError) throw insertError
}

async function replaceYampiTransactions(
  yampi: any,
  merchantId: number,
  yampiOrderId: number,
  rawTransactions: unknown[]
) {
  const { error: deleteError } = await yampi
    .from('order_transactions')
    .delete()
    .eq('merchant_id', merchantId)
    .eq('yampi_order_id', yampiOrderId)

  if (deleteError) throw deleteError

  const txPayload = rawTransactions
    .map((txRaw) => {
      const tx = asObject(txRaw)
      if (!tx) return null

      const yampiTransactionId = toInt(firstString([tx.id]))
      if (!yampiTransactionId) return null

      const payment = asObject(getPath(tx, ['payment', 'data']))
      const metadata = asObject(getPath(tx, ['metadata', 'data']))

      return {
        merchant_id: merchantId,
        yampi_order_id: yampiOrderId,
        yampi_transaction_id: yampiTransactionId,
        payment_alias: firstString([payment?.alias]),
        payment_name: firstString([payment?.name]),
        gateway_transaction_id: firstString([tx.gateway_transaction_id]),
        gateway_order_id: firstString([tx.gateway_order_id]),
        status: firstString([tx.status]),
        amount_cents: moneyToCents(tx.amount),
        installments: toInt(firstString([tx.installments])),
        installment_value_cents: moneyToCents(tx.installment_value),
        pix_qr_code: firstString([metadata?.pix_qr_code]),
        pix_expiration_at: parseDate(metadata?.pix_expiration_date),
        authorized_at: parseDate(tx.authorized_at),
        captured_at: parseDate(tx.captured_at),
        cancelled_at: parseDate(tx.cancelled_at),
        source_created_at: parseDate(tx.created_at),
        source_updated_at: parseDate(tx.updated_at),
        raw: tx,
      }
    })
    .filter((x) => x !== null)

  if (txPayload.length === 0) return

  const { error: insertError } = await yampi.from('order_transactions').insert(txPayload)
  if (insertError) throw insertError
}

async function replaceCartPandaTransactions(
  cartpanda: any,
  shopId: number,
  cartpandaOrderId: number,
  order: JsonObject,
  payment: JsonObject | null
) {
  const { error: deleteError } = await cartpanda
    .from('order_transactions')
    .delete()
    .eq('shop_id', shopId)
    .eq('cartpanda_order_id', cartpandaOrderId)

  if (deleteError) throw deleteError

  const transactions: Array<Record<string, unknown>> = []
  const refs = new Set<string>()

  const addTransaction = (ref: string, raw: JsonObject, fallback: JsonObject = {}) => {
    if (refs.has(ref)) return
    refs.add(ref)

    const payload = {
      shop_id: shopId,
      cartpanda_order_id: cartpandaOrderId,
      transaction_ref: ref,
      gateway: firstString([raw.gateway, fallback.gateway]),
      payment_type: firstString([raw.type, raw.payment_type, fallback.payment_type]),
      authorization_code: firstString([
        raw.authorizationCode,
        raw.authorization_code,
        raw.appmax_payment_id,
        fallback.authorization_code,
      ]),
      payment_id: firstString([
        raw.id,
        raw.gateway_payment_id,
        raw.appmax_payment_id,
        fallback.payment_id,
      ]),
      status: firstString([raw.status, raw.status_id, raw.actual_status_id, fallback.status]),
      amount_cents: moneyToCents(raw.amount) ?? moneyToCents(raw.actual_price_paid) ?? moneyToCents(fallback.amount),
      installments: toInt(firstString([raw.no_of_installments, raw.installments, fallback.installments])),
      installments_rate: firstString([raw.installments_rate, fallback.installments_rate]),
      pix_code: firstString([raw.pix_code, fallback.pix_code]),
      pix_limit_at: parseDate(firstString([raw.pix_limit_date, fallback.pix_limit_date])),
      boleto_link: firstString([raw.boleto_link, fallback.boleto_link]),
      boleto_limit_at: parseDate(firstString([raw.boleto_limit_date, fallback.boleto_limit_date])),
      currency: normalizeCurrencyCode(firstString([raw.currency, fallback.currency, order.currency])),
      raw,
    }

    transactions.push(payload)
  }

  if (payment) {
    const paymentRef =
      firstString([payment.id, payment.appmax_payment_id, payment.gateway_payment_id, order.appmax_payment_token]) ??
      'single'

    addTransaction(`payment:${paymentRef}`, payment, {
      gateway: firstString([order.payment_gateway]),
      payment_type: firstString([order.payment_type]),
      authorization_code: firstString([order.appmax_payment_token]),
      payment_id: firstString([order.appmax_payment_token]),
      status: firstString([order.payment_status]),
      amount: firstString([order.total_price]),
      installments: firstString([order.no_of_installments]),
      installments_rate: firstString([order.installments_rate]),
      pix_code: firstString([order.pix_code]),
      pix_limit_date: firstString([order.pix_limit_date]),
      boleto_link: firstString([order.boleto_link]),
      boleto_limit_date: firstString([order.boleto_limit_date]),
      currency: firstString([order.currency]),
    })
  }

  const orderTransactions = asArray(order.transactions) ?? []
  orderTransactions.forEach((txRaw, index) => {
    const tx = asObject(txRaw)
    if (!tx) return

    const token = firstString([tx.authorizationCode, tx.authorization_code, tx.id, tx.gateway]) ?? `${index + 1}`
    addTransaction(`transactions:${token}`, tx, {
      payment_type: firstString([order.payment_type]),
      status: firstString([order.payment_status]),
      amount: firstString([order.total_price]),
      installments: firstString([order.no_of_installments]),
      installments_rate: firstString([order.installments_rate]),
      pix_code: firstString([order.pix_code]),
      pix_limit_date: firstString([order.pix_limit_date]),
      currency: firstString([order.currency]),
    })
  })

  const allPayments = asArray(order.all_payments) ?? []
  allPayments.forEach((txRaw, index) => {
    const tx = asObject(txRaw)
    if (!tx) return

    const token =
      firstString([tx.authorizationCode, tx.authorization_code, tx.id, tx.gateway]) ?? `${index + 1}`
    addTransaction(`all_payments:${token}`, tx, {
      status: firstString([order.payment_status]),
      amount: firstString([order.total_price]),
      installments: firstString([order.no_of_installments]),
      installments_rate: firstString([order.installments_rate]),
      pix_code: firstString([order.pix_code]),
      pix_limit_date: firstString([order.pix_limit_date]),
      currency: firstString([order.currency]),
    })
  })

  if (transactions.length === 0) return

  const { error: insertError } = await cartpanda.from('order_transactions').insert(transactions)
  if (insertError) throw insertError
}

async function replaceYampiMetadata(yampi: any, merchantId: number, yampiOrderId: number, rawMetadata: unknown[]) {
  const { error: deleteError } = await yampi
    .from('order_metadata')
    .delete()
    .eq('merchant_id', merchantId)
    .eq('yampi_order_id', yampiOrderId)

  if (deleteError) throw deleteError

  const metadataPayload = rawMetadata
    .map((metaRaw) => {
      const meta = asObject(metaRaw)
      if (!meta) return null

      const metaKey = firstString([meta.key])
      if (!metaKey) return null

      return {
        merchant_id: merchantId,
        yampi_order_id: yampiOrderId,
        meta_key: metaKey,
        meta_value: firstString([meta.value]),
        raw: meta,
      }
    })
    .filter((x) => x !== null)

  if (metadataPayload.length === 0) return

  const { error: insertError } = await yampi.from('order_metadata').insert(metadataPayload)
  if (insertError) throw insertError
}

async function replaceCartPandaMetadata(
  cartpanda: any,
  shopId: number,
  cartpandaOrderId: number,
  payload: JsonObject,
  order: JsonObject
) {
  const { error: deleteError } = await cartpanda
    .from('order_metadata')
    .delete()
    .eq('shop_id', shopId)
    .eq('cartpanda_order_id', cartpandaOrderId)

  if (deleteError) throw deleteError

  const metadata: Array<Record<string, unknown>> = []

  const pushMeta = (key: string, value: unknown, raw: unknown = value) => {
    const valueText = firstString([value])
    if (!valueText) return

    metadata.push({
      shop_id: shopId,
      cartpanda_order_id: cartpandaOrderId,
      meta_key: key,
      meta_value: valueText,
      raw: raw as JsonObject,
    })
  }

  pushMeta('card_token', order.card_token)
  pushMeta('customer_token', order.customer_token)
  pushMeta('appmax_payment_token', order.appmax_payment_token)
  pushMeta('order_status_url', order.order_status_url)
  pushMeta('thank_you_page', order.thank_you_page)
  pushMeta('checkout_link', firstString([order.checkout_link, payload.checkout_link]))

  const webhook = asObject(payload.webhook)
  if (webhook) {
    pushMeta('webhook_id', webhook.id)
    pushMeta('webhook_endpoint', webhook.endpoint)
    pushMeta('webhook_apply_for', webhook.apply_for)
  }

  const checkoutParams = asObject(order.checkout_params)
  if (checkoutParams) {
    Object.entries(checkoutParams).forEach(([k, v]) => {
      pushMeta(`checkout_param_${k}`, v, { [k]: v })
    })
  }

  const trackingParameters = asArray(order.tracking_parameters) ?? []
  trackingParameters.forEach((item, idx) => {
    const row = asObject(item)
    if (!row) return

    Object.entries(row).forEach(([k, v]) => {
      pushMeta(`tracking_${idx + 1}_${k}`, v, { [k]: v })
    })
  })

  if (metadata.length === 0) return

  const { error: insertError } = await cartpanda.from('order_metadata').insert(metadata)
  if (insertError) throw insertError
}

function normalizeIntegrationEvent(value: unknown): IntegrationEventRow | null {
  if (!value) return null

  const event = Array.isArray(value) ? value[0] : value
  const obj = asObject(event)
  if (!obj) return null

  const id = toInt(firstString([obj.id]))
  const source = firstString([obj.source])
  const eventType = firstString([obj.event_type])

  if (!id || !source || !eventType) return null

  return {
    id,
    source,
    event_type: eventType,
    external_entity_id: firstString([obj.external_entity_id]),
    payload: obj.payload,
  }
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined) continue

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
      continue
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      const casted = String(value).trim()
      if (casted) return casted
    }
  }

  return null
}

function toInt(value: string | null): number | null {
  if (!value) return null
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return null
  return n
}

function toBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0

  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y'].includes(lower)) return true
    if (['0', 'false', 'no', 'n'].includes(lower)) return false
  }

  return null
}

function moneyToCents(value: unknown): number | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && Math.abs(value) >= 1000) return Math.round(value)
    return Math.round(value * 100)
  }

  const text = firstString([value])
  if (!text) return null

  const cleaned = text.replace(/[^0-9,.-]/g, '')
  if (!cleaned) return null

  let normalized = cleaned
  if (cleaned.includes(',')) normalized = cleaned.replace(/\./g, '').replace(',', '.')

  const n = Number(normalized)
  if (!Number.isFinite(n)) return null

  if (/^-?\d+$/.test(cleaned) && Math.abs(n) >= 1000) return Math.round(n)

  return Math.round(n * 100)
}

function normalizeCurrencyCode(value: string | null): string {
  if (!value) return 'BRL'

  const cleaned = value.trim().toUpperCase()
  if (!cleaned) return 'BRL'

  if (cleaned === 'R$' || cleaned.includes('REAL')) return 'BRL'
  if (/^[A-Z]{3}$/.test(cleaned)) return cleaned

  return 'BRL'
}

function parseDate(value: unknown): string | null {
  const obj = asObject(value)
  if (obj) {
    const fromDateField = firstString([obj.date])
    if (fromDateField) return parseDate(fromDateField)
  }

  const text = firstString([value])
  if (!text) return null

  const normalized = text.includes(' ') && !text.includes('T') ? text.replace(' ', 'T') : text
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonObject
  }
  return null
}

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  return null
}

function firstArrayObject(value: unknown): JsonObject | null {
  const arr = asArray(value)
  if (!arr || arr.length === 0) return null
  return asObject(arr[0])
}

function getPath(obj: unknown, path: string[]): unknown {
  let current: unknown = obj

  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null
    current = (current as JsonObject)[key]
  }

  return current
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message

  const fromObject = firstString([(error as { message?: unknown })?.message])
  if (fromObject) return fromObject

  return 'unknown error'
}
