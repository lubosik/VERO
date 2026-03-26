import axios from 'axios'
import * as cheerio from 'cheerio'
import pdfParse from 'pdf-parse'
import { supabase } from '../db/supabase.js'
import { logger } from '../utils/logger.js'

let cachedKB = null
let lastLoaded = null

export async function loadKnowledgeBase(forceRefresh = false) {
  const cacheFresh = cachedKB && lastLoaded && Date.now() - lastLoaded < 1000 * 60 * 10
  if (!forceRefresh && cacheFresh) return cachedKB

  const { data: docs, error } = await supabase
    .from('knowledge_docs')
    .select('name, source_type, raw_content')
    .eq('active', true)
    .order('uploaded_at', { ascending: false })

  if (error) {
    if (String(error.message || '').includes('knowledge_docs')) {
      cachedKB = 'No knowledge base documents loaded yet.'
      lastLoaded = Date.now()
      logger.warn('knowledge_docs table missing; using empty KB placeholder until schema is applied')
      return cachedKB
    }
    throw error
  }

  if (!docs?.length) {
    cachedKB = 'No knowledge base documents loaded yet.'
    lastLoaded = Date.now()
    return cachedKB
  }

  cachedKB = docs.map((doc) => `=== ${doc.name.toUpperCase()} ===\n${doc.raw_content}`).join('\n\n---\n\n')
  lastLoaded = Date.now()
  logger.info(`KB loaded: ${docs.length} docs`)
  return cachedKB
}

export async function ingestDocument({ name, sourceType, sourceUrl, buffer }) {
  let rawContent = ''

  if (sourceType === 'pdf' && buffer) {
    const parsed = await pdfParse(buffer)
    rawContent = parsed.text
  } else if (sourceType === 'txt' && buffer) {
    rawContent = buffer.toString('utf-8')
  } else if (sourceType === 'url' && sourceUrl) {
    const { data: html } = await axios.get(sourceUrl, {
      headers: { 'User-Agent': 'VERO-KB/1.0' },
      timeout: 10000
    })
    const $ = cheerio.load(html)
    $('script, style, nav, footer, header').remove()
    rawContent = $('body').text().replace(/\s+/g, ' ').trim()
  } else if (sourceType === 'paste' && buffer) {
    rawContent = buffer.toString('utf-8')
  }

  if (!rawContent || rawContent.length < 50) {
    throw new Error('Could not extract meaningful content from source')
  }

  const wordCount = rawContent.trim().split(/\s+/).length
  const { error } = await supabase.from('knowledge_docs').insert({
    name,
    source_type: sourceType,
    source_url: sourceUrl || null,
    raw_content: rawContent,
    word_count: wordCount
  })

  if (error) {
    if (String(error.message || '').includes('knowledge_docs')) {
      throw new Error('knowledge_docs table is missing in Supabase. Run schema.sql first.')
    }
    throw error
  }

  cachedKB = null
  lastLoaded = null
  await loadKnowledgeBase(true)
  return { wordCount }
}
