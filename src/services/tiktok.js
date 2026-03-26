import { ApifyClient } from 'apify-client'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { sendTelegramMessage } from './telegram.js'
import { isRecent } from '../utils/recencyCheck.js'
import { logger } from '../utils/logger.js'

const client = config.APIFY_API_KEY ? new ApifyClient({ token: config.APIFY_API_KEY }) : null

const HASHTAGS = [
  'peptides', 'bpc157', 'looksmaxxing', 'biohacking',
  'ghkcu', 'retatrutide', 'tirzepatide', 'glp1',
  'nad', 'antiaging', 'peptideprotocol', 'longevity',
  'skinpeptides', 'fatlosspeptide', 'looksmax',
  'ghpeptide', 'melanotan', 'copperperiptide',
  'weightlosspeptide', 'recovverypeptide'
]

function averageTrend(values = []) {
  const nums = values
    .map((entry) => Number(entry?.value ?? entry))
    .filter((value) => !Number.isNaN(value))
    .slice(-7)

  if (!nums.length) return 0
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

async function listItems(run) {
  const { items } = await client.dataset(run.defaultDatasetId).listItems()
  return items || []
}

export async function getTikTokHashtagTrends() {
  if (!client) return []

  const run = await client.actor('lexis-solutions/tiktok-hashtag-analytics').call({
    adsCountryCode: 'us',
    adsTimeRange: '7',
    hashtags: HASHTAGS
  })

  const items = await listItems(run)
  const rows = []

  for (const item of items) {
    const hashtagName = String(item?.hashtagName || '').replace(/^#/, '').trim().toLowerCase()
    if (!hashtagName) continue

    const viewWeight = Math.min(1, Math.log10(Number(item?.videoViews || 0) + 1) / 9)
    const trendScore = Math.round((averageTrend(item?.trend) * 0.8 + viewWeight * 0.2) * 100)
    const publishCnt = Number(item?.publishCnt || 0)
    const videoViews = Number(item?.videoViews || 0)
    const interests = (item?.audienceInterests || []).slice(0, 3)
      .map((entry) => entry?.interest || entry?.value || entry)
      .filter(Boolean)

    rows.push({
      keyword: hashtagName,
      search_volume: publishCnt,
      trend_score: trendScore,
      competition: null,
      source: 'tiktok',
      last_checked: new Date().toISOString(),
      fetched_at: new Date().toISOString()
    })

    for (const related of item?.relatedHashtags || []) {
      const relatedName = String(related?.hashtagName || related || '').replace(/^#/, '').trim().toLowerCase()
      if (!relatedName) continue
      rows.push({
        keyword: relatedName,
        search_volume: Math.max(1, Math.round(publishCnt * 0.7)),
        trend_score: Math.round(trendScore * 0.7),
        competition: null,
        source: 'tiktok_related',
        last_checked: new Date().toISOString(),
        fetched_at: new Date().toISOString()
      })
    }
  }

  if (rows.length) {
    const { error } = await supabase.from('keywords').upsert(rows, { onConflict: 'keyword' })
    if (error) throw error
  }

  logger.info(`TikTok hashtag trends updated: ${rows.length} keywords ingested`)
  await sendTelegramMessage(`📊 TikTok hashtag trends updated: ${rows.length} keywords ingested`)
  return rows
}

export async function getTikTokVideoComments(videoUrl, maxComments = 100) {
  if (!client) return []

  const run = await client.actor('emastra/tiktok-comments-scraper').call({
    postURLs: [videoUrl],
    commentsPerPost: maxComments,
    maxRepliesPerComment: 2
  })

  const items = await listItems(run)
  return items
    .map((item) => ({
      text: item?.text || '',
      author: item?.uniqueId || 'unknown',
      likes: Number(item?.diggCount || 0),
      replies: Number(item?.replyCommentTotal || 0),
      timestamp: item?.createTimeISO
    }))
    .filter((item) => item.text && isRecent(item.timestamp, 30))
    .sort((a, b) => (b.likes + b.replies * 3) - (a.likes + a.replies * 3))
    .slice(0, 20)
}
