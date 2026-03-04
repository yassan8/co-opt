/**
 * Quick test to verify WASM exports are available
 */

const mod = await import('../../rust-wasm/pkg/surface_origins.js');

console.log('WASM Module loaded');
console.log('Has vector_add_scaled?', typeof mod.vector_add_scaled);
console.log('Has vector_dot?', typeof mod.vector_dot);
console.log('Has vector_norm?', typeof mod.vector_norm);
console.log('Has matrix_vector_multiply?', typeof mod.matrix_vector_multiply);
console.log('Has cholesky_factorization?', typeof mod.cholesky_factorization);
console.log('Has bfgs_update?', typeof mod.bfgs_update);
console.log('Has qr_factorization?', typeof mod.qr_factorization);

console.log('\nTesting vector_dot([1,2,3], [4,5,6]):');
try {
  await mod.default();
  const x = new Float64Array([1, 2, 3]);
  const y = new Float64Array([4, 5, 6]);
  const result = mod.vector_dot(x, y);
  console.log('Result:', result);
  console.log('Expected: 32');
} catch (err) {
  console.error('Error:', err);
}
