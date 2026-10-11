# 跨端能力规范

`capabilities.json` 是客户端跟进任务的输入，**不是已实现能力清单**。
初始目录有 8 组能力、40 个目标组合，全部需要独立核验；尤其不能把现有
Swift package 测试通过当作 macOS 完整应用完成。

每次在 base 修改行为时，同一 PR 更新规范：

1. 保持 `id` 稳定；任何语义、参考文件、目标平台或验收条件变更都增加 `revision`。
2. `references` 必须是仓库内存在的源文件，禁止绝对路径和目录跳转。
3. `acceptance` 写可观察的行为、失败与恢复条件；测试实现和证据由跟进 PR 提供。
4. 合入 main 后，启用的协调器按 `(id, revision, platform)` 去重。仅 main
   提交变化不会重建任务；规范版本增加会 supersede 旧的未完成任务。
5. 不删除历史能力来消除欠账；能力退役需先设计明确的兼容与退役状态。

服务端协议/API/数据库兼容规则继续由 `app/contracts/`、Rust 核心和迁移链维护。
此目录不替代 API 契约、历史迁移归档或各平台测试报告。

本地校验：

```powershell
python -m automation validate
python -m automation plan --source-sha <40位提交SHA>
```

输出任务是待处理项，不是让 Codex直接执行的 shell 命令。
