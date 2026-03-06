# co-opt-pro Tauri v2 初期セットアップ

このドキュメントは、既存Web版`co-opt`をベースに`co-opt-pro`デスクトップ版へ移行するための初期実装ガイドです。

## 1. 初期セットアップ手順

1. 依存追加（実施済み）
   - `@tauri-apps/cli`
   - `@tauri-apps/api`
   - `@tauri-apps/plugin-dialog`
2. Tauriバックエンド骨格を追加（実施済み）
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/src/main.rs`
   - `src-tauri/src/lib.rs`
3. コマンド分割（実施済み）
   - `src-tauri/src/commands/optics.rs`
   - `src-tauri/src/commands/io.rs`
   - `src-tauri/src/commands/ai.rs`
4. フロント側IPC境界を追加（実施済み）
   - `src/shared/contracts/*`（DTO定義）
   - `src/desktop/ipc/client.ts`（`invoke`の型付きラッパー）
   - `src/desktop/adapters/file.ts`（ネイティブダイアログ）
5. 開発起動
   - Web: `npm run dev`
   - Desktop: `npm run dev:desktop`

## 2. 推奨ディレクトリ構成

```text
co-opt-pro/
  src/                         # 既存Web UI資産（再利用）
    desktop/
      ipc/client.ts            # Tauri invoke 境界
      adapters/file.ts         # ネイティブファイルダイアログ
    shared/contracts/          # TS-Rust 共有DTO
      optics.ts
      io-ai.ts
  src-tauri/
    src/
      lib.rs                   # invoke handler登録
      main.rs                  # Tauriエントリ
      commands/
        optics.rs              # 光学計算コマンド
        io.rs                  # ローカルI/Oコマンド
        ai.rs                  # AIバックエンドコマンド
    tauri.conf.json
```

## 3. invoke 実装例（雛形）

### TypeScript (`src/desktop/ipc/client.ts`)

```ts
import { invoke } from "@tauri-apps/api/core";

export async function opticsEcho(payload: { jobId: string; payload: number[] }) {
  return invoke<{ jobId: string; count: number; payloadSum: number }>("optics_echo", { req: payload });
}
```

### Rust (`src-tauri/src/commands/optics.rs`)

```rust
#[tauri::command]
pub fn optics_echo(req: OpticsEchoRequest) -> Result<OpticsEchoResponse, String> {
    let payload_sum = req.payload.iter().copied().sum::<f64>();
    Ok(OpticsEchoResponse {
        job_id: req.job_id,
        count: req.payload.len(),
        payload_sum,
    })
}
```

## 4. アーキテクチャ方針（フロント/バックエンド分離）

- UI/状態管理は既存TypeScriptを再利用
- 高負荷計算（ray tracing / optimizer / wavefront）はRust `commands::optics`へ段階移植
- ファイル操作は`plugin-dialog` + Rust I/O commandでローカル直読み書き
- AI API呼び出しはRust `commands::ai`に集約し、フロントからAPIキーを排除
- フロントは`src/desktop/ipc/client.ts`のみを通じてバックエンド呼び出し

## 5. JS→Rust移植時の型変換/シリアライズ注意点

1. **浮動小数精度**: Rustは`f64`を基本、`f32`混在禁止。
2. **`undefined`と欠損**: Rustでは`Option<T>`に対応。任意項目を明示。
3. **列挙型**: TS文字列ユニオン ⇄ Rust `enum` を`serde(rename_all="camelCase")`で一致。
4. **`NaN`/`Infinity`**: JSON非互換。送信前に`null`置換またはバリデーションエラー化。
5. **巨大配列転送**: 初期はJSON、ボトルネック化後にバイナリ転送を検討。
6. **日時**: `Date`直列化を避け、ISO8601かepoch msに統一。
7. **エラー形式**: Rust内部エラーは`code/message/details`へ正規化。
8. **契約互換性**: DTOに`schemaVersion`を持たせて段階移行時の破壊変更を回避。

## 6. 次の実装ステップ

1. `commands::ai`に実APIクライアント実装（環境変数/OS keychain連携）
2. `commands::io`にプロジェクト保存形式（`*.coopt.json`）を追加
3. 既存UI操作を`desktop/adapters`経由へ置換
4. 機能単位で計算ロジックをRustへ移行（Web版との数値差分検証付き）
