/**
 * dsh-paste-chip —— 客户端半：把超长粘贴折叠成一张可展开的引用胶囊。
 *
 * 为什么是插件而不是改 core
 * ---------------------------------------------------------------------------
 * 长文本卡死的根因是「每敲一个键就全文重算 + 全文写盘」。core 里的折叠实现要改
 * 编辑器 runtime；插件则走三条已有的公开通道，不动宿主一行代码：
 *   1. InputTriggerSource.codec.serialize(ref)  —— 发送时由本插件把正文展开
 *   2. actx.bail(actx, 'slash/input-insert-reference', { reference, span })
 *      —— 和内置 slash 插件插 chip 用的是同一个作用域事件
 *   3. InputActions.captureInsertion()          —— 拿到带 draftRev 的稳定锚点
 *
 * 正文不进 ref id（core 版把 base64 塞进 ref，CJK 要放大 4 倍），而是按短 id
 * 存在本插件自己的存储里：草稿里只有一个短字符串，每次按键的持久化体积回到
 * 标签大小。代价是正文与草稿分开存，所以发送时找不到正文会「明确失败」而不会
 * 静默把标签当成正文发出去。
 */

window.__ModuleLoader__.load({
  id: "dsh-paste-chip",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** 引用来源名；chip 的 source 与 roster 里注册的 name 必须一致。 */
    const SOURCE = "paste-chip";
    /** 到这里就折叠（字符数或行数任一达标）。400 字 ≈ 一屏满，再长就该折叠。 */
    /** 超过就拒绝：正文虽不进草稿，但还要进模型上下文，太长没有意义。 */
    /** 正文存储：短 id → 正文；按条数和总字节双限额，超了淘汰最旧的。 */
    const STORE_PREFIX = "dsh-paste-chip.v1.";
    const INDEX_KEY = "dsh-paste-chip.v1.index";

    /** 全部可调项与默认值；宿主接口读不到时就用它。 */
    const DEFAULT_SETTINGS = Object.freeze({
      collapseChars: 400,
      collapseLines: 12,
      maxChars: 200000,
      externalMinChars: 8,
      warmupMs: 1200,
      inputGraceMs: 500,
      previewChars: 320,
      contextChars: 40,
      hoverDelayMs: 180,
      leaveGraceMs: 60,
      storeMaxEntries: 12,
      storeMaxBytes: 2 * 1024 * 1024,
    });

    /** 每项取值范围，越界夹到边界（宿主也夹一次，双保险）。 */
    const SETTINGS_RANGES = {
      collapseChars: [100, 10000], collapseLines: [3, 200], maxChars: [1000, 2000000],
      externalMinChars: [1, 200], warmupMs: [0, 10000], inputGraceMs: [0, 3000],
      previewChars: [80, 2000], contextChars: [0, 200], hoverDelayMs: [0, 1000],
      leaveGraceMs: [0, 1000], storeMaxEntries: [1, 100], storeMaxBytes: [65536, 8388608],
    };

    /** 当前生效配置；apply() 里从宿主读到后替换。 */
    let settings = { ...DEFAULT_SETTINGS };

    /** 合并并夹取宿主配置。 */
    function normalizeSettings(raw) {
      const next = { ...DEFAULT_SETTINGS };
      if (raw === null || typeof raw !== "object") return next;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const value = raw[key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const range = SETTINGS_RANGES[key];
        next[key] = Math.max(range[0], Math.min(range[1], Math.round(value)));
      }
      return next;
    }

    /** 从宿主读配置（设置页与 cordis.patch.yml 都汇总在那里）；失败保持默认值。 */
    async function loadSettings() {
      try {
        if (typeof fetch !== "function") return;
        const response = await fetch(SETTINGS_PATH, { headers: { accept: "application/json" } });
        if (!response || response.ok === false) return;
        const body = await response.json();
        settings = normalizeSettings(body && body.config ? body.config : body);
        log("info", "settings.loaded", settings);
      } catch (error) {
        log("warn", "settings.load.failed", String(error && error.message ? error.message : error));
      }
    }
    /**
     * 用户输入的宽限期：用户输入事件之后这段时间内的草稿变化算「用户自己打的」。
     */
    /**
     * 外部插入的最小长度兜底。这不是产品阈值（外部渠道仍不看字数），
     * 而是「谁改的草稿」判断失手时的安全网：手打/输入法提交一次就是 1~3 个字，
     * 真实外部渠道塞进来的是整段注释/引用段落。日志里 7 次误折叠全是 1 个字。
     */
    /**
     * 挂载后的预热窗口。会话切换/页面加载会「恢复」草稿，那段文本对观察器来说
     * 长得和外部插件插入一模一样；预热窗口内的变化只当基线，不接管。
     */
    /** 悬停意图：停留这么久才显示，避免掠过时连闪（日志里 2.2s 触发过 7 次）。 */
    /** 离开宽限：在图标与文字之间移动时不闪。 */
    /** 悬停预览显示的正文前缀长度（字符）。 */
    /** Lexical 给可编辑根打的标记。 */
    const EDITOR_SELECTOR = '[data-lexical-editor="true"]';
    const HOST_ATTR = "data-dsh-paste-chip";

    /** 客户端半版本；与 package.json、宿主半保持一致。 */
    const VERSION = "0.1.20";
    /** 配置接口（宿主半提供）。 */
    const SETTINGS_PATH = "/api/dsh-paste-chip/config";
    /** 日志上报落点（宿主半写盘）。 */
    const LOG_PATH = "/api/dsh-paste-chip/log";
    /** 内存缓冲上限：宿主不在时有界，不涨内存。 */
    const LOG_BUFFER_LIMIT = 300;
    /** 批量上报间隔。 */
    const LOG_FLUSH_MS = 400;

    /**
     * 日志：一份进控制台（你直接看得到），一份进内存探针（devtools 查得到），
     * 一份批量 POST 给宿主落盘（我能 tail 到）。三条路径都包在 try 里，
     * 日志本身出问题绝不能影响粘贴。
     */
    const logBuffer = [];
    let flushTimer = null;
    let flushing = false;

    function log(level, ev, data) {
      try {
        const record = { level, ev, ...(data === undefined ? {} : { data }) };
        logBuffer.push(record);
        if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.shift();
        const probe = typeof window === "undefined" ? undefined : window.__dshPasteChip;
        if (probe !== undefined) {
          probe.lastEvent = record;
          probe.events = logBuffer.length;
        }
        if (typeof console !== "undefined") {
          const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
          if (typeof sink === "function") sink(`[dsh-paste-chip] ${ev}`, data === undefined ? "" : data);
        }
        scheduleFlush();
      } catch (_error) {
        /* 日志失败不影响主流程 */
      }
    }

    function scheduleFlush() {
      if (flushTimer !== null || typeof setTimeout !== "function") return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, LOG_FLUSH_MS);
    }

    /** 把缓冲批量发给宿主；失败就放回缓冲区，下一轮再试。 */
    function flush() {
      if (flushing || logBuffer.length === 0) return;
      if (typeof fetch !== "function") return;
      flushing = true;
      const batch = logBuffer.splice(0, logBuffer.length);
      try {
        fetch(LOG_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
        }).then(
          (response) => {
            flushing = false;
            if (!response || response.ok === false) throw new Error(`http ${response === undefined ? "?" : response.status}`);
          },
          (error) => {
            flushing = false;
            // 宿主还没起来/路由没挂：事件放回去，等下一轮。
            logBuffer.unshift(...batch);
            while (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.pop();
            throw error;
          },
        ).catch(() => {
          flushing = false;
        });
      } catch (_error) {
        flushing = false;
        logBuffer.unshift(...batch);
      }
    }

    /* ------------------------------------------------------------------ *
     * 文案：跟着宿主语言走，中英各一份
     * ------------------------------------------------------------------ */
    const COPY = {
      zh: {
        label: n => `粘贴文本 · ${compactCount(n)} 字`,
        chip: (snippet, n) => (snippet === "" ? `粘贴文本 · ${compactCount(n)} 字` : `粘贴「${snippet}」· ${compactCount(n)} 字`),
        contextBefore: "上文",
        contextAfter: "下文",
        tooLong: n => `粘贴内容 ${compactCount(n)} 字，超过输入框上限（${compactCount(settings.maxChars)} 字）；请改为作为文件附加上传`,
        failed: "胶囊插入失败，已按纯文本粘贴",
        copied: "已复制全文",
        copyFailed: "复制失败",
        copyAll: "复制全文",
        trayTitle: "查看粘贴内容",
        trayPrefix: "粘贴",
        lost: "这段粘贴的正文已失效（可能清理过缓存），请重新粘贴",
        nested: "这段粘贴只存下了标签（旧版本的缺陷），正文找不到了，请重新粘贴",
      },
      en: {
        label: n => `Pasted text · ${compactCount(n)} chars`,
        chip: (snippet, n) => (snippet === "" ? `Pasted text · ${compactCount(n)} chars` : `Pasted「${snippet}」· ${compactCount(n)} chars`),
        contextBefore: "before",
        contextAfter: "after",
        tooLong: n => `Pasted ${compactCount(n)} chars, over the composer limit (${compactCount(settings.maxChars)}); attach it as a file instead`,
        failed: "Could not insert the chip; pasted as plain text",
        copied: "Copied",
        copyFailed: "Copy failed",
        copyAll: "Copy full text",
        trayTitle: "View pasted text",
        trayPrefix: "Pasted",
        lost: "This paste's body is gone (storage pruned); paste it again",
        nested: "Only the label was stored for this paste (older bug); paste it again",
      },
    };

    /** 宿主 locale 服务的读取器；apply() 时注入，拿不到就退回浏览器语言。 */
    let localeReader = null;

    function copy() {
      // 注意：不能用 document.documentElement.lang —— DSH 的 index.html 固定写 lang="en"，
      // 中文界面下也读成 en。宿主的 locale 服务才是权威（LocaleSnapshot.active）。
      let lang = "";
      try {
        lang = localeReader === null ? "" : String(localeReader() || "");
      } catch (_error) {
        lang = "";
      }
      if (lang === "") {
        lang = typeof navigator === "undefined" ? "" : String(navigator.language || "");
      }
      return lang.toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
    }

    /** 标签里的正文前缀长度：够分辨「是哪一段」，又不至于把胶囊撑爆。 */
    const LABEL_SNIPPET_CHARS = 12;

    /**
     * 从正文里取一小段做标签前缀：压掉换行与连续空白，超长截断。
     * 「粘贴文本 · 12.1k 字」这种零信息标签会让两个同字数的胶囊完全无法区分。
     * @param {string} body - 完整正文
     * @returns {string} 前缀（可能为空）
     */
    function labelSnippet(body) {
      const flat = String(body).replace(/\s+/gu, " ").trim();
      if (flat === "") return "";
      return flat.length > LABEL_SNIPPET_CHARS ? `${flat.slice(0, LABEL_SNIPPET_CHARS)}…` : flat;
    }

    /** 我们自己生成过的标签（有界）。观察器靠它识别「这是胶囊自己的文本」。 */
    const selfLabels = new Set();

    /** 胶囊标签：正文前缀 + 字数。 */
    function chipLabel(body) {
      const label = copy().chip(labelSnippet(body), body.length);
      if (selfLabels.size >= 200) selfLabels.clear();
      selfLabels.add(label);
      return label;
    }

    /**
     * 比较前后两次草稿文本，找出「这一次新插入了什么」。
     * 标注浏览器、划词询问这类渠道是用 setDraft/insertText 写进来的，
     * 不经过 paste 事件，只能靠对比草稿的前后差异识别。
     * @param {string} prev - 变动前的草稿
     * @param {string} next - 变动后的草稿
     * @returns {{start: number, end: number, text: string, removed: number}|null}
     *   插入区间（next 坐标系）与插入内容；删除/替换会带着 removed>0 返回，由调用方决定要不要管
     */
    function detectInsertion(prev, next) {
      if (typeof prev !== "string" || typeof next !== "string") return null;
      if (next.length <= prev.length) return null;
      const limit = Math.min(prev.length, next.length);
      let start = 0;
      while (start < limit && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
      let endPrev = prev.length;
      let endNext = next.length;
      while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
        endPrev -= 1;
        endNext -= 1;
      }
      return { start, end: endNext, text: next.slice(start, endNext), removed: endPrev - start };
    }

    /**
     * 把 clipboard 投影的偏移换算成 detect 投影的偏移。
     * 胶囊在 clipboard 里展开成 label（length 个字符），在 detect 里只占 1 个字符，
     * 所以「草稿里已有胶囊」时不能直接拿 draft 的下标当 TokenSpan。
     * @param {number} offset - clipboard 投影里的偏移
     * @param {readonly object[]} occurrences - 按文档顺序排列的胶囊
     * @returns {number} detect 投影里的偏移
     */
    function clipboardToDetect(offset, occurrences) {
      let shift = 0;
      for (const occurrence of occurrences) {
        if (occurrence === null || typeof occurrence !== "object") continue;
        const start = occurrence.offset;
        const end = start + occurrence.length;
        if (end <= offset) {
          shift += occurrence.length - 1;
          continue;
        }
        if (start < offset) {
          // 落在胶囊内部：吸到胶囊之后（胶囊不可拆分）
          return start - shift + 1;
        }
        break;
      }
      return offset - shift;
    }

    /**
     * 悬停预览的模型：头部一行 + 正文前若干字符。
     * @param {string} body - 粘贴的完整正文
     * @param {string} header - 头部文案
     * @returns {{header: string, preview: string, total: number, truncated: boolean}}
     */
    function tooltipModel(body, header, context) {
      const total = body.length;
      const truncated = total > settings.previewChars;
      const preview = truncated ? `${body.slice(0, settings.previewChars)}…` : body;
      return { header, preview, total, truncated, fullBody: body, context: context === undefined ? null : context };
    }

    /** 悬停预览里「上文 … 胶囊 … 下文」的取字符数。 */

    /**
     * 取胶囊前后的上下文片段：告诉用户「这段粘贴落在哪句话里」。
     * 草稿的 draft 与 occurrences 的 offset/length 同属 clipboard 投影，直接切即可。
     * @param {object} input - InputState
     * @param {number} index - 第几个同名胶囊
     * @returns {{before: string, after: string}|null}
     */
    function contextOf(input, index) {
      if (input === undefined || input === null || typeof input.draft !== "string") return null;
      const list = (input.occurrences || []).filter(entry => entry !== null && typeof entry === "object" && entry.source === SOURCE);
      const found = list[index];
      if (found === undefined) return null;
      const draft = input.draft;
      const before = draft.slice(Math.max(0, found.offset - settings.contextChars), found.offset).trim();
      const after = draft.slice(found.offset + found.length, found.offset + found.length + settings.contextChars).trim();
      if (before === "" && after === "") return null;
      return { before, after };
    }

    /**
     * 把「第 N 个胶囊」映射回它的引用 id。
     * 胶囊的 DOM 元素与 occurrences 都按文档顺序排列，靠下标对齐最稳。
     * @param {readonly object[]} occurrences - InputState.occurrences
     * @param {number} index - 同名胶囊在 DOM 里的序号
     * @returns {string|undefined} 引用 id
     */
    function refAtIndex(occurrences, index) {
      const list = (occurrences || []).filter(entry => entry !== null && typeof entry === "object" && entry.source === SOURCE);
      const found = list[index];
      return found === undefined ? undefined : found.ref;
    }

    /** `980` → `980`，`1200` → `1.2k`，`200000` → `200k`。 */
    function compactCount(chars) {
      if (chars < 1000) return String(chars);
      const thousands = chars / 1000;
      if (thousands < 10) return `${thousands.toFixed(1).replace(/\.0$/u, "")}k`;
      return `${Math.round(thousands)}k`;
    }

    /** 行数统计到阈值就停，别为了一行超长文本把整段扫两遍。 */
    function shouldCollapse(text) {
      if (text.length >= settings.collapseChars) return true;
      let lines = 1;
      for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) !== 10) continue;
        lines += 1;
        if (lines >= settings.collapseLines) return true;
      }
      return false;
    }

    /* ------------------------------------------------------------------ *
     * 正文存储
     * ------------------------------------------------------------------ */
    function storage() {
      try {
        return typeof localStorage === "undefined" ? null : localStorage;
      } catch (_error) {
        return null;
      }
    }

    function readIndex() {
      const store = storage();
      if (store === null) return [];
      try {
        const raw = store.getItem(INDEX_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
          ? parsed.filter(entry => entry && typeof entry.id === "string" && typeof entry.size === "number")
          : [];
      } catch (_error) {
        return [];
      }
    }

    function writeIndex(entries) {
      const store = storage();
      if (store === null) return;
      try {
        store.setItem(INDEX_KEY, JSON.stringify(entries));
      } catch (_error) {
        /* 索引写不进去只影响淘汰，不影响本次正文读取。 */
      }
    }

    /** 淘汰：丢掉最旧的条目（以及它们的正文），直到条数与总字节都回到限额内。 */
    function prune(entries, keepId) {
      const store = storage();
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      while (entries.length > settings.storeMaxEntries || total > settings.storeMaxBytes) {
        const victim = entries.shift();
        if (victim === undefined) break;
        total -= victim.size;
        if (store !== null) {
          try {
            store.removeItem(STORE_PREFIX + victim.id);
          } catch (_error) {
            /* 删不掉就留着，最多是多占一点配额。 */
          }
        }
      }
      return entries.filter(entry => entry.id !== undefined && entry.id !== keepId);
    }

    /** 写入一段正文，返回它的短 id。存储不可用时退化成内存 Map，仍能正常工作。 */
    const memoryBodies = new Map();

    function writeBody(text) {
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      memoryBodies.set(id, text);
      const store = storage();
      if (store === null) return id;
      let entries = readIndex();
      try {
        store.setItem(STORE_PREFIX + id, text);
      } catch (_error) {
        // 配额满了：淘汰旧条目后重试一次，还失败就只留在内存里。
        log("warn", "storage.full", { chars: text.length, reason: String(_error && _error.name ? _error.name : _error) });
        entries = prune(entries, id);
        writeIndex(entries);
        try {
          store.setItem(STORE_PREFIX + id, text);
        } catch (_again) {
          return id;
        }
      }
      entries.push({ id, size: text.length });
      const kept = prune(entries, id);
      kept.push({ id, size: text.length });
      writeIndex(kept);
      return id;
    }

    /** 用指定 id 覆写正文（替换已有胶囊的内容时用，保持 ref 不变）。 */
    function writeBodyUnder(id, text) {
      memoryBodies.set(id, text);
      const store = storage();
      if (store === null) return;
      try {
        store.setItem(STORE_PREFIX + id, text);
      } catch (_error) {
        log("warn", "storage.full", { chars: text.length, reason: "replace" });
      }
    }

    /** 按 id 取正文；内存优先（本次会话写入的），其次持久化。 */
    function readBody(id) {
      const cached = memoryBodies.get(id);
      if (cached !== undefined) return cached;
      const store = storage();
      if (store === null) return null;
      try {
        return store.getItem(STORE_PREFIX + id);
      } catch (_error) {
        return null;
      }
    }

    /** 插入失败时清掉刚写的正文，别在存储里留孤儿。 */
    function dropBody(id) {
      memoryBodies.delete(id);
      const store = storage();
      if (store === null) return;
      try {
        store.removeItem(STORE_PREFIX + id);
      } catch (_error) {
        /* 清理失败不影响主流程。 */
      }
      writeIndex(readIndex().filter(entry => entry.id !== id));
    }

    /* ------------------------------------------------------------------ *
     * 纯逻辑：一次粘贴请求怎么处理（可单测，不碰 DOM）
     * ------------------------------------------------------------------ */
    /**
     * 判断并执行一次长文本粘贴。
     * @param {string} text - clipboard 里的纯文本。
     * @param {object} deps - { captureInsertion, insertChip, insertText, notify }
     * @returns {'pass'|'chip'|'refused'|'fallback'} 处理结果
     */
    function collapsePaste(text, deps) {
      if (!shouldCollapse(text)) return "pass";
      if (text.length > settings.maxChars) {
        deps.notify(copy().tooLong(text.length), "warn");
        return "refused";
      }
      const ref = writeBody(text);
      const label = chipLabel(text);
      const span = deps.captureInsertion();
      const reference = { source: SOURCE, ref, label, appearance: "file", clipboardText: label };
      let accepted = false;
      try {
        accepted = deps.insertChip(reference, span) === true;
      } catch (_error) {
        accepted = false;
      }
      if (accepted) {
        if (typeof deps.onInserted === "function") {
          try {
            deps.onInserted(ref, label);
          } catch (_error) {
            /* 记录失败不影响胶囊本身 */
          }
        }
        return "chip";
      }
      // 绝不吞掉用户的粘贴内容：胶囊插不进去就退回纯文本。
      dropBody(ref);
      deps.insertText(text, span);
      deps.notify(copy().failed, "info");
      return "fallback";
    }

    /* ------------------------------------------------------------------ *
     * DOM：找到本插件所属的 composer 编辑器，只拦它
     * ------------------------------------------------------------------ */
    function editorScopeOf(node) {
      let el = node;
      while (el && el !== document.body) {
        const editor = el.querySelector ? el.querySelector(EDITOR_SELECTOR) : null;
        if (editor) return editor;
        el = el.parentElement;
      }
      return null;
    }

    /* ------------------------------------------------------------------ *
     * 样式：胶囊只能从外层容器改（内部是 core 渲染的），浮层与提示条是自己的
     * ------------------------------------------------------------------ */
    const STYLE_ID = "dsh-paste-chip-style";

    function ensureStyles() {
      if (typeof document === "undefined" || document.head === null || document.head === undefined) return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
/* 胶囊外层：行内盒只有 17px，core 内层是 24px，描边会贴字形。
   display:inline-block 让外盒包住内层，做成真正的胶囊（实测基线不动、行高不变）。 */
[data-composer-chip="paste-chip"] {
  display: inline-block;
  vertical-align: baseline;
  max-width: 100%;
  border-radius: var(--dsw-radius-sm, 8px);
  background-color: rgba(122, 170, 255, 0.10);
  background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 10%, transparent);
  box-shadow: 0 0 0 1px rgba(122, 170, 255, 0.28), 0 1px 2px rgba(0, 0, 0, 0.22);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 28%, transparent),
              0 1px 2px rgba(0, 0, 0, 0.22);
  transition: background-color 120ms ease-out, box-shadow 120ms ease-out;
}
[data-composer-chip="paste-chip"]:hover {
  background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 16%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 46%, transparent),
              0 2px 6px rgba(0, 0, 0, 0.26);
}
/* 正文已失效：仍是胶囊，但一眼看出不对劲 */
[data-composer-chip="paste-chip"][data-paste-chip-lost] {
  background-color: color-mix(in srgb, #f2c14e 10%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, #f2c14e 40%, transparent), 0 1px 2px rgba(0, 0, 0, 0.22);
}
/* 提示条：浮在卡片上沿，不压草稿首行；回退是成功降级，用中性色不用警告色 */
[data-dsh-paste-chip="notice"] {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 6px;
  padding: 7px 11px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 18px;
  animation: dsh-paste-chip-notice-in 160ms ease-out;
}
[data-dsh-paste-chip="notice"][data-tone="warn"] {
  color: #f2c14e;
  background: rgba(210, 153, 34, 0.12);
  border: 1px solid rgba(210, 153, 34, 0.32);
  border-left: 3px solid rgba(242, 193, 78, 0.85);
}
[data-dsh-paste-chip="notice"][data-tone="info"] {
  color: var(--dsw-alias-label-secondary, #cfd3d6);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-left: 3px solid rgba(122, 170, 255, 0.55);
}
@keyframes dsh-paste-chip-notice-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  [data-composer-chip="paste-chip"] { transition: none; }
  [data-dsh-paste-chip="notice"] { animation: none; }
}
`;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ *
     * 悬停预览：一张浮层，显示该胶囊正文的前几百字
     * ------------------------------------------------------------------ */
    /**
     * label → ref 的旁路索引。槽位若拿不到 InputState（useInput 不存在），
     * 就用胶囊上的可见标签回查正文；同标签可能有多个，取最后插入的那个。
     */
    const labelIndex = new Map();

    function rememberLabel(label, ref) {
      const list = labelIndex.get(label) === undefined ? [] : labelIndex.get(label);
      list.push(ref);
      while (list.length > 50) list.shift();
      labelIndex.set(label, list);
    }

    let tooltipEl = null;

    /** 懒创建浮层节点；没有 DOM 就返回 null（测试环境）。 */
    function ensureTooltip() {
      if (tooltipEl !== null) return tooltipEl;
      if (typeof document === "undefined" || document.body === null || document.body === undefined) return null;
      const box = document.createElement("div");
      box.setAttribute("data-dsh-paste-chip", "tooltip");
      const styles = {
        position: "fixed", zIndex: "60", width: "520px", maxWidth: "min(520px, calc(100vw - 32px))",
        maxHeight: "320px", overflow: "hidden", padding: "12px 14px", borderRadius: "12px",
        background: "color-mix(in srgb, var(--dsw-specific-input-major, #2c2c2e) 96%, var(--dsw-alias-state-business-primary, #7aaaff))",
        color: "var(--dsw-alias-label-secondary, #cfd3d6)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 12px 28px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(0,0,0,0.5)",
        fontSize: "12px", lineHeight: "18px",
        pointerEvents: "none", opacity: "0", transform: "translateY(2px)",
        transition: "opacity 140ms cubic-bezier(0.16,1,0.3,1), transform 140ms cubic-bezier(0.16,1,0.3,1)",
      };
      for (const key of Object.keys(styles)) box.style[key] = styles[key];
      document.body.appendChild(box);
      tooltipEl = box;
      return box;
    }

    /** 创建一行小号说明文字。 */
    function textNode(tag, value, styles) {
      const node = document.createElement(tag);
      node.textContent = value;
      for (const key of Object.keys(styles || {})) node.style[key] = styles[key];
      return node;
    }

    /**
     * 计算浮层位置：默认贴在编辑器上沿之上（不压输入框），上方空间不够就放到编辑
     * 器下方；最后夹在视口内。抽成纯函数是为了能单测，DOM 只负责传矩形。
     * @param {{top:number,bottom:number,left:number}} anchor - 编辑器矩形
     * @param {{width:number,height:number}} self - 浮层自身尺寸
     * @param {{width:number,height:number}} viewport - 视口尺寸
     * @returns {{top: number, left: number}} 视口坐标
     */
    function placeTooltip(anchor, self, viewport) {
      const GAP = 8;
      const EDGE = 8;
      let top = anchor.top - self.height - GAP;
      if (top < EDGE) top = anchor.bottom + GAP;
      if (top + self.height > viewport.height - EDGE) {
        top = Math.max(EDGE, viewport.height - self.height - EDGE);
      }
      let left = anchor.left;
      if (left + self.width > viewport.width - EDGE) left = Math.max(EDGE, viewport.width - self.width - EDGE);
      return { top: Math.round(top), left: Math.round(left) };
    }

    /** 浮层锚点：优先整个编辑器（这样不会压在输入框内容上），没有就退回胶囊本身。 */
    function tooltipAnchorRect(anchorEl) {
      let rect = null;
      try {
        const editor = typeof document === "undefined" ? null : document.querySelector(EDITOR_SELECTOR);
        if (editor !== null && typeof editor.getBoundingClientRect === "function") rect = editor.getBoundingClientRect();
      } catch (_error) {
        rect = null;
      }
      if (rect === null || rect.height === 0) {
        rect = anchorEl !== null && anchorEl !== undefined && typeof anchorEl.getBoundingClientRect === "function"
          ? anchorEl.getBoundingClientRect()
          : { top: 200, bottom: 240, left: 200 };
      }
      return rect;
    }

    /** 把浮层放到编辑器上方；下方不够就翻到下方，并夹在视口内。 */
    function showTooltip(anchorEl, model, options) {
      const box = ensureTooltip();
      if (box === null) return;
      const pinning = options !== undefined && options.pinned === true;
      // 悬停时浮层不能吃鼠标事件（否则一移过去就闪）；常驻时反而要能点「复制全文」。
      box.style.pointerEvents = pinning ? "auto" : "none";
      box.textContent = "";

      const head = document.createElement("div");
      const headStyle = { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" };
      for (const key of Object.keys(headStyle)) head.style[key] = headStyle[key];

      const dot = textNode("span", "▍", { color: "#7aa2ff", fontSize: "13px", lineHeight: "1" });
      const title = textNode("span", model.header, { color: "#9db8ff", fontWeight: "600", fontSize: "12px" });
      const badge = textNode("span", `${model.total} 字`, {
        marginLeft: "auto", color: "rgba(230,232,238,0.72)", fontSize: "11px",
        padding: "1px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.08)",
      });
      head.appendChild(dot);
      head.appendChild(title);
      head.appendChild(badge);

      const body = textNode("div", model.preview, {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px", lineHeight: "1.62", color: "rgba(233,236,242,0.93)",
        whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "220px", overflow: "hidden",
      });

      const foot = textNode("div", model.truncated ? `仅预览前 ${settings.previewChars} 字 · 发送时展开全文` : "发送时展开全文", {
        marginTop: "8px", fontSize: "11px", color: "rgba(230,232,238,0.45)",
      });

      box.appendChild(head);

      if (model.context !== null) {
        const contextRow = document.createElement("div");
        const contextStyle = {
          marginBottom: "8px", paddingBottom: "8px", borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: "11px", lineHeight: "17px", color: "rgba(230,232,238,0.55)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        };
        for (const key of Object.keys(contextStyle)) contextRow.style[key] = contextStyle[key];
        if (model.context.before !== "") contextRow.appendChild(textNode("span", `…${model.context.before} `, {}));
        contextRow.appendChild(textNode("span", "▍此处 ", { color: "rgba(122,170,255,0.9)" }));
        if (model.context.after !== "") contextRow.appendChild(textNode("span", ` ${model.context.after}…`, {}));
        box.appendChild(contextRow);
      }

      box.appendChild(body);
      box.appendChild(foot);

      if (pinning) {
        const actions = document.createElement("div");
        const actionStyle = { marginTop: "10px", display: "flex", gap: "8px" };
        for (const key of Object.keys(actionStyle)) actions.style[key] = actionStyle[key];
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = copy().copyAll;
        const buttonStyle = {
          padding: "4px 10px", borderRadius: "7px", cursor: "pointer",
          fontSize: "11px", lineHeight: "16px",
          color: "var(--dsw-alias-label-primary, #e6e8ee)",
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.14)",
        };
        for (const key of Object.keys(buttonStyle)) button.style[key] = buttonStyle[key];
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
          if (clipboard === undefined || typeof clipboard.writeText !== "function") {
            button.textContent = copy().copyFailed;
            log("error", "preview.copy.failed", { reason: "no-clipboard" });
            return;
          }
          clipboard.writeText(model.fullBody).then(
            () => {
              button.textContent = copy().copied;
              log("info", "preview.copy", { chars: model.fullBody.length });
            },
            (error) => {
              button.textContent = copy().copyFailed;
              log("error", "preview.copy.failed", String(error && error.message ? error.message : error));
            },
          );
        });
        actions.appendChild(button);
        box.appendChild(actions);
      }

      box.style.left = "0px";
      box.style.top = "0px";
      box.style.opacity = "1";
      box.style.transform = "translateY(0)";
      const anchor = tooltipAnchorRect(anchorEl);
      const self = box.getBoundingClientRect();
      const viewport = typeof window === "undefined"
        ? { width: 1200, height: 800 }
        : { width: window.innerWidth || 1200, height: window.innerHeight || 800 };
      const placed = placeTooltip(anchor, self, viewport);
      box.style.top = `${placed.top}px`;
      box.style.left = `${placed.left}px`;
      void model.truncated;
    }

    let tooltipShowTimer = null;
    let tooltipHideTimer = null;
    /** 常驻预览：点击胶囊打开后保持显示，直到 Esc / 点外部 / 再点别的胶囊。 */
    let pinned = null;
    /** 最近一次悬停到的胶囊元素，点击打开预览时用它做锚点。 */
    let lastChipEl = null;
    /** 每会话最新的 InputState：对外 append() 需要它算插入点与 revision。 */
    const latestInputs = new Map();

    /** 取消一切待执行动作。 */
    function cancelTooltipTimers() {
      if (tooltipShowTimer !== null) {
        clearTimeout(tooltipShowTimer);
        tooltipShowTimer = null;
      }
      if (tooltipHideTimer !== null) {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      }
    }

    /** 悬停意图：延迟一段时间才显示。 */
    function scheduleTooltip(anchorEl, model) {
      if (tooltipHideTimer !== null) {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      }
      if (tooltipShowTimer !== null) return;
      tooltipShowTimer = setTimeout(() => {
        tooltipShowTimer = null;
        showTooltip(anchorEl, model);
      }, settings.hoverDelayMs);
    }

    /** 离开宽限：延迟隐藏，期间移回来就取消。 */
    function scheduleHideTooltip() {
      if (pinned !== null) return;
      if (tooltipShowTimer !== null) {
        clearTimeout(tooltipShowTimer);
        tooltipShowTimer = null;
      }
      if (tooltipHideTimer !== null) return;
      tooltipHideTimer = setTimeout(() => {
        tooltipHideTimer = null;
        hideTooltip();
      }, settings.leaveGraceMs);
    }

    function hideTooltip() {
      if (tooltipEl === null) return;
      tooltipEl.style.transition = "opacity 90ms ease-in";
      tooltipEl.style.opacity = "0";
      tooltipEl.style.transform = "translateY(2px)";
    }

    /** 没有胶囊元素可锚定时，退到输入框的位置。 */
    function composerAnchor() {
      const editor = typeof document === "undefined" ? null : document.querySelector(EDITOR_SELECTOR);
      const rect = editor !== null && typeof editor.getBoundingClientRect === "function"
        ? editor.getBoundingClientRect()
        : null;
      const box = rect === null ? { top: 200, left: 200, bottom: 240, width: 320, height: 40 } : rect;
      return { getBoundingClientRect: () => box };
    }

    /**
     * 打开常驻预览（点击胶囊或托盘条目）。
     * @param {string} ref - 胶囊的引用 id
     * @param {string} body - 正文
     * @param {object} [anchorEl] - 锚点元素，缺省用输入框
     * @returns {boolean} 是否打开
     */
    function pinPreview(ref, body, anchorEl) {
      if (typeof body !== "string" || body === "") {
        log("warn", "preview.pin.miss", { ref: String(ref) });
        return false;
      }
      pinned = { ref };
      const anchor = anchorEl !== null && anchorEl !== undefined && typeof anchorEl.getBoundingClientRect === "function"
        ? anchorEl
        : composerAnchor();
      showTooltip(anchor, tooltipModel(body, chipLabel(body), null), { pinned: true });
      log("info", "preview.pin", { ref: String(ref), chars: body.length });
      return true;
    }

    /** 关闭常驻预览。 */
    function unpinPreview() {
      if (pinned === null) return;
      pinned = null;
      hideTooltip();
      log("info", "preview.unpin");
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */
    function PasteHost(props) {
      const hostRef = useRef(null);
      const scopeRef = useRef(null);
      const liveRef = useRef(props);
      const [notice, setNotice] = useState(null);
      const pushNotice = (text, tone) => setNotice({ text, tone: tone === "warn" ? "warn" : "info" });
      // 会话槽只给 useInput 选择器，没有现成的 input 快照；
      // 订阅整个 InputState 让悬停能被映射回 occurrences（渲染成本只是一个空 div）。
      const inputState = typeof props.useInput === "function" ? props.useInput(state => state) : undefined;
      // 记住每个会话最新的输入状态：对外 append() 靠它算「末尾插入点」。
      try {
        if (inputState !== undefined && inputState !== null && inputState.sessionId !== undefined) {
          latestInputs.set(inputState.sessionId, inputState);
        } else if (inputState !== undefined && inputState !== null && props.sessionId !== undefined) {
          latestInputs.set(props.sessionId, inputState);
        }
      } catch (_error) { /* 记录失败不影响主流程 */ }
      liveRef.current = { ...props, input: inputState === undefined ? props.input : inputState };

      useEffect(() => {
        log("info", "host.mount", {
          hasDom: typeof document !== "undefined",
          hasUseInput: typeof liveRef.current.useInput === "function",
          hasInputActions: liveRef.current.inputActions !== undefined,
          hasActx: liveRef.current.pasteChipActx !== undefined,
        });

        const onPaste = (event) => {
          // 只处理本插件挂载的那一个 composer：别的可编辑区（设置页等）不管。
          // 槽位可能被 portal 到卡片外，从自己的节点找不到就退化成页面里唯一的编辑器；
          // 两者都没有就完全不拦（宁可不动，也不误伤别的输入区）。
          if (scopeRef.current === null) {
            const fromSelf = editorScopeOf(hostRef.current);
            const fallback = typeof document === "undefined" ? null : document.querySelector(EDITOR_SELECTOR);
            scopeRef.current = fromSelf ?? fallback;
            log(scopeRef.current === null ? "warn" : "info", "scope.resolve", {
              via: fromSelf !== null ? "self" : fallback !== null ? "document" : "none",
              tag: scopeRef.current === null ? undefined : String(scopeRef.current.tagName || ""),
              hasHostNode: hostRef.current !== null,
            });
          }
          const scope = scopeRef.current;
          if (scope === null) return;
          if (!scope.contains(event.target)) {
            log("info", "paste.outside-scope", {
              target: String(event.target && event.target.tagName ? event.target.tagName : "?"),
            });
            return;
          }

          const data = event.clipboardData;
          if (!data) {
            log("warn", "paste.no-clipboard-data");
            return;
          }
          const text = data.getData("text/plain");
          log("info", "paste.seen", { chars: text.length, collapses: shouldCollapse(text) });
          if (text === "") return;
          if (!shouldCollapse(text)) return;

          // 长粘贴由我们接管：先掐掉默认行为，再决定折叠或拒绝。
          event.preventDefault();
          event.stopPropagation();

          const live = liveRef.current;
          const actions = live.inputActions;
          const actx = live.pasteChipActx;
          if (actions === undefined || actx === undefined) {
            // 拿不到通道就退回原生粘贴，不拦。
            log("error", "paste.no-channel", { hasActions: actions !== undefined, hasActx: actx !== undefined });
            actions?.insertText?.(text, actions.captureInsertion());
            return;
          }

          const outcome = collapsePaste(text, {
            captureInsertion: () => actions.captureInsertion(),
            insertChip: (reference, span) =>
              actx.bail(actx, "slash/input-insert-reference", { reference, span }),
            insertText: (body, span) => actions.insertText(body, span),
            notify: pushNotice,
            onInserted: (ref, label) => rememberLabel(label, ref),
          });
          const state = typeof window === "undefined" ? undefined : window.__dshPasteChip;
          if (state !== undefined) {
            state.intercepts += 1;
            state.lastOutcome = outcome;
          }
          log(outcome === "chip" ? "info" : outcome === "refused" ? "warn" : "error", "paste.outcome", {
            chars: text.length, outcome, intercepts: state === undefined ? undefined : state.intercepts,
          });
        };

        // 悬停预览：只认本插件产出的胶囊（data-composer-chip 等于自己的 source）。
        const onOver = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== "function") return;
          const chip = target.closest("[data-composer-chip]");
          if (chip === null || chip.getAttribute("data-composer-chip") !== SOURCE) return;
          lastChipEl = chip;
          // 常驻预览开着时，悬停不抢它。
          if (pinned !== null) return;
          const chips = typeof document.querySelectorAll === "function"
            ? Array.from(document.querySelectorAll(`[data-composer-chip="${SOURCE}"]`))
            : [chip];
          const index = Math.max(0, chips.indexOf(chip));
          const input = liveRef.current.input;
          let via = "occurrences";
          let ref = refAtIndex(input === undefined ? [] : input.occurrences, index);
          if (ref === undefined) {
            const byLabel = labelIndex.get(String(chip.textContent || ""));
            if (byLabel !== undefined && byLabel.length > 0) {
              ref = byLabel[byLabel.length - 1];
              via = "label";
            }
          }
          if (ref === undefined) via = "none";
          const body = ref === undefined ? null : readBody(ref);
          log(body === null ? "warn" : "info", "tooltip.request", {
            index, via, hit: body !== null, chars: body === null ? 0 : body.length,
            knownLabels: labelIndex.size,
          });
          if (body === null) {
            // 正文被淘汰/丢失：把胶囊标成失效态，别等发送那一刻才炸。
            try { chip.setAttribute("data-paste-chip-lost", "1"); } catch (_error) { /* 标记失败不影响主流程 */ }
            return;
          }
          try { chip.removeAttribute("data-paste-chip-lost"); } catch (_error) { /* 同上 */ }
          // core 在胶囊上挂了 title={label}，会和我们的浮层形成双 tooltip，这里清掉。
          try {
            if (chip.getAttribute("title") !== null) chip.removeAttribute("title");
          } catch (_error) { /* 属性操作失败不影响预览 */ }
          scheduleTooltip(chip, tooltipModel(body, chipLabel(body), contextOf(input, index)));
        };
        const onOut = (event) => {
          const target = event.target;
          if (target && typeof target.closest === "function" && target.closest("[data-composer-chip]") !== null) scheduleHideTooltip();
        };
        const onScroll = () => { cancelTooltipTimers(); hideTooltip(); };

        // 用户输入的信号不止 beforeinput：输入法组合提交、部分按键路径不一定发它，
        // 漏一次就会被当成外部插入。这几类事件一起当作「用户在改草稿」。
        const onUserInput = () => { typingAtRef.current = Date.now(); };
        for (const type of ["beforeinput", "input", "keydown", "compositionstart", "compositionend"]) {
          document.addEventListener(type, onUserInput, true);
        }

        document.addEventListener("paste", onPaste, true);
        document.addEventListener("pointerover", onOver, true);
        document.addEventListener("pointerout", onOut, true);
        document.addEventListener("scroll", onScroll, true);
        return () => {
          for (const type of ["beforeinput", "input", "keydown", "compositionstart", "compositionend"]) {
            document.removeEventListener(type, onUserInput, true);
          }
          document.removeEventListener("paste", onPaste, true);
          document.removeEventListener("pointerover", onOver, true);
          document.removeEventListener("pointerout", onOut, true);
          document.removeEventListener("scroll", onScroll, true);
          cancelTooltipTimers();
          hideTooltip();
          log("info", "host.unmount");
        };
      }, []);

      // 非粘贴渠道：标注浏览器、划词询问这类插件是用 setDraft/insertText 写草稿的，
      // 不触发 paste 事件，只能比对前后草稿找出「这一次新塞进来的那一段」。
      const lastDraftRef = useRef(null);
      const skipOnceRef = useRef(false);
      const mountedAtRef = useRef(0);
      const warmLoggedRef = useRef(false);
      const typingAtRef = useRef(0);
      useEffect(() => {
        mountedAtRef.current = Date.now();
      }, []);
      useEffect(() => {
        const input = liveRef.current.input;
        if (input === undefined || typeof input.draft !== "string") return;
        const next = input.draft;
        const prev = lastDraftRef.current;
        lastDraftRef.current = next;
        if (mountedAtRef.current !== 0 && Date.now() - mountedAtRef.current < settings.warmupMs) {
          if (!warmLoggedRef.current) {
            warmLoggedRef.current = true;
            log("info", "insertion.warmup", { windowMs: settings.warmupMs });
          }
          // 预热期内如果有内容变化，说明可能有一条外部插入被窗口挡住——留痕才查得出来。
          if (prev !== null && prev !== next) {
            log("info", "insertion.skip", {
              reason: "warmup", sinceMountMs: Date.now() - mountedAtRef.current,
              grew: next.length - prev.length,
            });
          }
          return;
        }
        if (skipOnceRef.current) {
          skipOnceRef.current = false;
          return;
        }
        if (prev === null || prev === next) return;

        const insertion = detectInsertion(prev, next);
        if (insertion === null) return;
        if (insertion.removed > 0) return;
        // 外部渠道传进来的一律成胶囊，不看字数/行数——但必须先排除用户自己打字。
        if (insertion.text.trim() === "") return;
        if (typingAtRef.current !== 0 && Date.now() - typingAtRef.current < settings.inputGraceMs) {
          log("info", "insertion.skip", {
            reason: "user-typing", chars: insertion.text.length,
            sinceInputMs: Date.now() - typingAtRef.current,
          });
          return;
        }
        // 关键防护：插入内容如果是我们自己刚生成的胶囊标签，说明这次变化是
        // 「胶囊插进草稿」本身，不是外部渠道写入。再折叠一次会变成胶囊套胶囊，
        // 发送时展开出来的就是标签（线上踩过：1k 字粘贴最后只发出 24 个字符）。
        const insertedText = insertion.text.trim();
        // 旧版本留下的标签可能不在 selfLabels 里（例如恢复的草稿），用形状再兜一次：
        // 标签永远很短且以固定前缀开头，真实外部写入不会长这样。
        const looksLikeLabel = insertedText.length <= 120 && /^(粘贴「|Pasted 「)/u.test(insertedText);
        if (selfLabels.has(insertedText) || looksLikeLabel) {
          if (looksLikeLabel && !selfLabels.has(insertedText)) selfLabels.add(insertedText);
          log("info", "insertion.skip", { reason: "own-label", chars: insertedText.length });
          return;
        }
        // @ 提及、/ 命令是别的插件用「自定义方式艾特」插进来的 token，不是要折叠的长文本。
        // 吃掉它们会让提及失效（实测把「@品牌视觉设计师」折成了粘贴胶囊）。
        if (/^[@/]/u.test(insertedText)) {
          log("info", "insertion.skip", { reason: "trigger-token", chars: insertedText.length });
          return;
        }
        // 兜底：手打/输入法提交一次就是几个字，不可能是「外部渠道塞进来的一段」。
        if (insertedText.length < settings.externalMinChars) {
          log("info", "insertion.skip", { reason: "too-short", chars: insertion.text.length });
          return;
        }

        const actions = liveRef.current.inputActions;
        const actx = liveRef.current.pasteChipActx;
        log("info", "insertion.detected", {
          chars: insertion.text.length, start: insertion.start, end: insertion.end,
          hasActions: actions !== undefined, hasActx: actx !== undefined,
        });
        if (actions === undefined || actx === undefined) {
          log("warn", "insertion.no-channel");
          return;
        }
        // 已有胶囊时 clipboard 与 detect 偏移不一致：换算成 detect 坐标再插。
        const occurrences = input.occurrences === undefined || input.occurrences === null ? [] : input.occurrences;
        const detectStart = clipboardToDetect(insertion.start, occurrences);
        const detectEnd = clipboardToDetect(insertion.end, occurrences);
        if (detectEnd <= detectStart) {
          log("warn", "insertion.skip", { reason: "unmappable-span", clipStart: insertion.start, occurrences: occurrences.length });
          return;
        }

        const body = insertion.text;
        const ref = writeBody(body);
        const label = chipLabel(body);
        let accepted = false;
        try {
          accepted = actx.bail(actx, "slash/input-insert-reference", {
            reference: { source: SOURCE, ref, label, appearance: "file", clipboardText: label },
            span: { start: detectStart, end: detectEnd, draftRev: input.draftRev },
          }) === true;
        } catch (error) {
          log("error", "insertion.bail.failed", String(error && error.message ? error.message : error));
        }
        if (accepted) {
          skipOnceRef.current = true;
          rememberLabel(label, ref);
          log("info", "insertion.collapsed", {
            chars: body.length, clipStart: insertion.start, detectStart, detectEnd,
            occurrences: occurrences.length,
          });
        } else {
          dropBody(ref);
          log("warn", "insertion.rejected", { chars: body.length });
        }
      }, [inputState]);

      return h(
        "div",
        { [HOST_ATTR]: "host", ref: hostRef, style: { display: "contents" } },
        notice === null
          ? null
          : h("div", { role: "alert", [HOST_ATTR]: "notice", "data-tone": notice.tone }, notice.text),
      );
    }

    /* ------------------------------------------------------------------ *
     * 对外服务：给其他插件一个「精确插入」的入口（可选接法）
     * ------------------------------------------------------------------ */
    /** 服务名，其他插件通过 ctx.pasteChip 拿到。 */
    const SERVICE_NAME = "pasteChip";

    /**
     * 构造对外服务。生产者有两种接法：
     *   被动：什么都不做，靠草稿差异被接住（有预热窗口、已有胶囊时跳过等限制）
     *   主动：调 insert(text, { sessionId, span })，拿到原子插入与精确 span
     * @param {{sessions: object, log: Function}} deps - 会话解析与日志
     * @returns {{version: string, insert: Function}}
     */
    function createService(deps) {
      return {
        version: VERSION,
        /**
         * 把一段文本以胶囊形式插入指定会话的草稿。
         * @param {string} text - 正文（会进本插件的存储，不进草稿）
         * @param {{sessionId?: string, span?: object, label?: string}} [options]
         *   span 来自调用方的 inputActions.captureInsertion()，必须是同一 revision
         * @returns {{ok: true, ref: string, label: string} | {ok: false, reason: string}}
         */
        insert(text, options) {
          const opts = options === undefined || options === null ? {} : options;
          if (typeof text !== "string" || text === "") {
            return { ok: false, reason: "empty" };
          }
          if (text.length > settings.maxChars) {
            deps.log("warn", "api.reject", { reason: "too-long", chars: text.length });
            return { ok: false, reason: "too-long" };
          }
          const span = opts.span;
          if (span === undefined || span === null || typeof span.start !== "number" || typeof span.end !== "number") {
            deps.log("warn", "api.reject", { reason: "span-required" });
            return { ok: false, reason: "span-required" };
          }
          const sessionId = opts.sessionId;
          const actx = sessionId === undefined || deps.sessions === undefined || typeof deps.sessions.scope !== "function"
            ? undefined
            : deps.sessions.scope(sessionId);
          if (actx === undefined) {
            deps.log("warn", "api.reject", { reason: "no-session", sessionId: String(sessionId) });
            return { ok: false, reason: "no-session" };
          }

          const ref = writeBody(text);
          const label = typeof opts.label === "string" && opts.label !== "" ? opts.label : chipLabel(text);
          let accepted = false;
          try {
            accepted = actx.bail(actx, "slash/input-insert-reference", {
              reference: { source: SOURCE, ref, label, appearance: "file", clipboardText: label },
              span,
            }) === true;
          } catch (error) {
            deps.log("error", "api.bail.failed", String(error && error.message ? error.message : error));
          }
          if (!accepted) {
            dropBody(ref);
            deps.log("warn", "api.reject", { reason: "bail-refused" });
            return { ok: false, reason: "bail-refused" };
          }
          rememberLabel(label, ref);
          deps.log("info", "api.insert", { chars: text.length, label });
          return { ok: true, ref, label };
        },

        /**
         * 追加到草稿末尾并折叠成胶囊（不需要调用方提供 span）。
         * @param {string} text - 正文
         * @param {{sessionId?: string, label?: string}} [options]
         * @returns {{ok: true, ref: string, label: string} | {ok: false, reason: string}}
         */
        append(text, options) {
          const opts = options === undefined || options === null ? {} : options;
          const sessionId = opts.sessionId;
          const input = sessionId === undefined ? undefined : latestInputs.get(sessionId);
          if (input === undefined) {
            deps.log("warn", "api.reject", { reason: "no-input-state", sessionId: String(sessionId) });
            return { ok: false, reason: "no-input-state" };
          }
          const draft = typeof input.draft === "string" ? input.draft : "";
          const at = draft.length;
          return this.insert(text, {
            sessionId,
            span: { start: at, end: at, draftRev: input.draftRev },
            ...(opts.label === undefined ? {} : { label: opts.label }),
          });
        },

        /**
         * 原地更新一条胶囊的正文（标签与悬停预览共用同一份存储，无需重建草稿）。
         * @param {string} ref - 已有胶囊的引用 id
         * @param {string} text - 新正文
         * @returns {{ok: true, ref: string} | {ok: false, reason: string}}
         */
        replace(ref, text) {
          if (typeof ref !== "string" || ref === "") return { ok: false, reason: "empty-ref" };
          if (typeof text !== "string" || text === "") return { ok: false, reason: "empty" };
          if (text.length > settings.maxChars) return { ok: false, reason: "too-long" };
          if (readBody(ref) === null) {
            deps.log("warn", "api.reject", { reason: "unknown-ref" });
            return { ok: false, reason: "unknown-ref" };
          }
          writeBodyUnder(ref, text);
          deps.log("info", "api.replace", { ref, chars: text.length });
          return { ok: true, ref };
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 工具行入口：「粘贴 N」—— 键盘可达的查看器（不是草稿对象）
     * ------------------------------------------------------------------ */
    function PasteTray(props) {
      const input = typeof props.useInput === "function" ? props.useInput(state => state) : undefined;
      const occurrences = input === undefined || input === null
        ? []
        : (input.occurrences || []).filter(entry => entry !== null && typeof entry === "object" && entry.source === SOURCE);
      const [open, setOpen] = useState(false);
      if (occurrences.length === 0) return null;

      const rows = occurrences.map((occurrence, index) => {
        const body = readBody(occurrence.ref);
        const chars = body === null ? 0 : body.length;
        return h(
          "button",
          {
            type: "button",
            key: `paste-${index}`,
            title: occurrence.label,
            style: {
              display: "block", width: "100%", textAlign: "left", padding: "5px 8px",
              background: "transparent", border: "none", borderRadius: "6px", cursor: "pointer",
              color: "var(--dsw-alias-label-secondary, #cfd3d6)", fontSize: "11px", lineHeight: "16px",
            },
            onClick: () => {
              setOpen(false);
              pinPreview(occurrence.ref, body, lastChipEl);
            },
          },
          body === null ? `${occurrence.label} · 正文已失效` : `${occurrence.label}`,
        );
      });

      return h(
        "div",
        { [HOST_ATTR]: "tray", style: { position: "relative", display: "inline-flex" } },
        h(
          "button",
          {
            type: "button",
            title: copy().trayTitle,
            "aria-label": copy().trayTitle,
            onClick: () => setOpen(!open),
            style: {
              padding: "3px 8px", borderRadius: "8px", cursor: "pointer",
              fontSize: "11px", lineHeight: "16px",
              color: "var(--dsw-alias-label-secondary, #cfd3d6)",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
            },
          },
          `${copy().trayPrefix} ${occurrences.length}`,
        ),
        open
          ? h(
            "div",
            {
              style: {
                position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: "240px",
                maxWidth: "360px", padding: "6px", borderRadius: "10px", zIndex: 61,
                background: "color-mix(in srgb, var(--dsw-specific-input-major, #2c2c2e) 96%, transparent)",
                border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
              },
            },
            rows,
          )
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件装配
     * ------------------------------------------------------------------ */
    /** 需要 slots 挂组件、sessions 解析会话 actx、inputTriggers 注册引用来源。 */
    const inject = ["slots", "sessions", "inputTriggers", "locale"];

    function apply(ctx) {
      const sessions = ctx.sessions;
      const inputTriggers = ctx.inputTriggers;
      // 宿主 locale 服务：中文界面下 label 才能是中文（浏览器语言可能是 en）。
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.getLocale === "function") {
          localeReader = () => {
            const snapshot = ctx.locale.getLocale();
            return snapshot === undefined || snapshot === null ? "" : snapshot.active;
          };
        }
      } catch (_error) {
        localeReader = null;
      }

      // 加载自证：客户端半一旦被宿主执行，控制台和落盘日志一定都有这一行。
      // 没有它 = 插件没被加载；有它但没有胶囊 = 加载了但链路没通，两种故障可分。
      const probe = { version: VERSION, ready: true, intercepts: 0, lastOutcome: null, events: 0 };
      if (typeof window !== "undefined") {
        window.__dshPasteChip = probe;
        // 未捕获异常也要进日志：插件里任何一处 throw 都不能只留在控制台。
        try {
          window.addEventListener("error", (event) => {
            log("error", "window.error", String(event && event.message));
          });
          window.addEventListener("unhandledrejection", (event) => {
            log("error", "window.unhandledrejection", String(event && event.reason));
          });
          // 关页面时把尾巴发出去（beacon 不受 unload 取消影响）。
          window.addEventListener("pagehide", () => {
            try {
              if (logBuffer.length > 0 && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
                const payload = JSON.stringify({ events: logBuffer.splice(0, logBuffer.length) });
                navigator.sendBeacon(LOG_PATH, new Blob([payload], { type: "application/json" }));
              }
            } catch (_error) {
              /* beacon 失败就算了，不能拦住关闭 */
            }
          });
        } catch (_error) {
          /* 事件监听挂了也不影响主流程 */
        }
      }
      ensureStyles();
      void loadSettings();
      // 对外服务：其他插件自愿调用；不调用也照样被草稿观察器接住。
      try {
        ctx.provide(SERVICE_NAME, createService({ sessions, log }));
        log("info", "service.ready", { name: SERVICE_NAME });
      } catch (error) {
        log("error", "service.provide.failed", String(error && error.message ? error.message : error));
      }
      log("info", "client.loaded", {
        version: VERSION,
        locale: (() => { try { return localeReader === null ? "?" : String(localeReader()); } catch (_error) { return "err"; } })(),
        href: typeof location === "undefined" ? undefined : String(location.href).slice(0, 120),
        hasSlots: ctx.slots !== undefined,
        hasSessions: sessions !== undefined && typeof sessions.scope === "function",
        hasInputTriggers: inputTriggers !== undefined && typeof inputTriggers.registerSource === "function",
      });

      // 引用来源：chip 的 source 名必须在这里注册，否则发送时没人展开。
      // 空 candidates 让它不出现在 / 菜单里；showGroupTitle:false 连组标题都不画。
      ctx.effect(() => {
        try {
          const dispose = inputTriggers.registerSource({
            trigger: "/",
            name: SOURCE,
            order: 900,
            showGroupTitle: false,
            candidates: () => Promise.resolve([]),
            // 点击胶囊：打开常驻预览（触屏没有 hover，这是唯一的预览入口）。
            openReference: (_session, reference) => {
              const body = readBody(reference.ref);
              if (body === null) {
                log("warn", "open.miss", { ref: String(reference.ref) });
                return false;
              }
              return pinPreview(reference.ref, body, lastChipEl);
            },
            codec: {
              clipboardText: (ref) => {
                const body = readBody(ref);
                log("info", "codec.clipboardText", { ref, hit: body !== null, chars: body === null ? 0 : body.length });
                return body === null ? copy().label(0) : copy().label(body.length);
              },
              serialize: (ref) => {
                const body = readBody(ref);
                // 第二层防线：正文本身就是我们生成的标签，说明历史上发生过「胶囊套胶囊」。
                // 这种情况宁可拦住发送并说明，也不能把标签当成正文发出去。
                const nested = body !== null && selfLabels.has(body.trim());
                log(body === null || nested ? "error" : "info", "codec.serialize", {
                  ref, hit: body !== null, chars: body === null ? 0 : body.length,
                  ...(nested ? { nested: true } : {}),
                });
                if (body === null) return Promise.reject(new Error(copy().lost));
                if (nested) return Promise.reject(new Error(copy().nested));
                return Promise.resolve(body);
              },
            },
          });
          log("info", "source.registered", { name: SOURCE, trigger: "/" });
          return dispose;
        } catch (error) {
          log("error", "source.register.failed", String(error && error.message ? error.message : error));
          throw error;
        }
      }, "dsh-paste-chip: paste reference source");

      // 常驻预览的关闭手势：Esc 或点浮层外部。
      ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        const onKey = (event) => { if (event.key === "Escape") unpinPreview(); };
        const onDown = (event) => {
          if (pinned === null) return;
          if (tooltipEl !== null && typeof tooltipEl.contains === "function" && tooltipEl.contains(event.target)) return;
          unpinPreview();
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", onDown, true);
        return () => {
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("pointerdown", onDown, true);
        };
      }, "dsh-paste-chip: preview dismissal");

      ctx.inject(["slots"], () => {
        try {
          ctx.slots.inject("conversation.input.overlay", () => {
            const dispose = ctx.slots.register({
              name: "conversation.input.overlay",
              id: "dsh-paste-chip-v1",
              order: 90,
              // 槽位帧只给 sessionId，actx 要自己按会话解析（内置 slash 插件同样做法）。
              inject: (sessionId) => {
                const actx = typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
                log(actx === undefined ? "warn" : "info", "slot.session", {
                  sessionId: String(sessionId === undefined ? "undefined" : sessionId),
                  actxResolved: actx !== undefined,
                });
                return { pasteChipActx: actx };
              },
            }, PasteHost);
            log("info", "slot.registered", { slot: "conversation.input.overlay", id: "dsh-paste-chip-v1" });
            return dispose;
          });
          // 工具行入口：键盘 Tab 能到，读屏能念；只是查看器，不承担顺序语义。
          ctx.slots.inject("conversation.input.left", () => {
            const disposeTray = ctx.slots.register({ name: "conversation.input.left", id: "dsh-paste-chip-tray", order: 40 }, PasteTray);
            log("info", "slot.registered", { slot: "conversation.input.left", id: "dsh-paste-chip-tray" });
            return disposeTray;
          });
        } catch (error) {
          log("error", "slot.register.failed", String(error && error.message ? error.message : error));
        }
      });
    }

    return {
      inject,
      apply,
      // 测试缝隙：harness 直接驱动这些纯逻辑，不依赖 React/DOM。
      // 测试缝隙：harness 直接驱动这些纯逻辑，不依赖 React/DOM。
      __internals: {
        collapsePaste, shouldCollapse, compactCount, writeBody, readBody, dropBody, PasteHost,
        DEFAULT_SETTINGS, SOURCE, VERSION, LOG_PATH, flush, tooltipModel, refAtIndex, detectInsertion,
        chipLabel, labelSnippet, contextOf, clipboardToDetect,
        normalizeSettings, loadSettings, getSettings: () => settings, SETTINGS_PATH, placeTooltip,
        pendingLogs: () => logBuffer.slice(),
      },
    };
  },
});
