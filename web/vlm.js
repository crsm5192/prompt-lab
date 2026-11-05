/**
 * 拒答检测 —— 判断 VLM 的输出是「真的描述了画面」还是「拒绝/回避」。
 *
 * 为什么要单独做这件事：
 *   API 多模态模型（尤其带安全策略的）遇到 NSFW 图会拒答，但拒答的
 *   表现形式五花八门，不是只有一句 "I can't"。常见的有：
 *     1. 直接拒绝："I'm sorry, I cannot..."
 *     2. 声明能力不足："I'm unable to view images."
 *     3. 描述替代：明明能看到，却只写 "a person standing"（回避细节）
 *     4. 反向审问："Could you describe what you see?"
 *     5. 空输出 / 只有标点
 *     6. 中文拒答："抱歉，我无法..."
 *   这些如果不识别，就会被当成正常反推结果，输出一堆没用的提示词。
 *
 * 判定策略：**三路信号取或**（任一命中即视为拒答）
 *   - 拒答短语（强信号）
 *   - 输出过短且无标签特征（弱信号聚合）
 *   - 元话语（模型在谈论任务而非画面）
 *
 * 刻意保守：宁可放行一个可疑结果，也不要误杀正常输出。
 * 因为误杀代价是「明明能反推却退到 WD14」，而漏判代价是「输出垃圾」，
 * 后者用户一眼能看出并重试，前者是静默降级。
 */

