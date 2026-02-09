import { serve } from 'jsr:@std/http/server'

serve(async (req) => {
    return new Response(
        JSON.stringify({ message: 'Jobs runner function' }),
        { headers: { 'Content-Type': 'application/json' } }
    )
})

console.log('Serving jobs-runner function')
