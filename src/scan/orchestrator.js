import { one, query } from '../db/index.js';
import { config } from '../config.js';
import { fetchAsIphone } from '../crawler/fetcher.js';
import { runDecoders } from '../crawler/decoders/index.js';
import { looksLikeWebclip, parseWebclip, urlToDomain } from '../crawler/webclip.js';
import { resolveUrl, expandHandoff, isFollowable, normalize } from '../crawler/urls.js';
import { upsertDomain, checkDomain } from '../domain/service.js';

/**
 * Run a full exhaustive crawl for a task run.
 *
 * Strategy: breadth-first over the discovery tree. Every URL found (via
 * redirects, runtime sub-requests, plaintext links, or decoded payloads) is a
 * child node. We DO NOT stop at the first webclip — a webclip node simply
 * becomes a leaf (we don't crawl past it), and we keep exhausting every other
 * branch up to max_depth. A global node cap guards against runaway trees.
 */
export async function runScan(run, task, { xorKeys = [] } = {}) {
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

  // Simple bounded-concurrency BFS: drain a layer in parallel batches.
  while (queue.length > 0) {
    if (stats.nodes >= config.crawl.maxNodesPerTask) {
      console.warn(`[scan] run ${run.id} hit MAX_NODES_PER_TASK cap`);
      break;
    }
    const batch = queue.splice(0, config.crawl.concurrency);
    const children = await Promise.all(
      batch.map((item) => processNode(item, { run, task, xorKeys, stats, context }))
    );

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
  return stats;
}

async function processNode(item, { run, task, xorKeys, stats, context }) {
  stats.nodes++;
  const fetched = await fetchAsIphone(item.url);

  // Persist this node.
  const isClip = !fetched.error && looksLikeWebclip({
    url: fetched.finalUrl,
    contentType: fetched.contentType,
    buffer: fetched.buffer,
    body: fetched.body,
  });

  const node = await one(
    `INSERT INTO scan_nodes
       (run_id, parent_id, url, depth, discovery_method, decoded_via,
        http_status, content_type, is_webclip, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      run.id, item.parentId, item.url, item.depth, item.discovery, item.decodedVia,
      fetched.status, fetched.contentType, isClip, fetched.error,
    ]
  );

  if (fetched.error) {
    stats.errors++;
    return [];
  }

  // A webclip node is a leaf: parse it, record domains, stop this branch.
  if (isClip) {
    stats.webclips++;
    await ingestWebclip(node.id, fetched, { task, stats, context });
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

  // Structured links extracted from the rendered DOM (relative links resolved).
  for (const link of fetched.links || []) add(link, 'link', null);

  // Redirect chain + runtime sub-requests are the strongest signals.
  const runtimeUrls = [...fetched.redirectChain, ...fetched.subRequests.map((r) => r.url)];

  const candidates = runDecoders({ body: fetched.body, runtimeUrls, xorKeys });
  for (const c of candidates) {
    add(c.url, c.via === 'runtime' || c.via === 'plaintext' ? c.via : 'decoded', c.via);
  }

  return children;
}

async function ingestWebclip(nodeId, fetched, { task, stats, context }) {
  const parsed = parseWebclip({ buffer: fetched.buffer, body: fetched.body });
  const clip = await one(
    `INSERT INTO webclips (node_id, signed, label, raw_size)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [nodeId, parsed?.signed || false, parsed?.label || null,
     fetched.buffer ? fetched.buffer.length : (fetched.body ? fetched.body.length : null)]
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
    if (domainId) {
      await checkDomain(domainId, { ...context, webclipUrl: fullUrl });
    }
  }
}
