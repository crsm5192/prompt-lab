/**
 * 角色库检索 —— 对标本机插件的 doCharSearch。
 *
 * 本机版走 `nas_bridge.py` + `query_char_fuzzy.py`（查 101 上的 kb.sqlite）。
 * 这里改成**两级检索**，不依赖那个 sqlite：
 *   1. Danbooru 精确核验（角色是否真实存在、类别对不对）
 *   2. OpenViking 语义检索（从 KB 里找相关资源/描述/画师风格）
 *
 * 为什么这么改：
 *   - kb.sqlite 有 500MB+，同步到 102 代价大且会不断变大
 *   - OpenViking 已经索引了那批资源（61 上的服务），直接查更省事
 *   - Danbooru 官方 API 是权威数据源，角色存在性判断比本地库更准
 */
import { asString } from './engine.js'

/** 日文名常见顺序颠倒（Danbooru 是姓前名后）。 */
const NAME_SWAP_HINT = /^[a-z]+_?[a-z]+$/

/**
 * 角色检索主流程。
 * @param {object} deps { booru, viking }
 * @param {object} payload { query, limit, withText }
 */
export async function searchCharacter(deps, payload) {
  const { booru, viking } = deps
  const query = asString(payload.query).trim()
  if (!query) throw new Error('请提供角色名')

  // 归一：空格 -> 下划线（Danbooru 惯例）
  const norm = query.toLowerCase().replace(/\s+/g, '_')
  const notes = []
  let anchors = []

  // ── 1. Danbooru 精确核验 ──
  try {
    const exact = await booru.verify([norm])
    if (exact.length) {
      anchors = exact
    } else {
      // 不存在：先试「语序颠倒」（Danbooru 日文名是姓前名后，写反很常见）
      const parts = norm.split('_').filter(Boolean)
      let swappedHit = null
      if (parts.length === 2) {
        const swapped = `${parts[1]}_${parts[0]}`
        const r2 = await booru.verify([swapped])
        swappedHit = r2.find((x) => x.name === swapped) || null
        if (swappedHit) {
          anchors = [{ name: swappedHit.name, postCount: swappedHit.postCount, category: swappedHit.category }]
          notes.push(`「${norm}」不存在；Danbooru 用「姓前名后」，应为 ${swappedHit.name}（已自动纠正）`)
        }
      }
      if (!swappedHit) {
        notes.push(`「${norm}」在 Danbooru 无精确匹配，改用模糊搜索`)
        const fuzzy = await booru.search(norm, 8)
        anchors = fuzzy.map((t) => ({
          name: t.name, postCount: t.postCount, category: t.category,
        }))
      }
    }
  } catch (e) {
    notes.push(`Danbooru 查询失败：${String(e.message || e).slice(0, 100)}`)
  }

  // 分类建议：角色=4，作品=3
  const chars = anchors.filter((a) => a.category === 'character')
  const works = anchors.filter((a) => a.category === 'copyright')
  const others = anchors.filter((a) => !['character', 'copyright'].includes(a.category))

  // ── 2. OpenViking 语义检索（找相关资源）──
  let refs = []
  if (viking && payload.withText !== false) {
    const r = await viking.find({
      query,
      limit: Number(payload.limit) || 5,
      withText: true,
    })
    refs = r.refs || []
    if (!r.ok && r.errors && r.errors.length) {
      notes.push(`Viking 检索降级：${r.errors.slice(0, 2).join('；')}`)
    }
  }

  return {
    ok: true,
    query,
    normalized: norm,
    // 推荐写法：优先取角色，其次作品
    suggested: chars.length ? chars[0].name : (works.length ? works[0].name : (anchors[0] && anchors[0].name) || ''),
    characters: chars,
    works,
    others,
    refs,
    notes,
  }
}

/**
 * 批量核验角色/作品标签（整理结果时用，自动纠正写法）。
 * 对应本机插件的 verifyAnchors。
 */
export async function verifyAnchors(deps, { character, copyright }) {
  const { booru } = deps
  const notes = []
  let positiveFix = null
  const report = []

  for (const [kind, raw] of [['character', character], ['copyright', copyright]]) {
    const name = asString(raw).trim()
    if (!name) continue
    const norm = name.toLowerCase().replace(/\s+/g, '_')
    try {
      const hit = await booru.verify([norm])
      const exact = hit.find((h) => h.name === norm)
      if (exact) {
        const wantCat = kind === 'character' ? 'character' : 'copyright'
        if (exact.category !== wantCat) {
          // 常见陷阱：harry_potter 是角色，作品是 harry_potter_(series)
          if (kind === 'copyright' && exact.category === 'character') {
            const alt = hit.find((h) => h.name === `${norm}_(series)`)
            if (alt) {
              notes.push(`${norm} 是角色，作品应为 ${alt.name}，已自动纠正`)
              positiveFix = { from: norm, to: alt.name }
              report.push({ key: kind, ok: true, fixed: alt.name })
              continue
            }
            notes.push(`${norm} 在 Danbooru 是角色而非作品，请确认作品名`)
            report.push({ key: kind, ok: false, reason: 'category-mismatch', name: norm })
            continue
          }
          notes.push(`${norm} 的类别是 ${exact.category}，不是 ${wantCat}`)
          report.push({ key: kind, ok: false, reason: 'category', name: exact.category })
          continue
        }
        report.push({ key: kind, ok: true, name: exact.name, postCount: exact.postCount })
      } else {
        // 不存在：可能是语序反了
        const parts = norm.split('_')
        if (parts.length === 2) {
          const swapped = `${parts[1]}_${parts[0]}`
          const hit2 = await booru.verify([swapped])
          const ex2 = hit2.find((h) => h.name === swapped)
          if (ex2) {
            notes.push(`${norm} 不存在，语序应为 ${swapped}（Danbooru 姓前名后），已自动纠正`)
            positiveFix = { from: norm, to: swapped }
            report.push({ key: kind, ok: true, fixed: swapped })
            continue
          }
        }
        notes.push(`「${norm}」在 Danbooru 不存在（${kind === 'character' ? '角色' : '作品'}）`)
        report.push({ key: kind, ok: false, reason: 'not-found', name: norm })
      }
    } catch (e) {
      notes.push(`核验 ${norm} 失败：${String(e.message || e).slice(0, 80)}`)
    }
  }

  return { notes, fix: positiveFix, report }
}

/**
 * 把纠正应用到正文。
 *
 * 关键细节：Danbooru 标签用下划线，但正文可能是空格写法（anima/krea2 规范）。
 * 所以替换时要**跟随原文的写法**，不能直接把下划线版本塞进去——
 * 否则会给一个本来合规的提示词引入下划线污染。
 */
export function applyAnchorFix(text, fix) {
  if (!fix) return text
  const s = asString(text)
  const fromParts = String(fix.from).split('_')
  const toParts = String(fix.to).split('_')

  // 两种写法分别匹配：下划线版 与 空格版
  const variants = [
    { from: fromParts.join('_'), to: toParts.join('_') },   // subaru_awa -> awa_subaru
    { from: fromParts.join(' '), to: toParts.join(' ') },   // subaru awa -> awa subaru
  ]

  let out = s
  for (const v of variants) {
    if (!v.from) continue
    const re = new RegExp(`(?<![a-z0-9_])${v.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_(])`, 'gi')
    out = out.replace(re, v.to)
  }
  return out
}
