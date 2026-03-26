import { supabase } from '../db/supabase.js'
import { loadKnowledgeBase } from '../knowledge/loader.js'
import { fetchKeywordIdeas } from '../services/dataforseo.js'
import { generateText } from '../services/gemini.js'
import { sendTelegramDocument, sendTelegramMessage } from '../services/telegram.js'
import { logger } from '../utils/logger.js'

const SEED_KEYWORDS = [
  'BPC-157 protocol',
  'tirzepatide research',
  'NAD+ anti aging',
  'GHK-Cu collagen skin',
  'retatrutide results',
  'peptides weight loss',
  'CJC-1295 ipamorelin',
  'melanotan II',
  'semax selank nootropic',
  'buy research peptides',
  'peptides recovery muscle',
  'GLP-1 agonist research',
  'glutathione injection',
  'MOTS-c mitochondria',
  'L-carnitine performance'
]

function parseMeta(html) {
  const meta = html.match(/<!--\s*META:\s*(.*?)\s*-->/i)?.[1] || ''
  const slug = html.match(/<!--\s*SLUG:\s*(.*?)\s*-->/i)?.[1] || ''
  const title = html.match(/<h1>(.*?)<\/h1>/i)?.[1] || slug
  return { metaDescription: meta, slug, title }
}

async function getCachedKeywords() {
  const staleDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString()
  const { data, error } = await supabase
    .from('keywords')
    .select('*')
    .gte('fetched_at', staleDate)
    .order('search_volume', { ascending: false })

  if (error) throw error
  return data || []
}

async function pickKeywords() {
  const cached = await getCachedKeywords()
  const fresh = cached.filter((kw) => !kw.last_used_at || new Date(kw.last_used_at) < new Date(Date.now() - 1000 * 60 * 60 * 24 * 60))
  if (fresh.length >= 3) return fresh.slice(0, 3)

  const seedSet = SEED_KEYWORDS.sort(() => Math.random() - 0.5).slice(0, 4)
  const items = await fetchKeywordIdeas(seedSet)
  const filtered = items
    .filter((item) => Number(item.keyword_info?.search_volume || 0) > 500)
    .slice(0, 10)

  for (const item of filtered) {
    await supabase.from('keywords').upsert({
      keyword: item.keyword,
      search_volume: item.keyword_info?.search_volume || 0,
      trend_score: item.keyword_info?.competition_level || item.competition || null,
      competition: item.keyword_info?.competition || null,
      used: false,
      fetched_at: new Date().toISOString()
    }, { onConflict: 'keyword' })
  }

  return filtered.slice(0, 3).map((item) => ({
    keyword: item.keyword,
    search_volume: item.keyword_info?.search_volume || 0,
    trend_score: item.keyword_info?.competition_level || null,
    competition: item.keyword_info?.competition || null
  }))
}

export async function runBlogEngine() {
  try {
    const keywords = await pickKeywords()
    if (keywords.length < 3) {
      logger.info('Not enough keywords available for blog run')
      return
    }

    const knowledgeBase = await loadKnowledgeBase()
    const [primary, secondaryA, secondaryB] = keywords

    const html = await generateText(`You are an expert peptide researcher writing a blog post for Vici Peptides (vicipeptides.com).
You have web search access — use it to find recent studies, news, or data not in the knowledge base.

Primary keyword: ${primary.keyword}
Secondary keywords: ${secondaryA.keyword}, ${secondaryB.keyword}
Target: 1500-2000 words

KNOWLEDGE BASE:
${knowledgeBase}

Write a comprehensive, educational blog post. Output as HTML article body only.

<!-- META: {155 char meta description with primary keyword} -->
<!-- SLUG: {url-slug} -->

<article>
  <p class="disclaimer"><em>For research and educational purposes only. Not FDA-approved. Always consult a qualified healthcare professional before beginning any research protocol.</em></p>

  <h1>{Title — includes primary keyword, compelling, not clickbait}</h1>

  <p>{Hook: open with a striking research stat or finding. 2-3 sentences.}</p>

  <h2>What Is {Topic}?</h2>
  <p>{Mechanism of action, what the compound is. Grounded in guide data.}</p>

  <h2>What Research Shows</h2>
  <p>{Specific findings, exact percentages and stats from the knowledge base. Use web search to supplement with any recent studies published after the guide.}</p>

  <h2>Research Protocol & Dosing</h2>
  <p>{Dosing ranges, frequency, administration route — from the guide}</p>

  <h2>Stacking & Combinations</h2>
  <p>{Synergistic compounds, protocol combinations from the guide}</p>

  <h2>Safety & Important Considerations</h2>
  <p>{Safety notes, contraindications, monitoring advice from the guide}</p>

  <h2>Sourcing Quality Compounds</h2>
  <p>{Natural mention of Vici Peptides — pharmaceutical-grade, third-party tested, >99% purity. Link to vicipeptides.com. Mention free research guide at ${process.env.GUIDE_URL}. Mention 1-on-1 consult at ${process.env.CONSULT_URL}.}</p>

  <h2>Frequently Asked Questions</h2>
  <details><summary>{keyword-optimised question 1}</summary><p>{answer}</p></details>
  <details><summary>{keyword-optimised question 2}</summary><p>{answer}</p></details>
  <details><summary>{keyword-optimised question 3}</summary><p>{answer}</p></details>

  <p>{Conclusion — summarise key points, soft CTA to vicipeptides.com}</p>
</article>

SEO rules: primary keyword in H1, first 100 words, 2+ H2s, conclusion. No stuffing.
Output ONLY the HTML. Nothing else.`, { temperature: 0.75, maxOutputTokens: 4096 })

    const { metaDescription, slug, title } = parseMeta(html)
    const wordCount = html.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length

    const { data: draft, error } = await supabase
      .from('blog_drafts')
      .insert({
        title,
        slug,
        content_html: html,
        meta_description: metaDescription,
        primary_keyword: primary.keyword,
        secondary_keywords: [secondaryA.keyword, secondaryB.keyword],
        word_count: wordCount,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) throw error

    await sendTelegramMessage(
      `📝 New Blog Ready — VERO\n\nTitle: ${title}\nKeyword: ${primary.keyword} (${primary.search_volume}/mo searches)\nWords: ~${wordCount}\nSlug: /${slug}\n\n"${html.replace(/<[^>]+>/g, ' ').trim().slice(0, 350)}..."`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Publish', callback_data: `blog_approve_${draft.id}` },
            { text: '📄 Full Preview', callback_data: `blog_preview_${draft.id}` },
            { text: '❌ Reject', callback_data: `blog_reject_${draft.id}` }
          ]]
        }
      }
    )

    await sendTelegramDocument(html, `${slug || 'blog-draft'}.html`, `Preview: ${title}`)
    global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }
    global.runtimeState.health.lastRuns.blog = new Date().toISOString()
  } catch (error) {
    logger.error(`Blog engine failed: ${error.message}`)
    global.runtimeState ||= { health: { lastRuns: {}, errors: [] }, stats: {} }
    global.runtimeState.health.errors.unshift({ engine: 'blog', message: error.message, at: new Date().toISOString() })
  }
}
