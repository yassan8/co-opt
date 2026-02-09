
/**
 * AI Assistant Module
 * Handles the AI Assistant UI, API configuration, and chat interaction.
 */

import { getSystemContext } from './ai-context.ts';
import { BLOCK_SCHEMA_VERSION, expandBlocksToOpticalSystemRows, deriveBlocksFromLegacyOpticalSystemRows } from '../data/block-schema.ts';

const AI_CONFIG_KEY = 'ai_assistant_config';
const AI_HISTORY_KEY = 'ai_assistant_history';

// Default configuration
const DEFAULT_CONFIG = {
    provider: 'gemini', // 'gemini' | 'openai' | 'anthropic'
    apiKey: '',
    // Note: Gemini model availability varies by API version/account.
    // We'll also auto-normalize and list available models on errors.
    // Leave blank to auto-select via ListModels.
    model: ''
};

// State
let aiConfig = { ...DEFAULT_CONFIG };
let chatHistory = [];

// Guard against double-initialization (hot reload / repeated init calls).
let __aiAssistantInitialized = false;

let _aiPopupWindow = null;

let _nextMessageId = 1;
let _renderScheduled = false;

const TOOL_MAX_ITERS = 6;

// AI providers can legitimately take longer than 30s for large prompts/tool loops.
// Keep these conservative but practical; list-models calls override to shorter timeouts.
const DEFAULT_AI_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_AI_STREAM_TIMEOUT_MS = 180000;

// Note: this module is loaded as an ES module, so top-level consts are not globals.
// Export minimal debug info to `window` to help confirm which build is running.
try {
    if (typeof window !== 'undefined') {
        if (!window.__COOPT_AI_ASSISTANT_VERSION) {
            window.__COOPT_AI_ASSISTANT_VERSION = 'co-opt 1.9.6 (ai-assistant) 2026-01-05';
        }
        if (typeof window.DEFAULT_AI_REQUEST_TIMEOUT_MS === 'undefined') {
            window.DEFAULT_AI_REQUEST_TIMEOUT_MS = DEFAULT_AI_REQUEST_TIMEOUT_MS;
        }
        if (typeof window.DEFAULT_AI_STREAM_TIMEOUT_MS === 'undefined') {
            window.DEFAULT_AI_STREAM_TIMEOUT_MS = DEFAULT_AI_STREAM_TIMEOUT_MS;
        }
    }
} catch (_) {}

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_AI_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        try { controller.abort(); } catch (_) {}
    }, timeoutMs);

    const opts = { ...options, signal: controller.signal };
    return fetch(url, opts)
        .catch((err) => {
            // Normalize timeout-ish errors into a stable message.
            const name = String(err?.name || '');
            if (name === 'AbortError') {
                throw new Error(`Request timed out after ${timeoutMs}ms`);
            }
            throw err;
        })
        .finally(() => {
            try { clearTimeout(timer); } catch (_) {}
        });
}

let __aiGlobalErrorHandlersInstalled = false;
function installAIGlobalErrorHandlers() {
    if (__aiGlobalErrorHandlersInstalled) return;
    __aiGlobalErrorHandlersInstalled = true;

    const report = (label, err) => {
        const message = (err && typeof err === 'object' && 'message' in err) ? String(err.message) : String(err);
        const stack = (err && typeof err === 'object' && 'stack' in err) ? String(err.stack) : '';
        const text = [`❌ ${label}: ${message}`, stack ? `\n${stack}` : ''].join('');
        try {
            // If panel exists, show in chat. If not, at least log it.
            const hasPanel = !!document.getElementById('ai-chat-history');
            if (hasPanel) addMessage('assistant', text);
        } catch (_) {}
        try { console.error(`[AI Assistant] ${label}:`, err); } catch (_) {}
    };

    try {
        window.addEventListener('error', (e) => {
            // Some browsers provide e.error, some only e.message.
            report('Unhandled error', e?.error || e?.message || e);
        });
        window.addEventListener('unhandledrejection', (e) => {
            report('Unhandled promise rejection', e?.reason || e);
        });
    } catch (_) {}
}

