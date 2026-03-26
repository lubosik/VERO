import { loadKnowledgeBase } from '../knowledge/loader.js'
import { scrapeYouTubeComments, formatCommentsForPrompt } from '../services/apify.js'
import { generateJson, generateText } from '../services/gemini.js'
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

function buildPrompt({ video, detail, knowledgeBase, commentContext, guideUrl }) {
  return `You are a member of the Vici Peptides research team commenting on a YouTube video.
You post from the official Vici Peptides channel — your name is visible on the comment, so never mention the brand name in the body.

Video Title: ${detail?.snippet?.title || video.snippet.title}
Channel: ${video.snippet.channelTitle}
Description: ${(detail?.snippet?.description || '').slice(0, 1000)}

WHAT PEOPLE ARE ALREADY SAYING IN THE COMMENTS:
${commentContext}

KNOWLEDGE BASE (Vici Research Guide + Transcripts):
${knowledgeBase}

Your task:
1. Read the existing comments carefully. Identify:
   - Questions that haven't been answered well
   - Misconceptions or inaccurate claims that need correcting
   - Points where you can add meaningful depth or data
   - Gaps where specific protocol/dosing info from the guide would help
2. Write a comment that responds to the actual conversation — not just the video title
3. Lead with the real value. Use specific data: exact dosing numbers, mechanisms, research stats, stacking info
4. If the knowledge base lacks something, use your web search capability to find accurate current information
5. Tone: knowledgeable, peer-to-peer, genuinely helpful. Never corporate. Never promotional.
6. Never say "Vici Peptides" in the comment — the account handles that
7. Only include the guide link if the conversation clearly calls for it:
   "Our free research guide has the full protocol breakdown on this: ${guideUrl}"
   Never force it
8. 70-160 words
9. Do not start with compliments to the video or creator
10. End with a question or observation that invites further discussion when it feels natural

Output ONLY the comment text.`
}

async function passesNaturalness(comment) {
  const result = await generateJson(`Does this YouTube comment from a brand account sound genuinely helpful and human, or does it read like promotional/AI copy?
Comment: "${comment}"
Respond ONLY with JSON: {"score": <1-10>, "reason": "<brief>"}`)
  return result
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

  const knowledgeBase = await loadKnowledgeBase()

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

      const comment = await generateText(
        buildPrompt({
          video,
          detail,
          knowledgeBase,
          commentContext,
          guideUrl: process.env.GUIDE_URL
        }),
        { temperature: 0.8, maxOutputTokens: 400 }
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

  global.runtimeState.health.lastRuns.youtube = new Date().toISOString()
}
