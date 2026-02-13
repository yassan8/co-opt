/**
 * PSF Calculator WebAssembly Module (Optimized)
 * 高速PSF計算のためのC実装（最適化版）
 * 
 * 主要機能:
 * - 2D FFT (Cooley-Tukey algorithm, cache-optimized)
 * - 複素振幅計算（SIMD対応）
 * - 格子補間（効率化）
 * - 統計計算 (Strehl ratio, Encircled energy)
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// コンパイラ最適化ヒント
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// 高精度時間測定（WebAssembly用）
double get_time_ms() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1000000.0;
#endif
}

// 定数定義
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define LARGE_NUMBER 1e10  // INFINITYの代わり

// 複素数構造体（メモリアライメント最適化）
typedef struct {
    double real;
    double imag;
} Complex;

// PSF計算結果構造体
typedef struct {
    double* intensity;
    double strehl_ratio;
    double fwhm_x;
    double fwhm_y;
    double* encircled_energy;
    int size;
} PSFResult;

// 関数プロトタイプ宣言
void fft_1d(Complex* data, int n, int inverse);
void fft_1d_iterative(Complex* data, int n, int inverse);
void fft_1d_divide_conquer(Complex* data, int n, int inverse);
void fft_2d(Complex* data, int width, int height, int inverse);
// Removed fft_2d_blocked for simplicity
void transpose_complex(Complex* src, Complex* dst, int width, int height);
void transpose_complex_inplace(Complex* data, int size);
void calculate_complex_amplitude(double* opd, double* amplitude, int* pupil_mask, 
                                Complex* output, int size, double wavelength);
void interpolate_opd_grid(double* ray_x, double* ray_y, double* ray_opd, int ray_count,
                         double* grid_opd, int* pupil_mask, int grid_size,
                         double min_x, double max_x, double min_y, double max_y);
void fft_shift(double* data, int size);
double calculate_strehl_ratio(double* psf, int size);
void calculate_encircled_energy(double* psf, int size, double* radii, double* energies, int radii_count);
void init_fast_trig_tables(int max_size);
void init_twiddle_table(int max_size);
static double fast_sin(double x);
static double fast_cos(double x);
double* calculate_mtf_axes_from_psf_wasm(double* psf, int size, int k_max);

/**
 * FFTシフト（DC成分を中央に移動）
 * @param data 実数配列
 * @param size 配列サイズ（size × size）
 */
void fft_shift(double* data, int size) {
    int half = size / 2;
    
    for (int i = 0; i < half; i++) {
        for (int j = 0; j < half; j++) {
            // 第1象限と第3象限を交換
            double temp = data[i * size + j];
            data[i * size + j] = data[(i + half) * size + (j + half)];
            data[(i + half) * size + (j + half)] = temp;
            
            // 第2象限と第4象限を交換
            temp = data[i * size + (j + half)];
            data[i * size + (j + half)] = data[(i + half) * size + j];
            data[(i + half) * size + j] = temp;
        }
    }
}

// 三角関数テーブル（事前計算）
static Complex* twiddle_table = NULL;
static int twiddle_table_size = 0;

// 高速sin/cosテーブル用
static double* sin_table = NULL;
static double* cos_table = NULL;
static int trig_table_size = 0;

// FFT用の一時バッファを再利用（malloc/freeオーバーヘッド削減）
static Complex* fft_temp_buffer = NULL;
static size_t fft_temp_capacity = 0; // 要素数（Complex単位）

static inline void ensure_fft_temp_buffer(size_t need_elements) {
    if (fft_temp_capacity < need_elements) {
        if (fft_temp_buffer) {
            free(fft_temp_buffer);
            fft_temp_buffer = NULL;
            fft_temp_capacity = 0;
        }
        fft_temp_buffer = (Complex*)malloc(need_elements * sizeof(Complex));
        if (fft_temp_buffer) {
            fft_temp_capacity = need_elements;
        }
    }
}

/**
 * 高速三角関数テーブルの初期化
 */
void init_fast_trig_tables(int max_size) {
    if (sin_table) {
        free(sin_table);
        free(cos_table);
    }
    
    trig_table_size = max_size * 4; // オーバーサンプリング
    sin_table = (double*)malloc(trig_table_size * sizeof(double));
    cos_table = (double*)malloc(trig_table_size * sizeof(double));
    
    for (int i = 0; i < trig_table_size; i++) {
        double angle = 2.0 * M_PI * i / trig_table_size;
        sin_table[i] = sin(angle);
        cos_table[i] = cos(angle);
    }
}

/**
 * 高速sin関数（テーブル参照）
 */
static inline double fast_sin(double x) {
    if (!sin_table) return sin(x);

    // 角度を正規化（O(1)での範囲縮約）
    // NOTE: while で 2π を足し引きすると |x| が大きいケースで計算が破綻する。
    if (!isfinite(x)) return 0.0;
    x = fmod(x, 2.0 * M_PI);
    if (x < 0) x += 2.0 * M_PI;
    
    int index = (int)((x / (2.0 * M_PI)) * trig_table_size);
    if (index >= trig_table_size) index = trig_table_size - 1;
    
    return sin_table[index];
}

/**
 * 高速cos関数（テーブル参照）
 */
static inline double fast_cos(double x) {
    if (!cos_table) return cos(x);

    // 角度を正規化（O(1)での範囲縮約）
    // NOTE: while で 2π を足し引きすると |x| が大きいケースで計算が破綻する。
    if (!isfinite(x)) return 1.0;
    x = fmod(x, 2.0 * M_PI);
    if (x < 0) x += 2.0 * M_PI;
    
    int index = (int)((x / (2.0 * M_PI)) * trig_table_size);
    if (index >= trig_table_size) index = trig_table_size - 1;
    
    return cos_table[index];
}

/**
 * 三角関数テーブルの初期化
 */
void init_twiddle_table(int max_size) {
    if (twiddle_table) {
        free(twiddle_table);
    }
    
    twiddle_table_size = max_size;
    twiddle_table = (Complex*)malloc(max_size * sizeof(Complex));
    
    for (int i = 0; i < max_size; i++) {
        double angle = -2.0 * M_PI * i / max_size;
        twiddle_table[i].real = fast_cos(angle);
        twiddle_table[i].imag = fast_sin(angle);
    }
}

/**
 * 分割統治FFT（大サイズ用最適化）
 * @param data 複素数配列
 * @param n サイズ（2の冪乗）
 * @param inverse 0:順変換, 1:逆変換
 */
void fft_1d_divide_conquer(Complex* data, int n, int inverse) {
    if (n <= 1) return;
    
    // 小さなサイズは従来のFFTを使用
    if (n <= 64) {
        fft_1d_iterative(data, n, inverse);
        return;
    }
    
    // 分割統治アプローチ
    const int half = n / 2;
    Complex* even = (Complex*)malloc(half * sizeof(Complex));
    Complex* odd = (Complex*)malloc(half * sizeof(Complex));
    
    if (!even || !odd) {
        if (even) free(even);
        if (odd) free(odd);
        return;
    }
    
    // 偶数・奇数に分割
    for (int i = 0; i < half; i++) {
        even[i] = data[2 * i];
        odd[i] = data[2 * i + 1];
    }
    
    // 再帰的にFFT
    fft_1d_divide_conquer(even, half, inverse);
    fft_1d_divide_conquer(odd, half, inverse);
    
    // 結合
    for (int k = 0; k < half; k++) {
        double angle = (inverse ? 2.0 : -2.0) * M_PI * k / n;
        Complex w = {fast_cos(angle), fast_sin(angle)};
        
        Complex t = {
            w.real * odd[k].real - w.imag * odd[k].imag,
            w.real * odd[k].imag + w.imag * odd[k].real
        };
        
        data[k] = (Complex){even[k].real + t.real, even[k].imag + t.imag};
        data[k + half] = (Complex){even[k].real - t.real, even[k].imag - t.imag};
    }
    
    free(even);
    free(odd);
}

