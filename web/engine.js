
/**
 * 提示词引擎 —— 从本机 DSH 插件（lib/index.js）抽出的纯逻辑。
 *
 * 抽取原则：**只搬不依赖 DSH 宿主的部分**。
 * 原版依赖 ctx.llm / ctx.webServer / ctx.attachments，这里全部剥离：
 *   - 调模型      -> llm.js（OpenAI 兼容客户端）
 *   - 路由        -> server.js
 *   - 附件存储    -> 内存/临时文件
 *
 * 这些函数与插件版逐行对应（族规则拼装、格式规范化、长度预算、相机角度），
 * 所以两边产出的提示词风格一致。
 */

// ── 基础工具 ────────────────────────────────────────────────────────────────

export const asString = (v) => (v === undefined || v === null ? '' : String(v))

/** 字段值转文本：对象/数组序列化成紧凑 JSON，而不是 "[object Object]"。
 *  MOSS-Image 的 Layout 输出就是嵌套对象，必须保住结构。 */
export function fieldText(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

// 安全标签（safe / sensitive / nsfw / explicit）已按要求停用：
// 正向提示词不再自动追加，也不在系统提示里要求模型输出。

/**
 * 从模型输出里抽出 JSON（宽容解析）。
 *
 * 模型经常在 JSON 字符串值内部直接换行（而不是 \n 转义），会让 JSON.parse 失败。
 * 一旦失败就会把整坨 JSON 当提示词交给用户 —— 完全不可用。
 * 这里按代价从低到高依次尝试。
 */
export function extractJson(text) {
  if (!text) return null
  let s = String(text).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) s = s.slice(i, j + 1)

  const attempts = [
    s,
    s.replace(/,(\s*[}\]])/g, '$1'),
    escapeBareControlCharsInStrings(s),
    /'\s*:/.test(s) ? s.replace(/'/g, '"') : null,
  ]
  for (const a of attempts) {
    if (!a) continue
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object') return v
    } catch { /* 试下一种 */ }
  }
  try {
    const v = JSON.parse(escapeBareControlCharsInStrings(s.replace(/,(\s*[}\]])/g, '$1')))
    if (v && typeof v === 'object') return v
  } catch { /* 放弃 */ }
  return null
}

/** 把 JSON 字符串值内部的裸控制字符转义。 */
export function escapeBareControlCharsInStrings(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (esc) { out += ch; esc = false; continue }
    if (ch === '\\') { out += ch; esc = true; continue }
    if (ch === '"') { inStr = !inStr; out += ch; continue }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
    }
    out += ch
  }
  return out
}

/**
 * 兜底：JSON 彻底解析失败时，从文本里「剥壳抽字段」。
 * 典型输入是「带真实换行的畸形 JSON」。
 */
export function salvageField(text, field) {
  const s = String(text || '')
  if (!s) return ''
  const re = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"|\\}\\s*(?:,|$))`, 'i')
  const m = s.match(re)
  if (m) {
    return m[1]
      .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, ' ')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      .trim()
  }
  const re2 = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)["]`, 'i')
  const m2 = s.match(re2)
  return m2 ? m2[1].replace(/\\n/g, '\n').trim() : ''
}

// ── 格式规范化 ──────────────────────────────────────────────────────────────

/** 把下划线写法转成空格写法（按族决定是否转换）。 */
export function normalizeSeparators(text, family) {
  let s = asString(text)
  if (!s) return ''
  const kind = asString(family && family.kind)
  // separator: 'keep' —— 下划线本身承载语义（如 MOSS 的 video_game_capture /
  // health_bar 这类官方 meta 词），不能转成空格
  if (family && family.separator === 'keep') return s
  const wantsSpaces = kind === 'tag+NL' || kind === 'NL' || kind === 'NL+layout'
    || (family && family.separator === 'space')
  if (!wantsSpaces) return s

  const guards = []
  s = s.replace(/<[^>\n]*>/g, (m) => {
    guards.push(m)
    return `\u0000G${guards.length - 1}\u0000`
  })

  s = s.replace(/[^\s,，\n()\[\]{}]+/g, (token) => {
    if (/^score_\d+$/.test(token)) return token
    const weighted = token.match(/^([A-Za-z0-9_\-/]+):(\d+(?:\.\d+)?)$/)
    if (weighted) {
      if (/^score_\d+$/.test(weighted[1])) return token
      return `${weighted[1].replace(/_/g, ' ')}:${weighted[2]}`
    }
    if (!/^[A-Za-z0-9_\-/]+$/.test(token)) return token
    return token.replace(/_/g, ' ')
  })

  s = s.replace(/\u0000G(\d+)\u0000/g, (_m, i) => guards[Number(i)] || '')
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s
}

