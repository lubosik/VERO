import TelegramBot from 'node-telegram-bot-api'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { searchKnowledgeBase } from '../knowledge/loader.js'
import { generateWithSearch } from './llm.js'
import { publishBlog } from './wordpress.js'
import { logger } from '../utils/logger.js'

let bot = null
const awaitingBlogEdits = new Map()

function ensureBot() {
  if (!bot && config.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
      polling: {
        autoStart: true,
        params: { timeout: 10 }
      }
    })
  }
  return bot
}

function stripHtml(html = '') {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseMeta(html) {
  const meta = html.match(/<!--\s*META:\s*(.*?)\s*-->/i)?.[1] || ''
  const slug = html.match(/<!--\s*SLUG:\s*(.*?)\s*-->/i)?.[1] || ''
  const title = html.match(/<h1>(.*?)<\/h1>/i)?.[1] || slug || 'Untitled Draft'
  return { metaDescription: meta, slug, title }
}

function blogApprovalKeyboard(blogId) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve and Publish', callback_data: `blog_approve_${blogId}` },
        { text: '📝 Edit and Resubmit', callback_data: `blog_edit_${blogId}` },
        { text: '❌ Reject', callback_data: `blog_reject_${blogId}` }
      ]]
    }
  }
}

export async function sendTelegramMessage(text, options = {}) {
  const instance = ensureBot()
  if (!instance || !config.TELEGRAM_CHAT_ID) return null
  return instance.sendMessage(config.TELEGRAM_CHAT_ID, text, {
    disable_web_page_preview: true,
    ...options
  })
}

export async function sendTelegramDocument(content, filename, caption = '') {
  const instance = ensureBot()
  if (!instance || !config.TELEGRAM_CHAT_ID) return null
  return instance.sendDocument(
    config.TELEGRAM_CHAT_ID,
    Buffer.from(content, 'utf-8'),
    { caption },
    { filename, contentType: 'text/html' }
  )
}

async function sendBlogForReview(blog) {
  const preview = `${stripHtml(blog.content_html).slice(0, 400)}...`
  return sendTelegramMessage(
    `📝 Blog ready for review

Title: ${blog.title}
Keyword: ${blog.primary_keyword} (${blog.search_volume || blog.keyword_volume || 0}/mo)
Words: ~${blog.word_count || 0}

Preview:
"${preview}"`,
    blogApprovalKeyboard(blog.id)
  )
}

async function handleApproveBlog(blogId) {
  const { data: blog, error } = await supabase.from('blog_drafts').select('*').eq('id', blogId).single()
  if (error) throw error

  const published = await publishBlog({
    title: blog.title,
    content: blog.content_html,
    metaDescription: blog.meta_description,
    slug: blog.slug,
    primaryKeyword: blog.primary_keyword
  })

  await supabase
    .from('blog_drafts')
    .update({
      status: 'published',
      wordpress_post_id: String(published.id),
      published_url: published.link,
      updated_at: new Date().toISOString()
    })
    .eq('id', blogId)

  await supabase
    .from('keywords')
    .update({ last_used_at: new Date().toISOString(), used: true })
    .eq('keyword', blog.primary_keyword)

  await sendTelegramMessage(`✅ Blog published\n<a href="${published.link}">${blog.title}</a>`, {
    parse_mode: 'HTML'
  })
}

async function handleRejectBlog(blogId) {
  await supabase
    .from('blog_drafts')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', blogId)
  await sendTelegramMessage(`❌ Blog draft rejected (${blogId})`)
}

async function handleEditBlog(blogId) {
  const message = await sendTelegramMessage('Send me your edits as a reply to this message and I will regenerate the blog incorporating your feedback')
  if (message) {
    awaitingBlogEdits.set(message.message_id, blogId)
  }
}

