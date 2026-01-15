
/**
 * AI Assistant Module
 * Handles the AI Assistant UI, API configuration, and chat interaction.
 */

import { getSystemContext } from './ai-context.js';
import { BLOCK_SCHEMA_VERSION, expandBlocksToOpticalSystemRows, deriveBlocksFromLegacyOpticalSystemRows } from './block-schema.js';

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

const SYSTEM_INSTRUCTIONS_JA = `あなたは「co-opt」（ブラウザで動作する光学設計・解析ツール）の熟練した光学設計コンサルタントです。
ユーザーの目的に合わせて、設計・解析・最適化の方針を日本語で簡潔に提案してください。

重要:
- co-opt の面番号は UI 上は Surf 0..N-1 の 0-index です（context.system[].surf がそれ）。
- context.system[].surf1 は参考用の 1-index です。面番号の混同を避けてください。
- 最終行が像面（Image）で thickness が null/空でも、それ自体は必ずしもエラーではありません。
    エラー断定はせず、必要なら「どの計算が失敗したか」「どの入力が欠けているか」を確認する質問をしてください。
        - もし context.performance.error があり、かつ context.performance.diagnostics がある場合は、それを最優先の根拠にしてください。
            特に diagnostics.steps（paraxial / seidel 等）の ok=false と error.message/stack を引用し、「どの計算が失敗したか」を明確に述べてください。
            diagnostics.preflightIssues がある場合は、推測ではなくその指摘（例: NEGATIVE_THICKNESS 等）に沿って確認手順を提案してください。
        - もし diagnostics.steps がすべて ok=true なのにユーザーが「計算が失敗する」と言っている場合、原因は paraxial/seidel 以外（例: Wavefront/OPD/PSF/Spot/最適化）にある可能性が高いです。
            その場合は context.runtimeDiagnostics（wavefront/opdLastRay/psfError など）があれば必ず引用し、どの機能が失敗しているかを切り分けてください。
- context.system[].material が "AIR" の行は「空気（材料指定なし）」として正常です。ガラス未指定と断定しないでください。
- Design Intent（blocks）上の material 系キーはガラス名の文字列です（例: Lens.material, Doublet.material1/material2, Triplet.material1/material2/material3）。
    - これらは数値ではなく離散(categorical)変数として Optimize(V) 対象にできます。"non-numeric" だからといって最適化不可とは限りません。
    - ただし Lens/Doublet/Triplet の material* に "AIR" を提案・設定しないでください（空気はレンズ材として不正）。
    - 材料変更は set_block_param で parameters 側（key=material/material1/material2/material3）を更新してください。
- object は height ではなく xHeightAngle / yHeightAngle（フィールド定義）を主に使います。
- 口径は context.system[].semidia（光学系テーブルの semidia 列）です。
- 半径は context.system[].radius が数値、数値でない場合は context.system[].radiusRaw（例: "INF"）になります。null=欠落と決めつけないでください。

設計変更について:
- Design Intent（blocks）を最優先に維持してください。基本はブロックパラメータ更新→展開（Expanded Optical System）です。
- ユーザーが「〜を〜に変更」「set_*」「Surf/面番号指定」「semidia/semiDiameter/radius/thickness/material 等の値変更」を求めた場合は、必ずツール関数を呼んで“実際に反映”してください。文章だけで「変更します」と宣言して終わらないでください。
- blockId が不明でも、Surf（0-index）が指定されていれば set_block_param の surf を使って対象ブロックを解決できます。
- blocks が存在する場合は set_block_param を必ず優先し、set_surface_field は「blocks が無い場合のみ」のフォールバックとして使ってください。
- 「全てのconfig / all configurations」に同じ変更を適用したい場合は、set_block_param に applyToAllConfigs=true を指定してください（blockId が config 間で一致しない場合があるので、surf 指定が安全です）。
- 変更できない/失敗した場合は、理由を1行で述べ、次に必要な情報を最大1つだけ質問してください。
- 変更しない場合は、適用可能な具体値を含む提案（または ACTION_PLAN_JSON）を返してください。

出力:
- まず「現状のボトルネック（根拠=contextの値）」→「修正方針」→「具体的な数値案」の順で。
- context.performance.diagnostics がある場合、回答冒頭に「診断要約」を2〜6行で書いてください。
`;

const ACTION_PLAN_MARKER = 'ACTION_PLAN_JSON';

const COOPT_AI_REFRESH_MESSAGE_TYPE = 'COOPT_AI_REFRESH_UI';
let __aiRefreshMessageHandlerInstalled = false;

function installAIRefreshMessageHandler() {
    if (__aiRefreshMessageHandlerInstalled) return;
    __aiRefreshMessageHandlerInstalled = true;
    try {
        window.addEventListener('message', (event) => {
            try {
                const data = event?.data;
                if (!data || typeof data !== 'object') return;
                if (data.type !== COOPT_AI_REFRESH_MESSAGE_TYPE) return;
                // Run refresh in THIS window context (important for Tabulator tables).
                refreshUIInWindow(window);
            } catch (_) {}
        });
    } catch (_) {}
}

async function refreshUIInWindow(targetWin) {
    const w = targetWin;
    if (!w) return;
    try {
        const mgr = w.ConfigurationManager;
        const fn = (mgr && typeof mgr.loadActiveConfigurationToTables === 'function')
            ? mgr.loadActiveConfigurationToTables
            : (typeof w.loadActiveConfigurationToTables === 'function' ? w.loadActiveConfigurationToTables : null);
        if (fn) {
            await fn.call(mgr || w, {
                applyToUI: true,
                suppressOpticalSystemDataChanged: true,
            });
        }
    } catch (_) {}
    try { if (typeof w.refreshBlockInspector === 'function') w.refreshBlockInspector(); } catch (_) {}
    try {
        if (w.meritFunctionEditor && typeof w.meritFunctionEditor.calculateMerit === 'function') {
            w.meritFunctionEditor.calculateMerit();
        }
    } catch (_) {}
    try {
        if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.scheduleEvaluateAndUpdate === 'function') {
            w.systemRequirementsEditor.scheduleEvaluateAndUpdate();
        }
    } catch (_) {}
}

function shouldForceToolCallForRequest(userText) {
    const t = String(userText || '');
    const patterns = [
        /\bset_(block_param|surface_field)\b/i,
        /\bSurf\s*\d+\b/i,
        /semidia|semi\s*dia(meter)?/i,
        /\b(radius|thickness|material|glass|conic|coef)\b/i,
        /変更|変(更|えて|える|えたい)/,
    ];
    return patterns.some(r => r.test(t));
}

function findNthLensBlockId(cfg, lensIndex1Based) {
    const n = Number(lensIndex1Based);
    if (!Number.isInteger(n) || n <= 0) return null;
    const blocks = cfg?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) return null;
    const lensBlocks = blocks.filter(b => b && (b.blockType === 'Lens' || b.blockType === 'PositiveLens'));
    const b = lensBlocks[n - 1];
    const id = typeof b?.blockId === 'string' ? b.blockId.trim() : '';
    return id || null;
}

async function maybeApplyLensAsphereRequest(userText) {
    const t = String(userText || '');
    // Must explicitly be an asphere request to avoid surprising edits.
    if (!/(非球面|aspher(e|ic))/i.test(t)) return null;

    const wantsAllConfigs = /(全(て)?|全部|すべて|all)\s*(system\s*)?config/i.test(t);

    // Examples:
    // - "Lens-3 R1を非球面化"
    // - "Lens 3 R2 を aspheric"
    // - "レンズ3 R1 非球面"
    const m = t.match(/(?:\bLens\b|レンズ)\s*[-#]?\s*(\d+)\s*(?:の)?\s*R\s*([12])\b/i);
    if (!m) return null;

    const lensIndex = Number(m[1]);
    const rNum = Number(m[2]);
    if (!Number.isInteger(lensIndex) || lensIndex <= 0) return null;
    if (!(rNum === 1 || rNum === 2)) return null;

    const systemConfig = loadSystemConfigurations();
    const cfg = getActiveConfig(systemConfig);
    if (!systemConfig || !cfg) return null;
    if (!Array.isArray(cfg.blocks) || cfg.blocks.length === 0) return null;

    const prefix = (rNum === 1) ? 'front' : 'back';
    const applyToOneConfigInPlace = (oneCfg) => {
        try {
            const blockId = findNthLensBlockId(oneCfg, lensIndex);
            if (!blockId) return { ok: false, configId: oneCfg?.id, error: `Lens-${lensIndex} not found in blocks` };

            const blocks = deepClone(oneCfg.blocks);
            const b = Array.isArray(blocks) ? blocks.find(x => x && String(x.blockId) === String(blockId)) : null;
            if (!b) return { ok: false, configId: oneCfg?.id, error: `blockId not found: ${blockId}` };

            if (!isPlainObject(b.parameters)) b.parameters = {};
            b.parameters[`${prefix}SurfType`] = 'Aspheric even';
            b.parameters[`${prefix}Conic`] = 0;

            oneCfg.blocks = blocks;

            // Re-expand for legacy/UI views.
            const preservedThickness = pickPreservedObjectThickness(oneCfg, systemConfig);
            const legacyRows = Array.isArray(oneCfg?.opticalSystem) ? oneCfg.opticalSystem : null;
            const exp = expandBlocksToOpticalSystemRows(oneCfg.blocks);
            if (exp && Array.isArray(exp.rows)) {
                if (legacyRows && legacyRows.length > 0) {
                    preserveLegacySemidiaIntoExpandedRows(exp.rows, legacyRows);
                }
                if (preservedThickness !== undefined && exp.rows[0] && typeof exp.rows[0] === 'object') {
                    exp.rows[0].thickness = preservedThickness;
                }
                oneCfg.opticalSystem = exp.rows;
            }

            return { ok: true, configId: oneCfg?.id, blockId };
        } catch (e) {
            return { ok: false, configId: oneCfg?.id, error: String(e?.message || e) };
        }
    };

    if (wantsAllConfigs) {
        const results = [];
        for (const c of systemConfig.configurations || []) {
            results.push(applyToOneConfigInPlace(c));
        }
        await saveAndRefreshUI(systemConfig);
        const okCount = results.filter(r => r.ok).length;
        const ngCount = results.length - okCount;
        if (okCount > 0 && ngCount === 0) {
            return `全configの Lens-${lensIndex} の R${rNum}（${prefix}）を非球面（Aspheric even）に設定しました。`;
        }
        return `全configへ適用: ok=${okCount}, ng=${ngCount}。Lens-${lensIndex} が存在しないconfigがある可能性があります。`;
    }

    const single = applyToOneConfigInPlace(cfg);
    if (!single.ok) return `⚠️ Lens-${lensIndex} を blocks から特定できませんでした。`;
    await saveAndRefreshUI(systemConfig);
    return `Lens-${lensIndex} の R${rNum}（${prefix}）を非球面（Aspheric even）に設定しました。`;
}

/**
 * Initialize the AI Assistant
 */
export function initAIAssistant() {
    if (__aiAssistantInitialized) return;
    __aiAssistantInitialized = true;
    loadConfig();
    loadHistory();
    renderAIButton();
    renderAIModal();
    renderAIPanel();
    attachEventListeners();
    enableAIPanelDrag();
    installAIRefreshMessageHandler();
    installAIGlobalErrorHandlers();
}

export function initAIAssistantPopup() {
    loadConfig();
    loadHistory();
    renderAIModal();
    renderAIPanel();
    attachEventListeners();
    installAIRefreshMessageHandler();
    installAIGlobalErrorHandlers();

    const panel = document.getElementById('ai-assistant-panel');
    if (panel) {
        panel.style.display = 'flex';
        panel.classList.add('ai-panel-popup');
    }

    // In popup mode, close button should close the window.
    const closeBtn = document.getElementById('ai-close-panel-btn');
    if (closeBtn) closeBtn.onclick = () => window.close();
}

function enableAIPanelDrag() {
    const panel = document.getElementById('ai-assistant-panel');
    if (!panel) return;
    const header = panel.querySelector('.ai-panel-header');
    if (!(header instanceof HTMLElement)) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let startWidth = 0;
    let startHeight = 0;
    let pointerId = null;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const onPointerDown = (e) => {
        if (!(e instanceof PointerEvent)) return;
        if (e.button !== 0) return; // left button only
        const t = e.target;
        if (t instanceof HTMLElement) {
            // Don’t start drag when clicking controls.
            if (t.closest('.ai-panel-controls')) return;
            if (t.tagName === 'BUTTON') return;
        }

        const rect = panel.getBoundingClientRect();
        startWidth = rect.width;
        startHeight = rect.height;

        // Convert from right/bottom anchored layout into explicit left/top once user drags.
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        if (!panel.style.left) panel.style.left = `${rect.left}px`;
        if (!panel.style.top) panel.style.top = `${rect.top}px`;

        startLeft = Number.parseFloat(panel.style.left) || rect.left;
        startTop = Number.parseFloat(panel.style.top) || rect.top;
        startX = e.clientX;
        startY = e.clientY;
        dragging = true;
        pointerId = e.pointerId;
        try { header.setPointerCapture(pointerId); } catch (_) {}
        e.preventDefault();
    };

    const onPointerMove = (e) => {
        if (!(e instanceof PointerEvent)) return;
        if (!dragging) return;
        if (pointerId !== null && e.pointerId !== pointerId) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const maxLeft = Math.max(0, window.innerWidth - startWidth);
        const maxTop = Math.max(0, window.innerHeight - startHeight);
        const nextLeft = clamp(startLeft + dx, 0, maxLeft);
        const nextTop = clamp(startTop + dy, 0, maxTop);

        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
    };

    const endDrag = (e) => {
        if (!(e instanceof PointerEvent)) return;
        if (!dragging) return;
        if (pointerId !== null && e.pointerId !== pointerId) return;
        dragging = false;
        try { header.releasePointerCapture(pointerId); } catch (_) {}
        pointerId = null;
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
}

/**
 * Load configuration from localStorage
 */
function loadConfig() {
    const stored = localStorage.getItem(AI_CONFIG_KEY);
    if (stored) {
        try {
            aiConfig = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        } catch (e) {
            console.error('Failed to parse AI config', e);
        }
    }
}

/**
 * Save configuration to localStorage
 */
function saveConfig() {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
}

/**
 * Load chat history from localStorage
 */
function loadHistory() {
    const stored = localStorage.getItem(AI_HISTORY_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const norm = normalizeLoadedChatHistory(parsed);
            chatHistory = norm.history;
            _nextMessageId = norm.nextId;
        } catch (e) {
            console.error('Failed to parse AI history', e);
        }
    }
}

function normalizeLoadedChatHistory(raw) {
    const arr = Array.isArray(raw) ? raw : [];

    // First pass: find the current max id among valid finite ids.
    let maxId = 0;
    for (const m of arr) {
        const id = Number(m?.id);
        if (Number.isFinite(id) && id > maxId) maxId = id;
    }

    // Second pass: ensure ids are unique and valid (fixes "reload but history persists" id collisions).
    const seen = new Set();
    /** @type {any[]} */
    const out = [];
    for (const m0 of arr) {
        if (!m0 || typeof m0 !== 'object') continue;

        let id = Number(m0.id);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
            maxId += 1;
            id = maxId;
        }
        seen.add(id);

        const role = (m0.role === 'assistant' || m0.role === 'user' || m0.role === 'system') ? m0.role : 'assistant';
        const content = (m0.content === undefined || m0.content === null) ? '' : String(m0.content);
        const timestamp = Number(m0.timestamp);
        const actions = Array.isArray(m0.actions) ? m0.actions : null;

        out.push({ id, role, content, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(), actions });
    }

    return { history: out, nextId: Math.max(1, maxId + 1) };
}

/**
 * Save chat history to localStorage
 */
function saveHistory() {
    // Never allow persistence issues to break chat UX.
    try {
        localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(chatHistory));
        return;
    } catch (e) {
        // Typical failure: QuotaExceededError / DOMException when history grows.
        try { console.warn('[AI Assistant] saveHistory failed; pruning history', e); } catch (_) {}
    }

    // Best-effort prune + retry (keep the most recent messages).
    try {
        if (Array.isArray(chatHistory) && chatHistory.length > 200) {
            chatHistory = chatHistory.slice(-200);
        }
        localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(chatHistory));
    } catch (e2) {
        // Give up silently; UI should still work.
        try { console.warn('[AI Assistant] saveHistory retry failed; disabling persistence for this session', e2); } catch (_) {}
    }
}

