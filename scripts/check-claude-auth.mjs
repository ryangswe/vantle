// Makes one tiny Claude request with whatever credentials the environment
// provides. In CI that's workload identity federation; no API key is involved.
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
let response
try {
  response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  })
} catch (error) {
  // Also print as a GitHub annotation, which shows on the run summary page.
  const detail = error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error)
  console.log(`::error title=Claude request failed::${detail.replace(/\r?\n/g, ' ')}`)
  process.exit(1)
}

if (response.stop_reason === 'refusal') {
  console.error('Request was declined:', response.stop_details)
  process.exit(1)
}
const text = response.content.find((b) => b.type === 'text')?.text ?? ''
console.log(`Claude replied "${text.trim()}" (${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens).`)
