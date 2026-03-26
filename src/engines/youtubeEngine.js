import { searchKnowledgeBase } from '../knowledge/loader.js'
import { scrapeYouTubeComments, formatCommentsForPrompt } from '../services/apify.js'
import { checkNaturalness, generateWithSearch } from '../services/llm.js'
import { sendTelegramMessage } from '../services/telegram.js'
import { getVideoDetails, postComment, searchVideos } from '../services/youtube.js'
import { hasExistingComment, logComment } from '../utils/dedup.js'
import { logger } from '../utils/logger.js'

const SEARCH_QUERIES = [
  'BPC-157 results experience',
  'tirzepatide weight loss results 2025',
  'retatrutide vs semaglutide',
  'peptides for recovery bodybuilding',
  'NAD+ injection anti aging benefits',
  'GHK-Cu skin collagen results',
  'CJC-1295 ipamorelin stack protocol',
  'melanotan tanning peptide experience',
  'semax nootropic cognitive',
  'peptides for fat loss',
  'GLP-1 peptide research',
  'biohacking peptides longevity',
  'peptide protocol beginners guide',
  'semaglutide vs tirzepatide comparison',
  'retatrutide triple agonist results'
]

const PEPTIDES = [
  'bpc-157',
  'tirzepatide',
  'retatrutide',
  'semaglutide',
  'nad+',
  'ghk-cu',
  'cjc-1295',
  'ipamorelin',
  'melanotan',
  'semax',
  'selank',
  'mots-c',
  'glutathione'
]

function videoAgeDays(publishedAt) {
  return (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24)
}

function isMajorChannel(channelTitle = '') {
  return /(hospital|clinic|pharma|news|university|medical center|webmd)/i.test(channelTitle)
}

function scoreVideo(video, detail) {
  let score = 0
  const views = Number(detail?.statistics?.viewCount || 0)
  const comments = Number(detail?.statistics?.commentCount || 0)
  const title = `${video.snippet?.title || ''} ${detail?.snippet?.title || ''}`.toLowerCase()

  if (videoAgeDays(video.snippet?.publishedAt) <= 30) score += 20
  if (views >= 500 && views <= 100000) score += 20
  if (!detail?.status?.privacyStatus || detail.status.privacyStatus === 'public') score += 15
  if (PEPTIDES.some((name) => title.includes(name))) score += 25
  if (comments >= 10) score += 10
  if (!isMajorChannel(video.snippet?.channelTitle)) score += 10

  return score
}

function buildPrompt({ video, detail, knowledgeContext, commentContext, guideUrl }) {
  return `You are a member of the Vici Peptides research team commenting on a YouTube video.
You post from the official Vici Peptides channel, your name is visible on the comment, so never mention the brand name in the body.

Video Title: ${detail?.snippet?.title || video.snippet.title}
Channel: ${video.snippet.channelTitle}
Description: ${(detail?.snippet?.description || '').slice(0, 1000)}

WHAT PEOPLE ARE ALREADY SAYING IN THE COMMENTS:
${commentContext}

RELEVANT KNOWLEDGE BASE EXCERPTS:
${knowledgeContext}

Your task:
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
Write exactly like a real person commenting on YouTube. Match the energy, vocabulary, and sentence length of YouTube comment sections. Short punchy sentences where that is normal. Casual spelling and grammar where that is normal. Never sound like a press release, a product page, or a chatbot. No em dashes. No bullet points. No numbered lists. No bold text. Plain natural human writing only.
Tone for this platform: knowledgeable but casual, like someone who has done the research themselves and is sharing what they found in a biohacking or fitness YouTube comment section.
Read the existing comments carefully. Notice unanswered questions, bad claims, and missing context. Respond to the real conversation, not just the video title.
Lead with real value. Use specific data, exact dosing numbers, mechanisms, research stats, and stacking info when relevant.
If the knowledge base lacks something, use web search to find accurate current information.
Never say "Vici Peptides" in the comment, the account name already handles that.
Only include the guide link if the conversation clearly calls for it. If it fits naturally, use: "Our free research guide has the full protocol breakdown on this: ${guideUrl}"
Do not force the link.
Length: 70-160 words.
Do not start with compliments to the video or creator.
End with a genuine question or observation if it feels natural.

Output ONLY the comment text.`
}

