# Judge 校准 v3 — 15 条校准答案（好/中/差各 5 条）

## 设计原则
- 从 10 条 gold case 中选 5 条，每条构造 3 种质量的答案
- 好答案（author_score 4-5）：基于真实 agent 跑分结果
- 中等答案（author_score 3）：部分正确但有遗漏
- 差答案（author_score 1-2）：错误路径或完全偏题

## 校准答案列表

见同目录下 answers.jsonl（每行一条，含 case_id / answer_quality / author_score / agent_response / task_summary / expected）
