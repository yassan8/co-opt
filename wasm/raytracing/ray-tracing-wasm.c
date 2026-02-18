/**
 * WebAssembly版光線追跡数学計算モジュール
 * 最も計算集約的な非球面SAG計算とベクトル演算をWASMで高速化
 * 
 * コンパイル方法:
 * emcc ray-tracing-wasm.c -o ray-tracing-wasm-v3.js \
 *   -s EXPORTED_FUNCTIONS="['_aspheric_sag','_aspheric_sag10','_aspheric_sag_rt10','_batch_aspheric_sag','_batch_aspheric_sag10','_vector_dot','_vector_cross','_vector_normalize','_ray_sphere_intersect','_batch_vector_normalize','_malloc','_free']" \
 *   -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" -O3
 */

#include <math.h>
#include <stdlib.h>
#include <emscripten.h>

static inline double __rt10_asphere_poly(double r, double r2,
                                        double coef1, double coef2, double coef3, double coef4, double coef5,
                                        double coef6, double coef7, double coef8, double coef9, double coef10,
                                        int modeOdd) {
    double asphere = 0.0;
    const double coefs[10] = {coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10};
    if (modeOdd) {
        double r_power = r2 * r; // r^3
        for (int i = 0; i < 10; i++) {
            double c = coefs[i];
            if (c != 0.0) asphere += c * r_power;
            r_power *= r2;
        }
    } else {
        // even: coef1..coef10 multiply r^4, r^6, ..., r^22 (A4..A22)
        double r_power = r2 * r2; // r^4
        for (int i = 0; i < 10; i++) {
            double c = coefs[i];
            if (c != 0.0) asphere += c * r_power;
            r_power *= r2;
        }
    }
    return asphere;
}

static inline double __rt10_asphere_dzdr(double r, double r2,
                                        double coef1, double coef2, double coef3, double coef4, double coef5,
                                        double coef6, double coef7, double coef8, double coef9, double coef10,
                                        int modeOdd) {
    if (r == 0.0) return 0.0;
    const double coefs[10] = {coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10};
    double dz = 0.0;
    if (modeOdd) {
        // sag = sum coef_i * r^(2i+1) for i=1..10 (r^3..r^21)
        // dz/dr = sum coef_i * (2i+1) * r^(2i)
        double r_pow = r2; // r^2
        for (int i = 0; i < 10; i++) {
            double c = coefs[i];
            if (c != 0.0) {
                double p = (double)(2 * (i + 1) + 1); // 3,5,...,21
                dz += c * p * r_pow;
            }
            r_pow *= r2; // r^2 -> r^4 -> ... -> r^20
        }
    } else {
        // sag = sum coef_i * r^(2i+2) for i=1..10 (r^4..r^22)
        // dz/dr = sum coef_i * (2i+2) * r^(2i+1)
        double r_pow = r2 * r; // r^3
        for (int i = 0; i < 10; i++) {
            double c = coefs[i];
            if (c != 0.0) {
                double p = (double)(2 * (i + 2)); // 4,6,...,22
                dz += c * p * r_pow;
            }
            r_pow *= r2; // r^3 -> r^5 -> ... -> r^21
        }
    }
    return dz;
}

/**
 * 高速非球面SAG計算（WASM版）
 * @param r 半径
 * @param c 曲率
 * @param k コーニック定数
 * @param a4 4次非球面係数
 * @param a6 6次非球面係数
 * @param a8 8次非球面係数
 * @param a10 10次非球面係数
 * @return SAG値
 */
EMSCRIPTEN_KEEPALIVE
double aspheric_sag(double r, double c, double k, double a4, double a6, double a8, double a10) {
    if (r == 0.0) return 0.0;
    
    double r2 = r * r;
    double cr2 = c * r2;
    
    // 基本二次曲面項の計算
    double discriminant = 1.0 - (1.0 + k) * c * c * r2;
    if (discriminant <= 0.0) return 0.0;
    
    double basic_sag = cr2 / (1.0 + sqrt(discriminant));
    
    // 高次非球面項の計算（Horner法で最適化）
    double r4 = r2 * r2;
    double r6 = r4 * r2;
    double r8 = r4 * r4;
    double r10 = r8 * r2;
    
    double aspherical_terms = a4 * r4 + a6 * r6 + a8 * r8 + a10 * r10;
    
    return basic_sag + aspherical_terms;
}

/**
 * 非球面SAG計算（WASM拡張版: a22まで）
 * coef1..coef10 (A4..A22) をすべてWASM内で扱うためのエントリポイント。
 * @param a12..a22 追加の偶数次数非球面係数
 */
EMSCRIPTEN_KEEPALIVE
double aspheric_sag10(double r, double c, double k,
                      double a4, double a6, double a8, double a10,
                      double a12, double a14, double a16, double a18, double a20, double a22) {
    if (r == 0.0) return 0.0;

    double r2 = r * r;
    double cr2 = c * r2;

    double discriminant = 1.0 - (1.0 + k) * c * c * r2;
    if (discriminant <= 0.0) return 0.0;

    double basic_sag = cr2 / (1.0 + sqrt(discriminant));

    // r^4..r^22
    double r4 = r2 * r2;
    double r6 = r4 * r2;
    double r8 = r4 * r4;
    double r10 = r8 * r2;
    double r12 = r6 * r6;
    double r14 = r12 * r2;
    double r16 = r8 * r8;
    double r18 = r16 * r2;
    double r20 = r10 * r10;
    double r22 = r20 * r2;

    double aspherical_terms =
        a4 * r4 + a6 * r6 + a8 * r8 + a10 * r10 +
        a12 * r12 + a14 * r14 + a16 * r16 + a18 * r18 + a20 * r20 + a22 * r22;

    return basic_sag + aspherical_terms;
}

/**
 * 高速ベクトル内積計算
 */
EMSCRIPTEN_KEEPALIVE
double vector_dot(double ax, double ay, double az, double bx, double by, double bz) {
    return ax * bx + ay * by + az * bz;
}

/**
 * 高速ベクトル外積計算
 * 結果はresult配列に格納される [x, y, z]
 */