/**
 * 反復版FFT（小サイズ用）
 */
void fft_1d_iterative(Complex* data, int n, int inverse) {
    // 必要に応じてテーブル初期化
    if (!twiddle_table || twiddle_table_size < n) {
        init_twiddle_table(n);
    }
    
    // ビット反転（最適化版）
    int j = 0;
    for (int i = 1; i < n; i++) {
        int bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        
        if (i < j) {
            // SIMDフレンドリーなスワップ
            Complex temp = data[i];
            data[i] = data[j];
            data[j] = temp;
        }
    }
    
    // FFT計算（テーブル参照版）
    for (int len = 2; len <= n; len <<= 1) {
        int step = n / len;
        
        for (int i = 0; i < n; i += len) {
            for (int j = 0; j < len / 2; j++) {
                // テーブル参照
                int twiddle_idx = j * step;
                if (inverse) twiddle_idx = n - twiddle_idx;
                if (twiddle_idx >= n) twiddle_idx -= n;
                
                Complex w = twiddle_table[twiddle_idx];
                
                Complex u = data[i + j];
                Complex v = {
                    data[i + j + len / 2].real * w.real - data[i + j + len / 2].imag * w.imag,
                    data[i + j + len / 2].real * w.imag + data[i + j + len / 2].imag * w.real
                };
                
                // バタフライ演算（SIMDフレンドリー）
                data[i + j].real = u.real + v.real;
                data[i + j].imag = u.imag + v.imag;
                data[i + j + len / 2].real = u.real - v.real;
                data[i + j + len / 2].imag = u.imag - v.imag;
            }
        }
    }
    
    // 逆変換の場合は正規化
    if (inverse) {
        double inv_n = 1.0 / n;
        for (int i = 0; i < n; i++) {
            data[i].real *= inv_n;
            data[i].imag *= inv_n;
        }
    }
}

/**
 * 最適化された1D FFT（基本版に戻す）
 */
void fft_1d(Complex* data, int n, int inverse) {
    if (n <= 1) return;
    
    // 必要に応じてテーブル初期化
    if (!twiddle_table || twiddle_table_size < n) {
        init_twiddle_table(n);
    }
    
    // ビット反転（最適化版）
    int j = 0;
    for (int i = 1; i < n; i++) {
        int bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        
        if (i < j) {
            // SIMDフレンドリーなスワップ
            Complex temp = data[i];
            data[i] = data[j];
            data[j] = temp;
        }
    }
    
    // FFT計算（テーブル参照版）
    for (int len = 2; len <= n; len <<= 1) {
        int step = n / len;
        
        for (int i = 0; i < n; i += len) {
            for (int j = 0; j < len / 2; j++) {
                // テーブル参照
                int twiddle_idx = j * step;
                if (inverse) twiddle_idx = n - twiddle_idx;
                if (twiddle_idx >= n) twiddle_idx -= n;
                
                Complex w = twiddle_table[twiddle_idx];
                
                Complex u = data[i + j];
                Complex v = {
                    data[i + j + len / 2].real * w.real - data[i + j + len / 2].imag * w.imag,
                    data[i + j + len / 2].real * w.imag + data[i + j + len / 2].imag * w.real
                };
                
                // バタフライ演算（SIMDフレンドリー）
                data[i + j].real = u.real + v.real;
                data[i + j].imag = u.imag + v.imag;
                data[i + j + len / 2].real = u.real - v.real;
                data[i + j + len / 2].imag = u.imag - v.imag;
            }
        }
    }
    
    // 逆変換の場合は正規化
    if (inverse) {
        double inv_n = 1.0 / n;
        for (int i = 0; i < n; i++) {
            data[i].real *= inv_n;
            data[i].imag *= inv_n;
        }
    }
}

