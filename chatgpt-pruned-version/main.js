const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const INJECT_MARK = '__CHATGPT_PRUNER_INJECTED__';
const STYLE_MARK = '__CHATGPT_HIDE_SCROLLBAR__';
const PRUNER_URL = 'https://raw.githubusercontent.com/slhafzjw/ChatGPT-Conversation-Pruner/5f872465214d261c220648876941539b620eb27d/chatgpt-conversation-pruner.user.js'
const CACHE_PATH = path.join(
    app.getPath('userData'),
    'pruner.user.js'
);

function updateUserScriptFromRemote() {
    return new Promise((resolve) => {
        https.get(PRUNER_URL, {
            headers: {
                'User-Agent': 'Electron',
                'Cache-Control': 'no-cache',
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                console.warn('[pruner] fetch failed:', res.statusCode);
                res.resume();
                return resolve();
            }

            let data = '';
            res.setEncoding('utf8');

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    fs.writeFileSync(CACHE_PATH, data, 'utf8');
                    console.log('[pruner] script updated from github');
                } catch (e) {
                    console.error('[pruner] write cache failed:', e);
                }
                resolve();
            });
        }).on('error', (err) => {
            console.warn('[pruner] fetch failed, using cached version:', err.message);
            resolve();
        });
    });
}

async function injectScrollbarStyle(win) {
    try {
        await win.webContents.executeJavaScript(`
            (function () {
                if (window.${STYLE_MARK}) return;
                window.${STYLE_MARK} = true;

                const style = document.createElement('style');
                style.textContent = \`
                    ::-webkit-scrollbar {
                      width: 0px;
                      height: 0px;
                    }
                    * {
                      scrollbar-width: none;
                    }
                \`;
                document.documentElement.appendChild(style);
            })();
        `, true);
    } catch (e) {
        console.error('[inject] scrollbar css failed:', e);
    }
}

function readUserScript() {
    if (!fs.existsSync(CACHE_PATH)) {
        throw new Error('pruner.user.js cache not found');
    }

    let src = fs.readFileSync(CACHE_PATH, 'utf8');
    src = src.replace(
        /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m,
        ''
    );
    return src;
}

function shouldInject(url) {
    try {
        const u = new URL(url);

        // 1️⃣ 域名限制
        if (u.origin !== 'https://chatgpt.com') return false;

        // 2️⃣ 路径限制（只在会话页）
        if (!u.pathname.includes('/c/')) return false;

        return true;
    } catch {
        return false;
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 900,
        frame: false,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadURL('https://chatgpt.com/');

    const injectIfNeeded = async () => {
        const url = win.webContents.getURL();
        if (!shouldInject(url)) return;

        try {
            await injectScrollbarStyle(win);

            const src = readUserScript();

            await win.webContents.executeJavaScript(`
        (function () {
          if (window.${INJECT_MARK}) return;
          window.${INJECT_MARK} = true;
          ${src}
        })();
      `, true);

            console.log('[inject] pruner injected at', url);
        } catch (e) {
            console.error('[inject] failed:', e);
        }
    };

    // 首次页面完成
    win.webContents.于('did-finish-load'， injectIfNeeded);

    // SPA 内路由变化
    win.webContents.于('did-navigate-in-page', injectIfNeeded);

    // 兜底：少数真正跳转
    win.webContents.于('did-navigate', injectIfNeeded);

    win.webContents.setWindowOpenHandler(({ url }) => {
        // 只允许 chatgpt.com 在 App 内
        if (url.startsWith('https://chatgpt.com')) {
            return { action: 'allow' };
        }

        // 其他全部交给系统浏览器
        shell.openExternal(url);
        return { action: 'deny' };
    });

    return win;
}

app.whenReady().then(() => {
    createWindow();
    updateUserScriptFromRemote();
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