async function regenerateBlogFromFeedback(blogId, feedback) {
  const { data: blog, error } = await supabase.from('blog_drafts').select('*').eq('id', blogId).single()
  if (error) throw error

  const knowledgeContext = await searchKnowledgeBase(
    [blog.primary_keyword, ...(blog.secondary_keywords || []), feedback].join('\n'),
    10
  )

  const regenerated = await generateWithSearch(
    `You are revising an existing peptide research blog draft.
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.

Original draft:
${blog.content_html}

Editor feedback:
${feedback}

Relevant knowledge base:
${knowledgeContext}

Keep the output as HTML article body only.
Preserve the article structure with:
<!-- META: ... -->
<!-- SLUG: ... -->
<article>...</article>

Keep the primary keyword "${blog.primary_keyword}" central.
Incorporate the feedback precisely while keeping the post publication-ready.
Output only the final HTML.`,
    { maxOutputTokens: 4096 }
  )

  const { metaDescription, slug, title } = parseMeta(regenerated)
  const wordCount = stripHtml(regenerated).split(/\s+/).filter(Boolean).length

  const { data: updated, error: updateError } = await supabase
    .from('blog_drafts')
    .update({
      title,
      slug,
      content_html: regenerated,
      meta_description: metaDescription,
      word_count: wordCount,
      status: 'pending',
      updated_at: new Date().toISOString()
    })
    .eq('id', blogId)
    .select()
    .single()

  if (updateError) throw updateError

  await sendBlogForReview(updated)
  await sendTelegramDocument(regenerated, `${slug || 'blog-draft'}.html`, `Preview: ${title}`)
}

async function markAuthorsSeen(platform, usernames = []) {
  const rows = usernames
    .filter(Boolean)
    .map((username) => ({ platform, username }))

  if (!rows.length) return

  const { error } = await supabase.from('seen_authors').upsert(rows, { onConflict: 'platform,username' })
  if (error && !String(error.message || '').includes('seen_authors')) throw error
}

async function regenerateQueuedComment(row) {
  const knowledgeContext = await searchKnowledgeBase(
    [row.title, row.body, JSON.stringify(row.metadata || {})].join('\n'),
    8
  )

  return generateWithSearch(
    `Rewrite this manual outreach comment so it still sounds like a real person on ${row.platform}, but with a fresh angle.
Never use em dashes in any output. Use commas, periods, or rewrite the sentence instead.
No bullet points. No numbered lists. Plain natural human writing only.

Title: ${row.title}
Body: ${row.body}
Existing metadata: ${JSON.stringify(row.metadata || {})}

Relevant knowledge base:
${knowledgeContext}

Current comment:
${row.generated_comment}

Output only the revised comment text.`,
    { maxOutputTokens: 700 }
  )
}

