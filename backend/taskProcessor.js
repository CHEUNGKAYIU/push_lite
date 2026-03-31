const dayjs = require("dayjs");
const rssParser = require("rss-parser");
const turndown = require("turndown");
const Api2d = require("api2d");
const { HttpsProxyAgent } = require("https-proxy-agent");
const fetch = require("cross-fetch");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "tasks.json");
const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
};

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

function shouldRunTask(task, isTest = false) {
  if (isTest) return true;
  if (!task.last_time) return true;
  return dayjs(task.last_time).add(task.minutes, "minutes").isBefore(dayjs());
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

  if (task.keyword) {
    const keywords = task.keyword.toLowerCase().split("|");
    const matched = keywords.some((keyword) => lowerTitle.indexOf(keyword) >= 0);
    if (!matched) {
      return { pass: false, message: `白名单跳过，${task.keyword}` };
    }
  }

  if (task.bad_keyword) {
    const badKeywords = task.bad_keyword.toLowerCase().split("|");
    const matched = badKeywords.some((keyword) => lowerTitle.indexOf(keyword) >= 0);
    if (matched) {
      return { pass: false, message: `黑名单跳过，${task.bad_keyword}` };
    }
  }

  return { pass: true };
}

async function sendByKey({ skey, task, last, text, desp, short }) {
  let ret = { code: -1, message: "Bad Key" };

  if (skey.toLowerCase().startsWith("sct")) {
    ret = await sc_send(text, desp, short, String(skey).trim());
  } else if (skey.toLowerCase().startsWith("http")) {
    const form = new FormData();
    form.append("task_id", task.id);
    form.append("task_title", task.title);
    form.append("text", last.title);
    form.append("title", last.title);
    form.append("link", last.link);
    form.append("desp", last.content);

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
      ` -t "${text.replace(/"/g, '\\"').replace(/\$/g, "\\$")}" -b "${String(last.content || "").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

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
    const last = feed?.items?.[0];

    if (!last) {
      return { success: false, skipped: true, message: "RSS 无内容" };
    }

    const lastContent = last.guid || last.link;
    const oldContent = task.last_content;

    if (!isTest) {
      task.last_time = dayjs().format("YYYY-MM-DD HH:mm:ss");
      task.last_content = lastContent;
    }

    const shouldSend = isTest || (oldContent && oldContent !== lastContent);
    if (!shouldSend) {
      return { success: false, skipped: true, message: "没有新内容" };
    }

    const keywordCheck = passKeywordFilter(task, last.title || "");
    if (!keywordCheck.pass) {
      console.log(keywordCheck.message);
      return { success: false, skipped: true, message: keywordCheck.message };
    }

    const keys = String(task.keys || "")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    const uniqueKeys = [...new Set(keys)];

    const c = new turndown();
    const text = `${last.title || "RSS 更新"}`;
    const short = `${last.title || ""}`.substring(0, 64);
    const out = last.content || "";
    let desp = `${last.title || ""}\n${c.turndown(out)}\n${last.link || ""}`;

    if (last.content && parseInt(task.translate) > 0 && process.env.OPENAI_KEY) {
      const maxLen = parseInt(process.env.TRANSLATE_MAX_LEN) > 10 ? parseInt(process.env.TRANSLATE_MAX_LEN) : 8000;
      const ret0 = await translate(desp.substring(0, maxLen));
      if (ret0 && ret0.result) {
        desp = `${ret0.result}\n\n\n\n---------\n\n\n\n${desp}`;
      }
    }

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

  console.log(`[poll] tick start, tasks=${tasks.length}, time=${new Date().toISOString()}`);

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

async function translate(markdown) {
  const llm = new Api2d(process.env.OPENAI_KEY, process.env.OPENAI_API_BASE);
  const prompt = `
# Task 请将Markdown清理掉样式和广告后翻译为中文

# RULES

1. 不要修改原始Markdown的格式，务必保留其中的图片、链接、视频等格式
1. 去掉输入内容中多余的CSS和HTML标签
1. 去掉原始内容中的广告和推广内容，比如购买会员、下载APP等
1. 专有名词保留，无需翻译

# INPUT

\`\`\`md
${markdown}
\`\`\`

# OUTPUT

翻译结果：`;

  const ret = await llm.completion({
    model: markdown.length > 3000 ? "gpt-3.5-turbo-16k" : "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content: "你是世界一流的翻译家，精通将各国语言翻译为中文。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    stream: true,
    onMessage: (string, char) => {
      process.stdout.write(char);
    },
  });

  if (ret) return { result: ret };
  return false;
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
