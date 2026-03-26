import axios from 'axios'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { searchKnowledgeBase } from '../knowledge/loader.js'
import { generate, generateWithSearch } from '../services/llm.js'
import { sendTelegramMessage } from '../services/telegram.js'
import { canPost, incrementCap, shouldNotifyCap } from '../utils/dailyCap.js'
import { isRecent } from '../utils/recencyCheck.js'
import { logger } from '../utils/logger.js'

const REDDIT_HEADERS = { 'User-Agent': 'VERO-Monitor/1.0' }

const SUBREDDITS = [
  'Peptides',
  'PeptidesInfo',
  'Biohacking',
  'Longevity',
  'AntiAgingScience',
  'Fitness',
  'bodybuilding',
  'strength_training',
  'xxfitness',
  'running',
  'WeightLoss',
  'loseit',
  'intermittentfasting',
  'GLP1',
  'Tirzepatide',
  'Semaglutide',
  'Ozempic',
  'Nootropics',
  'SkinCareAddiction',
  '30PlusSkinCare',
  'SkincareAddicts',
  'TRT',
  'Supplements',
  'moreplatesmoredates',
  'nattyorjuice',
  'steroids',
  'PEDs',
  'overcominggravity',
  'veganfitness',
  'LooksmaxingAdvice',
  'BlackPillScience',
  'Looksmaxxing',
  'mewing',
  'jawsurgery',
  'malehairadvice',
  'FTMOver30',
  'Hairloss',
  'tressless',
  'alopecia',
  'SkincareScienceOG',
  'AsianMasculinity',
  'GainIt',
  'PurplePillDebate'
]

const KEYWORDS = [
  'bpc-157', 'bpc157', 'ghk-cu', 'ghk cu', 'copper peptide', 'tirzepatide', 'retatrutide',
  'semaglutide', 'ozempic', 'wegovy', 'mounjaro', 'glp-1', 'glp1', 'nad+', 'nad plus',
  'ipamorelin', 'cjc-1295', 'cjc1295', 'melanotan', 'tb-500', 'tb500', 'igf-1', 'igf1',
  'tesamorelin', 'glutathione', 'mots-c', 'motsc', 'semax', 'selank', 'l-carnitine',
  'peptide protocol', 'peptide dosing', 'peptide cycle', 'peptide stack',
  'research peptide', 'research chemical', 'peptide source', 'where to buy peptides',
  'peptide vendor', 'peptide supplier', 'best peptides', 'peptide guide',
  'reconstitution', 'bac water', 'bacteriostatic water', 'subcutaneous injection',
  'subq injection', 'insulin syringe', 'peptide injection', 'anti aging peptide',
  'healing peptide', 'fat loss peptide', 'weight loss peptide', 'recovery peptide',
  'skin peptide', 'collagen peptide', 'growth hormone peptide', 'gh peptide',
  'muscle recovery peptide', 'nootropic peptide', 'cognitive peptide'
  , 'looksmax', 'looksmaxxing', 'hardmax', 'hardmaxxing', 'glowup', 'glow up',
  'skin quality', 'jawline peptide', 'bone structure', 'facial', 'melanotan tan',
  'skin texture', 'hair loss peptide', 'hair growth peptide', 'face gains', 'aesthetics',
  'mewing', 'ascend', 'ascending', 'descending', 'nw scale', 'norwood'
]

const QUESTION_PATTERN = /\?$|\b(how|what|which|should i|does anyone|has anyone|looking for|need advice|recommendations)\b/i
const PAIN_PATTERN = /\b(help|pain|issue|problem|struggling|confused|side effect|dose|dosing|protocol|stack|vendor|source|where|advice|recommend)\b/i

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function formatAge(createdUtc) {
  const diffHours = Math.max(0, (Date.now() / 1000 - createdUtc) / 3600)
  if (diffHours < 1) return `${Math.max(1, Math.round(diffHours * 60))}m`
  if (diffHours < 24) return `${Math.round(diffHours)}h`
  return `${Math.round(diffHours / 24)}d`
}