/**
 * キャッシュフレンドリーな転置操作
 */
void transpose_complex(Complex* src, Complex* dst, int width, int height) {
    // サイズに応じてブロックサイズを調整（L1/L2キャッシュを考慮）
    const int BLOCK_SIZE = (width >= 256 && height >= 256) ? 64 : 32;

    for (int i = 0; i < height; i += BLOCK_SIZE) {
        for (int j = 0; j < width; j += BLOCK_SIZE) {
            int max_i = (i + BLOCK_SIZE < height) ? i + BLOCK_SIZE : height;
            int max_j = (j + BLOCK_SIZE < width) ? j + BLOCK_SIZE : width;

            for (int ii = i; ii < max_i; ii++) {
                for (int jj = j; jj < max_j; jj++) {
                    dst[jj * height + ii] = src[ii * width + jj];
                }
            }
        }
    }
}

/**
 * インプレース転置（メモリ効率版）
 */
void transpose_complex_inplace(Complex* data, int size) {
    for (int i = 0; i < size; i++) {
        for (int j = i + 1; j < size; j++) {
            Complex temp = data[i * size + j];
            data[i * size + j] = data[j * size + i];
            data[j * size + i] = temp;
        }
    }
}

/**
 * 基本2D FFT（正方形専用、安定版）
 * @param data 複素数配列（width × height）
 * @param width 幅
 * @param height 高さ
 * @param inverse 0:順変換, 1:逆変換
 */
void fft_2d(Complex* data, int width, int height, int inverse) {
    // ブロック転置を使ったアウトオブプレース方式（正方形/非正方形を問わず同一経路）
    const int W = width;
    const int H = height;
    ensure_fft_temp_buffer((size_t)W * (size_t)H);
    if (!fft_temp_buffer) return;

    // 行方向FFT（長さ W）
    for (int i = 0; i < H; i++) {
        fft_1d(data + i * W, W, inverse);
    }

    // 転置 data[H][W] -> temp[W][H]
    transpose_complex(data, fft_temp_buffer, W, H);

    // 列方向FFT（転置後は行方向、長さ H）
    for (int i = 0; i < W; i++) {
        fft_1d(fft_temp_buffer + i * H, H, inverse);
    }

    // 逆転置 temp[W][H] -> data[H][W]
    transpose_complex(fft_temp_buffer, data, H, W);
}

/**
 * 高速複素振幅計算（分岐予測最適化版）
 * @param opd OPDデータ
 * @param amplitude 振幅データ
 * @param pupil_mask 瞳マスク
 * @param output 出力複素振幅
 * @param size グリッドサイズ
 * @param wavelength 波長
 */
void calculate_complex_amplitude(double* opd, double* amplitude, int* pupil_mask, 
                                Complex* output, int size, double wavelength) {
    const double k = 2.0 * M_PI / wavelength;
    const int total_size = size * size;
    
    // 高速三角関数テーブルを初期化（必要に応じて）
    if (!sin_table || trig_table_size < total_size) {
        init_fast_trig_tables(total_size);
    }
    
    // 分岐予測を避けるため、マスクされた要素を先に処理
    // 1. 全要素をゼロ初期化
    memset(output, 0, total_size * sizeof(Complex));
    
    // 2. 有効な要素のみを処理（分岐なし）
    for (int i = 0; i < total_size; i++) {
        if (pupil_mask[i]) {
            double phase = k * opd[i];
            double amp = amplitude[i];
            
            // 高速三角関数を使用
            output[i].real = amp * fast_cos(phase);
            output[i].imag = amp * fast_sin(phase);
        }
    }
}

