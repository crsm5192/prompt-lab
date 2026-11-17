// Text checks guide format correction and budget rewrites; they do not score the generated image.
import { measureLength, promptBudget } from './engine.js'
const unquoted = (s) => String(s || '').replace(/"[^"]*"|“[^”]*”/g, '')
const requestText = (task) => unquoted(['brief', 'source', 'feedback', 'note', 'hardNote', 'base'].map((k) => task[k] || '').join('\n')
  .replace(/["“](anime|cartoon|illustration|painting|watercolou?r|line ?art|动漫|动画|二次元|卡通|插画|绘画|油画|水彩|线稿)["”]/gi, '$1')
  .replace(/((?:不要|不用|排除|避免|禁止|no|not|without|avoid|exclude)\s*)["“]([^"”]*)["”]/gi, '$1$2'))
const styles = [
  ['anime', '动漫|动画|二次元|anime'],
  ['cartoon', '卡通|动漫|动画|二次元|cartoon|anime'],
  ['illustration', '插画|illustration'],
  ['painting', '绘画|油画|painting'],
  ['watercolor', '水彩|watercolou?r'],
  ['lineart', '线稿|line\\s?art'],
  ['photograph', '摄影|照片|photograph(?:y)?'],
  ['photorealistic', '写实摄影|照片写实|photorealis(?:tic|m)'],
  ['3d render', '3D|三维|3d(?:\\s+render(?:ing)?)?'],
]
const label = (s) => s.trim().toLowerCase().replace(/^\((.*?)(?::[\d.]+)?\)$/, '$1').replace(/_/g, ' ')
  .replace(/^watercolour$/, 'watercolor').replace(/^line art$/, 'lineart').replace(/^3d rendering$/, '3d render')

function excludes(text, pattern) {
  const list = '(?:[^\\n。.!?;；]{1,40}?(?:[,、，]|\\bor\\b|\\band\\b|或|和|以及|及)\\s*)?'
  return new RegExp(`(?:不要|不用|排除|避免|禁止|非)\\s*(?:添加|加入|使用)?\\s*${list}(?:${pattern})|\\b(?:no|not|without|avoid|exclude)\\s+(?:an?\\s+)?${list}(?:${pattern})\\b|\\bnon[- ](?:${pattern})\\b`, 'i').test(text)
}

function wantsTags(text) {
  return /(?:只要|仅用|只用|使用|用|输出).{0,10}(?:tag\s*串|标签串|英文标签)|\b(?:use|only|as|output)\s+(?:an?\s+|english\s+)?tags?\b/i.test(text)
    && !/(?:不要|不用|避免)\s*(?:英文\s*)?(?:tag\s*串|标签串)|\b(?:no|without|avoid)\s+(?:english\s+)?tags?\b/i.test(text)
}

export function reviewPrompt(result, family, task = {}) {
  const kind = family?.kind
  const issues = []
  const positive = String(result.positive || '')
  const structured = kind === 'NL+layout' && positive.trim().startsWith('{')
  const text = unquoted(positive)
  const request = requestText(task)
  const mode = task.mode || 'gen'
  const optimize = ['gen', 'refine'].includes(mode)
  const compact = optimize || mode === 'iterate'
  const tokens = typeof result.length?.value === 'number' ? result.length.value
    : (measureLength(positive, family)?.value || 0)
  const budget = promptBudget(family, mode, positive)
  const exceeded = compact && budget !== null && tokens > budget
  const reviewed = () => ({ valid: !issues.length, issues, scope: 'text', approximateTokens: structured ? null : tokens,
    targetMax: budget, budget: budget === null ? null : { maxTokens: budget, exceeded, enforced: mode === 'iterate' } })
  if (!['tag+NL', 'NL+layout'].includes(kind) && mode !== 'iterate') return reviewed()

  // Iteration preserves scene facts while repacking its wording; reverse remains faithful.
  if (exceeded) {
    issues.push(`正文约 ${tokens} token，超过本次${mode === 'iterate' ? '迭代输出上限' : '简洁生成目标'} ${budget}；保留所有指定信息与本轮反馈，重新组织完整正文，合并重复描述并压缩修饰，不截断正文`)
  }
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20)
  if (!structured && compact && new Set(sentences).size < sentences.length) issues.push('自然语言出现重复句，合并为一次描述并保留不同的动作和人物信息')
  if (['tag+NL', 'tag'].includes(kind) && compact) {
    const tags = positive.split('\n')[0].split(',').map(label).filter(Boolean)
    if (new Set(tags).size < tags.length) issues.push('基础标签行有完全重复的标签，同一锚点只保留一次')
  }
  if (!['tag+NL', 'NL+layout'].includes(kind)) return reviewed()
  if (kind === 'NL+layout' && optimize && !structured && !wantsTags(request) && !/[A-Za-z][^.!?\n]{8,}[.!?]/.test(text)) {
    issues.push('普通 MOSS 场景使用完整英文画面描述；仅在用户要求 tag 串时输出标签')
  }
  if (structured && /(?:不要|不用|不使用|无需)\s*Layout|\b(?:no|without|avoid)\s+Layout\b/i.test(request)) {
    issues.push(wantsTags(request) ? '用户已排除 Layout 并要求 tag 串，本次应返回英文标签，不添加坐标' : '用户已排除 Layout，本次应返回普通英文画面描述，不重排元素或添加坐标')
  }

  // Match literal negative labels only. Do not infer a ban from style names in prose.
  const negatives = String(result.negative || '').split(',').map(label).filter(Boolean)
  const supplied = String(task.negative || '').split(',').map(label)
  for (const [name, aliases] of styles) {
    if (!negatives.includes(name) || supplied.includes(name) || excludes(request, aliases)) continue
    // Photo/3D exclusions can be appropriate for a requested painting, and vice versa.
    if (['photograph', 'photorealistic', '3d render'].includes(name)) {
      if (!new RegExp(aliases, 'i').test(request + '\n' + text)) continue
    }
    issues.push(`负面 ${name} 压制了合法媒介或画风；用户未排除它时删除该项，保留实际异常压制词`)
  }

  // Do not compare framing or support across different panels or different people.
  const single = /\b(?:solo|1girl|1boy|a dancer|a woman|an adult (?:female|male|woman|man))\b|一名|一个|单人|独舞|独自/i.test(text + '\n' + request)
  const multiple = /\b(?:[2-9](?:girls|boys)|[2-9]\s+(?:women|men|people)|two|three|four|couple|group|diptych|panels?|collage)\b|两人|双人|多人|另一个|另一人|分格|拼贴/i.test(text + '\n' + request)
  if (!structured && optimize && single && !multiple) {
    if (/\bfull[- ]body\b/i.test(text) && /\b(?:half[- ]body|waist[- ]up|head[- ]and[- ]shoulders|cropped at (?:the )?waist)\b/i.test(text)) {
      issues.push('同一人物同时出现全身与半身景别，按用户要求保留一个自洽景别')
    }
    if (/\b(?:airborne|mid[- ]air|leaping|leaps?|jumping)\b/i.test(text)
      && /\bboth(?:\s+bare)?\s+feet\s+(?:(?:are|remain|rest|resting|firmly|naturally|flat|flatly|planted)\s+){0,4}(?:on|against|touching)\s+(?:the\s+)?(?:floor|ground|stage)\b/i.test(text)) {
      issues.push('同一瞬间既腾空又双脚接地，保留用户要求的动作状态与相应支撑关系')
    }
  }
  return reviewed()
}
