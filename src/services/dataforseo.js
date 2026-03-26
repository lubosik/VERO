import axios from 'axios'
import { config } from '../config.js'

const client = axios.create({
  baseURL: 'https://api.dataforseo.com/v3',
  headers: {
    Authorization: `Basic ${config.DATAFORSEO_AUTH}`,
    'Content-Type': 'application/json'
  },
  timeout: 20000
})

export async function fetchKeywordIdeas(keywords, locationCode = 2840, languageCode = 'en') {
  const { data } = await client.post('/dataforseo_labs/google/keyword_ideas/live', [
    {
      keywords,
      location_code: locationCode,
      language_code: languageCode,
      include_seed_keyword: true,
      limit: 50
    }
  ])

  return data.tasks?.[0]?.result?.[0]?.items || []
}
