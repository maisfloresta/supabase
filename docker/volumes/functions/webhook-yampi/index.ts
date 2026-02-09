import { serve } from 'https://deno.land/std@0.177.1/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Cliente com schema integrations
const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: 'integrations' }
})

serve(async (req) => {
    try {
        const { method } = req

        if (method !== 'POST') {
            return new Response(
                JSON.stringify({ message: 'Yampi Webhook Receiver - Use POST' }),
                { headers: { 'Content-Type': 'application/json' }, status: 405 }
            )
        }

        const payload = await req.json()
        const headers = Object.fromEntries(req.headers.entries())

        console.log('Yampi Webhook - Received:', payload)

        // Gerar dedupe_key único
        const externalEntityId = payload.id || payload.order_id || crypto.randomUUID()
        const eventType = payload.event || 'unknown'
        const dedupeKey = `yampi_${eventType}_${externalEntityId}`

        // 1. Criar registro em integrations.integration_events
        const { data: event, error: eventError } = await supabase
            .from('integration_events')
            .insert({
                source: 'yampi',
                event_type: eventType,
                external_entity_type: payload.resource || 'order',
                external_entity_id: String(externalEntityId),
                dedupe_key: dedupeKey,
                status: 'received',
                headers: headers,
                payload: payload
            })
            .select()
            .single()

        if (eventError) {
            // Se for erro de duplicação, retorna sucesso (idempotência)
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
        const jobDedupeKey = `job_yampi_${eventType}_${externalEntityId}`
        const { data: job, error: jobError } = await supabase
            .from('jobs')
            .insert({
                job_type: `process_yampi_${eventType}`,
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

        console.log(`Yampi webhook enqueued - Event ID: ${event.id}, Job ID: ${job?.id}`)

        return new Response(
            JSON.stringify({
                success: true,
                message: 'Yampi webhook received and enqueued',
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
        console.error('Error in webhook-yampi:', error)
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