/**
 * 最適化されたOPD格子補間
 * @param ray_x 光線X座標
 * @param ray_y 光線Y座標
 * @param ray_opd 光線OPD
 * @param ray_count 光線数
 * @param grid_opd 出力格子OPD
 * @param pupil_mask 瞳マスク
 * @param grid_size 格子サイズ
 * @param min_x,max_x,min_y,max_y 座標範囲
 */
void interpolate_opd_grid(double* ray_x, double* ray_y, double* ray_opd, int ray_count,
                         double* grid_opd, int* pupil_mask, int grid_size,
                         double min_x, double max_x, double min_y, double max_y) {
    
    const double inv_grid_size_minus_1 = 1.0 / (grid_size - 1);
    const double x_range = max_x - min_x;
    const double y_range = max_y - min_y;
    const double max_radius = fmax(fabs(max_x), fabs(max_y));
    const double max_radius_sq = max_radius * max_radius;
    
    // 空間分割による高速化（簡易版）
    for (int i = 0; i < grid_size; i++) {
        double grid_x = min_x + x_range * i * inv_grid_size_minus_1;
        
        for (int j = 0; j < grid_size; j++) {
            double grid_y = min_y + y_range * j * inv_grid_size_minus_1;
            
            // 円形瞳の範囲内かチェック（平方根計算を避ける）
            double radius_sq = grid_x * grid_x + grid_y * grid_y;
            
            int index = i * grid_size + j;
            
            if (radius_sq <= max_radius_sq) {
                pupil_mask[index] = 1;
                
                // 高速最近傍補間（早期終了付き）
                double min_dist_sq = LARGE_NUMBER;
                double interpolated_opd = 0.0;
                
                // 十分近い点が見つかったら早期終了
                const double early_exit_threshold = 1e-8;
                
                for (int k = 0; k < ray_count; k++) {
                    double dx = ray_x[k] - grid_x;
                    double dy = ray_y[k] - grid_y;
                    double dist_sq = dx * dx + dy * dy;
                    
                    if (dist_sq < min_dist_sq) {
                        min_dist_sq = dist_sq;
                        interpolated_opd = ray_opd[k];
                        
                        // 十分近い場合は早期終了
                        if (dist_sq < early_exit_threshold) {
                            break;
                        }
                    }
                }
                
                grid_opd[index] = interpolated_opd;
            } else {
                pupil_mask[index] = 0;
                grid_opd[index] = 0.0;
            }
        }
    }
}

/**
 * Strehl比計算
 * @param psf PSF強度分布
 * @param size サイズ
 * @return Strehl比
 */
double calculate_strehl_ratio(double* psf, int size) {
    // 中心ピーク値
    int center = size / 2;
    double peak_value = psf[center * size + center];
    
    // 回折限界PSFのピーク値（理論値）
    double theoretical_peak = 1.0; // 正規化された場合
    
    return peak_value / theoretical_peak;
}

/**
 * エンサークルドエネルギー計算
 * @param psf PSF強度分布
 * @param size サイズ
 * @param radii 半径配列
 * @param energies 出力エネルギー配列
 * @param radii_count 半径数
 */
void calculate_encircled_energy(double* psf, int size, double* radii, double* energies, int radii_count) {
    int center = size / 2;
    
    // 全エネルギー計算
    double total_energy = 0.0;
    for (int i = 0; i < size * size; i++) {
        total_energy += psf[i];
    }
    
    // 各半径でのエンサークルドエネルギー計算
    for (int r = 0; r < radii_count; r++) {
        double radius = radii[r];
        double encircled = 0.0;
        
        for (int i = 0; i < size; i++) {
            for (int j = 0; j < size; j++) {
                double dx = i - center;
                double dy = j - center;
                double dist = sqrt(dx * dx + dy * dy);
                
                if (dist <= radius) {
                    encircled += psf[i * size + j];
                }
            }
        }
        
        energies[r] = encircled / total_energy;
    }
}

// WebAssembly エクスポート関数

