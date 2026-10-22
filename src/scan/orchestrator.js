import { one, many, query } from '../db/index.js';
import { config } from '../config.js';
import { fetchAsIphone } from '../crawler/fetcher.js';
import { runDecoders } from '../crawler/decoders/index.js';
import { looksLikeWebclip, parseWebclip, urlToDomain } from '../crawler/webclip.js';
import { resolveUrl, expandHandoff, isFollowable, normalize } from '../crawler/urls.js';
import { resolveDecodeConfig } from '../crawler/decoders/rules.js';
import { upsertDomain, checkDomain } from '../domain/service.js';
import { logRun } from './logger.js';

/**
 * Run a full exhaustive crawl for a task run.
 *
 * Strategy: breadth-first over the discovery tree. Every URL found (via
 * redirects, runtime sub-requests, plaintext links, or decoded payloads) is a
 * child node. We DO NOT stop at the first webclip — a webclip node simply
 * becomes a leaf (we don't crawl past it), and we keep exhausting every other
 * branch up to max_depth. A global node cap guards against runaway trees.
 */
export async function runScan(run, task, { decodeConfig = {} } = {}) {
  const visited = new Set();
  const stats = { nodes: 0, webclips: 0, domains: 0, errors: 0 };
  const context = { taskName: task.name, entryUrl: task.entry_url };

  // Queue holds { url, depth, parentId, discovery, decodedVia }.
  const queue = [{
    url: task.entry_url,
    depth: 0,
    parentId: null,
    discovery: 'entry',
    decodedVia: null,
  }];
  visited.add(normalize(task.entry_url));

  // Site type decides how far we crawl:
  //   'standalone' (独立站) — one landing page, one target: stop the whole scan
  //     as soon as the first webclip is found.
  //   'nav' (导航站, default) — many links: a webclip ends only its own branch,
  //     and every other branch is exhausted up to max_depth.
  const standalone = task.site_type === 'standalone';

  await logRun(run.id, 'info',
    `开始扫描：${task.entry_url}（类型=${standalone ? '独立站' : '导航站'}，最大深度=${task.max_depth}）`);

  // Simple bounded-concurrency BFS: drain a layer in parallel batches.
  while (queue.length > 0) {
    if (stats.nodes >= config.crawl.maxNodesPerTask) {
      await logRun(run.id, 'warn', `达到节点上限 ${config.crawl.maxNodesPerTask}，停止扩展`);
      break;
    }
    const batch = queue.splice(0, config.crawl.concurrency);
    const children = await Promise.all(
      batch.map((item) => processNode(item, { run, task, decodeConfig, stats, context }))
    );

    // Standalone site: first webclip is the answer — stop here.
    if (standalone && stats.webclips > 0) {
      await logRun(run.id, 'info', '独立站：已找到首个 webclip，提前停止');
      break;
    }

    for (const found of children) {
      for (const child of found) {
        const key = normalize(child.url);
        if (visited.has(key)) continue;
        if (child.depth > task.max_depth) continue;
        visited.add(key);
        queue.push(child);
      }
    }
  }

  await query('UPDATE scan_runs SET stats = $2 WHERE id = $1', [run.id, JSON.stringify(stats)]);
  await logRun(run.id, 'info',
    `扫描结束：节点 ${stats.nodes}，webclip ${stats.webclips}，域名 ${stats.domains}，错误 ${stats.errors}`, stats);
  return stats;
}

