/**
 * 只把「巡检确认可用」的 DeepSeek 模型暴露给 DSH 的模型选择器。
 *
 * 白名单是一个 JSON 文件，由外部巡检脚本定期写入：
 *   { at, staleAfterMinutes, keepProviders: [], models: [{ provider?, model }] }
 * provider 缺省表示「任何提供该模型 id 的渠道都算」。
 *
 * 实现方式：只包装 `sessionController.modelCatalog`（选择器读的那一份目录），
 * 不改 `llm.listModels` —— 后者同时用于「发送前模型可用性校验」，
 * 过滤它会让正在用其它模型的会话发不出消息。这里只影响列表显示，
 * 已选模型照常可发。
 *
 * 失败安全：白名单缺失、无法解析或过期时一律放行；包装抛错也放行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 付费/官方 DeepSeek 渠道：无论巡检结论如何都保留。 */
const DEFAULT_KEEP_PROVIDERS = ['deepseek-official', 'deepseek-account', 'codearts']
const DEFAULT_STALE_MINUTES = 180

/**
 * 解析白名单路径：显式配置 > 环境变量 > `~/.dsh/deepseek-whitelist.json`。
 * @param {string | undefined} configured
 * @returns {string}
 */
function resolveWhitelistPath(configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const fromEnv = process.env.DSH_DEEPSEEK_WHITELIST
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh', 'deepseek-whitelist.json')
}

export const name = 'deepseek-picker-filter'
export const inject = ['sessionController']

export function apply(ctx, config) {
  const controller = ctx.sessionController
  if (controller === undefined || typeof controller.modelCatalog !== 'function') return

  const whitelistPath = resolveWhitelistPath(config?.whitelistPath)
  const defaultKeep = Array.isArray(config?.keepProviders) && config.keepProviders.every(id => typeof id === 'string')
    ? config.keepProviders
    : DEFAULT_KEEP_PROVIDERS

  let cachedMtime = -1
  let cachedModels = null
  let cachedAt = 0
  let cachedStaleMs = DEFAULT_STALE_MINUTES * 60_000
  let cachedKeep = defaultKeep

  /** 读取并缓存白名单；不可用时返回 undefined（调用方放行）。 */
  function readWhitelist() {
    let stat
    try {
      stat = fs.statSync(whitelistPath)
    } catch {
      return undefined
    }
    if (stat.mtimeMs !== cachedMtime || cachedModels === null) {
      try {
        const parsed = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'))
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.models)) return undefined
        const models = []
        for (const row of parsed.models) {
          if (!row || typeof row.model !== 'string' || row.model === '') continue
          models.push(typeof row.provider === 'string' && row.provider !== ''
            ? { provider: row.provider, model: row.model }
            : { model: row.model })
        }
        cachedModels = models
        cachedKeep = Array.isArray(parsed.keepProviders) && parsed.keepProviders.every(id => typeof id === 'string')
          ? parsed.keepProviders
          : defaultKeep
        cachedAt = Number(parsed.at) || 0
        cachedStaleMs = (Number(parsed.staleAfterMinutes) > 0 ? Number(parsed.staleAfterMinutes) : DEFAULT_STALE_MINUTES) * 60_000
        cachedMtime = stat.mtimeMs
      } catch {
        return undefined
      }
    }
    if (!Number.isFinite(cachedAt) || cachedAt <= 0) return undefined
    if (Date.now() - cachedAt > cachedStaleMs) return undefined
    return { models: cachedModels, keepProviders: cachedKeep }
  }

  const original = controller.modelCatalog.bind(controller)

  ctx.effect(() => {
    controller.modelCatalog = async (...args) => {
      const catalog = await original(...args)
      try {
        const whitelist = readWhitelist()
        if (whitelist === undefined) return catalog

        const pairs = new Set()
        const bare = new Set()
        for (const entry of whitelist.models) {
          if (entry.provider === undefined) bare.add(entry.model)
          else pairs.add(`${entry.provider}/${entry.model}`)
        }

        const keepProviders = new Set(whitelist.keepProviders)
        const defaultSelection = catalog?.default
        const keep = (providerId, modelId) =>
          keepProviders.has(providerId)
          || pairs.has(`${providerId}/${modelId}`)
          || bare.has(modelId)
          // 当前选中的那个必须留着，否则选择器显示不出自己正在用的模型
          || (defaultSelection !== undefined
            && defaultSelection.provider === providerId
            && defaultSelection.model === modelId)

        const groups = Array.isArray(catalog?.groups)
          ? catalog.groups.map(group => ({
            ...group,
            models: Array.isArray(group.models) ? group.models.filter(model => keep(group.id, model.id)) : [],
          })).filter(group => group.models.length > 0)
          : []

        return { ...catalog, groups, routableProviders: groups.map(group => group.id) }
      } catch {
        return catalog
      }
    }
    return () => { controller.modelCatalog = original }
  }, 'deepseek-picker-filter: 把模型目录过滤到巡检白名单')
}