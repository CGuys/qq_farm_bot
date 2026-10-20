# Claude 交接：从 Codex 会话 `01a085af-b657-7732-9eac-7f41a93fb5c1` 接续

> 给下一个 Claude 会话用。先完整读 `docs/HANDOFF.md`，再读本文件。读完前不要改代码。
> 本文件只是会话摘要，**回归约束以 HANDOFF 为准**。

## 仓库与环境

- 仓库：`qq-farm-bot`（远程 `origin/main`，当时 HEAD `0a7293a`，工作树干净）
- 面板：`:3007`
- 启动：只在已有 tmux `farm:0.0` 里 `bash start.sh`；禁止另开 tmux / `nohup`
- 测试：`cd core && node --test test/*.test.js`
- 改完必须重启 bot；杀进程用 `bash stop.sh`，不要 `pkill -f`

## 这条 Codex 会话在做什么

用户从 2026-09-09 起让 Codex 修两类问题，后面扩成活动识别 + 自进化：

1. **应用更新后 tmux 选错**，卡在重启。正确做法是找进程所在 pane，不是乱找 tmux。
2. **微信保活**：进程一直跑可以保持登录；用户希望终端退出后再启动也不要扫码。
3. 后续：活动种子显示裸 ID、活动/好友图标缺失、背包优先识别漏种子、偷菜时间未进门不准、施肥误触发、自进化 Agent 巡检不够、README 复现。

## 已经落地（不要重做）

近期相关提交（从新到旧）：

- `0a7293a` 授权失效时停止旧会话保活
- `9b10fef` 阻止授权失效时使用旧 Code 启动
- `504168f` 阻止微信授权失效后的重复接管
- `37dbb8d` 完善活动与安全 Agent 每日巡检闭环
- `425b978` 补齐萌宠元气糕活动图标
- `702c3bd` 收口成熟与施肥误触发并移除私人图片
- `f6a8dc0` 补齐活动好友图片并隔离施肥误触发
- `2b82b82` 修正芦苇、狗尾草、泡泡棉花糖种子识别

关键结论：

- 土地 / 好友土地：`plant.id` 可能是植物 ID 或种子 ID。
- 活动作物名称优先服务端回包，避免 `植物<ID>`。
- 种子纠错：`20516`=狗尾草种子；`25995`=芦苇种子；`29004`=泡泡棉花糖种子（2×2）；萌宠元气糕=`1028`。
- 好友摘要缺 `ripe_time_sec` 时，不得覆盖地块 `phases` 已读到的成熟墙钟。
- 施肥 HOT 与自然成熟 PREARM 必须分开；成熟/抢收阶段切换不得误触发施肥。
- README 私人微信图已删；复现走真实 git 地址 + `corepack` + `pnpm install --frozen-lockfile` + `bash start.sh`。
- 登录：本地持久化 refresh token；重启先续期再换短 Code。`40188 / invalid scope / 微信授权范围已失效` 必须立刻阻断，禁止用旧 Code 启动或每 5/30/40 分钟空转重试。只有重新扫码成功才恢复。

## 登录问题的边界（Claude 不要越界）

用户后来追问“扫码一次永远不用再扫”“自动扫码组件”“永久微信权限”。

Codex 已说明：

- 终端退出后免扫码 = 保存并滚动 refresh token（已实现）。
- `invalid scope` = 微信服务端撤销授权，没有安全的“直接续授权”接口。
- 顶号是游戏会话层；立刻 refresh 不能保证不被再踢，还可能滚丢 token。
- **不要做** Cookie 窃取、伪造设备、拦截授权、第三方永久 Token、自动模拟扫码接入生产账号。

若用户再问“永久免扫码”，只解释 OAuth 生命周期，不提供绕过步骤。

## 自进化 Agent 已写入的硬门

活动 Agent 应每天查：

- 图标：活动商品/奖励/货币/种子/果实/礼包；活动页、背包、自己土地、好友土地四条图链
- 种子图与 1–6 阶段图分开验证
- 新玩法只读识别；新种子/物品用 `ItemInfo / Plant / Bag / Lands` 交叉核对
- 按 List / `end_time` 下架旧活动
- 保护收菜、种菜、偷菜、施肥 HOT/PREARM

安全 Agent 应先检索近 24h：`bot.log`、`core/data/logs/combined-*.log`、`error-*.log`；日志异常必须回到代码和阈值，不能凭文风盲改。

外部资料只能脱敏、只读、按需；禁止复制 RPC/登录/设备/TSDK/ACE。

## 用户硬约束（摘要）

完整列表在 `docs/HANDOFF.md`。最容易复发的：

- 不要恢复普通好友全量高频 Enter / 整号熔断
- 缺 `ripe_time_sec` ≠ 无成熟
- 不要把植物 ID 当种子 ID
- 不为未知活动猜写操作或猜 RPC
- 改代码必须同步 HANDOFF、测通、隐私扫描后推送
- 自动进化允许零改动

## 建议 Claude 接着做

1. 读完 HANDOFF 全文，核对当前代码是否与上述提交一致。
2. 看近 24h 日志：是否还有裸种子 ID、空图标、`invalid scope` 空转、施肥误触发。
3. 若活动页仍有空图（例如只有名称+ID、`image=""`），只用官方资源或已记录的通用回退，不要伪造 URL。
4. 不要重开“永久免扫码”实现；登录只维护现有 refresh + 失效阻断。

## Codex 原始记忆在哪（下次自己抽）

这条会话没有独立 `memories/` 文件。记忆分散在：

| 位置 | 内容 |
|---|---|
| `docs/HANDOFF.md` | 项目长期记忆（最重要） |
| `~/.codex/sessions/2026/09/09/rollout-2026-09-09T10-21-20-01a085af-b657-7732-9eac-7f41a93fb5c1.jsonl` | 完整 rollout（约 33MB，含工具输出） |
| 上述 jsonl 里 `type=compacted` | Codex 自己压过的两份进度摘要（09-11 05:37、13:26） |
| `~/.codex/history.jsonl` | 仅用户输入一行一条 |

抽取用户/助手正文可用：

```bash
python3 -c "
import json
p='~/.codex/sessions/2026/09/09/rollout-2026-09-09T10-21-20-01a085af-b657-7732-9eac-7f41a93fb5c1.jsonl'
p=__import__('os').path.expanduser(p)
for line in open(p, encoding='utf-8'):
    o=json.loads(line)
    pl=o.get('payload') or {}
    if o.get('type')=='event_msg' and pl.get('type')=='item_completed':
        it=(pl.get('item') or {}).get('type')
        if it in ('UserMessage','AgentMessage'):
            print(it, o.get('timestamp'))
"
```