/** 确定性清除画师标签与流水线语法（模型不保证遵守提示词）。 */
export function stripForbidden(text, wording) {
  let s = asString(text)
  if (!s) return ''
  // artist:xxx / @xxx / @[a|b] —— 只删「前缀式」写法
  s = s.replace(/(^|[,\s])artist:\s*[^,]+/gi, '$1')
  s = s.replace(/(^|[,\s])@\[[^\]]*\]/g, '$1')
  s = s.replace(/(^|[,\s])@[A-Za-z0-9_\-]+/g, '$1')
  // BREAK / // 注释
  s = s.replace(/\bBREAK\b/g, '')
  s = s.replace(/\s*\/\/[^\n]*/g, '')
  // 禁用直白解剖词 -> 体系标准词
  const w = wording || {}
  const rep = w.replacements || {}
  for (const [from, to] of Object.entries(rep)) {
    if (!from || !to) continue
    const re = new RegExp(`(^|[,\\s])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([,\\s]|$)`, 'gi')
    s = s.replace(re, `$1${to}$2`)
  }
  return s.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim()
}

/**
 * 确定性清除正向里的质量词与安全标签。
 *
 * 为什么必须用代码做：模型被反复要求「不要质量词」仍会漏回来（实测润色时
 * 稳定复现 masterpiece, best quality）。提示词工程只能降低概率，不能保证；
 * 这里是硬性兜底——删掉一两个评价词无害，留着则偏离工作台约定。
 *
 * 注意只清「独立标签」形态，不碰 as 短语中心的正文（如 "high quality fabric"）。
 */
const QUALITY_WORDS = [
  'masterpiece', 'best quality', 'good quality', 'high quality', 'top quality',
  'very aesthetic', 'amazing quality', 'absurdres', 'highres', 'ultra detailed',
  'extremely detailed', 'super fine illustration', 'highly detailed',
  'best quality:', 'very awa', 'worst aesthetic',
]

const SAFETY_WORDS = ['safe', 'sensitive', 'nsfw', 'explicit']

export function stripQualityAndSafety(text) {
  let s = asString(text)
  if (!s) return s
  // 整个提示词是 JSON（MOSS Layout）时不动内容，避免破坏结构
  const t = s.trim()
  if (t.startsWith('{') && t.endsWith('}')) {
    try { JSON.parse(t); return s } catch { /* 继续 */ }
  }

  const parts = s.split(',')
  const kept = parts.filter((p) => {
    const low = p.trim().toLowerCase().replace(/^\d+\s*$/, '')
    if (!low) return true
    // 去掉带权重的写法：(masterpiece:1.2)
    const bare = low.replace(/^\(+/, '').replace(/\)+$/, '').replace(/:\s*[\d.]+$/, '').trim()
    if (QUALITY_WORDS.includes(bare)) return false
    if (SAFETY_WORDS.includes(bare)) return false
    // score_9 / score_8_up / score_7_up 这类 Pony 系质量分
    if (/^score_\d+(?:_\w+)?$/.test(bare)) return false
    return true
  })
  return kept.join(',').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim()
}

/** 泛称清理：具体化标签在场时删掉同维度泛称。 */
const GENERIC_WITH_CONCRETE = [
  { generic: 'school uniform', concrete: ['dress shirt', 'pleated skirt', 'sailor collar', 'blazer', 'ribbon'] },
  { generic: 'casual clothes', concrete: ['hoodie', 't-shirt', 'jeans', 'denim', 'sneakers', 'sweater'] },
  { generic: 'elegant outfit', concrete: ['evening gown', 'lace', 'pearl', 'silk dress'] },
  { generic: 'armor', concrete: ['plate armor', 'pauldron', 'breastplate', 'chainmail', 'gauntlet'] },
  { generic: 'beautiful hair', concrete: ['long hair', 'straight hair', 'bangs', 'ponytail', 'braid'] },
  { generic: 'pretty face', concrete: ['eyelashes', 'pupils', 'eyebrows', 'detailed eyes'] },
  { generic: 'kimono', concrete: ['yukata', 'obi', 'furisode'] },
  { generic: 'swimsuit', concrete: ['one-piece swimsuit', 'bikini', 'school swimsuit'] },
]

