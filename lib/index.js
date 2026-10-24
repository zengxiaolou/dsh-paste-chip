/**
 * dsh-paste-chip 的宿主半 —— 只做一件事：把客户端半发来的日志追写到磁盘。
 *
 * 渲染进程没有文件系统权限，所以客户端缓存事件、批量 POST 到
 * `/api/dsh-paste-chip/log`，这里落到 `$DSH_HOME/logs/dsh-paste-chip.log`。
 *
 * 为什么要落盘：插件在浏览器里跑，出问题时只能靠控制台，隔着屏幕没法追。
 * 有了这个文件，一条 tail/grep 就能回答「宿主有没有加载插件」「客户端有没有
 * 执行到粘贴分支」，不用再靠人转述。
 */

import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 宿主半版本，和 package.json 保持一致。 */
const VERSION = "0.1.21";

/** 客户端批量上报的落点。 */
const LOG_PATH = "/api/dsh-paste-chip/log";

/** 客户端读取配置的落点。 */
const CONFIG_PATH = "/api/dsh-paste-chip/config";

/**
 * 全部可调项与其默认值。客户端半也用同一份默认值兜底——
 * 宿主没起、接口挂了、设置页没装，行为都和默认值一致。
 */
const DEFAULTS = {
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
  storeMaxBytes: 2097152,
};

/** 每个键的取值范围，越界一律夹到边界。 */
const RANGES = {
  collapseChars: [100, 10000],
  collapseLines: [3, 200],
  maxChars: [1000, 2000000],
  externalMinChars: [1, 200],
  warmupMs: [0, 10000],
  inputGraceMs: [0, 3000],
  previewChars: [80, 2000],
  contextChars: [0, 200],
  hoverDelayMs: [0, 1000],
  leaveGraceMs: [0, 1000],
  storeMaxEntries: [1, 100],
  storeMaxBytes: [65536, 8388608],
};

/**
 * 合并用户配置并夹到合法区间。
 * @param {object} source - 来自设置分区或 cordis.patch.yml 的 config
 * @returns {object} 完整配置
 */
function resolveConfig(source) {
  const raw = source === null || source === undefined ? {} : source;
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const [min, max] = RANGES[key];
    cfg[key] = Math.max(min, Math.min(max, Math.round(value)));
  }
  return cfg;
}

/** 单文件上限，超了就轮转一份 .1，避免日志把磁盘写满。 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 单次请求最多接收的事件数。 */
const MAX_EVENTS = 200;

/**
 * 选一个可写的日志目录：优先 `$DSH_HOME/logs`，退到临时目录。
 * @returns {string} 日志文件的绝对路径
 */
function resolveLogFile() {
  const candidates = [
    join(process.env.DSH_HOME || join(homedir(), ".dsh"), "logs"),
    join(tmpdir(), "dsh-logs"),
  ];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "dsh-paste-chip.log");
      appendFileSync(file, "");
      return file;
    } catch (_error) {
      /* 换下一个候选目录 */
    }
  }
  return join(candidates[candidates.length - 1], "dsh-paste-chip.log");
}

const LOG_FILE = resolveLogFile();

/** 超过上限就轮转一份，父目录不可写时安静跳过。 */
function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (_error) {
    /* 文件不存在或不可轮转都不影响写入 */
  }
}

/**
 * 追加一行 JSONL。
 * @param {object} record - 事件记录
 * @returns {void}
 */
function append(record) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...record });
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch (error) {
    // 落盘失败不能拖垮插件，退化成宿主 stderr。
    try {
      process.stderr.write(`[dsh-paste-chip] log write failed: ${String(error)}\n${line}\n`);
    } catch (_ignored) {
      /* 连 stderr 都没有就算了 */
    }
  }
}

/** 最小 JSON 响应。 */
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 读完整个请求体（体积有上限，避免被超大请求拖住）。 */
async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const inject = ["webServer"];

/**
 * 可选配置 schema：装了 @deepseek-ai/schemastery 就能在设置页里调；
 * 没装也能通过 cordis.patch.yml 的 config 段改。
 * @returns {object|null} Schemastery schema
 */
