import cron from 'node-cron'
import { ensureKnowledgeBaseIndexed, loadKnowledgeBase } from './knowledge/loader.js'
import { runYouTubeEngine } from './engines/youtubeEngine.js'
import { runBlogEngine } from './engines/blogEngine.js'
import { runRedditMonitor } from './engines/redditMonitor.js'
import { runLooksmaxxMonitor } from './engines/looksmaxxMonitor.js'
import { runTikTokMonitor } from './engines/tiktokMonitor.js'
import { startDashboard } from './dashboard/server.js'
import { initTelegram } from './services/telegram.js'
import { getTikTokHashtagTrends } from './services/tiktok.js'
import { getCaps, resetAllCaps } from './utils/dailyCap.js'
import { ensureRuntimeMetrics, resetRuntimeMetrics, trackMetric } from './utils/runtimeMetrics.js'
import { logger } from './utils/logger.js'

async function safeRun(name, runner) {
  try {
    await runner()
  } catch (error) {
    global.runtimeState ||= { youtube: { commentsToday: 0 }, stats: {}, health: { lastRuns: {}, errors: [] } }
    ensureRuntimeMetrics()
    global.runtimeState.health.errors.unshift({
      engine: name,
      message: error.message,
      at: new Date().toISOString()
    })
    const metricKey = name === 'knowledge-base' ? 'knowledgeBase' : name
    trackMetric(metricKey, { errors: 1, lastError: error.message })
    logger.error(`${name} run failed: ${error.stack || error.message}`)
  }
}

async function main() {
  global.runtimeState = {
    youtube: { commentsToday: 0 },
    stats: {},
    health: { lastRuns: {}, errors: [] }
  }
  ensureRuntimeMetrics()
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

  cron.schedule('*/45 * * * *', async () => {
    await safeRun('reddit', runRedditMonitor)
  })

  cron.schedule('0 * * * *', async () => {
    await safeRun('looksmaxxing', runLooksmaxxMonitor)
  })

  cron.schedule('0 */3 * * *', async () => {
    await safeRun('tiktok', runTikTokMonitor)
  })

  cron.schedule('0 8 * * 6', async () => {
    await safeRun('tiktok-trends', getTikTokHashtagTrends)
  })

  cron.schedule('0 9 * * 0', async () => {
    await safeRun('blog', runBlogEngine)
  })

  cron.schedule('0 0 * * *', async () => {
    resetAllCaps()
    resetRuntimeMetrics()
    ensureRuntimeMetrics()
    global.runtimeState.youtube.commentsToday = getCaps().youtube.count
    logger.info('Daily caps reset')
  })

  logger.info('VERO online.')

  setTimeout(() => {
    safeRun('youtube', runYouTubeEngine)
    safeRun('reddit', runRedditMonitor)
    safeRun('looksmaxxing', runLooksmaxxMonitor)
    safeRun('tiktok', runTikTokMonitor)
  }, 2000)
}

main().catch((error) => {
  logger.error(`Fatal: ${error.stack || error.message}`)
  process.exit(1)
})
