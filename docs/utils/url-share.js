// URL share helpers (no server): embed compressed design JSON into location.hash
// Requires global LZString (loaded via classic <script>)

export const COMPRESSED_DATA_HASH_KEY = 'compressed_data';

function __requireLZString() {
    const lz = (typeof window !== 'undefined' ? window.LZString : undefined);
    if (!lz || typeof lz.compressToEncodedURIComponent !== 'function' || typeof lz.decompressFromEncodedURIComponent !== 'function') {
        throw new Error('LZString is not available. Make sure lz-string.min.js is loaded.');
    }
    return lz;
}

export function parseQueryParams(queryString) {
    const raw = String(queryString ?? '');
    // ? または # で始まる場合は削除
    const s = raw.startsWith('?') || raw.startsWith('#') ? raw.slice(1) : raw;
    /** @type {Record<string, string>} */
    const out = {};
    if (!s) return out;

    for (const part of s.split('&')) {
        if (!part) continue;
        const idx = part.indexOf('=');
        if (idx < 0) {
            out[decodeURIComponent(part)] = '';
            continue;
        }
        const k = part.slice(0, idx);
        const v = part.slice(idx + 1);
        out[decodeURIComponent(k)] = v;
    }
    return out;
}

// 後方互換性のため残す
export const parseHashParams = parseQueryParams;

export function encodeAllDataToCompressedString(allData) {
    const lz = __requireLZString();
    const json = JSON.stringify(allData ?? null);
    return lz.compressToEncodedURIComponent(json);
}

export function decodeAllDataFromCompressedString(compressed) {
    const lz = __requireLZString();
    const s = String(compressed ?? '');
    if (!s) throw new Error('Missing compressed data');

    const json = lz.decompressFromEncodedURIComponent(s);
    if (json === null || json === undefined) throw new Error('Failed to decompress');
    const trimmed = String(json).trim();
    if (!trimmed) throw new Error('Decompressed JSON is empty');

    return JSON.parse(trimmed);
}

export function buildShareUrlFromCompressedString(compressed, baseUrl) {
    const base = String(baseUrl ?? '').trim();
    if (!base) throw new Error('Missing baseUrl');
    return `${base}?${COMPRESSED_DATA_HASH_KEY}=${compressed}`;
}

export function getCompressedStringFromLocationHash(hashOrSearch) {
    const params = parseQueryParams(hashOrSearch);
    return params[COMPRESSED_DATA_HASH_KEY] ?? '';
}

export function getCompressedStringFromLocation() {
    // 新しいクエリパラメータ形式（?）を優先、後方互換のためハッシュ（#）もチェック
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    
    let compressed = getCompressedStringFromLocationHash(search);
    if (!compressed) {
        compressed = getCompressedStringFromLocationHash(hash);
    }
    return compressed;
}