EMSCRIPTEN_KEEPALIVE
void vector_cross(double ax, double ay, double az, double bx, double by, double bz, double* result) {
    result[0] = ay * bz - az * by;
    result[1] = az * bx - ax * bz;
    result[2] = ax * by - ay * bx;
}

/**
 * 高速ベクトル正規化
 * 結果はresult配列に格納される [x, y, z]
 */
EMSCRIPTEN_KEEPALIVE
void vector_normalize(double x, double y, double z, double* result) {
    double length = sqrt(x * x + y * y + z * z);
    if (length == 0.0) {
        result[0] = result[1] = result[2] = 0.0;
        return;
    }
    
    double inv_length = 1.0 / length;
    result[0] = x * inv_length;
    result[1] = y * inv_length;
    result[2] = z * inv_length;
}

/**
 * 高速光線-球面交点計算
 * @param ox, oy, oz 光線原点
 * @param dx, dy, dz 光線方向
 * @param cx, cy, cz 球面中心
 * @param radius 球面半径
 * @return 交点までの距離（負の値は交点なし）
 */
EMSCRIPTEN_KEEPALIVE
double ray_sphere_intersect(double ox, double oy, double oz,
                           double dx, double dy, double dz,
                           double cx, double cy, double cz,
                           double radius) {
    // 光線原点から球面中心へのベクトル
    double ocx = ox - cx;
    double ocy = oy - cy;
    double ocz = oz - cz;
    
    // 二次方程式の係数
    double a = dx * dx + dy * dy + dz * dz;
    double b = 2.0 * (ocx * dx + ocy * dy + ocz * dz);
    double c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
    
    double discriminant = b * b - 4.0 * a * c;
    
    if (discriminant < 0.0) return -1.0; // 交点なし
    
    double sqrt_discriminant = sqrt(discriminant);
    double t1 = (-b - sqrt_discriminant) / (2.0 * a);
    double t2 = (-b + sqrt_discriminant) / (2.0 * a);
    
    // より近い正の解を返す
    if (t1 > 0.0) return t1;
    if (t2 > 0.0) return t2;
    return -1.0;
}

/**
 * 高速バッチベクトル演算（複数のベクトルを一度に処理）
 * @param vectors_ptr ベクトルデータのポインタ (x1,y1,z1,x2,y2,z2,...)
 * @param count ベクトルの数
 * @param result_ptr 結果を格納するポインタ
 */
EMSCRIPTEN_KEEPALIVE
void batch_vector_normalize(double* vectors_ptr, int count, double* result_ptr) {
    for (int i = 0; i < count; i++) {
        int idx = i * 3;
        double x = vectors_ptr[idx];
        double y = vectors_ptr[idx + 1];
        double z = vectors_ptr[idx + 2];
        
        double length = sqrt(x * x + y * y + z * z);
        
        if (length > 0.0) {
            double inv_length = 1.0 / length;
            result_ptr[idx] = x * inv_length;
            result_ptr[idx + 1] = y * inv_length;
            result_ptr[idx + 2] = z * inv_length;
        } else {
            result_ptr[idx] = 0.0;
            result_ptr[idx + 1] = 0.0;
            result_ptr[idx + 2] = 0.0;
        }
    }
}

/**
 * 高速バッチ行列ベクトル積（3x3行列 × vec3配列）
 * @param m00..m22 行列要素（行優先）
 * @param vectors_ptr 入力ベクトル配列ポインタ (x1,y1,z1,x2,y2,z2,...)
 * @param count ベクトル本数
 * @param result_ptr 出力配列ポインタ
 */
EMSCRIPTEN_KEEPALIVE
void batch_mat3_mul_vec3(double m00, double m01, double m02,
                         double m10, double m11, double m12,
                         double m20, double m21, double m22,
                         double* vectors_ptr, int count, double* result_ptr) {
    for (int i = 0; i < count; i++) {
        int idx = i * 3;
        const double x = vectors_ptr[idx];
        const double y = vectors_ptr[idx + 1];
        const double z = vectors_ptr[idx + 2];

        result_ptr[idx]     = m00 * x + m01 * y + m02 * z;
        result_ptr[idx + 1] = m10 * x + m11 * y + m12 * z;
        result_ptr[idx + 2] = m20 * x + m21 * y + m22 * z;
    }
}

/**
 * 高速バッチ非球面SAG計算
 * @param r_array 半径配列
 * @param count 要素数
 * @param c 曲率
 * @param k コーニック定数
 * @param a4, a6, a8, a10 非球面係数
 * @param result_array 結果格納用配列
 */
EMSCRIPTEN_KEEPALIVE
void batch_aspheric_sag(double* r_array, int count, double c, double k,
                       double a4, double a6, double a8, double a10,
                       double* result_array) {
    for (int i = 0; i < count; i++) {
        result_array[i] = aspheric_sag(r_array[i], c, k, a4, a6, a8, a10);
    }
}

/**
 * バッチ非球面SAG計算（拡張版: a22まで）
 */
