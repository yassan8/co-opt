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
                // push positive candidates
                if (t1 > EPS_T) guesses[gCount++] = t1;
                if (t2 > EPS_T) guesses[gCount++] = t2;
                // sort two items if needed
                if (gCount >= 2) {
                    if (guesses[0] > guesses[1]) {
                        double tmp = guesses[0]; guesses[0] = guesses[1]; guesses[1] = tmp;
                    }
                }
            }
        }
    }

    // 2) Plane z=0 approximation
    if (fabs(dz) > EPS_DIRZ) {
        double tp = -oz / dz;
        if (tp > EPS_T && gCount < 10) guesses[gCount++] = tp;
    }

    // 3) Semidia-based guesses (aim for edge)
    if (isfinite(semidia) && semidia > 0.0 && gCount < 10) {
        double curR = sqrt(ox*ox + oy*oy);
        double dirR = sqrt(dx*dx + dy*dy);
        if (dirR > EPS_R) {
            double targetR1 = semidia * 0.8;
            double targetR2 = semidia * 1.0;
            if (targetR1 > curR && gCount < 10) {
                double ts = (targetR1 - curR) / dirR;
                if (ts > EPS_T) guesses[gCount++] = ts;
            }
            if (targetR2 > curR && gCount < 10) {
                double ts = (targetR2 - curR) / dirR;
                if (ts > EPS_T) guesses[gCount++] = ts;
            }
        }
    }

    // 4) Fallback ladder
    if (gCount == 0) {
        guesses[gCount++] = 1e-6;
        guesses[gCount++] = 1e-4;
        guesses[gCount++] = 1e-2;
    }

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

            double sag = aspheric_sag_rt10(r, radius, conic,
                                           coef1, coef2, coef3, coef4, coef5,
                                           coef6, coef7, coef8, coef9, coef10,
                                           modeOdd);
            double F = z - sag;
            if (fabs(F) < tol) {
                if (isfinite(semidia) && semidia > 0.0) {
                    if (r > semidia) break; // try next initial guess
                }
                return (t > 0.0) ? t : -1.0;
            }

            // dz/dr for base conic term
            double dzdr_base = 0.0;
            if (isfinite(radius) && radius != 0.0 && r > 0.0) {
                double R = radius;
                double term = (1.0 + conic) * r2 / (R * R);
                if (term < 1.0) {
                    double sqrtTerm = sqrt(1.0 - term);
                    if (sqrtTerm > 0.0) {
                        double denom = R * (1.0 + sqrtTerm);
                        double sqrtDer = (1.0 + conic) * r / (R * R * sqrtTerm);
                        dzdr_base = (2.0 * r * denom - r2 * R * sqrtDer) / (denom * denom);
                    }
                } else {
                    dzdr_base = 1.0 / R;
                }
            }

            double dzdr_poly = __rt10_asphere_dzdr(r, r2,
                                                   coef1, coef2, coef3, coef4, coef5,
                                                   coef6, coef7, coef8, coef9, coef10,
                                                   modeOdd);
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
