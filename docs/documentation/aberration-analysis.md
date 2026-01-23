# 収差係数の正規化方法の比較

## 問題点

現在のeva-seidel-coefficients.jsの正規化方法とTable 1の期待値が一致しない。

## 現在の正規化方法（eva-seidel-coefficients.js）

**正規化係数**: NFL = FL / Reference FL = 1801.494386 / 40.0 = **45.037360**

**初期条件**:
- 子午光線（Marginal Ray）:
  - h[1] = 45.037360 (NFL)
  - α[1] = 0.0
  
- 主光線（Chief Ray）:
  - h[1]_ = -EnP/n1/NFL
  - α[1]_ = -0.022204 (-1/NFL)

**Surface 1での実際の値**:
- 子午光線: h₁ = 45.037360, α₁ = 4.94347959
- 主光線: h₁̄ = -14.60406302, ᾱ₁ = -2.48522110

## Table 1の期待値（40mm = 1 unit正規化）

**正規化係数**: 40mm = 1 unit

**期待値**:
- 主光線: α₁ = **-1.0**, h₁ = **3.18288**
- 子午光線: ᾱ₁ = **-0.0111031**, h̄₁ = **-0.964659**

## 主な違い

### 1. 正規化係数の違い
- 現在: NFL = 45.037360（焦点距離ベース）
- Table 1: 40.0（固定単位系）

### 2. 初期角度の設定
- 現在: 子午光線の角度を0に設定、主光線を-1/NFLに設定
- Table 1: **主光線の角度を-1.0に固定**（アフォーカル系の定義）

### 3. 光線の役割の混同？
- 現在のコードでは「Marginal Ray」と「Chief Ray」の定義が異なる可能性
- Table 1では：
  - Chief Ray（主光線）= α₀ = -1.0の固定角度
  - Marginal Ray（軸上光線）= Stop端を通る

## 必要な修正

1. **正規化を40mm = 1 unitに変更**
2. **主光線の初期角度をα₀ = -1.0に固定**
3. **Transfer方程式から初期高さh₀を逆算**
4. **第1面（air→air）での屈折なしを考慮**

## 検証済みの正しい初期条件

```javascript
// 正規化（40mm = 1 unit）
const d0 = 127.39 / 40.0 = 3.184750 unit

// 主光線（Chief Ray）
const alpha0_chief = -1.0;  // 固定
const h1_expected = 3.18288;
const h0_chief = h1_expected - d0 * alpha0_chief;
// → h0 = 3.18288 - 3.184750 × (-1.0) = 6.367630

// 子午光線（Marginal Ray）  
const alpha1_marginal_expected = -0.0111031;
const alpha0_marginal = alpha1_marginal_expected;  // 第1面で屈折なし
const h1_marginal_expected = -0.964659;
const h0_marginal = h1_marginal_expected - d0 * alpha0_marginal;
// → h0 = -0.964659 - 3.184750 × (-0.0111031) = -0.929298
```

## 次のステップ

1. eva-seidel-coefficients.jsのperformParaxialTraceを修正
2. 40mm正規化を適用
3. アフォーカル系の初期条件を実装
4. Table 1の値との一致を確認
