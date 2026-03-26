import axios from 'axios'
import { config } from '../config.js'

const client = axios.create({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000
})

function getHeaders() {
  if (!config.NVIDIA_API_KEY) {
    throw new Error('Missing NVIDIA_API_KEY for Kimi generation')
  }

  return {
    Authorization: `Bearer ${config.NVIDIA_API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
}

export async function generateText(prompt, options = {}) {
  const { data } = await client.post(
    '/chat/completions',
    {
      model: 'moonshotai/kimi-k2.5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxOutputTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      stream: false
    },
    {
      headers: getHeaders()
    }
  )

  const text = data?.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('Kimi returned an empty response')
  return text
}

export async function generateJson(prompt) {
  const text = await generateText(prompt, { temperature: 0.2, maxOutputTokens: 512 })
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  return JSON.parse(clean)
}
