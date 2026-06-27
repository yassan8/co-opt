/**
 * Phase 1 Linear Algebra Kernels - Simple Validation Script
 * Run with: node --experimental-strip-types testing/optimization/phase1-la-validate.mjs
 */

import {
  preloadOptimizerWasmBridge,
  vectorAddScaledWasm,
  vectorDotWasm,
  vectorNormWasm,
  matrixVectorMultiplyWasm,
  choleskyFactorizationWasm,
  bfgsUpdateWasm,
  qrFactorizationWasm,
  getOptimizerWasmBridgeDebugInfo
} from '../../rust-wasm/ts/optimization/optimizer-wasm-bridge.ts';

const EPS = 1e-10;

function assertClose(actual, expected, message, tolerance = EPS) {
  if (Math.abs(actual - expected) > tolerance) {
    console.error(`❌ FAIL: ${message}`);
    console.error(`   Expected: ${expected}, Got: ${actual}, Diff: ${Math.abs(actual - expected)}`);
    return false;
  }
  console.log(`✅ PASS: ${message}`);
  return true;
}

function assertArrayClose(actual, expected, message, tolerance = EPS) {
  if (actual.length !== expected.length) {
    console.error(`❌ FAIL: ${message} - length mismatch`);
    console.error(`   Expected length: ${expected.length}, Got: ${actual.length}`);
    return false;
  }
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      console.error(`❌ FAIL: ${message} - element ${i}`);
      console.error(`   Expected: ${expected[i]}, Got: ${actual[i]}, Diff: ${Math.abs(actual[i] - expected[i])}`);
      return false;
    }
  }
  console.log(`✅ PASS: ${message}`);
  return true;
}