/**
 * メインPSF計算関数（JavaScript から呼び出し）
 * @param ray_x 光線X座標配列
 * @param ray_y 光線Y座標配列
 * @param ray_opd 光線OPD配列
 * @param ray_count 光線数
 * @param grid_size 格子サイズ
 * @param wavelength 波長
 * @param min_x,max_x,min_y,max_y 座標範囲
 * @return PSF強度配列のポインタ
 */
double* calculate_psf_wasm(double* ray_x, double* ray_y, double* ray_opd, int ray_count,
                          int grid_size, double wavelength,
                          double min_x, double max_x, double min_y, double max_y) {
    
    const int total_size = grid_size * grid_size;
    double start_time = get_time_ms();
    
    // 高速テーブルの事前初期化
    double init_start = get_time_ms();
    if (!sin_table || trig_table_size < total_size) {
        init_fast_trig_tables(total_size);
    }
    double init_time = get_time_ms() - init_start;
    
    // メモリ確保
    double alloc_start = get_time_ms();
    double* grid_opd = (double*)calloc(total_size, sizeof(double));
    double* amplitude = (double*)malloc(total_size * sizeof(double));
    int* pupil_mask = (int*)calloc(total_size, sizeof(int));
    Complex* complex_amp = (Complex*)calloc(total_size, sizeof(Complex));
    double* psf_intensity = (double*)malloc(total_size * sizeof(double));
    
    if (!grid_opd || !amplitude || !pupil_mask || !complex_amp || !psf_intensity) {
        if (grid_opd) free(grid_opd);
        if (amplitude) free(amplitude);
        if (pupil_mask) free(pupil_mask);
        if (complex_amp) free(complex_amp);
        if (psf_intensity) free(psf_intensity);
        return NULL;
    }
    
    // 振幅を均一に設定（ベクトル化可能）
    for (int i = 0; i < total_size; i++) {
        amplitude[i] = 1.0;
    }
    double alloc_time = get_time_ms() - alloc_start;
    
    // 1. OPD格子補間
    double interp_start = get_time_ms();
    interpolate_opd_grid(ray_x, ray_y, ray_opd, ray_count,
                        grid_opd, pupil_mask, grid_size,
                        min_x, max_x, min_y, max_y);
    double interp_time = get_time_ms() - interp_start;
    
    // 2. 複素振幅計算
    double amp_start = get_time_ms();
    calculate_complex_amplitude(grid_opd, amplitude, pupil_mask,
                               complex_amp, grid_size, wavelength);
    double amp_time = get_time_ms() - amp_start;
    
    // 3. 2D FFT
    double fft_start = get_time_ms();
    fft_2d(complex_amp, grid_size, grid_size, 0);
    double fft_time = get_time_ms() - fft_start;
    
    // 4. 強度計算（ベクトル化可能）
    double intensity_start = get_time_ms();
    for (int i = 0; i < total_size; i++) {
        psf_intensity[i] = complex_amp[i].real * complex_amp[i].real + 
                          complex_amp[i].imag * complex_amp[i].imag;
    }
    double intensity_time = get_time_ms() - intensity_start;
    
    // 5. FFTshift
    double shift_start = get_time_ms();
    fft_shift(psf_intensity, grid_size);
    double shift_time = get_time_ms() - shift_start;
    
    double total_time = get_time_ms() - start_time;
    
    // タイミング情報をログ出力（デバッグ用）
#ifdef __EMSCRIPTEN__
    // Emscriptenの場合はJavaScript側にログを送信
    EM_ASM({
        console.log('📊 [WASM-C] Internal timing for ' + $0 + 'x' + $0 + ':', {
            'Initialization': $1.toFixed(2) + 'ms',
            'Memory Allocation': $2.toFixed(2) + 'ms', 
            'OPD Interpolation': $3.toFixed(2) + 'ms',
            'Complex Amplitude': $4.toFixed(2) + 'ms',
            'FFT': $5.toFixed(2) + 'ms',
            'Intensity Calc': $6.toFixed(2) + 'ms',
            'FFT Shift': $7.toFixed(2) + 'ms',
            'Total WASM-C': $8.toFixed(2) + 'ms'
        });
    }, grid_size, init_time, alloc_time, interp_time, amp_time, fft_time, intensity_time, shift_time, total_time);
#endif
    
    // クリーンアップ
    free(grid_opd);
    free(amplitude);
    free(pupil_mask);
    free(complex_amp);
    
    return psf_intensity;
}