EMSCRIPTEN_KEEPALIVE
void batch_aspheric_sag10(double* r_array, int count, double c, double k,
                          double a4, double a6, double a8, double a10,
                          double a12, double a14, double a16, double a18, double a20, double a22,
                          double* result_array) {
    for (int i = 0; i < count; i++) {
        result_array[i] = aspheric_sag10(r_array[i], c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
    }
}

/**
 * ray-tracing.js互換の非球面SAG計算
 * - even: coef1*r^4 + coef2*r^6 + ... + coef10*r^22
 * - odd:  coef1*r^3 + coef2*r^5 + ... + coef10*r^21
 *
 * NOTE:
 * - 既存のaspheric_sag/aspheric_sag10とは係数の次数対応が異なるため、別エントリポイントにする。
 * - ray-tracing.js 側はこの関数が存在する場合のみ利用し、無ければ従来JS実装にフォールバックする。
 *
 * @param r 半径
 * @param radius 曲率半径（ray-tracing.jsと同じ符号規約）
 * @param conic コーニック定数
 * @param coef1..coef10 多項式係数
 * @param modeOdd 0: even (r^4..r^22), 1: odd (r^3..r^21)
 */
EMSCRIPTEN_KEEPALIVE
double aspheric_sag_rt10(double r, double radius, double conic,
                         double coef1, double coef2, double coef3, double coef4, double coef5,
                         double coef6, double coef7, double coef8, double coef9, double coef10,
                         int modeOdd) {
    if (radius == 0.0) return 0.0;
    double r2 = r * r;
    double sqrtTerm = 1.0 - (1.0 + conic) * r2 / (radius * radius);
    if (!isfinite(sqrtTerm) || sqrtTerm < 0.0) return 0.0;
    double base = r2 / (radius * (1.0 + sqrt(sqrtTerm)));

    double asphere = __rt10_asphere_poly(r, r2, coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10, modeOdd);

    double out = base + asphere;
    return isfinite(out) ? out : 0.0;
}

/**
 * ray-tracing.js互換: 非球面サーフェスとの交点探索（Newton法）
 *
 * - ローカル座標系で面は z=0 に配置されている前提。
 * - 返り値は ray parameter t（pt = ray.pos + ray.dir * t）。失敗は -1。
 */
EMSCRIPTEN_KEEPALIVE
double intersect_aspheric_rt10(
    double ox, double oy, double oz,
    double dx, double dy, double dz,
    double semidia,
    double radius, double conic,
    double coef1, double coef2, double coef3, double coef4, double coef5,
    double coef6, double coef7, double coef8, double coef9, double coef10,
    int modeOdd,
    int maxIter,
    double tol
) {
    if (!isfinite(dx) || !isfinite(dy) || !isfinite(dz)) return -1.0;
    if (!isfinite(ox) || !isfinite(oy) || !isfinite(oz)) return -1.0;
    if (!(maxIter > 0)) maxIter = 20;
    if (!(tol > 0.0)) tol = 1e-7;

    // Try multiple initial guesses (matching ray-tracing.js behavior) to reduce misses
    // and avoid expensive JS-side fallback.
    const double EPS_T = 1e-10;
    const double EPS_DIRZ = 1e-14;
    const double EPS_R = 1e-14;
    const double EPS_DFDT = 1e-14;

    double guesses[10];
    int gCount = 0;

    // 1) Sphere approximation candidates (both roots, nearest first)
    if (isfinite(radius) && radius != 0.0) {
        double cz = radius;
        double A = dx*dx + dy*dy + dz*dz;
        if (A != 0.0) {
            double B = 2.0 * (ox*dx + oy*dy + (oz - cz)*dz);
            double C = ox*ox + oy*oy + (oz - cz)*(oz - cz) - radius*radius;
            double D = B*B - 4.0*A*C;
            if (D >= 0.0) {
                double sD = sqrt(D);
                double t1 = (-B - sD) / (2.0*A);
                double t2 = (-B + sD) / (2.0*A);
                // push positive candidates (prioritize closer intersection)
                if (t1 > EPS_T) guesses[gCount++] = t1;
                if (t2 > EPS_T && t2 != t1) guesses[gCount++] = t2;
            }
        }
    }

    // 2) Plane z=0 approximation
    if (fabs(dz) > EPS_DIRZ) {
        double tp = -oz / dz;
        if (tp > EPS_T && gCount < 10) guesses[gCount++] = tp;
    }

    // ✅ Optimization: Reduce initial guesses to most promising 3-4 candidates
    // Skip semidia-based and fallback guesses unless first attempts fail

    // Newton solve from each guess; return first converged hit.
    for (int gi = 0; gi < gCount; gi++) {
        double t = guesses[gi];
        if (!(t > 0.0) || !isfinite(t)) continue;

        for (int i = 0; i < maxIter; i++) {
            double x = ox + dx * t;
            double y = oy + dy * t;
            double z = oz + dz * t;
            double r2 = x*x + y*y;
            double r = sqrt(r2);

            // ✅ Optimization: Combined SAG and derivative calculation
            // Compute SAG value
            double sag, dzdr_base, dzdr_poly;
            
            // Base conic term and its derivative in one pass
            if (isfinite(radius) && radius != 0.0) {
                double R = radius;
                double term = (1.0 + conic) * r2 / (R * R);
                double sqrtTerm;
                if (term < 1.0) {
                    sqrtTerm = sqrt(1.0 - term);
                    double denom = R * (1.0 + sqrtTerm);
                    // SAG: r^2 / (R * (1 + sqrt(...)))
                    sag = r2 / denom;
                    // Derivative: reuse sqrtTerm
                    if (r > 0.0 && sqrtTerm > 0.0) {
                        double sqrtDer = (1.0 + conic) * r / (R * R * sqrtTerm);
                        dzdr_base = (2.0 * r * denom - r2 * R * sqrtDer) / (denom * denom);
                    } else {
                        dzdr_base = 0.0;
                    }
                } else {
                    sag = (term >= 1.0 && isfinite(R)) ? 0.0 : 0.0;
                    dzdr_base = (R != 0.0) ? (1.0 / R) : 0.0;
                }
            } else {
                sag = 0.0;
                dzdr_base = 0.0;
            }

            // Polynomial terms (inline to avoid function call overhead)
            double asphere = __rt10_asphere_poly(r, r2, coef1, coef2, coef3, coef4, coef5, 
                                                 coef6, coef7, coef8, coef9, coef10, modeOdd);
            sag += asphere;
            dzdr_poly = __rt10_asphere_dzdr(r, r2, coef1, coef2, coef3, coef4, coef5,
                                           coef6, coef7, coef8, coef9, coef10, modeOdd);
            
            double F = z - sag;
            if (fabs(F) < tol) {
                if (isfinite(semidia) && semidia > 0.0) {
                    if (r > semidia) break; // try next initial guess
                }
                return (t > 0.0) ? t : -1.0;
            }

            double dzdr = dzdr_base + dzdr_poly;

            double drdt = 0.0;
            if (r > EPS_R) {
                drdt = (x * dx + y * dy) / r;
            }
            double dFdt = dz - dzdr * drdt;
            if (!isfinite(dFdt) || fabs(dFdt) < EPS_DFDT) break;

            double step = F / dFdt;
            if (!isfinite(step)) break;
            t -= step;
            if (!(t > 0.0)) break;
        }
    }

    return -1.0;
}

/**
 * ray-tracing.js互換: 非球面交点探索（WASM内リトライ統合版）
 * - 1回目の設定で失敗した場合のみ、2回目の設定で再試行する。
 * - JS側の strict mode 再試行をWASM内に寄せ、境界呼び出し回数を削減する。
 */
EMSCRIPTEN_KEEPALIVE
double intersect_aspheric_rt10_with_retry(
    double ox, double oy, double oz,
    double dx, double dy, double dz,
    double semidia,
    double radius, double conic,
    double coef1, double coef2, double coef3, double coef4, double coef5,
    double coef6, double coef7, double coef8, double coef9, double coef10,
    int modeOdd,
    int maxIter1,
    double tol1,
    int maxIter2,
    double tol2
) {
    double t1 = intersect_aspheric_rt10(
        ox, oy, oz,
        dx, dy, dz,
        semidia,
        radius, conic,
        coef1, coef2, coef3, coef4, coef5,
        coef6, coef7, coef8, coef9, coef10,
        modeOdd,
        maxIter1,
        tol1
    );
    if (isfinite(t1) && t1 > 0.0) {
        return t1;
    }

    double t2 = intersect_aspheric_rt10(
        ox, oy, oz,
        dx, dy, dz,
        semidia,
        radius, conic,
        coef1, coef2, coef3, coef4, coef5,
        coef6, coef7, coef8, coef9, coef10,
        modeOdd,
        maxIter2,
        tol2
    );
    if (isfinite(t2) && t2 > 0.0) {
        return t2;
    }
    return -1.0;
}

/**
 * ray-tracing.js互換: 非球面サーフェス交点探索のバッチ版
 *
 * 入力rayはAoS配列: [ox, oy, oz, dx, dy, dz] * count
 * 出力tも配列: out_t[i] (失敗は-1)
 */
EMSCRIPTEN_KEEPALIVE
void batch_intersect_aspheric_rt10(
    const double* rays_ptr,
    int count,
    double semidia,
    double radius,
    double conic,
    double coef1,
    double coef2,
    double coef3,
    double coef4,
    double coef5,
    double coef6,
    double coef7,
    double coef8,
    double coef9,
    double coef10,
    int modeOdd,
    int maxIter,
    double tol,
    double* out_t_ptr
) {
    if (!rays_ptr || !out_t_ptr || count <= 0) return;

    for (int i = 0; i < count; i++) {
        const int j = i * 6;
        const double ox = rays_ptr[j + 0];
        const double oy = rays_ptr[j + 1];
        const double oz = rays_ptr[j + 2];
        const double dx = rays_ptr[j + 3];
        const double dy = rays_ptr[j + 4];
        const double dz = rays_ptr[j + 5];

        out_t_ptr[i] = intersect_aspheric_rt10(
            ox, oy, oz,
            dx, dy, dz,
            semidia,
            radius,
            conic,
            coef1,
            coef2,
            coef3,
            coef4,
            coef5,
            coef6,
            coef7,
            coef8,
            coef9,
            coef10,
            modeOdd,
            maxIter,
            tol
        );
    }
}

/**
 * 対称正定値連立方程式をCholesky分解で解く
 *
 * Solve A x = b, where A is symmetric positive definite.
 *
 * @param A_ptr 入力行列A（row-major, n*n）
 * @param b_ptr 右辺ベクトルb（n）
 * @param n 行列サイズ
 * @param x_ptr 解ベクトルx（n）
 * @return 1=成功, 0=失敗
 */
EMSCRIPTEN_KEEPALIVE
int solve_spd_cholesky(const double* A_ptr, const double* b_ptr, int n, double* x_ptr) {
    if (!A_ptr || !b_ptr || !x_ptr || n <= 0) return 0;

    const int nn = n * n;
    double* L = (double*)malloc((size_t)nn * sizeof(double));
    double* y = (double*)malloc((size_t)n * sizeof(double));
    if (!L || !y) {
        if (L) free(L);
        if (y) free(y);
        return 0;
    }

    for (int i = 0; i < nn; i++) L[i] = 0.0;

    // Cholesky decomposition: A = L * L^T
    for (int i = 0; i < n; i++) {
        for (int j = 0; j <= i; j++) {
            double sum = 0.0;
            for (int k = 0; k < j; k++) {
                sum += L[i * n + k] * L[j * n + k];
            }

            const double aij = A_ptr[i * n + j];
            if (!isfinite(aij)) {
                free(L);
                free(y);
                return 0;
            }

            if (i == j) {
                const double d = aij - sum;
                if (!(d > 0.0) || !isfinite(d)) {
                    free(L);
                    free(y);
                    return 0;
                }
                L[i * n + j] = sqrt(d);
            } else {
                const double ljj = L[j * n + j];
                if (!(ljj > 0.0) || !isfinite(ljj)) {
                    free(L);
                    free(y);
                    return 0;
                }
                L[i * n + j] = (aij - sum) / ljj;
            }
        }
    }

    // Forward substitution: L y = b
    for (int i = 0; i < n; i++) {
        double sum = 0.0;
        for (int j = 0; j < i; j++) {
            sum += L[i * n + j] * y[j];
        }
        const double lii = L[i * n + i];
        if (!(lii > 0.0) || !isfinite(lii)) {
            free(L);
            free(y);
            return 0;
        }
        const double bi = b_ptr[i];
        if (!isfinite(bi)) {
            free(L);
            free(y);
            return 0;
        }
        y[i] = (bi - sum) / lii;
    }

    // Back substitution: L^T x = y
    for (int i = n - 1; i >= 0; i--) {
        double sum = 0.0;
        for (int j = i + 1; j < n; j++) {
            sum += L[j * n + i] * x_ptr[j];
        }
        const double lii = L[i * n + i];
        if (!(lii > 0.0) || !isfinite(lii)) {
            free(L);
            free(y);
            return 0;
        }
        x_ptr[i] = (y[i] - sum) / lii;
        if (!isfinite(x_ptr[i])) {
            free(L);
            free(y);
            return 0;
        }
    }

    free(L);
    free(y);
    return 1;
}

static inline void __rt_mat3_mul_vec3(const double* m, double x, double y, double z, double* out3) {
    out3[0] = m[0] * x + m[1] * y + m[2] * z;
    out3[1] = m[3] * x + m[4] * y + m[5] * z;
    out3[2] = m[6] * x + m[7] * y + m[8] * z;
}

static inline int __rt_normalize3(double* x, double* y, double* z) {
    const double n2 = (*x) * (*x) + (*y) * (*y) + (*z) * (*z);
    if (!(n2 > 0.0) || !isfinite(n2)) return 0;
    const double inv = 1.0 / sqrt(n2);
    *x *= inv; *y *= inv; *z *= inv;
    return 1;
}

static inline int __rt_refract3(double ix, double iy, double iz,
                                double nx, double ny, double nz,
                                double n1, double n2,
                                double* ox, double* oy, double* oz) {
    if (!(n1 > 0.0) || !(n2 > 0.0)) return 0;
    double cosi = -(ix * nx + iy * ny + iz * nz);
    double nnx = nx, nny = ny, nnz = nz;
    if (cosi < 0.0) {
        cosi = -cosi;
        nnx = -nnx; nny = -nny; nnz = -nnz;
    }
    const double eta = n1 / n2;
    const double k = 1.0 - eta * eta * (1.0 - cosi * cosi);
    if (k < 0.0 || !isfinite(k)) return 0;
    const double c2 = sqrt(k);
    *ox = eta * ix + (eta * cosi - c2) * nnx;
    *oy = eta * iy + (eta * cosi - c2) * nny;
    *oz = eta * iz + (eta * cosi - c2) * nnz;
    return __rt_normalize3(ox, oy, oz);
}

static inline void __rt_reflect3(double ix, double iy, double iz,
                                 double nx, double ny, double nz,
                                 double* ox, double* oy, double* oz) {
    const double d = ix * nx + iy * ny + iz * nz;
    *ox = ix - 2.0 * d * nx;
    *oy = iy - 2.0 * d * ny;
    *oz = iz - 2.0 * d * nz;
    (void)__rt_normalize3(ox, oy, oz);
}

static inline double __rt_toric_sag(double x, double y,
                                    double radiusX, double radiusY,
                                    double conic, double axisDeg) {
    const double axisRad = axisDeg * (M_PI / 180.0);
    const double cosA = cos(axisRad);
    const double sinA = sin(axisRad);

    const double xRot = x * cosA + y * sinA;
    const double yRot = -x * sinA + y * cosA;
    const double x2 = xRot * xRot;
    const double y2 = yRot * yRot;

    double sagX = 0.0;
    if (isfinite(radiusX) && radiusX != 0.0) {
        const double absRx = fabs(radiusX);
        const double discX = 1.0 - (1.0 + conic) * x2 / (absRx * absRx);
        if (!isfinite(discX) || discX < 0.0) return NAN;
        const double sagXAbs = x2 / (absRx * (1.0 + sqrt(discX)));
        sagX = (radiusX > 0.0) ? sagXAbs : -sagXAbs;
    }

    double sagY = 0.0;
    if (isfinite(radiusY) && radiusY != 0.0) {
        const double absRy = fabs(radiusY);
        const double discY = 1.0 - (1.0 + conic) * y2 / (absRy * absRy);
        if (!isfinite(discY) || discY < 0.0) return NAN;
        const double sagYAbs = y2 / (absRy * (1.0 + sqrt(discY)));
        sagY = (radiusY > 0.0) ? sagYAbs : -sagYAbs;
    }

    return sagX + sagY;
}

static inline void __rt_toric_derivatives(double x, double y,
                                          double radiusX, double radiusY,
                                          double conic, double axisDeg,
                                          double* dzdx, double* dzdy) {
    const double axisRad = axisDeg * (M_PI / 180.0);
    const double cosA = cos(axisRad);
    const double sinA = sin(axisRad);

    const double xRot = x * cosA + y * sinA;
    const double yRot = -x * sinA + y * cosA;

    double dzdxRot = 0.0;
    if (isfinite(radiusX) && radiusX != 0.0) {
        const double absRx = fabs(radiusX);
        const double disc = 1.0 - (1.0 + conic) * (xRot * xRot) / (absRx * absRx);
        if (isfinite(disc) && disc > 0.0) {
            dzdxRot = xRot / (absRx * sqrt(disc));
            if (radiusX < 0.0) dzdxRot = -dzdxRot;
        }
    }

    double dzdyRot = 0.0;
    if (isfinite(radiusY) && radiusY != 0.0) {
        const double absRy = fabs(radiusY);
        const double disc = 1.0 - (1.0 + conic) * (yRot * yRot) / (absRy * absRy);
        if (isfinite(disc) && disc > 0.0) {
            dzdyRot = yRot / (absRy * sqrt(disc));
            if (radiusY < 0.0) dzdyRot = -dzdyRot;
        }
    }

    *dzdx = dzdxRot * cosA - dzdyRot * sinA;
    *dzdy = dzdxRot * sinA + dzdyRot * cosA;
}

static inline double __rt_intersect_toric(double ox, double oy, double oz,
                                          double dx, double dy, double dz,
                                          double radiusX, double radiusY,
                                          double conic, double axisDeg,
                                          double semidia,
                                          int maxIter, double tol) {
    if (!(maxIter > 0)) maxIter = 50;
    if (!(tol > 0.0)) tol = 1e-10;
    if (!isfinite(dx) || !isfinite(dy) || !isfinite(dz)) return -1.0;

    const double eps = 1e-12;
    double t = (fabs(dz) > eps) ? (-oz / dz) : 1e-3;
    if (!(t > 0.0) || !isfinite(t)) t = 1e-3;

    for (int it = 0; it < maxIter; it++) {
        const double x = ox + dx * t;
        const double y = oy + dy * t;
        const double z = oz + dz * t;
        const double sag = __rt_toric_sag(x, y, radiusX, radiusY, conic, axisDeg);
        if (!isfinite(sag)) return -1.0;
        const double F = z - sag;
        if (fabs(F) < tol) {
            if (isfinite(semidia) && semidia > 0.0) {
                const double rr = sqrt(x * x + y * y);
                if (rr > semidia) return -1.0;
            }
            return (t > 0.0) ? t : -1.0;
        }

        double dzdx = 0.0, dzdy = 0.0;
        __rt_toric_derivatives(x, y, radiusX, radiusY, conic, axisDeg, &dzdx, &dzdy);
        const double dFdt = dz - dzdx * dx - dzdy * dy;
        if (!isfinite(dFdt) || fabs(dFdt) < eps) return -1.0;
        const double dt = F / dFdt;
        if (!isfinite(dt)) return -1.0;
        t -= dt;
        if (!(t > 0.0)) return -1.0;
    }

    return -1.0;
}

/**
 * Full ray-tracing batch kernel
 * out layout per ray (6 doubles):
 *  [0]=status(1 ok, 2 invalid_input, 3 no_intersection, 4 aperture_block, 5 tir, 6 not_reached, 7 invalid_segment),
 *  [1]=oplMicrons,
 *  [2]=hitX,
 *  [3]=hitY,
 *  [4]=hitZ,
 *  [5]=reserved
 */
EMSCRIPTEN_KEEPALIVE
int trace_ray_batch_full(
    const double* rays_ptr,
    int ray_count,
    int target_surface_index,
    double n0,
    int row_count,
    const int* row_meta_ptr,
    const double* row_params_ptr,
    const double* row_origin_ptr,
    const double* row_rot_ptr,
    const double* row_invrot_ptr,
    double* out_ptr
) {
    if (!rays_ptr || !row_meta_ptr || !row_params_ptr || !row_origin_ptr || !row_rot_ptr || !row_invrot_ptr || !out_ptr) return 0;
    if (ray_count <= 0 || row_count <= 0 || target_surface_index < 0 || target_surface_index >= row_count) return 0;

    const int PSTRIDE = 24;
    const int KIND_OBJECT = 1;
    const int KIND_GAP = 2;
    const int KIND_COORD = 3;

    const int FLAG_MIRROR = 1;
    const int FLAG_PLANE = 2;
    const int FLAG_TORIC = 4;
    const int FLAG_IMAGE = 8;
    const int FLAG_RECT = 16;

    int* alive = (int*)malloc((size_t)ray_count * sizeof(int));
    double* state = (double*)malloc((size_t)ray_count * 9 * sizeof(double));
    if (!alive || !state) {
        if (alive) free(alive);
        if (state) free(state);
        return 0;
    }

    int aliveCount = 0;
    // Loop unrolling for ray initialization (process 4 at a time)
    int r;
    for (r = 0; r + 3 < ray_count; r += 4) {
        for (int unroll = 0; unroll < 4; unroll++) {
            const int idx = r + unroll;
            const int ri = idx * 6;
            const int si = idx * 9;
            const double px = rays_ptr[ri + 0];
            const double py = rays_ptr[ri + 1];
            const double pz = rays_ptr[ri + 2];
            double dx = rays_ptr[ri + 3];
            double dy = rays_ptr[ri + 4];
            double dz = rays_ptr[ri + 5];

            out_ptr[ri + 0] = 2.0;
            out_ptr[ri + 1] = NAN;
            out_ptr[ri + 2] = NAN;
            out_ptr[ri + 3] = NAN;
            out_ptr[ri + 4] = NAN;
            out_ptr[ri + 5] = 0.0;

            if (!isfinite(px) || !isfinite(py) || !isfinite(pz) || !isfinite(dx) || !isfinite(dy) || !isfinite(dz)) {
                alive[idx] = 0;
                continue;
            }

            if (!__rt_normalize3(&dx, &dy, &dz)) {
                alive[idx] = 0;
                out_ptr[ri + 0] = 2.0;
                continue;
            }

            alive[idx] = 1;
            aliveCount++;
            state[si + 0] = px;
            state[si + 1] = py;
            state[si + 2] = pz;
            state[si + 3] = dx;
            state[si + 4] = dy;
            state[si + 5] = dz;
            state[si + 6] = (isfinite(n0) && n0 > 0.0) ? n0 : 1.0;
            state[si + 7] = 0.0;
            state[si + 8] = 0.0;
            out_ptr[ri + 0] = 6.0;
            out_ptr[ri + 1] = 0.0;
        }
    }
    // Handle remaining rays
    for (; r < ray_count; r++) {
        const int ri = r * 6;
        const int si = r * 9;
        const double px = rays_ptr[ri + 0];
        const double py = rays_ptr[ri + 1];
        const double pz = rays_ptr[ri + 2];
        double dx = rays_ptr[ri + 3];
        double dy = rays_ptr[ri + 4];
        double dz = rays_ptr[ri + 5];

        out_ptr[ri + 0] = 2.0;
        out_ptr[ri + 1] = NAN;
        out_ptr[ri + 2] = NAN;
        out_ptr[ri + 3] = NAN;
        out_ptr[ri + 4] = NAN;
        out_ptr[ri + 5] = 0.0;

        if (!isfinite(px) || !isfinite(py) || !isfinite(pz) || !isfinite(dx) || !isfinite(dy) || !isfinite(dz)) {
            alive[r] = 0;
            continue;
        }

        if (!__rt_normalize3(&dx, &dy, &dz)) {
            alive[r] = 0;
            out_ptr[ri + 0] = 2.0;
            continue;
        }

        alive[r] = 1;
        aliveCount++;
        state[si + 0] = px;
        state[si + 1] = py;
        state[si + 2] = pz;
        state[si + 3] = dx;
        state[si + 4] = dy;
        state[si + 5] = dz;
        state[si + 6] = (isfinite(n0) && n0 > 0.0) ? n0 : 1.0;
        state[si + 7] = 0.0;
        state[si + 8] = 0.0;
        out_ptr[ri + 0] = 6.0; // not reached yet
        out_ptr[ri + 1] = 0.0;
    }

    for (int row = 0; row < row_count; row++) {
        // Early exit if no rays are alive
        if (aliveCount == 0) break;

        const int metaIdx = row * 4;
        const int kind = row_meta_ptr[metaIdx + 0];
        const int flags = row_meta_ptr[metaIdx + 1];

        const int pidx = row * PSTRIDE;
        const double radius = row_params_ptr[pidx + 0];
        const double conic = row_params_ptr[pidx + 1];
        const double coef1 = row_params_ptr[pidx + 2];
        const double coef2 = row_params_ptr[pidx + 3];
        const double coef3 = row_params_ptr[pidx + 4];
        const double coef4 = row_params_ptr[pidx + 5];
        const double coef5 = row_params_ptr[pidx + 6];
        const double coef6 = row_params_ptr[pidx + 7];
        const double coef7 = row_params_ptr[pidx + 8];
        const double coef8 = row_params_ptr[pidx + 9];
        const double coef9 = row_params_ptr[pidx + 10];
        const double coef10 = row_params_ptr[pidx + 11];
        const double semidia = row_params_ptr[pidx + 12];
        const double toricRadiusX = row_params_ptr[pidx + 13];
        const double toricRadiusY = row_params_ptr[pidx + 14];
        const double toricAxis = row_params_ptr[pidx + 15];
        const double thickness = row_params_ptr[pidx + 16];
        const double apertureLimit = row_params_ptr[pidx + 17];
        const double rectHalfW = row_params_ptr[pidx + 18];
        const double rectHalfH = row_params_ptr[pidx + 19];
        const double n2Row = row_params_ptr[pidx + 20];

        const double* origin = &row_origin_ptr[row * 3];
        const double* rot = &row_rot_ptr[row * 9];
        const double* invrot = &row_invrot_ptr[row * 9];

        if (kind == KIND_COORD) {
            if (isfinite(n2Row) && n2Row > 0.0) {
                for (int r = 0; r < ray_count; r++) {
                    if (!alive[r]) continue;
                    state[r * 9 + 6] = n2Row;
                }
            }
            continue;
        }

        if (kind == KIND_OBJECT || kind == KIND_GAP) {
            for (int r = 0; r < ray_count; r++) {
                if (!alive[r]) continue;
                int si = r * 9;
                const double ncur = state[si + 6];
                if (isfinite(thickness) && thickness != 0.0 && isfinite(ncur) && ncur > 0.0) {
                    state[si + 7] += fabs(thickness) * 1000.0 * ncur;
                    state[si + 0] += state[si + 3] * thickness;
                    state[si + 1] += state[si + 4] * thickness;
                    state[si + 2] += state[si + 5] * thickness;
                }
                if (isfinite(n2Row) && n2Row > 0.0) {
                    state[si + 6] = n2Row;
                }
            }
            continue;
        }

        for (int r = 0; r < ray_count; r++) {
            if (!alive[r]) continue;

            const int si = r * 9;
            const int oi = r * 6;

            const double px = state[si + 0];
            const double py = state[si + 1];
            const double pz = state[si + 2];
            const double dxg = state[si + 3];
            const double dyg = state[si + 4];
            const double dzg = state[si + 5];

            double pLocal[3], dLocal[3];
            __rt_mat3_mul_vec3(invrot, px - origin[0], py - origin[1], pz - origin[2], pLocal);
            __rt_mat3_mul_vec3(invrot, dxg, dyg, dzg, dLocal);

            double tHit = -1.0;
            if ((flags & FLAG_PLANE) != 0) {
                const double eps = 1e-9;
                if (fabs(dLocal[2]) > eps) {
                    tHit = -pLocal[2] / dLocal[2];
                    if (!isfinite(tHit) || tHit <= 0.0) tHit = -1.0;
                }
            } else if ((flags & FLAG_TORIC) != 0) {
                tHit = __rt_intersect_toric(
                    pLocal[0], pLocal[1], pLocal[2],
                    dLocal[0], dLocal[1], dLocal[2],
                    toricRadiusX, toricRadiusY,
                    conic, toricAxis,
                    semidia,
                    50, 1e-10
                );
            } else {
                tHit = intersect_aspheric_rt10(
                    pLocal[0], pLocal[1], pLocal[2],
                    dLocal[0], dLocal[1], dLocal[2],
                    semidia,
                    radius, conic,
                    coef1, coef2, coef3, coef4, coef5,
                    coef6, coef7, coef8, coef9, coef10,
                    0,
                    20,
                    1e-7
                );
            }

            if (!(isfinite(tHit) && tHit > 0.0)) {
                alive[r] = 0;
                aliveCount--;
                out_ptr[oi + 0] = 3.0;
                out_ptr[oi + 1] = state[si + 7];
                continue;
            }

            const double hxL = pLocal[0] + dLocal[0] * tHit;
            const double hyL = pLocal[1] + dLocal[1] * tHit;
            const double hzL = pLocal[2] + dLocal[2] * tHit;

            if ((flags & FLAG_RECT) != 0) {
                if (isfinite(rectHalfW) && isfinite(rectHalfH) && (fabs(hxL) > rectHalfW || fabs(hyL) > rectHalfH)) {
                    alive[r] = 0;
                    aliveCount--;
                    out_ptr[oi + 0] = 4.0;
                    out_ptr[oi + 1] = state[si + 7];
                    continue;
                }
            } else if (isfinite(apertureLimit) && apertureLimit > 0.0) {
                const double hr = sqrt(hxL * hxL + hyL * hyL);
                if (hr > apertureLimit) {
                    alive[r] = 0;
                    aliveCount--;
                    out_ptr[oi + 0] = 4.0;
                    out_ptr[oi + 1] = state[si + 7];
                    continue;
                }
            }

            double hitGlobal[3];
            __rt_mat3_mul_vec3(rot, hxL, hyL, hzL, hitGlobal);
            hitGlobal[0] += origin[0];
            hitGlobal[1] += origin[1];
            hitGlobal[2] += origin[2];

            const double sx = state[si + 0], sy = state[si + 1], sz = state[si + 2];
            const double dx_seg = hitGlobal[0] - sx;
            const double dy_seg = hitGlobal[1] - sy;
            const double dz_seg = hitGlobal[2] - sz;
            const double seg = sqrt(dx_seg * dx_seg + dy_seg * dy_seg + dz_seg * dz_seg);
            if (!isfinite(seg) || seg < 0.0) {
                alive[r] = 0;
                aliveCount--;
                out_ptr[oi + 0] = 7.0;
                out_ptr[oi + 1] = state[si + 7];
                continue;
            }

            const double ncur = state[si + 6];
            if (isfinite(ncur) && ncur > 0.0) {
                state[si + 7] += seg * 1000.0 * ncur;
            }

            state[si + 0] = hitGlobal[0];
            state[si + 1] = hitGlobal[1];
            state[si + 2] = hitGlobal[2];

            if (row == target_surface_index) {
                alive[r] = 0;
                aliveCount--;
                out_ptr[oi + 0] = 1.0;
                out_ptr[oi + 1] = state[si + 7];
                out_ptr[oi + 2] = hitGlobal[0];
                out_ptr[oi + 3] = hitGlobal[1];
                out_ptr[oi + 4] = hitGlobal[2];
                continue;
            }

            double nxL = 0.0, nyL = 0.0, nzL = 1.0;
            if ((flags & FLAG_PLANE) != 0) {
                nzL = (dLocal[2] > 0.0) ? -1.0 : 1.0;
            } else if ((flags & FLAG_TORIC) != 0) {
                double dzdx = 0.0, dzdy = 0.0;
                __rt_toric_derivatives(hxL, hyL, toricRadiusX, toricRadiusY, conic, toricAxis, &dzdx, &dzdy);
                nxL = -dzdx;
                nyL = -dzdy;
                nzL = 1.0;
                if (!__rt_normalize3(&nxL, &nyL, &nzL)) {
                    nxL = 0.0; nyL = 0.0; nzL = 1.0;
                }
            } else {
                const double r2 = hxL * hxL + hyL * hyL;
                const double rr = sqrt(r2);
                double dzdr_base = 0.0;
                if (isfinite(radius) && radius != 0.0 && rr > 0.0) {
                    const double R = radius;
                    const double term = (1.0 + conic) * r2 / (R * R);
                    if (term < 1.0) {
                        const double sqrtTerm = sqrt(1.0 - term);
                        if (sqrtTerm > 0.0) {
                            const double denom = R * (1.0 + sqrtTerm);
                            const double sqrtDer = (1.0 + conic) * rr / (R * R * sqrtTerm);
                            dzdr_base = (2.0 * rr * denom - r2 * R * sqrtDer) / (denom * denom);
                        }
                    } else {
                        dzdr_base = 1.0 / R;
                    }
                }
                const double dzdr_poly = __rt10_asphere_dzdr(rr, r2,
                    coef1, coef2, coef3, coef4, coef5,
                    coef6, coef7, coef8, coef9, coef10,
                    0);
                const double dzdr = dzdr_base + dzdr_poly;
                if (rr > 1e-12) {
                    nxL = -dzdr * (hxL / rr);
                    nyL = -dzdr * (hyL / rr);
                    nzL = 1.0;
                    if (!__rt_normalize3(&nxL, &nyL, &nzL)) {
                        nxL = 0.0; nyL = 0.0; nzL = 1.0;
                    }
                }
            }

            if (dLocal[0] * nxL + dLocal[1] * nyL + dLocal[2] * nzL > 0.0) {
                nxL = -nxL; nyL = -nyL; nzL = -nzL;
            }

            double nGlobal[3];
            __rt_mat3_mul_vec3(rot, nxL, nyL, nzL, nGlobal);
            if (!__rt_normalize3(&nGlobal[0], &nGlobal[1], &nGlobal[2])) {
                nGlobal[0] = 0.0; nGlobal[1] = 0.0; nGlobal[2] = 1.0;
            }

            if ((flags & FLAG_MIRROR) != 0) {
                if (dLocal[0] * nxL + dLocal[1] * nyL + dLocal[2] * nzL < 0.0) {
                    __rt_reflect3(state[si + 3], state[si + 4], state[si + 5],
                                  nGlobal[0], nGlobal[1], nGlobal[2],
                                  &state[si + 3], &state[si + 4], &state[si + 5]);
                }
            } else {
                double rx = 0.0, ry = 0.0, rz = 0.0;
                const double n1 = state[si + 6];
                const double n2 = (isfinite(n2Row) && n2Row > 0.0) ? n2Row : n1;
                if (!__rt_refract3(state[si + 3], state[si + 4], state[si + 5],
                                   nGlobal[0], nGlobal[1], nGlobal[2],
                                   n1, n2,
                                   &rx, &ry, &rz)) {
                    alive[r] = 0;
                    aliveCount--;
                    out_ptr[oi + 0] = 5.0;
                    out_ptr[oi + 1] = state[si + 7];
                    continue;
                }
                state[si + 3] = rx;
                state[si + 4] = ry;
                state[si + 5] = rz;
                state[si + 6] = n2;
            }

            if (isfinite(thickness) && thickness != 0.0) {
                const double nmid = state[si + 6];
                if (isfinite(nmid) && nmid > 0.0) {
                    state[si + 7] += fabs(thickness) * 1000.0 * nmid;
                }
                state[si + 0] += state[si + 3] * thickness;
                state[si + 1] += state[si + 4] * thickness;
                state[si + 2] += state[si + 5] * thickness;
            }
        }
    }

    for (int r = 0; r < ray_count; r++) {
        const int oi = r * 6;
        const int si = r * 9;
        if (out_ptr[oi + 0] == 1.0) continue;
        if (out_ptr[oi + 0] == 2.0) continue;
        if (out_ptr[oi + 0] == 3.0 || out_ptr[oi + 0] == 4.0 || out_ptr[oi + 0] == 5.0 || out_ptr[oi + 0] == 7.0) continue;
        out_ptr[oi + 0] = 6.0;
        out_ptr[oi + 1] = state[si + 7];
    }

    free(alive);
    free(state);
    return 1;
}
