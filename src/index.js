import cron from 'node-cron'
import { ensureKnowledgeBaseIndexed, loadKnowledgeBase } from './knowledge/loader.js'
import { runYouTubeEngine } from './engines/youtubeEngine.js'
import { runBlogEngine } from './engines/blogEngine.js'
import { runRedditMonitor } from './engines/redditMonitor.js'
import { startDashboard } from './dashboard/server.js'
import { initTelegram } from './services/telegram.js'
import { logger } from './utils/logger.js'

async function safeRun(name, runner) {
  try {
    await runner()
  } catch (error) {
    global.runtimeState ||= { youtube: { commentsToday: 0 }, stats: {}, health: { lastRuns: {}, errors: [] } }
    global.runtimeState.health.errors.unshift({
      engine: name,
      message: error.message,
      at: new Date().toISOString()
    })
    logger.error(`${name} run failed: ${error.stack || error.message}`)
  }
}

async function main() {
  global.runtimeState = {
    youtube: { commentsToday: 0 },
    stats: {},
    health: { lastRuns: {}, errors: [] }
  }
  global.enginePausedUntil = 0
  const version = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'local'

  logger.info(`VERO starting up... version=${version}`)
  await startDashboard()

  await safeRun('knowledge-base', async () => {
    await loadKnowledgeBase()
    await ensureKnowledgeBaseIndexed()
    logger.info('Knowledge base ready')
  })

  await safeRun('telegram', async () => {
    await initTelegram()
  })

  cron.schedule('0 */2 * * *', async () => {
    if (!global.enginePausedUntil || global.enginePausedUntil <= Date.now()) {
      await safeRun('youtube', runYouTubeEngine)
    }
  })

  cron.schedule('0 * * * *', async () => {
    await safeRun('reddit', runRedditMonitor)
  })

  cron.schedule('0 9 * * 0', async () => {
    await safeRun('blog', runBlogEngine)
  })

  logger.info('VERO online.')

  setTimeout(() => {
    safeRun('youtube', runYouTubeEngine)
    safeRun('reddit', runRedditMonitor)
  }, 2000)
}

main().catch((error) => {
  logger.error(`Fatal: ${error.stack || error.message}`)
  process.exit(1)
})
