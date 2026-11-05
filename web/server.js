/**
 * prompt-lab NAS 版 Web 服务。
 *
 * 与本机 DSH 插件的区别：
 *   - 本机版是 Cordis 插件，依赖 ctx.llm / ctx.webServer / ctx.attachments
 *   - 这里是独立 HTTP 服务，自带路由与 LLM 客户端
 *   - NSFW 反推只走 WD14（102 无 GPU，VLM 跑不了）
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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLLM } from './llm.js'
import { createViking, createBooru } from './services.js'
import { searchCharacter, verifyAnchors, applyAnchorFix } from './character.js'
import { detectRefusal, extractTagsFromVlm } from './vlm.js'
import { normalizeLayoutOutput } from './moss-layout.js'
import {
  asString, buildSystem, buildUser, extractJson, salvageField, fieldText,
  cameraPrompt, cameraFromPrompt, finalizeText, measureLength,
  normalizeSeparators, stripForbidden, wd14ToPrompt, styleFor,
} from './engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 配置 ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const p = join(HERE, 'config.json')
  if (!existsSync(p)) throw new Error(`配置缺失：${p}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function loadRules() {
  // 族规则单独放，便于与 DSH 版共享（可挂载同一份）
  const cand = [join(HERE, 'rules.json'), join(HERE, 'config.json')]
  for (const p of cand) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && j.families) return { rules: j, source: p }
    } catch { /* 继续 */ }
  }
  throw new Error('找不到含 families 段的规则文件（rules.json 或 config.json）')
}

const config = loadConfig()
const { rules, source: rulesPath } = loadRules()
const llm = createLLM(config.llm)
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
    return { ok: true, base: wd14Base, ...j }
  } catch (e) {
    return { ok: false, base: wd14Base, error: String(e.message || e) }
  }
}

// ── 族工具 ──────────────────────────────────────────────────────────────────

function familyOf(id) {
  const fams = rules.families || {}
  return fams[id] || fams.generic || null
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

// ── 核心：生成/润色/迭代/整理 ───────────────────────────────────────────────

async function doCompose(payload) {
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
        notes: ['模型输出的 JSON 格式不规范（多为字符串内直接换行），已自动修复字段'],
        length: measureLength(positive, f, rules),
        ...meta,
      }
    }
    const positive = finalizeText(r.text.trim(), f, rules)
    return {
      ok: true, positive, negative: '', params: f.params || {},
      notes: ['模型未返回标准 JSON，已按纯文本输出'],
      length: measureLength(positive, f, rules), ...meta,
    }
  }

  const p = (parsed.params && typeof parsed.params === 'object') ? parsed.params : {}
  const fp = f.params || {}
  const negRaw = asString(parsed.negative)
  let positive = finalizeText(fieldText(parsed.positive), f, rules, negRaw)
  const notes = Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5).map(asString) : []

  // MOSS-Image Layout：模型只写 abs/xyxy 草稿，坐标换算由代码做
  //（官方明确要求模型不做算术）；模型若自己算了中心化坐标，校验后放行。
  const pRaw = (parsed.params && typeof parsed.params === 'object') ? parsed.params : {}
  let layoutInfo = null
  try {
    let lay = normalizeLayoutOutput(positive)
    // 草稿缺 width/height 时，从模型给的 params.size 回填（"832x1536" / "832×1536"）
    if (lay && lay.kind === 'draft-incomplete') {
      const m = fieldText(pRaw.size).trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
      if (m) {
        const draft = JSON.parse(positive.trim())
        if (!('width' in draft)) draft.width = Number(m[1])
        if (!('height' in draft)) draft.height = Number(m[2])
        positive = JSON.stringify(draft)
        lay = normalizeLayoutOutput(positive)
      }
    }
    if (lay && lay.kind === 'compiled') {
      layoutInfo = { width: lay.width, height: lay.height }
      positive = lay.positive
      notes.push(`已按官方规范编译 Layout 坐标：abs/xyxy → abs_centralized/yxyx；`
        + `生成尺寸须为 ${lay.width}×${lay.height}（16 的倍数，且与 bbox 同一画布）`)
    } else if (lay && lay.kind === 'model') {
      positive = lay.positive
      notes.push('模型已输出中心化坐标（yxyx），仅做校验未再换算；width×height 以 params.size 为准')
    }
  } catch (e) {
    notes.push(`⚠ Layout 校验/编译失败：${String(e.message || e).slice(0, 140)}（已原样返回）`)
  }

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

  // 长度：只统计不设限（用户要求去掉提示词数量限制），不再产生任何告警
  const len = measureLength(positive, f, rules)

  return {
    ok: true,
    positive,
    negative: negFinal,
    params: {
      steps: asString(p.steps) || asString(fp.steps),
      cfg: asString(p.cfg) || asString(fp.cfg),
      sampler: asString(p.sampler) || asString(fp.sampler),
      size: (layoutInfo ? `${layoutInfo.width}x${layoutInfo.height}` : '')
        || asString(p.size) || asString(fp.size),
    },
    layout: layoutInfo,
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
    if (!/^\/(images|data)\//.test(p)) throw new Error(`路径必须在 /images/ 下：${p}`)
    if (p.includes('..')) throw new Error('路径非法')
    const buf = readFileSync(p)
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
  if (s.startsWith('UklGRklG')) return 'image/gif'
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
  const model = asString(payload.vlmModel) || asString(vcfg.model) || payload.model

  // 提示词：要求它「只输出提示词」，不要解释；并明确这是本地出图用的技术输入
  const sys = buildSystem(f, 'reverse', rules, asString(payload.hardNote).trim())
  const ask = [
    '请直接观察这张图片，输出符合上述目标模型族规范的提示词。',
    '要求：',
    '1. 只输出 JSON（格式见上），不要任何解释、不要 markdown 代码块。',
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

async function doReverse(payload) {
  const f = familyOf(payload.family)
  if (!f) throw new Error(`未知族：${payload.family}`)

  const vcfg = config.vlm || {}
  const notes = []
  let vlmResult = null
  let vlmTried = false

  // ── 阶段 1：VLM 优先 ──
  // payload.engine: 'auto'(默认，先 VLM 后 WD14) | 'vlm' | 'wd14'
  const engine = asString(payload.engine) || 'auto'
  const wantVlm = vcfg.enabled !== false && engine !== 'wd14'

  if (wantVlm) {
    vlmTried = true
    try {
      vlmResult = await reverseByVlm(payload, f)
      if (vlmResult.ok) {
        notes.unshift(`VLM 反推成功（${vlmResult.model}，${vlmResult.ms}ms）`)
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

        return {
          ok: true,
          engine: 'vlm',
          positive: final,
          negative: vlmResult.negative || asString(f.negative),
          params: f.params || {},
          tags: vlmResult.tags || '',
          vlmMs: vlmResult.ms,
          vlmModel: vlmResult.model,
          llmUsed: true,
          notes,
          length: measureLength(final, f, rules),
          family: payload.family,
          familyLabel: asString(f.label),
        }
      }
      // VLM 明确拒答 → 记下来，继续走 WD14
      const why = vlmResult.refusal || {}
      notes.push(`VLM 未能反推（${why.reason || 'unknown'}`
        + (why.matched ? `：${String(why.matched).slice(0, 50)}` : '') + '），已降级 WD14')
    } catch (e) {
      notes.push(`VLM 调用失败（${String(e.message || e).slice(0, 90)}），已降级 WD14`)
    }
  }

  if (engine === 'vlm' && (!vlmResult || !vlmResult.ok)) {
    throw new Error('VLM 反推失败且已指定 engine=vlm（不降级）：'
      + notes.join('；'))
  }

  // ── 阶段 2：WD14 兜底 ──
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
    length: measureLength(final, f, rules),
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
      user: buildUser({ refTags: tags || '', refDesc: sentences || '', note }, 'reverse'),
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

// ── HTTP ────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '40mb' }))   // 图片 base64 可能较大

// 统一错误处理：任何路由抛错都回 {ok:false, error}
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) })
  }
}

