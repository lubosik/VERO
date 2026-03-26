import TelegramBot from 'node-telegram-bot-api'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { publishBlog } from './wordpress.js'
import { logger } from '../utils/logger.js'

let bot = null

function ensureBot() {
  if (!bot && config.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true })
  }
  return bot
}

export async function sendTelegramMessage(text, options = {}) {
  const instance = ensureBot()
  if (!instance || !config.TELEGRAM_CHAT_ID) return null
  return instance.sendMessage(config.TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
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

  await sendTelegramMessage(`✅ Blog published\n<a href="${published.link}">${blog.title}</a>`)
}

async function handleRejectBlog(blogId) {
  await supabase
    .from('blog_drafts')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', blogId)
  await sendTelegramMessage(`❌ Blog draft rejected (${blogId})`)
}

async function handleRedditAction(action, id) {
  if (action === 'posted') {
    await supabase.from('comments').insert({
      platform: 'reddit',
      external_id: id,
      status: 'manually_posted',
      created_at: new Date().toISOString()
    })
  }

  const actedOn = action !== 'regen'
  await supabase
    .from('scanned_content')
    .update({ acted_on: actedOn, updated_at: new Date().toISOString() })
    .eq('external_id', id)

  if (action === 'regen') {
    await sendTelegramMessage(`🔄 Regeneration requested for Reddit opportunity ${id}`)
  }
}

export async function initTelegram() {
  const instance = ensureBot()
  if (!instance) return null

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

  instance.on('callback_query', async (query) => {
    try {
      const data = query.data || ''
      if (data.startsWith('blog_approve_')) await handleApproveBlog(data.replace('blog_approve_', ''))
      if (data.startsWith('blog_reject_')) await handleRejectBlog(data.replace('blog_reject_', ''))
      if (data.startsWith('blog_preview_')) {
        const id = data.replace('blog_preview_', '')
        const { data: blog } = await supabase.from('blog_drafts').select('*').eq('id', id).single()
        if (blog) await sendTelegramDocument(blog.content_html, `${blog.slug || 'blog-draft'}.html`, blog.title)
      }
      if (data.startsWith('reddit_posted_')) await handleRedditAction('posted', data.replace('reddit_posted_', ''))
      if (data.startsWith('reddit_regen_')) await handleRedditAction('regen', data.replace('reddit_regen_', ''))
      if (data.startsWith('reddit_skip_')) await handleRedditAction('skip', data.replace('reddit_skip_', ''))
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