export function dropRedundantGeneric(text) {
  let s = asString(text)
  if (!s) return s
  const low = s.toLowerCase()
  for (const { generic, concrete } of GENERIC_WITH_CONCRETE) {
    if (!low.includes(generic)) continue
    if (!concrete.some((c) => low.includes(c))) continue
    const parts = s.split(',')
    const kept = parts.filter((p) => p.trim().toLowerCase() !== generic)
    if (kept.length !== parts.length) s = kept.join(',')
  }
  return s
}

/**
 * 安全标签兜底 —— 已停用。
 *
 * 用户要求输出不带安全标签（safe / sensitive / nsfw / explicit），
 * 所以这里保留函数签名只为兼容旧调用点，一律原样返回。
 */
export function ensureSafetyTag(text) {
  return text
}

/** 后处理三步：规范化 + 清违规 + 删泛称。 */
export function finalizeText(text, family, rules, negative) {
  // Layout JSON 一类的结构化输出不能过词法清洗：
  // separator 会把 abs_centralized 改成 "abs centralized"，
  // 删泛称会把 JSON 里的 caption 片段误当标签删掉。
  const trimmed = asString(text).trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      JSON.parse(trimmed)
      return stripForbidden(trimmed, rules && rules.wording)
    } catch { /* 不是合法 JSON，走常规清洗 */ }
  }
  let s = normalizeSeparators(stripForbidden(text, rules && rules.wording), family)
  s = dropRedundantGeneric(s)
  return stripQualityAndSafety(s)
}

// ── 长度预算 ────────────────────────────────────────────────────────────────

/**
 * 长度预算已停用（用户要求去掉数量限制）。
 * 保留这个导出只为兼容旧调用点，恒返回 null。
 */
export function pickBudget() {
  return null
}

/**
 * 长度与重复体检。
 *
 * 阈值来自 2026-11 本机 A/B 实测（同一 seed，只改变提示词长度）：
 *   100 / 240 / 380 / 510 / 750 / 920 token 六档
 *   - 920 token：结构仍完整，但景别漂移、低权重细节丢失
 *   - 510 token：半身→中景，发带等细节消失
 *   - 750 token：人物朝向开始偏离 looking at viewer
 *   - 300 词（≈440 token）内：主体与细节都稳
 *
 * 另一件更关键的事：**重复比长度更致命**。
 * 实测重复同一句 25 次（仅 345 token），人物没崩，但 green jacket 被染成荧光亮绿——
 * 重复会放大该概念的权重。所以这里同时统计「同义重复度」。
 *
 * 只告警、不裁剪：裁掉内容会破坏画面语义，宁可提示让人自己决定。
 */
const LEN_LIMITS = {
  // 单位：token（约 1.45 token/词）
  'tag+NL': { target: 300, hard: 380 },   // anima（实测 510 起丢细节，压到 300 保稳）
  'NL': { target: 440, hard: 580 },       // krea2
  'NL+layout': { target: 1200, hard: 2000 }, // moss（官方条件上限 4096）
  tag: { target: 75, hard: 77 },          // noobai / generic：SDXL 77 token 硬分块
}

export function measureLength(text, family, rules) {
  const s = asString(text)
  if (!s) return null

  // 中文没有词间空格，纯按空格分词会把一整段中文数成 1 个词。
  const cjkChars = (s.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length
  const latinWords = s.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, ' ')
    .split(/\s+/).filter(Boolean).length
  const words = latinWords + cjkChars
  const chars = s.length
  const approxTokens = Math.round(latinWords * 1.45 + cjkChars * 1.0)

  // 结构化的 Layout JSON 不做长度/重复判定（它是数据不是散文）
  const kind = asString(family && family.kind) || 'tag'
  const lim = LEN_LIMITS[kind] || LEN_LIMITS['tag+NL']

  // 只有 moss 的 Layout JSON 才算「结构化数据」跳过判定。
  // 其它族出现 { 开头的文本，几乎都是模型把整个 JSON 信封当成了正文
  //（兜底路径），那种情况正需要长度告警，不能放过。
  const isLayoutJson = kind === 'NL+layout' && s.trim().startsWith('{')

  // tag 族正负共享 77 token 窗口，正文本身要留出负面词的空间
  const target = lim.target
  const hard = lim.hard

  const value = approxTokens
  const over = !isLayoutJson && value > hard
  const warn = !isLayoutJson && value > target && value <= hard

  // ── 重复度：按句统计完全相同或高度相似的句子 ──
  const dup = isLayoutJson ? { top: 0, sample: '', ratio: 0 } : detectRepetition(s)

  return {
    family, unit: 'token', value, words, chars, approxTokens, cjkChars, latinWords,
    targetMax: target, hardMax: hard,
    over, warn,
    // 剩余可用于追加画风词的余量（词）
    headroomWords: Math.max(0, Math.round((target - value) / 1.45)),
    repetition: dup,
    budget: { unit: 'token', targetMax: target, hardMax: hard },
  }
}

