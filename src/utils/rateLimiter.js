const buckets = new Map()

export function canRun(key, windowMs, limit = 1) {
  const now = Date.now()
  const entries = (buckets.get(key) || []).filter((ts) => now - ts < windowMs)
  buckets.set(key, entries)
  return entries.length < limit
}

export function recordRun(key) {
  const entries = buckets.get(key) || []
  entries.push(Date.now())
  buckets.set(key, entries)
}

export function getRecentCount(key, windowMs) {
  const now = Date.now()
  return (buckets.get(key) || []).filter((ts) => now - ts < windowMs).length
}
