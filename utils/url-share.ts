// URL share helpers (no server): embed compressed design JSON into location.hash
// Requires global LZString (loaded via classic <script>)

export const COMPRESSED_DATA_HASH_KEY = 'compressed_data';
const DEFLATE_PREFIX = 'd:';
const SHARE_PACK_VERSION = 1;
const SHARE_PACK_OBJECT = 0;
const SHARE_PACK_ATOM = 1;
const SHARE_PACK_ARRAY = 2;
const SHARE_PACK_MIN_ATOM_COUNT = 12;

function __requireLZString() {
    const lz = (typeof window !== 'undefined' ? window.LZString : undefined);
    if (!lz || typeof lz.compressToEncodedURIComponent !== 'function' || typeof lz.decompressFromEncodedURIComponent !== 'function') {
        throw new Error('LZString is not available. Make sure lz-string.min.js is loaded.');
    }
    return lz;
}

function __hasDeflateStreams() {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

function __withTimeout(promise, timeoutMs, label) {
    const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${safeTimeoutMs}ms`)), safeTimeoutMs);
        })
    ]);
}

function __bytesToBase64Url(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function __base64UrlToBytes(base64Url) {
    const normalized = String(base64Url ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function __collectSharePrimitiveCounts(value, counts) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const item of value) {
            __collectSharePrimitiveCounts(item, counts);
        }
        return;
    }
    if (typeof value === 'object') {
        for (const child of Object.values(value)) {
            __collectSharePrimitiveCounts(child, counts);
        }
        return;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;

    const token = `${typeof value}:${String(value)}`;
    counts.set(token, (counts.get(token) ?? 0) + 1);
}

function __decodeSharePrimitiveToken(token) {
    const separatorIndex = token.indexOf(':');
    const type = separatorIndex >= 0 ? token.slice(0, separatorIndex) : 'string';
    const raw = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : token;

    if (type === 'number') return Number(raw);
    if (type === 'boolean') return raw === 'true';
    return raw;
}

function __buildShareAtomTable(value) {
    const counts = new Map();
    __collectSharePrimitiveCounts(value, counts);

    const atomTokens = [];
    const atomIndexes = new Map();
    for (const [token, count] of counts.entries()) {
        if (count < SHARE_PACK_MIN_ATOM_COUNT) continue;
        atomIndexes.set(token, atomTokens.length);
        atomTokens.push(token);
    }

    return {
        atoms: atomTokens.map(__decodeSharePrimitiveToken),
        atomIndexes
    };
}

function __packSharePayload(rootValue) {
    const keyIndexes = new Map();
    const keys = [];
    const { atoms, atomIndexes } = __buildShareAtomTable(rootValue);

    function getKeyIndex(key) {
        let index = keyIndexes.get(key);
        if (index !== undefined) return index;
        index = keys.length;
        keys.push(key);
        keyIndexes.set(key, index);
        return index;
    }

    function encodeNode(value) {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) {
            return [SHARE_PACK_ARRAY, ...value.map((item) => encodeNode(item))];
        }
        if (typeof value === 'object') {
            const encoded = [SHARE_PACK_OBJECT];
            for (const [key, child] of Object.entries(value)) {
                encoded.push(getKeyIndex(key), encodeNode(child));
            }
            return encoded;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            const token = `${typeof value}:${String(value)}`;
            const atomIndex = atomIndexes.get(token);
            if (atomIndex !== undefined) {
                return [SHARE_PACK_ATOM, atomIndex];
            }
        }
        return value;
    }

    return {
        v: SHARE_PACK_VERSION,
        k: keys,
        a: atoms,
        r: encodeNode(rootValue)
    };
}

function __isPackedSharePayload(value) {
    return !!value
        && typeof value === 'object'
        && value.v === SHARE_PACK_VERSION
        && Array.isArray(value.k)
        && Array.isArray(value.a)
        && Object.prototype.hasOwnProperty.call(value, 'r');
}

function __unpackSharePayload(value) {
    if (!__isPackedSharePayload(value)) return value;

    const keys = value.k;
    const atoms = value.a;

    function decodeNode(node) {
        if (!Array.isArray(node) || node.length === 0) return node;

        const tag = node[0];
        if (tag === SHARE_PACK_ATOM) {
            return atoms[node[1]];
        }
        if (tag === SHARE_PACK_ARRAY) {
            return node.slice(1).map((item) => decodeNode(item));
        }
        if (tag === SHARE_PACK_OBJECT) {
            const out = {};
            for (let index = 1; index < node.length; index += 2) {
                out[keys[node[index]]] = decodeNode(node[index + 1]);
            }
            return out;
        }

        return node;
    }

    return decodeNode(value.r);
}

async function __compressTextToDeflateBase64Url(text) {
    const encoder = new TextEncoder();
    const input = encoder.encode(text);
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    await writer.write(input);
    await writer.close();
    const output = new Uint8Array(await new Response(stream.readable).arrayBuffer());
    return __bytesToBase64Url(output);
}

async function __decompressDeflateBase64UrlToText(base64Url) {
    const input = __base64UrlToBytes(base64Url);
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    await writer.write(input);
    await writer.close();
    const output = new Uint8Array(await new Response(stream.readable).arrayBuffer());
    return new TextDecoder().decode(output);
}

export function parseHashbangParams(hashString) {
    const raw = String(hashString ?? '');
    // #!, #, ? で始まる場合は削除
    let s = raw;
    if (s.startsWith('#!')) s = s.slice(2);
    else if (s.startsWith('#') || s.startsWith('?')) s = s.slice(1);
    
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
export const parseHashParams = parseHashbangParams;
export const parseQueryParams = parseHashbangParams;

export async function encodeAllDataToCompressedString(allData) {
    const normalized = JSON.parse(JSON.stringify(allData ?? null));
    const packed = __packSharePayload(normalized);
    const json = JSON.stringify(packed);

    if (__hasDeflateStreams()) {
        try {
            return `${DEFLATE_PREFIX}${await __withTimeout(__compressTextToDeflateBase64Url(json), 1500, 'Share URL deflate compression')}`;
        } catch (error) {
            console.warn('⚠️ [Share URL] deflate compression failed, falling back to LZString:', error);
        }
    }

    const lz = __requireLZString();
    return lz.compressToEncodedURIComponent(json);
}

export async function decodeAllDataFromCompressedString(compressed) {
    const s = String(compressed ?? '');
    if (!s) throw new Error('Missing compressed data');

    let json;
    if (s.startsWith(DEFLATE_PREFIX)) {
        if (!__hasDeflateStreams()) {
            throw new Error('This Share URL uses the new compression format, but this browser cannot decompress it.');
        }
        json = await __withTimeout(
            __decompressDeflateBase64UrlToText(s.slice(DEFLATE_PREFIX.length)),
            1500,
            'Share URL deflate decompression'
        );
    } else {
        const lz = __requireLZString();
        json = lz.decompressFromEncodedURIComponent(s);
        if (json === null || json === undefined) throw new Error('Failed to decompress');
    }

    const trimmed = String(json).trim();
    if (!trimmed) throw new Error('Decompressed JSON is empty');

    return __unpackSharePayload(JSON.parse(trimmed));
}

export function buildShareUrlFromCompressedString(compressed, baseUrl) {
    const base = String(baseUrl ?? '').trim();
    if (!base) throw new Error('Missing baseUrl');
    return `${base}#!${COMPRESSED_DATA_HASH_KEY}=${compressed}`;
}

export function getCompressedStringFromLocationHash(hashOrSearch) {
    const params = parseHashbangParams(hashOrSearch);
    return params[COMPRESSED_DATA_HASH_KEY] ?? '';
}

export function getCompressedStringFromLocation() {
    // 新しいHashbang形式(#!)を優先、後方互換のため?(query)と#(hash)もチェック
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const search = typeof window !== 'undefined' ? window.location.search : '';
    
    // まずhashをチェック（#! または # 形式）
    let compressed = getCompressedStringFromLocationHash(hash);
    // なければsearchをチェック（? 形式、旧バージョン互換）
    if (!compressed) {
        compressed = getCompressedStringFromLocationHash(search);
    }
    return compressed;
}
