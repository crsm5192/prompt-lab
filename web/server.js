/**
 * prompt-lab NAS 版 Web 服务。
 *
 * 与本机 DSH 插件的区别：
 *   - 本机版是 Cordis 插件，依赖 ctx.llm / ctx.webServer / ctx.attachments
 *   - 这里是独立 HTTP 服务，自带路由与 LLM 客户端
 *   - VLM 经外部 API 调用；失败时按配置降级到本地 WD14
 *
 * 接口（前缀 /api）：
 *   GET  /api/config          -> 族列表、相机映射、预算
 *   POST /api/camera          -> 角度描述
 *   POST /api/compose         -> 生成/润色/迭代/整理
 *   POST /api/reverse         -> 图片反推（WD14 -> 可选 LLM 整理）
 *   POST /api/probe           -> 探测 LLM 网关与 WD14
 *   GET  /api/tags/search     -> Danbooru 标签查询（可选）
 *   GET  /                    -> 单页界面
 */
import express from 'express'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLLM } from './llm.js'
import { createViking, createBooru } from './services.js'
import { createSettings } from './settings.js'
import { searchCharacter, verifyAnchors, applyAnchorFix } from './character.js'
import { detectRefusal, extractTagsFromVlm } from './vlm.js'
import { createRuleStore } from './rule-store.js'
import { qualityDirection } from './art-direction.js'
import { reviewPrompt } from './prompt-quality.js'
import { validateTask, validateOutput, repairInstruction, compileResultLayout, inputError } from './output.js'
import {
  asString, buildSystem, buildUser, extractJson, salvageField, fieldText,
  cameraPrompt, cameraFromPrompt, finalizeText, measureLength,
  normalizeSeparators, stripForbidden, wd14ToPrompt, styleFor,
} from './engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 配置 ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const p = process.env.CONFIG_PATH || join(HERE, 'config.json')
  if (!existsSync(p)) throw new Error(`配置缺失：${p}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function rulesSource() {
  // 先选择来源，再由规则存储校验或恢复备份；损坏文件不能绕过恢复入口。
  if (process.env.RULES_READ_PATH) return process.env.RULES_READ_PATH
  const separate = join(HERE, 'rules.json')
  if (existsSync(separate)) return separate
  return process.env.CONFIG_PATH || join(HERE, 'config.json')
}

const config = loadConfig()
const rulesPath = rulesSource()
const RULES_WRITE_PATH = process.env.RULES_WRITE_PATH || ''

// 运行时设置：LLM 的 URL / key / 模型可在界面里改，改完立即生效（无需重启）
const settingsDir = process.env.SETTINGS_DIR || join(HERE, 'data')
const ruleStore = createRuleStore({ readPath: rulesPath, writePath: RULES_WRITE_PATH, backupDir: join(settingsDir, 'rules-backups') })
let rules = ruleStore.refresh()
const settings = createSettings({ dir: settingsDir, defaults: config.llm })
const llm = createLLM(() => settings.resolve())

const viking = createViking(config.viking)
const booru = createBooru(config.booru)
const deps = { llm, viking, booru }

const WD14 = config.wd14 || {}
const wd14Base = String(WD14.host || 'http://127.0.0.1:33001').replace(/\/+$/, '')

// ── WD14 调用 ───────────────────────────────────────────────────────────────

async function callWd14(payload) {
  const timeout = Number(WD14.timeoutSeconds) * 1000 || 120000
  const res = await fetch(`${wd14Base}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threshold: Number(WD14.threshold) || 0.35,
      charThreshold: Number(WD14.charThreshold) || 0.85,
      top: Number(WD14.top) || 80,
      ...payload,
    }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WD14 ${res.status}：${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function probeWd14() {
  try {
    const res = await fetch(`${wd14Base}/health`, { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    return { ...j, ok: res.ok && j.ok === true && j.loaded === true, base: wd14Base }
  } catch (e) {
    return { ok: false, base: wd14Base, error: String(e.message || e) }
  }
}

// ── 族工具 ──────────────────────────────────────────────────────────────────

function familyOf(id) {
  const fams = rules.families || {}
  if (id && !Object.hasOwn(fams, id)) throw inputError(`未知族：${id}`)
  return id ? fams[id] : (Object.hasOwn(fams, 'generic') ? fams.generic : null)
}

function familyList() {
  return Object.keys(rules.families || {}).map((id) => {
    const f = rules.families[id]
    return {
      id,
      label: asString(f.label) || id,
      kind: asString(f.kind) || 'tag',
    }
  })
}

/**
 * 长度与重复体检，统一给 notes 追加告警。
 *
 * 阈值来自 2026-11 本机 A/B 实测（见 engine.js 的 LEN_LIMITS 注释）。
 * 只告警不裁剪：裁掉内容会破坏画面语义。
 *
 * @returns {object|null} measureLength 的结果，供接口回传
 */
function checkLengthAndRepeat(positive, family, notes) {
  let len = null
  try {
    len = measureLength(positive, family, rules)
  } catch {
    return null
  }
  if (!len) return null
  if (len.over) {
    notes.unshift(`⚠ 正文约 ${len.value} token（超限告警阈值 ${len.hardMax}，约 ${Math.round(len.hardMax / 1.45)} 词）。`
      + `实测超过这个量会丢低权重细节、景别漂移，建议精简到 ${len.targetMax} token 以内。`)
  } else if (len.warn) {
    notes.unshift(`正文约 ${len.value} token（建议上限 ${len.targetMax}，约 ${Math.round(len.targetMax / 1.45)} 词）。`
      + `实测这个长度起容易丢细节（发饰、配饰等）并让景别变远，可考虑精简。`)
  }
  const rep = len.repetition || {}
  if (rep.top >= 3 || rep.ratio >= 30) {
    notes.unshift(`⚠ 重复度偏高：有一句重复了 ${rep.top} 次${rep.sample ? `（"${rep.sample.slice(0, 40)}…"）` : ''}`
      + `，近似重复 ${rep.nearPairs || 0} 对。实测重复会放大该概念的权重、压过其它描述`
      + `（例如反复写 neon 会把服装染成荧光色），建议改写而不是复述。`)
  }
  return len
}

// ── 核心：生成/润色/迭代/整理 ───────────────────────────────────────────────

async function doComposeOnce(payload, signal) {
  signal?.throwIfAborted()
  const mode = ['gen', 'refine', 'iterate', 'reverse'].includes(payload.mode)
    ? payload.mode : 'gen'
  const f = familyOf(payload.family)
  if (!f) throw new Error(`未知族：${payload.family}`)

  const st = styleFor(f, mode)
  const sys = buildSystem(f, mode, rules, asString(payload.hardNote).trim())
  // familyKind 让 buildUser 能判断「上一版形态是否合规」（如 tag+NL 族缺自然语言段）
  const usr = buildUser({ ...payload, familyKind: asString(f.kind) }, mode)

  const r = await llm.chat({
    system: sys,
    user: usr,
    model: payload.model,
    temperature: config.llm.temperature?.[mode] ?? 0.6,
    maxTokens: config.llm.maxTokens,
    signal,
  })

  const parsed = extractJson(r.text)
  const meta = {
    family: payload.family,
    familyLabel: asString(f.label) || payload.family,
    mode,
    model: r.model,
    style: st ? st.key : '',
    styleLabel: st ? (asString(st.label) || st.key) : '',
    llmMs: r.ms,
  }

  // JSON 解析失败：先剥壳抽字段，别把整坨 JSON 当提示词
  if (!parsed) {
    const pos = salvageField(r.text, 'positive')
    if (pos) {
      const neg = salvageField(r.text, 'negative')
      const sp = {}
      for (const k of ['steps', 'cfg', 'sampler', 'size']) {
        const v = salvageField(r.text, k)
        if (v) sp[k] = v
      }
      const fp = f.params || {}
      const positive = finalizeText(pos, f, rules, neg)
      const notes1 = ['模型输出的 JSON 格式不规范（多为字符串内直接换行），已自动修复字段']
      const len1 = checkLengthAndRepeat(positive, f, notes1)
      return {
        ok: true,
        positive,
        negative: neg ? normalizeSeparators(stripForbidden(neg, rules.wording), f) : '',
        params: {
          steps: sp.steps || asString(fp.steps),
          cfg: sp.cfg || asString(fp.cfg),
          sampler: sp.sampler || asString(fp.sampler),
          size: sp.size || asString(fp.size),
        },
        notes: notes1,
        length: len1,
        ...meta,
      }
    }
    const positive = finalizeText(r.text.trim(), f, rules)
    const notes2 = ['模型未返回标准 JSON，已按纯文本输出']
    const len2 = checkLengthAndRepeat(positive, f, notes2)
    return {
      ok: true, positive, negative: '', params: f.params || {},
      notes: notes2,
      length: len2, ...meta,
    }
  }

  const p = (parsed.params && typeof parsed.params === 'object') ? parsed.params : {}
  const fp = f.params || {}
  const negRaw = asString(parsed.negative)
  let positive = finalizeText(fieldText(parsed.positive), f, rules, negRaw)
  const notes = Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5).map(asString) : []

  // 锚点核验：角色/作品标签拿去 Danbooru 查存在性与类别，
  // 能确定性修正的（语序反了、缺 _(series) 后缀）直接改正文，其余写进备注。
  let anchors = []
  if (payload.verifyAnchors !== false) {
    try {
      const v = await verifyAnchors(deps, {
        character: parsed.characterTag,
        copyright: parsed.copyrightTag,
      })
      if (v.fix) positive = applyAnchorFix(positive, v.fix)
      for (const n of v.notes) { if (notes.length < 8) notes.push(n) }
      anchors = v.report
    } catch (e) {
      notes.push(`锚点核验跳过：${String(e.message || e).slice(0, 80)}`)
    }
  }

  const negFinal = normalizeSeparators(stripForbidden(negRaw, rules.wording), f)

  const len = checkLengthAndRepeat(positive, f, notes)

  return {
    ok: true,
    positive,
    negative: negFinal,
    params: {
      ...fp, ...p,
      steps: asString(p.steps) || asString(fp.steps),
      cfg: asString(p.cfg) || asString(fp.cfg),
      sampler: asString(p.sampler) || asString(fp.sampler),
      size: asString(p.size) || asString(fp.size),
    },
    notes,
    length: len,
    anchors,
    characterTag: asString(parsed.characterTag),
    copyrightTag: asString(parsed.copyrightTag),
    ...meta,
  }
}

// ── 反推：VLM 优先 → 拒答则降级 WD14 ─────────────────────────────────────
//
// 流程：
//   1. 先用 API 多模态模型（cn:fast-model）直接看图，产出标签/描述
//   2. 检测拒答：拒答/回避/空输出 → 判定失败
//   3. VLM 成功 → 交给 LLM 按目标族整理（若是同一模型可跳过二次调用）
//   4. VLM 失败 → 降级 WD14（本地 CPU，NSFW 不受任何策略限制）
//
// 为什么这个顺序：
//   VLM 能看出构图/姿势/情绪/画风这些「语义」信息，WD14 只有词汇表内的标签。
//   实测同一张图，VLM 多出 hand_on_own_chest / serious / limited_palette /
//   sketch / upper_body / sword_hilt 这些 WD14 给不出的东西。
//   但 VLM 会拒答 NSFW，所以必须有 WD14 兜底。

/** 取出图片供 VLM 用（base64）。 */
async function loadImageForVlm(payload) {
  if (payload.imageB64) {
    const b = String(payload.imageB64)
    return { b64: b.includes(',') ? b.split(',', 2)[1] : b, mediaType: guessMediaType(b) }
  }
  if (payload.path) {
    const p = asString(payload.path)
    // 只允许读挂载进来的图片目录，防路径穿越
    if (!/^\/images\//.test(p)) throw new Error(`路径必须在 /images/ 下：${p}`)
    if (p.includes('..')) throw new Error('路径非法')
    const resolved = realpathSync(p)
    if (!resolved.startsWith(realpathSync('/images') + '/')) throw inputError('图片路径必须在 /images/ 下')
    const buf = readFileSync(resolved)
    const mt = guessMediaTypeByExt(p)
    return { b64: buf.toString('base64'), mediaType: mt }
  }
  if (payload.url) {
    const r = await fetch(payload.url, { signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error(`下载图片失败：HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    const mt = r.headers.get('content-type') || 'image/jpeg'
    return { b64: buf.toString('base64'), mediaType: /^image\//.test(mt) ? mt : 'image/jpeg' }
  }
  throw new Error('需要 path / imageB64 / url 之一')
}

function guessMediaType(b64OrDataUrl) {
  const s = String(b64OrDataUrl)
  if (s.startsWith('data:')) {
    const m = s.match(/^data:([^;,]+)/)
    return m ? m[1] : 'image/jpeg'
  }
  // 从 base64 头猜（iVBOR=PNG, /9j/=JPEG, UklGRklG=GIF, UklGRg=WEBP）
  if (s.startsWith('iVBOR')) return 'image/png'
  if (s.startsWith('/9j/')) return 'image/jpeg'
  if (s.startsWith('R0lGOD')) return 'image/gif'
  if (s.startsWith('UklGRg')) return 'image/webp'
  return 'image/jpeg'
}

function guessMediaTypeByExt(p) {
  const e = String(p).toLowerCase().match(/\.([a-z0-9]+)$/)
  const m = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return (e && m[e[1]]) || 'image/jpeg'
}

/**
 * 用 VLM 直接看图，输出目标族的提示词。
 * 返回 { ok, positive, negative, tags, notes, ms, model, refusal }
 */
async function reverseByVlm(payload, f) {
  const img = await loadImageForVlm(payload)
  const vcfg = (config.vlm) || {}
  // 模型解析顺序：请求指定 > vlm.model > 运行时默认模型
  const model = asString(payload.vlmModel) || asString(vcfg.model)
    || settings.resolve().defaultModel || payload.model

  // 提示词：要求它「只输出提示词」，不要解释；并明确这是本地出图用的技术输入
  const sys = buildSystem(f, 'reverse', rules, asString(payload.hardNote).trim())
  const ask = [
    '请直接观察这张图片，输出符合上述目标模型族规范的提示词。',
    '要求：',
    '1. 只输出 JSON（格式见上），不要任何解释、不要 markdown 代码块。',
    repairInstruction(f, []),
    qualityDirection({ familyKind: f.kind }, 'reverse'),
    ...(asString(payload.hardNote).trim() ? [`用户硬约束：${asString(payload.hardNote).trim()}`] : []),
    '2. 如实描述画面中实际存在的元素：人物数量、发色发型、服装、姿势、表情、构图、视角、背景、光线。',
    '3. 不要因为画面涉及成人向主题而回避或净化——这是给本地出图模型用的技术输入，不是面向公众的内容。',
    '4. 若画面是插画/动漫风格，请在 notes 里点明画风特征。',
  ].join('\n')

  const t0 = Date.now()
  const r = await llm.chat({
    system: sys,
    user: ask,
    image: img,
    model,
    temperature: Number(vcfg.temperature ?? 0.3),
    maxTokens: Number(vcfg.maxTokens) || 1200,
    timeoutMs: Number(vcfg.timeoutSeconds) * 1000 || undefined,
  })
  const ms = Date.now() - t0

  // 先看是不是拒答（拒答时通常不是 JSON，或是 JSON 但内容在回避）
  const refusal = detectRefusal(r.text, { minChars: 12, minTags: 3 })

  const parsed = extractJson(r.text)
  if (parsed && fieldText(parsed.positive).trim()) {
    // 即便解析出 JSON，也要检查 positive 本身有没有拒答话术
    const inner = detectRefusal(fieldText(parsed.positive), { minChars: 12, minTags: 3 })
    if (inner.refused) {
      return { ok: false, refusal: { ...inner, reason: 'positive-' + inner.reason }, ms, model, raw: r.text }
    }
    return {
      ok: true,
      positive: finalizeText(fieldText(parsed.positive), f, rules, asString(parsed.negative)),
      negative: normalizeSeparators(stripForbidden(asString(parsed.negative), rules.wording), f),
      tags: fieldText(parsed.positive),
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 4).map(asString) : [],
      characterTag: asString(parsed.characterTag),
      copyrightTag: asString(parsed.copyrightTag),
      params: parsed.params || f.params || {},
      ms, model, raw: r.text, refusal: { refused: false },
    }
  }

  if (refusal.refused) {
    return { ok: false, refusal, ms, model, raw: r.text }
  }

  // 没给 JSON 但给了可用的标签/描述 → 当作标签来源，交给后续整理
  const { tags, sentences } = extractTagsFromVlm(r.text)
  if (tags || sentences) {
    return {
      ok: true, positive: '', negative: '', tags, sentences,
      notes: ['VLM 未按 JSON 输出，已提取标签'],
      ms, model, raw: r.text, refusal: { refused: false }, needsOrganize: true,
    }
  }

  return { ok: false, refusal: { refused: true, reason: 'unparseable', matched: r.text.slice(0, 80) }, ms, model, raw: r.text }
}

async function doReverseOnce(payload) {
  const f = familyOf(payload.family)
  if (!f) throw new Error(`未知族：${payload.family}`)

  const vcfg = config.vlm || {}
  const notes = []
  let vlmResult = null
  let vlmTried = false

  // ── 阶段 1：VLM 优先 ──
  // payload.engine: 'auto'(默认，先 VLM 后 WD14) | 'vlm' | 'wd14'
  const engine = asString(payload.engine) || 'auto'
  if (engine === 'vlm' && vcfg.enabled === false) throw inputError('VLM 已停用')
  const wantVlm = vcfg.enabled !== false && engine !== 'wd14'

  if (wantVlm) {
    vlmTried = true
    try {
      vlmResult = await reverseByVlm(payload, f)
      if (vlmResult.ok) {
        if (vlmResult.notes && vlmResult.notes.length) notes.push(...vlmResult.notes)

        let final = vlmResult.positive
        // VLM 只给了标签/句子 → 走 LLM 整理成目标族
        if (!final && (vlmResult.tags || vlmResult.sentences)) {
          const org = await organizeWithLlm({
            family: f, tags: vlmResult.tags, sentences: vlmResult.sentences,
            note: payload.note, hardNote: payload.hardNote, model: payload.model,
          })
          final = org.positive
          notes.push(...org.notes)
        }
        if (!final) throw new Error('VLM 输出为空')
        notes.unshift(`VLM 反推成功（${vlmResult.model}，${vlmResult.ms}ms）`)

        return {
          ok: true,
          engine: 'vlm',
          positive: final,
          negative: vlmResult.negative || asString(f.negative),
          params: vlmResult.params || f.params || {},
          tags: vlmResult.tags || '',
          vlmMs: vlmResult.ms,
          vlmModel: vlmResult.model,
          llmUsed: true,
          notes,
          length: checkLengthAndRepeat(final, f, notes),
          family: payload.family,
          familyLabel: asString(f.label),
        }
      }
      // VLM 明确拒答 → 记下来，继续走 WD14
      const why = vlmResult.refusal || {}
      notes.push(`VLM 未能反推（${why.reason || 'unknown'}`
        + (why.matched ? `：${String(why.matched).slice(0, 50)}` : '') + '）')
    } catch (e) {
      notes.push(`VLM 调用失败（${String(e.message || e).slice(0, 90)}）`)
    }
  }

  if (vlmTried && (engine === 'vlm' || vcfg.fallbackToWd14 === false)) {
    throw Object.assign(new Error('VLM 反推失败（当前配置不允许降级）：'
      + notes.join('；')), { status: 502 })
  }

  // ── 阶段 2：WD14 兜底 ──
  if (vlmTried) notes.push('已降级 WD14')
  const wd = await callWd14({
    ...(payload.path ? { path: payload.path } : {}),
    ...(payload.imageB64 ? { imageB64: payload.imageB64 } : {}),
    ...(payload.url ? { url: payload.url } : {}),
  })
  const base = wd14ToPrompt(wd, f, rules)
  notes.push(`WD14 出 ${wd.count} 个标签，安全档 ${wd.rating}，耗时 ${wd.ms}ms`)

  let final = base.positive
  let llmUsed = false

  if (base.needsLLM && payload.organize !== false) {
    const org = await organizeWithLlm({
      family: f, tags: base.tags, note: payload.note,
      hardNote: payload.hardNote, model: payload.model,
    })
    if (org.positive) { final = org.positive; llmUsed = true }
    notes.push(...org.notes)
  }

  return {
    ok: true,
    engine: 'wd14',
    positive: final,
    negative: asString(f.negative),
    params: f.params || {},
    tags: base.tags,
    rating: base.rating,
    scored: wd.scored,
    wd14Ms: wd.ms,
    wd14Count: wd.count,
    llmUsed,
    vlmTried,
    notes,
    length: checkLengthAndRepeat(final, f, notes),
    family: payload.family,
    familyLabel: asString(f.label),
  }
}

/** 用 LLM 把标签/描述整理成目标族提示词。 */
async function organizeWithLlm({ family, tags, sentences, note, hardNote, model }) {
  const notes = []
  try {
    const r = await llm.chat({
      system: buildSystem(family, 'reverse', rules, asString(hardNote).trim()),
      user: buildUser({ refTags: tags || '', refDesc: sentences || '', note, familyKind: family.kind }, 'reverse'),
      model,
      temperature: config.llm.temperature?.reverse ?? 0.4,
      maxTokens: config.llm.maxTokens,
    })
    const parsed = extractJson(r.text)
    if (parsed && asString(parsed.positive)) {
      if (Array.isArray(parsed.notes)) notes.push(...parsed.notes.slice(0, 3).map(asString))
      return {
        positive: finalizeText(fieldText(parsed.positive), family, rules, asString(parsed.negative)),
        notes,
      }
    }
    const salv = salvageField(r.text, 'positive')
    if (salv) return { positive: finalizeText(salv, family, rules), notes }
    notes.push('LLM 整理未返回可用内容')
  } catch (e) {
    notes.push(`LLM 整理失败（${String(e.message || e).slice(0, 80)}）`)
  }
  return { positive: '', notes }
}

// Validate the completed output, including salvage and reverse paths.
function finishResult(result, family, retried = false, payload = {}, repairAttempts = retried ? 1 : 0) {
  result.notes = Array.isArray(result.notes) ? result.notes : []
  try { compileResultLayout(result, family) } catch (e) { throw Object.assign(e, { status: 502 }) }
  result.validation = { ...validateOutput(result.positive, family, result.params), retried }
  result.quality = { ...reviewPrompt(result, family, payload), retried, repairAttempts }
  if (result.validation.unusable) throw Object.assign(new Error('模型未返回可用提示词'), { status: 502 })
  const budget = result.quality.budget
  if (budget?.enforced && result.length) {
    result.length = { ...result.length, targetMax: budget.maxTokens, hardMax: budget.maxTokens, enforced: true,
      headroomWords: Math.max(0, Math.floor((budget.maxTokens - result.length.value) / 1.45)),
      budget: { unit: 'token', targetMax: budget.maxTokens, hardMax: budget.maxTokens, enforced: true } }
  }
  if (!result.validation.valid) result.notes.unshift('⚠ 输出格式仍需调整：' + result.validation.issues.join('；'))
  if (!result.quality.valid) result.notes.unshift('⚠ 提示词仍需检查：' + result.quality.issues.join('；'))
  if (ruleStore.warning) result.notes.unshift('⚠ ' + ruleStore.warning)
  return result
}

async function doCompose(payload, { signal } = {}) {
  validateTask(payload)
  const family = familyOf(payload.family)
  let result = await doComposeOnce(payload, signal)
  const first = result
  let repairAttempts = 0
  let stalled = 0
  while (true) {
    signal?.throwIfAborted()
    const validation = validateOutput(result.positive, family, result.params)
    const quality = reviewPrompt(result, family, payload)
    if (validation.valid && quality.valid) break
    // Ordinary format/quality gets one correction; iteration keeps repacking until it fits.
    const overBudget = quality.budget?.enforced && quality.budget.exceeded
    const mayRetry = repairAttempts === 0 || overBudget
    if (!mayRetry) break
    repairAttempts++
    const targetRatio = Math.max(0.35, 0.9 - (repairAttempts - 1) * 0.1 - stalled * 0.05)
    try {
      const repair = repairInstruction(family, [...validation.issues, ...quality.issues])
        + '\n【待修正候选】' + JSON.stringify({ positive: result.positive, negative: result.negative })
        + (quality.budget?.enforced ? `\n【完整重组验收】第 ${repairAttempts} 次重组，当前约 ${quality.approximateTokens} token。保留上一版全部画面事实、本轮反馈、触发词和引用文字；标签与正文共计 ≤ ${quality.budget.maxTokens} 个应用估算 token，英文优先约 ${Math.floor(quality.budget.maxTokens * targetRatio / 1.45)} 词。重新写一份自洽最终状态，移除旧错误表达与同义重复，不追加补丁，不机械截断，不改采样参数。` : '')
        + (quality.budget?.enforced ? '\n反馈重点保护的细节沿用原文具体称谓，不能将其泛化；核对数量、形状、接触和相对位置，先省通用修饰，不改物件或文字落位、不补新视线。' : '')
        + (overBudget && repairAttempts > 1 ? '\n【切换重组策略】前轮仍超预算，不能只沿用长句骨架换几个词。先在内部整合主体、动作接触、服装、构图和光影的最终事实，再从头组织简洁正文；将同一物件的属性并入同一处，标签与正文不重复整套清单，省去通用修饰，用紧凑分句承载不同细节。超限只说明本轮仍需优化，继续重写到预算内。' : '')
      const corrected = await doComposeOnce({ ...payload, formatRepair: repair, hardNote: [payload.hardNote, repair].filter(Boolean).join('\n') }, signal)
      signal?.throwIfAborted()
      corrected.llmMs += result.llmMs || 0
      if (quality.budget?.enforced) corrected.params = first.params
      if (overBudget && reviewPrompt(corrected, family, payload).budget?.exceeded && corrected.length?.value >= result.length?.value) {
        // Reuse the shortest complete candidate rather than accumulating longer failed drafts.
        result.llmMs = corrected.llmMs
        stalled++
      } else {
        result = corrected
        stalled = 0
      }
    } catch (e) {
      if (signal?.aborted) throw e
      if (overBudget) throw Object.assign(new Error('提示词重组模型调用失败：' + String(e.message || e)), { status: e.status || 502 })
      result.notes.push('修正调用失败，保留已生成结果：' + String(e.message || e).slice(0, 120))
      break
    }
  }
  const finished = finishResult(result, family, repairAttempts > 0, payload, repairAttempts)
  if (finished.quality.budget?.enforced) {
    const before = Math.max(measureLength(payload.positive, family)?.value || 0, first.length?.value || 0)
    if (before > finished.quality.budget.maxTokens) finished.notes.unshift(`已按迭代预算重组正文：约 ${before} → ${finished.length.value} token，上限 ${finished.quality.budget.maxTokens}；保留原设定与本轮修改。`)
  }
  return finished
}

async function doReverse(payload) {
  validateTask(payload, true)
  const family = familyOf(payload.family)
  const result = await doReverseOnce(payload)
  const validation = validateOutput(result.positive, family, result.params)
  let retried = false
  if (!validation.valid && payload.organize !== false) {
    retried = true
    const correction = await organizeWithLlm({ family, tags: result.tags || '', sentences: result.positive || '',
      note: payload.note, hardNote: [payload.hardNote, repairInstruction(family, validation.issues)].filter(Boolean).join('\n'), model: payload.model })
    if (correction.positive) result.positive = correction.positive
    result.notes.push(...correction.notes)
    result.length = checkLengthAndRepeat(result.positive, family, result.notes)
  }
  return finishResult(result, family, retried, { ...payload, mode: 'reverse' })
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '40mb' }))   // 图片 base64 可能较大

app.use('/api', (_req, _res, next) => { rules = ruleStore.refresh(); next() })

// 统一错误处理：任何路由抛错都回 {ok:false, error}
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (e) {
    if (res.destroyed || res.writableEnded) return
    res.status(e.status || 500).json({ ok: false, error: String(e && e.message ? e.message : e),
      ...(e.code ? { code: e.code } : {}), ...(e.length ? { length: e.length } : {}) })
  }
}

// ── 设置：LLM 地址 / 密钥 / 模型 ─────────────────────────────────────────────
//
// 安全约定：
//   - GET 只回「有没有 key」和掩码，绝不回真值
//   - POST 接受 apiKey，但原样回传掩码时表示「不修改」
//   - 密钥落单独文件（权限 600），不写进 settings.json

app.get('/api/settings', wrap(async (_req, res) => {
  res.json({ ok: true, ...settings.publicView() })
}))

app.post('/api/settings', wrap(async (req, res) => {
  const body = req.body || {}
  const next = settings.save({
    baseURL: body.baseURL,
    apiKey: body.apiKey,
    defaultModel: body.defaultModel,
    models: body.models,
  })
  // 保存后顺手探测一次，让界面立刻知道配得对不对
  let probeInfo = null
  try {
    probeInfo = await llm.probe()
  } catch (e) {
    probeInfo = { ok: false, error: String(e.message || e) }
  }
  res.json({ ok: true, saved: true, settings: settings.publicView(), probe: probeInfo })
}))

// 拉取模型列表。支持临时覆盖（还没保存也能测）
app.post('/api/models', wrap(async (req, res) => {
  const body = req.body || {}
  const r = await llm.listModels({
    baseURL: asString(body.baseURL).trim() || undefined,
    apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
  })
  res.json({ ok: r.ok, base: r.base, models: r.models || [], count: (r.models || []).length, error: r.error })
}))

app.get('/api/config', wrap(async (_req, res) => {
  const s = settings.resolve()
  res.json({
    ok: true,
    families: familyList(),
    camera: config.camera,
    models: s.models || [],
    defaultModel: s.defaultModel || '',
    llmBase: s.baseURL || '',
    hasApiKey: !!s.apiKey,
    rulesPath,
    rulesWarning: ruleStore.warning,
    services: { booru: { enabled: booru.enabled }, viking: { enabled: viking.enabled } },
  })
}))

app.post('/api/camera', wrap(async (req, res) => {
  const r = cameraPrompt(req.body || {}, config.camera)
  res.json({ ok: true, ...r })
}))

app.post('/api/cameraFromPrompt', wrap(async (req, res) => {
  const r = cameraFromPrompt(asString(req.body && req.body.text), config.camera)
  res.json({ ok: true, ...r })
}))

app.post('/api/compose', wrap(async (req, res) => {
  const controller = new AbortController()
  const cancel = () => { if (!res.writableEnded) controller.abort() }
  res.once('close', cancel)
  try { res.json(await doCompose(req.body || {}, { signal: controller.signal })) }
  finally { res.off('close', cancel) }
}))

app.post('/api/reverse', wrap(async (req, res) => {
  res.json(await doReverse(req.body || {}))
}))

// ── 规则读写（预设可见 / 可改）───────────────────────────────────────────
//
// ⚠️ 规则是 mount 进容器的只读文件（compose 里 ./rules.json:/app/rules.json:ro），
// 所以「保存」不能直接写容器内路径。做法：写回挂载源目录。
// 容器内 /app/rules.json 是只读的，但宿主机上的 ./rules.json 可写——
// 这里通过 /data/rules.json（另一处可写挂载）落盘。


app.get('/api/rules', wrap(async (_req, res) => {
  // 每次都重读文件，保证与磁盘同步（rules.json 支持热改）
  const cur = ruleStore.refresh()
  res.json({
    ok: true,
    source: rulesPath,
    writable: !!RULES_WRITE_PATH,
    writeTarget: RULES_WRITE_PATH || '(只读挂载，需在宿主机改文件)',
    families: familyList(),
    presets: buildPresets(cur),
    rules: cur,
    warning: ruleStore.warning,
  })
}))

app.post('/api/rules', wrap(async (req, res) => {
  const saved = ruleStore.save(req.body?.rules)
  const next = saved.rules
  rules = next
  res.json({
    ok: true,
    saved: RULES_WRITE_PATH,
    backup: saved.backup,
    families: familyList(),
    presets: buildPresets(next),
    note: '已写回；下次请求即用新规则',
  })
}))

/** 把各族风格档整理成「预设」视图。 */
function buildPresets(r) {
  const out = []
  for (const [id, f] of Object.entries((r && r.families) || {})) {
    if (!f || typeof f !== 'object') continue
    const styles = f.styles || {}
    out.push({
      id,
      label: asString(f.label) || id,
      kind: asString(f.kind),
      order: asString(f.order),
      negative: asString(f.negative),
      params: f.params || {},
      modeStyle: f.modeStyle || {},
      styles: Object.entries(styles).map(([k, v]) => ({
        key: k,
        label: asString(v && v.label) || k,
        rules: Array.isArray(v && v.rules) ? v.rules : [],
      })),
    })
  }
  return out
}

app.get('/api/tags', wrap(async (req, res) => {
  const q = asString(req.query.q).trim()
  if (!q) throw new Error('需要 q 参数')
  const list = await booru.search(q, Number(req.query.limit) || 20)
  res.json({ ok: true, tags: list })
}))

// ── 标签详情（wiki / 相关 / 示例图）──────────────────────────────────────

app.post('/api/tag', wrap(async (req, res) => {
  const body = req.body || {}
  const op = asString(body.op) || 'wiki'
  const name = asString(body.name || body.q).trim()
  if (!name) throw new Error('需要标签名')

  if (op === 'wiki') {
    res.json({ ok: true, ...(await booru.wiki(name)) })
  } else if (op === 'related') {
    res.json({ ok: true, tags: await booru.related(name, Number(body.limit) || 16) })
  } else if (op === 'posts') {
    const list = await booru.posts(name, Number(body.limit) || 8, asString(body.ratings))
    res.json({ ok: true, posts: list })
  } else if (op === 'verify') {
    res.json({ ok: true, tags: await booru.verify([name]) })
  } else {
    throw new Error(`未知操作：${op}`)
  }
}))

// 缩略图代理：浏览器直连 danbooru CDN 会被 DNS 污染，服务端转一手
app.get('/api/thumb', wrap(async (req, res) => {
  const url = asString(req.query.u)
  if (!url) throw new Error('需要 u 参数')
  const r = await fetch(url, {
    headers: { 'User-Agent': 'prompt-lab-nas/1.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`CDN ${r.status}`)
  const type = r.headers.get('content-type') || 'image/jpeg'
  if (!/^image\//.test(type)) throw new Error('不是图片')
  const buf = Buffer.from(await r.arrayBuffer())
  res.set('Content-Type', type)
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(buf)
}))

// ── 角色库检索 ─────────────────────────────────────────────────────────────

app.post('/api/character', wrap(async (req, res) => {
  res.json(await searchCharacter(deps, req.body || {}))
}))

// ── Viking 语义检索 ────────────────────────────────────────────────────────

app.post('/api/viking', wrap(async (req, res) => {
  const r = await viking.find(req.body || {})
  res.json({ ok: r.ok, ...r })
}))

// ── 探测：LLM / WD14 / Viking / Danbooru ───────────────────────────────────

app.post('/api/probe', wrap(async (_req, res) => {
  const [l, w, v, b] = await Promise.all([llm.probe(), probeWd14(), viking.probe(), booru.probe()])
  res.json({ ok: l.ok && w.ok && b.ok && v.every((item) => item.ok), llm: l, wd14: w, viking: v, booru: b })
}))

// 静态界面
app.use('/', express.static(join(HERE, 'public')))
app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ ok: false, error: error.message || '请求失败' })
})

// 端口：环境变量 PORT 优先（容器编排常用），否则用 config.json
const port = Number(process.env.PORT) || Number(config.server?.port) || 33002
const host = process.env.HOST || config.server?.host || '0.0.0.0'

app.listen(port, host, () => {
  console.log(`[web] 监听 http://${host}:${port}`)
  console.log(`[web] LLM 网关 ${llm.base}（模型 ${llm.defaultModel}，key ${llm.hasKey ? '已配置' : '**缺失**'}）`)
  console.log(`[web] WD14 ${wd14Base}`)
  console.log(`[web] 规则 ${rulesPath}`)
  console.log(`[web] 族：${familyList().map((f) => f.id).join(', ')}`)
})