/**
 * PSF計算関数（格子入力版）
 * - OPD補間を行わず、与えられた grid_opd / amplitude / pupil_mask をそのまま使用してFFTする。
 * - JS側で piston/tilt 除去や座標系の扱いを済ませた gridData を渡す用途。
 *
 * @param grid_opd OPD格子（row-major, length = grid_size*grid_size）
 * @param amplitude 振幅格子（row-major, length = grid_size*grid_size）
 * @param pupil_mask 瞳マスク（0/1, row-major, length = grid_size*grid_size）
 * @param grid_size 格子サイズ
 * @param wavelength 波長
 * @return PSF強度配列のポインタ（caller must free via free_psf_result）
 */
double* calculate_psf_grid_wasm(double* grid_opd, double* amplitude, int* pupil_mask,
                               int grid_size, double wavelength) {
    const int total_size = grid_size * grid_size;
    double start_time = get_time_ms();

    // 高速テーブルの事前初期化
    double init_start = get_time_ms();
    if (!sin_table || trig_table_size < total_size) {
        init_fast_trig_tables(total_size);
    }
    double init_time = get_time_ms() - init_start;

    // メモリ確保
    double alloc_start = get_time_ms();
    Complex* complex_amp = (Complex*)calloc(total_size, sizeof(Complex));
    double* psf_intensity = (double*)malloc(total_size * sizeof(double));
    if (!complex_amp || !psf_intensity) {
        if (complex_amp) free(complex_amp);
        if (psf_intensity) free(psf_intensity);
        return NULL;
    }
    double alloc_time = get_time_ms() - alloc_start;

    // 1. 複素振幅計算（格子入力をそのまま使用）
    // OPDは光路差（遅延）なので、位相は負の符号（JS実装に合わせる）
    double amp_start = get_time_ms();
    const double k = -2.0 * M_PI / wavelength;
    memset(complex_amp, 0, total_size * sizeof(Complex));
    for (int i = 0; i < total_size; i++) {
        if (pupil_mask && pupil_mask[i]) {
            const double opd = grid_opd ? grid_opd[i] : 0.0;
            const double a = amplitude ? amplitude[i] : 1.0;
            const double phase = k * opd;
            complex_amp[i].real = a * fast_cos(phase);
            complex_amp[i].imag = a * fast_sin(phase);
        }
    }
    double amp_time = get_time_ms() - amp_start;

    // 2. 2D FFT
    double fft_start = get_time_ms();
    fft_2d(complex_amp, grid_size, grid_size, 0);
    double fft_time = get_time_ms() - fft_start;

    // 3. 強度計算
    double intensity_start = get_time_ms();
    for (int i = 0; i < total_size; i++) {
        psf_intensity[i] = complex_amp[i].real * complex_amp[i].real +
                           complex_amp[i].imag * complex_amp[i].imag;
    }
    double intensity_time = get_time_ms() - intensity_start;

    // 4. FFTshift
    double shift_start = get_time_ms();
    fft_shift(psf_intensity, grid_size);
    double shift_time = get_time_ms() - shift_start;

    double total_time = get_time_ms() - start_time;

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('📊 [WASM-C] Internal timing for grid ' + $0 + 'x' + $0 + ':', {
            'Initialization': $1.toFixed(2) + 'ms',
            'Memory Allocation': $2.toFixed(2) + 'ms',
            'OPD Interpolation': '0.00ms',
            'Complex Amplitude': $3.toFixed(2) + 'ms',
            'FFT': $4.toFixed(2) + 'ms',
            'Intensity Calc': $5.toFixed(2) + 'ms',
            'FFT Shift': $6.toFixed(2) + 'ms',
            'Total WASM-C': $7.toFixed(2) + 'ms'
        });
    }, grid_size, init_time, alloc_time, amp_time, fft_time, intensity_time, shift_time, total_time);
