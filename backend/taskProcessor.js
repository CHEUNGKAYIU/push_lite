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
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const DATA_FILE = path.join(__dirname, "data", "tasks.json");
const FILTERED_FILE = path.join(__dirname, "data", "filtered_messages.json");

function loadTasksData() {
  if (!fs.existsSync(DATA_FILE)) return { globalWebhookKeys: [], tasks: [] };

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!raw) return { globalWebhookKeys: [], tasks: [] };

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { globalWebhookKeys: [], tasks: parsed };
    }

    return {
      globalWebhookKeys: Array.isArray(parsed?.globalWebhookKeys) ? parsed.globalWebhookKeys : [],
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
    };
  } catch (error) {
    console.error("读取 tasks.json 失败，已回退为空数组", error);
    return { globalWebhookKeys: [], tasks: [] };
  }
}
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
  return loadTasksData().tasks;
}

function saveTasks(tasks) {
  const data = loadTasksData();
  data.tasks = Array.isArray(tasks) ? tasks : [];
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

let feishuTenantTokenCache = {
  token: "",
  expireAt: 0,
};

function resolveFeishuCredential(input, fallback = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const envAppId = process.env.FEISHU_APP_ID || process.env.APP_ID || process.env.app_id || "";
  const envAppSecret = process.env.FEISHU_APP_SECRET || process.env.APP_SECRET || process.env.app_secret || "";
  const appId = String(raw.app_id || raw.feishu_app_id || fallback.app_id || fallback.feishu_app_id || envAppId || "").trim();
  const appSecret = String(raw.app_secret || raw.feishu_app_secret || fallback.app_secret || fallback.feishu_app_secret || envAppSecret || "").trim();
  return { app_id: appId, app_secret: appSecret };
}

async function getFeishuTenantAccessToken(credentials = {}) {
  const { app_id, app_secret } = resolveFeishuCredential(credentials);
  if (!app_id || !app_secret) {
    throw new Error("缺少飞书 app_id 或 app_secret");
  }

  const now = Date.now();
  if (feishuTenantTokenCache.token && feishuTenantTokenCache.expireAt > now + 5000) {
    return feishuTenantTokenCache.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ app_id, app_secret }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.code !== 0 || !json?.tenant_access_token) {
    throw new Error(json?.msg || `获取 tenant_access_token 失败(${response.status})`);
  }

  const expireSeconds = Number(json.expire || 7200);
  feishuTenantTokenCache = {
    token: String(json.tenant_access_token),
    expireAt: now + Math.max(60, expireSeconds - 60) * 1000,
  };

  return feishuTenantTokenCache.token;
}

function extractImageUrl(item = {}) {
  const direct = [item.enclosure?.url, item.image?.url, item.thumbnail?.url]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direct) return direct;

  const html = String(item.content || item["content:encoded"] || item.summary || "");
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function guessImageExtension(contentType = "", imageUrl = "") {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("bmp")) return ".bmp";
  if (ct.includes("avif")) return ".avif";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";

  const pathname = (() => {
    try {
      return new URL(imageUrl).pathname;
    } catch (e) {
      return "";
    }
  })();
  return path.extname(pathname) || ".jpg";
}

function buildImageRequestUrl(imageUrl = "") {
  const raw = String(imageUrl || "").trim();
  if (!raw) return "";

  // RSS 内容里常见 HTML 实体：&，必须先还原，否则 URL 参数解析异常
  const normalizedRaw = raw.replace(/&/gi, "&");
  if (normalizedRaw !== raw) {
    console.log(`[image.download] 检测到 HTML 实体参数并已还原 original=${raw} normalized=${normalizedRaw}`);
  }

  let u;
  try {
    u = new URL(normalizedRaw);
  } catch (e) {
    return normalizedRaw;
  }

  // 兼容 twitter/pbs 图片链接（有些 name=orig 直接 404，改为 large 成功率更高）
  if (/pbs\.twimg\.com$/i.test(u.hostname)) {
    const format = (u.searchParams.get("format") || "").toLowerCase();
    if (format) {
      u.pathname = `${u.pathname}.${format}`;
      u.searchParams.delete("format");
    }

    const name = (u.searchParams.get("name") || "").toLowerCase();
    if (name === "orig") {
      u.searchParams.set("name", "large");
    }
  }

  return u.toString();
}