/**
 * Render the AI Assistant button in the top bar
 */
function renderAIButton() {
    // Check if button already exists
    if (document.getElementById('ai-assistant-btn')) return;

    const optimizeBtn = document.getElementById('optimize-design-intent-btn');
    const anchorParent = optimizeBtn?.parentElement || document.querySelector('.top-buttons-row');
    if (!anchorParent) return;

    const btn = document.createElement('button');
    btn.id = 'ai-assistant-btn';
    btn.textContent = '🤖 AI Assistant';
    btn.title = 'Open AI Optical Consultant';
    btn.onclick = () => {
        const ok = openAIAssistantPopup();
        if (!ok) toggleAIPanel();
    };

    // Place right next to Optimize when possible.
    if (optimizeBtn && optimizeBtn.parentElement === anchorParent) {
        anchorParent.insertBefore(btn, optimizeBtn.nextSibling);
    } else {
        // Fallback: append into the first visible top button row.
        anchorParent.appendChild(btn);
    }
}

function openAIAssistantPopup() {
        try {
                // Reuse a single named window.
                if (_aiPopupWindow && !_aiPopupWindow.closed) {
                        _aiPopupWindow.focus();
                        return true;
                }

                const w = Math.min(720, Math.max(520, Math.floor(window.innerWidth * 0.45)));
                const h = Math.min(900, Math.max(640, Math.floor(window.innerHeight * 0.8)));
                const left = Math.max(0, Math.floor((window.screenX || 0) + (window.outerWidth - w) / 2));
                const top = Math.max(0, Math.floor((window.screenY || 0) + (window.outerHeight - h) / 2));
                const features = [
                        `width=${w}`,
                        `height=${h}`,
                        `left=${left}`,
                        `top=${top}`,
                        'resizable=yes',
                        'scrollbars=yes'
                ].join(',');

                const popup = window.open('', 'coopt-ai-assistant', features);
                if (!popup) return false;

                _aiPopupWindow = popup;

                const baseHref = new URL('.', window.location.href).toString();
                const html = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="${baseHref}" />
    <title>AI Assistant</title>
    <link rel="stylesheet" href="styles.css" />
</head>
<body>
    <script>window.__AI_ASSISTANT_MODE = 'popup';<\/script>
    <script type="module">
        import { initAIAssistantPopup } from './ai-assistant.js';
        initAIAssistantPopup();
    <\/script>
</body>
</html>`;

                popup.document.open();
                popup.document.write(html);
                popup.document.close();
                popup.focus();
                return true;
        } catch (e) {
                console.warn('Failed to open AI Assistant popup:', e);
                return false;
        }
}

/**
 * Render the Settings Modal
 */
function renderAIModal() {
    const modalHtml = `
        <div id="ai-settings-modal" class="modal">
            <div class="modal-content">
                <span class="close-modal">&times;</span>
                <h2>AI Assistant Settings</h2>
                <div class="form-group">
                    <label for="ai-provider">Provider:</label>
                    <select id="ai-provider">
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="ai-model-select">Model:</label>
                    <select id="ai-model-select"></select>
                    <input type="text" id="ai-model-custom" placeholder="Custom model id" style="display:none; margin-top:6px;">
                </div>
                <div class="form-group">
                    <label for="ai-api-key">API Key:</label>
                    <input type="password" id="ai-api-key" placeholder="Enter your API Key">
                </div>
                <div class="modal-actions">
                    <button id="save-ai-settings-btn">Save Settings</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function getPresetModelsForProvider(provider) {
    const p = String(provider || '').trim();
    if (p === 'openai') {
        return [
            { value: '', label: '(Auto)' },
            { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            { value: 'gpt-4o', label: 'gpt-4o' },
            { value: '__custom__', label: 'Custom…' }
        ];
    }
    if (p === 'anthropic') {
        return [
            { value: '', label: '(Auto)' },
            { value: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet-latest' },
            { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest' },
            { value: '__custom__', label: 'Custom…' }
        ];
    }
    // gemini (default)
    return [
        { value: '', label: '(Auto: ListModels)' },
        { value: 'gemini-1.5-flash', label: 'gemini-1.5-flash' },
        { value: 'gemini-1.5-pro', label: 'gemini-1.5-pro' },
        { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
        { value: '__custom__', label: 'Custom…' }
    ];
}

function setModelSelectOptions({ provider, options, desiredModel }) {
    const sel = document.getElementById('ai-model-select');
    const custom = document.getElementById('ai-model-custom');
    if (!(sel instanceof HTMLSelectElement) || !(custom instanceof HTMLInputElement)) return;

    const opts = Array.isArray(options) ? options : [];
    sel.innerHTML = opts.map(o => `<option value="${String(o.value)}">${escapeHtml(String(o.label))}</option>`).join('');

    const desired = String(desiredModel || '').trim();
    const hasDesired = desired !== '' && opts.some(o => String(o.value) === desired);
    if (desired === '') {
        sel.value = '';
        custom.style.display = 'none';
        custom.value = '';
    } else if (hasDesired) {
        sel.value = desired;
        custom.style.display = 'none';
        custom.value = '';
    } else {
        sel.value = '__custom__';
        custom.style.display = '';
        custom.value = desired;
    }

    // Ensure custom visibility is synced with current selection.
    const onSel = () => {
        if (sel.value === '__custom__') {
            custom.style.display = '';
            if (!custom.value) custom.value = desired;
        } else {
            custom.style.display = 'none';
        }
    };
    onSel();
}

async function refreshModelOptionsForProvider({ provider, apiKey, desiredModel }) {
    const p = String(provider || '').trim();
    // Start with presets immediately.
    setModelSelectOptions({ provider: p, options: getPresetModelsForProvider(p), desiredModel });

    // For Gemini, try ListModels when API key is present.
    if (p === 'gemini') {
        const key = String(apiKey || '').trim();
        if (!key) return;
        try {
            const names = await listGeminiModels(key);
            const cleaned = names.map(n => String(n).replace(/^models\//, '')).filter(Boolean);
            const options = [{ value: '', label: '(Auto: ListModels)' }]
                .concat(cleaned.slice(0, 60).map(n => ({ value: n, label: n })))
                .concat([{ value: '__custom__', label: 'Custom…' }]);
            setModelSelectOptions({ provider: p, options, desiredModel });
        } catch (_) {
            // Keep presets if ListModels fails.
        }
    }
}

/**
 * Render the AI Assistant Panel (Chat Interface)
 */
function renderAIPanel() {
    // Idempotent: avoid duplicate panels/duplicate IDs (breaks Send wiring).
    try {
        const existing = document.getElementById('ai-assistant-panel');
        if (existing) {
            renderChatHistory();
            return;
        }
    } catch (_) {}
    const panelHtml = `
        <div id="ai-assistant-panel" class="ai-panel" style="display: none;">
            <div class="ai-panel-header">
                <h3>AI Optical Consultant</h3>
                <div class="ai-panel-controls">
                    <button id="ai-settings-open-btn" title="Settings">⚙️</button>
                    <button id="ai-clear-chat-btn" title="Clear Chat">🗑️</button>
                    <button id="ai-close-panel-btn" title="Close">✖️</button>
                </div>
            </div>
            <div id="ai-chat-history" class="ai-chat-history">
                <!-- Messages will appear here -->
            </div>
            <div class="ai-input-area">
                <textarea id="ai-user-input" placeholder="Ask about your optical system... (e.g., 'Why is the spot size large?')"></textarea>
                <button id="ai-send-btn">Send</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', panelHtml);
    renderChatHistory();
}

/**
 * Attach event listeners
 */
function attachEventListeners() {
    // Modal controls
    const modal = document.getElementById('ai-settings-modal');
    const closeBtn = modal?.querySelector?.('.close-modal');
    const saveBtn = document.getElementById('save-ai-settings-btn');
    const settingsOpenBtn = document.getElementById('ai-settings-open-btn');
    const providerSelect = document.getElementById('ai-provider');
    const apiKeyInput = document.getElementById('ai-api-key');
    const modelSelect = document.getElementById('ai-model-select');
    const modelCustom = document.getElementById('ai-model-custom');

    if (settingsOpenBtn && modal) settingsOpenBtn.onclick = () => {
        // Populate fields
        if (providerSelect) providerSelect.value = aiConfig.provider;
        if (apiKeyInput) apiKeyInput.value = aiConfig.apiKey;
        modal.style.display = 'block';

        refreshModelOptionsForProvider({
            provider: providerSelect?.value,
            apiKey: apiKeyInput?.value,
            desiredModel: aiConfig.model
        });
    };

    if (closeBtn && modal) closeBtn.onclick = () => modal.style.display = 'none';
    // Do not clobber other modules' click handlers.
    if (modal) {
        window.addEventListener('click', (event) => {
            try {
                if (event && event.target === modal) modal.style.display = 'none';
            } catch (_) {}
        });
    }

    if (saveBtn && modal) saveBtn.onclick = () => {
        aiConfig.provider = providerSelect?.value || 'gemini';
        const selVal = modelSelect?.value ?? '';
        const modelVal = (selVal === '__custom__') ? (modelCustom?.value ?? '') : selVal;
        aiConfig.model = String(modelVal || '').trim();
        aiConfig.apiKey = apiKeyInput?.value ?? '';
        saveConfig();
        modal.style.display = 'none';
        alert('AI Settings Saved!');
    };

    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            refreshModelOptionsForProvider({
                provider: providerSelect.value,
                apiKey: apiKeyInput?.value,
                desiredModel: ''
            });
        });
    }

    if (modelSelect && modelCustom) {
        modelSelect.addEventListener('change', () => {
            modelCustom.style.display = (modelSelect.value === '__custom__') ? '' : 'none';
        });
    }

    // Panel controls
    const closePanelBtn = document.getElementById('ai-close-panel-btn');
    if (closePanelBtn) closePanelBtn.onclick = toggleAIPanel;
    const clearChatBtn = document.getElementById('ai-clear-chat-btn');
    if (clearChatBtn) clearChatBtn.onclick = () => {
        if (confirm('Clear chat history?')) {
            chatHistory = [];
            saveHistory();
            renderChatHistory();
        }
    };

    // Chat interaction
    const sendBtn = document.getElementById('ai-send-btn');
    const input = document.getElementById('ai-user-input');

    const handleSend = async () => {
        try {
            const text = input?.value?.trim?.() || '';
        if (!text) return;

        // Add user message
            addMessage('user', text);
            if (input) input.value = '';

            // Always show immediate UI feedback so "Send" never feels dead.
            const thinkingMsgId = addMessage('assistant', '');
            updateMessage(thinkingMsgId, { content: 'Collecting system context...' });

        // Get System Context
        let context = {};
        try {
            // Avoid hanging forever on context collection.
            context = await Promise.race([
                getSystemContext(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getSystemContext timed out')), 15000))
            ]);
        } catch (e) {
            console.error('Failed to get system context', e);
            context = { error: 'Failed to retrieve system data' };
        }

            // Deterministic PSF last-result summary (avoid hallucinations)
            // Note: These paths should overwrite the temporary thinking message.
            updateMessage(thinkingMsgId, { content: 'Thinking...' });

        // Deterministic PSF last-result summary (avoid hallucinations)
        const localAnswer = maybeBuildLocalAnswer(text, context);
        if (localAnswer) {
            updateMessage(thinkingMsgId, { content: localAnswer });
            return;
        }

        // Deterministic multi-config edit (avoids model/tool arg ambiguity)
        const localApplied = await maybeApplyStopSemiDiameterAllConfigs(text);
        if (localApplied) {
            updateMessage(thinkingMsgId, { content: localApplied });
            return;
        }

        // Deterministic Lens-Rx aspherize (avoids ambiguous surface index mapping).
        const localAsphereApplied = await maybeApplyLensAsphereRequest(text);
        if (localAsphereApplied) {
            updateMessage(thinkingMsgId, { content: localAsphereApplied });
            return;
        }

        const contextJson = JSON.stringify(context);

        const systemMessage = {
            role: 'system',
            content: SYSTEM_INSTRUCTIONS_JA
        };

        // Keep context separate to reduce prompt injection & to simplify tool calling.
        const contextMessage = {
            role: 'user',
            content: `CONTEXT_JSON (do not edit; read-only):\n${contextJson}`
        };

        const userMessage = {
            role: 'user',
            content: `ユーザーの要望: ${text}`
        };

        const openAiMessages = [systemMessage, contextMessage, userMessage];

        const forceToolCall = shouldForceToolCallForRequest(text);

        const geminiSystemInstruction = SYSTEM_INSTRUCTIONS_JA;
        const geminiContents = [
            { role: 'user', parts: [{ text: `CONTEXT_JSON (do not edit; read-only):\n${contextJson}` }] },
            { role: 'user', parts: [{ text: `ユーザーの要望: ${text}` }] }
        ];

        // Call API
            console.log('Sending to AI:', { provider: aiConfig.provider, model: aiConfig.model || '(auto)', userText: text });
        
            if (!aiConfig.apiKey) {
                updateMessage(thinkingMsgId, { content: '⚠️ Please configure your API Key in settings (⚙️).' });
                return;
            }
        
        try {
            if (aiConfig.provider === 'openai') {
                await runOpenAIConversationWithTools({
                    messages: openAiMessages,
                    apiKey: aiConfig.apiKey,
                    model: aiConfig.model,
                    thinkingMsgId,
                    forceToolCall
                });
            } else if (aiConfig.provider === 'gemini') {
                await runGeminiConversationWithTools({
                    systemInstruction: geminiSystemInstruction,
                    contents: geminiContents,
                    apiKey: aiConfig.apiKey,
                    model: aiConfig.model,
                    thinkingMsgId,
                    forceToolCall
                });
            } else {
                updateMessage(thinkingMsgId, { content: 'Provider not supported yet.' });
            }

            } catch (error) {
                console.error('AI API Error:', error);
                const msg = (error && typeof error === 'object' && 'message' in error) ? String(error.message) : String(error);
                const stack = (error && typeof error === 'object' && 'stack' in error) ? String(error.stack) : '';
                updateMessage(thinkingMsgId, { content: `❌ Error: ${msg}${stack ? `\n\n${stack}` : ''}` });
            }
        } catch (outerErr) {
            // This catches UI wiring / context gathering errors so user sees *something*.
            console.error('[AI Assistant] handleSend failed:', outerErr);
            const msg = (outerErr && typeof outerErr === 'object' && 'message' in outerErr) ? String(outerErr.message) : String(outerErr);
            const stack = (outerErr && typeof outerErr === 'object' && 'stack' in outerErr) ? String(outerErr.stack) : '';
            try { addMessage('assistant', `❌ Internal error: ${msg}${stack ? `\n\n${stack}` : ''}`); } catch (_) {}
        }
    };

    if (sendBtn) sendBtn.onclick = handleSend;
    if (input) input.onkeydown = (e) => {
        // Enter inserts a newline.
        // Use Cmd+Enter (macOS) / Ctrl+Enter (others) to send.
        // Avoid sending while IME (Japanese) is composing.
        if (!e || e.isComposing) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSend();
            return;
        }
    };
}

function scheduleRenderChatHistory() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        try { renderChatHistory(); } catch (_) {}
    });
}

function updateMessage(id, patch) {
    const idx = chatHistory.findIndex(m => m && m.id === id);
    if (idx < 0) return;
    chatHistory[idx] = { ...chatHistory[idx], ...patch };
    saveHistory();
    scheduleRenderChatHistory();
}

function formatAppliedToolLog(toolLogs) {
    if (!Array.isArray(toolLogs) || toolLogs.length === 0) return '';
    return [
        `✅ Applied ${toolLogs.length} change(s).`,
        '',
        '---',
        '(適用ログ)',
        ...toolLogs.map(s => `- ${s}`),
        '---',
        ''
    ].join('\n');
}

function maybeBuildLocalAnswer(userText, context) {
    const wantPsf = isPsfLastResultSummaryRequest(userText);
    const wantWavefront = isWavefrontSummaryRequest(userText);
    const wantOpd = isOpdSummaryRequest(userText);
    const wantOverview = isOpticalSystemOverviewRequest(userText);
    if (!wantPsf && !wantWavefront && !wantOpd && !wantOverview) return null;

    if (wantOverview) {
        return buildOpticalSystemOverview(context);
    }

    const rd = context?.runtimeDiagnostics;
    if (!rd) {
        return [
            'runtimeDiagnostics が context に存在しません。',
            'この質問に答えるには、まず PSF 計算を実行してから AI を呼び出してください。'
        ].join('\n');
    }

    const lines = [];

    if (wantPsf) {
        const psfLastResult = rd.psfLastResult || null;
        const psfError = rd.psfError || null;
        const psfUI = rd.psfUI || null;

        lines.push('PSF（runtimeDiagnostics.psfLastResult）要約（引用ベース）:');

        if (psfLastResult) {
            lines.push('- psfLastResult:');
            lines.push(formatQuotedKeyValues(psfLastResult, [
                'from',
                'at',
                'wavelength',
                'objectIndex',
                'psfMethod',
                'performanceMode',
                'psfSamplingSize',
                'zernikeFitSamplingSize',
                'gridSize',
                'calculationTime',
                'calculationTimeMs',
                'hasMetrics',
                'metricKeys',
                'psfSummary'
            ]));

            if (psfLastResult.hasMetrics === false || (Array.isArray(psfLastResult.metricKeys) && psfLastResult.metricKeys.length === 0)) {
                lines.push('補足: この実行結果にはメトリクスが含まれていません（hasMetrics=false または metricKeys が空）。');
            }
        } else {
            lines.push('- psfLastResult: null（PSFの直近成功結果が保存されていません）');
        }

        if (psfError) {
            lines.push('- psfError（直近エラー）:');
            lines.push(formatQuotedKeyValues(psfError, ['from', 'at', 'code', 'message', 'hint', 'wavelength', 'objectIndex', 'gridSize', 'psfSamplingSize', 'zernikeFitSamplingSize']));
        }

        if (psfUI) {
            lines.push('- psfUI（取得できたUI値）:');
            lines.push(formatQuotedKeyValues(psfUI, ['objectIndex', 'samplingSize', 'zernikeFitSamplingSize', 'performanceMode', 'wasmStatusText']));
        }

        lines.push('次の確認:');
        lines.push('- PSF をもう一度実行し、psfLastResult.psfSummary が入るか（または hasMetrics/metricKeys が変わるか）を確認');
        lines.push('- もし psfError が出ている場合は、まず psfError.message/hint の内容に沿って切り分け');
    }

    if (wantWavefront) {
        const wavefront = rd.wavefront || null;
        lines.push('Wavefront（runtimeDiagnostics.wavefront）要約（引用ベース）:');
        if (wavefront) {
            lines.push('- wavefront:');
            // Print meta/error/statistics once; statistics sub-objects are included as JSON.
            lines.push(formatQuotedKeyValues(wavefront, ['from', 'meta', 'hasError', 'error', 'statistics']));
            if (wavefront?.hasError) {
                lines.push('補足: wavefront.hasError=true なので wavefront.error を根拠に切り分けしてください。');
            }
        } else {
            lines.push('- wavefront: null（直近の波面/OPDマップ結果が保存されていません）');
        }
    }

    if (wantOpd) {
        const opdLastRay = rd.opdLastRay || null;
        lines.push('OPD last ray（runtimeDiagnostics.opdLastRay）要約（引用ベース）:');
        if (opdLastRay) {
            lines.push('- opdLastRay:');
            lines.push(formatQuotedKeyValues(opdLastRay, ['success', 'error', 'fieldKey', 'pupilCoord', 'stopHit']));
        } else {
            lines.push('- opdLastRay: null（直近のOPDレイ計算が保存されていません）');
        }
    }

    if (wantWavefront || wantOpd) {
        const wavefrontMissing = wantWavefront && !rd.wavefront;
        const opdMissing = wantOpd && !rd.opdLastRay;
        const needRun = wavefrontMissing || opdMissing;

        if (needRun) {
            lines.push('次の確認:');
            if (wavefrontMissing) lines.push('- 波面/光路差表示を一度実行し、runtimeDiagnostics.wavefront が埋まるか確認');
            if (opdMissing) lines.push('- Show wavefront diagram を一度実行し、runtimeDiagnostics.opdLastRay が埋まるか確認');
        }
    }

    return lines.join('\n');
}

function isOpticalSystemOverviewRequest(text) {
    if (!text) return false;
    const t = String(text);
    return (
        t.includes('現在の光学系') ||
        t.includes('この光学系') ||
        t.includes('光学系について説明') ||
        t.includes('システムについて説明') ||
        /describe\s+(the\s+)?(current\s+)?optical\s+system/i.test(t)
    );
}

function buildOpticalSystemOverview(context) {
    if (!context || typeof context !== 'object') {
        return 'context が取得できませんでした。';
    }

    const lines = [];
    const meta = context.meta || {};
    const cfg = meta.activeConfig || null;
    const system = Array.isArray(context.system) ? context.system : [];
    const sources = Array.isArray(context.sources) ? context.sources : [];
    const objects = Array.isArray(context.objects) ? context.objects : [];
    const perf = context.performance || {};
    const diag = perf?.diagnostics || null;
    const targets = context.targets || null;
    const di = context.designIntent || null;

    lines.push('光学系サマリ（CONTEXT_JSONより）:');
    if (cfg) {
        const cfgName = cfg.name ? String(cfg.name) : '(no name)';
        const cfgId = (cfg.id === null || cfg.id === undefined) ? '(no id)' : String(cfg.id);
        const scen = (cfg.activeScenarioId === null || cfg.activeScenarioId === undefined) ? null : String(cfg.activeScenarioId);
        lines.push(`- Active config: ${cfgName} (id=${cfgId}${scen ? `, scenario=${scen}` : ''})`);
    }
    lines.push(`- Surface count: ${system.length} (Surf 0..${Math.max(0, system.length - 1)})`);

    const idxObject = system.findIndex(r => r && (r.isObject || String(r.type || '').toLowerCase().includes('object')));
    const idxImage = system.findIndex(r => r && (r.isImage || String(r.type || '').toLowerCase().includes('image')));
    const idxStop = system.findIndex(r => r && String(r.type || '').toLowerCase().includes('stop'));
    if (idxObject >= 0) lines.push(`- Object surface: Surf ${idxObject}`);
    if (idxStop >= 0) {
        const sd = system[idxStop]?.semidia;
        lines.push(`- Stop: Surf ${idxStop}${(typeof sd === 'number') ? ` (semidia=${sd})` : ''}`);
    }
    if (idxImage >= 0) lines.push(`- Image surface: Surf ${idxImage}`);

    const glassSet = new Set();
    let airCount = 0;
    for (const r of system) {
        const m = (r && r.material) ? String(r.material) : 'AIR';
        if (m === 'AIR') airCount++;
        else glassSet.add(m);
    }
    lines.push(`- Media: AIR rows=${airCount}, glass kinds=${glassSet.size}${glassSet.size ? ` (${Array.from(glassSet).slice(0, 6).join(', ')}${glassSet.size > 6 ? ', …' : ''})` : ''}`);

    if (di && typeof di === 'object') {
        const bc = (typeof di.blockCount === 'number') ? di.blockCount : null;
        lines.push(`- Design Intent (blocks): ${bc !== null ? bc : 'n/a'} block(s)`);
    } else {
        lines.push('- Design Intent (blocks): not available (surface-only / import mode の可能性)');
    }

    // Source / Object
    if (sources.length) {
        const wls = sources.map(s => s?.wavelength).filter(v => typeof v === 'number' && Number.isFinite(v));
        const primary = sources.find(s => String(s?.primary || '').toLowerCase().includes('primary'))?.wavelength;
        const minW = wls.length ? Math.min(...wls) : null;
        const maxW = wls.length ? Math.max(...wls) : null;
        lines.push(`- Sources: ${sources.length} (λ: ${minW !== null ? minW : 'n/a'} .. ${maxW !== null ? maxW : 'n/a'} μm${(typeof primary === 'number') ? `, primary=${primary} μm` : ''})`);
    } else {
        lines.push('- Sources: 0');
    }
    if (objects.length) {
        const modes = Array.from(new Set(objects.map(o => String(o?.position || '')).filter(Boolean)));
        lines.push(`- Objects/Fields: ${objects.length}${modes.length ? ` (position: ${modes.join(', ')})` : ''}`);
    } else {
        lines.push('- Objects/Fields: 0');
    }

    // Performance
    if (diag && Array.isArray(diag.steps) && diag.steps.some(s => s && s.ok === false)) {
        const failed = diag.steps.filter(s => s && s.ok === false);
        lines.push('診断要約:');
        for (const f of failed.slice(0, 3)) {
            const msg = f?.error?.message ? String(f.error.message) : '(no message)';
            lines.push(`- 計算失敗: ${String(f.step)}: ${msg}`);
        }
        if (failed.length > 3) lines.push(`- (他 ${failed.length - 3} 件)`);
    } else {
        const fl = (typeof perf.focalLength === 'number') ? perf.focalLength : null;
        const fno = (typeof perf.fNumber === 'number') ? perf.fNumber : null;
        const mag = (typeof perf.magnification === 'number') ? perf.magnification : null;
        lines.push('近軸/Seidel（計算できた範囲）:');
        lines.push(`- focalLength: ${fl !== null ? fl : 'n/a'}`);
        lines.push(`- fNumber: ${fno !== null ? fno : 'n/a'}`);
        lines.push(`- magnification: ${mag !== null ? mag : 'n/a'}`);

        const s = perf?.seidel || {};
        const seidelKeys = ['spherical', 'coma', 'astigmatism', 'fieldCurvature', 'distortion', 'lca', 'tca'];
        const anySeidel = seidelKeys.some(k => typeof s[k] === 'number');
        if (anySeidel) {
            lines.push(`- seidel sums: S1=${s.spherical ?? 'n/a'}, S2=${s.coma ?? 'n/a'}, S3=${s.astigmatism ?? 'n/a'}, S4=${s.fieldCurvature ?? 'n/a'}, S5=${s.distortion ?? 'n/a'}`);
            if (typeof s.lca === 'number' || typeof s.tca === 'number') lines.push(`- chromatic: LCA=${s.lca ?? 'n/a'}, TCA=${s.tca ?? 'n/a'}`);
        }
    }

    // Requirements snapshot (only if it already has evaluated fields)
    const reqRows = targets?.requirements?.rows;
    if (Array.isArray(reqRows) && reqRows.length) {
        const evaluated = reqRows.filter(r => (typeof r?.current === 'number') || (r?.status));
        lines.push(`Requirements: enabled=${reqRows.length}${evaluated.length ? ` (evaluated=${evaluated.length})` : ''}`);
        for (const r of evaluated.slice(0, 6)) {
            const op = r.op ? String(r.op) : '';
            const tgt = (typeof r.target === 'number') ? r.target : 'n/a';
            const cur = (typeof r.current === 'number') ? r.current : 'n/a';
            const st = r.status ? String(r.status) : '';
            lines.push(`- ${String(r.operand)} ${op} target=${tgt} current=${cur}${st ? ` status=${st}` : ''}`);
        }
    }

    lines.push('次にできること:');
    lines.push('- どの評価結果（Spot/PSF/Wavefront）を根拠に改善するかを指定すると、blocks優先で具体的な変更案を出せます。');
    return lines.join('\n');
}

async function maybeApplyStopSemiDiameterAllConfigs(userText) {
    const t = String(userText || '');
    // Detect user intent "apply to all configurations" (JP/EN + common typos).
    const wantsAll = /(全て|すべて|全部|全\s*config|全\s*コンフィグ|全\s*構成|all|every)/i.test(t);
    const mentionsConfig = /(config|configs|configuration|configurations|system\s*config|sytem\s*config|コンフィグ|構成)/i.test(t);
    if (!(wantsAll && mentionsConfig)) return null;
    const mSurf = t.match(/\bSurf\s*(\d+)\b/i) || t.match(/面\s*(\d+)/);
    if (!mSurf) return null;
    const surf = Number(mSurf[1]);
    if (!Number.isInteger(surf) || surf < 0) return null;
    if (!/stop/i.test(t)) return null;
    if (!/semidia|semi\s*dia(meter)?/i.test(t)) return null;

    // Accept: "...を 11.9 に" (including "12に"), "... = 11.9", or trailing number.
    const mVal = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:に|へ)(?:\s|$|[、。,.])/)
        || t.match(/=\s*([0-9]+(?:\.[0-9]+)?)/)
        || t.match(/\b([0-9]+(?:\.[0-9]+)?)\b\s*$/);
    if (!mVal) return null;
    const value = Number(mVal[1]);
    if (!Number.isFinite(value) || value <= 0) return null;

    const systemConfig = loadSystemConfigurations();
    const cfgActive = getActiveConfig(systemConfig);
    if (!systemConfig || !cfgActive) return '❌ Error: systemConfigurations / active configuration not found';

    const results = [];
    for (const c of systemConfig.configurations || []) {
        try {
            if (!Array.isArray(c.blocks) || c.blocks.length === 0) {
                results.push({ ok: false, configId: c?.id, error: 'no blocks' });
                continue;
            }
            const exp = expandBlocksToOpticalSystemRows(c.blocks);
            const row = exp?.rows?.[surf];
            const blockId = row?._blockId;
            const blockType = row?._blockType;
            if (!blockId) {
                results.push({ ok: false, configId: c?.id, error: `surf=${surf} has no _blockId` });
                continue;
            }
            if (blockType !== 'Stop') {
                results.push({ ok: false, configId: c?.id, error: `surf=${surf} is not Stop (blockType=${String(blockType)})` });
                continue;
            }

            const blocks = deepClone(c.blocks);
            const b = blocks.find(x => x && String(x.blockId) === String(blockId));
            if (!b) {
                results.push({ ok: false, configId: c?.id, error: `blockId not found: ${String(blockId)}` });
                continue;
            }
            if (String(b.blockType || '').trim() !== 'Stop') {
                results.push({ ok: false, configId: c?.id, error: `blockId=${String(blockId)} is not Stop` });
                continue;
            }

            if (!isPlainObject(b.parameters)) b.parameters = {};
            b.parameters.semiDiameter = value;

            // Best-effort keep variables in sync for legacy tooling.
            if (!isPlainObject(b.variables)) b.variables = {};
            const existing = b.variables.semiDiameter;
            if (isPlainObject(existing)) existing.value = value;
            else b.variables.semiDiameter = { value };

            c.blocks = blocks;

            // Re-expand derived table.
            const preservedThickness = pickPreservedObjectThickness(c, systemConfig);
            const legacyRows = Array.isArray(c?.opticalSystem) ? c.opticalSystem : null;
            const exp2 = expandBlocksToOpticalSystemRows(c.blocks);
            if (exp2 && Array.isArray(exp2.rows)) {
                if (legacyRows && legacyRows.length > 0) {
                    preserveLegacySemidiaIntoExpandedRows(exp2.rows, legacyRows);
                }
                if (preservedThickness !== undefined && exp2.rows[0] && typeof exp2.rows[0] === 'object') {
                    exp2.rows[0].thickness = preservedThickness;
                }
                c.opticalSystem = exp2.rows;
            }

            results.push({ ok: true, configId: c?.id, blockId: String(blockId) });
        } catch (e) {
            results.push({ ok: false, configId: c?.id, error: e?.message || String(e) });
        }
    }

    await saveAndRefreshUI(systemConfig);

    const okCount = results.filter(r => r.ok).length;
    const total = results.length;
    const fail = results.filter(r => !r.ok);
    const failPreview = fail.slice(0, 3).map(r => `- ${String(r.configId)}: ${r.error}`);

    return [
        `Surf ${surf}（Stop）のsemiDiameterを${value}に変更しました（全config）。`,
        '',
        '---',
        '(適用ログ)',
        `- set_block_param(all configs): ok=${okCount}/${total}${fail.length ? ` fail=${fail.length}` : ''}`,
        ...(failPreview.length ? failPreview : [])
    ].join('\n');
}

function isPsfLastResultSummaryRequest(text) {
    if (!text) return false;
    const t = String(text);
    return (
        t.includes('runtimeDiagnostics.psfLastResult') ||
        t.includes('psfLastResult')
    ) && (
        t.includes('引用') ||
        t.includes('要約')
    );
}

function isWavefrontSummaryRequest(text) {
    if (!text) return false;
    const t = String(text);
    const mentionsTarget = (
        t.includes('runtimeDiagnostics.wavefront') ||
        /wavefront/i.test(t) ||
        t.includes('波面')
    );
    const wantsSummary = t.includes('引用') || t.includes('要約');
    return mentionsTarget && wantsSummary;
}

function isOpdSummaryRequest(text) {
    if (!text) return false;
    const t = String(text);
    const mentionsTarget = (
        t.includes('runtimeDiagnostics.opdLastRay') ||
        t.includes('opdLastRay') ||
        /\bOPD\b/i.test(t) ||
        t.includes('光路差')
    );
    const wantsSummary = t.includes('引用') || t.includes('要約');
    return mentionsTarget && wantsSummary;
}

function formatQuotedKeyValues(obj, preferredOrder) {
    if (!obj || typeof obj !== 'object') return '  - (none)';

    const keys = Array.isArray(preferredOrder) && preferredOrder.length
        ? preferredOrder.filter(k => Object.prototype.hasOwnProperty.call(obj, k))
        : Object.keys(obj);

    if (keys.length === 0) return '  - (no fields)';

    return keys.map((k) => {
        const v = obj[k];
        let rendered;
        if (v === null || v === undefined) {
            rendered = String(v);
        } else if (typeof v === 'string') {
            rendered = v;
        } else {
            try {
                rendered = JSON.stringify(v);
            } catch {
                rendered = String(v);
            }
        }
        return `  - ${k}: ${rendered}`;
    }).join('\n');
}

/**
 * Toggle AI Panel visibility
 */
function toggleAIPanel() {
    const panel = document.getElementById('ai-assistant-panel');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'flex';
}

/**
 * Add message to history and render
 */
function addMessage(role, content) {
    const id = _nextMessageId++;
    chatHistory.push({ id, role, content, timestamp: Date.now(), actions: null });
    saveHistory();
    scheduleRenderChatHistory();
    return id;
}

/**
 * Render chat history
 */
function renderChatHistory() {
    const container = document.getElementById('ai-chat-history');
    if (!container) return;

    container.innerHTML = chatHistory.map(msg => {
        const hasActions = Array.isArray(msg.actions) && msg.actions.length > 0;
        const actionsHtml = hasActions
            ? `<div class="ai-message-actions"><button class="ai-apply-btn" data-ai-action="apply" data-ai-msg-id="${msg.id}">提案を適用</button></div>`
            : '';
        return `
        <div class="ai-message ai-message-${msg.role}" data-ai-msg-id="${msg.id}">
            <div class="ai-message-content">${escapeHtml(msg.content)}</div>
            ${actionsHtml}
        </div>`;
    }).join('');
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// One-time event delegation for Apply button
document.addEventListener('click', async (e) => {
    const t = e?.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset?.aiAction !== 'apply') return;

    const msgId = Number(t.dataset.aiMsgId);
    if (!Number.isFinite(msgId)) return;
    const msg = chatHistory.find(m => m && m.id === msgId);
    const actions = msg?.actions;
    if (!Array.isArray(actions) || actions.length === 0) return;

    t.setAttribute('disabled', 'true');
    try {
        const out = await applyActionPlan(actions);
        const appended = [
            msg.content,
            '\n\n---\n適用結果:',
            out.ok ? `✅ OK: ${out.appliedCount} actions` : `❌ Failed: ${out.reason || 'unknown reason'}`,
            ...(Array.isArray(out.logs) ? out.logs.map(s => `- ${s}`) : [])
        ].join('\n');
        updateMessage(msgId, { content: appended, actions: null });
    } catch (err) {
        updateMessage(msgId, { content: `${msg.content}\n\n❌ Apply error: ${err?.message || err}` });
    } finally {
        try { t.removeAttribute('disabled'); } catch (_) {}
    }
});

/**
 * Utility to escape HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
}

function normalizeGeminiModelName(model) {
    const raw = String(model || '').trim();
    if (!raw) return '';
    return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

async function listGeminiModels(apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const resp = await fetchWithTimeout(url, { method: 'GET' }, 20000);
    if (!resp.ok) {
        let msg = '';
        try {
            const j = await resp.json();
            msg = j?.error?.message || '';
        } catch (_) {}
        throw new Error(msg || 'Gemini ListModels failed');
    }
    const data = await resp.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    // Filter models that support generateContent when metadata is available.
    const usable = models.filter(m => {
        const methods = m?.supportedGenerationMethods;
        return Array.isArray(methods) ? methods.includes('generateContent') : true;
    });
    return usable.map(m => m?.name).filter(Boolean);
}

function pickGeminiModelFromList(modelNames) {
    const names = (Array.isArray(modelNames) ? modelNames : [])
        .map(n => String(n))
        .filter(Boolean);

    const cleaned = names.map(n => n.replace(/^models\//, ''));

    const preferOrder = [
        // Prefer flash models for speed/cost.
        (n) => n.includes('gemini-1.5-flash'),
        (n) => n.includes('gemini-2.0-flash'),
        (n) => n.includes('flash'),
        // Then pro.
        (n) => n.includes('gemini-1.5-pro'),
        (n) => n.includes('pro'),
        // Anything gemini.
        (n) => n.includes('gemini')
    ];

    for (const pred of preferOrder) {
        const hit = cleaned.find(pred);
        if (hit) return hit;
    }
    return cleaned[0] || '';
}

async function resolveGeminiModel(apiKey, desiredModel) {
    const desired = normalizeGeminiModelName(desiredModel);
    if (desired) return desired;
    const names = await listGeminiModels(apiKey);
    const picked = pickGeminiModelFromList(names);
    if (!picked) throw new Error('Gemini: no available models returned by ListModels');
    return picked;
}

/**
 * Call Google Gemini API
 */
async function callGeminiAPI(prompt, apiKey, model) {
    // If model is not specified (AI Studio UI often hides this), auto-select one.
    const modelName = await resolveGeminiModel(apiKey, model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }]
        })
    }, DEFAULT_AI_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
        let message = 'Gemini API failed';
        try {
            const err = await response.json();
            message = err?.error?.message || message;
        } catch (_) {
            try { message = await response.text(); } catch (_) {}
        }

        // If the model isn't found / doesn't support generateContent, retry with an auto-picked model,
        // and provide a helpful ListModels hint if it still fails.
        const lower = String(message || '').toLowerCase();
        const looksLikeModelIssue = lower.includes('model') && (lower.includes('not found') || lower.includes('not supported'));
        if (looksLikeModelIssue) {
            try {
                const names = await listGeminiModels(apiKey);
                const picked = pickGeminiModelFromList(names);

                // Retry once with the picked model if it's different.
                if (picked && picked !== modelName) {
                    try {
                        // Cache for current session to reduce repeated failures.
                        aiConfig.model = picked;
                    } catch (_) {}
                    return await callGeminiAPI(prompt, apiKey, picked);
                }

                const shortList = names
                    .map(n => String(n).replace(/^models\//, ''))
                    .filter(n => n.includes('gemini'))
                    .slice(0, 20);
                throw new Error(
                    `Gemini model error for "${modelName}": ${message}\n\n` +
                    `利用可能なモデル例（Settings の Model にコピペ可）:\n` +
                    (shortList.length ? shortList.join('\n') : '(取得できませんでした)') +
                    `\n\nModel欄が空でも自動選択します。うまくいかない場合は一覧のモデル名を設定してください。`
                );
            } catch (e) {
                // If ListModels also fails, fall back to original error.
                throw new Error(message);
            }
        }

        throw new Error(message);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text).filter(Boolean).join('')
        ?? data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || '(Gemini: empty response)';
}

function buildGeminiTools() {
    return [{
        functionDeclarations: [
            {
                name: 'set_block_param',
                description: 'Design Intent (blocks) の特定ブロックのパラメータ/変数を更新し、blocks→expanded optical system に再展開してUIへ反映します。',
                parameters: {
                    type: 'object',
                    properties: {
                        blockId: { type: 'string', description: '対象ブロックの blockId（不明な場合は surf を指定可）' },
                        surf: { type: 'integer', description: '0-based surface index（expanded optical system の行）。blockId が不明な場合に使用' },
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration に同じ変更を適用します（surf 指定推奨）' },
                        section: { type: 'string', enum: ['parameters', 'variables'], description: '更新先: parameters または variables' },
                        key: { type: 'string', description: '更新キー（blockTypeに依存。例: Lens=frontRadius/backRadius/centerThickness/material、asphere=frontSurfType/frontConic/frontCoef1..10、Doublet=radius1..3/material1..2、Triplet=radius1..4/material1..3、Stop=semiDiameter、AirGap=thickness）' },
                        value: { description: '新しい値（数値または文字列）' }
                    },
                    // Note: Gemini functionDeclarations schema does not support JSON Schema anyOf.
                    // We enforce "blockId or surf" in tool_set_block_param.
                    required: ['section', 'key', 'value']
                }
            },
            {
                name: 'set_surface_field',
                description: 'フォールバック: Expanded Optical System の表（active config opticalSystem）上の特定面のフィールドを更新します（blocks が無い場合など）。',
                parameters: {
                    type: 'object',
                    properties: {
                        surf: { type: 'integer', description: '0-based surface index' },
                        key: { type: 'string', description: '更新キー（例: radius, thickness, material, semidia, conic）' },
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration に同じ変更を適用します（blocks がある場合は可能な限り blocks に同期）' },
                        value: { description: '新しい値（数値または文字列）' }
                    },
                    required: ['surf', 'key', 'value']
                }
            },
            {
                name: 'set_surface_color',
                description: 'Render Optical System の Surface Colors（面ごとの色）を更新します。localStorage の coopt.surfaceColorOverrides を更新し、3D描画を再描画します。',
                parameters: {
                    type: 'object',
                    properties: {
                        all: { type: 'boolean', description: 'true の場合、全Surface対象（色=Default/None で全解除）' },
                        surf: { type: 'integer', description: '0-based surface index（Surface Colors の # と同じ）' },
                        surfaceId: { type: 'integer', description: 'surface row の id（存在する場合）。指定すると id:NN で更新します。' },
                        blockId: { type: 'string', description: 'provenance 用 blockId（_blockId）。surfaceRole と組で指定すると p:blockId|surfaceRole を更新します。' },
                        surfaceRole: { type: 'string', description: 'provenance 用 surfaceRole（_surfaceRole）。blockId と組で指定します。' },
                        color: { type: 'string', description: '色。#RRGGBB / 0xRRGGBB / "Light Pink" 等。"Default"/"None" で解除。' }
                    },
                    required: ['color']
                }
            },
            {
                name: 'apply_optical_system_rows',
                description: 'Optical System（surface rows）を active configuration に取り込み、可能なら Design Intent（blocks）へ自動変換してUIへ反映します。特許の処方表/表をAIが行配列に整形した後に適用する用途。',
                parameters: {
                    type: 'object',
                    properties: {
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration の opticalSystem を同じ rows に置換します（blocksの自動変換も試みます）' },
                        rows: {
                            type: 'array',
                            description: 'Optical system rows (Surf 0..N-1). Each row may include: object type, radius, thickness, semidia, material, surfType, conic, coef1..coef10, comment',
                            items: { type: 'object' }
                        }
                    },
                    required: ['rows']
                }
            }
        ]
    }];
}

async function callGeminiGenerateContent({ apiKey, model, systemInstruction, contents, tools, forceToolCall }) {
    const modelName = await resolveGeminiModel(apiKey, model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const body = {
        contents: Array.isArray(contents) ? contents : [],
    };
    if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: String(systemInstruction) }] };
    }
    if (Array.isArray(tools) && tools.length) {
        body.tools = tools;
        // Encourage function calling, but let model decide unless user explicitly requested a change.
        body.toolConfig = { functionCallingConfig: { mode: forceToolCall ? 'ANY' : 'AUTO' } };
    }

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }, DEFAULT_AI_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
        let message = 'Gemini API failed';
        try {
            const err = await response.json();
            message = err?.error?.message || message;
        } catch (_) {
            try { message = await response.text(); } catch (_) {}
        }
        throw new Error(message);
    }

    return await response.json();
}

function extractGeminiTextParts(candidate) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => p?.text).filter(Boolean).join('');
}

function extractGeminiFunctionCalls(candidate) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return [];
    const calls = [];
    for (const p of parts) {
        const fc = p?.functionCall;
        if (fc && fc.name) {
            calls.push({
                name: String(fc.name),
                args: isPlainObject(fc.args) ? fc.args : (fc.args ?? {})
            });
        }
    }
    return calls;
}

async function runGeminiConversationWithTools({ systemInstruction, contents, apiKey, model, thinkingMsgId, forceToolCall }) {
    const tools = buildGeminiTools();
    let workingContents = Array.isArray(contents) ? [...contents] : [];
    const toolLogs = [];

    for (let iter = 0; iter < TOOL_MAX_ITERS; iter++) {
        const data = await callGeminiGenerateContent({
            apiKey,
            model,
            systemInstruction,
            contents: workingContents,
            tools,
            // Only force on the first turn; after a tool executes, allow free-form response.
            forceToolCall: !!forceToolCall && iter === 0
        });

        const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
        const calls = extractGeminiFunctionCalls(cand);
        const text = extractGeminiTextParts(cand);

        if (!calls.length) {
            const finalText = text || '(Gemini: empty response)';
            const header = formatAppliedToolLog(toolLogs);
            updateMessage(thinkingMsgId, { content: header ? (header + finalText) : finalText });
            // Back-compat: if model produced ACTION_PLAN_JSON, keep Apply button behavior.
            const parsed = tryParseActionPlanFromText(finalText);
            if (parsed?.actions) updateMessage(thinkingMsgId, { actions: parsed.actions });
            return;
        }

        // Model called tools: execute and send functionResponse parts.
        updateMessage(thinkingMsgId, { content: `Applying ${calls.length} change(s)...` });

        const functionResponseParts = [];
        for (const c of calls) {
            let result = null;
            try {
                if (c.name === 'set_block_param') {
                    result = await tool_set_block_param(c.args);
                } else if (c.name === 'set_surface_field') {
                    result = await tool_set_surface_field(c.args);
                } else if (c.name === 'set_surface_color') {
                    result = await tool_set_surface_color(c.args);
                } else if (c.name === 'apply_optical_system_rows') {
                    result = await tool_apply_optical_system_rows(c.args);
                } else {
                    result = { ok: false, error: `Unknown tool: ${c.name}` };
                }
            } catch (e) {
                result = { ok: false, error: e?.message || String(e) };
            }

            toolLogs.push(`${c.name}: ${result?.ok ? 'ok' : 'fail'}${result?.error ? ` (${result.error})` : ''}`);
            functionResponseParts.push({
                functionResponse: {
                    name: c.name,
                    response: result
                }
            });
        }

        // Immediate feedback (don’t wait for the model’s final prose).
        const headerNow = formatAppliedToolLog(toolLogs);
        if (headerNow) updateMessage(thinkingMsgId, { content: headerNow });

        workingContents = workingContents.concat([
            { role: 'user', parts: functionResponseParts }
        ]);
    }

    updateMessage(thinkingMsgId, { content: '❌ Tool loop exceeded max iterations. Please re-try with a narrower request.' });
}

/**
 * Call OpenAI API
 */
async function callOpenAIAPI(prompt, apiKey, model) {
    const url = 'https://api.openai.com/v1/chat/completions';
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: 'You are a helpful optical design assistant.' },
                { role: 'user', content: prompt }
            ]
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || 'OpenAI API failed');
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

function normalizeOpenAIModelName(model) {
    const m = String(model || '').trim();
    return m || 'gpt-4o-mini';
}

function buildOpenAITools() {
    return [
        {
            type: 'function',
            function: {
                name: 'set_block_param',
                description: 'Design Intent (blocks) の特定ブロックのパラメータ/変数を更新し、blocks→expanded optical system に再展開してUIへ反映します。',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        blockId: { type: 'string', description: '対象ブロックの blockId（不明な場合は surf を指定可）' },
                        surf: { type: 'integer', description: '0-based surface index（expanded optical system の行）。blockId が不明な場合に使用' },
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration に同じ変更を適用します（surf 指定推奨）' },
                        section: { type: 'string', enum: ['parameters', 'variables'], description: '更新先: parameters または variables' },
                        key: { type: 'string', description: '更新キー（blockTypeに依存。例: Lens=frontRadius/backRadius/centerThickness/material、asphere=frontSurfType/frontConic/frontCoef1..10、Doublet=radius1..3/material1..2、Triplet=radius1..4/material1..3、Stop=semiDiameter、AirGap=thickness）' },
                        value: { description: '新しい値（数値または文字列）' }
                    },
                    required: ['section', 'key', 'value'],
                    anyOf: [
                        { required: ['blockId'] },
                        { required: ['surf'] }
                    ]
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_surface_field',
                description: 'フォールバック: Expanded Optical System の表（active config opticalSystem）上の特定面のフィールドを更新します（blocks が無い場合など）。',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        surf: { type: 'integer', description: '0-based surface index' },
                        key: { type: 'string', description: '更新キー（例: radius, thickness, material, semidia, conic）' },
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration に同じ変更を適用します（blocks がある場合は可能な限り blocks に同期）' },
                        value: { description: '新しい値（数値または文字列）' }
                    },
                    required: ['surf', 'key', 'value']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_surface_color',
                description: 'Render Optical System の Surface Colors（面ごとの色）を更新します。localStorage の coopt.surfaceColorOverrides を更新し、3D描画を再描画します。',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        all: { type: 'boolean', description: 'true の場合、全Surface対象（色=Default/None で全解除）' },
                        surf: { type: 'integer', description: '0-based surface index（Surface Colors の # と同じ）' },
                        surfaceId: { type: 'integer', description: 'surface row の id（存在する場合）。指定すると id:NN で更新します。' },
                        blockId: { type: 'string', description: 'provenance 用 blockId（_blockId）。surfaceRole と組で指定すると p:blockId|surfaceRole を更新します。' },
                        surfaceRole: { type: 'string', description: 'provenance 用 surfaceRole（_surfaceRole）。blockId と組で指定します。' },
                        color: { type: 'string', description: '色。#RRGGBB / 0xRRGGBB / "Light Pink" 等。"Default"/"None" で解除。' }
                    },
                    required: ['color'],
                    anyOf: [
                        { required: ['all'] },
                        { required: ['surf'] },
                        { required: ['surfaceId'] },
                        { required: ['blockId', 'surfaceRole'] }
                    ]
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_optical_system_rows',
                description: 'Optical System（surface rows）を active configuration に取り込み、可能なら Design Intent（blocks）へ自動変換してUIへ反映します。特許の処方表/表をAIが行配列に整形した後に適用する用途。',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        applyToAllConfigs: { type: 'boolean', description: 'true の場合、全ての configuration の opticalSystem を同じ rows に置換します（blocksの自動変換も試みます）' },
                        rows: { type: 'array', items: { type: 'object' }, description: 'Optical system rows (Surf 0..N-1). Each row may include: object type, radius, thickness, semidia, material, surfType, conic, coef1..coef10, comment' }
                    },
                    required: ['rows']
                }
            }
        }
    ];
}

function normalizeImportedOpticalRows(rows) {
    const out = Array.isArray(rows) ? deepClone(rows) : [];
    for (let i = 0; i < out.length; i++) {
        if (!out[i] || typeof out[i] !== 'object') out[i] = {};
        out[i].id = i;
        // Normalize common aliases
        if (out[i].type !== undefined && out[i]['object type'] === undefined) {
            out[i]['object type'] = out[i].type;
        }
        if (out[i].glass !== undefined && out[i].material === undefined) {
            out[i].material = out[i].glass;
        }
        if (out[i].semiDiameter !== undefined && out[i].semidia === undefined) {
            out[i].semidia = out[i].semiDiameter;
        }
    }
    return out;
}

async function tool_apply_optical_system_rows(args) {
    const systemConfig = loadSystemConfigurations();
    const cfg = getActiveConfig(systemConfig);
    if (!systemConfig || !cfg) throw new Error('systemConfigurations / active configuration not found');

    const applyToAllConfigs = !!args?.applyToAllConfigs;
    const rowsIn = args?.rows;
    const rowsNorm = normalizeImportedOpticalRows(rowsIn);
    if (!Array.isArray(rowsNorm) || rowsNorm.length === 0) throw new Error('rows must be a non-empty array');

    const targets = applyToAllConfigs ? (systemConfig.configurations || []) : [cfg];
    const perCfg = [];

    for (const c of targets) {
        try {
            const legacyRows = normalizeImportedOpticalRows(rowsNorm);
            c.opticalSystem = legacyRows;

            // Best-effort: derive Blocks (Design Intent) from legacy rows.
            const derived = deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
            const issues = Array.isArray(derived?.issues) ? derived.issues : [];
            const hasFatal = issues.some(i => i && i.severity === 'fatal');

            if (!hasFatal && Array.isArray(derived?.blocks) && derived.blocks.length > 0) {
                c.schemaVersion = c.schemaVersion || BLOCK_SCHEMA_VERSION;
                c.blocks = derived.blocks;

                // Re-expand from blocks so provenance is consistent.
                const exp = expandBlocksToOpticalSystemRows(c.blocks);
                if (exp && Array.isArray(exp.rows)) {
                    try { preserveLegacySemidiaIntoExpandedRows(exp.rows, legacyRows); } catch (_) {}
                    try {
                        const objT = legacyRows?.[0]?.thickness;
                        const s = String(objT ?? '').trim();
                        if (s !== '' && exp.rows[0] && typeof exp.rows[0] === 'object') exp.rows[0].thickness = objT;
                    } catch (_) {}
                    c.opticalSystem = exp.rows;
                }

                if (!c.metadata || typeof c.metadata !== 'object') c.metadata = {};
                c.metadata.importAnalyzeMode = false;
            } else {
                // Keep legacy surface workflow; mark that blocks were not derived.
                if (!c.metadata || typeof c.metadata !== 'object') c.metadata = {};
                c.metadata.importAnalyzeMode = true;
            }

            perCfg.push({ ok: true, configId: c?.id, blocksDerived: !hasFatal && Array.isArray(derived?.blocks) && derived.blocks.length > 0, issues });
        } catch (e) {
            perCfg.push({ ok: false, configId: c?.id, error: e?.message || String(e) });
        }
    }

    await saveAndRefreshUI(systemConfig);
    return { ok: perCfg.some(r => r.ok), applyToAllConfigs, appliedToConfigs: perCfg };
}

// Debug-only export: allows deterministic smoke tests without calling external LLM APIs.
// Not used by the UI.
export async function __debug_apply_optical_system_rows(args) {
    return tool_apply_optical_system_rows(args);
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function loadSystemConfigurations() {
    try {
        const raw = localStorage.getItem('systemConfigurations');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function getActiveConfig(systemConfig) {
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
    const activeId = systemConfig.activeConfigId;
    return systemConfig.configurations.find(c => c && String(c.id) === String(activeId))
        || systemConfig.configurations[0]
        || null;
}
 
function pickPreservedObjectThickness(cfg, systemConfig) {
    try {
        const hasObjectPlane = Array.isArray(cfg?.blocks) && cfg.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectPlane');
        if (hasObjectPlane) return undefined;
    } catch (_) {}

    // Prefer persisted config.opticalSystem[0].thickness.
    try {
        const v = cfg?.opticalSystem?.[0]?.thickness;
        const s = String(v ?? '').trim();
        if (s !== '') return v;
    } catch (_) {}

    // If this is the active config, fall back to current UI table snapshot.
    try {
        if (systemConfig && String(systemConfig.activeConfigId) === String(cfg?.id)) {
            const raw = localStorage.getItem('OpticalSystemTableData');
            if (raw) {
                const rows = JSON.parse(raw);
                const v = rows?.[0]?.thickness;
                const s = String(v ?? '').trim();
                if (s !== '') return v;
            }
        }
    } catch (_) {}

    return undefined;
}

function pickLegacyRowsForSemidia(cfg, systemConfig) {
    try {
        if (Array.isArray(cfg?.opticalSystem) && cfg.opticalSystem.length) return cfg.opticalSystem;
    } catch (_) {}

    // If this is the active config, fall back to current UI table snapshot.
    try {
        if (systemConfig && String(systemConfig.activeConfigId) === String(cfg?.id)) {
            const raw = localStorage.getItem('OpticalSystemTableData');
            if (raw) {
                const rows = JSON.parse(raw);
                if (Array.isArray(rows) && rows.length) return rows;
            }
        }
    } catch (_) {}

    return null;
}

function preserveLegacySemidiaIntoExpandedRows(expandedRows, legacyRows) {
    if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows)) return;
    const n = Math.min(expandedRows.length, legacyRows.length);
    const hasValue = (v) => {
        if (v === null || v === undefined) return false;
        const s = String(v).trim();
        return s !== '';
    };
    const getLegacySemidia = (row) => {
        if (!row || typeof row !== 'object') return null;
        return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
    };

    for (let i = 0; i < n; i++) {
        const e = expandedRows[i];
        const l = legacyRows[i];
        if (!e || typeof e !== 'object' || !l || typeof l !== 'object') continue;
        const t = String(e['object type'] ?? e.object ?? '').trim().toLowerCase();
        if (t === 'stop' || t === 'image') continue;
        const lsRaw = getLegacySemidia(l);
        if (hasValue(lsRaw)) e.semidia = lsRaw;
    }
}

async function saveAndRefreshUI(systemConfig) {
    localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));

    const pickUIWindow = () => {
        try {
            // Prefer current window if it owns the UI.
            if (window.ConfigurationManager || window.tableOpticalSystem) return window;
        } catch (_) {}
        try {
            // In popup mode, the actual UI tables live in the opener.
            if (window.opener && !window.opener.closed) return window.opener;
        } catch (_) {}
        return window;
    };

    const uiWin = pickUIWindow();

    // If we're running in a popup, ask the opener to refresh itself as well.
    try {
        if (window.opener && !window.opener.closed) {
            const origin = (typeof window.location?.origin === 'string' && window.location.origin && window.location.origin !== 'null')
                ? window.location.origin
                : '*';
            window.opener.postMessage({ type: COOPT_AI_REFRESH_MESSAGE_TYPE }, origin);
        }
    } catch (_) {}

    await refreshUIInWindow(uiWin);
}

const buildRangeKeys = (prefix, start, end) => {
    const out = [];
    for (let i = start; i <= end; i++) out.push(`${prefix}${i}`);
    return out;
};

const LENS_KEYS = new Set([
    'frontRadius',
    'backRadius',
    'centerThickness',
    'material',
    'frontSurfType',
    'backSurfType',
    'frontConic',
    'backConic',
    ...buildRangeKeys('frontCoef', 1, 10),
    ...buildRangeKeys('backCoef', 1, 10),
]);

const DOUBLET_KEYS = new Set([
    'radius1', 'radius2', 'radius3',
    'thickness1', 'thickness2',
    'material1', 'material2',
    'surf1SurfType', 'surf2SurfType', 'surf3SurfType',
    'surf1Conic', 'surf2Conic', 'surf3Conic',
    ...buildRangeKeys('surf1Coef', 1, 10),
    ...buildRangeKeys('surf2Coef', 1, 10),
    ...buildRangeKeys('surf3Coef', 1, 10),
]);

const TRIPLET_KEYS = new Set([
    'radius1', 'radius2', 'radius3', 'radius4',
    'thickness1', 'thickness2', 'thickness3',
    'material1', 'material2', 'material3',
    'surf1SurfType', 'surf2SurfType', 'surf3SurfType', 'surf4SurfType',
    'surf1Conic', 'surf2Conic', 'surf3Conic', 'surf4Conic',
    ...buildRangeKeys('surf1Coef', 1, 10),
    ...buildRangeKeys('surf2Coef', 1, 10),
    ...buildRangeKeys('surf3Coef', 1, 10),
    ...buildRangeKeys('surf4Coef', 1, 10),
]);

const AIRGAP_KEYS = new Set(['thickness']);
const STOP_KEYS = new Set(['semiDiameter']);

function getAllowedKeysForBlockType(blockType) {
    const t = String(blockType || '').trim();
    if (t === 'Lens' || t === 'PositiveLens') return LENS_KEYS;
    if (t === 'Doublet') return DOUBLET_KEYS;
    if (t === 'Triplet') return TRIPLET_KEYS;
    if (t === 'AirGap') return AIRGAP_KEYS;
    if (t === 'Stop') return STOP_KEYS;
    // ImagePlane has no editable params.
    return null;
}

const ALLOWED_SURFACE_KEYS = new Set(['radius', 'radiusRaw', 'thickness', 'material', 'glass', 'semidia', 'conic', 'type']);

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const SURFACE_COLOR_PALETTE_BY_NAME = new Map([
    ['light pink', '#F8BBD0'],
    ['light red', '#FFCDD2'],
    ['light orange', '#FFE0B2'],
    ['light amber', '#FFECB3'],
    ['light yellow', '#FFF9C4'],
    ['light lime', '#F0F4C3'],
    ['light green', '#C8E6C9'],
    ['light mint', '#B2DFDB'],
    ['light cyan', '#B3E5FC'],
    ['light sky', '#BBDEFB'],
    ['light blue', '#90CAF9'],
    ['light indigo', '#C5CAE9'],
    ['light purple', '#E1BEE7'],
    ['light lavender', '#D1C4E9'],
    ['light peach', '#FFCCBC'],
    ['light gray', '#ECEFF1']
]);

function loadSurfaceColorOverrides() {
    try {
        const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function saveSurfaceColorOverrides(map) {
    try {
        localStorage.setItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY, JSON.stringify(map || {}));
    } catch (_) {}
}

function normalizeSurfaceColorInput(color) {
    const s0 = String(color ?? '').trim();
    if (!s0) return null;
    const lower = s0.toLowerCase();
    if (lower === 'default' || lower === 'none' || lower === 'clear' || lower === 'reset' || lower === 'auto') return null;

    if (/^#[0-9a-fA-F]{6}$/.test(s0)) return s0.toUpperCase();
    if (/^0x[0-9a-fA-F]{6}$/.test(s0)) return ('#' + s0.slice(2)).toUpperCase();

    const named = SURFACE_COLOR_PALETTE_BY_NAME.get(lower);
    if (named) return named;

    const squashed = lower.replace(/\s+/g, ' ').trim();
    const named2 = SURFACE_COLOR_PALETTE_BY_NAME.get(squashed);
    if (named2) return named2;

    throw new Error(`Unsupported color: ${s0}`);
}

function surfaceColorKeyFromRowOrArgs({ row, surf, surfaceId, blockId, surfaceRole }) {
    try {
        const bid = String(row?._blockId ?? blockId ?? '').trim();
        const role = String(row?._surfaceRole ?? surfaceRole ?? '').trim();
        if (bid && role) return 'p:' + bid + '|' + role;
    } catch (_) {}

    try {
        const sid = Number(row?.id ?? surfaceId);
        if (Number.isFinite(sid)) return 'id:' + String(Math.floor(sid));
    } catch (_) {}

    const idx = Number.isInteger(Number(surf)) ? Number(surf) : 0;
    return 'i:' + String(Math.floor(idx));
}

function request3DRedrawBestEffort() {
    const tryPost = (win) => {
        try {
            if (!win || win.closed) return false;
            win.postMessage({ action: 'request-redraw' }, '*');
            return true;
        } catch (_) {
            return false;
        }
    };

    if (tryPost(window.popup3DWindow)) return;

    try {
        if (window.opener && !window.opener.closed) {
            if (tryPost(window.opener.popup3DWindow)) return;
        }
    } catch (_) {}
}

async function tool_set_surface_color(args) {
    const systemConfig = loadSystemConfigurations();
    const cfg = getActiveConfig(systemConfig);
    if (!systemConfig || !cfg) throw new Error('systemConfigurations / active configuration not found');

    const colorHex = normalizeSurfaceColorInput(args?.color);

    const isAll = Boolean(args?.all);
    if (isAll) {
        if (colorHex !== null) {
            throw new Error('all=true is currently only supported with color=Default/None (reset)');
        }
        localStorage.removeItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
        request3DRedrawBestEffort();
        return { ok: true, applied: { key: '(all)', color: 'Default' } };
    }

    const hasSurf = Number.isInteger(Number(args?.surf)) && Number(args?.surf) >= 0;
    const hasSurfaceId = Number.isFinite(Number(args?.surfaceId));
    const hasProv = String(args?.blockId ?? '').trim() && String(args?.surfaceRole ?? '').trim();
    if (!hasSurf && !hasSurfaceId && !hasProv) {
        throw new Error('surf or surfaceId or (blockId+surfaceRole) is required');
    }

    const surf = hasSurf ? Number(args.surf) : null;

    let row = null;
    try {
        if (hasSurf) {
            if (Array.isArray(cfg?.blocks) && cfg.blocks.length > 0) {
                const exp = expandBlocksToOpticalSystemRows(cfg.blocks);
                row = exp?.rows?.[surf] ?? null;
            } else if (Array.isArray(cfg?.opticalSystem)) {
                row = cfg.opticalSystem?.[surf] ?? null;
            }
        } else if (hasSurfaceId) {
            const sid = Math.floor(Number(args.surfaceId));
            const rows = (Array.isArray(cfg?.blocks) && cfg.blocks.length > 0)
                ? (expandBlocksToOpticalSystemRows(cfg.blocks)?.rows || [])
                : (Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : []);
            row = Array.isArray(rows) ? (rows.find(r => Number(r?.id) === sid) || null) : null;
        }
    } catch (_) {
        row = null;
    }

    const key = surfaceColorKeyFromRowOrArgs({
        row,
        surf: hasSurf ? surf : 0,
        surfaceId: hasSurfaceId ? Number(args.surfaceId) : null,
        blockId: args?.blockId,
        surfaceRole: args?.surfaceRole
    });

    const map = loadSurfaceColorOverrides();
    if (colorHex === null) {
        delete map[key];
    } else {
        map[key] = colorHex;
    }
    saveSurfaceColorOverrides(map);

    request3DRedrawBestEffort();

    return { ok: true, applied: { key, color: colorHex ?? 'Default' } };
}

async function tool_set_block_param(args) {
    const systemConfig = loadSystemConfigurations();
    const cfg = getActiveConfig(systemConfig);
    if (!systemConfig || !cfg) throw new Error('systemConfigurations / active configuration not found');

    if (!Array.isArray(cfg.blocks) || cfg.blocks.length === 0) {
        throw new Error('Active configuration has no blocks (Design Intent).');
    }

    const applyToAllConfigs = !!args?.applyToAllConfigs;
    const surf = args?.surf;
    let blockId = String(args?.blockId || '').trim();
    const section = String(args?.section || '').trim();
    let key = String(args?.key || '').trim();
    let value = args?.value;

    const resolveBlockIdForConfig = (oneCfg) => {
        const direct = blockId ? String(blockId) : '';
        if (direct) {
            const exists = Array.isArray(oneCfg?.blocks) && oneCfg.blocks.some(b => b && String(b.blockId) === direct);
            if (exists) return direct;
        }
        const si = Number(surf);
        if (!Number.isInteger(si) || si < 0) return null;
        const exp = expandBlocksToOpticalSystemRows(oneCfg.blocks);
        const row = exp?.rows?.[si];
        const resolved = row?._blockId;
        return resolved ? String(resolved) : null;
    };

    const applyToOneConfig = (oneCfg) => {
        if (!Array.isArray(oneCfg?.blocks) || oneCfg.blocks.length === 0) {
            return { ok: false, configId: oneCfg?.id, error: 'no blocks' };
        }

        const resolvedBlockId = resolveBlockIdForConfig(oneCfg);
        if (!resolvedBlockId) {
            return { ok: false, configId: oneCfg?.id, error: 'blockId or surf (0-based) required / could not resolve blockId' };
        }

        const blocks = deepClone(oneCfg.blocks);
        const b = blocks.find(x => x && String(x.blockId) === resolvedBlockId);
        if (!b) return { ok: false, configId: oneCfg?.id, error: `blockId not found: ${resolvedBlockId}` };

        const blockType = String(b.blockType || '').trim();
        if (blockType === 'ImagePlane') {
            return { ok: false, configId: oneCfg?.id, error: 'ImagePlane is not editable' };
        }

        // Some block types have a single authoritative storage location.
        let sectionEffective = section;
        let k = key;
        let v = value;

        // Key aliasing (user/model may say glass instead of material).
        if (k === 'glass') k = 'material';
        if (k === 'glass1') k = 'material1';
        if (k === 'glass2') k = 'material2';
        if (k === 'glass3') k = 'material3';
        if (blockType === 'Stop' && k === 'semiDiameter') sectionEffective = 'parameters';

        const allowed = getAllowedKeysForBlockType(blockType);
        if (!allowed || !allowed.has(k)) {
            return { ok: false, configId: oneCfg?.id, error: `Unsupported key for blockType=${blockType}: ${k}` };
        }

        const numeric = (vv) => {
            if (typeof vv === 'number') return Number.isFinite(vv) ? vv : NaN;
            if (typeof vv === 'string') {
                const s = vv.trim();
                if (s === '') return NaN;
                if (/^inf(inity)?$/i.test(s)) return Infinity;
                const n = Number(s);
                return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
        };

        if (k.toLowerCase().includes('thickness')) {
            const n = numeric(v);
            if (Number.isFinite(n) && n < 0) return { ok: false, configId: oneCfg?.id, error: `Negative thickness is not allowed: ${n}` };
            if (blockType === 'AirGap' && Number.isFinite(n) && n < 0) return { ok: false, configId: oneCfg?.id, error: `Negative AirGap thickness is not allowed: ${n}` };
        }
        if (k === 'semiDiameter') {
            const n = numeric(v);
            if (!Number.isFinite(n) || n <= 0) return { ok: false, configId: oneCfg?.id, error: `Stop.semiDiameter must be positive: ${String(v)}` };
            v = n;
        }

        const updateParameters = () => {
            if (!isPlainObject(b.parameters)) b.parameters = {};
            b.parameters[k] = v;
        };
        const updateVariables = () => {
            if (!isPlainObject(b.variables)) b.variables = {};
            const existing = b.variables[k];
            if (isPlainObject(existing)) existing.value = v;
            else b.variables[k] = { value: v };
        };

        // IMPORTANT:
        // Expansion prefers parameters over variables (getParamOrVarValue).
        // If a key already exists in parameters, writing only to variables would appear to "apply"
        // but have no visible effect. Therefore, update the authoritative location:
        // - If key exists in parameters: update parameters.
        // - If key exists in variables: update variables.
        // - If key exists in both: update both (avoid drift).
        // - If key exists in neither: honor requested section.
        const hasParamKey = isPlainObject(b.parameters) && Object.prototype.hasOwnProperty.call(b.parameters, k);
        const hasVarKey = isPlainObject(b.variables) && Object.prototype.hasOwnProperty.call(b.variables, k);
        if (hasParamKey) updateParameters();
        if (hasVarKey) updateVariables();
        if (!hasParamKey && !hasVarKey) {
            if (sectionEffective === 'parameters') updateParameters();
            else updateVariables();
        }

        // Keep legacy stop variables in sync (best-effort), even though expand uses parameters.
        if (blockType === 'Stop' && k === 'semiDiameter') {
            if (!isPlainObject(b.variables)) b.variables = {};
            const existing = b.variables[k];
            if (isPlainObject(existing)) existing.value = v;
            else b.variables[k] = { value: v };
        }

        oneCfg.blocks = blocks;

        // Update expanded optical system (derived)
        const preservedThickness = pickPreservedObjectThickness(oneCfg, systemConfig);
        const legacyRows = Array.isArray(oneCfg?.opticalSystem) ? oneCfg.opticalSystem : null;
        const exp2 = expandBlocksToOpticalSystemRows(oneCfg.blocks);
        if (exp2 && Array.isArray(exp2.rows)) {
            if (legacyRows && legacyRows.length > 0) {
                preserveLegacySemidiaIntoExpandedRows(exp2.rows, legacyRows);
            }
            if (preservedThickness !== undefined && exp2.rows[0] && typeof exp2.rows[0] === 'object') {
                exp2.rows[0].thickness = preservedThickness;
            }
            oneCfg.opticalSystem = exp2.rows;
        }

        const appliedSection = (hasParamKey || (!hasParamKey && !hasVarKey && sectionEffective === 'parameters')) ? 'parameters' : 'variables';
        return { ok: true, configId: oneCfg?.id, applied: { blockId: resolvedBlockId, section: appliedSection, key: k, value: v } };
    };

    // Validate required fields
    if (!(section === 'parameters' || section === 'variables')) throw new Error('section must be parameters|variables');
    if (!key) throw new Error('key is required');

    if (applyToAllConfigs) {
        const results = [];
        for (const c of systemConfig.configurations || []) {
            results.push(applyToOneConfig(c));
        }
        await saveAndRefreshUI(systemConfig);
        return { ok: results.some(r => r.ok), applyToAllConfigs: true, appliedToConfigs: results };
    }

    // Single-config default: active config
    const singleResult = applyToOneConfig(cfg);
    if (!singleResult.ok) throw new Error(singleResult.error || 'failed');
    await saveAndRefreshUI(systemConfig);
    return { ok: true, applyToAllConfigs: false, applied: singleResult.applied };
    if (!(section === 'parameters' || section === 'variables')) throw new Error('section must be parameters|variables');
    if (!key) throw new Error('key is required');

    const blocks = deepClone(cfg.blocks);
    const b = blocks.find(x => x && String(x.blockId) === blockId);
    if (!b) throw new Error(`blockId not found: ${blockId}`);

    const blockType = String(b.blockType || '').trim();
    if (blockType === 'ImagePlane') {
        throw new Error('ImagePlane is not editable (marker block).');
    }

    // Some block types have a single authoritative storage location.
    // Stop.semiDiameter is defined as parameters.semiDiameter in block-schema.
    let sectionEffective = section;

    // Key aliasing (user/model may say glass instead of material).
    if (key === 'glass') key = 'material';
    if (key === 'glass1') key = 'material1';
    if (key === 'glass2') key = 'material2';
    if (key === 'glass3') key = 'material3';

    if (blockType === 'Stop' && key === 'semiDiameter') {
        sectionEffective = 'parameters';
    }

    const allowed = getAllowedKeysForBlockType(blockType);
    if (!allowed || !allowed.has(key)) {
        throw new Error(`Unsupported key for blockType=${blockType}: ${key}`);
    }

    // Basic safety validation for common physical constraints.
    const numeric = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
        if (typeof v === 'string') {
            const s = v.trim();
            if (s === '') return NaN;
            if (/^inf(inity)?$/i.test(s)) return Infinity;
            const n = Number(s);
            return Number.isFinite(n) ? n : NaN;
        }
        return NaN;
    };

    if (key.toLowerCase().includes('thickness')) {
        const n = numeric(value);
        // Allow INF for Lens centerThickness in some legacy cases, but disallow negative.
        if (Number.isFinite(n) && n < 0) {
            throw new Error(`Negative thickness is not allowed: ${n}`);
        }
        if (blockType === 'AirGap' && Number.isFinite(n) && n < 0) {
            throw new Error(`Negative AirGap thickness is not allowed: ${n}`);
        }
    }

    if (key === 'semiDiameter') {
        const n = numeric(value);
        if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`Stop.semiDiameter must be a positive number: ${String(value)}`);
        }
        // Keep numeric for stop.
        value = n;
    }

    if (sectionEffective === 'parameters') {
        if (!isPlainObject(b.parameters)) b.parameters = {};
        b.parameters[key] = value;
    } else {
        if (!isPlainObject(b.variables)) b.variables = {};
        const existing = b.variables[key];
        if (isPlainObject(existing)) {
            existing.value = value;
        } else {
            b.variables[key] = { value };
        }
    }

    // Keep legacy stop variables in sync (best-effort), even though expand uses parameters.
    if (blockType === 'Stop' && key === 'semiDiameter') {
        if (!isPlainObject(b.variables)) b.variables = {};
        const existing = b.variables[key];
        if (isPlainObject(existing)) existing.value = value;
        else b.variables[key] = { value };
    }

    // Apply blocks
    cfg.blocks = blocks;

    // Update expanded optical system (derived)
    const preservedThickness = pickPreservedObjectThickness(cfg, systemConfig);
    const legacyRowsForSemidia = pickLegacyRowsForSemidia(cfg, systemConfig);
    try {
        const exp = expandBlocksToOpticalSystemRows(cfg.blocks);
        if (exp && Array.isArray(exp.rows)) {
            if (legacyRowsForSemidia && legacyRowsForSemidia.length > 0) {
                preserveLegacySemidiaIntoExpandedRows(exp.rows, legacyRowsForSemidia);
            }
            if (preservedThickness !== undefined && exp.rows[0] && typeof exp.rows[0] === 'object') {
                exp.rows[0].thickness = preservedThickness;
            }
            cfg.opticalSystem = exp.rows;
        }
    } catch (e) {
        throw new Error(`Block expansion failed: ${e?.message || e}`);
    }

    await saveAndRefreshUI(systemConfig);

    return { ok: true, applied: { blockId, section, key, value } };
}

async function tool_set_surface_field(args) {
    const systemConfig = loadSystemConfigurations();
    const cfg = getActiveConfig(systemConfig);
    if (!systemConfig || !cfg) throw new Error('systemConfigurations / active configuration not found');

    const surf = Number(args?.surf);
    let key = String(args?.key || '').trim();
    const value = args?.value;
    const applyToAllConfigs = !!args?.applyToAllConfigs;

    if (!Number.isInteger(surf) || surf < 0) throw new Error('surf must be a 0-based non-negative integer');
    if (!key) throw new Error('key is required');

    // Alias: context exposes radiusRaw for non-numeric radii (e.g., "INF").
    // The editable field in opticalSystem rows is still "radius".
    if (key === 'radiusRaw') key = 'radius';
    if (!ALLOWED_SURFACE_KEYS.has(key)) throw new Error(`Unsupported surface key: ${key}`);

    // If blocks exist, try to keep Design Intent (blocks) as source of truth.
    // Prefer translating Stop semidia edits into Stop.parameters.semiDiameter via set_block_param.
    if (key === 'semidia') {
        try {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            if (!Number.isFinite(n) || n <= 0) throw new Error(`semidia must be positive number: ${String(value)}`);
            const r = await tool_set_block_param({ surf, applyToAllConfigs, section: 'parameters', key: 'semiDiameter', value: n });
            return { ok: true, applyToAllConfigs, applied: { surf, key, value, translatedTo: 'set_block_param' }, result: r };
        } catch (_) {
            // Fall back to direct surface edit below.
        }
    }

    const targets = applyToAllConfigs ? (systemConfig.configurations || []) : [cfg];
    const perCfg = [];
    for (const c of targets) {
        try {
            const rows = Array.isArray(c.opticalSystem) ? deepClone(c.opticalSystem) : [];
            if (!rows[surf]) throw new Error(`surface out of range: ${surf}`);
            rows[surf][key] = value;
            c.opticalSystem = rows;
            perCfg.push({ ok: true, configId: c?.id });
        } catch (e) {
            perCfg.push({ ok: false, configId: c?.id, error: e?.message || String(e) });
        }
    }

    await saveAndRefreshUI(systemConfig);
    return { ok: perCfg.some(r => r.ok), applyToAllConfigs, applied: { surf, key, value }, appliedToConfigs: perCfg };
}

async function applyActionPlan(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return { ok: false, reason: 'no actions' };

    const logs = [];
    let appliedCount = 0;

    for (const a of actions) {
        const type = String(a?.type || '').trim();
        if (type === 'set_block_param') {
            const r = await tool_set_block_param(a);
            appliedCount++;
            logs.push(`set_block_param ${r.applied.blockId} ${r.applied.section}.${r.applied.key}=${JSON.stringify(r.applied.value)}`);
        } else if (type === 'set_surface_field') {
            const r = await tool_set_surface_field(a);
            appliedCount++;
            logs.push(`set_surface_field surf=${r.applied.surf} ${r.applied.key}=${JSON.stringify(r.applied.value)}`);
        } else if (type === 'set_surface_color') {
            const r = await tool_set_surface_color(a);
            appliedCount++;
            logs.push(`set_surface_color ${r.applied.key}=${JSON.stringify(r.applied.color)}`);
        } else {
            logs.push(`skip unknown action type: ${type || '(missing)'}`);
        }
    }

    return { ok: true, appliedCount, logs };
}

function tryParseActionPlanFromText(text) {
    if (!text) return null;
    const s = String(text);

    // 1) Preferred: fenced code block with marker header
    const markerIdx = s.indexOf(ACTION_PLAN_MARKER);
    if (markerIdx >= 0) {
        const after = s.slice(markerIdx + ACTION_PLAN_MARKER.length);
        const m = after.match(/```json\s*([\s\S]*?)```/i) || after.match(/```\s*([\s\S]*?)```/);
        if (m && m[1]) {
            try {
                const obj = JSON.parse(m[1]);
                if (obj && Array.isArray(obj.actions)) return obj;
            } catch (_) {}
        }
    }

    // 2) Any JSON block that has actions
    const blocks = [...s.matchAll(/```json\s*([\s\S]*?)```/gi)];
    for (const b of blocks) {
        try {
            const obj = JSON.parse(b[1]);
            if (obj && Array.isArray(obj.actions)) return obj;
        } catch (_) {}
    }

    return null;
}

async function callOpenAINonStream({ apiKey, model, payload }) {
    const url = 'https://api.openai.com/v1/chat/completions';
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: normalizeOpenAIModelName(model),
            ...payload,
            stream: false
        })
    }, DEFAULT_AI_REQUEST_TIMEOUT_MS);
    if (!resp.ok) {
        let msg = 'OpenAI API failed';
        try {
            const err = await resp.json();
            msg = err?.error?.message || msg;
        } catch (_) {
            try { msg = await resp.text(); } catch (_) {}
        }
        throw new Error(msg);
    }
    return await resp.json();
}

async function callOpenAIStreamText({ apiKey, model, messages, onDelta }) {
    const url = 'https://api.openai.com/v1/chat/completions';
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: normalizeOpenAIModelName(model),
            messages,
            stream: true
        })
    }, DEFAULT_AI_STREAM_TIMEOUT_MS);
    if (!resp.ok) {
        let msg = 'OpenAI stream failed';
        try {
            const err = await resp.json();
            msg = err?.error?.message || msg;
        } catch (_) {
            try { msg = await resp.text(); } catch (_) {}
        }
        throw new Error(msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice('data:'.length).trim();
            if (data === '[DONE]') return;
            try {
                const j = JSON.parse(data);
                const delta = j?.choices?.[0]?.delta?.content;
                if (delta) onDelta(String(delta));
            } catch (_) {
                // ignore
            }
        }
    }
}

async function runOpenAIConversationWithTools({ messages, apiKey, model, thinkingMsgId, forceToolCall }) {
    const tools = buildOpenAITools();

    let iter = 0;
    let workingMessages = [...messages];
    const toolLogs = [];

    while (iter++ < TOOL_MAX_ITERS) {
        const shouldForceThisTurn = !!forceToolCall && toolLogs.length === 0;
        const toolChoice = shouldForceThisTurn
            ? { type: 'function', function: { name: 'set_block_param' } }
            : 'auto';

        const data = await callOpenAINonStream({
            apiKey,
            model,
            payload: {
                messages: workingMessages,
                tools,
                tool_choice: toolChoice
            }
        });

        const msg = data?.choices?.[0]?.message;
        const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const content = msg?.content || '';

        if (toolCalls.length === 0) {
            // No tool calls: stream the final answer (and attach optional action plan).
            let streamedText = '';
            const header = formatAppliedToolLog(toolLogs);
            updateMessage(thinkingMsgId, { content: header || '' });
            await callOpenAIStreamText({
                apiKey,
                model,
                messages: workingMessages.concat([{ role: 'assistant', content }]),
                onDelta: (d) => {
                    streamedText += d;
                    updateMessage(thinkingMsgId, { content: (header || '') + streamedText });
                }
            });

            const parsed = tryParseActionPlanFromText(streamedText);
            if (parsed?.actions) {
                updateMessage(thinkingMsgId, { actions: parsed.actions });
            }
            return;
        }

        // Tool call stage (non-stream)
        workingMessages = workingMessages.concat([{ role: 'assistant', content, tool_calls: toolCalls }]);

        for (const tc of toolCalls) {
            const name = tc?.function?.name;
            const argsJson = tc?.function?.arguments;
            let args = {};
            try {
                args = argsJson ? JSON.parse(argsJson) : {};
            } catch {
                args = {};
            }

            let result = null;
            try {
                if (name === 'set_block_param') {
                    result = await tool_set_block_param(args);
                } else if (name === 'set_surface_field') {
                    result = await tool_set_surface_field(args);
                } else if (name === 'set_surface_color') {
                    result = await tool_set_surface_color(args);
                } else if (name === 'apply_optical_system_rows') {
                    result = await tool_apply_optical_system_rows(args);
                } else {
                    result = { ok: false, error: `Unknown tool: ${name}` };
                }
            } catch (e) {
                result = { ok: false, error: e?.message || String(e) };
            }

            toolLogs.push(`${name}: ${result?.ok ? 'ok' : 'fail'}${result?.error ? ` (${result.error})` : ''}`);

            // Immediate feedback (don’t wait for the model’s final prose).
            const headerNow = formatAppliedToolLog(toolLogs);
            if (headerNow) updateMessage(thinkingMsgId, { content: headerNow });

            workingMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify(result)
            });
        }
    }

    updateMessage(thinkingMsgId, { content: '❌ Tool loop exceeded max iterations. Please re-try with a narrower request.' });
}
