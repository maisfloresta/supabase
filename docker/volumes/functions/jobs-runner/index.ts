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
        console.log('Jobs Runner - Starting job processing')

        const workerId = `worker_${crypto.randomUUID().slice(0, 8)}`

        // 1. Buscar jobs pendentes (status = 'queued', run_after <= now)
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
            console.log('No pending jobs found')
            return new Response(
                JSON.stringify({
                    success: true,
                    message: 'No pending jobs to process',
                    processed: 0
                }),
                { headers: { 'Content-Type': 'application/json' } }
            )
        }

        console.log(`Found ${pendingJobs.length} pending jobs`)

        const results = []

        // 2. Processar cada job
        for (const job of pendingJobs) {
            try {
                // Travar job (marcar como processing + locked_by)
                const { error: lockError } = await supabase
                    .from('jobs')
                    .update({
                        status: 'processing',
                        locked_at: new Date().toISOString(),
                        locked_by: workerId,
                        attempts: job.attempts + 1
                    })
                    .eq('id', job.id)
                    .eq('status', 'queued')

                if (lockError) {
                    console.log(`Job ${job.id} already locked by another worker`)
                    continue
                }

                const event = job.integration_events
                if (!event) {
                    throw new Error('Event not found for job')
                }

                const payload = event.payload

                // 3. Normalizar dados para core.*
                let normalized
                if (event.source === 'yampi') {
                    normalized = await normalizeYampiData(payload)
                } else if (event.source === 'cartpanda') {
                    normalized = await normalizeCartPandaData(payload)
                } else {
                    throw new Error(`Unknown source: ${event.source}`)
                }

                // 4. Marcar job como done
                await supabase
                    .from('jobs')
                    .update({
                        status: 'done',
                        locked_at: null,
                        locked_by: null
                    })
                    .eq('id', job.id)

                // 5. Marcar evento como processed
                await supabase
                    .from('integration_events')
                    .update({
                        status: 'processed',
                        processed_at: new Date().toISOString()
                    })
                    .eq('id', event.id)

                results.push({ job_id: job.id, status: 'done', normalized })
                console.log(`Job ${job.id} completed successfully`)

            } catch (error) {
                console.error(`Error processing job ${job.id}:`, error)

                const newStatus = job.attempts + 1 >= job.max_attempts ? 'dead' : 'failed'
                const backoffMinutes = Math.pow(2, job.attempts)
                const runAfter = new Date(Date.now() + backoffMinutes * 60 * 1000)

                await supabase
                    .from('jobs')
                    .update({
                        status: newStatus,
                        last_error: error.message,
                        locked_at: null,
                        locked_by: null,
                        run_after: newStatus === 'failed' ? runAfter.toISOString() : undefined
                    })
                    .eq('id', job.id)

                if (newStatus === 'dead') {
                    await supabase
                        .from('integration_events')
                        .update({
                            status: 'failed',
                            error: error.message
                        })
                        .eq('id', job.event_id)
                }

                results.push({ job_id: job.id, status: newStatus, error: error.message })
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                message: 'Job processing completed',
                worker_id: workerId,
                processed: results.length,
                results
            }),
            { headers: { 'Content-Type': 'application/json' } }
        )

    } catch (error) {
        console.error('Error in jobs-runner:', error)
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

// Funções de normalização - TODO: implementar
async function normalizeYampiData(payload: any) {
    console.log('Normalizing Yampi data:', payload)
    return { normalized: true, source: 'yampi' }
}

async function normalizeCartPandaData(payload: any) {
    console.log('Normalizing CartPanda data:', payload)
    return { normalized: true, source: 'cartpanda' }
}
