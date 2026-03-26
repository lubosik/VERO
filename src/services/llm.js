import OpenAI from 'openai'
import { config } from '../config.js'

const SEARCH_PREFIX =
  "You have broad knowledge up to early 2026. If the user's prompt requires current data you are uncertain about, clearly note that in your response and answer based on best available knowledge."

const client = new OpenAI({
  apiKey: config.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 120000
})

function stripReasoning(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content.trim()
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n')
      .trim()
  }
  return ''
}

async function requestCompletion(prompt, options = {}) {
  if (!config.NVIDIA_API_KEY) {
    throw new Error('Missing NVIDIA_API_KEY')
  }

  const response = await client.chat.completions.create({
    model: 'moonshotai/kimi-k2.5',
    messages: [
      ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
      { role: 'user', content: prompt }
    ],
    temperature: options.temperature ?? 0.6,
    top_p: options.topP ?? 1,
    max_tokens: options.maxTokens ?? 1024,
    ...(options.thinking ? { thinking: { type: 'enabled' } } : {})
  })

  return stripReasoning(response.choices?.[0]?.message)
}

export async function generate(prompt, options = {}) {
  return requestCompletion(prompt, {
    temperature: options.temperature ?? 0.6,
    topP: options.topP ?? 1,
    maxTokens: options.maxOutputTokens ?? 1024,
    thinking: Boolean(options.thinking)
  })
}

export async function generateWithSearch(prompt, options = {}) {
  return requestCompletion(prompt, {
    systemPrompt: SEARCH_PREFIX,
    temperature: options.temperature ?? 0.6,
    topP: options.topP ?? 1,
    maxTokens: options.maxOutputTokens ?? 1024,
    thinking: Boolean(options.thinking)
  })
}

export async function checkNaturalness(commentText, platform = 'youtube') {
  const prompt = `Does this ${platform} comment sound genuinely helpful and human, or does it read like promotional/AI copy?\nComment: "${commentText}"\nRespond ONLY with JSON: {"score": <1-10>, "reason": "<brief>"}` 
  const text = await generate(prompt, { temperature: 0.6, maxOutputTokens: 1024 })
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  return JSON.parse(clean)
}

export async function generateText(prompt, options = {}) {
  return generate(prompt, options)
}

export async function generateJson(prompt) {
  const text = await generate(prompt, { temperature: 0.6, maxOutputTokens: 1024 })
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  return JSON.parse(clean)
}
