import { google } from 'googleapis'
import { config } from '../config.js'

const oauth2Client = new google.auth.OAuth2(
  config.YOUTUBE_OAUTH_CLIENT_ID,
  config.YOUTUBE_OAUTH_CLIENT_SECRET,
  config.YOUTUBE_OAUTH_REDIRECT_URI
)

if (config.YOUTUBE_OAUTH_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: config.YOUTUBE_OAUTH_REFRESH_TOKEN
  })
}

const youtubeRead = google.youtube({ version: 'v3', auth: config.YOUTUBE_API_KEY })
const youtubeWrite = google.youtube({ version: 'v3', auth: oauth2Client })

export async function searchVideos(query, maxResults = 15) {
  const res = await youtubeRead.search.list({
    part: ['snippet'],
    q: query,
    type: ['video'],
    order: 'date',
    maxResults,
    relevanceLanguage: 'en',
    videoDuration: 'medium'
  })

  return res.data.items || []
}

export async function getVideoDetails(videoId) {
  const res = await youtubeRead.videos.list({
    part: ['snippet', 'statistics', 'status'],
    id: [videoId]
  })
  return res.data.items?.[0] || null
}

export async function postComment(videoId, commentText) {
  const res = await youtubeWrite.commentThreads.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: { textOriginal: commentText }
        }
      }
    }
  })

  return res.data
}
