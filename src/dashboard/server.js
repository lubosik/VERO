import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { supabase } from '../db/supabase.js'
import { ingestDocument, loadKnowledgeBase } from '../knowledge/loader.js'
import { publishBlog } from '../services/wordpress.js'
import { getCaps } from '../utils/dailyCap.js'
import { logger } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const upload = multer({ storage: multer.memoryStorage() })

function authMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next()
  const header = req.headers.authorization || ''
  const token = header.replace(/^Bearer\s+/i, '')
  if (!token || token !== config.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

async function getStats() {
  const [{ count: comments24h }, { count: kbDocs }, { count: redditPending }, { count: blogsPending }, { count: blogsPublished }] =
    await Promise.all([
      supabase.from('comments').select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86400000).toISOString()),
      supabase.from('knowledge_docs').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('scanned_content').select('*', { count: 'exact', head: true }).in('platform', ['reddit', 'looksmaxxing', 'tiktok']).eq('acted_on', false),
      supabase.from('blog_drafts').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('blog_drafts').select('*', { count: 'exact', head: true }).eq('status', 'published')
    ])

  return {
    youtubeComments24h: comments24h || 0,
    blogsPublished: blogsPublished || 0,
    redditAlertsPending: redditPending || 0,
    kbDocuments: kbDocs || 0,
    blogsPending: blogsPending || 0
  }
}

export async function startDashboard() {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '4mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(authMiddleware)
  app.use(express.static(path.join(__dirname, 'public')))

  app.get('/api/stats', async (_req, res) => {
    res.json(await getStats())
  })

  app.get('/api/version', async (_req, res) => {
    res.json({
      version: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'local'
    })
  })

  app.get('/api/comments', async (req, res) => {
    const limit = Number(req.query.limit || 50)
    const offset = Number(req.query.offset || 0)
    const [{ data: comments, error }, { data: manualQueue, error: queueError }] = await Promise.all([
      supabase
      .from('comments')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
      supabase
        .from('scanned_content')
        .select('*')
        .in('platform', ['reddit', 'looksmaxxing', 'tiktok'])
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
    ])
    if (error) return res.status(500).json({ error: error.message })
    if (queueError) return res.status(500).json({ error: queueError.message })

    const mappedQueue = (manualQueue || []).map((item) => ({
      platform: item.platform,
      content_title: item.title,
      comment_text: item.generated_comment,
      naturalness_score: item.intent_score,
      created_at: item.created_at,
      status: item.acted_on ? 'acted_on' : 'queued'
    }))

    const merged = [...(comments || []), ...mappedQueue]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, limit)

    res.json(merged)
  })

  app.get('/api/blogs', async (_req, res) => {
    const { data, error } = await supabase.from('blog_drafts').select('*').order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.get('/api/keywords', async (_req, res) => {
    const { data, error } = await supabase.from('keywords').select('*').order('search_volume', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.get('/api/kb', async (_req, res) => {
    const { data, error } = await supabase.from('knowledge_docs').select('*').order('uploaded_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    const docIds = (data || []).map((item) => item.id)
    let chunkCounts = new Map()

    if (docIds.length) {
      const { data: chunks } = await supabase.from('knowledge_chunks').select('doc_id').in('doc_id', docIds)
      chunkCounts = new Map()
      for (const chunk of chunks || []) {
        chunkCounts.set(chunk.doc_id, (chunkCounts.get(chunk.doc_id) || 0) + 1)
      }
    }

    res.json(
      (data || []).map((item) => {
        const chunkCount = chunkCounts.get(item.id) || 0
        const indexingStatus = chunkCount === 0 ? 'pending' : 'lexical'

        return {
          ...item,
          chunk_count: chunkCount,
          indexing_status: indexingStatus
        }
      })
    )
  })

  app.post('/api/kb/ingest', upload.single('file'), async (req, res) => {
    try {
      const type = req.body.type
      const name = req.body.name
      if (!type || !name) return res.status(400).json({ error: 'type and name are required' })

      const result = await ingestDocument({
        name,
        sourceType: type,
        sourceUrl: req.body.url,
        buffer: req.file?.buffer || Buffer.from(req.body.content || '', 'utf-8')
      })
      await loadKnowledgeBase(true)
      res.json({ ok: true, ...result })
    } catch (error) {
      logger.error(`KB ingest failed: ${error.stack || error.message}`)
      res.status(400).json({ error: error.message })
    }
  })

  app.delete('/api/kb/:id', async (req, res) => {
    const { error } = await supabase.from('knowledge_docs').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    await loadKnowledgeBase(true)
    res.json({ ok: true })
  })

  app.patch('/api/kb/:id/toggle', async (req, res) => {
    const { data: current } = await supabase.from('knowledge_docs').select('active').eq('id', req.params.id).single()
    const { data, error } = await supabase
      .from('knowledge_docs')
      .update({ active: !current?.active })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    await loadKnowledgeBase(true)
    res.json(data)
  })

  app.get('/api/reddit-queue', async (_req, res) => {
    const { data, error } = await supabase
      .from('scanned_content')
      .select('*')
      .in('platform', ['reddit', 'looksmaxxing'])
      .eq('acted_on', false)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.get('/api/health', async (_req, res) => {
    res.json({
      uptime: process.uptime(),
      paused: Boolean(global.enginePausedUntil && global.enginePausedUntil > Date.now()),
      lastRuns: global.runtimeState?.health?.lastRuns || {},
      youtubeQuotaUsedToday: getCaps().youtube.count,
      recentErrors: global.runtimeState?.health?.errors?.slice(0, 20) || [],
      instagram: 'Handled via ManyChat (external)',
      metrics: global.runtimeState?.metrics || {}
    })
  })

  app.get('/api/caps', async (_req, res) => {
    res.json(getCaps())
  })

  app.post('/api/blog/:id/approve', async (req, res) => {
    const { data: blog, error } = await supabase.from('blog_drafts').select('*').eq('id', req.params.id).single()
    if (error) return res.status(500).json({ error: error.message })
    const published = await publishBlog({
      title: blog.title,
      content: blog.content_html,
      metaDescription: blog.meta_description,
      slug: blog.slug,
      primaryKeyword: blog.primary_keyword
    })
    await supabase
      .from('blog_drafts')
      .update({ status: 'published', published_url: published.link, wordpress_post_id: String(published.id), updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
    res.json(published)
  })

  app.post('/api/blog/:id/reject', async (req, res) => {
    const { error } = await supabase
      .from('blog_drafts')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  app.post('/api/engine/pause', async (_req, res) => {
    global.enginePausedUntil = Date.now() + 1000 * 60 * 60 * 2
    res.json({ ok: true })
  })

  app.post('/api/engine/resume', async (_req, res) => {
    global.enginePausedUntil = 0
    res.json({ ok: true })
  })

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  })

  return new Promise((resolve) => {
    const port = config.DASHBOARD_PORT || config.PORT
    app.listen(port, () => {
      logger.info(`Dashboard listening on ${port}`)
      resolve(app)
    })
  })
}
