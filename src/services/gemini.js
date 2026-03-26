import { GoogleGenerativeAI } from '@google/generative-ai'
import { config } from '../config.js'

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY)

function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-1.5-pro',
    tools: [{ googleSearch: {} }]
  })
}

export async function generateText(prompt, options = {}) {
  const model = getModel()
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      topP: options.topP ?? 0.9,
      maxOutputTokens: options.maxOutputTokens ?? 2048
    }
  })

  return result.response.text().trim()
}

export async function generateJson(prompt) {
  const text = await generateText(prompt, { temperature: 0.2, maxOutputTokens: 512 })
  const clean = text.replace(/^```json\s*/, '').replace(/```$/, '').trim()
  return JSON.parse(clean)
}
