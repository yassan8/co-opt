# [Q1][Milestone] Step 8: AI Assisted Optimization（段階導入）

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 8
- 目的（Why）: 性能維持を前提に全長短縮・低コスト材置換を自動探索する。
- 成果物（What）: 8a 既存optimizer拡張 + 8b RL導入判断。
- 非目標（Out of scope）: PPO直行での本番投入。

## 受け入れ基準（DoD）
- [ ] 8a: 既存optimizerで多目的改善を確認
- [ ] 8a: 実行時間が運用可能範囲
- [ ] 8b: RL導入可否を評価結果で判断

## スコープ
### In Scope
- 8a: 並列評価・目的関数統合
- 8a: ベンチで改善率評価
- 8b: PPO試作条件の定義

### Out of Scope
- 長期学習基盤の本格運用
- GPU前提の大規模学習

## 依存関係
- 先行Issue: Step 2, Step 5, Step 7b
- 外部依存: 学習実行環境

## 週次タスク分解（リンク）
- Week 1: 8a目的関数/制約の固定
- Week 2: 並列評価実装
- Week 3: ベンチ比較
- Week 4: 8b導入判定

## 計測/KPI
- 性能維持率
- 全長短縮率
- 材料コスト低減率
- 実行時間

## リスクと対策
- リスク: 評価1回コストが高く探索が進まない
- 早期検知シグナル: 改善率が時間対比で低い
- 対策: 8aで探索効率を先に最適化し、RLは後段判断

## 完了報告
- 実績サマリ:
- KPI結果:
- 次フェーズ提案:
