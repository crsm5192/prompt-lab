/**
 * ZeroTier 内网服务客户端 —— 直连，不再需要 NAS 桥接。
 *
 * 本机 DSH 插件版走的是 `nas_bridge.py`（ssh 到 101 执行 python）。
 * 102 本身就在 ZT 网里，所有服务可以直接 HTTP 访问，**这层桥接可以砍掉**，
 * 好处是：少一次 ssh、延迟低、错误信息更明确。
 *
 * 服务清单（102 实测可达）：
 *   101:7863  WorkBuddy 网关（LLM）
 *   61:1933   OpenViking（合规，含角色库/画师库检索）
 *   61:1934   OpenViking（NSFW 镜像）
 *   61:8188   ComfyUI（备用）
 */
import { request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** 极简 JSON HTTP 客户端（支持超时与自定义头）。 */
export function fetchJson(url, opts = {}) {
  const u = new URL(url)
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('服务地址必须使用 http 或 https')
  const isHttps = u.protocol === 'https:'
  const lib = isHttps ? httpsRequest : request
  const body = opts.body === undefined ? null : Buffer.from(
    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body), 'utf8')

  return new Promise((resolve, reject) => {
    const req = lib({
      hostname: u.hostname,
      port: Number(u.port) || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || (body ? 'POST' : 'GET'),
      ...(opts.proxy ? { agent: new HttpsProxyAgent(opts.proxy) } : {}),
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
          return
        }
        try { resolve(JSON.parse(text)) }
        catch { resolve({ _raw: text }) }
      })
      res.on('error', reject)
    })
    req.on('error', (e) => reject(new Error(`${e.code || ''} ${e.message}`.trim())))
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error(`超时（${Math.round((opts.timeoutMs || 30000) / 1000)}s）`))
    }, opts.timeoutMs || 30000)
    req.on('close', () => clearTimeout(timer))
    if (body) req.write(body)
    req.end()
  })
}

// ── OpenViking（Viking 检索 / 角色库）──────────────────────────────────────

export function createViking(config) {
  const enabled = config?.enabled !== false
  const instances = (config && config.instances) || []
  const apiKey = process.env[(config && config.apiKeyEnv) || 'OPENVIKING_API_KEY'] || ''

  /** 按实例名取 base URL。 */
  function baseOf(name) {
    const hit = instances.find((i) => i.name === name)
    return hit ? String(hit.baseURL || '').replace(/\/+$/, '') : ''
  }

  async function call(instance, path, body, timeoutMs) {
    const base = baseOf(instance)
    if (!base) throw new Error(`未配置 OpenViking 实例：${instance}`)
    return fetchJson(base + path, {
      method: 'POST',
      body,
      timeoutMs: timeoutMs || config?.timeoutMs || 60000,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {},
    })
  }

  /**
   * 语义检索（/api/v1/search/find）。
   * 对应本机插件的 doVikingSearch。
   */
  async function find(opts) {
    if (!enabled) return { ok: true, disabled: true, refs: [], total: 0, errors: [], note: 'OpenViking 已停用' }
    const query = String(opts.query || '').trim()
    if (!query) throw new Error('没有可检索的内容')
    const instance = opts.instance || (config && config.active) || 'compliance'
    const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5))

    const body = {
      query,
      limit: limit + 2,
      read_content: opts.withText !== false,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.targetUri ? { target_uri: opts.targetUri } : {}),
    }

    // 两个实例都试（合规 / NSFW）；主实例失败自动降级
    const order = [instance, ...instances.map((i) => i.name).filter((n) => n !== instance)]
    const errors = []
    for (const name of order) {
      try {
        const r = await call(name, '/api/v1/search/find', body, opts.timeoutMs)
        // 真实结构：{status, result: {memories: [], resources: [{uri, score, abstract, level}]}}
        // 注意不是顶层 results，也不是 hits——之前解析错导致 total 恒为 0。
        const res = r.result || r
        const list = []
        if (Array.isArray(res.resources)) list.push(...res.resources.map((x) => ({ ...x, _kind: 'resource' })))
        if (Array.isArray(res.memories)) list.push(...res.memories.map((x) => ({ ...x, _kind: 'memory' })))
        if (Array.isArray(res.hits)) list.push(...res.hits)
        if (!list.length) list.push(...(Array.isArray(r.results) ? r.results : []))

        const refs = list.slice(0, limit).map((h) => ({
          instance: name,
          kind: h._kind || 'resource',
          contextType: h.context_type || '',
          uri: h.uri || h.path || '',
          level: h.level ?? null,
          score: h.score ?? h.similarity ?? null,
          abstract: String(h.abstract || h.summary || '').slice(0, 400),
          text: String(h.text || h.content || '').slice(0, opts.refTextChars || 800),
        }))
        return {
          ok: true, instance: name, refs,
          total: Number(res.count) || refs.length,
          memories: Array.isArray(res.memories) ? res.memories.length : 0,
          errors,
          note: refs.length ? '' : '未命中任何资源',
        }
      } catch (e) {
        errors.push(`${name}: ${String(e.message || e).slice(0, 120)}`)
      }
    }
    return { ok: false, refs: [], total: 0, errors, note: '所有实例均失败' }
  }

  /** 探测各实例可用性。 */
  async function probe() {
    if (!enabled) return instances.map((i) => ({ name: i.name, base: i.baseURL, ok: true, disabled: true }))
    const out = []
    for (const inst of instances) {
      const base = String(inst.baseURL || '').replace(/\/+$/, '')
      try {
        const r = await fetchJson(base + '/health', { timeoutMs: 8000 })
        out.push({ name: inst.name, base, ok: r.healthy !== false && r.status !== 'error', detail: r })
      } catch (e) {
        out.push({ name: inst.name, base, ok: false, error: String(e.message || e).slice(0, 150) })
      }
    }
    return out
  }

  return { find, probe, baseOf, hasKey: !!apiKey, enabled }
}

