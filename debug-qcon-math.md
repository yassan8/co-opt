# Qcon Ray Tracing 式の検証

## 定義確認

### Qcon sag
```
z_qcon = Σ(coef_i * u^4 * P_i^(0,4)(2u^2 - 1))
where u = r / scale
```

### Qcon sag derivative
```
dz/dr = Σ(coef_i * d(u^4 * P_i)/dr)
      = Σ(coef_i * (4u^3 * P_i + 4u^5 * dP_i/dx) / scale)
where x = 2u^2 - 1, dx/du = 4u
```

## 実装比較

### JS 実装 (qcon-basis.ts)
```typescript
const u = rr / scale;
const u2 = u * u;
const x = 2 * u2 - 1;
const u4 = u2 * u2;

// Sag
sag += coefficient * (u4 * jacobiPolynomial(i, 0, 4, x));

// Derivative
derivative += coefficient * ((4 * u * u2 * pn) + (4 * u * u2 * u2 * dPnDx)) / scale;
```

### Rust 実装 (lib.rs)
```rust
let u = r / scale;
let u2 = u * u;
let x = 2.0 * u2 - 1.0;
let u4 = u2 * u2;

// Sag
sag += coef * (u4 * pn);

// Derivative
derivative += coef * ((4.0 * u * u2 * pn) + (4.0 * u * u2 * u2 * d_pn_dx)) / scale;
```

## 問題の可能性

### 1. スケール因子計算 ⚠️
Rust `resolve_qcon_scale()`:
- qconNrad > 0 → return qconNrad
- else semidia > 0 → return semidia  
- else radius ≠ 0 → return |radius|
- else return 1.0

JS `resolveQconScale()`:
- qconNrad チェック ✓
- diameter/aperture チェック（半径に変換）
- semidia チェック
- **複数の代替名をチェック**: SemiDia, semiDiameter など

### 2. パラメータ渡し
Rust では `parse_qcon_params()`:
```rust
coefs[i] = get_param(params, 4 + i, 0.0);
```

JS では係数を直接受け取る

**もし TS から Rust へ渡されるパラメータが不正だと、全て失敗します**

### 3. Newton 法の初期推定値
Rust では複数の初期値を試しますが、**非常に複雑な Qcon 表面では十分でない**可能性があります。

## 検証に必要な情報
1. 実際の Qcon サーフェスが ray tracing されているか確認
2. Qcon パラメータが正しく渡されているか確認  
3. 他の aspheric surfaces は正常に機能しているか確認