export function configSchema() {
  let Schema;
  try {
    // eslint-disable-next-line global-require
    Schema = require("@deepseek-ai/schemastery");
  } catch (_error) {
    return null;
  }
  const S = Schema && Schema.default ? Schema.default : Schema;
  if (typeof S?.object !== "function") return null;
  const num = (min, max, step) => S.number().min(min).max(max).step(step);
  return S.object({
    collapseChars: num(100, 10000, 50).default(DEFAULTS.collapseChars)
      .description("粘贴折叠阈值：字符数。达到即折叠成胶囊"),
    collapseLines: num(3, 200, 1).default(DEFAULTS.collapseLines)
      .description("粘贴折叠阈值：行数。任一条件达标即折叠"),
    maxChars: num(1000, 2000000, 1000).default(DEFAULTS.maxChars)
      .description("单段正文上限（字符）。超过直接拒绝并提示改用附件"),
    externalMinChars: num(1, 200, 1).default(DEFAULTS.externalMinChars)
      .description("外部渠道插入的兜底长度。低于它视为手打/输入法，不折叠"),
    warmupMs: num(0, 10000, 100).default(DEFAULTS.warmupMs)
      .description("挂载后的预热窗口（毫秒）。会话切换恢复草稿不接管"),
    inputGraceMs: num(0, 3000, 50).default(DEFAULTS.inputGraceMs)
      .description("用户输入后的宽限期（毫秒）。期间内的草稿变化算手打"),
    previewChars: num(80, 2000, 20).default(DEFAULTS.previewChars)
      .description("悬停浮层里预览的正文长度（字符）"),
    contextChars: num(0, 200, 10).default(DEFAULTS.contextChars)
      .description("悬停浮层里上下文各取多少字（0 = 不显示上下文）"),
    hoverDelayMs: num(0, 1000, 20).default(DEFAULTS.hoverDelayMs)
      .description("悬停多久才弹出预览（毫秒）"),
    leaveGraceMs: num(0, 1000, 20).default(DEFAULTS.leaveGraceMs)
      .description("移出胶囊后多久才收起预览（毫秒）"),
    storeMaxEntries: num(1, 100, 1).default(DEFAULTS.storeMaxEntries)
      .description("正文存储最多保留几条，超出淘汰最旧的"),
    storeMaxBytes: num(65536, 8388608, 65536).default(DEFAULTS.storeMaxBytes)
      .description("正文存储总字节上限，超出淘汰最旧的"),
  });
}

/**
 * 挂路由、写启动标记。
 * @param {object} ctx - 宿主 cordis 上下文
 * @param {object} [config] - cordis 传入的插件配置
 * @returns {void}
 */
export function apply(ctx, config) {
  let current = resolveConfig(config || {});
  // 启动标记是「宿主半到底加载了没有」的唯一证据：文件不存在 = 没加载。
  append({
    src: "host",
    ev: "host.boot",
    version: VERSION,
    logFile: LOG_FILE,
    node: process.version,
    pid: process.pid,
    config: current,
  });
  try {
    ctx.logger?.info?.(`[dsh-paste-chip] host half loaded v${VERSION}; log -> ${LOG_FILE}`);
  } catch (_error) {
    /* logger 不可用不影响插件 */
  }

  // 客户端启动时读这份配置；读不到就用同一套默认值。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: CONFIG_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      sendJson(res, 200, { ok: true, version: VERSION, config: current });
    },
  }), "dsh-paste-chip: config endpoint");

  // 设置页分区（装了 @deepseek-ai/dsh-settings 才有；没有也能用 cordis.patch.yml）
  try {
    const Schema = configSchema();
    if (Schema !== null) {
      const settings = require("@deepseek-ai/dsh-settings");
      if (typeof settings.installSettingsSection === "function" && typeof settings.settingsNamespace === "function") {
        settings.installSettingsSection(ctx, settings.settingsNamespace("dsh-paste-chip"), Schema, current, {
          setSource: (source) => {
            current = resolveConfig(typeof source === "function" ? source() : source);
          },
          onChange: () => {
            current = resolveConfig(current);
          },
        });
        append({ src: "host", ev: "config.section", namespace: "dsh-paste-chip" });
      }
    }
  } catch (error) {
    append({ src: "host", ev: "config.section.skipped", reason: String(error && error.message ? error.message : error) });
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: LOG_PATH,
    handler: async (req, res) => {
      if (req.method === "GET") {
        // 只读状态查询：不进文件也能确认落点与体积。
        let size = -1;
        try {
          size = statSync(LOG_FILE).size;
        } catch (_error) {
          /* 还没写过 */
        }
        sendJson(res, 200, { ok: true, version: VERSION, logFile: LOG_FILE, bytes: size });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }
      let events = [];
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        events = Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS) : [];
      } catch (error) {
        // 解析失败本身也要留痕：客户端日志格式错是我要修的问题。
        append({ src: "host", ev: "log.reject", reason: String(error) });
        sendJson(res, 400, { ok: false, error: "bad-json" });
        return;
      }
      for (const event of events) {
        if (event === null || typeof event !== "object") continue;
        append({ src: "client", ...event });
      }
      sendJson(res, 200, { ok: true, accepted: events.length });
    },
  }), "dsh-paste-chip: log sink");
}
