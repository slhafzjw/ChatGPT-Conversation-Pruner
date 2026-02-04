// ==UserScript==
// @name         ChatGPT Conversation Pruner
// @namespace    chatgpt-conversation-pruner
// @version      2.3.3
// @description  缓解 ChatGPT 长对话场景下的前端性能问题
// @match        https://chatgpt.com/*
// @homepageURL  https://github.com/slhafzjw/ChatGPT-Conversation-Pruner
// @supportURL   https://github.com/slhafzjw/ChatGPT-Conversation-Pruner/issues
// @grant        none
// @run-at       document-start
// @noframes
// @author       slhaf
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /**********************************************************
   * Debug & 对照实验开关（保留 v1.6 思路）
   **********************************************************/
    const DEBUG = true;

    // true = 临时禁用“首屏剪枝相关优化”（用于对照）
    // - 不隐藏 main
    // - 稳定态后不做首次 prune（但后续滚动回到底部仍可能触发 prune）
    const DISABLE_FIRST_SCREEN_PRUNE = false;

    const LOG = {
        log: (...a) => DEBUG && console.log('[Pruner]', ...a),
        warn: (...a) => DEBUG && console.warn('[Pruner]', ...a),
    };

    LOG.log('script loaded at', document.readyState, 'path=', location.pathname);

    /**********************************************************
   * 参数
   **********************************************************/
    const HIDE_BEYOND = 8;
    const BATCH_SIZE = 8;

    const LOAD_ROOT_MARGIN = '200px 0px 0px 0px';
    const BOTTOM_THRESHOLD = 10;

    const MAX_CACHE_PER_CONV = 300;

    // 稳定态判定：需要连续 N 次“turn 数量不变 + 最末 turn 高度不变”
    const STABLE_HITS_REQUIRED = 2;
    const STABLE_CHECK_INTERVAL = 200;

    // scrollRoot 仍可能在稳定后短时间内替换：做有限次重绑
    const REBIND_CHECK_MS = 450;
    const REBIND_TRIES = 2;

    // 同路由 DOM 重建看门狗（轻量）
    const DOM_WATCHDOG_INTERVAL = 600;

    /**********************************************************
   * 全局：仅保留 convKey -> removed DOM[] 的缓存
   **********************************************************/
    const GLOBAL_CACHE_KEY = '__CHATGPT_PRUNER_CACHE_MAP__';
    const GLOBAL_INSTANCE_KEY = '__CHATGPT_PRUNER_INSTANCE__';

    if (!window[GLOBAL_CACHE_KEY]) window[GLOBAL_CACHE_KEY] = new Map();
    const CACHE_MAP = window[GLOBAL_CACHE_KEY];

    /**********************************************************
   * Header badge
   **********************************************************/
    const HEADER_BADGE_KEY = '__CHATGPT_PRUNER_HEADER_BADGE__';

    function getModelSwitcherButton() {
        return document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    }

    function getPageHeader() {
        return document.getElementById('page-header');
    }

    function ensureHeaderBadge() {
        const header = getPageHeader();
        const anchor = getModelSwitcherButton();
        if (!header || !anchor) return null;

        let badge = window[HEADER_BADGE_KEY];
        if (!badge || !badge.isConnected) {
            badge = document.createElement('span');
            badge.style.cssText = `
    position: absolute;
    font-size: 12px;
    line-height: 1;
    color: var(--token-text-tertiary);
    opacity: 0.9;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
    z-index: 30;
  `;
            badge.textContent = '• live: - | cached: -';
            header.appendChild(badge);
            window[HEADER_BADGE_KEY] = badge;
        }

        const a = anchor.getBoundingClientRect();
        const h = header.getBoundingClientRect();

        badge.style.left = `${a.right - h.left + 8}px`;
        badge.style.top = `${a.top - h.top + a.height / 2}px`;
        badge.style.transform = 'translateY(-50%)';

        return badge;
    }

    function removeHeaderBadge() {
        const el = window[HEADER_BADGE_KEY];
        if (el?.remove) el.remove();
        window[HEADER_BADGE_KEY] = null;
    }

    function updateHeaderBadge({ live, cached }) {
        const badge = ensureHeaderBadge();
        if (!badge) return;
        badge.textContent = `• live: ${live} | cached: ${cached}`;
        ensureHeaderBadge();
    }

    window.addEventListener('resize', () => {
        if (window[HEADER_BADGE_KEY]) {
            ensureHeaderBadge();
        }
    }, { passive: true });

    /**********************************************************
   * Helpers（无状态）
   **********************************************************/
    function isConversationPage() {
        return location.pathname.startsWith('/c/');
    }

    function getConvKey() {
        return location.pathname;
    }

    function getTurns() {
        return Array.from(
            document.querySelectorAll('article[data-testid^=conversation-turn]')
        );
    }

    function getConversationContainer() {
        const first = getTurns()[0];
        return first?.parentElement || document.querySelector('main') || document.body;
    }

    function isScrollable(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
        return el.scrollHeight > el.clientHeight + 1;
    }

    function pickScrollableFallback() {
        // 从 thread 往上找最可能的滚动容器
        const start =
              document.querySelector('[data-scroll-root]') ||
              document.getElementById('thread') ||
              document.getElementById('main') ||
              document.body;

        let cur = start;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            if (isScrollable(cur)) return cur;
            cur = cur.parentElement;
        }

        // 最后兜底：浏览器默认滚动元素
        return document.scrollingElement || document.documentElement;
    }

    function getScrollRoot() {
        // ✅ 新版是 data-scroll-root=""（没有 true）
        const explicit = document.querySelector('[data-scroll-root]');
        if (explicit && isScrollable(explicit)) return explicit;

        // explicit 可能存在但一开始还没撑开高度：也允许返回 explicit
        if (explicit) return explicit;

        return pickScrollableFallback();
    }


    function isAtBottom(threshold = BOTTOM_THRESHOLD) {
        const root = getScrollRoot();
        if (!root) {
            const se = document.scrollingElement || document.documentElement;
            return se.scrollHeight - se.scrollTop - window.innerHeight < threshold;
        }
        return root.scrollHeight - root.scrollTop - root.clientHeight < threshold;
    }

    function isVoiceActive() {
        return !!document.querySelector('[data-testid*=voice], [aria-label*=voice]');
    }

    function getCacheForKey(key) {
        if (!CACHE_MAP.has(key)) CACHE_MAP.set(key, []);
        return CACHE_MAP.get(key);
    }

    /**********************************************************
   * 等待“对话 DOM 稳定态”
   **********************************************************/
    function waitForConversationStable(convKey, onReady, onProgress) {
        let lastCount = 0;
        let stableHits = 0;
        let lastHeight = 0;

        const t = setInterval(() => {
            if (getConvKey() !== convKey) {
                clearInterval(t);
                return;
            }

            const turns = getTurns();
            const root = getScrollRoot();
            const last = turns[turns.length - 1];

            if (!root || !last) {
                stableHits = 0;
                lastCount = turns.length;
                return;
            }

            const h = last.getBoundingClientRect().height;

            if (turns.length === lastCount && Math.abs(h - lastHeight) < 1) {
                stableHits++;
            } else {
                stableHits = 0;
            }

            lastCount = turns.length;
            lastHeight = h;

            onProgress && onProgress({ stableHits, turns: turns.length });

            if (stableHits >= STABLE_HITS_REQUIRED) {
                clearInterval(t);
                onReady();
            }
        }, STABLE_CHECK_INTERVAL);

        return () => clearInterval(t);
    }

    /**********************************************************
   * per-route instance
   **********************************************************/
    function createConversationInstance(convKey) {
        const cache = getCacheForKey(convKey);

        let ACTIVE = true;
        let HISTORY_MODE = false;
        let PAUSE_PRUNE = false;
        let IS_LOADING = false;

        let SENTINEL = null;
        let IO = null;

        let SCROLL_ROOT = null;
        let SCROLL_HANDLER = null;

        let EARLY_HIT = false;
        let START_AT = performance.now();

        let rebindLeft = REBIND_TRIES;
        let rebindTimer = null;
        let stableCancel = null;

        const hideStyle = document.createElement('style');
        hideStyle.textContent = `main { visibility: hidden !important; }`;

        // 生成期剪枝触发器
        let lastTurnCount = getTurns().length;
        let lastSeenTurnId = null;

        // ✅ 新增：记录当前被 observe 的 container，供 DOM 重建检测
        let OBSERVED_CONTAINER = null;

        // ✅ 新增：看门狗 timer
        let watchdogTimer = null;

        function refreshHeaderBadge() {
            updateHeaderBadge({
                live: getTurns().length,
                cached: cache.length,
            });
        }

        function destroy() {
            ACTIVE = false;

            try { growObserver.disconnect(); } catch {}

            if (watchdogTimer) {
                clearInterval(watchdogTimer);
                watchdogTimer = null;
            }

            try { stableCancel?.(); } catch {}
            stableCancel = null;

            try { IO?.disconnect(); } catch {}
            IO = null;

            try { SENTINEL?.remove(); } catch {}
            SENTINEL = null;

            if (SCROLL_HANDLER) {
                try { window.removeEventListener('scroll', SCROLL_HANDLER); } catch {}
                try { SCROLL_ROOT?.removeEventListener('scroll', SCROLL_HANDLER); } catch {}
            }
            SCROLL_HANDLER = null;
            SCROLL_ROOT = null;

            if (rebindTimer) {
                clearTimeout(rebindTimer);
                rebindTimer = null;
            }

            try { hideStyle.remove(); } catch {}

            removeHeaderBadge();
        }

        function sanitizeCache() {
            if (!cache.length) return;
            for (let i = cache.length - 1; i >= 0; i--) {
                const el = cache[i];
                if (el?.isConnected) cache.splice(i, 1);
            }
            if (cache.length > MAX_CACHE_PER_CONV) {
                cache.splice(0, cache.length - MAX_CACHE_PER_CONV);
            }
        }

        function clearHiddenTurns() {
            const turns = getTurns();
            for (const el of turns) {
                if (el?.style?.display === 'none') el.style.display = '';
            }
        }

        function ensureSentinel() {
            if (SENTINEL && SENTINEL.isConnected) return SENTINEL;

            const s = document.createElement('div');
            s.style.cssText = 'height:1px;width:1px;opacity:0;pointer-events:none';

            const first = getTurns()[0];
            if (first?.parentElement) {
                first.parentElement.insertBefore(s, first);
            } else {
                getConversationContainer().prepend(s);
            }

            SENTINEL = s;
            return s;
        }

        // ✅ 新增：DOM 重建安全剪枝（避免 cached 翻倍）
        function safePrune(reason) {
            if (!ACTIVE) return;
            if (DISABLE_FIRST_SCREEN_PRUNE) {
                // 对照开关开启时，仍需保证输入能触发 prune？
                // 这里不强行剪枝，只刷新 badge；你如果希望实验模式也剪枝，把这行删掉即可。
                refreshHeaderBadge();
                return;
            }
            if (isVoiceActive()) {
                // 语音态不做 remove
                refreshHeaderBadge();
                return;
            }

            const liveNow = getTurns().length;

            // 关键：同路由重建后，cache 里全是“旧树节点引用”，会导致重复累计
            // 触发条件：live 明显大 + cache 非空
            if (cache.length > 0 && liveNow > HIDE_BEYOND) {
                // 估算旧树占比：旧树节点通常 !isConnected
                let stale = 0;
                const sample = Math.min(cache.length, 32);
                for (let i = 0; i < sample; i++) {
                    const el = cache[cache.length - 1 - i];
                    if (el && !el.isConnected) stale++;
                }
                // 如果样本中大部分是 stale，直接清空（避免翻倍/错位）
                if (sample > 0 && stale / sample >= 0.6) {
                    DEBUG && LOG.warn('safePrune: drop stale cache before prune', {
                        key: convKey,
                        reason,
                        live: liveNow,
                        cached: cache.length,
                        stale,
                        sample
                    });
                    cache.length = 0;
                }
            }

            // 正常 sanitize + prune
            sanitizeCache();
            clearHiddenTurns();
            prune();
        }

        function prune() {
            if (!ACTIVE || PAUSE_PRUNE || HISTORY_MODE) return;

            const turns = getTurns();
            if (turns.length <= HIDE_BEYOND) {
                refreshHeaderBadge();
                return;
            }

            const removeBefore = turns.length - HIDE_BEYOND;
            const voiceActive = isVoiceActive();

            if (DEBUG && removeBefore > 0) {
                LOG.log(
                    'prune',
                    voiceActive ? 'hide' : 'remove',
                    removeBefore,
                    'turns (readyState=',
                    document.readyState + ')',
                    'key=',
                    convKey
                );
            }

            if (voiceActive) {
                for (let i = 0; i < removeBefore; i++) {
                    const el = turns[i];
                    if (!el) continue;
                    el.style.display = 'none';
                }
                refreshHeaderBadge();
                return;
            }

            clearHiddenTurns();
            sanitizeCache();

            for (let i = 0; i < removeBefore; i++) {
                const el = turns[i];
                if (!el) continue;
                cache.push(el);
                el.remove();
            }

            sanitizeCache();
            refreshHeaderBadge();
        }

        function loadMoreHistory() {
            if (!ACTIVE) return;
            if (isVoiceActive()) return;

            HISTORY_MODE = true;
            PAUSE_PRUNE = true;
            IS_LOADING = true;

            sanitizeCache();

            const sentinel = ensureSentinel();
            const beforeTop = sentinel.getBoundingClientRect().top;

            let restored = 0;
            while (restored < BATCH_SIZE && cache.length) {
                const el = cache.pop();
                sentinel.insertAdjacentElement('afterend', el);
                el.style.display = '';
                restored++;
            }

            requestAnimationFrame(() => {
                const afterTop = sentinel.getBoundingClientRect().top;
                const delta = afterTop - beforeTop;
                if (Math.abs(delta) > 1) window.scrollBy(0, delta);

                IS_LOADING = false;
                DEBUG && LOG.log('restored', restored, 'cache left', cache.length, 'key=', convKey);

                refreshHeaderBadge();
            });
        }

        function setupIntersectionObserver() {
            if (IO) IO.disconnect();

            const root = getScrollRoot();

            IO = new IntersectionObserver(entries => {
                const e = entries[0];
                if (!e?.isIntersecting) return;
                if (!ACTIVE || IS_LOADING) return;
                if (!cache.length) return;
                loadMoreHistory();
            }, {
                root,
                rootMargin: LOAD_ROOT_MARGIN,
                threshold: 0.01,
            });

            IO.observe(ensureSentinel());

            if (rebindLeft > 0) {
                const boundRoot = root;
                if (rebindTimer) clearTimeout(rebindTimer);
                rebindTimer = setTimeout(() => {
                    rebindTimer = null;
                    if (!ACTIVE) return;

                    const newRoot = getScrollRoot();
                    if (newRoot !== boundRoot) {
                        DEBUG && LOG.warn('scroll root changed, rebind IO', { key: convKey });
                        rebindLeft--;
                        setupIntersectionObserver();
                        watchScrollMode();
                    } else {
                        rebindLeft--;
                    }
                }, REBIND_CHECK_MS);
            }
        }

        function watchScrollMode() {
            const root = getScrollRoot();
            if (root === SCROLL_ROOT && SCROLL_HANDLER) return;

            if (SCROLL_HANDLER) {
                window.removeEventListener('scroll', SCROLL_HANDLER);
                SCROLL_ROOT?.removeEventListener('scroll', SCROLL_HANDLER);
            }

            SCROLL_ROOT = root;
            SCROLL_HANDLER = () => {
                if (!ACTIVE) return;
                if (isVoiceActive()) return;

                if (HISTORY_MODE && isAtBottom()) {
                    HISTORY_MODE = false;
                    PAUSE_PRUNE = false;
                    DEBUG && LOG.log('back to bottom → resume prune', 'key=', convKey);
                    prune();
                }
            };

            (SCROLL_ROOT || window).addEventListener('scroll', SCROLL_HANDLER, { passive: true });
        }

        const growObserver = new MutationObserver(() => {
            if (!ACTIVE || PAUSE_PRUNE || HISTORY_MODE || IS_LOADING) return;

            const turns = getTurns();
            const last = turns[turns.length - 1];

            // 条件 A：article 数量真的增加了（你原本就有）
            const countGrown = turns.length > lastTurnCount;

            // 条件 B：最后一个 article 被“定型”（turn-id 变化）
            const lastId = last?.getAttribute('data-turn-id');
            const idFinalized = lastId && lastId !== lastSeenTurnId;

            // 两个条件都不满足 → 不触发
            if (!countGrown && !idFinalized) return;

            // 更新状态
            lastTurnCount = turns.length;
            lastSeenTurnId = lastId;

            prune()
        });


        const earlyObserver = new MutationObserver(() => {
            if (!ACTIVE) return;
            if (!EARLY_HIT) {
                EARLY_HIT = true;
                DEBUG && LOG.log(
                    'first DOM mutation at',
                    Math.round(performance.now() - START_AT),
                    'ms',
                    'key=',
                    convKey
                );
            }
        });

        // ✅ 新增：同路由 DOM 重建看门狗（会触发 safePrune）
        function startDomWatchdog() {
            if (watchdogTimer) clearInterval(watchdogTimer);

            watchdogTimer = setInterval(() => {
                if (!ACTIVE) return;
                if (getConvKey() !== convKey) return;

                // 1) header 被 React 刷掉：确保徽章存在 + 位置刷新
                if (getPageHeader() && getModelSwitcherButton()) {
                    ensureHeaderBadge();
                }

                // 2) container 被替换：重绑 growObserver + 立刻 safePrune
                const nowContainer = getConversationContainer();
                if (nowContainer && nowContainer !== OBSERVED_CONTAINER) {
                    try { growObserver.disconnect(); } catch {}
                    try {
                        growObserver.observe(nowContainer, { childList: true, subtree: true });
                        OBSERVED_CONTAINER = nowContainer;
                        lastTurnCount = getTurns().length;
                        DEBUG && LOG.warn('container replaced → rebind growObserver', { key: convKey });
                    } catch {}

                    // DOM 树刚替换：立即安全剪一次，避免 live 暴涨但不 prune
                    safePrune('container-replaced');
                }

                // 3) sentinel 丢失：重建 sentinel 并重挂 IO，然后安全剪一次
                if (SENTINEL && !SENTINEL.isConnected) {
                    SENTINEL = null;
                    try { IO?.disconnect(); } catch {}
                    IO = null;
                    try { setupIntersectionObserver(); } catch {}
                    try { watchScrollMode(); } catch {}
                    DEBUG && LOG.warn('sentinel lost → rebuild IO', { key: convKey });

                    safePrune('sentinel-lost');
                }

                // 4) 定期刷新 badge（显示真实 live/cached）
                refreshHeaderBadge();
            }, DOM_WATCHDOG_INTERVAL);
        }

        function start() {
            if (!DISABLE_FIRST_SCREEN_PRUNE) {
                document.documentElement.appendChild(hideStyle);
                DEBUG && LOG.log('main hidden (waiting stable)', 'key=', convKey);
            }

            earlyObserver.observe(document.documentElement, { childList: true, subtree: true });

            stableCancel = waitForConversationStable(
                convKey,
                () => {
                    if (!ACTIVE) return;

                    const tStable = Math.round(performance.now() - START_AT);
                    DEBUG && LOG.log('conversation stable at', tStable, 'ms', 'key=', convKey);

                    if (!DISABLE_FIRST_SCREEN_PRUNE) {
                        hideStyle.remove();
                        const tRestore = Math.round(performance.now() - START_AT);
                        DEBUG && LOG.log('main restored at', tRestore, 'ms', 'key=', convKey);

                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                DEBUG && LOG.log(
                                    'first visible frame at',
                                    Math.round(performance.now() - START_AT),
                                    'ms',
                                    'key=',
                                    convKey
                                );
                            });
                        });
                    }

                    sanitizeCache();
                    clearHiddenTurns();

                    if (!DISABLE_FIRST_SCREEN_PRUNE) {
                        prune();
                    } else {
                        DEBUG && LOG.warn('first screen prune disabled (experiment)', 'key=', convKey);
                    }

                    setupIntersectionObserver();
                    watchScrollMode();

                    try { earlyObserver.disconnect(); } catch {}

                    // 启用生成期剪枝监听（绑定当前 container）
                    const c = getConversationContainer();
                    OBSERVED_CONTAINER = c;
                    try {
                        growObserver.observe(c, { childList: true, subtree: true });
                    } catch {}

                    refreshHeaderBadge();

                    // ✅ 启动 DOM 重建看门狗
                    startDomWatchdog();
                },
                () => {}
            );
        }

        start();
        return { destroy };
    }

    /**********************************************************
   * SPA routing：切换时销毁旧实例，创建新实例
   **********************************************************/
    function applyRoute() {
        const old = window[GLOBAL_INSTANCE_KEY];
        if (old?.destroy) {
            try { old.destroy(); } catch {}
            window[GLOBAL_INSTANCE_KEY] = null;
        }

        if (!isConversationPage()) {
            removeHeaderBadge();
            return;
        }

        const key = getConvKey();
        DEBUG && LOG.log('route change →', key);

        window[GLOBAL_INSTANCE_KEY] = createConversationInstance(key);
    }

    function hookHistory(cb) {
        const _push = history.pushState;
        const _replace = history.replaceState;

        history.pushState = function () {
            _push.apply(this, arguments);
            cb();
        };

        history.replaceState = function () {
            _replace.apply(this, arguments);
            cb();
        };

        window.addEventListener('popstate', cb);
    }

    hookHistory(applyRoute);
    applyRoute();
})();
