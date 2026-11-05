# dsh-deepseek-picker-filter

让 DSH 右下角的模型选择器**只列出你确认过能用的 DeepSeek 模型**，省掉每次在几十个模型里翻找的时间。

配合任意「巡检脚本」使用：脚本把结论写进一个 JSON 白名单，本插件只负责把选择器过滤到白名单范围。插件本身**不做任何探测**，也不发网络请求。

## 它解决什么

DSH 装上多个免费渠道（`dsh-our-free-model` 之类）后，选择器里会堆出几十个模型，其中大部分已经废弃、限流或根本调不通。每次想用都要自己试一遍。

这个插件让选择器只显示：

1. 白名单里「最近一次巡检确认可用」的模型
2. `keepProviders` 里列出的渠道（默认 `deepseek-official`、`deepseek-account`、`codearts` —— 付费/官方渠道永远保留，不因为巡检没测到就被藏掉）
3. 当前会话正在用的那个模型（否则选择器会连自己现在用的都显示不出来）

## 安装

```bash
# 1. 克隆到任意位置
git clone https://github.com/poweriverHN/dsh-deepseek-picker-filter.git
cd dsh-deepseek-picker-filter

# 2. 装进 DSH profile（把路径换成你的实际位置）
dsh plugin install link:/path/to/dsh-deepseek-picker-filter
```

或者直接用插件管理器：

```
plugin_manager  action=install_bundle  target=link:/path/to/dsh-deepseek-picker-filter
```

插件是纯 Host 侧 ESM，没有客户端代码，**装完刷新页面即可**，不需要重启 DSH。

## 白名单格式

```json
{
  "at": 1793846236768,
  "staleAfterMinutes": 180,
  "keepProviders": ["deepseek-official", "deepseek-account", "codearts"],
  "rotateExclude": ["deepseek-official", "deepseek-account", "codearts"],
  "models": [
    { "provider": "trae", "model": "DeepSeek-V4-Pro" },
    { "provider": "codearts", "model": "deepseek-v4.1-flash" },
    { "model": "some-model-id" }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `at` | 巡检完成时间戳（毫秒）。超过 `staleAfterMinutes` 后白名单整体失效，插件放行全部模型 |
| `staleAfterMinutes` | 过期阈值，缺省 180 |
| `keepProviders` | 永远保留的渠道 id；缺省 `["deepseek-official","deepseek-account","codearts"]` |
| `rotateExclude` | 本插件不读这个字段，由配套的轮换插件使用 |
| `models[].provider` | 渠道 id；**省略表示「任何提供这个模型 id 的渠道都算」** |
| `models[].model` | 模型 id |

## 配置

三个来源，优先级从高到低：

| 来源 | 写法 |
| --- | --- |
| 插件配置 | `cordis.patch.yml` 里 `config.whitelistPath` / `config.keepProviders` |
| 环境变量 | `DSH_DEEPSEEK_WHITELIST=/path/to/whitelist.json` |
| 默认值 | `~/.dsh/deepseek-whitelist.json` |

例：在 profile 的 patch 里固定路径

```yaml
- insert:
    - id: deepseek-picker-filter
      name: 'dsh-deepseek-picker-filter'
      config:
        whitelistPath: /home/me/patrol/whitelist.json
        keepProviders: ['deepseek-official', 'deepseek-account']
```

## 失败安全

插件刻意做到「怎么都坏不掉对话」：

- 白名单文件不存在 → 不过滤，选择器显示全部
- JSON 解析失败 → 不过滤
- 白名单过期 → 不过滤
- `models` 为空 → 不过滤
- 包装函数内部抛任何异常 → 返回原始目录

也就是说：**巡检脚本挂了，你只是回到「全部模型都显示」的状态，不会用不了。**

## 实现细节

只包装 `sessionController.modelCatalog` —— 这正是选择器读取的那份目录。

**刻意不改 `llm.listModels`**：那份目录同时用于「发送前模型可用性校验」，过滤它会导致正在使用其它模型的会话发不出消息。本插件只影响列表显示，已选模型照常可发。

## 配套插件

- [`dsh-deepseek-model-round-robin`](https://github.com/poweriverHN/dsh-deepseek-model-round-robin) —— 每轮对话后自动切到白名单里的下一个模型，避免单个渠道被薅干。两个插件读同一份白名单，可以单独用，也可以一起用。

## License

MIT