app.get('/api/config', wrap(async (_req, res) => {
  res.json({
    ok: true,
    families: familyList(),
    camera: config.camera,
    models: config.llm.models || [],
    defaultModel: config.llm.defaultModel,
    rulesPath,
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
  res.json(await doCompose(req.body || {}))
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

const RULES_WRITE_PATH = process.env.RULES_WRITE_PATH || ''

app.get('/api/rules', wrap(async (_req, res) => {
  // 每次都重读文件，保证与磁盘同步（rules.json 支持热改）
  const cur = JSON.parse(readFileSync(rulesPath, 'utf8'))
  res.json({
    ok: true,
    source: rulesPath,
    writable: !!RULES_WRITE_PATH,
    writeTarget: RULES_WRITE_PATH || '(只读挂载，需在宿主机改文件)',
    families: familyList(),
    presets: buildPresets(cur),
    rules: cur,
  })
}))

app.post('/api/rules', wrap(async (req, res) => {
  const next = req.body && req.body.rules
  if (!next || typeof next !== 'object' || !next.families) {
    throw new Error('提交的规则缺少 families 段')
  }
  if (!RULES_WRITE_PATH) {
    throw new Error('规则文件是只读挂载，无法在容器内保存。请在宿主机编辑 '
      + rulesPath + ' 后重启容器。')
  }
  // 先校验能解析，避免写坏
  const text = JSON.stringify(next, null, 2)
  JSON.parse(text)
  writeFileSync(RULES_WRITE_PATH, text, 'utf8')
  // 同步到运行时使用的对象
  Object.keys(rules).forEach((k) => { delete rules[k] })
  Object.assign(rules, next)
  res.json({
    ok: true,
    saved: RULES_WRITE_PATH,
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
  const [l, w, v] = await Promise.all([
    llm.probe(),
    probeWd14(),
    viking.probe(),
  ])
  let b
  try {
    const t = await booru.search('1girl', 1)
    b = { ok: true, base: booru.base, sample: t.length }
  } catch (e) {
    b = { ok: false, base: booru.base, error: String(e.message || e).slice(0, 150) }
  }
  res.json({ ok: true, llm: l, wd14: w, viking: v, booru: b })
}))

// 静态界面
app.use('/', express.static(join(HERE, 'public')))

const port = Number(config.server?.port) || 33002
const host = config.server?.host || '0.0.0.0'

app.listen(port, host, () => {
  console.log(`[web] 监听 http://${host}:${port}`)
  console.log(`[web] LLM 网关 ${llm.base}（模型 ${llm.defaultModel}，key ${llm.hasKey ? '已配置' : '**缺失**'}）`)
  console.log(`[web] WD14 ${wd14Base}`)
  console.log(`[web] 规则 ${rulesPath}`)
  console.log(`[web] 族：${familyList().map((f) => f.id).join(', ')}`)
})
