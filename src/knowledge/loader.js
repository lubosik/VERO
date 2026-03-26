import axios from 'axios'
import * as cheerio from 'cheerio'
import pdfParse from 'pdf-parse'
import { supabase } from '../db/supabase.js'
import { embedQuery, embedTexts, toVectorLiteral } from '../services/embeddings.js'
import { logger } from '../utils/logger.js'

let cachedKB = null
let lastLoaded = null

const CHUNK_WORD_TARGET = 220
const CHUNK_WORD_OVERLAP = 40

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function chunkText(rawContent) {
  const words = normalizeText(rawContent).split(/\s+/)
  const chunks = []

  for (let start = 0; start < words.length; start += CHUNK_WORD_TARGET - CHUNK_WORD_OVERLAP) {
    const end = Math.min(words.length, start + CHUNK_WORD_TARGET)
    const content = words.slice(start, end).join(' ').trim()
    if (content.length >= 80) {
      chunks.push(content)
    }
    if (end >= words.length) break
  }

  return chunks
}

async function replaceDocumentChunks(docId, rawContent) {
  const chunks = chunkText(rawContent)
  if (!chunks.length) return 0

  const embeddings = await embedTexts(chunks, 'passage')

  const rows = chunks.map((content, index) => ({
    doc_id: docId,
    chunk_index: index,
    content,
    token_estimate: Math.ceil(content.split(/\s+/).length * 1.35),
    embedding: toVectorLiteral(embeddings[index])
  }))

  const { error: deleteError } = await supabase.from('knowledge_chunks').delete().eq('doc_id', docId)
  if (deleteError && !String(deleteError.message || '').includes('knowledge_chunks')) throw deleteError

  const { error } = await supabase.from('knowledge_chunks').insert(rows)
  if (error) throw error

  return rows.length
}

export async function loadKnowledgeBase(forceRefresh = false) {
  const cacheFresh = cachedKB && lastLoaded && Date.now() - lastLoaded < 1000 * 60 * 10
  if (!forceRefresh && cacheFresh) return cachedKB

  const { data: docs, error } = await supabase
    .from('knowledge_docs')
    .select('id, name, source_type, raw_content')
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

  cachedKB = docs.map((doc) => `=== ${doc.name.toUpperCase()} ===\n${doc.raw_content.slice(0, 1200)}`).join('\n\n---\n\n')
  lastLoaded = Date.now()
  logger.info(`KB loaded: ${docs.length} docs`)
  return cachedKB
}

export async function ensureKnowledgeBaseIndexed() {
  const { data: docs, error } = await supabase
    .from('knowledge_docs')
    .select('id, name, raw_content')
    .eq('active', true)

  if (error) {
    if (String(error.message || '').includes('knowledge_docs')) return
    throw error
  }

  for (const doc of docs || []) {
    const { count, error: countError } = await supabase
      .from('knowledge_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('doc_id', doc.id)

    if (countError) {
      if (String(countError.message || '').includes('knowledge_chunks')) return
      throw countError
    }

    if (!count) {
      const chunkCount = await replaceDocumentChunks(doc.id, doc.raw_content)
      logger.info(`Indexed KB doc ${doc.name} into ${chunkCount} chunks`)
    }
  }
}

export async function searchKnowledgeBase(query, limit = 6) {
  try {
    const embedding = await embedQuery(query)
    const { data, error } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: toVectorLiteral(embedding),
      match_count: limit
    })

    if (error) throw error

    if (data?.length) {
      return data
        .filter((item) => Number(item.similarity || 0) > 0.2)
        .map(
          (item, index) =>
            `[KB ${index + 1} | similarity ${Number(item.similarity).toFixed(2)}]\n${item.content}`
        )
        .join('\n\n')
    }
  } catch (error) {
    logger.warn(`Semantic KB search failed, falling back to cached docs: ${error.message}`)
  }

  return loadKnowledgeBase()
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

  rawContent = normalizeText(rawContent)

  if (!rawContent || rawContent.length < 50) {
    throw new Error('Could not extract meaningful content from source')
  }

  const wordCount = rawContent.trim().split(/\s+/).length
  const { data: inserted, error } = await supabase
    .from('knowledge_docs')
    .insert({
      name,
      source_type: sourceType,
      source_url: sourceUrl || null,
      raw_content: rawContent,
      word_count: wordCount
    })
    .select('id')
    .single()

  if (error) {
    if (String(error.message || '').includes('knowledge_docs')) {
      throw new Error('knowledge_docs table is missing in Supabase. Run schema.sql first.')
    }
    throw error
  }

  let chunkCount = 0
  if (inserted?.id) {
    chunkCount = await replaceDocumentChunks(inserted.id, rawContent)
  }

  cachedKB = null
  lastLoaded = null
  await loadKnowledgeBase(true)
  return { wordCount, chunkCount }
}
