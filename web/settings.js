/**
 * 运行时设置 —— 把 LLM 的 baseURL / apiKey / 模型 从「启动时固定」变成「可配置」。
 *
 * 三层优先级（高 → 低）：
 *   1. 环境变量（LLM_BASE_URL / WORKBUDDY_API_KEY）—— 容器化部署时由编排注入
 *   2. 运行时设置文件（data/settings.json）—— 界面上改的
 *   3. config.json 里的 llm 段 —— 出厂默认
 *
 * 为什么密钥不写进 settings.json：
 *   settings.json 可能被挂载、被备份、被误提交。密钥单独放 secrets 目录，
 *   权限 600，且**永不回传前端**——前端只知道「有没有配」，不知道值是什么。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeBaseURL } from './llm.js'

const MASK = '••••••••'

/**
 * @param {object} opts { dir, defaults }  defaults = config.json 的 llm 段
 */
export function createSettings({ dir, defaults }) {
  const settingsPath = join(dir, 'settings.json')
  const secretPath = join(dir, 'llm-key.txt')   // 单独存密钥，权限 600

  const ensureDir = () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /** 读设置文件（不存在则空对象）。 */
  function readSettings() {
    if (!existsSync(settingsPath)) return {}
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return {}
    }
  }

  /** 原子写（先写临时文件再改名，避免写一半断电留下坏 JSON）。 */
  function writeAtomic(path, text, mode) {
    ensureDir()
    const tmp = `${path}.tmp${process.pid}`
    writeFileSync(tmp, text, 'utf8')
    if (mode) { try { chmodSync(tmp, mode) } catch { /* Windows 上可能不支持 */ } }
    renameSync(tmp, path)
  }

  function readSecret() {
    if (!existsSync(secretPath)) return ''
    try {
      return readFileSync(secretPath, 'utf8').trim()
    } catch {
      return ''
    }
  }

  /**
   * 解析出生效的配置。
   * 注意 apiKey 的优先级：环境变量 > secret 文件，避免容器注入被界面误覆盖。
   */
  function resolve() {
    const s = readSettings()
    const d = defaults || {}
    const envBase = process.env[d.baseURLEnv || 'LLM_BASE_URL'] || ''
    const envKey = process.env[d.apiKeyEnv || 'WORKBUDDY_API_KEY'] || ''

    const baseURL = String(envBase || s.baseURL || d.baseURL || '').replace(/\/+$/, '')
    const apiKey = envKey || readSecret()
    const defaultModel = String(s.defaultModel || d.defaultModel || '')
    // 模型清单：界面里存过就用存的，否则用 config.json 的
    const models = Array.isArray(s.models) && s.models.length
      ? s.models
      : (Array.isArray(d.models) ? d.models : [])

    return {
      baseURL,
      apiKey,
      apiKeyEnv: d.apiKeyEnv || 'WORKBUDDY_API_KEY',
      defaultModel,
      models,
      timeoutSeconds: Number(d.timeoutSeconds) || 180,
      maxTokens: Number(d.maxTokens) || 4000,
      temperature: d.temperature || {},
      // 来源标记，便于界面提示「当前生效的是哪一层」
      source: {
        baseURL: envBase ? 'env' : (s.baseURL ? 'settings' : 'config'),
        apiKey: envKey ? 'env' : (readSecret() ? 'settings' : 'none'),
        models: (Array.isArray(s.models) && s.models.length) ? 'settings' : 'config',
      },
    }
  }

  /**
   * 保存设置。只接受白名单字段，且密钥为空时表示「不修改」。
   *
   * @param {object} patch { baseURL, apiKey, defaultModel, models }
   */
  function save(patch = {}) {
    const cur = readSettings()
    const next = { ...cur }

    if (patch.baseURL !== undefined) {
      const v = normalizeBaseURL(patch.baseURL)
      if (v) next.baseURL = v
      else delete next.baseURL
    }
    if (patch.defaultModel !== undefined) {
      const v = String(patch.defaultModel || '').trim()
      if (v) next.defaultModel = v
      else delete next.defaultModel
    }
    if (patch.models !== undefined) {
      const list = Array.isArray(patch.models) ? patch.models : []
      const clean = list
        .map((m) => {
          if (typeof m === 'string') return { id: m.trim() }
          if (m && typeof m === 'object' && m.id) {
            const out = { id: String(m.id).trim() }
            if (m.label) out.label = String(m.label)
            if (m.contextWindow) out.contextWindow = Number(m.contextWindow)
            if (m.maxTokens) out.maxTokens = Number(m.maxTokens)
            return out
          }
          return null
        })
        .filter((m) => m && m.id)
      if (clean.length) next.models = clean
      else delete next.models
    }

    // 密钥：只有非空且不是掩码时才写
    if (patch.apiKey !== undefined) {
      const k = String(patch.apiKey || '').trim()
      if (k && k !== MASK) {
        writeAtomic(secretPath, k, 0o600)
      } else if (k === '') {
        // 显式传空字符串 = 清除
        if (existsSync(secretPath)) writeAtomic(secretPath, '', 0o600)
      }
      // k === MASK 表示前端把掩码原样回传，忽略
    }

    writeAtomic(settingsPath, JSON.stringify(next, null, 2))
    return resolve()
  }

  /** 给前端的视图：密钥只给布尔与掩码，绝不给值。 */
  function publicView() {
    const r = resolve()
    return {
      baseURL: r.baseURL,
      defaultModel: r.defaultModel,
      models: r.models,
      hasApiKey: !!r.apiKey,
      apiKeyMask: r.apiKey ? MASK : '',
      source: r.source,
      // 提示优先级，避免用户以为界面改了却没生效
      note: '环境变量优先级高于界面设置；若 apiKey 来源为 env，界面里填的值不会覆盖它。',
    }
  }

  return { resolve, save, publicView, paths: { settingsPath, secretPath }, MASK }
}
