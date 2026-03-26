import OpenAI from 'openai'
import { config } from '../config.js'

const client = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: 120000
})

function cleanText(text = '') {
  return String(text || '').trim()
}

export async function generate(prompt, options = {}) {
  const response = await client.responses.create({
    model: 'gpt-5.4-nano',
    input: [{ role: 'user', content: prompt }],
    instructions: options.instructions,
    max_output_tokens: options.maxTokens ?? options.maxOutputTokens ?? 1024
  })

  return cleanText(response.output_text)
}

export async function generateWithSearch(prompt, options = {}) {
  const response = await client.responses.create({
    model: 'gpt-5.4-nano',
    input: [{ role: 'user', content: prompt }],
    instructions: options.instructions,
    tools: [{ type: 'web_search' }],
    max_output_tokens: options.maxTokens ?? options.maxOutputTokens ?? 4096
  })

  return cleanText(response.output_text)
}

export async function checkNaturalness(commentText, platform) {
  try {
    const text = await generate(
      `Does this ${platform} comment sound like a genuine human or AI marketing copy? Score 1-10. Respond ONLY with valid JSON: {"score": <number>, "reason": "<brief>"}\n\nComment:\n${commentText}`,
      { maxTokens: 1024 }
    )
    const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
    return JSON.parse(clean)
  } catch {
    return { score: 5, reason: 'parse error' }
  }
}

export async function generateText(prompt, options = {}) {
  return generate(prompt, options)
}

export async function generateJson(prompt, options = {}) {
  const text = await generate(prompt, options)
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  return JSON.parse(clean)
}
