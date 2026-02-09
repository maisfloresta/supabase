import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Cliente com schema integrations
const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: 'integrations' }
})

type JsonObject = Record<string, unknown>

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

        const payload = await req.json() as JsonObject
        const headers = Object.fromEntries(req.headers.entries())

        console.log('CartPanda Webhook - Received:', payload)

        // Extrai campos indexados de forma segura (sem gravar objetos gigantes em colunas text indexadas)
        const externalEntityId = pickExternalEntityId(payload)
        const eventType = pickEventType(payload)
        const externalEntityType = pickExternalEntityType(payload)
        const dedupeKey = `cartpanda_${eventType}_${externalEntityId}`

        // 1. Criar registro em integrations.integration_events
        const { data: event, error: eventError } = await supabase
            .from('integration_events')
            .insert({
                source: 'cartpanda',
                event_type: eventType,
                external_entity_type: externalEntityType,
                external_entity_id: externalEntityId,
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
