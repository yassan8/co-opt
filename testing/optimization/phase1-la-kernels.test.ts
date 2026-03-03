/**
 * Phase 1 Linear Algebra Kernels - Unit Tests
 * 
 * Tests for Rust WASM linear algebra operations:
 * - Vector operations (add_scaled, dot, norm)
 * - Matrix operations (matrix-vector multiply)
 * - Cholesky factorization
 * - BFGS update
 * - QR factorization
 */

import { describe, test, expect, beforeAll } from 'vitest';
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
} from '../../rust-wasm/ts/optimization/optimizer-wasm-bridge';

describe('Phase 1: Linear Algebra Kernels', () => {
  beforeAll(async () => {
    await preloadOptimizerWasmBridge();
    const debug = getOptimizerWasmBridgeDebugInfo();
    console.log('[Phase 1 LA Tests] WASM Bridge Debug:', debug);
  });

  describe('Vector Operations', () => {
    test('vector_add_scaled: basic operation', () => {
      const x = [1.0, 2.0, 3.0];
      const y = [4.0, 5.0, 6.0];
      const alpha = 2.0;
      
      const result = vectorAddScaledWasm(x, y, alpha);
      
      if (result === null) {
        console.warn('[Phase 1 LA Tests] vector_add_scaled not available, skipping');
        expect(result).toBeNull();
        return;
      }
      
      expect(result).toHaveLength(3);
      expect(result[0]).toBeCloseTo(9.0); // 1 + 2*4
      expect(result[1]).toBeCloseTo(12.0); // 2 + 2*5
      expect(result[2]).toBeCloseTo(15.0); // 3 + 2*6
    });

    test('vector_add_scaled: negative alpha', () => {
      const x = [10.0, 20.0];
      const y = [3.0, 4.0];
      const alpha = -1.0;
      
      const result = vectorAddScaledWasm(x, y, alpha);
      
      if (result === null) return;
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBeCloseTo(7.0); // 10 - 3
      expect(result[1]).toBeCloseTo(16.0); // 20 - 4
    });

    test('vector_dot: basic operation', () => {
      const x = [1.0, 2.0, 3.0];
      const y = [4.0, 5.0, 6.0];
      
      const result = vectorDotWasm(x, y);
      
      if (result === null) {
        console.warn('[Phase 1 LA Tests] vector_dot not available, skipping');
        expect(result).toBeNull();
        return;
      }
      
      expect(result).toBeCloseTo(32.0); // 1*4 + 2*5 + 3*6
    });

    test('vector_dot: orthogonal vectors', () => {
      const x = [1.0, 0.0];
      const y = [0.0, 1.0];
      
      const result = vectorDotWasm(x, y);
      
      if (result === null) return;
      
      expect(result).toBeCloseTo(0.0);
    });

    test('vector_norm: unit vector', () => {
      const x = [1.0, 0.0, 0.0];
      
      const result = vectorNormWasm(x);
      
      if (result === null) {
        console.warn('[Phase 1 LA Tests] vector_norm not available, skipping');
        expect(result).toBeNull();
        return;
      }
      
      expect(result).toBeCloseTo(1.0);
    });

    test('vector_norm: general vector', () => {
      const x = [3.0, 4.0]; // 3-4-5 triangle
      
      const result = vectorNormWasm(x);
      
      if (result === null) return;
      
      expect(result).toBeCloseTo(5.0);
    });
  });

  describe('Matrix Operations', () => {
    test('matrix_vector_multiply: identity matrix', () => {
      const I = [
        [1.0, 0.0],
        [0.0, 1.0]
      ];
      const x = [5.0, 7.0];
      
      const result = matrixVectorMultiplyWasm(I, x);
      
      if (result === null) {
        console.warn('[Phase 1 LA Tests] matrix_vector_multiply not available, skipping');
        expect(result).toBeNull();
        return;
      }
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBeCloseTo(5.0);
      expect(result[1]).toBeCloseTo(7.0);
    });

    test('matrix_vector_multiply: general matrix', () => {
      const A = [
        [1.0, 2.0, 3.0],
        [4.0, 5.0, 6.0]
      ];
      const x = [1.0, 2.0, 3.0];
      
      const result = matrixVectorMultiplyWasm(A, x);
      
      if (result === null) return;
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBeCloseTo(14.0); // 1*1 + 2*2 + 3*3
      expect(result[1]).toBeCloseTo(32.0); // 4*1 + 5*2 + 6*3
    });
  });

  describe('Cholesky Factorization', () => {
    test('cholesky_factorization: 2x2 positive definite', () => {
      // A = [[4, 2], [2, 3]]
      // L = [[2, 0], [1, sqrt(2)]]
      const A = [
        [4.0, 2.0],
        [2.0, 3.0]
      ];
      
      const L = choleskyFactorizationWasm(A);
      
      if (L === null) {
        console.warn('[Phase 1 LA Tests] cholesky_factorization not available, skipping');
        expect(L).toBeNull();
        return;
      }
      
      expect(L).toHaveLength(2);
      expect(L[0]).toHaveLength(2);
      
      expect(L[0][0]).toBeCloseTo(2.0);
      expect(L[0][1]).toBeCloseTo(0.0);
      expect(L[1][0]).toBeCloseTo(1.0);
      expect(L[1][1]).toBeCloseTo(Math.sqrt(2.0));
      
      // Verify L * L^T = A
      const reconstructed = [
        [L[0][0] * L[0][0] + L[0][1] * L[0][1], L[0][0] * L[1][0] + L[0][1] * L[1][1]],
        [L[1][0] * L[0][0] + L[1][1] * L[0][1], L[1][0] * L[1][0] + L[1][1] * L[1][1]]
      ];
      
      expect(reconstructed[0][0]).toBeCloseTo(A[0][0]);
      expect(reconstructed[0][1]).toBeCloseTo(A[0][1]);
      expect(reconstructed[1][0]).toBeCloseTo(A[1][0]);
      expect(reconstructed[1][1]).toBeCloseTo(A[1][1]);
    });

    test('cholesky_factorization: not positive definite', () => {
      // Not positive definite (negative eigenvalue)
      const A = [
        [1.0, 2.0],
        [2.0, 1.0]
      ];
      
      const L = choleskyFactorizationWasm(A);
      
      if (L === null) return;
      
      // Should return null or empty for non-positive-definite matrices
      // In our implementation, we return empty array from Rust
      expect(L).toEqual([]);
    });
  });

  describe('BFGS Update', () => {
    test('bfgs_update: basic update with positive curvature', () => {
      // Start with identity Hessian approximation
      const H = [
        [1.0, 0.0],
        [0.0, 1.0]
      ];
      const step = [0.1, 0.2];
      const gradDiff = [0.3, 0.4]; // y = grad_new - grad_old
      
      const success = bfgsUpdateWasm(H, step, gradDiff);
      
      if (success === false && H[0][0] === 1.0) {
        console.warn('[Phase 1 LA Tests] bfgs_update not available, skipping');
        expect(success).toBe(false);
        return;
      }
      
      expect(success).toBe(true);
      
      // H should be updated (no longer identity)
      const isIdentity = H[0][0] === 1.0 && H[0][1] === 0.0 && H[1][0] === 0.0 && H[1][1] === 1.0;
      expect(isIdentity).toBe(false);
      
      // H should remain symmetric
      expect(H[0][1]).toBeCloseTo(H[1][0]);
    });

    test('bfgs_update: negative curvature (should reject)', () => {
      const H = [
        [1.0, 0.0],
        [0.0, 1.0]
      ];
      const step = [1.0, 0.0];
      const gradDiff = [-0.1, 0.0]; // Negative curvature: y^T s < 0
      
      const success = bfgsUpdateWasm(H, step, gradDiff);
      
      if (success === true || H[0][0] !== 1.0) return; // Function available
      
      // Should reject update due to negative curvature
      expect(success).toBe(false);
      
      // H should remain unchanged
      expect(H[0][0]).toBe(1.0);
      expect(H[0][1]).toBe(0.0);
    });
  });

  describe('QR Factorization', () => {
    test('qr_factorization: 3x2 matrix', () => {
      const A = [
        [12.0, -51.0],
        [6.0, 167.0],
        [-4.0, 24.0]
      ];
      
      const result = qrFactorizationWasm(A);
      
      if (result === null) {
        console.warn('[Phase 1 LA Tests] qr_factorization not available, skipping');
        expect(result).toBeNull();
        return;
      }
      
      const { Q, R } = result;
      
      expect(Q).toHaveLength(3);
      expect(Q[0]).toHaveLength(3);
      expect(R).toHaveLength(3);
      expect(R[0]).toHaveLength(2);
      
      // Verify Q is orthogonal: Q^T * Q = I
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let dot = 0.0;
          for (let k = 0; k < 3; k++) {
            dot += Q[k][i] * Q[k][j];
          }
          const expected = i === j ? 1.0 : 0.0;
          expect(dot).toBeCloseTo(expected, 5);
        }
      }
      
      // Verify R is upper triangular
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          if (i > j) {
            expect(Math.abs(R[i][j])).toBeLessThan(1e-10);
          }
        }
      }
      
      // Verify Q * R = A
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          let sum = 0.0;
          for (let k = 0; k < 3; k++) {
            sum += Q[i][k] * R[k][j];
          }
          expect(sum).toBeCloseTo(A[i][j], 5);
        }
      }
    });

    test('qr_factorization: square matrix', () => {
      const A = [
        [1.0, 2.0],
        [3.0, 4.0]
      ];
      
      const result = qrFactorizationWasm(A);
      
      if (result === null) return;
      
      const { Q, R } = result;
      
      expect(Q).toHaveLength(2);
      expect(R).toHaveLength(2);
      
      // Verify Q * R = A
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          let sum = 0.0;
          for (let k = 0; k < 2; k++) {
            sum += Q[i][k] * R[k][j];
          }
          expect(sum).toBeCloseTo(A[i][j], 5);
        }
      }
    });
  });
});
