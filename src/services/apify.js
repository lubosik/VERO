import { ApifyClient } from 'apify-client'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const ACTOR_ID = 'streamers/youtube-comments-scraper'

const client = config.APIFY_API_KEY
  ? new ApifyClient({ token: config.APIFY_API_KEY })
  : null

export async function scrapeYouTubeComments(videoUrl, maxComments = 150) {
  if (!client) return []

  try {
    const input = {
      startUrls: [{ url: videoUrl }],
      maxComments,
      commentsSortBy: '1'
    }

    const run = await client.actor(ACTOR_ID).call(input)
    const { items } = await client.dataset(run.defaultDatasetId).listItems()

    return items
      .filter((item) => item.comment && item.comment.trim().length > 10)
      .map((item) => ({
        text: item.comment.trim(),
        author: item.author || 'unknown',
        votes: item.voteCount || 0,
        replies: item.replyCount || 0,
        isOwner: item.authorIsChannelOwner || false
      }))
      .slice(0, 150)
  } catch (error) {
    logger.error(`Apify scrape failed for ${videoUrl}: ${error.message}`)
    return []
  }
}

export function formatCommentsForPrompt(comments, limit = 20) {
  if (!comments?.length) return 'No existing comments could be retrieved for this video.'

  const top = [...comments]
    .sort((a, b) => b.votes + b.replies * 3 - (a.votes + a.replies * 3))
    .slice(0, limit)

  const lines = top.map(
    (comment, index) =>
      `[${index + 1}] ${comment.author} (${comment.votes} likes, ${comment.replies} replies):\n"${comment.text}"`
  )

  return `Top ${top.length} comments on this video:\n\n${lines.join('\n\n')}`
}
