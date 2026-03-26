import cron from 'node-cron'
import { loadKnowledgeBase } from './knowledge/loader.js'
import { runYouTubeEngine } from './engines/youtubeEngine.js'
import { runBlogEngine } from './engines/blogEngine.js'
import { runRedditMonitor } from './engines/redditMonitor.js'
import { startDashboard } from './dashboard/server.js'
import { initTelegram } from './services/telegram.js'
import { logger } from './utils/logger.js'

async function main() {
  global.runtimeState = {
    youtube: { commentsToday: 0 },
    stats: {},
    health: { lastRuns: {}, errors: [] }
  }
  global.enginePausedUntil = 0

  logger.info('VERO starting up...')
  await loadKnowledgeBase()
  logger.info('Knowledge base ready')

  await initTelegram()
  await startDashboard()

  cron.schedule('0 */2 * * *', async () => {
    if (!global.enginePausedUntil || global.enginePausedUntil <= Date.now()) {
      await runYouTubeEngine()
    }
  })

  cron.schedule('0 * * * *', async () => {
    await runRedditMonitor()
  })

  cron.schedule('0 9 * * 0', async () => {
    await runBlogEngine()
  })

  await runYouTubeEngine()
  await runRedditMonitor()

  logger.info('VERO online.')
}

main().catch((error) => {
  logger.error(`Fatal: ${error.stack || error.message}`)
  process.exit(1)
})
