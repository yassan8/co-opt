# State Ownership Contract (co-opt)

更新日: 2026-02-12（Step 2 window mutable global 縮退完了反映）

## 0. 目的

co-opt の状態管理を **「正本（source of truth）」が1つ**になるように定義し、UI移行（React）・精度/速度改善・AIインジェスト/最適化を進めても破綻しない土台を作る。

この文書は Step 1 の成果物（方針を固定する契約）であり、実装の詳細は別Issueで管理する。

---

## 1. 用語

- Canonical Model（正本）: 光学系の意味論（ブロック/設定/派生）を持つ唯一のモデル。
- Projection（投影）: UI（Tabulator/React）に表示するための派生データ。
- Persistence Gateway: localStorage/URL/ファイル入出力を一元化する層。
- Adapter/Facade: `window.*` 互換API。外部からの読み取りは許容するが、内部状態の mutate を禁止する方向へ。

---

## 2. 現状（重要な観測）

### 2.1 Optical System Rows の取得経路が多重化

[utils/data-utils.ts](../utils/data-utils.ts) の `getOpticalSystemRows()` は以下の順で複数の「候補」を読み得る:

1. `globalThis.__cooptOpticalSystemRowsOverride`（最適化などの一時上書き）
2. Blocks展開（Design Intent）を優先（`__du_expandActiveBlocksToRows()`）
3. 渡された `tableOpticalSystem.getData()`
4. `window.tableOpticalSystem.getData()`
5. `window.opticalSystemTabulator.getData()`
6. DOM要素 `#table-optical-system`.tabulator.getData()
7. localStorage `OpticalSystemTableData`
8. dummy

この構造は「評価/最適化/要件」などの入力が **いつどれに依存しているか**を曖昧にしやすい。

### 2.2 Configuration が localStorage と UI の双方を直接触る

[data/table-configuration.ts](../data/table-configuration.ts) の `saveCurrentToActiveConfiguration()` は、
- Tabulatorから読み取る
- `activeConfig` に書く
- localStorageにも直接書く

を同一関数内で行う（例: `sourceTableData`, `systemData`）。

これにより、
- UI投影の状態
- 正本（config）
- 永続化

が混線する。

### 2.3 window グローバルが状態APIとして肥大化

[main.ts](../main.ts) は多数の関数・テーブル参照・レンダラ参照を `window.*` に公開している。
互換性維持のためのFacadeとしては有用だが、正本が散らばる温床になりうる。

### 2.4 React mount の同期イベントが重複

`coopt:react-mounted` は複数箇所から dispatch され、複数箇所で listen される。
初期化順序のレースと「一度の操作で複数初期化」が起こりやすい。

---

## 3. 目標アーキテクチャ（契約）

### 3.1 正本（Canonical Model）

- 正本は **1つの Store / Service** に置く。
- 正本が保持するのは次を含む（例）:
  - systemConfigurations（active config含む）
  - active config の blocks / systemData / metadata
  - 派生の expanded rows は「キャッシュ」扱い（再計算可能）

### 3.2 UI（React/Tabulator）の責務

- React state は「UI状態（選択・開閉・表示モード・一時入力）」のみ。
- Tabulatorは「投影先」であり、Tabulatorのセル編集は **StoreへのPatch** として扱う。
- UIは localStorage を直接読まない/書かない。

### 3.3 Persistence Gateway

- localStorage/URL/ファイルI/Oは **Gatewayだけ**が触る。
- モジュール内で `localStorage.setItem/getItem/removeItem` を直接呼ばない。

### 3.4 window Facade

- `window.*` は外部/旧UI互換のFacade。
- 新規実装は window に依存せず Store API を使う。
- window 経由で state を mutate する新規追加は禁止。

---

## 4. 不変条件（破ってはいけないルール）

1. **正本は1つ**（同じ意味のデータを複数場所に保持しない）
2. UI state と光学モデルを混ぜない（React deep object禁止）
3. 永続化はGateway経由のみ
4. 評価/最適化の入力は「Storeが返すスナップショット」のみ
5. イベントは単発の ready/barrier を持ち、重複dispatchしない

---

## 5. キー/状態インベントリ（暫定）

### 5.1 localStorage（主要キー）

この節は「契約上のキー」を列挙する。実装上は **Gatewayに集約**し、各モジュールからの直アクセスを禁止する。

- `systemConfigurations` : Configuration全体（Canonical候補）
  - Gateway: [data/table-configuration.ts](../data/table-configuration.ts)
