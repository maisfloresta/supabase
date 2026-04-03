import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const jobsRunnerUrl = `${supabaseUrl}/functions/v1/jobs-runner`
const internalWebhookToken = Deno.env.get('WEBHOOK_SHARED_TOKEN') ?? ''
const providerWebhookToken = Deno.env.get('CARTPANDA_WEBHOOK_SECRET') ?? ''

// Cliente com schema integrations
const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: 'integrations' }
})

type JsonObject = Record<string, unknown>

function parseBearerToken(headerValue: string | null): string | null {
    if (!headerValue) return null
    const [scheme, token] = headerValue.trim().split(/\s+/, 2)
    if (!scheme || !token) return null
    if (scheme.toLowerCase() !== 'bearer') return null
    return token
}

function getRequestWebhookToken(req: Request): string | null {
    const url = new URL(req.url)
    const queryToken =
        url.searchParams.get('token') ??
        url.searchParams.get('webhook_token') ??
        url.searchParams.get('secret')
    if (queryToken) return queryToken

    const directToken = req.headers.get('x-webhook-shared-token')
    if (directToken) return directToken

    return parseBearerToken(req.headers.get('authorization'))
}

function isAuthorizedRequest(req: Request): boolean {
    const validTokens = [providerWebhookToken, internalWebhookToken]
        .map((token) => token.trim())
        .filter((token) => token.length > 0)

    if (validTokens.length === 0) {
        console.error('Missing webhook token configuration (CARTPANDA_WEBHOOK_SECRET or WEBHOOK_SHARED_TOKEN)')
        return false
    }

    const requestToken = getRequestWebhookToken(req)
    if (!requestToken) return false

    return validTokens.includes(requestToken)
}

function toScalarString(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value)
    }
    return null
}

function clamp(value: string, max: number): string {
    return value.trim().slice(0, max)
}

function getNestedObject(value: unknown): JsonObject | null {
    if (typeof value === 'object' && value !== null) {
        return value as JsonObject
    }
    return null
}

async function triggerJobsRunner(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)

    try {
        const response = await fetch(jobsRunnerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                'x-webhook-shared-token': internalWebhookToken
            },
            body: '{}',
            signal: controller.signal
        })

        if (!response.ok) {
            const body = await response.text()
            console.warn('jobs-runner trigger failed:', response.status, body)
        }
    } catch (error) {
        console.warn('jobs-runner trigger error:', error)
    } finally {
        clearTimeout(timeout)
    }
}

async function resolveStoreId(source: 'yampi' | 'cartpanda', externalStoreId: string | null): Promise<string | null> {
    if (!externalStoreId) return null

    const { data, error } = await supabase
        .from('store_external_links')
        .select('store_id')
        .eq('source', source)
        .eq('external_store_id', externalStoreId)
        .maybeSingle()

    if (error) {
        console.warn('Error resolving store mapping:', error)
        return null
    }

    return toScalarString(data?.store_id)
}

function pickSourceStoreId(payload: JsonObject): string | null {
    const order = getNestedObject(payload.order)
    const webhook = getNestedObject(payload.webhook)
    const shop = getNestedObject(payload.shop)
    const shopInfo = getNestedObject(payload.shop_info)

    const candidate =
        toScalarString(payload.shop_id) ??
        (order ? toScalarString(order.shop_id) : null) ??
        (webhook ? toScalarString(webhook.shop_id) : null) ??
        (shop ? toScalarString(shop.id) : null) ??
        (shopInfo ? toScalarString(shopInfo.id) : null)

    return candidate ? clamp(candidate, 120) : null
}

function pickEventType(payload: JsonObject): string {
    const eventType =
        toScalarString(payload.event) ??
        toScalarString(payload.topic) ??
        toScalarString(payload.type) ??
        'unknown'
    return clamp(eventType, 120)
}

function pickExternalEntityType(payload: JsonObject): string {
    const resource = getNestedObject(payload.resource)
    const candidate =
        toScalarString(payload.resource) ??
        toScalarString(payload.resource_type) ??
        (resource ? toScalarString(resource.type) ?? toScalarString(resource.alias) : null) ??
        'order'
    return clamp(candidate, 80)
}

