# [Q1][Milestone] Step 4: Vite→dist 配布経路一本化

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 4
- 目的（Why）: ビルド経路の二重管理を解消し、Pages公開の再現性を上げる。
- 成果物（What）: Vite成果物（dist/）をPages配布物とする標準手順。
- 非目標（Out of scope）: 新規機能開発。

## 受け入れ基準（DoD）
- [ ] 本番配布手順が1系統に統一されている
- [ ] Pages公開物（dist/）でローカル同等の主要機能が動作
- [ ] base path / asset path の検証記録がある

## スコープ
### In Scope
- build/publish 手順の整理
- dist成果物の検証
- 関連ドキュメント更新

### Out of Scope
- 最適化機能改修
- AIパイプライン実装

## 依存関係
- 先行Issue: Step 2
- 外部依存: GitHub Pages設定

## 週次タスク分解（リンク）
- Week 1: 統一フロー設計
- Week 2: 実行手順整備
- Week 3: Pages実機検証
- Week 4: 手順確定と周知

## 計測/KPI
- Build Success Rate
- Deploy Success Rate
- Runtime Error件数

## リスクと対策
- リスク: WASM/静的アセットの参照崩れ
- 早期検知シグナル: Pagesでのみ読み込み失敗
- 対策: 本番URLでのスモークテストを固定化

## 完了報告
- 実績サマリ:
- KPI結果:
- 次Stepへの引き継ぎ:
