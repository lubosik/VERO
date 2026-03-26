import { logger } from './logger.js'

export function isRecent(timestamp, maxAgeDays = 14) {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    logger.warn('recencyCheck: unparseable timestamp, rejecting')
    return false
  }

  let date = null

  if (typeof timestamp === 'number') {
    if (timestamp < 9999999999) {
      if (timestamp <= 24 * maxAgeDays + 24) return timestamp / 24 <= maxAgeDays
      date = new Date(timestamp * 1000)
    } else {
      date = new Date(timestamp)
    }
  } else if (typeof timestamp === 'string') {
    const numeric = Number(timestamp)
    if (!Number.isNaN(numeric) && timestamp.trim() !== '') {
      return isRecent(numeric, maxAgeDays)
    }
    date = new Date(timestamp)
  } else if (timestamp instanceof Date) {
    date = timestamp
  }

  if (!date || Number.isNaN(date.getTime())) {
    logger.warn('recencyCheck: unparseable timestamp, rejecting')
    return false
  }

  const ageDays = (Date.now() - date.getTime()) / 86400000
  return ageDays <= maxAgeDays
}
