/**
 * LLM 客户端 —— OpenAI 兼容。
 *
 * 为什么不用 SDK：只用 /v1/chat/completions 与 /v1/models 两个端点，
 * 自己发 fetch 更透明，也少一个依赖（能少则少）。
 *
 * 配置是**运行时可变的**：createLLM(provider) 每次调用都向 provider 取最新配置，
 * 所以在界面上改完 URL/key/模型立即生效，不需要重启。
 */

const DEFAULT_TIMEOUT = 180000

/**
 * @param {() => object} provider 返回 { baseURL, apiKey, defaultModel, timeoutSeconds, maxTokens }
 */
export function createLLM(provider) {
  const current = () => (typeof provider === 'function' ? provider() : provider) || {}

  const base = () => String(current().baseURL || '').replace(/\/+$/, '')
  const key = () => String(current().apiKey || '')
  const defaultModel = () => String(current().defaultModel || '')
  const timeout = () => (Number(current().timeoutSeconds) * 1000) || DEFAULT_TIMEOUT

  /**
   * 调一次模型，返回文本。
   *
   * 支持多模态：传 opts.image 时，user content 变成
   * [{type:'text'}, {type:'image_url'}]（OpenAI 兼容）。
   *
   * @param {object} opts {system, user, image, model, temperature, maxTokens, timeoutMs}
   */
  async function chat(opts = {}) {
    const cfg = current()
    const b = base()
    if (!b) throw new Error('LLM 地址未配置：请在「设置」里填写 API URL')

    const model = opts.model || defaultModel()
    if (!model) throw new Error('未指定模型：请在「设置」里选择默认模型')

    // 纯文本时 content 是字符串；带图时是数组（OpenAI vision 格式）
    let userContent = opts.user
    if (opts.image) {
      let url = opts.image
      if (typeof opts.image === 'object' && opts.image.b64) {
        const mt = opts.image.mediaType || 'image/jpeg'
        url = `data:${mt};base64,${opts.image.b64}`
      } else if (typeof opts.image === 'object' && opts.image.url) {
        url = opts.image.url
      }
      userContent = [
        { type: 'text', text: String(opts.user || '') },
        { type: 'image_url', image_url: { url } },
      ]
    }

    const body = {
      model,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: userContent },
      ],
      temperature: opts.temperature === undefined ? 0.7 : Number(opts.temperature),
      max_tokens: Number(opts.maxTokens) || Number(cfg.maxTokens) || 4000,
      stream: false,
    }

    const thisTimeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeout()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), thisTimeout)
    const t0 = Date.now()
    const k = key()
    try {
      const res = await fetch(`${b}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(k ? { Authorization: `Bearer ${k}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      const text = await res.text()
      if (!res.ok) {
        throw new Error(`模型接口 ${res.status}：${text.slice(0, 300)}`)
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`模型返回非 JSON：${text.slice(0, 200)}`)
      }
      const choice = (json.choices && json.choices[0]) || {}
      const content = (choice.message && choice.message.content) || ''
      if (!content) throw new Error('模型返回空内容')

      return {
        text: content,
        model: json.model || model,
        ms: Date.now() - t0,
        usage: json.usage || null,
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`模型调用超时（${thisTimeout / 1000}s）`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 拉取模型列表（GET /models）。
   *
   * 允许传入临时覆盖，用于「先在界面上填好再点测试」——
   * 此时还没保存，不能依赖 provider 的当前值。
   *
   * @param {{baseURL?:string, apiKey?:string}} override
   * @returns {{ok:boolean, base:string, models:Array<{id:string}>, raw?:number, error?:string}}
   */
  async function listModels(override = {}) {
    const cfg = current()
    const b = String(override.baseURL || base() || '').replace(/\/+$/, '')
    const k = override.apiKey !== undefined && override.apiKey !== '' && override.apiKey !== '••••••••'
      ? String(override.apiKey)
      : key()

    if (!b) return { ok: false, base: b, models: [], error: 'API URL 未配置' }

    try {
      const res = await fetch(`${b}/models`, {
        headers: k ? { Authorization: `Bearer ${k}` } : {},
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, base: b, models: [], error: `HTTP ${res.status}：${text.slice(0, 200)}` }
      }
      let ids = []
      try {
        const j = JSON.parse(text)
        // 兼容 OpenAI（data[]）、Anthropic 风格、以及裸数组
        const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : [])
        ids = arr
          .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name))))
          .filter(Boolean)
          .map(String)
      } catch {
        return { ok: false, base: b, models: [], error: `返回非 JSON：${text.slice(0, 150)}` }
      }
      return { ok: true, base: b, models: ids.map((id) => ({ id })), raw: ids.length }
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? '请求超时（20s）' : String(e.message || e)
      return { ok: false, base: b, models: [], error: msg }
    }
  }

  /** 探测：地址 + key 是否可用（顺便带回模型数）。 */
  async function probe(override = {}) {
    const r = await listModels(override)
    const cfg = current()
    return {
      ok: r.ok,
      base: r.base,
      model: cfg.defaultModel || '',
      available: r.models.length,
      sample: r.models.slice(0, 20).map((m) => m.id),
      error: r.error,
    }
  }

  return {
    chat,
    listModels,
    probe,
    get base() { return base() },
    get defaultModel() { return defaultModel() },
    get hasKey() { return !!key() },
  }
}
