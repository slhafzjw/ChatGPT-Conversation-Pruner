# ChatGPT-Conversation-Pruner

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)

A Tampermonkey userscript designed to **mitigate frontend performance issues in long ChatGPT conversations**.

This script dynamically prunes older conversation turns **after the conversation DOM reaches a stable state**, reducing the number of DOM nodes kept live on the page.  
As a result, scrolling, typing, and rendering performance are significantly improved in long-running conversations.

The script only runs on ChatGPT conversation pages.  
It does **not** intercept network requests and does **not** collect any user data.

> Inspired by [ChatGPT Long Conversation Lag Optimization](https://greasyfork.org/zh-CN/scripts/559208-chatgpt-%E9%95%BF%E5%AF%B9%E8%AF%9D%E5%8D%A1%E9%A1%BF%E4%BC%98%E5%8C%96).  
> Building on the DOM-unmounting approach, this script further introduces **pruned DOM caching, on-demand restoration, and scroll-state–aware DOM management**, making it suitable for longer conversations and more complex frontend state transitions.

> This script is developed with the assistance of ChatGPT.

---

## Quick Start

### Download Appimage

Go to [Released Version](https://github.com/slhafzjw/ChatGPT-Conversation-Pruner/releases/tag/Integrated) and download.

### Using Tampermonkey

1. Install the **Tampermonkey** browser extension
2. Visit [ChatGPT Conversation Pruner](https://greasyfork.org/scripts/565110) and install the script

### Manual Installation

1. Open the Tampermonkey dashboard and choose **Create a new script**
2. Paste the full contents of  
   [`chatgpt-conversation-pruner.user.js`](chatgpt-conversation-pruner.user.js)
3. Save the script and refresh the ChatGPT page

---

## Configuration

The script exposes a small set of configurable parameters to balance performance and historical visibility.

| Parameter | Default | Description | Notes |
|---------|---------|-------------|-------|
| `HIDE_BEYOND` | `8` | Maximum number of **live conversation turns** kept in the DOM. Older turns are pruned and cached. | Recommended: `6 ~ 12`. Lower values improve performance |
| `BATCH_SIZE` | `8` | Number of conversation turns restored per batch when scrolling upward. | Larger values may cause brief layout shifts |
| `MAX_CACHE_PER_CONV` | `300` | Maximum number of cached (pruned) turns per conversation. | Usually no need to change |
| `DEBUG` | `false` | Enables verbose debug logs in the browser console. | Set to `true` for troubleshooting |

> All other constants are considered internal implementation details and are **not recommended** for modification.

---

## Features

- **Conversation DOM stable-state detection**
  - Avoids pruning during streaming responses or React batch updates
  - Only activates pruning after the DOM is confirmed stable

- **Dynamic pruning of older conversation turns**
  - Keeps only the most recent N turns live
  - Older turns are removed from the DOM and cached

- **Scroll-up history restoration**
  - Scrolling upward restores cached turns in batches
  - Uses a sentinel element with `IntersectionObserver` to prevent large DOM spikes

- **Live / cached turn indicator**
  - Displays `live` and `cached` turn counts in the page header
  - Updates automatically during pruning, restoration, 和 DOM rebuilds
  - Provides a clear visual indicator of DOM size and script activity

- **Automatic pruning resume on scroll-to-bottom**
  - When returning to the bottom of the conversation:
    - History mode is exited
    - Live mode resumes
    - Pruning is re-enabled automatically
  - Prevents unbounded DOM growth after browsing history

- **Voice-mode safe handling**
  - In voice-related modes, turns are hidden instead of removed
  - Avoids interfering with voice interaction workflows

- **Same-route DOM rebuild protection**
  - Detects full DOM subtree replacement on the same route
  - Rebinds observers and performs safe pruning to prevent cache duplication

- **Generation-phase pruning triggers**
  - Automatically evaluates pruning after a new turn finishes rendering
  - Prevents gradual DOM accumulation during long sessions

- **SPA route awareness**
  - Supports ChatGPT’s single-page application navigation
  - Cleans up and reinitializes per conversation route

---

## How It Works

### 1. Core Idea

In long ChatGPT conversations, the frontend accumulates a large number of `article`-level DOM nodes.  
As the conversation grows, scrolling, input handling, and layout computation become increasingly expensive.

The core goal of this script is:

> **Reduce the number of simultaneously mounted conversation turns without affecting reading or interaction.**

### 2. Stable-State Detection

To avoid interfering with:

- Streaming responses
- Ongoing React reconciliation

The script periodically checks:

- Whether the number of conversation turns has changed
- Whether the height of the last turn remains stable

Only after multiple consecutive stable checks does pruning become active.

### 3. Pruning and Caching

- When the number of live turns exceeds the configured threshold:
  - Older turns are removed from the DOM
  - Their DOM nodes are cached in memory (per conversation)
- A cache size limit is enforced to prevent unbounded memory growth

Cached turns can be restored when needed.

### 4. History Restoration and Scroll Control

- A hidden sentinel element is placed at the top of the conversation
- An `IntersectionObserver` monitors when the sentinel enters the viewport
- As the user scrolls upward, cached turns are restored incrementally

Scroll position is compensated to avoid sudden jumps.

### 5. Scroll Containers and State Machine

ChatGPT does not always use `window` as the scroll container.  
The script dynamically detects the active scroll root.

Based on scroll position, the script transitions between:

- **Live mode**: at the bottom, pruning enabled
- **History mode**: browsing older content, pruning paused
- **Voice mode**: turns are hidden but not removed

### 6. DOM Rebuild Protection

In some cases, ChatGPT replaces the entire conversation DOM subtree on the same route.

A lightweight watchdog detects:

- Conversation container replacement
- Sentinel loss

When detected, observers are reattached and a safe pruning pass is executed to prevent cache duplication or state corruption.

### 7. Limitations

- This script relies on ChatGPT’s current frontend DOM structure
- UI changes may require future adaptations
- The script operates on a best-effort basis and does not guarantee long-term compatibility
