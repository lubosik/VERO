CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS content_title TEXT,
  ADD COLUMN IF NOT EXISTS comment_text TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE comments
SET
  content_title = COALESCE(content_title, video_title, post_id),
  comment_text = COALESCE(comment_text, comment_body),
  external_id = COALESCE(external_id, post_id, video_id),
  created_at = COALESCE(created_at, posted_at)
WHERE
  content_title IS NULL
  OR comment_text IS NULL
  OR external_id IS NULL
  OR created_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS comments_platform_video_external_uniq
ON comments (platform, COALESCE(video_id, external_id));

ALTER TABLE scanned_content
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS url TEXT,
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS subreddit TEXT,
  ADD COLUMN IF NOT EXISTS generated_comment TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE scanned_content
SET
  external_id = COALESCE(external_id, content_id),
  url = COALESCE(url, content_url),
  created_at = COALESCE(created_at, scanned_at)
WHERE
  external_id IS NULL
  OR url IS NULL
  OR created_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scanned_content_external_id_uniq
ON scanned_content (external_id);

CREATE TABLE IF NOT EXISTS seen_authors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, username)
);

ALTER TABLE blog_drafts
  ADD COLUMN IF NOT EXISTS content_html TEXT,
  ADD COLUMN IF NOT EXISTS secondary_keywords TEXT[],
  ADD COLUMN IF NOT EXISTS wordpress_post_id TEXT,
  ADD COLUMN IF NOT EXISTS published_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE blog_drafts
SET
  content_html = COALESCE(content_html, content),
  wordpress_post_id = COALESCE(wordpress_post_id, wp_post_id::TEXT),
  published_url = COALESCE(published_url, wp_url)
WHERE
  content_html IS NULL
  OR wordpress_post_id IS NULL
  OR published_url IS NULL;

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;

UPDATE keywords
SET
  used = COALESCE(used, used_in_blog, FALSE),
  last_used_at = COALESCE(last_used_at, used_at),
  fetched_at = COALESCE(fetched_at, last_checked)
WHERE
  used IS NULL
  OR last_used_at IS NULL
  OR fetched_at IS NULL;

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  raw_content TEXT NOT NULL,
  word_count INTEGER,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  embedding VECTOR(2048),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_docs_uploaded_at_idx ON knowledge_docs (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_docs_active_idx ON knowledge_docs (active);
CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks (doc_id);

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding VECTOR(2048),
  match_count INT DEFAULT 8
)
RETURNS TABLE (
  id UUID,
  doc_id UUID,
  chunk_index INTEGER,
  content TEXT,
  similarity DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.doc_id,
    knowledge_chunks.chunk_index,
    knowledge_chunks.content,
    1 - (knowledge_chunks.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks
  WHERE knowledge_chunks.embedding IS NOT NULL
  ORDER BY knowledge_chunks.embedding <=> query_embedding
  LIMIT match_count;
$$;
