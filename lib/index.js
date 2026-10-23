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

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 宿主半版本，和 package.json 保持一致。 */
const VERSION = "0.1.16";

/** 客户端批量上报的落点。 */
const LOG_PATH = "/api/dsh-paste-chip/log";

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
 * 挂路由、写启动标记。
 * @param {object} ctx - 宿主 cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {
  // 启动标记是「宿主半到底加载了没有」的唯一证据：文件不存在 = 没加载。
  append({
    src: "host",
    ev: "host.boot",
    version: VERSION,
    logFile: LOG_FILE,
    node: process.version,
    pid: process.pid,
  });
  try {
    ctx.logger?.info?.(`[dsh-paste-chip] host half loaded v${VERSION}; log -> ${LOG_FILE}`);
  } catch (_error) {
    /* logger 不可用不影响插件 */
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
