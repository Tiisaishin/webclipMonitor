const api = {
  async get(path) { return (await fetch(`/api${path}`)).json(); },
  async post(path, body) {
    return (await fetch(`/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
  },
  async put(path, body) {
    return (await fetch(`/api${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();
  },
  async patch(path, body) {
    return (await fetch(`/api${path}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();
  },
  async del(path) { await fetch(`/api${path}`, { method: 'DELETE' }); },
};

const el = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');
const badge = (s) => `<span class="badge ${esc(s || 'unknown')}">${esc(s || 'unknown')}</span>`;

// --- Tabs ---
document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    el(`#${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'domains') loadDomains();
    if (b.dataset.tab === 'settings') loadSettings();
  });
});

// --- Tasks ---
async function loadTasks() {
  const tasks = await api.get('/tasks');
  const tbody = el('#task-table tbody');
  tbody.innerHTML = tasks.map((t) => {
    const stats = t.last_run_stats ? JSON.stringify(t.last_run_stats) : '';
    return `<tr>
      <td>${esc(t.name)}</td>
      <td><a href="${esc(t.entry_url)}" target="_blank" rel="noopener">${esc(t.entry_url.slice(0, 40))}</a></td>
      <td>${t.max_depth}</td>
      <td>${esc(t.cron || '—')}</td>
      <td>${t.last_run_id ? `${badge(t.last_run_status)} <a href="#" data-run="${t.last_run_id}">#${t.last_run_id}</a> <span class="via">${esc(stats)}</span>` : '—'}</td>
      <td>${t.enabled ? '✅' : '⛔'}</td>
      <td class="actions">
        <button class="ghost" data-run-task="${t.id}">Run</button>
        <button class="ghost" data-del-task="${t.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-run-task]').forEach((b) =>
    b.addEventListener('click', async () => { await api.post(`/tasks/${b.dataset.runTask}/run`); setTimeout(loadTasks, 500); }));
  tbody.querySelectorAll('[data-del-task]').forEach((b) =>
    b.addEventListener('click', async () => { if (confirm('Delete task?')) { await api.del(`/tasks/${b.dataset.delTask}`); loadTasks(); } }));
  tbody.querySelectorAll('[data-run]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); showRun(a.dataset.run); }));
}

el('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const res = await api.post('/tasks', {
    name: f.get('name'), entry_url: f.get('entry_url'),
    max_depth: f.get('max_depth'), cron: f.get('cron') || null,
  });
  if (res.error) return alert(res.error);
  e.target.reset();
  loadTasks();
});

async function showRun(runId) {
  const detail = el('#run-detail');
  detail.hidden = false;
  el('#run-id').textContent = `#${runId}`;
  const [{ nodes }, webclips] = await Promise.all([
    api.get(`/runs/${runId}/tree`),
    api.get(`/runs/${runId}/webclips`),
  ]);

  el('#run-webclips').innerHTML = webclips.length
    ? `<table><thead><tr><th>Domain</th><th>Status</th><th>Expiry</th><th>Full URL</th><th>Source page</th><th>Signed</th></tr></thead><tbody>${
        webclips.map((w) => `<tr>
          <td>${esc(w.domain || '—')}</td>
          <td>${badge(w.status)}</td>
          <td>${w.expiry_date ? new Date(w.expiry_date).toISOString().slice(0, 10) : '—'}</td>
          <td><a href="${esc(w.full_url)}" target="_blank" rel="noopener">${esc((w.full_url || '').slice(0, 50))}</a></td>
          <td title="${esc(w.source_url || '')}">${esc(w.source_title || (w.source_url || '').slice(0, 40))}</td>
          <td>${w.signed ? '🔏' : ''}</td>
        </tr>`).join('')
      }</tbody></table>`
    : '<p class="hint">No webclips found in this run.</p>';

  // Render the tree indented by depth.
  const byParent = new Map();
  nodes.forEach((n) => {
    if (!byParent.has(n.parent_id)) byParent.set(n.parent_id, []);
    byParent.get(n.parent_id).push(n);
  });
  const lines = [];
  const walk = (parentId, depth) => {
    for (const n of byParent.get(parentId) || []) {
      const pad = '  '.repeat(depth);
      const cls = n.is_webclip ? 'clip' : n.error ? 'err' : '';
      const tag = n.is_webclip ? ' 📎WEBCLIP' : n.error ? ` ✗${esc(n.error.slice(0, 40))}` : '';
      const via = n.decoded_via ? ` <span class="via">[${esc(n.decoded_via)}]</span>` : '';
      const title = n.title ? ` <span class="title">“${esc(n.title.slice(0, 60))}”</span>` : '';
      lines.push(`<div class="node ${cls}">${pad}${esc(n.url.slice(0, 90))}${title}${via}${tag}</div>`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  el('#run-tree').innerHTML = lines.join('') || '<p class="hint">No nodes.</p>';
  detail.scrollIntoView({ behavior: 'smooth' });
}

// --- Domains ---
async function loadDomains() {
  const domains = await api.get('/domains');
  const tbody = el('#domain-table tbody');
  tbody.innerHTML = domains.map((d) => `<tr>
    <td>${esc(d.domain)}</td>
    <td>${badge(d.status)}</td>
    <td>${d.expiry_date ? new Date(d.expiry_date).toISOString().slice(0, 10) : '—'}</td>
    <td>${esc(d.registrar || '—')}</td>
    <td>${fmtDate(d.last_checked_at)}</td>
    <td class="actions"><button class="ghost" data-check="${d.id}">Re-check</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="hint">No domains yet.</td></tr>';
  tbody.querySelectorAll('[data-check]').forEach((b) =>
    b.addEventListener('click', async () => { b.textContent = '…'; await api.post(`/domains/${b.dataset.check}/check`); loadDomains(); }));
}

// --- Settings ---
async function loadSettings() {
  const s = await api.get('/settings');
  const f = el('#settings-form');
  f.telegram_chat_id.value = s.telegram_chat_id || '';
  f.telegram_bot_token.value = '';
  f.telegram_bot_token.placeholder = s.telegram_bot_token_set ? `set (${s.telegram_bot_token})` : '123456:ABC…';
  f.expiry_warn_days.value = s.expiry_warn_days || '';
  f.xor_keys.value = s.xor_keys || '';
  f.decode_rules.value = s.decode_rules || '';
}

el('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {};
  for (const [k, v] of f.entries()) if (v !== '') body[k] = v;
  await api.put('/settings', body);
  el('#settings-status').textContent = 'Saved.';
  loadSettings();
});

el('#tg-test').addEventListener('click', async () => {
  el('#settings-status').textContent = 'Sending…';
  const res = await api.post('/settings/telegram/test');
  el('#settings-status').textContent = res.ok ? '✅ Test message sent.' : `❌ ${res.error}`;
});

// Initial load + light polling of the task list.
loadTasks();
setInterval(() => { if (el('#tasks').classList.contains('active')) loadTasks(); }, 5000);
