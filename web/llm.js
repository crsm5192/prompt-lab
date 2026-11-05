/**
 * LLM 客户端 —— OpenAI 兼容（WorkBuddy 网关）。
 *
 * 为什么不用 SDK：只用 /v1/chat/completions 一个端点，自己发 fetch 更透明，
 * 也少一个依赖（102 上装包要过镜像源，能少则少）。
 *
 * 网关地址通过 config.baseURL 或环境变量 BASE_URL 配置，
 * 因此可对接任何 OpenAI 兼容服务（自建网关、Ollama、vLLM 等）。
 */

const DEFAULT_TIMEOUT = 180000

export function createLLM(config) {
  // baseURL 支持环境变量覆盖，部署时不必改代码
  const rawBase = (config.baseURLEnv && process.env[config.baseURLEnv]) || config.baseURL
  const base = String(rawBase || '').replace(/\/+$/, '')
  const apiKey = process.env[config.apiKeyEnv || 'WORKBUDDY_API_KEY'] || ''
  const defaultModel = config.defaultModel || 'cn:primary-model'
  const timeout = Number(config.timeoutSeconds) * 1000 || DEFAULT_TIMEOUT

  if (!apiKey) {
    console.warn(`[llm] 警告：环境变量 ${config.apiKeyEnv} 未设置，调用会失败`)
  }

  /**
   * 调一次模型，返回文本。
   *
   * 支持多模态：传 opts.image 时，user content 会变成
   * [{type:'text'}, {type:'image_url'}] 的数组格式（OpenAI 兼容）。
   *
   * @param {object} opts {system, user, image, model, temperature, maxTokens}
   *   image: { b64, mediaType } 或 data URL 字符串
   */
  async function chat(opts) {
    const model = opts.model || defaultModel

    // 纯文本时 content 是字符串；带图时是数组（OpenAI vision 格式）
    let userContent = opts.user
    if (opts.image) {
      let url = opts.image
      if (typeof opts.image === 'object' && opts.image.b64) {
        const mt = opts.image.mediaType || 'image/jpeg'
        url = `data:${mt};base64,${opts.image.b64}`
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
      max_tokens: Number(opts.maxTokens) || Number(config.maxTokens) || 4000,
      stream: false,
    }

    const ctrl = new AbortController()
    // 单次调用可覆盖超时（VLM 带图较慢，需要独立预算）
    const thisTimeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeout
    const timer = setTimeout(() => ctrl.abort(), thisTimeout)
    const t0 = Date.now()
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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

  /** 探测网关与 key 是否可用（界面「检测」用）。 */
  async function probe() {
    try {
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15000),
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, base, error: `HTTP ${res.status}：${text.slice(0, 200)}` }
      }
      let ids = []
      try {
        const j = JSON.parse(text)
        ids = (j.data || []).map((m) => m.id).slice(0, 20)
      } catch { /* 不解析也能认为通了 */ }
      return { ok: true, base, model: defaultModel, available: ids.length, sample: ids }
    } catch (e) {
      return { ok: false, base, error: String(e.message || e) }
    }
  }

  return { chat, probe, base, defaultModel, hasKey: !!apiKey }
}
