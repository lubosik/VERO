const STORAGE_KEY = 'vero_auth'
const splashSteps = ['INITIALISING', 'CONNECTING', 'LOADING ENGINES', 'READY']
let authToken = null
let currentKbTab = 'file'

function getStoredToken() {
  return sessionStorage.getItem(STORAGE_KEY)
}

function setStoredToken(token) {
  sessionStorage.setItem(STORAGE_KEY, token)
  authToken = token
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.headers || {})
    }
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

async function verifyToken(token) {
  try {
    const res = await fetch('/api/stats', {
      headers: { Authorization: `Bearer ${token}` }
    })
    return res.ok
  } catch {
    return false
  }
}

function showLogin() {
  document.getElementById('splash').style.display = 'none'
  document.getElementById('login-panel').style.display = 'flex'
  document.getElementById('dashboard').style.display = 'none'
}

function showDashboard() {
  document.getElementById('splash').style.display = 'none'
  document.getElementById('login-panel').style.display = 'none'
  document.getElementById('dashboard').style.display = 'block'
  loadDashboard()
  setInterval(loadDashboard, 30000)
}

function animateSplash() {
  const bar = document.getElementById('splash-bar')
  const status = document.getElementById('splash-status')
  let progress = 0
  const interval = setInterval(() => {
    progress += 25
    bar.style.width = `${progress}%`
    status.textContent = splashSteps[Math.floor(progress / 25) - 1] || 'READY'
    if (progress >= 100) clearInterval(interval)
  }, 400)
}

function formatDate(value) {
  if (!value) return 'n/a'
  return new Date(value).toLocaleString()
}

function truncate(text, length = 120) {
  if (!text) return ''
  return text.length > length ? `${text.slice(0, length)}...` : text
}

