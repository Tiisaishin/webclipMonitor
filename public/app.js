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
const fmtDate = (d) => (d ? new Date(d).toLocaleString('zh-CN') : '—');
// Hostname of a URL (e.g. the landing page's domain), '' if unparseable.
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Keep the English key as the CSS class (colors), show a Chinese label.
const STATUS_LABEL = {
  expired: '已过期', expiring: '即将过期', active: '正常', unknown: '未知',
  ignored: '已忽略',
  queued: '排队中', running: '运行中', done: '完成', error: '出错',
};
const badge = (s) => {
  const key = s || 'unknown';
  return `<span class="badge ${esc(key)}">${esc(STATUS_LABEL[key] || key)}</span>`;
};

// Scan run stats -> short Chinese summary.
const fmtStats = (st) => {
  if (!st || typeof st !== 'object') return '';
  return `节点 ${st.nodes ?? 0} · webclip ${st.webclips ?? 0} · 域名 ${st.domains ?? 0} · 错误 ${st.errors ?? 0}`;
};

// Short label for a path hop: its title, else the URL's host + last segment.
const hopLabel = (hop) => {
  if (hop.title) return hop.title;
  try {
    const u = new URL(hop.url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? `${u.host}/${seg}` : u.host;
  } catch { return (hop.url || '').slice(0, 24); }
};

// Render the scan path (entry → … → webclip) as an arrow chain with a full
// tooltip. `path` is the JSONB array stored on the webclip.
const fmtPath = (path) => {
  if (!Array.isArray(path) || path.length === 0) return '—';
  const chain = path.map(hopLabel).join(' → ');
  const full = path.map((h, i) => `${i}. ${h.url}${h.decodedVia ? ` [${h.decodedVia}]` : ''}`).join('\n');
  return `<span title="${esc(full)}">${esc(chain.length > 70 ? chain.slice(0, 70) + '…' : chain)}</span>`;
};

// --- Tabs ---
document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    el(`#${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'domains') loadDomains();
    if (b.dataset.tab === 'settings') { loadSettings(); loadIgnore(); }
  });
});

// --- Tasks ---
async function loadTasks() {
  const tasks = await api.get('/tasks');
  const tbody = el('#task-table tbody');
  tbody.innerHTML = tasks.map((t) => {
    const stats = t.last_run_stats ? fmtStats(t.last_run_stats) : '';
    const typeLabel = t.site_type === 'standalone' ? '独立站' : '导航站';
    return `<tr>
      <td>${esc(t.name)}</td>
      <td><a href="${esc(t.entry_url)}" target="_blank" rel="noopener">${esc(t.entry_url.slice(0, 40))}</a></td>
      <td>${typeLabel}</td>
      <td>${t.max_depth}</td>
      <td>${esc(t.cron || '—')}</td>
      <td>${t.last_run_id ? `${badge(t.last_run_status)} <a href="#" data-run="${t.last_run_id}">#${t.last_run_id}</a> <span class="via">${esc(stats)}</span>` : '—'}</td>
      <td>${t.enabled ? '✅' : '⛔'}</td>
      <td class="actions">
        <button class="ghost" data-run-task="${t.id}">运行</button>
        <button class="ghost" data-del-task="${t.id}">删除</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-run-task]').forEach((b) =>
    b.addEventListener('click', async () => { await api.post(`/tasks/${b.dataset.runTask}/run`); setTimeout(loadTasks, 500); }));
  tbody.querySelectorAll('[data-del-task]').forEach((b) =>
    b.addEventListener('click', async () => { if (confirm('确认删除该任务？')) { await api.del(`/tasks/${b.dataset.delTask}`); loadTasks(); } }));
  tbody.querySelectorAll('[data-run]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); showRun(a.dataset.run); }));
}

el('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const res = await api.post('/tasks', {
    name: f.get('name'), entry_url: f.get('entry_url'),
    site_type: f.get('site_type'),
    max_depth: f.get('max_depth'), cron: f.get('cron') || null,
  });
  if (res.error) return alert(res.error);
  e.target.reset();
  loadTasks();
});

// Clipboard helper with a textarea fallback for non-secure contexts.
function copyText(text, btn) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => (btn.textContent = o), 1200); } };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch {}
    document.body.removeChild(ta);
  }
}

const logLineText = (g) => {
  const t = new Date(g.created_at).toLocaleTimeString('zh-CN');
  const data = g.data ? ` | ${JSON.stringify(g.data)}` : '';
  return `${t} [${g.level}] ${g.message}${data}`;
};

let currentLogs = [];
let logFilter = 'all'; // all | warn | error

