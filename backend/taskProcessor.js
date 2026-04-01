const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Shanghai");

const rssParser = require("rss-parser");
const turndown = require("turndown");
const { HttpsProxyAgent } = require("https-proxy-agent");
const fetch = require("cross-fetch");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "tasks.json");
const FILTERED_FILE = path.join(__dirname, "data", "filtered_messages.json");
const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRemovePatterns(task) {
  const raw = String(task?.remove_content || "").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .flatMap((line) => String(line).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function applyRemovePatterns(content, patterns) {
  let next = String(content || "");
  if (!patterns || patterns.length === 0) return next;

  for (const pattern of patterns) {
    const p = String(pattern || "").trim();
    if (!p) continue;

    if (p.toLowerCase().startsWith("re:")) {
      const source = p.slice(3).trim();
      if (!source) continue;
      try {
        next = next.replace(new RegExp(source, "gi"), "");
      } catch (e) {}
      continue;
    }

    if (p.includes("<") && p.includes(">")) {
      const source = escapeRegExp(p).replace(/\s+/g, "\\s*");
      next = next.replace(new RegExp(source, "gi"), "");
      continue;
    }

    next = next.split(p).join("");
  }

  return next;
}

function isTaskEnabled(task) {
  const enabled = parseInt(task?.enabled, 10);
  return Number.isNaN(enabled) ? true : enabled > 0;
}

function loadTasks() {
  if (!fs.existsSync(DATA_FILE)) return [];

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (error) {
    console.error("读取 tasks.json 失败，已回退为空数组", error);
    return [];
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks));
}

function saveFilteredMessage(data) {
  let list = [];
  if (fs.existsSync(FILTERED_FILE)) {
    try {
      const raw = fs.readFileSync(FILTERED_FILE, "utf8").trim();
      if (raw) list = JSON.parse(raw);
    } catch (e) {
      list = [];
    }
  }
  const nextItem = {
    ...data,
    saved_at: dayjs().tz().format("YYYY-MM-DD HH:mm:ss"),
  };
  const identity = String(nextItem.content_id || nextItem.link || nextItem.title || "").trim();
  if (identity) {
    const index = list.findIndex((item) => {
      const itemIdentity = String(item?.content_id || item?.link || item?.title || "").trim();
      return String(item?.task_id || "") === String(nextItem.task_id || "") && itemIdentity === identity;
    });
    if (index >= 0) {
      list.splice(index, 1);
    }
  }
  list.unshift(nextItem);
  // 最多保存 500 条
  if (list.length > 500) list = list.slice(0, 500);
  fs.writeFileSync(FILTERED_FILE, JSON.stringify(list, null, 2));
}

function shouldRunTask(task, isTest = false) {
  if (isTest) return true;
  if (!task.last_time) return true;
  return dayjs(task.last_time).add(task.minutes, "minutes").isBefore(dayjs().tz());
}

function createParser() {
  let requestOptions = {};
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (httpProxy) {
    requestOptions.agent = new HttpsProxyAgent(httpProxy);
  } else if (httpsProxy) {
    requestOptions.agent = new HttpsProxyAgent(httpsProxy);
  }

  return new rssParser({
    timeout: 10000,
    requestOptions,
    headers: RSS_HEADERS,
  });
}

function passKeywordFilter(task, title = "") {
  const lowerTitle = String(title).toLowerCase();

  // 1. 先检查黑名单
  if (task.bad_keyword) {
    const badKeywords = task.bad_keyword.toLowerCase().split(",").map(k => k.trim()).filter(Boolean);
    const badMatched = badKeywords.some((keyword) => lowerTitle.indexOf(keyword) >= 0);
    if (badMatched) {
      return { pass: false, action: "save_local", message: `命中黑名单 "${task.bad_keyword}"，已保存到本地` };
    }
  }

  // 2. 再检查白名单
  // 如果白名单为空，则全部推送到渠道
  if (!task.keyword) {
    return { pass: true };
  }

  // 逗号分隔的关键词
  const keywords = task.keyword.toLowerCase().split(",").map(k => k.trim()).filter(Boolean);
  if (keywords.length === 0) {
    return { pass: true };
  }

  const matched = keywords.some((keyword) => lowerTitle.indexOf(keyword) >= 0);
  if (matched) {
    return { pass: true };
  } else {
    // 没命中白名单，标记为需要保存到本地
    return { pass: false, action: "save_local", message: `未命中白名单 "${task.keyword}"，已保存到本地` };
  }
}

async function sendByKey({ skey, task, last, text, desp, short }) {
  let ret = { code: -1, message: "Bad Key" };

  if (skey.toLowerCase().startsWith("sct")) {
    ret = await sc_send(text, desp, short, String(skey).trim());
  } else if (skey.toLowerCase().startsWith("http")) {
    const form = new FormData();
    form.append("task_id", task.id);
    form.append("task_title", task.title);
    form.append("text", text);
    form.append("title", text);
    form.append("link", last.link);
    form.append("desp", desp);

    try {
      const response = await fetch(skey, {
        method: "POST",
        body: form,
      });
      ret = await response.json();
    } catch (error) {
      ret = { code: 9, message: "webhook " + error };
    }
  } else if (skey.toLowerCase().startsWith("apprise:raw ")) {
    const cmd =
      "apprise " +
      skey.substring(12) +
      ` -t "${text.replace(/"/g, '\\"').replace(/\$/g, "\\$")}" -b "${String(desp || "").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

    ret = { code: 0, message: "sent to apprise" };
    const { exec } = require("child_process");
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
        return;
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`);
        return;
      }
      console.log(`stdout: ${stdout}`);
    });
  } else if (skey.toLowerCase().startsWith("apprise ")) {
    const cmd =
      skey +
      ` -t "${text.replace(/"/g, '\\"').replace(/\$/g, "\\$")}" -b "${desp.replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

    ret = { code: 0, message: "sent to apprise" };
    const { exec } = require("child_process");
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
        return;
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`);
        return;
      }
      console.log(`stdout: ${stdout}`);
    });
  }

  return ret;
}