function extractMatchedKeywords(text) {
  const haystack = normalizeText(text).toLowerCase()
  return KEYWORDS.filter((keyword) => haystack.includes(keyword)).slice(0, 8)
}

function isQuestion(text) {
  return QUESTION_PATTERN.test(normalizeText(text))
}

function getWordCount(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length
}

function buildIntentScore(post, matchedKeywords, authorIsNew) {
  const body = normalizeText(post.selftext)
  const combined = `${post.title}\n${body}`
  let score = 0

  if (matchedKeywords.length) score += 30
  if (isQuestion(combined)) score += 25

  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600
  if (ageHours >= 1 && ageHours <= 24) score += 15
  if ((post.num_comments || 0) >= 1) score += 10
  if (getWordCount(body) > 50) score += 10
  if (authorIsNew) score += 10

  return score
}

function formatTopCommentsForPrompt(comments) {
  if (!comments.length) return 'No useful existing comments were found.'
  return comments
    .map((comment, index) => `[${index + 1}] u/${comment.author} (${comment.score} upvotes): ${comment.body}`)
    .join('\n\n')
}

function buildCommentPrompt({ post, subreddit, topComments, knowledgeContext }) {
  return `You are a knowledgeable peptide researcher and regular contributor to Reddit communities about peptides, biohacking, fitness, longevity, looksmaxxing, and blackpill-adjacent self-improvement threads when they overlap with peptide research.
You write exactly like a real person in these subreddits. Direct, slightly technical, peer-to-peer. Short sentences. No corporate language. No em dashes ever. No bullet points. No numbered lists. No bold text. Plain natural human writing only. You are not a brand, not a marketer, not a salesperson. You share what you know because you have done the research.

Post title: ${post.title}
Post body: ${normalizeText(post.selftext) || '(no body text)'}
Subreddit: r/${subreddit}

Top existing comments:
${formatTopCommentsForPrompt(topComments)}

Relevant knowledge base:
${knowledgeContext}

Write exactly like a real person commenting on Reddit. Match the energy, vocabulary, and sentence length of Reddit comment sections. Short punchy sentences where that is normal. Casual spelling and grammar where that is normal. Never sound like a press release, a product page, or a chatbot. No em dashes. No bullet points. No numbered lists. No bold text. Plain natural human writing only.
Add value that is missing from the thread. Do not repeat what the top comments already covered unless you are correcting something inaccurate.
Use specific protocol, dosing, mechanism, stacking, safety, or sourcing context when it genuinely helps.
You may mention this naturally only if it directly helps the thread: "there is a free research guide at ${config.GUIDE_URL} that has the full protocol breakdown on this". Frame it like something you found useful, not something you made.
Length: 90-220 words.
Output only the comment text.`
}

function buildDmPrompt({ post, subreddit, knowledgeContext }) {
  return `Write a Reddit DM to someone who posted in r/${subreddit}.
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
Tone: casual, warm, industry-insider. Like someone who saw their post and genuinely wants to help. Conversational. No corporate language.

Post title: ${post.title}
Post body: ${normalizeText(post.selftext) || '(no body text)'}

Relevant knowledge base:
${knowledgeContext}

Instructions:
Mention Vici Peptides naturally.
Include the guide link: ${config.GUIDE_URL}
If the question is about protocols or dosing, mention the 1-on-1 consult option at ${config.CONSULT_URL}.
Keep it short enough to feel like a normal DM, but helpful.
Output only the DM text.`
}

