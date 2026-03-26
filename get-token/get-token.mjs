import 'dotenv/config'
import http from 'http'
import { google } from 'googleapis'

const CLIENT_ID = process.env.YOUTUBE_OAUTH_CLIENT_ID
const CLIENT_SECRET = process.env.YOUTUBE_OAUTH_CLIENT_SECRET
const REDIRECT_URI = process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'http://localhost:3001/oauth/callback'
const PORT = 3001
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube'
]

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET before running.')
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES
})

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth/callback')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  try {
    const url = new URL(req.url, REDIRECT_URI)
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing code')
      return
    }

    const { tokens } = await oauth2Client.getToken(code)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Authorization received. Return to the terminal.')

    console.log('\nYOUTUBE_OAUTH_REFRESH_TOKEN=')
    console.log(tokens.refresh_token || 'No refresh token returned. Re-run and ensure prompt=consent is used.')
    console.log('\nFull token payload:')
    console.log(JSON.stringify(tokens, null, 2))
  } catch (error) {
    console.error('OAuth exchange failed:', error.message)
  } finally {
    setTimeout(() => server.close(), 500)
  }
})

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`)
  console.log('\nOpen this URL in your browser:\n')
  console.log(authUrl)
  console.log('\nWaiting for OAuth callback...')
})