function renderStats(stats) {
  const cards = [
    ['YouTube Comments (24h)', stats.youtubeComments24h],
    ['Blogs Published', stats.blogsPublished],
    ['Reddit Alerts Pending', stats.redditAlertsPending],
    ['KB Documents', stats.kbDocuments]
  ]
  document.getElementById('stats-grid').innerHTML = cards
    .map(([label, value]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`)
    .join('')
}

function renderEngineStatus(health) {
  const entries = [
    ['YouTube', health.lastRuns?.youtube],
    ['Reddit', health.lastRuns?.reddit],
    ['Blog', health.lastRuns?.blog]
  ]
  document.getElementById('engine-status').innerHTML = entries
    .map(([name, time]) => `<div class="status-pill">${name}: ${time ? 'online' : 'idle'}</div>`)
    .join('')
}

function renderComments(items) {
  document.getElementById('comments-table').innerHTML = items
    .map(
      (item) => `<tr>
        <td>${item.platform || ''}</td>
        <td>${truncate(item.content_title || item.video_id || item.external_id, 60)}</td>
        <td>${truncate(item.comment_text || '', 110)}</td>
        <td>${item.naturalness_score || '-'}</td>
        <td>${formatDate(item.created_at)}</td>
        <td>${item.status || ''}</td>
      </tr>`
    )
    .join('')
}

function renderBlogs(items) {
  document.getElementById('blogs-list').innerHTML = items
    .map(
      (item) => `<div class="stack-item">
        <h3>${item.title || item.slug}</h3>
        <p>${truncate(item.meta_description || item.primary_keyword || '', 180)}</p>
        <div class="item-actions">
          <span class="badge ${item.status === 'published' ? 'success' : item.status === 'rejected' ? 'error' : 'warning'}">${item.status}</span>
          ${item.status === 'pending' ? `<button data-approve-blog="${item.id}">Approve</button><button data-reject-blog="${item.id}">Reject</button>` : ''}
          ${item.published_url ? `<a class="linklike" href="${item.published_url}" target="_blank" rel="noreferrer">Open</a>` : ''}
        </div>
      </div>`
    )
    .join('')
}

function renderKeywords(items) {
  document.getElementById('keywords-table').innerHTML = items
    .map(
      (item) => `<tr>
        <td>${item.keyword}</td>
        <td>${item.search_volume ?? '-'}</td>
        <td>${item.trend_score ?? '-'}</td>
        <td>${item.competition ?? '-'}</td>
        <td>${item.used ? 'Yes' : 'No'}</td>
      </tr>`
    )
    .join('')
}

function renderKb(items) {
  document.getElementById('kb-docs').innerHTML = items
    .map(
      (item) => `<tr>
        <td>${item.name}</td>
        <td>${item.source_type}</td>
        <td>${item.word_count || 0}</td>
        <td>${formatDate(item.uploaded_at)}</td>
        <td><button data-toggle-kb="${item.id}">${item.active ? 'On' : 'Off'}</button></td>
        <td><button data-delete-kb="${item.id}">Delete</button></td>
      </tr>`
    )
    .join('')
}

function renderReddit(items) {
  document.getElementById('reddit-queue').innerHTML = items
    .map(
      (item) => `<div class="stack-item">
        <h3>${item.title}</h3>
        <p>${truncate(item.generated_comment || '', 220)}</p>
        <div class="item-actions">
          <span class="badge warning">${item.intent_score || 0}/100 intent</span>
          <button data-copy-comment="${encodeURIComponent(item.generated_comment || '')}">Copy Comment</button>
          <a class="linklike" href="${item.url}" target="_blank" rel="noreferrer">Open Thread</a>
        </div>
      </div>`
    )
    .join('')
}

function renderHealth(health) {
  const cards = [
    ['Uptime', `${Math.floor((health.uptime || 0) / 60)} min`],
    ['Paused', health.paused ? 'Yes' : 'No'],
    ['YT Quota Used Today', health.youtubeQuotaUsedToday || 0],
    ['Recent Errors', (health.recentErrors || []).length]
  ]
  document.getElementById('health-panel').innerHTML = cards
    .map(([label, value]) => `<div class="health-card"><div class="stat-label">${label}</div><div class="stat-value" style="font-size:22px">${value}</div></div>`)
    .join('')
}

async function loadDashboard() {
  const [stats, comments, blogs, keywords, kb, redditQueue, health] = await Promise.all([
    api('/api/stats'),
    api('/api/comments?limit=25&offset=0'),
    api('/api/blogs'),
    api('/api/keywords'),
    api('/api/kb'),
    api('/api/reddit-queue'),
    api('/api/health')
  ])

  renderStats(stats)
  renderComments(comments)
  renderBlogs(blogs)
  renderKeywords(keywords)
  renderKb(kb)
  renderReddit(redditQueue)
  renderHealth(health)
  renderEngineStatus(health)
}

function setKbTab(tab) {
  currentKbTab = tab
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab)
  })
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab)
  })
}

async function handleKbSubmit(event) {
  event.preventDefault()
  const form = new FormData()
  form.set('name', document.getElementById('kb-name').value)
  form.set('type', currentKbTab === 'file' ? fileType() : currentKbTab)

  if (currentKbTab === 'file') {
    const file = document.getElementById('kb-file').files[0]
    if (!file) throw new Error('Choose a file')
    form.set('file', file)
  } else if (currentKbTab === 'url') {
    form.set('url', document.getElementById('kb-url').value)
  } else {
    form.set('content', document.getElementById('kb-content').value)
  }

  const res = await fetch('/api/kb/ingest', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: form
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Ingest failed')
  document.getElementById('kb-result').textContent = `Loaded ${data.wordCount} words`
  event.target.reset()
  await loadDashboard()
}

function fileType() {
  const file = document.getElementById('kb-file').files[0]
  if (!file) return 'txt'
  return file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'txt'
}

async function init() {
  animateSplash()
  await new Promise((resolve) => setTimeout(resolve, 1600))

  const stored = getStoredToken()
  if (stored && await verifyToken(stored)) {
    setStoredToken(stored)
    showDashboard()
  } else {
    showLogin()
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init()

  document.getElementById('login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = document.getElementById('login-password').value
    const btn = document.getElementById('login-btn')
    const error = document.getElementById('login-error')

    btn.textContent = 'Verifying...'
    btn.disabled = true
    error.textContent = ''

    const valid = await verifyToken(password)
    if (valid) {
      setStoredToken(password)
      showDashboard()
    } else {
      error.textContent = 'Invalid access key'
      btn.textContent = 'Enter'
      btn.disabled = false
      document.getElementById('login-password').value = ''
      document.getElementById('login-password').focus()
      document.getElementById('login-panel-card').style.animation = 'shake 0.3s ease'
      setTimeout(() => {
        document.getElementById('login-panel-card').style.animation = ''
      }, 300)
    }
  })

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => setKbTab(button.dataset.tab))
  })

  document.getElementById('kb-form')?.addEventListener('submit', async (event) => {
    const status = document.getElementById('kb-result')
    status.textContent = 'Uploading...'
    try {
      await handleKbSubmit(event)
    } catch (error) {
      status.textContent = error.message
    }
  })

  document.body.addEventListener('click', async (event) => {
    const approveBlog = event.target.dataset.approveBlog
    const rejectBlog = event.target.dataset.rejectBlog
    const toggleKb = event.target.dataset.toggleKb
    const deleteKb = event.target.dataset.deleteKb
    const copyComment = event.target.dataset.copyComment

    try {
      if (approveBlog) await api(`/api/blog/${approveBlog}/approve`, { method: 'POST' })
      if (rejectBlog) await api(`/api/blog/${rejectBlog}/reject`, { method: 'POST' })
      if (toggleKb) await api(`/api/kb/${toggleKb}/toggle`, { method: 'PATCH' })
      if (deleteKb) await api(`/api/kb/${deleteKb}`, { method: 'DELETE' })
      if (copyComment) await navigator.clipboard.writeText(decodeURIComponent(copyComment))
      if (approveBlog || rejectBlog || toggleKb || deleteKb) await loadDashboard()
    } catch (error) {
      alert(error.message)
    }
  })
})