async function processNode(item, { run, task, decodeConfig, stats, context }) {
  stats.nodes++;
  const fetched = await fetchAsIphone(item.url);

  // Persist this node.
  const isClip = !fetched.error && looksLikeWebclip({
    url: fetched.finalUrl,
    contentType: fetched.contentType,
    buffer: fetched.buffer,
    body: fetched.body,
    status: fetched.status,
  });

  const node = await one(
    `INSERT INTO scan_nodes
       (run_id, parent_id, url, depth, discovery_method, decoded_via,
        http_status, content_type, is_webclip, error,
        title, description, final_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      run.id, item.parentId, item.url, item.depth, item.discovery, item.decodedVia,
      fetched.status, fetched.contentType, isClip, fetched.error,
      fetched.title, fetched.description, fetched.finalUrl,
    ]
  );

  if (fetched.error) {
    stats.errors++;
    await logRun(run.id, 'error', `[深度${item.depth}] 抓取失败：${item.url} — ${fetched.error}`,
      { url: item.url, depth: item.depth, discovery: item.discovery });
    return [];
  }

  // A webclip node is a leaf: parse it, record domains, stop this branch.
  if (isClip) {
    stats.webclips++;
    await logRun(run.id, 'info', `[深度${item.depth}] 命中 webclip：${fetched.finalUrl}`,
      { url: fetched.finalUrl, depth: item.depth, contentType: fetched.contentType });
    await ingestWebclip(node.id, fetched, { run, task, stats, context });
    return [];
  }

  // Otherwise, discover the next hops.
  const children = [];
  const seen = new Set();
  const add = (rawUrl, discovery, decodedVia) => {
    const resolved = resolveUrl(rawUrl, fetched.finalUrl);
    if (!resolved) return;
    for (const expanded of [resolved, ...expandHandoff(resolved)]) {
      const target = expanded === resolved ? resolved : resolveUrl(expanded, fetched.finalUrl);
      if (!target || !isFollowable(target)) continue;
      const k = normalize(target);
      if (seen.has(k)) continue;
      seen.add(k);
      children.push({
        url: target,
        depth: item.depth + 1,
        parentId: node.id,
        discovery,
        decodedVia,
      });
    }
  };

  // Jumps first: HTTP 30x + JS/meta navigations the page passed through.
  for (const u of fetched.redirectChain || []) add(u, 'redirect', null);
  if (fetched.finalUrl && normalize(fetched.finalUrl) !== normalize(item.url)) {
    await logRun(run.id, 'info',
      `[深度${item.depth}] 跳转：${item.url} → ${fetched.finalUrl}`,
      { from: item.url, to: fetched.finalUrl, via: fetched.redirectChain || [] });
  }

  // Structured links extracted from the rendered DOM (relative links resolved).
  for (const link of fetched.links || []) add(link, 'link', null);

  // Runtime sub-requests are a secondary signal (XHR/fetch the page issued).
  const runtimeUrls = fetched.subRequests.map((r) => r.url);

  // Resolve per-domain decode rules for this node's URL.
  const { xorKeys, aesKeys, extracts } = resolveDecodeConfig(fetched.finalUrl || item.url, decodeConfig);

  const candidates = runDecoders({
    body: fetched.body,
    runtimeUrls,
    runtimeDecoded: fetched.runtimeDecoded,
    xorKeys,
    aesKeys,
    extracts,
  });
  for (const c of candidates) {
    add(c.url, c.via === 'runtime' || c.via === 'plaintext' ? c.via : 'decoded', c.via);
  }

  // Log the page visit and what decoders turned up (helps debug "why no webclip").
  const vias = [...new Set(candidates.map((c) => c.via))];
  await logRun(run.id, 'info',
    `[深度${item.depth}] 抓取 ${item.url}（HTTP ${fetched.status ?? '—'}，标题「${fetched.title || ''}」）→ 发现 ${children.length} 个下一跳`,
    { url: item.url, depth: item.depth, status: fetched.status, title: fetched.title,
      childCount: children.length, decoders: vias });

  return children;
}

async function ingestWebclip(nodeId, fetched, { run, task, stats, context }) {
  const parsed = parseWebclip({ buffer: fetched.buffer, body: fetched.body });
  if (!parsed) {
    await logRun(run.id, 'warn',
      `检测到 webclip 但未能解析出 URL：${fetched.finalUrl}（可能是加密/异常的描述文件）`);
  }

  // Reconstruct the full scan path (entry -> … -> this webclip) by walking
  // parent links, so each webclip records how it was reached.
  const pathRows = await many(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, url, final_url, title, discovery_method, decoded_via, depth
         FROM scan_nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, n.url, n.final_url, n.title, n.discovery_method, n.decoded_via, n.depth
         FROM scan_nodes n JOIN anc a ON n.id = a.parent_id
     )
     SELECT * FROM anc ORDER BY depth ASC`,
    [nodeId]
  );
  const path = pathRows.map((r) => ({
    depth: r.depth,
    url: r.final_url || r.url,
    title: r.title || null,
    discovery: r.discovery_method || null,
    decodedVia: r.decoded_via || null,
  }));
  // The landing page is the webclip node's parent (the page that offered the
  // profile); if the webclip is the entry itself, fall back to the node.
  const landing = pathRows.length > 1 ? pathRows[pathRows.length - 2] : pathRows[pathRows.length - 1];
  const landingUrl = landing ? (landing.final_url || landing.url) : null;
  const landingTitle = landing ? landing.title : null;

  const clip = await one(
    `INSERT INTO webclips (node_id, signed, label, raw_size, landing_url, landing_title, path)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [nodeId, parsed?.signed || false, parsed?.label || null,
     fetched.buffer ? fetched.buffer.length : (fetched.body ? fetched.body.length : null),
     landingUrl, landingTitle, JSON.stringify(path)]
  );

  if (!parsed) return;

  for (const fullUrl of parsed.urls) {
    const domain = urlToDomain(fullUrl);
    let domainId = null;
    if (domain) {
      domainId = await upsertDomain(domain);
      stats.domains++;
    }
    await query(
      `INSERT INTO webclip_urls (webclip_id, domain_id, full_url) VALUES ($1,$2,$3)`,
      [clip.id, domainId, fullUrl]
    );
    await logRun(run.id, 'info', `解析出完整 URL：${fullUrl} → 域名 ${domain || '(无法提取域名)'}`,
      { fullUrl, domain, landingUrl });
    if (domainId) {
      // Pass landing page + title into the alert context too.
      await checkDomain(domainId, { ...context, webclipUrl: fullUrl, landingUrl, landingTitle });
    }
  }
}