async function fetchSubredditPosts(subreddit) {
  const { data } = await axios.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=25`, {
    headers: REDDIT_HEADERS,
    timeout: 15000
  })
  return data?.data?.children?.map((child) => child.data) || []
}

async function fetchPostComments(permalink) {
  const { data } = await axios.get(`https://www.reddit.com${permalink}.json?limit=20&sort=top`, {
    headers: REDDIT_HEADERS,
    timeout: 15000
  })

  const items = data?.[1]?.data?.children || []
  return items
    .map((item) => item.data)
    .filter((comment) => comment?.body && comment.author && comment.author !== '[deleted]')
    .map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: normalizeText(comment.body),
      score: comment.score || 0
    }))
    .filter((comment) => comment.body.length > 20)
}

async function hasProcessedPost(postId) {
  const { data, error } = await supabase
    .from('scanned_content')
    .select('id')
    .eq('platform', 'reddit')
    .or(`content_id.eq.${postId},external_id.eq.${postId}`)
    .limit(1)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') throw error
  return Boolean(data)
}

async function hasSeenAuthor(username) {
  if (!username) return false
  const { data, error } = await supabase
    .from('seen_authors')
    .select('id')
    .eq('platform', 'reddit')
    .eq('username', username)
    .limit(1)
    .maybeSingle()

  if (error) {
    if (String(error.message || '').includes('seen_authors')) return false
    if (error.code !== 'PGRST116') throw error
  }

  return Boolean(data)
}