async function runTests() {
  console.log('🧪 Phase 1 Linear Algebra Kernels - Validation\n');
  
  // Preload WASM
  console.log('Loading WASM module...');
  await preloadOptimizerWasmBridge();
  const debug = getOptimizerWasmBridgeDebugInfo();
  console.log('WASM Debug Info:', debug);
  console.log('');
  
  let passed = 0;
  let failed = 0;
  
  // Test vector_add_scaled
  console.log('--- Vector Operations ---');
  {
    const x = [1.0, 2.0, 3.0];
    const y = [4.0, 5.0, 6.0];
    const alpha = 2.0;
    const result = vectorAddScaledWasm(x, y, alpha);
    
    if (result === null) {
      console.warn('⚠️  vector_add_scaled not available');
    } else {
      assertArrayClose(result, [9.0, 12.0, 15.0], 'vector_add_scaled: x + alpha*y') ? passed++ : failed++;
    }
  }
  
  // Test vector_dot
  {
    const x = [1.0, 2.0, 3.0];
    const y = [4.0, 5.0, 6.0];
    const result = vectorDotWasm(x, y);
    
    if (result === null) {
      console.warn('⚠️  vector_dot not available');
    } else {
      assertClose(result, 32.0, 'vector_dot: [1,2,3]·[4,5,6]') ? passed++ : failed++;
    }
  }
  
  // Test vector_norm
  {
    const x = [3.0, 4.0];
    const result = vectorNormWasm(x);
    
    if (result === null) {
      console.warn('⚠️  vector_norm not available');
    } else {
      assertClose(result, 5.0, 'vector_norm: ||[3,4]||') ? passed++ : failed++;
    }
  }
  
  console.log('');
  
  // Test matrix_vector_multiply
  console.log('--- Matrix Operations ---');
  {
    const A = [
      [1.0, 2.0, 3.0],
      [4.0, 5.0, 6.0]
    ];
    const x = [1.0, 2.0, 3.0];
    const result = matrixVectorMultiplyWasm(A, x);
    
    if (result === null) {
      console.warn('⚠️  matrix_vector_multiply not available');
    } else {
      assertArrayClose(result, [14.0, 32.0], 'matrix_vector_multiply: A*x') ? passed++ : failed++;
    }
  }
  
  console.log('');
  
  // Test Cholesky
  console.log('--- Cholesky Factorization ---');
  {
    const A = [
      [4.0, 2.0],
      [2.0, 3.0]
    ];
    const L = choleskyFactorizationWasm(A);
    
    if (L === null) {
      console.warn('⚠️  cholesky_factorization not available');
    } else if (L.length === 0) {
      console.error('❌ FAIL: Cholesky factorization failed for positive definite matrix');
      failed++;
    } else {
      // Verify L * L^T = A
      const reconstructed = [
        [L[0][0] * L[0][0] + L[0][1] * L[0][1], L[0][0] * L[1][0] + L[0][1] * L[1][1]],
        [L[1][0] * L[0][0] + L[1][1] * L[0][1], L[1][0] * L[1][0] + L[1][1] * L[1][1]]
      ];
      
      let allClose = true;
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          if (Math.abs(reconstructed[i][j] - A[i][j]) > 1e-10) {
            allClose = false;
            break;
          }
        }
      }
      
      if (allClose) {
        console.log('✅ PASS: Cholesky: L*L^T = A');
        passed++;
      } else {
        console.error('❌ FAIL: Cholesky: L*L^T ≠ A');
        failed++;
      }
    }
  }
  
  console.log('');
  
  // Test BFGS
  console.log('--- BFGS Update ---');
  {
    const H = [
      [1.0, 0.0],
      [0.0, 1.0]
    ];
    const step = [0.1, 0.2];
    const gradDiff = [0.3, 0.4];
    
    const success = bfgsUpdateWasm(H, step, gradDiff);
    
    if (success === false && H[0][0] === 1.0) {
      console.warn('⚠️  bfgs_update not available');
    } else if (success) {
      // Check that H was modified and is symmetric
      const isIdentity = H[0][0] === 1.0 && H[0][1] === 0.0 && H[1][0] === 0.0 && H[1][1] === 1.0;
      const isSymmetric = Math.abs(H[0][1] - H[1][0]) < 1e-10;
      
      if (!isIdentity && isSymmetric) {
        console.log('✅ PASS: BFGS update modified Hessian, preserved symmetry');
        passed++;
      } else {
        console.error('❌ FAIL: BFGS update issues');
        if (isIdentity) console.error('   H was not modified');
        if (!isSymmetric) console.error('   H is not symmetric');
        failed++;
      }
    } else {
      console.error('❌ FAIL: BFGS update rejected positive curvature');
      failed++;
    }
  }
  
  console.log('');
  
  // Test QR
  console.log('--- QR Factorization ---');
  {
    const A = [
      [12.0, -51.0],
      [6.0, 167.0],
      [-4.0, 24.0]
    ];
    
    const result = qrFactorizationWasm(A);
    
    if (result === null) {
      console.warn('⚠️  qr_factorization not available');
    } else {
      const { Q, R } = result;
      
      // Verify Q * R = A
      let qrMatchesA = true;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          let sum = 0.0;
          for (let k = 0; k < 3; k++) {
            sum += Q[i][k] * R[k][j];
          }
          if (Math.abs(sum - A[i][j]) > 1e-5) {
            qrMatchesA = false;
            break;
          }
        }
      }
      
      // Verify Q is orthogonal
      let qIsOrthogonal = true;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let dot = 0.0;
          for (let k = 0; k < 3; k++) {
            dot += Q[k][i] * Q[k][j];
          }
          const expected = i === j ? 1.0 : 0.0;
          if (Math.abs(dot - expected) > 1e-5) {
            qIsOrthogonal = false;
            break;
          }
        }
      }
      
      if (qrMatchesA && qIsOrthogonal) {
        console.log('✅ PASS: QR: Q*R=A, Q is orthogonal');
        passed++;
      } else {
        console.error('❌ FAIL: QR factorization issues');
        if (!qrMatchesA) console.error('   Q*R ≠ A');
        if (!qIsOrthogonal) console.error('   Q is not orthogonal');
        failed++;
      }
    }
  }
  
  console.log('');
  console.log('='.repeat(50));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('='.repeat(50));
  
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
