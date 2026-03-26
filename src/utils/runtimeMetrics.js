function baseMetrics() {
  return {
    processed: 0,
    queued: 0,
    posted: 0,
    staleSkipped: 0,
    capSkipped: 0,
    errors: 0,
    lastItem: null,
    lastError: null
  }
}

export function ensureRuntimeMetrics() {
  global.runtimeState ||= { youtube: { commentsToday: 0 }, stats: {}, health: { lastRuns: {}, errors: [] } }
  global.runtimeState.metrics ||= {
    youtube: baseMetrics(),
    reddit: baseMetrics(),
    looksmaxxing: baseMetrics(),
    tiktok: baseMetrics(),
    blog: baseMetrics(),
    knowledgeBase: baseMetrics()
  }
  return global.runtimeState.metrics
}

export function trackMetric(platform, patch = {}) {
  const metrics = ensureRuntimeMetrics()
  const current = metrics[platform] || baseMetrics()
  metrics[platform] = {
    ...current,
    processed: current.processed + (patch.processed || 0),
    queued: current.queued + (patch.queued || 0),
    posted: current.posted + (patch.posted || 0),
    staleSkipped: current.staleSkipped + (patch.staleSkipped || 0),
    capSkipped: current.capSkipped + (patch.capSkipped || 0),
    errors: current.errors + (patch.errors || 0),
    lastItem: patch.lastItem ?? current.lastItem,
    lastError: patch.lastError ?? current.lastError
  }
  return metrics[platform]
}

export function resetRuntimeMetrics() {
  if (!global.runtimeState) return
  global.runtimeState.metrics = {
    youtube: baseMetrics(),
    reddit: baseMetrics(),
    looksmaxxing: baseMetrics(),
    tiktok: baseMetrics(),
    blog: baseMetrics(),
    knowledgeBase: baseMetrics()
  }
}
