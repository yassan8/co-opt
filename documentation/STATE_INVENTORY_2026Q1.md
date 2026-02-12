# State Inventory (co-opt) — 2026 Q1

更新日: 2026-02-12（Step 2 window mutable global 縮退完了を反映）
目的: Step 1（State Ownership Contract）の Week 1 成果物として、状態の所在と書き込み経路を棚卸しする。

> 注: ここでは「現状」を記録する。改善（移行）は別Issueで行う。

---

## 1. localStorage キー棚卸し（主要）

| key | 目的/意味 | 現状の所有者（推定） | 書き込み元（例） | 課題 | 移行方針（案） |
|---|---|---|---|---|---|
| systemConfigurations | config全体 + activeConfig | Canonical（Config正本） | data/table-configuration.ts（+ テスト/スモーク用途: scripts/smoke-apply-optical-system-rows.mjs） | 正本はまだ localStorage 直結（将来Store化） | 目標: Storeが正本、Gatewayが永続化（他はStore API経由） |
| sourceTableData | Source table（UI投影 + 永続化） | Projection cache（集約済み） | data/table-configuration.ts | UIと永続化が混線しやすい（ただし直アクセスは縮退済み） | 目標: Storeが正本、Gatewayが永続化、UIは投影のみ |
| objectTableData | Object table（UI投影 + 永続化） | Projection cache（集約済み） | data/table-configuration.ts | UIと永続化が混線しやすい（ただし直アクセスは縮退済み） | 目標: Storeが正本、Gatewayが永続化、UIは投影のみ |
| OpticalSystemTableData | legacy surface rows（Expanded rows） | Derived cache（互換/投影） | data/table-configuration.ts | Blocks正本時にドリフト源になりうる（現状はBlocks優先で抑制） | 目標: Derived cache（互換のみ）。正本はBlocks/Store。 |
| meritFunctionData | merit function（グローバル） | Projection cache（集約済み） | data/table-configuration.ts | editor直書きが起点になりやすい（ただし直アクセスは縮退済み） | 目標: Storeが正本、Gatewayが永続化 |
| systemRequirementsData | system requirements（グローバル） | Projection cache（集約済み） | data/table-configuration.ts | 評価/最適化入力がぶれやすい（ただし直アクセスは縮退済み） | 目標: Storeが正本、Gatewayが永続化 |
| systemData | referenceFLなど（config付随） | Projection cache（集約済み） | data/table-configuration.ts（gateway: load/save*Projection） | UI入力と永続化が混線しやすい（ただし直アクセスは縮退済み） | 目標: Storeが正本、Gatewayが永続化 |
| spotDiagramSettingsByConfigId | 要件スポット設定（config別） | UI settings（集約済み） | ui/spot-diagram-settings-storage.ts | UI/Eval付随状態（Store正本とは別） | 目標: UI Settings Gateway（またはStore内のUI設定領域） |
| spotDiagramPattern | スポットのレイ発生パターン | UI settings（集約済み） | ui/spot-diagram-settings-storage.ts | window状態とも二重化しやすい（現在はgatewayで吸収） | 目標: UI Settings Gateway（またはStore内のUI設定領域） |
| loadedFileName | ロード中のファイル名表示 | UI状態（集約済み） | ui/loaded-file-storage.ts | storeと無関係だが散在しやすい（現在はgateway化済み） | 目標: UIのみ（必要ならUI settingsへ） |
| loadedFileWarn | ロード警告フラグ表示 | UI状態（集約済み） | ui/loaded-file-storage.ts | 表示状態がlocalStorage依存（現在はgateway化済み） | 目標: UIのみ（必要ならUI settingsへ） |
| toolbarCollapsed | ツールバー折りたたみ | UI状態（集約済み） | ui/toolbar-collapsed-storage.ts | UI状態が複数実装から触られる（現在はgateway化済み） | 目標: React UIの責務に寄せる（localStorageはUI settings経由） |
| lastWavefrontSnapshot | Wavefront/OPDの直近スナップショット | UI/Eval補助（集約済み） | evaluation/wavefront/wavefront-snapshot-storage.ts | AI Context がlocalStorage fallback を参照（現状はgateway経由） | 目標: UI settings か Diagnostics store へ分離（必要なら） |

---

## 2. window グローバル棚卸し（代表例）

分類ルール（暫定）:
- Facade(Read-only): 互換のために公開。内部状態の mutate なし。
- Legacy Write: 旧UI/旧設計が mutate 可能（縮小対象）。
- Debug/Tool: 診断/ベンチ/補助。

