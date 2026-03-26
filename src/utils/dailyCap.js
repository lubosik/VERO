const CAPS = {
  youtube: 12,
  reddit: 20,
  looksmaxxing: 15,
  tiktok: 15
}

let counts = {
  youtube: 0,
  reddit: 0,
  looksmaxxing: 0,
  tiktok: 0
}

const notified = new Set()

export function canPost(platform) {
  return (counts[platform] || 0) < (CAPS[platform] || Number.MAX_SAFE_INTEGER)
}

export function incrementCap(platform) {
  counts[platform] = (counts[platform] || 0) + 1
  return {
    count: counts[platform],
    cap: CAPS[platform] || null,
    reached: (counts[platform] || 0) >= (CAPS[platform] || Number.MAX_SAFE_INTEGER)
  }
}

export function getCaps() {
  return Object.fromEntries(
    Object.keys(CAPS).map((platform) => [platform, { count: counts[platform] || 0, cap: CAPS[platform] }])
  )
}

export function resetAllCaps() {
  counts = {
    youtube: 0,
    reddit: 0,
    looksmaxxing: 0,
    tiktok: 0
  }
  notified.clear()
}

export function shouldNotifyCap(platform) {
  if (canPost(platform) || notified.has(platform)) return false
  notified.add(platform)
  return true
}