async function downloadImageBuffer(imageUrl) {
  const directUrl = String(imageUrl || "").trim();
  const htmlDecodedDirectUrl = directUrl.replace(/&/gi, "&");
  const rewrittenUrl = buildImageRequestUrl(htmlDecodedDirectUrl);
  const candidates = [...new Set([rewrittenUrl, htmlDecodedDirectUrl, directUrl].filter(Boolean))];

  let lastError = null;
  for (const candidate of candidates) {
    const startAt = Date.now();
    console.log(`[image.download] 开始下载图片 url=${candidate}`);

    try {
      const response = await fetch(candidate, {
        method: "GET",
        headers: {
          "User-Agent": RSS_HEADERS["User-Agent"],
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: "https://twitter.com/",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("image/")) {
        throw new Error(`返回内容不是图片 content-type=${contentType || "unknown"}`);
      }

      const buffer = await response.buffer();
      if (!buffer || buffer.length === 0) {
        throw new Error("图片字节为空");
      }

      console.log(`[image.download] 下载成功 url=${candidate} size=${buffer.length} contentType=${contentType} costMs=${Date.now() - startAt}`);
      return { buffer, contentType, finalUrl: candidate };
    } catch (e) {
      lastError = e;
      console.error(`[image.download] 下载失败 url=${candidate} err=${e?.message || e}`);
    }
  }

  throw new Error(`下载图片失败: ${lastError?.message || "未知错误"}`);
}

async function uploadFeishuImage({ imageUrl, credentials }) {
  if (!imageUrl) return { skipped: true, message: "无图片地址" };

  console.log(`[image.token] 开始获取 tenant_access_token imageUrl=${imageUrl}`);
  const token = await getFeishuTenantAccessToken(credentials);
  console.log(`[image.token] 获取 tenant_access_token 成功`);

  const downloaded = await downloadImageBuffer(imageUrl);
  const ext = guessImageExtension(downloaded.contentType, downloaded.finalUrl);
  const filename = `rss_${Date.now()}${ext}`;

  console.log(`[image.upload] 开始上传飞书图片 filename=${filename} contentType=${downloaded.contentType} size=${downloaded.buffer.length}`);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", downloaded.buffer, { filename, contentType: downloaded.contentType || undefined });

  const uploadResponse = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const uploadJson = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || uploadJson?.code !== 0 || !uploadJson?.data?.image_key) {
    throw new Error(uploadJson?.msg || `上传图片失败(${uploadResponse.status})`);
  }

  const imageKey = String(uploadJson.data.image_key || "").trim();
  if (!imageKey) {
    throw new Error("获取 image_key 失败：返回为空");
  }

  console.log(`[image.key] 获取 image_key 成功 image_key=${imageKey}`);
  return { image_key: imageKey };
}

function buildFeishuPostPayload({ task, text, desp, imageKey }) {
  const safeTitle = String(text || task?.title || "RSS 更新").trim() || "RSS 更新";
  const bodyText = String(desp || "").trim() || "RSS 更新";

  const contentRows = [
    [
      {
        tag: "text",
        text: bodyText,
      },
    ],
  ];

  if (String(imageKey || "").trim()) {
    contentRows.push([
      {
        tag: "img",
        image_key: String(imageKey).trim(),
      },
    ]);
  }

  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: safeTitle,
          content: contentRows,
        },
      },
    },
  };
}

async function sendByKey({ skey, task, text, desp, imageKey }) {
  const payload = buildFeishuPostPayload({ task, text, desp, imageKey });

  try {
    const response = await fetch(skey, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const bodyText = await response.text();
    try {
      const bodyJson = JSON.parse(bodyText);
      return { code: response.ok ? 0 : response.status, status: response.status, data: bodyJson };
    } catch (e) {
      return { code: response.ok ? 0 : response.status, status: response.status, data: bodyText };
    }
  } catch (error) {
    return { code: 9, message: "webhook " + error.message };
  }
}

async function processTask(task, isTest = false, options = {}) {
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
    const patterns = getRemovePatterns(task);
    const out = applyRemovePatterns(last.content || "", patterns);
    // 构建正文，不再在开头加上 title，因为推送系统的 text 字段通常已经包含了 title
    // 这样可以避免出现“双标题”的问题
    const markdownContent = applyRemovePatterns(c.turndown(out), patterns).replace(/(\n\s*){2,}/g, '\n').trim();
    let desp = `${markdownContent}\n${last.link || ""}`;

    const credentials = resolveFeishuCredential(options?.credentials, task);
    const imageUrls = [
      ...new Set(
        [extractImageUrl(last)]
          .map((v) => String(v || "").trim())
          .filter(Boolean)
      ),
    ];

    const imageKeys = [];
    if (imageUrls.length > 0) {
      if (credentials.app_id && credentials.app_secret) {
        for (const imageUrl of imageUrls) {
          try {
            const uploaded = await uploadFeishuImage({ imageUrl, credentials });
            const key = String(uploaded?.image_key || "").trim();
            if (key) imageKeys.push(key);
          } catch (e) {
            console.error(`[image.flow] 上传飞书图片失败 imageUrl=${imageUrl} err=${e?.message || e}`);
          }
        }
      } else {
        console.log("检测到图片但未配置飞书 app_id/app_secret，跳过 image_key 转换");
      }
    }

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
      const ret = await sendByKey({ skey, task, last, text, desp, imageKey: imageKeys[0] || "" });
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
  getFeishuTenantAccessToken,
  uploadFeishuImage,
};