/** 找出重复度最高的一句，用来提示「你在反复说同一件事」。 */
export function detectRepetition(text) {
  const s = asString(text)
  if (!s) return { top: 0, sample: '', ratio: 0 }

  // 按句子切分（含中文句号）；换行也算分隔
  const raw = s.split(/(?<=[.!?。！？])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 8)
  if (raw.length < 2) return { top: 1, sample: raw[0] || '', ratio: 0 }

  // 归一化后比较：小写、去标点、压空白
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const counts = new Map()
  for (const x of raw) {
    const k = norm(x)
    if (!k) continue
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  let top = 0
  let sample = ''
  for (const [k, n] of counts) {
    if (n > top) { top = n; sample = k }
  }

  // 近似重复：把句子按词袋比对（重叠 >80% 视为同义反复）
  const keys = [...counts.keys()]
  let near = 0
  if (keys.length >= 2) {
    const bags = keys.map((k) => new Set(k.split(' ')))
    for (let i = 0; i < bags.length; i++) {
      for (let j = i + 1; j < bags.length; j++) {
        const a = bags[i]; const b = bags[j]
        const inter = [...a].filter((w) => b.has(w)).length
        // 用「较小集合」作分母：Jaccard 对短句过于严苛，
        // 「换一个词的同义复述」才是要抓的目标。
        const base = Math.min(a.size, b.size)
        if (base >= 4 && inter / base >= 0.8) near++
      }
    }
  }

  return {
    top,                       // 同一句出现的最多次数
    sample: sample.slice(0, 80),
    ratio: raw.length ? Math.round(((top - 1 + near) / raw.length) * 100) : 0,
    sentences: raw.length,
    nearPairs: near,
  }
}

// ── 相机角度（吸收自 ComfyUI_VNCCS_Utils）─────────────────────────────────

/**
 * 相机角度 → 提示词片段。
 * 映射词沿用 VNCCS 的 azimuth_map / elevation_map（Multiple-Angles LoRA 的
 * 标准语言，改词就失效）。取档用最近邻，平手取先出现者（与 Python min 一致）。
 */
export function cameraPrompt(cam, cfgIn) {
  const cfg = cfgIn || {}
  const state = cam || {}
  const style = asString(state.style || cfg.style) === 'generic' ? 'generic' : 'standard'

  const azKeys = Object.keys(cfg.方位 || {}).filter((k) => k !== '_comment').map(Number)
  let az = Number(state.azimuth)
  if (!Number.isFinite(az)) az = 0
  az = ((az % 360) + 360) % 360
  let azPick = 0
  if (azKeys.length) {
    const norm = az > 337.5 ? 0 : az
    azPick = azKeys.reduce((best, k) => (Math.abs(k - norm) < Math.abs(best - norm) ? k : best), azKeys[0])
  }

  const elKeys = Object.keys(cfg.仰俯 || {}).filter((k) => k !== '_comment').map(Number)
  let el = Number(state.elevation)
  if (!Number.isFinite(el)) el = 0
  let elPick = 0
  if (elKeys.length) {
    elPick = elKeys.reduce((best, k) => (Math.abs(k - el) < Math.abs(best - el) ? k : best), elKeys[0])
  }

  const distKeys = Object.keys(cfg.景别 || {}).filter((k) => k !== '_comment')
  const dist = distKeys.includes(asString(state.distance)) ? asString(state.distance)
    : (distKeys.includes(asString(cfg.default && cfg.default.distance))
      ? asString(cfg.default.distance) : distKeys[0])

  const azEntry = (cfg.方位 || {})[azPick] || {}
  const elEntry = (cfg.仰俯 || {})[elPick] || {}
  const distEntry = (cfg.景别 || {})[dist] || {}
  const pick = (e) => asString(style === 'generic' ? (e.generic || e.standard) : e.standard)

  const parts = []
  if (cfg.includeTrigger) parts.push(asString(cfg.trigger) || '<sks>')
  parts.push(pick(azEntry))
  parts.push(pick(elEntry))
  parts.push(pick(distEntry) || dist)

  // 补充词组：单选组只取第一个（防配置写坏时输出冲突词）
  const sup = (cfg.补充 && Array.isArray(cfg.补充.groups)) ? cfg.补充.groups : []
  const picked = []
  const selected = {}
  const sel = state.extras && typeof state.extras === 'object' ? state.extras : {}
  for (const g of sup) {
    if (!g || !g.id) continue
    const want = Array.isArray(sel[g.id]) ? sel[g.id] : []
    const hit = []
    for (const it of (Array.isArray(g.items) ? g.items : [])) {
      const tag = asString(it && it.tag)
      if (tag && want.includes(tag)) hit.push(tag)
    }
    if (hit.length) {
      const use = (g.single && !g.multi) ? hit.slice(0, 1) : hit
      selected[g.id] = use
      picked.push(...use)
    }
  }
  const extraText = picked.join(' ')
  const ordered = (cfg.补充 && cfg.补充.position === 'before')
    ? [extraText, ...parts] : [...parts, extraText]

  // 本质是仰俯的词（aerial/god's eye/ground level）与非零仰俯同时用会矛盾
  const conflicts = []
  for (const g of sup) {
    for (const it of (Array.isArray(g.items) ? g.items : [])) {
      if (!it || !it.elevationConflict) continue
      if (picked.includes(asString(it.tag)) && elPick !== 0) {
        conflicts.push(`${asString(it.tag)} 与 ${asString(elEntry.standard) || (elPick + '°')} 语义重叠`)
      }
    }
  }

  return {
    text: ordered.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    azimuth: azPick, elevation: elPick, distance: dist, style,
    extras: selected, conflicts,
    trigger: cfg.includeTrigger ? (asString(cfg.trigger) || '<sks>') : '',
    labels: {
      azimuth: asString(azEntry.label),
      elevation: asString(elEntry.label),
      distance: asString(distEntry.label),
    },
  }
}

/** 从提示词反解相机角度（界面回填用）。 */
export function cameraFromPrompt(text, cfg) {
  const raw = asString(text)
  const triggerRe = new RegExp(String(cfg.trigger || '<sks>').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const low = raw.replace(triggerRe, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  const found = { azimuth: null, elevation: null, distance: null, includeTrigger: triggerRe.test(raw) }

  for (const [k, v] of Object.entries(cfg.方位 || {})) {
    if (k === '_comment') continue
    const words = [v.standard, v.generic].filter(Boolean).map((w) => String(w).toLowerCase())
    if (words.some((w) => low.includes(w))) { found.azimuth = Number(k); break }
  }
  for (const [k, v] of Object.entries(cfg.仰俯 || {})) {
    if (k === '_comment') continue
    const words = [v.standard, v.generic].filter(Boolean).map((w) => String(w).toLowerCase())
    if (words.some((w) => low.includes(w))) { found.elevation = Number(k); break }
  }
  for (const [k] of Object.entries(cfg.景别 || {})) {
    if (k === '_comment') continue
    if (low.includes(String(k).toLowerCase())) { found.distance = k; break }
  }
  const extras = {}
  for (const g of ((cfg.补充 && cfg.补充.groups) || [])) {
    if (!g || !g.id) continue
    const hit = []
    for (const it of (Array.isArray(g.items) ? g.items : [])) {
      const tag = asString(it && it.tag).toLowerCase()
      if (tag && low.includes(tag)) hit.push(asString(it.tag))
    }
    if (hit.length) extras[g.id] = hit
  }
  if (Object.keys(extras).length) found.extras = extras
  return found
}

// ── WD14 标签 → 提示词 ─────────────────────────────────────────────────────

/**
 * 把 WD14 的标签结果整理成目标族提示词。
 *
 * 与 VLM 反推的区别：WD14 只给标签（无自然语言），所以：
 *   - tag 族（noobai/generic）：直接就是提示词主体
 *   - tag+NL 族（anima）：标签段 + 补一句自然语言说明
 *   - NL 族（krea2）：需要把标签转成句子 —— 这一步靠 LLM 做，这里只给标签
 */
export function wd14ToPrompt(wd14, family, rules) {
  const tags = asString(wd14 && wd14.tags)
  const rating = asString(wd14 && wd14.rating)
  const kind = asString(family && family.kind) || 'tag'
  const budget = pickBudget((rules && rules.lengthBudget) || null, family)

  // 不再拼质量前缀（用户要求正向输出不带质量词）；WD14 自己的 rating 也不当标签写进去
  const text = tags

  const finalText = finalizeText(text, family, rules, '')
  return {
    positive: finalText,
    tags,
    rating,
    needsLLM: kind !== 'tag',   // NL 类需要 LLM 转成句子
    budget,
  }
}

// ── 族规则拼装 ─────────────────────────────────────────────────────────────

const KIND_TEXT = {
  tag: 'Danbooru 标签流（逗号分隔的短标签）',
  'tag+NL': '标签段 + 自然语言段混排',
  NL: '完整英文自然语言描述',
  'NL+layout': '自然语言 caption / tag 串 / Layout JSON',
}

const STYLE_LABEL = {
  faithful: '忠实还原（反推）',
  epic: '震撼美化（润色 / 生成）',
}

/** 按任务模式选风格档（反推用忠实还原，生成/润色用震撼美化）。 */
export function styleFor(family, mode) {
  const styles = family && family.styles
  if (!styles) return null
  const modeStyle = (family.modeStyle || {})
  const key = asString(modeStyle[mode]) || (mode === 'reverse' ? 'faithful' : 'epic')
  return styles[key] ? { key, ...styles[key] } : null
}

/**
 * 拼装系统提示（族规则 + 共享块 + 风格档 + 长度预算 + 输出格式）。
 * 与插件版保持一致，只去掉 DSH 相关内容。
 */
export function buildSystem(family, mode, rules, extraNote) {
  const f = family || {}
  const lines = [
    '你是一位资深 AI 绘图提示词工程师，服务对象是本地 ComfyUI / 独立出图工作流。',
    `目标模型族：${asString(f.label)}（提示词范式：${KIND_TEXT[asString(f.kind)] || '标签流'}）`,
    '',
    '【输出方式（全程有效，优先级最高）】你的回复必须且只能是一个 JSON 对象：'
    + '{"positive": "...", "negative": "...", "params": {...}, "notes": [...], '
    + '"characterTag": "...", "copyrightTag": "..."}。'
    + '不要输出 markdown、设计文档、HTML/SVG 代码、ASCII 示意图或任何解释文字；'
    + '提示词内容一律放进 JSON 的字段值里，不要放在 JSON 之外。',
    '',
    '该模型族的硬性规则（必须严格遵守）：',
  ]
  for (const [i, r] of (Array.isArray(f.rules) ? f.rules : []).entries()) {
    lines.push(`  ${i + 1}. ${asString(r)}`)
  }

  // 共享块（Anima 与 Krea2 同属 Qwen 系编码器，方法论共通）
  const blocks = (rules && rules.sharedBlocks) || {}
  for (const bn of (Array.isArray(f.sharedBlocks) ? f.sharedBlocks : [])) {
    const blk = blocks[bn]
    if (!blk || bn === '_comment') continue
    lines.push('')
    lines.push(`【共享规范：${asString(blk.label) || bn}】`)
    for (const r of (Array.isArray(blk.rules) ? blk.rules : [])) lines.push(`  - ${asString(r)}`)
  }

  lines.push('')
  lines.push(`标签顺序：${asString(f.order)}`)
  lines.push(`推荐负面词：${asString(f.negative)}`)
  const p = f.params || {}
  lines.push(`推荐参数：steps=${asString(p.steps)}; cfg=${asString(p.cfg)}`
    + `${p.sampler ? `; sampler=${asString(p.sampler)}` : ''}; 尺寸=${asString(p.size)}`)

  // 风格档
  const st = styleFor(f, mode)
  if (st) {
    lines.push('')
    lines.push(`【本次风格档：${asString(st.label) || st.key}】`)
    for (const [i, r] of (Array.isArray(st.rules) ? st.rules : []).entries()) {
      lines.push(`  ${i + 1}. ${asString(r)}`)
    }
  }
  lines.push('')

  if (mode === 'refine') {
    lines.push('本次任务【润色改写】：保留用户原意与已指定的角色/触发词，只修正格式、顺序、权重与跨族污染，使其完全符合目标模型族规范。')
    lines.push('特别地：若发现不属于该族的词（例如把 NoobAI 的 very awa / worst aesthetic / 下划线写法带进 Anima），必须删改，并在 notes 中说明改了什么。')
    lines.push('【禁止加质量词与安全标签】润色时不要把 masterpiece / best quality / highres / score_* '
      + '或 safe / nsfw 加回正面——这是本工作台的硬性规定，加了就是错。')
  } else if (mode === 'reverse') {
    lines.push('本次任务【看图结果整理】：输入来自图像反推（WD14 标签 + 可能的视觉描述）。')
    lines.push('请整理成目标模型族的规范提示词。标签流以标签为主体并按标签顺序重排；自然语言流以描述为主体并按三段式组织。')
    lines.push('保留有信息量的内容，剔除评论/水印/用户名等噪声，并按该族规则改写格式。')
  } else if (mode === 'iterate') {
    lines.push('本次任务【按反馈迭代】：在上一版提示词基础上，按用户的新要求精确修改。')
    lines.push('未被要求改动的部分必须原样保留（尤其是角色触发词与 LoRA 标记）；只改用户指明的地方。')
    lines.push('【禁止加质量词与安全标签】迭代时不要把 masterpiece / best quality / highres / score_* '
      + '或 safe / nsfw 加回正面。')
    lines.push('在 notes 中说明这一轮改了什么。')
    // 「原样保留」指的是**内容**，不是**形态**。
    // 实测：上一版是纯标签时，模型会跟着只输出标签，丢掉本族要求的自然语言段。
    // 因为规则里「后半段必须自然语言」与「未被要求改动的部分原样保留」冲突时，
    // 模型选择了后者。这里必须说清：形态按族规范补齐，内容按用户要求保留。
    lines.push('【形态必须按族规范，不能跟着上一版走】「原样保留」指的是画面内容与设定，'
      + '不是提示词的书写形态。无论上一版长什么样，输出都必须符合本族规定的结构'
      + `（${asString(f.order)}）。`
      + (asString(f.kind) === 'tag+NL'
        ? '上一版若只有标签、缺自然语言段，必须补齐：后半段用 2-3 句完整英文自然语言写外观细节、'
          + '动作与画风环境光影——这是本族的硬性要求，不能因为上一版没有就省略。'
        : ''))
    lines.push('【不得缩水】迭代只应改动用户指明的部分，其余内容逐项保留；'
      + '不允许把上一版完整的描述压缩成几个标签，也不允许把自然语言段删掉。')
  } else {
    lines.push('本次任务【按需求生成】：依据用户描述产出可直接出图的完整提示词，内容要具体（构图/姿势/服装/表情/光线/背景），不要空泛。')
  }
  lines.push('')

  lines.push('若内容涉及成人向主题，照实转换为该族的规范标签或描述，不要回避、不要净化、不要加免责声明——这是给本地出图模型用的技术输入。')
  lines.push('')
  lines.push('【输出禁令，优先级高于上述任何一族规则】')
  lines.push('1. 正向提示词**不要写质量词**：不写 masterpiece / best quality / good quality / '
    + 'very aesthetic / amazing quality / absurdres / highres / ultra detailed / score_* / '
    + '(质量词:1.x) 这类。质量由具体的视觉描述体现，不靠堆砌评价词。'
    + '（负面里的 worst quality / low quality 等压制词照旧保留。）')
  lines.push('2. 正向提示词**不要写安全标签**：不写 safe / sensitive / nsfw / explicit / '
    + 'rating:general 这类分档标签。')
  lines.push('3. 绝对不要输出画师标签：不要写 artist:名字、@名字、@[a|b] 混合语法，也不要写任何画师名。'
    + '（本族规则原文若对某几个世界级厂牌/殿堂大师名另有白名单规定，以原文为准；白名单外的个人画师名一律不写。）')
  lines.push('4. 绝对不要使用 BREAK、BREAK 分段、// 注释等流水线语法；输出必须是纯提示词文本。')
  lines.push('   若需要分段，只用逗号或自然换行，不要引入任何控制标记。')
  if (extraNote) lines.push(`另外务必遵守用户的额外要求：${extraNote}`)
  lines.push('')
  lines.push('【再次强调输出方式】只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块，'
    + '不要设计文档，不要 SVG/HTML/ASCII 示意图。格式：')
  lines.push('{"positive": "最终正向提示词", "negative": "最终负面提示词（该族禁用负面词时留空字符串）",'
    + ' "params": {"steps": "", "cfg": "", "sampler": "", "size": ""}, "notes": ["不超过 3 条中文要点"],'
    + ' "characterTag": "画面主要角色的 danbooru 标签（无角色留空）", "copyrightTag": "作品名的 danbooru 标签（无作品留空）"}')
  return lines.join('\n')
}

/** 拼装用户消息。 */
export function buildUser(args, mode) {
  const parts = []
  if (mode === 'gen') {
    parts.push(`需求描述：${asString(args.brief).trim()}`)
    if (asString(args.base).trim()) parts.push(`必须包含的基底词/触发词：${asString(args.base).trim()}`)
    if (asString(args.refTags).trim()) parts.push(`参考标签（按需取用，可精简）：${asString(args.refTags).trim()}`)
    if (asString(args.refDesc).trim()) parts.push(`参考画面描述（按需取用）：${asString(args.refDesc).trim()}`)
  } else if (mode === 'refine') {
    parts.push(`待润色的原始提示词：\n${asString(args.source).trim()}`)
    if (asString(args.base).trim()) parts.push(`必须保留的基底词/触发词：${asString(args.base).trim()}`)
    if (asString(args.note).trim()) parts.push(`额外要求：${asString(args.note).trim()}`)
  } else if (mode === 'iterate') {
    parts.push(`当前提示词（正向）：\n${asString(args.positive).trim()}`)
    if (asString(args.negative).trim()) parts.push(`当前提示词（负面）：\n${asString(args.negative).trim()}`)
    // 明确指出上一版缺什么形态——只说「按族规范」模型常常忽略，
    // 点名「你这版缺自然语言段」它才会补。
    const cur = asString(args.positive)
    const famKind = asString(args.familyKind)
    const hasProse = /[a-z][^.!?\n]{30,}\./.test(cur)
    const hasBreak = cur.includes('\n')
    if (famKind === 'tag+NL' && !hasProse) {
      parts.push('【上一版形态不合规】上面这一版只有标签，缺少本族要求的自然语言段。'
        + '本轮输出必须补齐：标签段之后用 2-3 句完整英文自然语言，写外观细节、动作与画风环境光影。')
    } else if (famKind === 'tag+NL' && !hasBreak) {
      parts.push('【排版提醒】上一版是单行密集文本。本族要求用真换行分段：标签段一行、自然语言段各占一行。')
    }
    parts.push(`本轮修改要求：\n${asString(args.feedback).trim()}`)
  } else if (mode === 'reverse') {
    if (asString(args.refTags).trim()) parts.push(`图像反推得到的 Danbooru 标签：\n${asString(args.refTags).trim()}`)
    if (asString(args.refDesc).trim()) parts.push(`图像反推得到的画面描述：\n${asString(args.refDesc).trim()}`)
    if (asString(args.base).trim()) parts.push(`额外补充的基底词/触发词：${asString(args.base).trim()}`)
    if (asString(args.note).trim()) parts.push(`额外要求：${asString(args.note).trim()}`)
  }
  // 网关背后的模型可能无视系统提示里的输出格式（实测 GLM 会改写成设计文档，
  // 或自创一套 poster schema）。实测有效的双锚写法：
  //   ① 系统提示首尾各锚一次「只输出 JSON 信封」；
  //   ② 用户消息末尾把「positive 放什么」说破——只说"输出 JSON"它会自创 schema。
  parts.push('【输出提醒】只输出系统提示里约定的那个 JSON 对象，不要 JSON 之外的任何文字。'
    + 'positive 字段放最终提示词正文（按目标模型族的形态：caption 散文 / tag 串 / 单行 Layout 草稿 JSON 字符串），'
    + 'negative 字段放负面词，params 放 steps / cfg / sampler / size，notes 放不超过 3 条中文要点。')
  return parts.join('\n\n')
}