function renderLogs() {
  const tools = el('#log-tools');
  const box = el('#run-logs');
  const errs = currentLogs.filter((g) => g.level === 'error');
  const warns = currentLogs.filter((g) => g.level === 'warn' || g.level === 'error');
  const shown = logFilter === 'error' ? errs : logFilter === 'warn' ? warns : currentLogs;

  tools.innerHTML =
    `<span class="log-count">共 ${currentLogs.length} 条` +
    (errs.length ? ` · <b class="err-n">错误 ${errs.length}</b>` : '') + `</span>` +
    `<span class="seg">` +
    `<button data-f="all" class="${logFilter === 'all' ? 'on' : ''}">全部</button>` +
    `<button data-f="warn" class="${logFilter === 'warn' ? 'on' : ''}">警告+错误</button>` +
    `<button data-f="error" class="${logFilter === 'error' ? 'on' : ''}">仅错误</button>` +
    `</span>` +
    `<button data-copy="all" class="ghost">复制全部</button>` +
    `<button data-copy="error" class="ghost"${errs.length ? '' : ' disabled'}>复制错误</button>`;

  box.innerHTML = shown.length
    ? shown.map((g) => {
        const t = new Date(g.created_at).toLocaleTimeString('zh-CN');
        const data = g.data ? `<span class="data">${esc(JSON.stringify(g.data))}</span>` : '';
        const dom = g.data && g.data.domain;
        const ignBtn = (dom && !g.data.ignored)
          ? `<button class="ign" data-ign="${esc(dom)}" title="把 ${esc(dom)} 加入忽略名单">加入忽略</button>`
          : '';
        return `<div class="logline ${esc(g.level)}"><span class="ts">${t}</span>` +
               `<span class="lvl">${esc(g.level)}</span>` +
               `<span class="msg">${esc(g.message)}${data}</span>` +
               ignBtn +
               `<button class="copyline" title="复制此行">⧉</button></div>`;
      }).join('')
    : '<p class="hint">没有符合条件的日志。</p>';

  tools.querySelectorAll('[data-f]').forEach((b) =>
    b.addEventListener('click', () => { logFilter = b.dataset.f; renderLogs(); }));
  tools.querySelector('[data-copy="all"]').addEventListener('click', (e) =>
    copyText(currentLogs.map(logLineText).join('\n'), e.target));
  const ce = tools.querySelector('[data-copy="error"]');
  if (ce && !ce.disabled) ce.addEventListener('click', (e) =>
    copyText(errs.map(logLineText).join('\n'), e.target));
  box.querySelectorAll('.copyline').forEach((b, i) =>
    b.addEventListener('click', (e) => copyText(logLineText(shown[i]), e.target)));
  box.querySelectorAll('[data-ign]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '…';
      await api.post('/ignore-domains', { domain: b.dataset.ign });
      b.textContent = '已忽略';
    }));
}