// 强拒答短语（英文）。用词边界避免误伤 "candid" 里的 can 之类。
const REFUSAL_PATTERNS = [
  /\bi(?:'m| am) (?:sorry|afraid|unable|not able)\b/i,
  /\bi (?:cannot|can't|can not|won't|will not|am unable to)\b/i,
  /\b(?:cannot|can't|unable to) (?:help|assist|comply|process|analy[sz]e|view|see|describe)\b/i,
  /\b(?:as an ai|as a language model|i'm just an ai)\b/i,
  /\bagainst (?:my|the) (?:policy|policies|guidelines|programming)\b/i,
  /\b(?:not|n't) (?:able|allowed|permitted) to (?:view|see|describe|analy[sz]e|process)\b/i,
  /\b(?:inappropriate|explicit|nsfw|sexual|adult) content\b/i,
  /\b(?:i )?(?:do not|don't) (?:have|possess) (?:the )?(?:ability|capability)\b/i,
  /\b(?:please|kindly) (?:provide|upload|share|describe)\b[^.!?]{0,40}\b(?:image|picture|photo)\b/i,
  /\bi (?:see|can see) (?:no|an empty) (?:image|picture)\b/i,
  /\b(?:image|picture) (?:is )?(?:not|un)available\b/i,
  /\bthis (?:image|picture|content) (?:appears|seems|looks) (?:to be )?(?:inappropriate|explicit)\b/i,
]

// 中文拒答
const REFUSAL_ZH = [
  /抱歉[,，]?\s*(?:我|但)/,
  /(?:我|本人)?无法(?:查看|浏览|看到|处理|协助|提供|描述|分析)/,
  /(?:不能|不便|不会)(?:查看|浏览|处理|描述|提供)/,
  /作为(?:一个)?(?:AI|人工智能|语言模型)/,
  /(?:违反|不符合).{0,10}(?:政策|规定|准则|规范)/,
  /(?:请|麻烦)(?:提供|上传|描述).{0,10}(?:图片|图像|照片)/,
  /(?:图片|图像).{0,6}(?:无法|不能|没有)(?:显示|加载|提供)/,
]

/**
 * 元话语：模型在说「任务/格式/要求」，而不是在描述画面。
 * 这类输出通常意味着它没真正看图。
 */
const META_PATTERNS = [
  /\b(?:here (?:are|is) (?:the |some )?tags?)\b/i,
  /\b(?:based on (?:the|your) (?:image|request|description))\b/i,
  /\b(?:i (?:would|can) describe (?:it|this) as)\b/i,
  /\b(?:sure|certainly|of course)[,!.]/i,
  /\b(?:let me|i'll) (?:describe|analy[sz]e|break)/i,
  /以下是(?:我|对).{0,8}(?:描述|分析|结果)/,
]

/**
 * 软回避：模型**没有拒答**，但把敏感内容改写成干净描述。
 *
 * 这是最难识别的一类。实测 cn:fast-model 遇到「描述裸露」的请求会回：
 *   "I can describe this image, but there's no nudity or sexual content
 *    to describe — it's a fully clothed character illustration."
 * 然后照常描述衣着。表面上完全正常，实际上它在否认画面内容。
 *
 * 这类输出如果放行，用户看到的提示词就是被净化过的、和原图不符的。
 * 对出图工具来说，这比明确拒答更糟——因为不可见。
 *
 * 判定：出现「否定 + 敏感词」的句式，且整体缺少 NSFW 证据。
 */
const SOFT_AVOID_PATTERNS = [
  // 英文：否认存在敏感内容
  /\b(?:there(?:'s| is) )?(?:no|not any|zero) (?:nudity|nude|sexual|explicit|nsfw|adult|pornographic|suggestive) (?:content|material|imagery)/i,
  /\b(?:doesn't|does not|don't) (?:contain|include|show|feature|depict) (?:any )?(?:nudity|sexual|explicit|nsfw|adult)/i,
  /\b(?:fully|completely|entirely) clothed\b/i,
  /\b(?:not|nothing) (?:explicit|sexual|nsfw|suggestive) (?:here|present|shown)/i,
  // 「我很乐意描述，但是…」这类转折
  /\bi (?:can|would be happy to|am happy to) describe (?:this|it)[,.]?\s*but\b/i,
  // 中文
  // 要求「否认词 + 敏感词」两端都明确，避免误伤正常描述
  /(?:没有|并无|不含|未有)(?:任何)?(?:裸露|露骨|色情|性暗示|成人内容)/,
  /(?:画面|图中|这张图|该图).{0,12}(?:没有|并无|不含|无).{0,12}(?:裸露|露骨|色情|性暗示|成人)/,
  /(?:衣着|穿着).{0,4}(?:完整|整齐|得体|完全)/,
  /(?:完全|全)(?:着装|穿衣)/,
]

/** 画面确实含敏感内容的证据（标签或描述里出现）。 */
const NSFW_EVIDENCE = [
  /\b(?:nude|naked|nipples?|topless|bare breasts|areolae|panties|underwear|lingerie|cleavage|nsfw|explicit|uncensored|sex|penetration|cum|erection|genitals?|penis|vagina|anus)\b/i,
  /裸露|裸体|全裸|半裸|乳|下体|性交|色情/,
]

/** 只要出现这些，说明模型确实在描述画面（哪怕很短）。 */
const VISUAL_SIGNALS = [
  /1girl|1boy|2girls|2boys|multiple_girls|multiple_boys|solo\b/i,
  /\b(?:hair|eyes|dress|shirt|skirt|armor|cape|sword|weapon|background|pose|view)\b/i,
  /\b(?:color|colour|lighting|shadow|frame|composition)\b/i,
  /头发|眼睛|衣服|背景|姿势|表情|画面|构图|光线|色调/,
]

/**
 * 句内否认判定：某个敏感词出现时，它前面（同一分句内、40 字以内）
 * 是否有否定词在管着它。
 *
 * 为什么需要它：
 *   "This image does not contain any X or Y" 里，Y 前面隔着 X，
 *   单靠「摘掉否认短语」是摘不干净的；只有按位置判断才可靠。
 */
const NEG_CUE =
  /(?:\b(?:not|no|none|nothing|never|without|isn't|aren't|doesn't|don't|didn't|hasn't|haven't|lacks?)\b|free of|没有|并无|不含|未有|无任何)/i

function isDenied(clause, idx) {
  const win = clause.slice(Math.max(0, idx - 40), idx)
  const cut = win.search(/[,，。.!?；;][^,，。.!?；;]*$/)
  const tail = cut >= 0 ? win.slice(cut + 1) : win
  return NEG_CUE.test(tail)
}

/** 全文里是否存在「未被否认」的敏感证据。 */
function hasEvidence(text) {
  for (const re of NSFW_EVIDENCE) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m
    while ((m = g.exec(text))) {
      if (m[0].length === 0) { g.lastIndex += 1; continue }
      if (!isDenied(text, m.index)) return true
    }
  }
  return false
}

/**
 * 判断是否为拒答。
 *
 * @param {string} text 模型输出
 * @param {object} opts { minChars, minTags }
 * @returns {{refused:boolean, reason:string, matched?:string, tagCount:number}}
 */
export function detectRefusal(text, opts = {}) {
  const raw = String(text == null ? '' : text).trim()
  const minChars = Number(opts.minChars) || 12
  const minTags = Number(opts.minTags) || 3

  // 空输出
  if (!raw) {
    return { refused: true, reason: 'empty', matched: '', tagCount: 0 }
  }

  // 只有标点/空白
  if (!/[a-zA-Z\u4e00-\u9fa5]/.test(raw)) {
    return { refused: true, reason: 'no-letters', matched: raw.slice(0, 40), tagCount: 0 }
  }

  // 统计「像标签」的片段：逗号分段且较短、无句号
  const segs = raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  const tagLike = segs.filter((s) => s.length <= 40 && !/[.!?。！？]/.test(s))
  const tagCount = tagLike.length

  // ── 第一步：找出「否认句式」，并判断证据是否属于被否认的那部分 ──
  //
  // 关键点：否认句里天然带着敏感词本身（"no X content"），所以不能
  // 直接拿全文找证据——那会把「否认」读成「描述」。但也不能简单把
  // 整句删掉：模型可能在一句里先否认、再如实描述（"no X, but the
  // figure is Y"），那说明它其实看见了。按「否定词管辖范围」判定。
  let softMatched = ''
  for (const re of SOFT_AVOID_PATTERNS) {
    const m = text == null ? null : String(text).match(re)
    if (m) { softMatched = m[0]; break }
  }

  const evidence = hasEvidence(raw)

  // ── 第二步：有证据 = 模型确实在描述画面，放行 ──
  //
  // 哪怕它顺口说了句「这里没有 XX」，只要它同时给出了真实画面细节，
  // 就说明它看见了，不能因为语气否定就判死。
  if (evidence) {
    return { refused: false, reason: 'ok', matched: '', tagCount }
  }

  // ── 第三步：否认句式 + 无任何证据 = 软回避 ──
  //
  // 必须排在强拒答之前：软回避的句子里常带 content 之类的词，
  // 会被强拒答规则先命中，导致 reason 被标错（虽然结论一样是拒答）。
  if (softMatched) {
    return {
      refused: true,
      reason: 'soft-avoid',
      matched: softMatched.slice(0, 80),
      tagCount: 0,
    }
  }

  // ── 第四步：强拒答短语 ──
  for (const re of REFUSAL_PATTERNS) {
    const m = raw.match(re)
    if (m) return { refused: true, reason: 'refusal-phrase', matched: m[0].slice(0, 80), tagCount: 0 }
  }
  for (const re of REFUSAL_ZH) {
    const m = raw.match(re)
    if (m) return { refused: true, reason: 'refusal-zh', matched: m[0].slice(0, 80), tagCount: 0 }
  }

  // ── 第五步：弱信号（元话语 / 过短 / 标签太少）──
  const hasVisual = VISUAL_SIGNALS.some((re) => re.test(raw))
  const hasMeta = META_PATTERNS.some((re) => re.test(raw))

  if (hasMeta && !hasVisual) {
    return { refused: true, reason: 'meta-talk', matched: raw.slice(0, 80), tagCount }
  }
  if (raw.length < minChars && !hasVisual) {
    return { refused: true, reason: 'too-short', matched: raw.slice(0, 80), tagCount }
  }
  if (tagCount < minTags && !hasVisual) {
    return { refused: true, reason: 'too-few-tags', matched: raw.slice(0, 80), tagCount }
  }

  return { refused: false, reason: 'ok', matched: '', tagCount }
}


/**
 * 从 VLM 的自然语言/标签输出里提取标签列表。
 *
 * VLM 不会严格按 Danbooru 语法输出，可能：
 *   - 给逗号列表          -> 直接切
 *   - 给一句话            -> 需要转成标签（保留原句，交给 LLM 二次整理）
 *   - 混着解释文字        -> 去掉解释句
 */
export function extractTagsFromVlm(text) {
  const raw = String(text || '').trim()
  if (!raw) return { tags: '', sentences: '' }

  const segs = raw
    .split(/[,，\n]/)
    .map((s) => {
      // 去句首「列表标记」，但要小心别把 1girl 的 1 当成序号：
      // 只有「数字+分隔符(. ) -)」才算序号（"1. " / "2) " / "- " / "* "）
      // 而 "1girl" 数字后紧跟字母，不是序号
      return s
        .replace(/^\s*(?:[-*•]+\s+)/, '')            // 项目符号
        .replace(/^\s*\d+\s*[.)、]\s*/, '')           // 1. / 2) / 3、
        .trim()
    })
    .filter(Boolean)

  // 去掉像句子的段（带句号且很长）
  const tagSegs = segs.filter((s) => !(/[.!?。！？]$/.test(s) && s.length > 50))
  const sentSegs = segs.filter((s) => /[.!?。！？]$/.test(s) && s.length > 50)

  const norm = (s) => s
    .toLowerCase()
    .replace(/[()\[\]{}"']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim()

  // 标签化的段：压成下划线风格（后续 finalizeText 按族再决定是否转空格）
  const toTag = (s) => {
    let x = norm(s)
    // 只去冠词，**保留数字**（1girl / 2boys / 4k 这类是 Danbooru 的真实标签）
    x = x.replace(/^(?:a|an|the)\s+/, '')
    // 保留字母数字下划线空格连字符斜杠和点（score_9 / 1.5 权重）
    x = x.replace(/[^a-z0-9_\s\-/.]/g, '')
    x = x.replace(/\s+/g, '_')
    x = x.replace(/^_+|_+$/g, '')
    x = x.replace(/_+/g, '_')
    return x
  }

  const tags = tagSegs.map(toTag).filter((t) => t && t.length > 1).join(', ')
  const sentences = sentSegs.join(' ').trim()
  return { tags, sentences }
}
