# [Q1][Milestone] Step 1: State Ownership Contract 固定

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 1
- 目的（Why）: 光学モデルとUI状態の二重管理を解消し、決定性と性能を確保する。
- 成果物（What）: State Ownership Contract 文書、境界定義、移行ガイド。
- 非目標（Out of scope）: 全UIの全面React化、最適化アルゴリズム改修。

参照:
- documentation/STATE_OWNERSHIP_CONTRACT.md
- documentation/STATE_INVENTORY_2026Q1.md
- documentation/STATE_INVENTORY_REPORT.md

## 受け入れ基準（DoD）
- [ ] Canonical model / UI projection / persistence gateway の責務が文書化されている
- [ ] localStorage 直書きの新規追加を禁止するルールが明記されている
- [ ] 同一入力で評価結果が一致することを確認できる

## スコープ
### In Scope
- 状態遷移図の作成
- 書き込み経路の棚卸し
- 移行優先度の定義

### Out of Scope
- Pages配布フロー変更
- WASM高速化実装

## 依存関係
- 先行Issue: なし
- 外部依存: なし

## 週次タスク分解（リンク）
- Week 1: 現状の状態保持経路の可視化（成果物: localStorage/window棚卸し表 + 状態図）
- Week 2: Contract草案とレビュー
- Week 3: gateway経路への集約方針（localStorage）→ window Facade/Service 境界の固定
- Week 4: 決定性チェック実施

## 計測/KPI
- Determinism: 同一入力時の差分 0
- Stability: 再計算失敗率
- Speed: UI操作時のp95応答時間

## リスクと対策
- リスク: 既存window APIとの互換崩れ
- 早期検知シグナル: 既存操作で未反映や二重反映が発生
- 対策: 互換Facadeを維持し内部書き込みのみ差し替え

## 完了報告
- 実績サマリ:
- KPI結果:
- 次Stepへの引き継ぎ:

## Week 1 実行メモ

- 自動棚卸し: `npm run state:inventory`
- 生成物:
	- `documentation/STATE_INVENTORY_REPORT.md`
	- `documentation/STATE_INVENTORY_REPORT.json`
- 人手でowner確定: `documentation/STATE_INVENTORY_2026Q1.md`

## 直近の進捗メモ（2026-02-12）

- localStorage主要キーは inventory 上で `files=1` まで縮退（Gatewayへ集約）
- 次フェーズ: window.* 公開APIの owner を固定するため、Facade/Service 境界を設計して段階的に集約
