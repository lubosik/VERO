import axios from 'axios'
import { config } from '../config.js'

const client = axios.create({
  baseURL: 'https://ai.api.nvidia.com/v1',
  timeout: 60000
})

function getHeaders() {
  if (!config.NVIDIA_API_KEY) {
    throw new Error('Missing NVIDIA_API_KEY for reranking')
  }

  return {
    Authorization: `Bearer ${config.NVIDIA_API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
}

export async function rerankPassages(query, passages) {
  if (!passages?.length) return []

  const { data } = await client.post(
    '/retrieval/nvidia/llama-nemotron-rerank-1b-v2/reranking',
    {
      query,
      passages: passages.map((content) => ({ text: content }))
    },
    {
      headers: getHeaders()
    }
  )

  const rankings = data?.rankings || data?.data || []
  return rankings.map((item) => ({
    index: item.index ?? item.passage_index ?? 0,
    score: item.logit ?? item.score ?? 0
  }))
}
