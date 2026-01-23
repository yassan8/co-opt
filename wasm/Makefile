# WebAssembly PSF Calculator Makefile
# EmscriptenでC言語をWebAssemblyにコンパイル

CC = emcc
CFLAGS = -O3 -msimd128 -s WASM=1 -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","setValue","getValue","UTF8ToString","stringToUTF8","HEAP8","HEAPU8","HEAPF32","HEAPF64"]' \
         -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 \
         -s MAXIMUM_MEMORY=536870912 -s NO_EXIT_RUNTIME=1 \
         -s MODULARIZE=1 -s EXPORT_NAME="PSFWasm" \
         -s EXPORTED_FUNCTIONS='["_calculate_psf_wasm","_calculate_psf_grid_wasm","_calculate_strehl_wasm","_calculate_encircled_energy_wasm","_free_psf_result","_malloc","_free"]' \
         --pre-js pre.js \
         -s MALLOC=emmalloc \
         -s AGGRESSIVE_VARIABLE_ELIMINATION=1 \
         -s ELIMINATE_DUPLICATE_FUNCTIONS=1 \
         -ffast-math \
         -funroll-loops \
         -fvectorize \
         --closure 0 \
         -s STACK_SIZE=1048576 \
         -s TOTAL_STACK=2097152

# ソースファイル
SOURCES = psf-wasm.c
TARGET = psf-wasm

# デフォルトターゲット
all: $(TARGET).js

# WASM生成
$(TARGET).js: $(SOURCES)
	$(CC) $(CFLAGS) $(SOURCES) -o $(TARGET).js

# クリーン
clean:
	rm -f $(TARGET).js $(TARGET).wasm

# インストール（wasm/psf にコピー）
install: $(TARGET).js
    @mkdir -p ../wasm/psf
    cp $(TARGET).js $(TARGET).wasm ../wasm/psf/

.PHONY: all clean install
