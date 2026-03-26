import { supabase } from '../db/supabase.js'

export async function hasExistingComment({ platform, videoId, externalId, channelId }) {
  let query = supabase.from('comments').select('id').eq('platform', platform).limit(1)

  if (videoId) query = query.eq('video_id', videoId)
  if (externalId) query = query.eq('external_id', externalId)
  if (channelId) query = query.eq('channel_id', channelId)

  const { data, error } = await query.maybeSingle()
  if (error && error.code !== 'PGRST116') throw error
  return Boolean(data)
}

export async function logComment(payload) {
  const { data, error } = await supabase.from('comments').insert(payload).select().single()
  if (error) throw error
  return data
}