#endif

    free(complex_amp);
    return psf_intensity;
}

/**
 * PSFからMTFのx/y軸断面を計算
 * @param psf PSF強度（row-major, size*size）
 * @param size PSFサイズ（NxN）
 * @param k_max 取得する周波数ビン上限（0..size/2）
 * @return 先頭にx軸、後半にy軸を格納した配列ポインタ（length=2*(k_max+1)）
 */
double* calculate_mtf_axes_from_psf_wasm(double* psf, int size, int k_max) {
    if (!psf || size < 2) return NULL;

    const int max_bin = size / 2;
    if (k_max < 0) k_max = 0;
    if (k_max > max_bin) k_max = max_bin;

    const int n = size * size;
    Complex* otf = (Complex*)calloc((size_t)n, sizeof(Complex));
    if (!otf) return NULL;

    for (int i = 0; i < n; i++) {
        otf[i].real = psf[i];
        otf[i].imag = 0.0;
    }

    fft_2d(otf, size, size, 0);

    const double dc_re = otf[0].real;
    const double dc_im = otf[0].imag;
    const double dc_mag = sqrt(dc_re * dc_re + dc_im * dc_im);
    if (!(isfinite(dc_mag) && dc_mag > 0.0)) {
        free(otf);
        return NULL;
    }

    const int out_len = (k_max + 1) * 2;
    double* out = (double*)malloc((size_t)out_len * sizeof(double));
    if (!out) {
        free(otf);
        return NULL;
    }

    for (int k = 0; k <= k_max; k++) {
        const int idx_x = k;
        const int idx_y = k * size;

        const double x_re = otf[idx_x].real;
        const double x_im = otf[idx_x].imag;
        const double y_re = otf[idx_y].real;
        const double y_im = otf[idx_y].imag;

        out[k] = sqrt(x_re * x_re + x_im * x_im) / dc_mag;
        out[(k_max + 1) + k] = sqrt(y_re * y_re + y_im * y_im) / dc_mag;
    }

    if (out_len > 0) {
        out[0] = 1.0;
        out[k_max + 1] = 1.0;
    }

    free(otf);
    return out;
}

/**
 * Strehl比計算関数（JavaScript から呼び出し）
 */
double calculate_strehl_wasm(double* psf, int size) {
    return calculate_strehl_ratio(psf, size);
}

/**
 * エンサークルドエネルギー計算関数（JavaScript から呼び出し）
 */
void calculate_encircled_energy_wasm(double* psf, int size, double* radii, double* energies, int radii_count) {
    calculate_encircled_energy(psf, size, radii, energies, radii_count);
}

/**
 * PSF結果メモリ解放関数
 */
void free_psf_result(double* psf) {
    if (psf) {
        free(psf);
    }
}

/**
 * WebAssemblyモジュールクリーンアップ
 */
void cleanup_wasm_module() {
    if (twiddle_table) {
        free(twiddle_table);
        twiddle_table = NULL;
        twiddle_table_size = 0;
    }
    
    if (sin_table) {
        free(sin_table);
        sin_table = NULL;
    }
    
    if (cos_table) {
        free(cos_table);
        cos_table = NULL;
    trig_table_size = 0;
    if (fft_temp_buffer) { free(fft_temp_buffer); fft_temp_buffer = NULL; fft_temp_capacity = 0; }
    }
}
