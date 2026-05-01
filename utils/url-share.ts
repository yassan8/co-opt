// URL share helpers (no server): embed compressed design JSON into location.hash
// Requires global LZString (loaded via classic <script>)

export const COMPRESSED_DATA_HASH_KEY = 'compressed_data';
const DEFLATE_PREFIX = 'd:';

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
    const json = JSON.stringify(allData ?? null);

    if (__hasDeflateStreams()) {
        try {
            return `${DEFLATE_PREFIX}${await __compressTextToDeflateBase64Url(json)}`;
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
        json = await __decompressDeflateBase64UrlToText(s.slice(DEFLATE_PREFIX.length));
    } else {
        const lz = __requireLZString();
        json = lz.decompressFromEncodedURIComponent(s);
        if (json === null || json === undefined) throw new Error('Failed to decompress');
    }

    const trimmed = String(json).trim();
    if (!trimmed) throw new Error('Decompressed JSON is empty');

    return JSON.parse(trimmed);
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