// ── Danbooru（标签详情）────────────────────────────────────────────────────

export function createBooru(config) {
  const cfg = config || {}
  const enabled = cfg.enabled !== false
  const base = String(cfg.baseURL || 'https://danbooru.donmai.us').replace(/\/+$/, '')
  const ua = cfg.userAgent || 'prompt-lab-nas/1.0'
  const timeout = Number(cfg.timeoutSeconds) * 1000 || 30000
  const CATEGORY = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' }

  function q(path, params) {
    const u = new URL(base + path)
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  async function get(url) {
    const r = await fetchJson(url, { headers: { 'User-Agent': ua }, timeoutMs: timeout, proxy: cfg.proxy })
    if (r._raw !== undefined) throw new Error('Danbooru 返回非 JSON')
    return r
  }

  /** 标签搜索（按名字前缀，按热度排序）。 */
  async function search(qstr, limit) {
    if (!enabled) return []
    const arr = await get(q(`/tags.json`, {
      'search[name_matches]': `${qstr}*`,
      'search[order]': 'count',
      limit: limit || 20,
    }))
    return (Array.isArray(arr) ? arr : []).map((t) => ({
      name: t.name,
      postCount: t.post_count,
      category: CATEGORY[t.category] || 'general',
      categoryId: t.category,
    }))
  }

  /** 精确核验一个标签（角色锚点用）。 */
  async function verify(names) {
    if (!enabled) return []
    const list = (Array.isArray(names) ? names : [names]).filter(Boolean)
    if (!list.length) return []
    const arr = await get(q(`/tags.json`, {
      'search[name_comma]': list.join(','),
      limit: list.length + 5,
    }))
    return (Array.isArray(arr) ? arr : []).map((t) => ({
      name: t.name,
      postCount: t.post_count,
      category: CATEGORY[t.category] || 'general',
    }))
  }

  /** 标签 Wiki 简介。 */
  async function wiki(name) {
    if (!enabled) return { ok: false, disabled: true, name, body: '', error: 'Danbooru 已停用' }
    const arr = await get(q(`/wiki_pages.json`, {
      'search[title]': name,
      limit: 1,
    }))
    const p = Array.isArray(arr) ? arr[0] : null
    if (!p) return { ok: false, name, body: '', error: '无 wiki 页面' }
    return {
      ok: true, name, title: p.title,
      body: String(p.body || '').slice(0, 2000),
    }
  }

  /** 相关标签（同图共现）。 */
  async function related(name, limit) {
    if (!enabled) return []
    const arr = await get(q(`/related_tag.json`, {
      query: name, limit: limit || 16,
    }))
    // 结构：{ related_tags: [{ tag: {name}, frequency, jaccard }] }
    const rows = (arr && (arr.related_tags || arr.relatedTag || [])) || []
    return rows.slice(0, limit || 16).map((r) => ({
      name: (r.tag && r.tag.name) || r.name || '',
      frequency: r.frequency ?? r.post_count ?? 0,
      jaccard: r.jaccard ?? null,
    })).filter((r) => r.name)
  }

  /**
   * 示例图。
   *
   * 三档 URL 的取舍（踩过坑）：
   *   file_url       原图，可能几 MB~几十 MB（3256x2480），缩略图用不上
   *   large_file_url sample 版，约 850px，**细节与体积的平衡点** ← 用这个
   *   preview_file_url 180x180，糊到看不出细节
   * 所以优先 sample，其次原图，最后 preview。
   */
  async function posts(tags, limit, ratings) {
    if (!enabled) return []
    const params = {
      tags: tags + (ratings ? ` rating:${ratings}` : ''),
      limit: limit || 8,
    }
    const arr = await get(q(`/posts.json`, params))
    return (Array.isArray(arr) ? arr : []).map((p) => {
      const sample = p.large_file_url || ''
      const original = p.file_url || ''
      const preview = p.preview_file_url || ''
      return {
        id: p.id,
        score: p.score,
        rating: p.rating,
        // 展示优先 sample；同时保留原图供「看大图」
        large: sample || original || preview,
        original,
        preview,
        width: p.image_width, height: p.image_height,
        tags: String(p.tag_string || '').split(' ').filter(Boolean).slice(0, 20),
      }
    })
  }

  async function probe() {
    if (!enabled) return { ok: true, disabled: true, base }
    try { return { ok: true, base, sample: (await search('1girl', 1)).length } }
    catch (e) { return { ok: false, base, error: String(e.message || e).slice(0, 150) } }
  }
  return { search, verify, wiki, related, posts, probe, base, enabled }
}
