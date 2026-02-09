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

export function parseHashbangParams(hashString) {
    const raw = String(hashString ?? '');
