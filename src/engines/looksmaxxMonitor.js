import axios from 'axios'
import * as cheerio from 'cheerio'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { searchKnowledgeBase } from '../knowledge/loader.js'
import { generateWithSearch } from '../services/llm.js'
import { sendTelegramMessage } from '../services/telegram.js'
import { canPost, incrementCap, shouldNotifyCap } from '../utils/dailyCap.js'
import { isRecent } from '../utils/recencyCheck.js'
import { logger } from '../utils/logger.js'
import { trackMetric } from '../utils/runtimeMetrics.js'

const BASE_URL = 'https://forum.looksmaxxing.com'
const HEADERS = { 'User-Agent': 'VERO-Monitor/1.0' }
const KEYWORDS = [
  'looksmax', 'looksmaxxing', 'hardmax', 'hardmaxxing', 'glowup', 'glow up',
  'skin quality', 'collagen', 'jawline peptide', 'bone structure', 'facial',
  'ghk-cu', 'copper peptide', 'melanotan tan', 'skin texture', 'hair loss peptide',
  'hair growth peptide', 'anti aging', 'face gains', 'physique', 'aesthetics',
  'body recomp', 'fat loss peptide', 'mewing', 'ascend', 'ascending', 'descending',
  'nw scale', 'norwood', 'finasteride peptide', 'minoxidil peptide', 'peptide source',
  'where to get peptides', 'peptide vendor', 'research chemical', 'bpc healing', 'gh peptide'
]

function normalizeText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function toAbsoluteUrl(url = '') {
  if (!url) return ''
  return url.startsWith('http') ? url : `${BASE_URL}${url}`
}

function findKeywords(text) {
  const haystack = normalizeText(text).toLowerCase()
  return KEYWORDS.filter((keyword) => haystack.includes(keyword)).slice(0, 8)
}

function scoreThread(thread, matchedKeywords, authorIsNew) {
  let score = 0
  const body = normalizeText(thread.body)
  const combined = `${thread.title}\n${body}`
  if (matchedKeywords.length) score += 30
  if (/\?$|\b(how|what|which|should i|does anyone|has anyone|looking for|need advice|recommendations)\b/i.test(combined)) score += 25
  if (thread.postCount > 0) score += 10
  if (body.split(/\s+/).filter(Boolean).length > 50) score += 10
  if (authorIsNew) score += 10
  if (isRecent(thread.publishedAt, 7)) score += 15
  return score
}

async function fetchThreadList() {
  try {
    const { data } = await axios.get(`${BASE_URL}/whats-new/posts.json?limit=25`, {
      headers: HEADERS,
      timeout: 15000
    })

    const items = data?.posts || data?.results || []
    return items.map((item) => ({
      id: String(item.thread_id || item.threadId || item.content_id || item.post_id || item.id),
      title: item.thread_title || item.title || item.title_plain || '',
      url: toAbsoluteUrl(item.thread_url || item.url || item.thread?.url || ''),
      body: item.message || item.body || '',
      author: item.username || item.author || item.User?.username || 'unknown',
      postCount: Number(item.reply_count || item.replyCount || 0),
      publishedAt: item.post_date || item.postDate || item.last_post_date || item.postDateISO
    })).filter((item) => item.id && item.title)
  } catch (error) {
    const { data: html } = await axios.get(`${BASE_URL}/forums/looksmaxxing.3/`, {
      headers: HEADERS,
      timeout: 15000
    })
    const $ = cheerio.load(html)
    return $('.structItem--thread').map((_, element) => {
      const link = $(element).find('.structItem-title a').attr('href')
      const time = $(element).find('time').attr('datetime')
      return {
        id: (link || '').match(/threads\/.*?\.(\d+)/)?.[1] || link,
        title: normalizeText($(element).find('.structItem-title').text()),
        url: toAbsoluteUrl(link),
        body: normalizeText($(element).find('.structItem-snippet').text()),
        author: normalizeText($(element).find('.username').first().text()) || 'unknown',
        postCount: Number($(element).find('.pairs--justified dd').first().text() || 0),
        publishedAt: time
      }
    }).get().filter((item) => item.id && item.url)
  }
}

async function fetchThreadContext(threadUrl) {
  const { data: html } = await axios.get(threadUrl, { headers: HEADERS, timeout: 15000 })
  const $ = cheerio.load(html)
  const posts = $('.message').map((_, element) => {
    const body = normalizeText($(element).find('.bbWrapper').text())
    const author = normalizeText($(element).find('.message-name').text() || $(element).find('.username').first().text())
    const score = Number($(element).find('.reaction-score').first().text() || 0)
    const timestamp = $(element).find('time').attr('datetime')
    return { body, author, score, timestamp }
  }).get().filter((post) => post.body)

  const firstPost = posts[0] || {}
  return {
    body: firstPost.body || '',
    publishedAt: firstPost.timestamp || $('time').first().attr('datetime'),
    comments: posts.slice(1, 8)
  }
}

