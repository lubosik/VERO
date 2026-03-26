import { google } from 'googleapis'
import { config } from '../config.js'

const oauth2Client = new google.auth.OAuth2(
  config.YOUTUBE_OAUTH_CLIENT_ID,
  config.YOUTUBE_OAUTH_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
)

if (config.YOUTUBE_OAUTH_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: config.YOUTUBE_OAUTH_REFRESH_TOKEN
  })
}

const youtube = google.youtube({ version: 'v3', auth: oauth2Client })

export async function searchVideos(query, maxResults = 15) {
  const res = await youtube.search.list({
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
  const res = await youtube.videos.list({
    part: ['snippet', 'statistics', 'status'],
    id: [videoId]
  })
  return res.data.items?.[0] || null
}

export async function postComment(videoId, commentText) {
  const res = await youtube.commentThreads.insert({
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