async function passesNaturalness(comment) {
  return checkNaturalness(comment, 'youtube')
}

export async function runYouTubeEngine() {
  if (global.enginePausedUntil && global.enginePausedUntil > Date.now()) {
    logger.info('YouTube engine paused')
    return
  }

  global.runtimeState ||= { youtube: {}, stats: {}, health: { lastRuns: {}, errors: [] } }
  const commentsToday = global.runtimeState.youtube.commentsToday || 0
  if (commentsToday >= 12) {
    logger.info('YouTube daily limit reached')
    return
  }

  try {
    for (const query of SEARCH_QUERIES) {
      const results = await searchVideos(query, 5)

      for (const video of results) {
        const videoId = video.id?.videoId
        if (!videoId) continue
        if (await hasExistingComment({ platform: 'youtube', videoId })) continue

        const detail = await getVideoDetails(videoId)
        const score = scoreVideo(video, detail)
        if (score < 55) continue

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
        const scrapedComments = await scrapeYouTubeComments(videoUrl, 150)
        const commentContext = formatCommentsForPrompt(scrapedComments, 20)
        const knowledgeContext = await searchKnowledgeBase(
          [
            detail?.snippet?.title || video.snippet?.title || '',
            detail?.snippet?.description?.slice(0, 500) || '',
            query,
            scrapedComments.slice(0, 5).map((item) => item.text).join(' ')
          ].join('\n')
        )

        const comment = await generateWithSearch(
          buildPrompt({
            video,
            detail,
            knowledgeContext,
            commentContext,
            guideUrl: process.env.GUIDE_URL
          }),
          { temperature: 0.6, maxOutputTokens: 1024 }
        )

        const naturalness = await passesNaturalness(comment)
        if ((naturalness.score || 0) < 7) continue

        try {
          const posted = await postComment(videoId, comment)
          await logComment({
            platform: 'youtube',
            video_id: videoId,
            channel_id: video.snippet?.channelId,
            content_title: detail?.snippet?.title || video.snippet?.title,
            comment_text: comment,
            naturalness_score: naturalness.score,
            status: 'posted',
            external_id: posted?.id || videoId,
            metadata: { score, query, naturalness, videoUrl },
            created_at: new Date().toISOString()
          })

          global.runtimeState.youtube.commentsToday = commentsToday + 1
          global.runtimeState.health.lastRuns.youtube = new Date().toISOString()
          await sendTelegramMessage(`✅ Commented on YouTube\n${detail?.snippet?.title || video.snippet?.title}`)
          return
        } catch (error) {
          global.enginePausedUntil = Date.now() + 1000 * 60 * 60 * 3
          global.runtimeState.health.errors.unshift({
            engine: 'youtube',
            message: error.message,
            at: new Date().toISOString()
          })
          await sendTelegramMessage(`⚠️ YouTube API error. Pausing for 3 hours.\n${error.message}`)
          logger.error(`YouTube engine failed: ${error.message}`)
          return
        }
      }
    }
  } catch (error) {
    const message = String(error?.message || error)
    if (/invalid_client/i.test(message)) {
      global.enginePausedUntil = Date.now() + 1000 * 60 * 60 * 12
      await sendTelegramMessage('⚠️ YouTube OAuth refresh failed with invalid_client. Check the OAuth client ID, secret, redirect URI, and refresh token in Railway. YouTube engine paused for 12 hours.')
    }
    throw error
  }

  global.runtimeState.health.lastRuns.youtube = new Date().toISOString()
}
