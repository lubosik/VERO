import axios from 'axios'
import { config } from '../config.js'

function authHeader() {
  const token = Buffer.from(`${config.WP_USERNAME}:${config.WP_APP_PASSWORD}`).toString('base64')
  return `Basic ${token}`
}

export async function publishBlog({ title, content, metaDescription, slug, primaryKeyword }) {
  const { data } = await axios.post(
    `${config.WP_BASE_URL}/wp-json/wp/v2/posts`,
    {
      title,
      content,
      status: 'publish',
      slug,
      excerpt: metaDescription,
      meta: {
        _yoast_wpseo_metadesc: metaDescription,
        _yoast_wpseo_focuskw: primaryKeyword
      }
    },
    {
      headers: {
        Authorization: authHeader()
      },
      timeout: 20000
    }
  )

  return { id: data.id, link: data.link }
}
