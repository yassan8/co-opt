# co-opt 方針ドキュメント（特許レンズレビュー向け）

更新日: 2026-02-12
対象期間: 2026 Q1〜Q2（6〜12週間の実行計画を含む）

## 1. ゴール

co-opt を **特許レンズのレビュー作業**（再現・比較・評価・改善提案）で最短に回す。

- 入力: 特許の実施例データ（表・図・テキスト）
- 処理: 光学系の再現、解析、改善探索
- 出力: 比較可能な評価結果（MTF/スポット/波面/全長/コスト）

---

## 2. 確定した意思決定（設計原則）

### 2.1 State 正本の一本化（最優先）

- 正本は「光学モデルの外部 Store / サービス」に限定する。
- React は「派生データ（要約・表示状態）」のみ購読する。
- React の deep nested state に光学データ本体を持たない。
- localStorage への直接書き込みは単一 Gateway に集約する。

狙い:
- スライダー操作時の不要コピーを抑制
- 再計算トリガーを制御しやすくする
- UI/計算エンジンの責務分離を維持する

### 2.2 ビルド経路は Vite 一本化（GitHub Pages 前提）

- 本番配布は「Vite の成果物（dist/）を GitHub Pages にデプロイ」を標準とする。
- 独自クローラ方式は本番経路から段階的に外す（保守コスト削減）。
- WASM / 静的アセット解決は Vite の規約に合わせる。

狙い:
- 複雑化に伴う依存解決の破綻リスクを抑える
- プラグインエコシステム（WASM含む）を活用しやすくする

### 2.3 品質方針

- 方針: **精度と速度を両立**（どちらも妥協しない）
- ただし実行順序は「測定可能化 → 改善」の順で進める

---

## 3. 6〜12週間の実行順序

## Step 1: State Ownership Contract を固定

- Canonical model / UI projection / persistence gateway の境界を文書化
- window 経由の mutate は互換 API に限定
- 既存の複数経路読み書きを段階的に一本化

完了条件:
- 状態遷移図が1系統になる
- 同一入力で同一評価結果（決定性）が取れる

## Step 2: ベンチセット（基準ケース）整備

- 特許由来の基準系を複数ケース化
- 比較指標を固定: MTF, スポット, 波面, 全長, 材料コスト, 実行時間
- 回帰判定に使う JSON + 計測スクリプトを定義

完了条件:
- 変更前後の比較が定量化できる
- 「速くなった/精度が上がった」を数値で示せる

## Step 3: React 移行（レビュー導線のみ）

- 対象を「入力→比較→評価→共有」に限定
- 旧 DOM 実装はアダプタ化し、置換単位を小さく切る
- マウントイベントや初期化順序の競合を解消

完了条件:
- レビュー導線で UI 側の責務が明確
- 同じ操作で再描画/再計算の挙動が安定

## Step 4: Pages 配布の一本化

- Vite build（dist/）を Pages 配布物にする正式フローを確立
- CI/手動手順どちらでも再現可能にする
- base path と asset path の整合を確認

完了条件:
- Pages 公開物（dist/）でローカルと同等動作
- ビルド失敗要因が単一化される

## Step 5: WASM 安定化（RL前提基盤）

- 初期化失敗時のフォールバック戦略を統一
- 重い解析（ray tracing/PSFなど）のホットパスを優先
- 実行時間分散を縮小

完了条件:
- 同一ケースの所要時間ブレが許容範囲内
- 本番公開時の WASM ロード失敗を抑制

---

## 4. Step 7: 特許データ・インジェストのAI化

目的:
- 特許の実施例データから co-opt 形式 JSON を高速生成し、初期再現の工数を削減する。

### Step 7a: OCR + LLM 変換パイプライン（MVP）

- 入力: 実施例の表（画像/テキスト）
- 出力: まず optical system rows を生成
- 適用: 既存の適用ツールで取り込み
- 検証: derive → validate → expand を必須ゲート化

受け入れ基準（確定）:
- `fatal = 0`（必須）
- warning は人手修正を前提に許容

### Step 7b: block-schema への整形と修正支援

- warning 内容を UI で可視化
- AI が修正案を提案、ユーザーが採否を選択
- 修正後に再検証（fatal=0 維持）

### Step 7 評価（Step 2 ベンチ連携）

計測項目:
- 復元成功率
- fatal/warning 件数
- 人手修正時間
- 最終評価一致度（MTF/スポット/波面）

運用方針（確定）:
- 外部LLM/OCR送信は許可（利便性優先）
- 機密性の高い案件は、別途ローカル処理モードを将来検討

---

## 5. Step 8: AI Assisted Optimization（段階導入）

目的:
- 特許性能を維持しつつ、全長短縮・材料コスト低減を自動探索する。

### Step 8a: RL前の実用基盤（先行）

- 既存 optimizer を並列評価しやすい構造へ拡張
- WASM で評価ループを安定・高速化
- 多目的評価（性能維持 + 長さ + コスト）を統一スコア化

### Step 8b: RL（PPO等）導入（後行）

- PPO直行は避け、8a の再現性・速度閾値達成後に導入
- 学習に使う状態/行動/報酬を固定してから試作

受け入れ基準:
- 基準性能を維持（しきい値内）
- 全長またはコストで統計的に改善
- 実行時間が運用可能範囲内

---

## 6. 主要な落とし穴（短期で失速しやすい点）

1. 光学モデルとUI状態の二重管理
2. localStorage 直書きの散在
3. window グローバル経由 mutate の増殖
4. ビルド経路の二重化（Vite と独自クローラ併存）
5. WASM パス解決の環境差異（Pages配下）
6. RLを先に始めて評価ループの遅さで詰まる

---

## 7. 進捗レビュー用 KPI（週次）

- Determinism: 同一入力時の評価差分
- Accuracy: ベンチ基準との差（MTF/スポット/波面）
- Speed: ケース別平均実行時間とp95
- Ingest Quality: fatal/warning と修正時間
- Optimization Gain: 全長短縮率 / 材料コスト低減率

---

## 8. 当面の実行チェックリスト

- [ ] Step 1 の State Ownership Contract 文書を作成
- [ ] Step 2 ベンチケースを固定（3〜5ケース）
- [ ] Step 4 配布フローを Vite 一本に決定
- [ ] Step 7a MVP の I/O 仕様を定義
- [ ] Step 7 評価指標をベンチに追加
- [ ] Step 8a の並列評価設計を決定

---

## 9. 補足

この文書は「方針（Why/What）」を固定するための上位ドキュメント。
実装タスク（How）は、別途 issue / milestone に分解して管理する。

### Q1 Issue テンプレート

- `.github/ISSUE_TEMPLATE/q1-milestone-epic.md`
- `.github/ISSUE_TEMPLATE/q1-weekly-task.md`
- `.github/ISSUE_TEMPLATE/q1-risk-blocker.md`

### Q1 Issue 下書き

- `.github/ISSUE_DRAFTS/q1-roadmap/README.md`

### Step 1 ドキュメント

- `documentation/STATE_OWNERSHIP_CONTRACT.md`
- `documentation/STATE_INVENTORY_2026Q1.md`