# 模型质量门禁

## 自动发布门禁

`pnpm model-quality:validate` 独立运行完整的版本化回答评估 fixture suite。CI 在格式化、类型检查和通用测试之前显式执行该命令；通用 Server 测试仍会再次覆盖同一套件，避免发布流程通过过滤测试集绕过质量基线。

当前 suite 固定以下版本：

- fixture Schema：`evaluation-fixture-suite-v1`
- suite：`go-backend-answer-evaluation@1`
- purpose：`answer_evaluation`
- prompt：`prompt-structured-answer-evaluation-v1`
- output Schema：`schema-model-answer-evaluation-output-v1`

八类场景必须完整且顺序稳定：

1. 正确回答
2. 部分正确回答
3. 完全错误回答
4. 显式不知道
5. 显式跳过
6. 澄清后仍不相关
7. 歧义回答
8. Prompt Injection 风格回答

门禁验证 case ID/版本、类别完整性、题目与 Rubric、证据引用、确定性预期结果、追问状态、简体中文和不可信输入边界。显式不知道与跳过不会伪装成模型调用；其余六类使用固定模型输出验证生产适配器和领域语义。

## 人工验收模型

当前开发环境为人工验收选定的模型是 `opencode-go/deepseek-v4-flash`。自动发布门禁不读取或调用该模型，也不需要真实凭据。

当前真实调用在 provider workspace 的中国托管模型 opt-in 之前被阻止，因此尚无可复现的真实模型校准结果。此限制必须保留在发布判断中：现阶段只能确认请求构造、Schema、重试、评分聚合和安全边界，不能声称该模型已经达到稳定的语义评分质量。

完成 provider opt-in 后，人工验收必须使用上述固定 suite 和当前 prompt/Schema 版本，记录模型标识、每个 case 的原始结构化结果、修复/重试次数及人工判定。不得把人工输出提交到包含候选人内容的生产日志，也不得用一次通过替代后续模型版本升级时的重新校准。

## 已知限制

- Faux Provider 证明确定性编排和校验行为，不证明真实模型的事实正确性、中文自然度或评分一致性。
- 当前 fixture 以 `context.Context` 取消传播题为受控样本，不等价于对 90 道发布题库逐题校准。
- 固定 Rubric 只能稳定聚合已验证评分点；分类、证据选择和解释文本仍可能受模型随机性或供应商更新影响。
- 简体中文、Schema 和私有内容检查不能发现所有事实错误、含混表达或间接参考答案泄漏。
- Prompt Injection fixture 验证已知分隔与证据边界，不代表穷尽对抗输入。
- MVP 不做跨模型比较、自动故障转移、统计置信度估计或线上质量反馈学习。
