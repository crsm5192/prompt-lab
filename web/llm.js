/**
 * LLM 客户端 —— OpenAI 兼容。
 *
 * 为什么不用 SDK：只用 /v1/chat/completions 与 /v1/models 两个端点，
 * 自己发 fetch 更透明，也少一个依赖（能少则少）。
 *
 * 配置是**运行时可变的**：createLLM(provider) 每次调用都向 provider 取最新配置，
 * 所以在界面上改完 URL/key/模型立即生效，不需要重启。
 */

import { logModelCall } from './diagnostics.js'

const DEFAULT_TIMEOUT = 180000

export function normalizeBaseURL(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  let url
  try { url = new URL(text) } catch { throw Object.assign(new Error('API 地址无效'), { status: 400 }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('API 地址必须是无用户名、查询参数的 http/https URL'), { status: 400 })
  }
  return url.href.replace(/\/+$/, '')
}

/**
 * @param {() => object} provider 返回 { baseURL, apiKey, defaultModel, timeoutSeconds, maxTokens }
 */
export function createLLM(provider) {
  const current = () => (typeof provider === 'function' ? provider() : provider) || {}

  const base = () => normalizeBaseURL(current().baseURL)
  const key = () => String(current().apiKey || '')
  const defaultModel = () => String(current().defaultModel || '')
  const timeout = () => (Number(current().timeoutSeconds) * 1000) || DEFAULT_TIMEOUT

  /**
   * 调一次模型，返回文本。
   *
   * 支持多模态：传 opts.image 时，user content 变成
   * [{type:'text'}, {type:'image_url'}]（OpenAI 兼容）。
   *
   * @param {object} opts {system, user, image, model, reasoningEffort, temperature, maxTokens, timeoutMs, signal}
   */
  async function chat(opts = {}) {
    opts.signal?.throwIfAborted()
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
    if (opts.reasoningEffort && opts.reasoningEffort !== 'auto') body.reasoning_effort = opts.reasoningEffort

    const thisTimeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeout()
    const ctrl = new AbortController()
    const cancel = () => ctrl.abort()
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => ctrl.abort(), thisTimeout)
    const t0 = Date.now()
    const k = key()
    const knownModel = model === cfg.defaultModel || cfg.models?.some(m => (m.id || m) === model)
    const trace = { model: knownModel && /^[\w./:-]{1,96}$/.test(model) ? model : 'custom',
      input: opts.image ? 'image' : 'text', reasoningEffort: body.reasoning_effort || 'auto',
      limit: body.max_tokens, timeoutMs: thisTimeout, outcome: 'network_error' }
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

      trace.status = res.status
      const text = await res.text()
      if (!res.ok) {
        trace.outcome = 'gateway_http'
        if (body.reasoning_effort && [400, 422].includes(res.status) && /reasoning[_ -]effort/i.test(text)) {
          throw Object.assign(new Error('模型接口 ' + res.status + '：当前模型未接受所选思考强度，请切换到「模型默认」或选择其他档位。'),
            { status: 400, code: 'UNSUPPORTED_REASONING_EFFORT' })
        }
        throw new Error(`模型接口 ${res.status}：${text.slice(0, 300)}`)
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        trace.outcome = 'gateway_non_json'
        throw new Error(`模型返回非 JSON：${text.slice(0, 200)}`)
      }
      const choice = (json.choices && json.choices[0]) || {}
      const content = (choice.message && choice.message.content) || ''
      trace.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason) ? choice.finish_reason : 'unknown'
      trace.contentChars = typeof content === 'string' ? content.length : 0
      trace.hasReasoning = Boolean(choice.message?.reasoning_content || choice.message?.reasoning)
      if (Number.isSafeInteger(json.usage?.completion_tokens)) trace.completionTokens = json.usage.completion_tokens
      trace.outcome = content ? 'ok' : 'model_empty'
      if (!content) throw Object.assign(new Error('模型返回空内容'), { status: 502 })

      return {
        text: content,
        model: json.model || model,
        ms: Date.now() - t0,
        usage: json.usage || null,
      }
    } catch (e) {
      if (ctrl.signal.aborted) trace.outcome = opts.signal?.aborted ? 'client_cancelled' : 'timeout'
      if (opts.signal?.aborted) throw opts.signal.reason
      if (e.name === 'AbortError') throw new Error(`模型调用超时（${thisTimeout / 1000}s）`)
      throw e
    } finally {
      logModelCall({ ...trace, ms: Date.now() - t0 })
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', cancel)
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
    const activeBase = base()
    const b = normalizeBaseURL(override.baseURL || activeBase)
    const k = override.apiKey !== undefined && override.apiKey !== '' && override.apiKey !== '••••••••'
      ? String(override.apiKey)
      : (b === activeBase ? key() : '')

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
