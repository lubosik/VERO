import axios from 'axios'
import { config } from '../config.js'

const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-1b-v2'
const EMBEDDING_DIMENSIONS = 1024

const client = axios.create({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000
})

function getHeaders() {
  if (!config.NVIDIA_API_KEY) {
    throw new Error('Missing NVIDIA_API_KEY for embeddings')
  }

  return {
    Authorization: `Bearer ${config.NVIDIA_API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
}

export function toVectorLiteral(values) {
  return `[${values.join(',')}]`
}

export async function embedTexts(texts, inputType = 'passage') {
  if (!texts.length) return []

  const { data } = await client.post(
    '/embeddings',
    {
      model: EMBEDDING_MODEL,
      input: texts,
      input_type: inputType,
      encoding_format: 'float',
      dimensions: EMBEDDING_DIMENSIONS
    },
    {
      headers: getHeaders()
    }
  )

  const embeddings = (data?.data || [])
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding)

  if (embeddings.length !== texts.length) {
    throw new Error('Embedding response size mismatch')
  }

  return embeddings
}

export async function embedQuery(text) {
  const [embedding] = await embedTexts([text], 'query')
  return embedding
}

export { EMBEDDING_DIMENSIONS }