async function processTask(task, isTest = false) {
  try {
    if (!isTest && !isTaskEnabled(task)) {
      return { success: false, skipped: true, message: "任务已关闭" };
    }

    if (!shouldRunTask(task, isTest)) {
      return { success: false, skipped: true, message: "未到执行时间" };
    }

    const parser = createParser();
    const feed = await parser.parseURL(task.feed);
    if (!feed?.items?.[0]) {
      return { success: false, skipped: true, message: "RSS 无内容" };
    }

    const normalizeContentId = (item) => {
      if (!item) return "";
      const candidates = [item.guid, item.id, item.link, item.isoDate, item.pubDate, item.title];
      for (const value of candidates) {
        const normalized = String(value || "").trim();
        if (normalized) return normalized;
      }
      return "";
    };

    const getTaskSeenSet = (taskObj) => {
      const seen = new Set();

      if (taskObj.last_content) {
        seen.add(String(taskObj.last_content).trim());
      }

      if (Array.isArray(taskObj.last_contents)) {
        for (const value of taskObj.last_contents) {
          const normalized = String(value || "").trim();
          if (normalized) seen.add(normalized);
        }
      }

      return seen;
    };

    const allItems = Array.isArray(feed?.items) ? feed.items : [];
    const currentSeenSet = getTaskSeenSet(task);
    const latestItem = allItems[0] || null;
    const latestContentId = normalizeContentId(latestItem);
    const latestTitle = String(latestItem?.title || "").trim();

    const newItem = allItems.find((item) => {
      const id = normalizeContentId(item);
      if (!id) return false;
      return !currentSeenSet.has(id);
    });

    if (!isTest) {
      const nextSeenSet = new Set(currentSeenSet);
      if (latestContentId) {
        nextSeenSet.add(latestContentId);
      }

      const maxHistory = 20;
      const dedupedLatestIds = [];
      for (const item of allItems) {
        const id = normalizeContentId(item);
        if (!id) continue;
        if (dedupedLatestIds.includes(id)) continue;
        dedupedLatestIds.push(id);
        if (dedupedLatestIds.length >= maxHistory) break;
      }

      task.last_time = dayjs().tz().format("YYYY-MM-DD HH:mm:ss");
      task.last_content = latestContentId || task.last_content || "";
      task.last_contents = dedupedLatestIds;
    }

    const effectiveItem = newItem || (isTest ? latestItem : null);
    if (!effectiveItem) {
      return {
        success: false,
        skipped: true,
        message: `没有新内容（latest=${latestContentId || "empty"}, seen=${currentSeenSet.size}, title=${latestTitle || "N/A"}）`,
      };
    }

    const last = effectiveItem;

    const c = new turndown();
    const hideTitle = parseInt(task.hide_title) > 0;
    const text = hideTitle ? "" : `${last.title || "RSS 更新"}`;
    const short = hideTitle ? "" : `${last.title || ""}`.substring(0, 64);
    const patterns = getRemovePatterns(task);
    const out = applyRemovePatterns(last.content || "", patterns);
    // 构建正文，不再在开头加上 title，因为推送系统的 text 字段通常已经包含了 title
    // 这样可以避免出现“双标题”的问题
    const markdownContent = applyRemovePatterns(c.turndown(out), patterns).replace(/(\n\s*){2,}/g, '\n').trim();
    let desp = `${markdownContent}\n${last.link || ""}`;

    const keywordCheck = passKeywordFilter(task, last.title || "");
    if (!keywordCheck.pass) {
      if (keywordCheck.action === "save_local") {
        const contentId = normalizeContentId(last);
        saveFilteredMessage({
          task_id: task.id,
          task_title: task.title,
          content_id: contentId,
          title: last.title,
          link: last.link,
          content: desp,
        });
      }
      console.log(keywordCheck.message);
      return { success: false, skipped: true, message: keywordCheck.message };
    }

    const keys = String(task.keys || "")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    const uniqueKeys = [...new Set(keys)];

    const sendResults = [];
    for (const skey of uniqueKeys) {
      const ret = await sendByKey({ skey, task, last, text, desp, short });
      console.log("发送结果", ret);
      sendResults.push({ skey, result: ret });
    }

    return { success: true, sendResults };
  } catch (error) {
    console.error("处理任务出错", task.feed, error);
    return { success: false, error: error.message };
  }
}