async function showRun(runId) {
  const detail = el('#run-detail');
  detail.hidden = false;
  logFilter = 'all';
  const [{ nodes, run }, webclips, logs] = await Promise.all([
    api.get(`/runs/${runId}/tree`),
    api.get(`/runs/${runId}/webclips`),
    api.get(`/runs/${runId}/logs`),
  ]);

  // Run history for this task — each run is a separate, selectable block.
  const runs = run?.task_id ? await api.get(`/tasks/${run.task_id}/runs`) : [run].filter(Boolean);
  el('#run-history').innerHTML = `<span class="rh-label">运行历史：</span>` + runs.map((r) =>
    `<button class="rh ${String(r.id) === String(runId) ? 'on' : ''}" data-run="${r.id}">` +
    `#${r.id} ${badge(r.status)}</button>`).join('');
  el('#run-history').querySelectorAll('[data-run]').forEach((b) =>
    b.addEventListener('click', () => showRun(b.dataset.run)));

  // Meta header = this run's divider: id, time, status, stats.
  const st = run?.stats || {};
  const started = run?.started_at ? new Date(run.started_at).toLocaleString('zh-CN') : '—';
  el('#run-meta').innerHTML =
    `<b>运行 #${runId}</b> · ${badge(run?.status)} · 开始 ${started}` +
    ` · 节点 ${st.nodes ?? 0} · webclip ${st.webclips ?? 0} · 域名 ${st.domains ?? 0}` +
    ` · <span class="${(st.errors ?? 0) > 0 ? 'err-n' : ''}">错误 ${st.errors ?? 0}</span>` +
    (run?.error ? ` · <span class="err-n">${esc(run.error)}</span>` : '');

  el('#run-webclips').innerHTML = webclips.length
    ? `<div class="table-wrap"><table><thead><tr><th>域名</th><th>状态</th><th>到期日</th><th>完整 URL</th><th>落地页</th><th>扫描路径</th><th>签名</th></tr></thead><tbody>${
        webclips.map((w) => `<tr>
          <td>${esc(w.domain || '—')}</td>
          <td>${badge(w.status)}</td>
          <td>${w.expiry_date ? new Date(w.expiry_date).toISOString().slice(0, 10) : '—'}</td>
          <td><a href="${esc(w.full_url)}" target="_blank" rel="noopener">${esc((w.full_url || '').slice(0, 44))}</a></td>
          <td title="${esc((w.landing_title ? w.landing_title + ' — ' : '') + (w.landing_url || ''))}">${esc(hostOf(w.landing_url) || '—')}${w.landing_title ? `<br><span class="sub">${esc(w.landing_title.slice(0, 24))}</span>` : ''}</td>
          <td class="pathcell">${fmtPath(w.path)}</td>
          <td>${w.signed ? '🔏' : ''}</td>
        </tr>`).join('')
      }</tbody></table></div>`
    : '<p class="hint">本次运行未发现 webclip。</p>';

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
  el('#run-tree').innerHTML = lines.join('') || '<p class="hint">暂无节点。</p>';

  // Run log (filterable + copyable).
  currentLogs = logs || [];
  renderLogs();

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
    <td>${d.full_url ? `<a href="${esc(d.full_url)}" target="_blank" rel="noopener" title="${esc(d.full_url)}">${esc(d.full_url.slice(0, 40))}</a>` : '—'}</td>
    <td title="${esc((d.landing_title ? d.landing_title + ' — ' : '') + (d.landing_url || ''))}">${esc(hostOf(d.landing_url) || '—')}${d.landing_title ? `<br><span class="sub">${esc(d.landing_title.slice(0, 24))}</span>` : ''}</td>
    <td class="pathcell">${fmtPath(d.path)}</td>
    <td>${esc(d.registrar || '—')}</td>
    <td>${fmtDate(d.last_checked_at)}</td>
    <td class="actions">
      <button class="ghost" data-check="${d.id}">重新检查</button>
      <button class="ghost" data-edit="${d.id}" data-exp="${d.expiry_date ? new Date(d.expiry_date).toISOString().slice(0,10) : ''}">编辑到期日</button>
      ${d.status === 'ignored'
        ? `<button class="ghost" data-unignore="${d.id}">取消忽略</button>`
        : `<button class="ghost" data-ignore="${d.id}">忽略</button>`}
      <button class="ghost" data-del="${d.id}" data-dom="${esc(d.domain)}">删除</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="9" class="hint">暂无域名。</td></tr>';
  tbody.querySelectorAll('[data-check]').forEach((b) =>
    b.addEventListener('click', async () => { b.textContent = '…'; await api.post(`/domains/${b.dataset.check}/check`); loadDomains(); }));
  tbody.querySelectorAll('[data-ignore]').forEach((b) =>
    b.addEventListener('click', async () => { b.textContent = '…'; await api.post(`/domains/${b.dataset.ignore}/ignore`); loadDomains(); }));
  tbody.querySelectorAll('[data-unignore]').forEach((b) =>
    b.addEventListener('click', async () => { b.textContent = '…'; await api.post(`/domains/${b.dataset.unignore}/unignore`); loadDomains(); }));
  tbody.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', async () => {
      const v = prompt('输入到期日（YYYY-MM-DD），留空取消：', b.dataset.exp);
      if (v === null || v.trim() === '') return;
      const res = await api.patch(`/domains/${b.dataset.edit}`, { expiry_date: v.trim() });
      if (res && res.error) alert(res.error); else loadDomains();
    }));
  tbody.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`确认删除域名 ${b.dataset.dom}？`)) return;
      await api.del(`/domains/${b.dataset.del}`); loadDomains();
    }));
}

// --- Settings ---
async function loadSettings() {
  const s = await api.get('/settings');
  const f = el('#settings-form');
  f.telegram_chat_id.value = s.telegram_chat_id || '';
  f.telegram_bot_token.value = '';
  f.telegram_bot_token.placeholder = s.telegram_bot_token_set ? `已设置（${s.telegram_bot_token}）` : '123456:ABC…';
  f.expiry_warn_days.value = s.expiry_warn_days || '';
  f.xor_keys.value = s.xor_keys || '';
  f.decode_rules.value = s.decode_rules || '';
}

// --- Ignore-domain list ---
async function loadIgnore() {
  const { custom, builtin } = await api.get('/ignore-domains');
  el('#ign-custom').innerHTML = custom.length
    ? custom.map((d) => `<span class="chip">${esc(d)}<button data-del="${esc(d)}" title="删除">✕</button></span>`).join('')
    : '<span class="hint">暂无自定义项。</span>';
  el('#ign-builtin').innerHTML = builtin.map((d) => `<span class="chip">${esc(d)}</span>`).join('');
  el('#ign-custom').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => { await api.post('/ignore-domains/remove', { domain: b.dataset.del }); loadIgnore(); }));
}
async function addIgnore() {
  const raw = el('#ign-input').value.trim();
  if (!raw) return;
  const domains = raw.split(/[\s,]+/).filter(Boolean);
  await api.post('/ignore-domains', { domains });
  el('#ign-input').value = '';
  loadIgnore();
}

el('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {};
  for (const [k, v] of f.entries()) if (v !== '') body[k] = v;
  const res = await api.put('/settings', body);
  el('#settings-status').textContent = res.error ? `❌ ${res.error}` : '已保存。';
  loadSettings();
});

el('#ign-add').addEventListener('click', addIgnore);
el('#ign-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addIgnore(); } });

el('#tg-test').addEventListener('click', async () => {
  el('#settings-status').textContent = '发送中…';
  const res = await api.post('/settings/telegram/test');
  el('#settings-status').textContent = res.ok ? '✅ 测试消息已发送。' : `❌ ${res.error}`;
});

// Initial load + light polling of the task list.
loadTasks();
setInterval(() => { if (el('#tasks').classList.contains('active')) loadTasks(); }, 5000);
