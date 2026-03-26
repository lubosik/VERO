import { ApifyClient } from 'apify-client'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { searchKnowledgeBase } from '../knowledge/loader.js'
import { formatCommentsForPrompt } from '../services/apify.js'
import { getTikTokVideoComments } from '../services/tiktok.js'
import { checkNaturalness, generateWithSearch } from '../services/llm.js'
import { sendTelegramMessage } from '../services/telegram.js'
import { canPost, incrementCap, shouldNotifyCap } from '../utils/dailyCap.js'
import { isRecent } from '../utils/recencyCheck.js'
import { logger } from '../utils/logger.js'

const client = config.APIFY_API_KEY ? new ApifyClient({ token: config.APIFY_API_KEY }) : null

const SEARCH_QUERIES = [
  'bpc157 peptide', 'ghk-cu skin results', 'tirzepatide results',
  'retatrutide weight loss', 'peptide protocol', 'looksmaxxing peptides',
  'nad injection', 'biohacking peptides', 'CJC ipamorelin',
  'melanotan tanning peptide', 'peptides anti aging', 'fat loss peptide',
  'peptide source review', 'research peptides', 'ghk copper peptide'
]

const KEYWORDS = [
  'bpc', 'ghk', 'tirzepatide', 'retatrutide', 'peptide', 'looksmax', 'nad',
  'ipamorelin', 'melanotan', 'biohacking', 'glp', 'anti aging', 'fat loss'
]

function normalizeText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function pickQueries() {
  return [...SEARCH_QUERIES].sort(() => Math.random() - 0.5).slice(0, 3)
}

function getDescription(post) {
  return normalizeText(post?.text || post?.description || post?.desc || post?.title || '')
}

function extractTimestamp(post) {
  return post?.createTimeISO || post?.createTime || post?.publishTime || post?.createTimestamp || null
}

function scoreVideo(post, description, fresh, isNew) {
  let score = 0
  const views = Number(post?.playCount || post?.stats?.playCount || post?.views || 0)
  const comments = Number(post?.commentCount || post?.stats?.commentCount || 0)
  const ageRecent = isRecent(extractTimestamp(post), 7)
  if (ageRecent) score += 25
  else if (fresh) score += 10
  if (views >= 1000 && views <= 500000) score += 20
  if (comments >= 20) score += 15
  if (KEYWORDS.some((keyword) => description.toLowerCase().includes(keyword))) score += 25
  if (isNew) score += 15
  return score
}

async function hasScanned(id) {
  const { data, error } = await supabase
    .from('scanned_content')
    .select('id')
    .eq('platform', 'tiktok')
    .or(`content_id.eq.${id},external_id.eq.${id}`)
    .limit(1)
    .maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  return Boolean(data)
}

export async function runTikTokMonitor() {
  global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }
  if (!client) return

  if (!canPost('tiktok')) {
    if (shouldNotifyCap('tiktok')) {
      await sendTelegramMessage('📊 Daily cap reached: tiktok (15 actions). Resuming tomorrow.')
    }
    return
  }

  for (const query of pickQueries()) {
    if (!canPost('tiktok')) break

    try {
      const run = await client.actor('clockworks/tiktok-scraper').call({
        searchQueries: [query],
        maxPostsPerQuery: 10,
        resultsType: 'search'
      })

      const { items } = await client.dataset(run.defaultDatasetId).listItems()
      for (const post of items || []) {
        if (!canPost('tiktok')) break
        const id = String(post?.id || post?.awemeId || '')
        const videoUrl = post?.webVideoUrl || post?.url || post?.videoUrl
        const timestamp = extractTimestamp(post)
        if (!id || !videoUrl) continue
        if (!isRecent(timestamp, 14)) {
          logger.info(`Skipped ${id}: missing or stale timestamp`)
          continue
        }
        if (await hasScanned(id)) continue

        const description = getDescription(post)
        const score = scoreVideo(post, description, true, true)
        if (score < 55) continue

        const comments = await getTikTokVideoComments(videoUrl, 100)
        const commentContext = formatCommentsForPrompt(
          comments.map((item) => ({
            text: item.text,
            author: item.author,
            votes: item.likes,
            replies: item.replies
          })),
          20
        )
        const knowledgeContext = await searchKnowledgeBase(
          [description, comments.slice(0, 5).map((item) => item.text).join('\n')].join('\n'),
          8
        )

        const generatedComment = await generateWithSearch(
          `You are a knowledgeable member of the peptide and biohacking community commenting on a TikTok video. Write exactly like a real person in TikTok comments. Short punchy sentences. Casual. Direct. Match the energy of TikTok's peptide and looksmaxxing community. No em dashes ever. No bullet points. No brand names in the comment body. Plain natural human writing only.

Video title/description: ${description}

What people are already saying:
${commentContext}

Knowledge base:
${knowledgeContext}

Write a TikTok comment that adds real value to this conversation. Reference specific data from the knowledge base if it addresses what people are discussing. Go deeper than what is already in the comments. If the guide is directly relevant drop it naturally:
"theres a free guide that breaks this down properly: ${config.GUIDE_URL}"
Never force the link. 60-120 words max.
Output only the comment text.`,
          { maxOutputTokens: 700 }
        )

        const naturalness = await checkNaturalness(generatedComment, 'tiktok')
        if ((naturalness.score || 0) < 7) continue

        await supabase.from('scanned_content').upsert({
          platform: 'tiktok',
          content_id: id,
          external_id: id,
          title: description.slice(0, 120) || id,
          body: description,
          url: videoUrl,
          generated_comment: generatedComment,
          intent_score: score,
          acted_on: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {
            views: Number(post?.playCount || post?.stats?.playCount || post?.views || 0),
            comment_count: Number(post?.commentCount || post?.stats?.commentCount || 0),
            naturalness
          }
        }, { onConflict: 'external_id' })

        const daysAgo = Math.max(0, Math.round((Date.now() - new Date(typeof timestamp === 'number' && timestamp < 9999999999 ? timestamp * 1000 : timestamp).getTime()) / 86400000))
        await sendTelegramMessage(
          `🎵 TikTok Opportunity

"${description.slice(0, 80) || id}"
Views: ${Number(post?.playCount || post?.stats?.playCount || post?.views || 0)} | Comments: ${Number(post?.commentCount || post?.stats?.commentCount || 0)}
Posted: ${daysAgo} days ago
${videoUrl}

💬 Suggested comment:
──────────────────
${generatedComment}
──────────────────`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Mark Posted', callback_data: `tiktok_posted_${id}` },
                { text: '🔄 Regenerate', callback_data: `tiktok_regen_${id}` },
                { text: '❌ Skip', callback_data: `tiktok_skip_${id}` }
              ]]
            }
          }
        )
        incrementCap('tiktok')
      }
    } catch (error) {
      logger.error(`TikTok monitor failed for query "${query}": ${error.message}`)
      global.runtimeState.health.errors.unshift({
        engine: 'tiktok',
        message: error.message,
        at: new Date().toISOString()
      })
    }
  }

  global.runtimeState.health.lastRuns.tiktok = new Date().toISOString()
}
