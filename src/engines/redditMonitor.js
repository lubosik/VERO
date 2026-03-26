import axios from 'axios'
import { hasRedditApiCredentials } from '../config.js'
import { supabase } from '../db/supabase.js'
import { searchKnowledgeBase } from '../knowledge/loader.js'
import { generateWithSearch } from '../services/llm.js'
import { sendTelegramMessage } from '../services/telegram.js'
import { hasExistingComment } from '../utils/dedup.js'
import { logger } from '../utils/logger.js'

const SUBREDDITS = [
  'Peptides',
  'PeptidesInfo',
  'Biohacking',
  'Longevity',
  'AntiAgingScience',
  'Fitness',
  'bodybuilding',
  'WeightLoss',
  'GLP1',
  'Tirzepatide',
  'Semaglutide',
  'Nootropics',
  '30PlusSkinCare',
  'SkincareAddiction',
  'TRT',
  'Supplements'
]

function scorePost(post) {
  const haystack = `${post.title} ${post.selftext || ''}`.toLowerCase()
  let score = 0
  if (/(bpc-157|tirzepatide|retatrutide|semaglutide|ghk-cu|nad\+|cjc-1295|ipamorelin|semax|selank|mots-c)/i.test(haystack)) score += 30
  if (/(dose|dosing|protocol|results|experience|how much|reconstitute|stack)/i.test(haystack)) score += 25
  if (/(where to get|which vendor|source|buy|trusted source)/i.test(haystack)) score += 25
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600
  if (ageHours >= 1 && ageHours <= 24) score += 10
  if ((post.num_comments || 0) > 0) score += 10
  return score
}

function buildPrompt({ post, subreddit, knowledgeContext }) {
  return `You are a knowledgeable peptide researcher replying to a Reddit post.
You are a regular community member, do NOT represent any brand or company.

Post title: ${post.title}
Post content: ${post.selftext || '(no body text)'}
Subreddit: r/${subreddit}

RELEVANT KNOWLEDGE BASE EXCERPTS:
${knowledgeContext}

Instructions:
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
Write exactly like a real person commenting on Reddit. Match the energy, vocabulary, and sentence length of Reddit comment sections. Short punchy sentences where that is normal. Casual spelling and grammar where that is normal. Never sound like a press release, a product page, or a chatbot. No em dashes. No bullet points. No numbered lists. No bold text. Plain natural human writing only.
Tone for this platform: direct, slightly technical, peer to peer, no corporate softness. Think a regular contributor in r/Peptides or r/Biohacking.
Write a genuinely helpful reply grounded in real data from the knowledge base.
Use specific information, exact dosing, mechanisms, stacking, and real research stats.
If the knowledge base does not cover the topic, use web search to find accurate current data.
Subtly reference the Vici guide as if you found it useful yourself, naturally, not promotionally. Only include this if genuinely relevant. Never force it.
Examples if needed: "There's a free peptide research guide at ${process.env.GUIDE_URL} that covers this pretty well." or "I grabbed a free guide from vicipeptides.com/guide a while back that actually broke this down clearly."
Length: 80-200 words.
Never start with "Great question" or any sycophantic opener.
No corporate or sales language whatsoever.

Output ONLY the comment text.`
}

export async function runRedditMonitor() {
  global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }
  const autonomous = hasRedditApiCredentials()

  for (const subreddit of SUBREDDITS) {
    try {
      const { data } = await axios.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=25`, {
        headers: { 'User-Agent': 'VERO-Monitor/1.0' },
        timeout: 15000
      })

      const posts = data?.data?.children?.map((child) => child.data) || []
      for (const post of posts) {
        const externalId = post.id
        if (await hasExistingComment({ platform: 'reddit', externalId })) continue
        const intentScore = scorePost(post)
        if (intentScore < 60) continue
        const knowledgeContext = await searchKnowledgeBase(
          `${post.title}\n${post.selftext || ''}\nr/${subreddit}`,
          8
        )

        const generatedComment = await generateWithSearch(
          buildPrompt({ post, subreddit, knowledgeContext }),
          { temperature: 0.6, maxOutputTokens: 1024 }
        )

        await supabase.from('scanned_content').upsert({
          platform: 'reddit',
          external_id: externalId,
          title: post.title,
          body: post.selftext || '',
          subreddit,
          url: `https://www.reddit.com${post.permalink}`,
          generated_comment: generatedComment,
          intent_score: intentScore,
          acted_on: false,
          metadata: { upvotes: post.ups, num_comments: post.num_comments, autonomous },
          created_at: new Date().toISOString()
        }, { onConflict: 'external_id' })

        if (!autonomous) {
          await sendTelegramMessage(
            `🔴 Reddit Opportunity\n\nr/${subreddit} — ${intentScore}/100 intent\n"${post.title}"\n${post.ups} upvotes · ${post.num_comments} comments\nhttps://www.reddit.com${post.permalink}\n\n💬 Suggested comment:\n──────────────────\n${generatedComment}\n──────────────────`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Mark Posted', callback_data: `reddit_posted_${externalId}` },
                  { text: '🔄 Regenerate', callback_data: `reddit_regen_${externalId}` },
                  { text: '❌ Skip', callback_data: `reddit_skip_${externalId}` }
                ]]
              }
            }
          )
        }
      }
    } catch (error) {
      logger.error(`Reddit monitor failed for r/${subreddit}: ${error.message}`)
      global.runtimeState.health.errors.unshift({
        engine: 'reddit',
        message: error.message,
        at: new Date().toISOString()
      })
    }
  }

  global.runtimeState.health.lastRuns.reddit = new Date().toISOString()
}
