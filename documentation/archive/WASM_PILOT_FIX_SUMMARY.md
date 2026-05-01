# WASM パイロット統合 - 重大バグ修正

## 問題の発見

WASM の `optimize_system_in_wasm()` 関数が**JavaScript Map**をプレーンオブジェクトの代わりに返していました。これにより TypeScript ブリッジは期待されるすべてのフィールド（`dx`、`xNext` など）に対して `undefined` を受け取り、100% JavaScript ソルバーへのフォールバックが発生していました。

### 根本原因
[rust-wasm/src/lib.rs](rust-wasm/src/lib.rs#L2288) で以下を使用していました：
```rust
serde_wasm_bindgen::to_value(&serde_json::json!({...}))
```

`serde_wasm_bindgen::to_value()` 関数は JSON オブジェクトをプレーンオブジェクトではなく JavaScript Map に変換します。これは TypeScript ブリッジのプロパティアクセスパターン（`result.dx`、`result.xNext` など）と互換性がありません。

## 実装した解決策

### 1. Rust の変更 (rust-wasm/src/lib.rs)

戻り値の型とシリアライズを変更：

**修正前：**
```rust
pub fn optimize_system_in_wasm(payload_json: String) -> Result<JsValue, JsValue> {
    // ... 計算処理 ...
    serde_wasm_bindgen::to_value(&serde_json::json!({...}))
        .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}
```

**修正後：**
```rust
pub fn optimize_system_in_wasm(payload_json: String) -> Result<String, JsValue> {
    // ... 計算処理 ...
    Ok(serde_json::to_string(&serde_json::json!({...}))
        .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))?)
}
```

✅ 結果：WASM が Map の代わりに **JSON 文字列**を返すようになりました。

### 2. TypeScript ブリッジの変更 (rust-wasm/ts/optimization/optimizer-wasm-bridge.ts)

JSON 文字列レスポンスを解析し、文字列とオブジェクト型の両方に対応するようにブリッジを更新：

**変更内容：**
- WASM からの `string` 型を受け入れる（フォールバックオブジェクトも可能）
- JSON 文字列レスポンスを解析：`JSON.parse(raw)`
- すべてのフィールドアクセスを `raw` → `parsed` に更新
- パース失敗用エラーメッセージを改善

**主なコード：**
```typescript
let parsed: any;
try {
  if (typeof raw === 'string') {
    parsed = JSON.parse(raw);
  } else if (typeof raw === 'object') {
    parsed = raw;
  } else {
    setPilotReason('result-invalid-type', `expected string or object, got ${typeof raw}`);
    return null;
  }
} catch (err) {
  setPilotReason('result-parse-error', `${err}`);
  return null;
}
```

## 検証

### Node.js 診断
一時検証スクリプト `test-wasm-quick.mjs` は役目を終えたため削除済みです。

**出力：**
```
✅ Testing WASM JSON string response

  Raw response type: STRING ✓
  JSON.parse succeeded ✓

📦 Parsed fields:
  ok: true
  status: pilot-one-iteration
  dx: Array[12] - first 3: [-0.004166579862911568, -0.00416657986292025, -0.00416657986292024]
  xNext: Array[12] - first 3: [0.09583342013708844, 0.19583342013707977, 0.29583342013707975]
  predictedReduction: 0.049998958355034276
  jacobianShape: [10, 12]

✅ SUCCESS: WASM returns valid JSON with correct array sizes!
```

### WASM ビルド
```bash
npm run wasm:rebuild
```
✅ 成功してビルドされ `public/rust-wasm/pkg/` に同期されました

### 型チェック
```bash
get_errors [bridge, optimizer-mvp]
```
✅ TypeScript エラーなし

## 修正後の期待される動作

1. **WASM 呼び出し**：ブリッジが WASM から JSON 文字列を受け取る
2. **パース**：ブリッジが JSON をパース → JavaScript プレーンオブジェクト
3. **フィールドアクセス**：`parsed.dx`、`parsed.xNext` が正常に機能
4. **バリデーション**：配列が正しくパースされ検証される
5. **KKT 統合**：パイロット呼び出しが `ok: true` と有効な配列サイズで成功するはず
6. **ベンチマーク**：`kktWasmPilotHits` が増加、`kktWasmPilotLastReason` が `"ok"` を示すはず

## 修正されたファイル

1. [rust-wasm/src/lib.rs](rust-wasm/src/lib.rs#L2149-L2309)
   - `optimize_system_in_wasm()` の戻り値の型を `Result<String, JsValue>` に変更
   - シリアライズを `serde_wasm_bindgen::to_value()` から `serde_json::to_string()` に変更

2. [rust-wasm/ts/optimization/optimizer-wasm-bridge.ts](rust-wasm/ts/optimization/optimizer-wasm-bridge.ts)
   - JSON 文字列パース処理を追加
   - すべての `raw` 参照を `parsed` に更新
   - パースエラーハンドリングを改善

## テストコマンド

この修正時に使った一時 HTML / Node.js テストハーネスは archive から削除済みです。
現在は通常の diagnostics と build を使って確認します。

---

**状態**：✅ 修正が WASM レベルで実装・検証されました。ビルド成功。ブラウザ統合テスト準備完了。