- `sourceTableData` / `objectTableData` / `OpticalSystemTableData` : UI投影（互換用の派生キャッシュ）
  - Gateway: [data/table-configuration.ts](../data/table-configuration.ts)
- `meritFunctionData` / `systemRequirementsData` : グローバル表（互換用の派生キャッシュ）
  - Gateway: [data/table-configuration.ts](../data/table-configuration.ts)
- `systemData` : reference focal length など（互換用の投影）
  - Gateway: [data/table-configuration.ts](../data/table-configuration.ts)（`load/save*Projection`）
- `spotDiagramPattern` / `spotDiagramSettingsByConfigId` : 要件スポットのUI設定
  - Gateway: [ui/spot-diagram-settings-storage.ts](../ui/spot-diagram-settings-storage.ts)
- `loadedFileName` / `loadedFileWarn` : UI表示（ロードしたファイル名）
  - Gateway: [ui/loaded-file-storage.ts](../ui/loaded-file-storage.ts)
- `toolbarCollapsed` : UI表示（ツールバー開閉）
  - Gateway: [ui/toolbar-collapsed-storage.ts](../ui/toolbar-collapsed-storage.ts)
- `lastWavefrontSnapshot` : Wavefront/OPDの直近スナップショット（AI Context fallback含む）
  - Gateway: [evaluation/wavefront/wavefront-snapshot-storage.ts](../evaluation/wavefront/wavefront-snapshot-storage.ts)

### 5.2 window（代表例）

- `window.getOpticalSystemRows` などのデータ取得
- `window.tableOpticalSystem/tableObject/tableSource` などのテーブル参照
- `window.scene/camera/renderer/controls` などレンダラ参照

### 5.3 window分類（2026-02-12 初期確定）

- Facade(Read-only)
  - `get*Rows`, `getPrimaryWavelength` などの取得API
  - service/store の公開口として残す `window` 互換関数
- Legacy Write（縮退対象）
  - `tableOpticalSystem/tableObject/tableSource`
  - `__popupPsfCalculator`, `__lastResize*` などUI相互接続の mutable 値
- Debug/Tool
  - `__DEBUG_*`, `__coopt*Debug*`, `__EVA_*`, `__GEN_*`, `_sphericalAberDebugCount`

補足: 最新 inventory では top `window.*` 代入は **空**（該当行なし）。
owner の一意化に加え、可視在庫の観点でも縮退完了。

---

## 6. 移行の最初の一手（Week 1 の成果物）

### 6.1 可視化（棚卸し）

- localStorageの読み書き箇所を列挙し、所有者（Store/UI/Gateway/Legacy）を割り当てる。
- window公開APIを「Facade（read-only）/Legacy write / Debug」分類する。

進捗（2026-02-12 時点）:
- localStorage 直アクセスは inventory 上で **0 件**（`ops/opFiles/keys/keyFiles` が空）
- localStorage は Gateway 経由に統一済み（UI/評価/設定/互換経路を含む）
- window.* assignments 在庫は top テーブルで **0 件**（縮退完了）
- 継続タスクは Facade/Debug の整理と、Store/API owner への文書固定

### 6.3 運用ガード（再発防止）

- 変更後は必ず `npm run state:inventory` を実行し、
  [STATE_INVENTORY_REPORT.md](./STATE_INVENTORY_REPORT.md) の `localStorage usage` が空であることを確認する。
- 新規コードで `localStorage.getItem/setItem/removeItem/clear` の直呼びを追加しない。
- 永続化追加は Gateway モジュール（`utils/local-storage-gateway.ts` または責務別 storage module）に限定する。

### 6.2 ルール凍結（Freeze）

- 新規の localStorage キー追加を停止。
- 新規の window state mutate API 追加を停止。
- 評価/最適化で Tabulator を直接読みに行く経路の追加を停止。

---

## 7. 付録: Mermaid（状態の大枠）

```mermaid
flowchart LR
  subgraph Canonical[Canonical Model Store]
    SC[SystemConfigurations\n(active config, blocks, metadata)]
    ER[Expanded Rows Cache\n(derived)]
  end

  subgraph UI[UI]
    RX[React UI State\n(selection, panels)]
    TB[Tabulator Tables\nprojection]
  end

  subgraph IO[Persistence Gateway]
    LS[(localStorage)]
    URL[(URL share)]
    FILE[(file import/export)]
  end

  SC -->|derive| ER
  SC -->|snapshot| UI
  UI -->|patch| SC
  IO <-->|load/save| SC
  TB <-->|projection| SC
  RX -->|subscribe summary| SC
```
