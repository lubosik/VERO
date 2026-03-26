import dotenv from 'dotenv'

dotenv.config()

function requireEnv(name, fallback = '') {
  return process.env[name] ?? fallback
}

export const config = {
  NODE_ENV: requireEnv('NODE_ENV', 'development'),
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: requireEnv('SUPABASE_SERVICE_KEY') || requireEnv('SUPABASE_SECRET_KEY'),
  YOUTUBE_API_KEY: requireEnv('YOUTUBE_API_KEY'),
  YOUTUBE_OAUTH_CLIENT_ID: requireEnv('YOUTUBE_OAUTH_CLIENT_ID'),
  YOUTUBE_OAUTH_CLIENT_SECRET: requireEnv('YOUTUBE_OAUTH_CLIENT_SECRET'),
  YOUTUBE_OAUTH_REFRESH_TOKEN: requireEnv('YOUTUBE_OAUTH_REFRESH_TOKEN'),
  GEMINI_API_KEY: requireEnv('GEMINI_API_KEY'),
  GROQ_API_KEY: requireEnv('GROQ_API_KEY'),
  TELEGRAM_BOT_TOKEN: requireEnv('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: requireEnv('TELEGRAM_CHAT_ID'),
  WP_BASE_URL: requireEnv('WP_BASE_URL'),
  WP_USERNAME: requireEnv('WP_USERNAME'),
  WP_APP_PASSWORD: requireEnv('WP_APP_PASSWORD'),
  DATAFORSEO_AUTH: requireEnv('DATAFORSEO_AUTH'),
  APIFY_API_KEY: requireEnv('APIFY_API_KEY'),
  DASHBOARD_PORT: Number(requireEnv('DASHBOARD_PORT', '3000')),
  DASHBOARD_SECRET: requireEnv('DASHBOARD_SECRET'),
  REDDIT_CLIENT_ID: requireEnv('REDDIT_CLIENT_ID'),
  REDDIT_CLIENT_SECRET: requireEnv('REDDIT_CLIENT_SECRET'),
  REDDIT_USERNAME: requireEnv('REDDIT_USERNAME'),
  REDDIT_PASSWORD: requireEnv('REDDIT_PASSWORD'),
  BRAND_URL: requireEnv('BRAND_URL'),
  CONSULT_URL: requireEnv('CONSULT_URL'),
  GUIDE_URL: requireEnv('GUIDE_URL')
}

export function hasRedditApiCredentials() {
  return Boolean(
    config.REDDIT_CLIENT_ID &&
      config.REDDIT_CLIENT_SECRET &&
      config.REDDIT_USERNAME &&
      config.REDDIT_PASSWORD
  )
}