async function runAllTasks() {
  const tasks = loadTasks();
  let tasksUpdated = false;

  console.log(`[poll] tick start, tasks=${tasks.length}, time=${dayjs().tz().format("YYYY-MM-DD HH:mm:ss")}`);

  const summary = {
    total: tasks.length,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  for (const index in tasks) {
    const task = tasks[index];
    const result = await processTask(task, false);

    if (result?.success) {
      tasks[index] = task;
      tasksUpdated = true;
      summary.success += 1;
    } else if (result?.error) {
      summary.failed += 1;
    } else {
      summary.skipped += 1;
    }
  }

  if (tasksUpdated) {
    saveTasks(tasks);
  }

  return { success: true, summary };
}

async function sc_send(text, desp, short, key) {
  const url = String(key).startsWith("sctp")
    ? `https://${key}.push.ft07.com/send`
    : `https://sctapi.ftqq.com/${key}.send`;

  const form = new FormData();
  form.append("text", text);
  form.append("desp", desp);
  form.append("short", short);

  try {
    const response = await fetch(url, {
      method: "POST",
      body: form,
    });

    const ret = await response.json();
    return ret;
  } catch (error) {
    console.log(error);
    return false;
  }
}

if (require.main === module) {
  runAllTasks()
    .then((ret) => {
      console.log("runAllTasks done", ret.summary);
    })
    .catch((error) => {
      console.error("runAllTasks error", error);
      process.exitCode = 1;
    });
}

module.exports = {
  processTask,
  runAllTasks,
  loadTasks,
  saveTasks,
  isTaskEnabled,
};