async function hasProcessedThread(threadId) {
  const { data, error } = await supabase
    .from('scanned_content')
    .select('id')
    .eq('platform', 'looksmaxxing')
    .or(`content_id.eq.${threadId},external_id.eq.${threadId}`)
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  return Boolean(data)
}

async function hasSeenAuthor(username) {
  const { data, error } = await supabase
    .from('seen_authors')
    .select('id')
    .eq('platform', 'looksmaxxing')
    .eq('username', username)
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116' && !String(error.message || '').includes('seen_authors')) throw error
  return Boolean(data)
}

function commentPrompt({ thread, comments, knowledgeContext }) {
  const commentBlock = comments.length
    ? comments.map((item, index) => `[${index + 1}] ${item.author}: ${item.body}`).join('\n\n')
    : 'No replies yet.'

  return `You are replying in a looksmaxxing forum thread about peptides, skin quality, physique, aesthetics, recovery, or related self-improvement topics.
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
The tone here is younger, direct, internet-native. Short sentences. Knowledgeable but casual. Forum-appropriate vocabulary like goated, actually works, tried this, solid results is fine when it feels natural. Never sound corporate or like a brand rep. No bullet points. No numbered lists. Plain natural human writing only.

Thread title: ${thread.title}
Thread body: ${thread.body}

Existing replies:
${commentBlock}

Relevant knowledge base:
${knowledgeContext}

Write a forum reply that adds something missing. Go deeper than the current replies. Never mention Vici in the body. If it genuinely fits, you can say: "there is a solid free guide on this at ${config.GUIDE_URL} if you want the full protocol"
Length: 70-160 words.
Output only the reply text.`
}

export async function runLooksmaxxMonitor() {
  global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }

  if (!canPost('looksmaxxing')) {
    trackMetric('looksmaxxing', { capSkipped: 1, lastError: 'daily cap reached' })
    if (shouldNotifyCap('looksmaxxing')) {
      await sendTelegramMessage('📊 Daily cap reached: looksmaxxing (15 actions). Resuming tomorrow.')
    }
    return
  }

  const threads = await fetchThreadList()

  for (const seed of threads) {
    try {
      if (!canPost('looksmaxxing')) break
      if (!seed.id || await hasProcessedThread(seed.id)) continue
      trackMetric('looksmaxxing', {
        processed: 1,
        lastItem: { id: seed.id, title: seed.title, url: seed.url }
      })

      const context = await fetchThreadContext(seed.url)
      const thread = { ...seed, body: context.body || seed.body, publishedAt: context.publishedAt || seed.publishedAt }
      if (!isRecent(thread.publishedAt, 7)) {
        trackMetric('looksmaxxing', { staleSkipped: 1 })
        continue
      }

      const matchedKeywords = findKeywords(`${thread.title}\n${thread.body}`)
      const authorIsNew = !(await hasSeenAuthor(thread.author))
      const score = scoreThread(thread, matchedKeywords, authorIsNew)
      if (score < 55) continue

      const knowledgeContext = await searchKnowledgeBase(
        [thread.title, thread.body, context.comments.map((item) => item.body).join('\n')].join('\n'),
        8
      )

      const generatedComment = await generateWithSearch(commentPrompt({
        thread,
        comments: context.comments,
        knowledgeContext
      }), { maxOutputTokens: 900 })

      await supabase.from('scanned_content').upsert({
        platform: 'looksmaxxing',
        content_id: seed.id,
        external_id: seed.id,
        title: thread.title,
        body: thread.body,
        url: seed.url,
        generated_comment: generatedComment,
        intent_score: score,
        acted_on: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          author: thread.author,
          post_count: thread.postCount,
          matched_keywords: matchedKeywords
        }
      }, { onConflict: 'external_id' })

      await sendTelegramMessage(
        `🔴 Looksmaxxing Lead
Intent score: ${score}/100
"${thread.title}"
${thread.author} | ${thread.postCount || 0} replies
${seed.url}

Matched keywords: ${matchedKeywords.join(', ') || 'none'}

Post preview:
"${thread.body.slice(0, 300)}${thread.body.length > 300 ? '...' : ''}"`
      )
      await sendTelegramMessage(`💬 Comment (paste on the post):\n${generatedComment}`)
      await sendTelegramMessage(
        `✅ Actions:
1. Open thread: ${seed.url}
2. Paste the comment above
3. Post manually from your forum account`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Mark Done', callback_data: `looksmax_done_${seed.id}` },
              { text: '❌ Skip', callback_data: `looksmax_skip_${seed.id}` }
            ]]
          }
        }
      )
      incrementCap('looksmaxxing')
      trackMetric('looksmaxxing', { queued: 1 })
    } catch (error) {
      logger.error(`Looksmaxxing monitor failed for ${seed?.url || 'thread'}: ${error.message}`)
      trackMetric('looksmaxxing', { errors: 1, lastError: error.message })
      global.runtimeState.health.errors.unshift({
        engine: 'looksmaxxing',
        message: error.message,
        at: new Date().toISOString()
      })
    }
  }

  global.runtimeState.health.lastRuns.looksmaxxing = new Date().toISOString()
}
