# KKT Optimizer Quick Start Guide

## Method 1: Console Command (Quick Test)

Open the browser **Developer Console** (F12) and run:

```javascript
// Run KKT optimization with default parameters
OptimizationMVP.run({ 
  method: 'kkt',
  maxIterations: 50,
  kktOuterIters: 10,
  kktInnerIters: 20,
  onProgress: (p) => console.log(`[KKT] Iter: ${p.iter}, Current: ${p.current?.toFixed(6) || 'N/A'}, Best: ${p.best?.toFixed(6) || 'N/A'}`)
})
```

## Method 2: UI RUN Button

1. Open the **Optimizer UI** (the interface with RUN button)
2. Look for **Method** dropdown (should show "lm", "cd", "kkt" options)
3. **Select "kkt"**
4. Adjust parameters if needed:
   - `kktOuterIters`: Number of outer SQP iterations (default: 10)
   - `kktInnerIters`: Number of inner LM iterations (default: 200)
   - `kktPenalty`: Initial penalty parameter (default: 1)
5. Click **RUN**

## Debug Output

When KKT runs, you should see in the browser console:

```
[DEBUG] method= kkt vars.length= 2
[DEBUG] KKT block entered. vars.length= 2
🚀 [KKT] Starting optimization with 2 variables, initial score: 0.123456
🔄 [KKT] Starting SQP outer + LM inner (max: 50 iters)
📐 [KKT] Outer 0 maxViolation: 1.23e-3 mu: 1.00e+0
...
✅ [KKT] Improved to 0.098765 viol: 5.43e-4
📈 [KKT] Final: Initial= 0.123456 Best= 0.098765 Improved= true
```

## Troubleshooting

### "❌ No continuous variables"
- You need to mark at least one parameter as **"Optimize"** in Design Intent
- The variable must be a numeric parameter (radius, thickness, etc.)

### "⏸️ Step KKT block entered. vars.length= 0"
- No optimization variables found
- Go to **Design Intent** → Open a **Block** → Check "Optimize" on numeric parameters

### No output at all
- Check the **Method dropdown** in UI - is it set to "kkt"?
- Try the console command Method 1 above
- Open **Developer Console** (F12) to see debug logs

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kktOuterIters` | 10 | Number of SQP outer iterations |
| `kktInnerIters` | 200 | Max inner LM iterations per outer iter |
| `kktPenalty` | 1 | Initial penalty parameter (grows on constraints) |
| `method` | 'lm' | Use 'kkt' or 'sqp' to select KKT method |

## SQP+LM Algorithm Overview

KKT uses **Sequential Quadratic Programming (SQP)** outer loop with **Levenberg-Marquardt (LM)** inner loop:

1. **Outer SQP**: Updates Lagrange multipliers and penalty parameter based on constraint violations
2. **Inner LM**: Minimizes augmented Lagrangian residual with damping adaptation
3. **Box Constraints**: Enforced by clamping to Design Intent bounds
4. **Trust Region**: Limits step size in scaled variable coordinates
5. **Backtracking**: Line search with adaptive alpha reduction