| window property | 用途 | 分類（暫定） | 主な定義元 | 課題 | 移行方針（案） |
|---|---|---|---|---|---|
| getOpticalSystemRows | 評価入力の取得 | Facade(Read-only) | main.ts → utils/data-utils.ts | 多重取得経路 | Store snapshot専用に寄せる |
| tableOpticalSystem/tableSource/tableObject | UIテーブル参照 | Legacy Write | main.ts, data/table-*.ts | 正本混線 | 投影先として扱い、書き込みはPatch化 |
| loadSystemConfigurations/saveSystemConfigurations | config I/O | Legacy Write | main.ts → data/table-configuration.ts | localStorage直 | Gatewayへ集約 |
| scene/camera/renderer/controls | 3D/描画参照 | Debug/Tool | main.ts | 依存肥大 | UI層から参照削減 |

### 2.1 Top window assignments（Week 1 優先分類）

| window property | 主用途 | 分類 | 目標owner | コメント |
|---|---|---|---|---|
| __cooptScenarioOverride / __cooptBlocksOverride | 最適化・検証用の一時上書き | Debug/Tool | Store（debug overlay） | 本番ロジックの入力をこれに依存させない |
| getPrimaryWavelength | 評価/描画の入力（主波長） | Facade(Read-only) | Store snapshot | 現状はテーブル参照に寄りがち。Store側に寄せる |
| refreshBlockInspector / updateSurfaceNumberSelect | UI更新トリガ | Legacy Write | UI projection | 正本からUIへ通知する形に移行 |
| getObjectRows / getSourceRows / getOpticalSystemRows | 評価入力 | Facade(Read-only) | Store snapshot | 「評価はStoreスナップショットのみ」を徹底 |
| getWASMSystem / ForceWASMSystem / _setWASMSystem | WASM初期化/取得 | Debug/Tool → Service | WASM service | Step 5の対象。UIから直接触らない方向へ |
| camera / controls / scene / renderer | 3D参照 | Debug/Tool | Rendering service | UIが直接参照しない方向へ |

#### 2.2 inventoryベースライン（2026-02-12 最新）

`documentation/STATE_INVENTORY_REPORT.md` の最新結果では、
Top `window.* assignments` は **空**（該当行なし）。

これにより、Step 2 の「Legacy Write の段階的縮退（dot-assignment在庫の圧縮）」は完了。
owner の一意化（Step 1）に加え、可視在庫の観点でも目標達成。

この時点での実務分類（初期確定）は以下:

- Facade(Read-only)
  - `get*Rows`, `getPrimaryWavelength` などの取得API
  - `__cooptSetRenderingContext` など、最終的に service/store の公開口として残すもの
- Legacy Write（縮退対象）
  - `tableOpticalSystem/tableObject/tableSource`
  - `__popupPsfCalculator`, `__lastResize*` など UI 相互接続のための mutable 値
- Debug/Tool
  - `__DEBUG_*`, `__coopt*Debug*`, `__EVA_*`, `__GEN_*`, `_sphericalAberDebugCount`

注: Step 2 では Legacy Write をイベント/サービスAPIに置換し、Facade と Debug の境界をさらに固定する。

---

## 3. 初期化イベント棚卸し

- `coopt:react-mounted`
  - dispatch が複数箇所（src/main.tsx / src/app/App.tsx など）
  - listen が複数箇所（main.ts, ui/*, data/table-* など）

課題:
- 重複dispatch
- 初期化が複数回走る可能性
- レース対策がモジュールごとに実装され、全体として読みにくい

移行方針（案）:
- 単一の barrier（例: `coopt:app-ready`）へ統一
- 「readyの判定条件」をStore/サービスに寄せ、UIはそれを待つ

---

## 4. 次アクション（Week 1）

- [x] `docs/` や `dist/` のコピー群を棚卸し対象から除外して集計（ソースのみ）
- [x] localStorage 直書き箇所に owner を付与（Store/UI/Gateway/Legacy）
- [x] window API を分類して一覧化（Facade/LegacyWrite/Debug）
- [x] Step 1 契約文書に反映（必要なら更新）

---

## 5. 自動棚卸し（補助）

Week 1 の棚卸しを機械的に回すためのスクリプト。

- 実行: `node tools/state-inventory.mjs`
- 出力:
  - `documentation/STATE_INVENTORY_REPORT.md`
  - `documentation/STATE_INVENTORY_REPORT.json`

このレポートは正規表現ベースの近似集計のため、所有者の最終判断は人手で行う。

### 5.1 Week 1 の運用（おすすめ手順）

1. `npm run state:inventory` を実行
2. `documentation/STATE_INVENTORY_REPORT.md` の Top keys から優先度順に owner を確定
3. 「正本(Store)に寄せるキー」と「UI設定として残すキー」を分離
4. 以降の改修PRで localStorage 直書きを減らし、Gateway/Store API に集約