async function handleQueueAction(platform, action, contentId) {
  const { data: row, error } = await supabase
    .from('scanned_content')
    .select('*')
    .eq('platform', platform)
    .or(`content_id.eq.${contentId},external_id.eq.${contentId}`)
    .single()

  if (error) throw error

  if (action === 'regen') {
    const regenerated = await regenerateQueuedComment(row)
    await supabase
      .from('scanned_content')
      .update({
        generated_comment: regenerated,
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id)
    await sendTelegramMessage(`🔄 Regenerated ${platform} comment:\n${regenerated}`)
    return
  }

  if (action === 'done' || action === 'posted') {
    const dmTargets = [
      row.metadata?.author,
      ...(row.metadata?.commenter_authors || [])
    ]
    await markAuthorsSeen(platform, dmTargets)
  }

  await supabase
    .from('scanned_content')
    .update({ acted_on: true, updated_at: new Date().toISOString() })
    .eq('id', row.id)
}

export async function initTelegram() {
  const instance = ensureBot()
  if (!instance) return null

  instance.on('polling_error', (error) => {
    if (String(error?.message || '').includes('409 Conflict')) {
      logger.warn('Telegram polling conflict detected, likely from a previous Railway instance during deploy')
      return
    }
    logger.error(`Telegram polling error: ${error.message}`)
  })

  instance.onText(/^\/status$/, async (msg) => {
    const uptimeMinutes = Math.floor(process.uptime() / 60)
    const commentsToday = global.runtimeState?.youtube?.commentsToday || 0
    const blogsPending = global.runtimeState?.stats?.blogsPending || 0
    const redditQueue = global.runtimeState?.stats?.redditPending || 0
    await instance.sendMessage(
      msg.chat.id,
      `VERO status\nUptime: ${uptimeMinutes}m\nYouTube comments today: ${commentsToday}\nPending blogs: ${blogsPending}\nReddit queue: ${redditQueue}`
    )
  })

  instance.onText(/^\/pause$/, async (msg) => {
    global.enginePausedUntil = Date.now() + 1000 * 60 * 60 * 2
    await instance.sendMessage(msg.chat.id, 'YouTube engine paused for 2 hours.')
  })

  instance.onText(/^\/resume$/, async (msg) => {
    global.enginePausedUntil = 0
    await instance.sendMessage(msg.chat.id, 'YouTube engine resumed.')
  })

  instance.onText(/^\/reddit$/, async (msg) => {
    global.runRedditNow = true
    await instance.sendMessage(msg.chat.id, 'Reddit scan flagged for immediate execution.')
  })

  instance.onText(/^\/kb$/, async (msg) => {
    const { data } = await supabase
      .from('knowledge_docs')
      .select('name, word_count')
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
    const text = (data || []).map((doc) => `• ${doc.name} (${doc.word_count || 0} words)`).join('\n') || 'No KB docs loaded.'
    await instance.sendMessage(msg.chat.id, text)
  })

  instance.on('message', async (msg) => {
    const replyId = msg.reply_to_message?.message_id
    if (!replyId || !awaitingBlogEdits.has(replyId) || !msg.text?.trim()) return

    const blogId = awaitingBlogEdits.get(replyId)
    awaitingBlogEdits.delete(replyId)

    try {
      await instance.sendMessage(msg.chat.id, 'Regenerating the draft with your notes...')
      await regenerateBlogFromFeedback(blogId, msg.text.trim())
    } catch (error) {
      logger.error(`Blog regeneration failed: ${error.message}`)
      await instance.sendMessage(msg.chat.id, `Regeneration failed: ${error.message}`)
    }
  })

  instance.on('callback_query', async (query) => {
    try {
      const data = query.data || ''
      if (data.startsWith('blog_approve_')) await handleApproveBlog(data.replace('blog_approve_', ''))
      if (data.startsWith('blog_reject_')) await handleRejectBlog(data.replace('blog_reject_', ''))
      if (data.startsWith('blog_edit_')) await handleEditBlog(data.replace('blog_edit_', ''))
      if (data.startsWith('reddit_done_')) await handleQueueAction('reddit', 'done', data.replace('reddit_done_', ''))
      if (data.startsWith('reddit_skip_')) await handleQueueAction('reddit', 'skip', data.replace('reddit_skip_', ''))
      if (data.startsWith('looksmax_done_')) await handleQueueAction('looksmaxxing', 'done', data.replace('looksmax_done_', ''))
      if (data.startsWith('looksmax_skip_')) await handleQueueAction('looksmaxxing', 'skip', data.replace('looksmax_skip_', ''))
      if (data.startsWith('tiktok_posted_')) await handleQueueAction('tiktok', 'posted', data.replace('tiktok_posted_', ''))
      if (data.startsWith('tiktok_regen_')) await handleQueueAction('tiktok', 'regen', data.replace('tiktok_regen_', ''))
      if (data.startsWith('tiktok_skip_')) await handleQueueAction('tiktok', 'skip', data.replace('tiktok_skip_', ''))
      await instance.answerCallbackQuery(query.id)
    } catch (error) {
      logger.error(`Telegram callback failed: ${error.message}`)
      await instance.answerCallbackQuery(query.id, { text: 'Action failed.' })
    }
  })

  logger.info('Telegram bot ready')
  return instance
}

export function getTelegramBot() {
  return bot
}