function pickExternalEntityId(payload: JsonObject): string {
    const resource = getNestedObject(payload.resource)
    const order = getNestedObject(payload.order)
    const candidate =
        toScalarString(payload.id) ??
        toScalarString(payload.order_id) ??
        toScalarString(payload.resource_id) ??
        (resource
            ? toScalarString(resource.id) ??
              toScalarString(resource.order_id) ??
              toScalarString(resource.number)
            : null) ??
        (order
            ? toScalarString(order.id) ??
              toScalarString(order.order_id) ??
              toScalarString(order.number)
            : null) ??
        crypto.randomUUID()

    return clamp(candidate, 255)
}

serve(async (req) => {
    try {
        const { method } = req

        if (method !== 'POST') {
            return new Response(
                JSON.stringify({ message: 'CartPanda Webhook Receiver - Use POST' }),
                { headers: { 'Content-Type': 'application/json' }, status: 405 }
            )
        }

        if (!isAuthorizedRequest(req)) {
            return new Response(
                JSON.stringify({ success: false, error: 'Unauthorized' }),
                { headers: { 'Content-Type': 'application/json' }, status: 401 }
            )
        }

        const payload = await req.json() as JsonObject
        const headers = Object.fromEntries(req.headers.entries())

        // Extrai campos indexados de forma segura (sem gravar objetos gigantes em colunas text indexadas)
        const externalEntityId = pickExternalEntityId(payload)
        const eventType = pickEventType(payload)
        const externalEntityType = pickExternalEntityType(payload)
        const sourceStoreId = pickSourceStoreId(payload)
        const storeId = await resolveStoreId('cartpanda', sourceStoreId)
        const dedupeKey = `cartpanda_${eventType}_${externalEntityId}`

        console.log(`CartPanda Webhook - Received event=${eventType} entity=${externalEntityType} id=${externalEntityId}`)

        // 1. Criar registro em integrations.integration_events
        const { data: event, error: eventError } = await supabase
            .from('integration_events')
            .insert({
                source: 'cartpanda',
                event_type: eventType,
                external_entity_type: externalEntityType,
                external_entity_id: externalEntityId,
                store_id: storeId,
                dedupe_key: dedupeKey,
                status: 'received',
                headers: headers,
                payload: payload
            })
            .select()
            .single()

        if (eventError) {
            if (eventError.code === '23505') {
                console.log('Duplicate event ignored:', dedupeKey)
                return new Response(
                    JSON.stringify({
                        success: true,
                        message: 'Event already processed (duplicate)',
                        dedupe_key: dedupeKey
                    }),
                    { headers: { 'Content-Type': 'application/json' }, status: 200 }
                )
            }
            console.error('Error creating integration_event:', eventError)
            throw eventError
        }

        // 2. Criar job em integrations.jobs para processamento
        const jobDedupeKey = `job_cartpanda_${eventType}_${externalEntityId}`
        const { data: job, error: jobError } = await supabase
            .from('jobs')
            .insert({
                job_type: `process_cartpanda_${eventType}`,
                event_id: event.id,
                dedupe_key: jobDedupeKey,
                status: 'queued',
                priority: 100
            })
            .select()
            .single()

        if (jobError) {
            if (jobError.code === '23505') {
                console.log('Duplicate job ignored:', jobDedupeKey)
            } else {
                console.error('Error creating job:', jobError)
                throw jobError
            }
        }

        // Dispara processamento imediato (best-effort) para não depender de cron externo.
        await triggerJobsRunner()

        console.log(`CartPanda webhook enqueued - Event ID: ${event.id}, Job ID: ${job?.id}`)

        return new Response(
            JSON.stringify({
                success: true,
                message: 'CartPanda webhook received and enqueued',
                event_id: event.id,
                job_id: job?.id,
                dedupe_key: dedupeKey
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: 200
            }
        )
    } catch (error) {
        console.error('Error in webhook-cartpanda:', error)
        return new Response(
            JSON.stringify({
                success: false,
                error: error.message
            }),
            {
                headers: { 'Content-Type': 'application/json' },
                status: 500
            }
        )
    }
})
