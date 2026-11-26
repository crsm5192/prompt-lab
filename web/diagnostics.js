import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const context = new AsyncLocalStorage()
const routes = new Set(['/compose', '/reverse', '/nibbles/assemble', '/nibbles/convert'])
const modes = new Set(['gen', 'iterate', 'refine', 'reverse'])
const families = new Set(['generic', 'noobai', 'anima', 'krea2', 'moss', 'nibbles', 'noob2'])
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

function errorKind(message, status) {
  const value = typeof message === 'string' ? message : ''
  for (const [prefix, kind] of [
    ['提示词重组模型调用失败', 'repair_failed'], ['模型未返回可用提示词', 'positive_unusable'],
    ['模型返回空内容', 'model_empty'], ['模型返回非 JSON', 'gateway_non_json'],
    ['模型接口 ', 'gateway_http'], ['模型调用超时', 'model_timeout'],
    ['WD14', 'wd14_error'], ['VLM', 'vision_error'], ['fetch failed', 'network_error'],
  ]) if (value.startsWith(prefix)) return kind
  return status >= 400 && status < 500 ? 'input_error' : 'task_error'
}

export function logModelCall(details) {
  const task = context.getStore()
  if (task) task.write('model_call', { attempt: ++task.calls, ...details })
}

export function taskDiagnostics(directory, now = () => new Date()) {
  let lastWriteWarning = ''
  return (req, res, next) => {
    const route = req.path
    if (req.method !== 'POST' || !routes.has(route)) return next()
    const requestId = randomUUID()
    const started = performance.now()
    function write(event, fields = {}) {
      const time = now()
      const day = dayFormat.format(time)
      const row = { time: time.toISOString(), requestId, route, event, ...fields }
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        appendFileSync(join(directory, day + '.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 })
      } catch {
        if (lastWriteWarning !== day) console.error('[diagnostics] Unable to write daily task log')
        lastWriteWarning = day
      }
    }
    const task = { write, calls: 0 }
    res.setHeader('X-Request-ID', requestId)
    write('request_started')
    let result = {}
    const sendJson = res.json
    res.json = function (body) {
      if (body?.ok === false) {
        result.error = errorKind(body.error, res.statusCode)
        body = { ...body, requestId }
      } else if (body?.ok === true) {
        result = { valid: body.validation?.valid, qualityValid: body.quality?.valid,
          repairs: body.quality?.repairAttempts,
          fallback: body.engine === 'wd14' ? req.body?.engine !== 'wd14' : undefined,
          via: ['vlm', 'wd14'].includes(body.engine) ? body.engine : undefined,
          positiveChars: typeof body.positive === 'string' ? body.positive.length : 0 }
        if (body.notes?.some?.(s => typeof s === 'string' && s.includes('模型未返回标准 JSON'))) result.format = 'plain_text'
      }
      return sendJson.call(this, body)
    }
    res.once('close', () => {
      const mode = req.body?.mode || (route === '/compose' ? 'gen' : undefined)
      const family = typeof req.body?.family === 'string' ? req.body.family.toLowerCase() : ''
      write(res.writableFinished ? 'request_finished' : 'client_disconnected', {
        status: res.writableFinished ? res.statusCode : undefined, ms: Math.round(performance.now() - started),
        mode: modes.has(mode) ? mode : undefined, family: families.has(family) ? family : undefined,
        modelCalls: task.calls, ...result,
      })
    })
    context.run(task, next)
  }
}