async function queuePostLead({ post, subreddit, intentScore, matchedKeywords, commentText, dmText, topComments }) {
  const postUrl = `https://www.reddit.com${post.permalink}`
  const preview = normalizeText(post.selftext).slice(0, 300) || '(no body text)'

  await supabase.from('scanned_content').upsert({
    platform: 'reddit',
    content_id: post.id,
    external_id: post.id,
    title: post.title,
    body: normalizeText(post.selftext),
    subreddit,
    url: postUrl,
    generated_comment: commentText,
    intent_score: intentScore,
    acted_on: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {
      author: post.author,
      upvotes: post.ups || 0,
      num_comments: post.num_comments || 0,
      matched_keywords: matchedKeywords,
      dm_text: dmText,
      top_comments: topComments.slice(0, 5),
      reddit_username: config.REDDIT_USERNAME || ''
    }
  }, { onConflict: 'external_id' })

  await sendTelegramMessage(
    `🔴 Reddit Lead — r/${subreddit}
Intent score: ${intentScore}/100
"${post.title}"
u/${post.author} | ${post.ups || 0} upvotes | ${post.num_comments || 0} comments
Age: ${formatAge(post.created_utc)}
${postUrl}

Matched keywords: ${matchedKeywords.join(', ')}

Post preview:
"${preview}${preview.length >= 300 ? '...' : ''}"`,
    {}
  )

  await sendTelegramMessage(`💬 Comment (paste on the post):\n${commentText}`)

  if (dmText) {
    await sendTelegramMessage(`📩 DM for u/${post.author} (send 2-4 hours after commenting):\n${dmText}`)
  }

  await sendTelegramMessage(
    `✅ Actions:
1. Open post: ${postUrl}
2. Paste the comment above from u/${config.REDDIT_USERNAME || 'South_Requirement473'}
3. Set a timer for 2-4 hours
4. Send the DM to u/${post.author}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Mark Done', callback_data: `reddit_done_${post.id}` },
          { text: '❌ Skip', callback_data: `reddit_skip_${post.id}` }
        ]]
      }
    }
  )
}

async function queueCommenterLead({ post, subreddit, comment, matchedKeywords, dmText }) {
  if (!canPost('reddit')) return false
  const postUrl = `https://www.reddit.com${post.permalink}`
  await sendTelegramMessage(
    `🔴 Reddit Lead — r/${subreddit}
Intent score: commenter lead
"${post.title}"
u/${comment.author} in comments | ${comment.score} comment upvotes
Age: ${formatAge(post.created_utc)}
${postUrl}

Matched keywords: ${matchedKeywords.join(', ')}

Post preview:
"${comment.body.slice(0, 300)}${comment.body.length > 300 ? '...' : ''}"`,
    {}
  )

  await sendTelegramMessage(`📩 DM for u/${comment.author} (send after you engage in the thread if relevant):\n${dmText}`)
  const { error } = await supabase.from('seen_authors').upsert(
    [{ platform: 'reddit', username: comment.author }],
    { onConflict: 'platform,username' }
  )
  if (error && !String(error.message || '').includes('seen_authors')) throw error
  incrementCap('reddit')
  return true
}

async function processCommenterLeads({ post, subreddit, comments, knowledgeContext }) {
  for (const comment of comments.slice(0, 10)) {
    if (!canPost('reddit')) break
    const matchedKeywords = extractMatchedKeywords(comment.body)
    if (!matchedKeywords.length) continue
    if (!isQuestion(comment.body) && !PAIN_PATTERN.test(comment.body)) continue
    if (comment.author === post.author) continue
    if (await hasSeenAuthor(comment.author)) continue

    const dmText = await generate(
      `Write a Reddit DM to u/${comment.author}.
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
Tone: casual, warm, insider, genuinely helpful.
Do not sound like a company.

Original post title: ${post.title}
Comment they left: ${comment.body}

Relevant knowledge base:
${knowledgeContext}

Mention Vici Peptides naturally.
Include this guide link naturally because you found it useful: ${config.GUIDE_URL}
If the comment is clearly asking about protocol or dosing, mention the consult option at ${config.CONSULT_URL}.
Output only the DM text.`
    )

    await queueCommenterLead({ post, subreddit, comment, matchedKeywords, dmText })
  }
}

export async function runRedditMonitor() {
  global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }

  if (!canPost('reddit')) {
    if (shouldNotifyCap('reddit')) {
      await sendTelegramMessage('📊 Daily cap reached: reddit (20 actions). Resuming tomorrow.')
    }
    return
  }

  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchSubredditPosts(subreddit)

      for (const post of posts) {
        if (!canPost('reddit')) break
        if (!post?.id || await hasProcessedPost(post.id)) continue
        if (!isRecent(post.created_utc, 1)) continue

        const matchedKeywords = extractMatchedKeywords(`${post.title}\n${post.selftext || ''}`)
        const authorIsNew = !(await hasSeenAuthor(post.author))
        const intentScore = buildIntentScore(post, matchedKeywords, authorIsNew)
        if (intentScore < 55) continue

        const topComments = await fetchPostComments(post.permalink)
        const knowledgeContext = await searchKnowledgeBase(
          [
            post.title,
            post.selftext || '',
            topComments.slice(0, 5).map((item) => item.body).join('\n')
          ].join('\n'),
          8
        )

        const commentText = await generateWithSearch(
          buildCommentPrompt({ post, subreddit, topComments, knowledgeContext }),
          { maxOutputTokens: 1200 }
        )

        let dmText = ''
        if (authorIsNew) {
          dmText = await generate(
            buildDmPrompt({ post, subreddit, knowledgeContext }),
            { maxOutputTokens: 500 }
          )
        }

        await queuePostLead({
          post,
          subreddit,
          intentScore,
          matchedKeywords,
          commentText,
          dmText,
          topComments
        })
        incrementCap('reddit')

        await processCommenterLeads({ post, subreddit, comments: topComments, knowledgeContext })
      }
    } catch (error) {
      logger.error(`Reddit monitor failed for r/${subreddit}: ${error.message}`)
      global.runtimeState.health.errors.unshift({
        engine: 'reddit',
        message: `r/${subreddit}: ${error.message}`,
        at: new Date().toISOString()
      })
    }
  }

  const { count } = await supabase
    .from('scanned_content')
    .select('*', { count: 'exact', head: true })
    .eq('platform', 'reddit')
    .eq('acted_on', false)

  global.runtimeState.stats.redditPending = count || 0
  global.runtimeState.health.lastRuns.reddit = new Date().toISOString()
}
