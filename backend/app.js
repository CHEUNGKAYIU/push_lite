
const rssParser = require('rss-parser');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Shanghai');

const express = require('express');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { processTask, runAllTasks, getFeishuTenantAccessToken, uploadFeishuImage } = require('./taskProcessor');
const app = express();

const logBuffer = [];
const LOG_MAX_LINES = 500;

function appendLog(message) {
    const line = `[${dayjs().tz().format('YYYY-MM-DD HH:mm:ss')}] ${message}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_MAX_LINES) {
        logBuffer.shift();
    }
}

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    originalLog(...args);
    appendLog(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '));
};

console.error = (...args) => {
    originalError(...args);
    appendLog('[ERROR] ' + args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '));
};

const cors = require('cors');
app.use(cors());

var multer = require('multer');
var forms = multer({limits: { fieldSize: 100 * 1024 * 1024 }});
const bodyParser = require('body-parser')
app.use(bodyParser.json());
app.use(forms.array()); 
app.use(bodyParser.urlencoded({ extended: true }));

// create data folder if not exists
if( !fs.existsSync( path.join(__dirname, 'data') ) ) fs.mkdirSync( path.join(__dirname, 'data') );

function checkApiKey (req, res, next) {
    
    if( process.env.ADMIN_KEY && process.env.ADMIN_KEY != ( req.query.key||req.body.key ))
    return res.json({"code":403,"message":"错误的ADMIN KEY"});
   
    next();
}

function normalizeEnabled(value, defaultValue = 1) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (value === true || value === 'true') return 1;
    if (value === false || value === 'false') return 0;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? defaultValue : (n > 0 ? 1 : 0);
}

function readJsonArray(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getTasksFile() {
    return path.join(__dirname, 'data', 'tasks.json');
}

function loadTasksData() {
    const filePath = getTasksFile();
    if (!fs.existsSync(filePath)) {
        return { globalWebhookKeys: [], tasks: [] };
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) {
            return { globalWebhookKeys: [], tasks: [] };
        }

        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return { globalWebhookKeys: [], tasks: parsed };
        }

        const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        const globalWebhookKeys = Array.isArray(parsed?.globalWebhookKeys) ? parsed.globalWebhookKeys : [];
        return { globalWebhookKeys, tasks };
    } catch (error) {
        console.error('读取 tasks.json 失败，已回退为空数据', error);
        return { globalWebhookKeys: [], tasks: [] };
    }
}

function saveTasksData(data) {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const globalWebhookKeys = [...new Set((Array.isArray(data?.globalWebhookKeys) ? data.globalWebhookKeys : []).map((item) => String(item || '').trim()).filter(Boolean))];
    writeJson(getTasksFile(), { globalWebhookKeys, tasks });
}

function loadWebhookKeys() {
    const { globalWebhookKeys } = loadTasksData();
    return [...new Set(globalWebhookKeys.map((item) => String(item || '').trim()).filter(Boolean))];
}

function saveWebhookKeys(keys) {
    const data = loadTasksData();
    data.globalWebhookKeys = [...new Set((Array.isArray(keys) ? keys : []).map((item) => String(item || '').trim()).filter(Boolean))];
    saveTasksData(data);
}

function loadTasks() {
    return loadTasksData().tasks;
}

function saveTasks(tasks) {
    const data = loadTasksData();
    data.tasks = Array.isArray(tasks) ? tasks : [];
    saveTasksData(data);
}

function normalizeTaskKeys(keys) {
    return String(keys || '')
        .split('\n')
        .flatMap((item) => item.split(','))
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeWebhookValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://open.feishu.cn/open-apis/bot/v2/hook/${raw}`;
}

function ensureTaskWebhookKeys(keys) {
    const selectedKeys = normalizeTaskKeys(keys).map(normalizeWebhookValue).filter(Boolean);
    if (selectedKeys.length === 0) {
        return { ok: false, message: '请至少选择一个 Webhook Key' };
    }

    const globalKeys = loadWebhookKeys().map(normalizeWebhookValue);
    const invalidKeys = selectedKeys.filter((item) => !globalKeys.includes(item));
    if (invalidKeys.length > 0) {
        return { ok: false, message: '所选 Webhook Key 不在全局列表中' };
    }

    return { ok: true, keys: [...new Set(selectedKeys)].join('\n') };
}

// add static files
const buildPath = path.join(__dirname, 'build');
if (fs.existsSync(buildPath)) {
    app.use(express.static(buildPath));
}

app.all("/check",checkApiKey,(req,res)=>{
    res.json({"info":"ok"});
});

app.get('/webhook/list', checkApiKey, (req, res) => {
    res.json({ result: loadWebhookKeys() });
});

app.post('/webhook/add', checkApiKey, (req, res) => {
    const webhook = normalizeWebhookValue(req.body?.webhook);
    if (!webhook) return res.json({ code: 400, message: '参数错误' });

    const nextKeys = [...new Set([...loadWebhookKeys().map(normalizeWebhookValue), webhook])];
    saveWebhookKeys(nextKeys);
    res.json({ result: 'ok', list: nextKeys });
});

app.post('/webhook/remove', checkApiKey, (req, res) => {
    const webhook = normalizeWebhookValue(req.body?.webhook);
    if (!webhook) return res.json({ code: 400, message: '参数错误' });

    const nextKeys = loadWebhookKeys().map(normalizeWebhookValue).filter((item) => item !== webhook);
    saveWebhookKeys(nextKeys);
    res.json({ result: 'ok', list: nextKeys });
});

app.post("/task/add",checkApiKey,async (req,res)=>{
    const { feed, keys, minutes, keyword, bad_keyword, enabled, hide_title, remove_content } = req.body;
    if( !feed || !keys || !minutes ) return res.json({"code":400,"message":"参数错误"});

    const keysCheck = ensureTaskWebhookKeys(keys);
    if (!keysCheck.ok) return res.json({"code":400,"message":keysCheck.message});

    let title = feed;
    let link = "";
    let enabledValue = normalizeEnabled(enabled, 1);
    let hideTitleValue = normalizeEnabled(hide_title, 0);
    let checkFailed = false;
    // 验证 feed ，并获取标题
    try {
        const parser = new rssParser({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
            }
        });
        const site = await parser.parseURL( feed );
        if( site.title ) title = site.title;
        if( site.link ) link = site.link;
        
        
    } catch (error) {
        checkFailed = true;
        enabledValue = 0;
    }
    
    // read tasks.json
    let tasks = loadTasks();

    // gen uiniq id
    const id = Math.random().toString(36).substr(2, 9);
    
    // find exists feed and replace it
    const index = tasks.findIndex( item => item.feed == feed );
    if( index >= 0 ) {
        const oldTask = tasks[index] || {};
        const nextId = oldTask.id || id;
        tasks[index] = {
            ...oldTask,
            id: nextId,
            title,
            link: oldTask.link || link,
            feed,
            keys: keysCheck.keys,
            minutes,
            keyword,
            bad_keyword,
            hide_title: hideTitleValue,
            remove_content: remove_content === undefined ? (oldTask.remove_content || "") : remove_content,
            enabled: enabledValue
        };
    }
    else tasks.push( { id, title, link, feed, keys: keysCheck.keys, minutes, keyword, bad_keyword, hide_title: hideTitleValue, remove_content: remove_content || "", enabled: enabledValue } );

    // unique array by feed
    const unique = [...new Map(tasks.map(item => [item.feed, item])).values()];
    // save tasks to tasks.json
    saveTasks(unique);

    res.json({
        "result":"ok",
        "enabled": enabledValue,
        "warning": checkFailed ? "feed 检查失败，已自动关闭该 RSS" : undefined
    });

});

app.post("/task/modify",checkApiKey,async (req,res)=>{
    const { id, feed, keys, minutes, keyword, bad_keyword, enabled, hide_title, remove_content } = req.body;
    if( !id || !feed || !keys || !minutes ) return res.json({"code":400,"message":"参数错误"});

    const keysCheck = ensureTaskWebhookKeys(keys);
    if (!keysCheck.ok) return res.json({"code":400,"message":keysCheck.message});

    // read tasks.json
    let tasks = loadTasks();

    // find exists feed and replace it
    const index = tasks.findIndex( item => item.id == id );
    if( index >= 0 )
    {
        const old_title = tasks[index].title;
        const old_link = tasks[index].link||"";
        const old_last_time = tasks[index].last_time||"";
        const old_last_content = tasks[index].last_content||"";
        const old_last_contents = tasks[index].last_contents||[];
        const old_remove_content = tasks[index].remove_content||"";
        const old_hide_title = normalizeEnabled(tasks[index].hide_title, 0);
        const old_enabled = normalizeEnabled(tasks[index].enabled, 1);
        const new_enabled = normalizeEnabled(enabled, old_enabled);
        const new_hide_title = normalizeEnabled(hide_title, old_hide_title);
        const new_remove_content = remove_content === undefined ? old_remove_content : remove_content;
        
        tasks[index] = { id, title:old_title,link:old_link,last_time:old_last_time,last_content:old_last_content,last_contents:old_last_contents,feed,keys: keysCheck.keys,minutes, keyword, bad_keyword, hide_title: new_hide_title, remove_content: new_remove_content, enabled: new_enabled};
    }
    else {
        return res.json({"code":404,"message":"任务不存在"});
    }

    // unique array by feed
    const unique = [...new Map(tasks.map(item => [item.feed, item])).values()];
    // save tasks to tasks.json
    saveTasks(unique);

    res.json({"result":"ok"});

});

app.post("/task/remove",checkApiKey,async( req, res )=>{
    let tasks = loadTasks();

    // remove item from tasks by id
    const index = tasks.findIndex( item => item.id == req.body.id );
    if( index >= 0 ) tasks.splice(index,1);
    else return res.json({"code":404,"message":"任务不存在"});

    saveTasks(tasks);

    res.json({"result":"ok"});
});

app.post("/task/detail",checkApiKey,async( req, res )=>{
    let tasks = loadTasks();

    // find item by id
    const item = tasks.find( item => item.id == req.body.id );
    const ret = item ? {"result": { ...item, enabled: normalizeEnabled(item.enabled, 1) }} : { "code":404, "message":"not found" };
    res.json( ret );
});

app.post("/task/list",checkApiKey,async( req, res )=>{
    let tasks = loadTasks();
    const result = tasks.map(item => ({ ...item, enabled: normalizeEnabled(item.enabled, 1) }));
    res.json( {"result": result} );
});

app.post("/task/toggle",checkApiKey,async( req, res )=>{
    const { id, enabled } = req.body;
    if (!id) return res.json({"code":400,"message":"参数错误"});

    let tasks = loadTasks();
    const index = tasks.findIndex(item => item.id == id);
    if (index < 0) return res.json({"code":404,"message":"任务不存在"});

    tasks[index].enabled = normalizeEnabled(enabled, 1);
    saveTasks(tasks);

    res.json({"result":"ok","enabled":tasks[index].enabled});
});

app.post("/task/test", checkApiKey, async (req, res) => {
    const { feed, keys, minutes, keyword, bad_keyword, hide_title, remove_content, app_id, app_secret } = req.body;
    if (!feed || !keys || !minutes) return res.json({ "code": 400, "message": "参数错误" });

    const keysCheck = ensureTaskWebhookKeys(keys);
    if (!keysCheck.ok) return res.json({ "code": 400, "message": keysCheck.message });

    let title = feed;
    let link = "";

    // 验证 feed，并获取标题
    try {
        const parser = new rssParser({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
            }
        });
        const site = await parser.parseURL(feed);
        if (site.title) title = site.title;
        if (site.link) link = site.link;
    } catch (error) {
        console.log(error);
        return res.json({ "error": "检查 feed 错误" });
    }

    // 生成唯一 ID
    const id = Math.random().toString(36).substr(2, 9);

    // 创建任务对象
    const task = { id, title, link, feed, keys: keysCheck.keys, minutes, keyword, bad_keyword, hide_title, remove_content };

    // 调用 processTask，测试模式下 isTest 为 true
    const result = await processTask(task, true, {
        credentials: { app_id, app_secret }
    });

    res.json({ "result": result });
});

app.post('/feishu/token', checkApiKey, async (req, res) => {
    const { app_id, app_secret } = req.body || {};
    if (!app_id || !app_secret) return res.json({ code: 400, message: '缺少 app_id 或 app_secret' });
    try {
        const token = await getFeishuTenantAccessToken({ app_id, app_secret });
        res.json({ code: 0, result: { tenant_access_token: token } });
    } catch (error) {
        res.json({ code: 500, message: error.message || '获取 tenant_access_token 失败' });
    }
});

app.post('/feishu/upload-image', checkApiKey, async (req, res) => {
    const { app_id, app_secret, image_url } = req.body || {};
    if (!app_id || !app_secret || !image_url) return res.json({ code: 400, message: '缺少 app_id/app_secret/image_url' });
    try {
        const result = await uploadFeishuImage({
            imageUrl: image_url,
            credentials: { app_id, app_secret },
        });
        res.json({ code: 0, result });
    } catch (error) {
        res.json({ code: 500, message: error.message || '上传图片失败' });
    }
});

app.get("/rss/base", async( req, res )=> res.json({"rss_base":process.env.RSS_BASE||"https://rsshub.app"}));

app.all("/rss/parse",checkApiKey,async (req,res)=>{
    const { url } = req.body;
    console.log( "url", url );
    try {
        let requestOptions = {};

        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy ;
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy ;

        if (httpProxy) {
            requestOptions.agent = new HttpsProxyAgent(httpProxy);
        }else
        {
            if(httpsProxy) requestOptions.agent = new HttpsProxyAgent(httpsProxy);    
        }
        // console.log( "requestOptions", requestOptions.agent );
        const parser = new rssParser({
            timeout: 10000,
            requestOptions,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
            }
        });
        const site = await parser.parseURL( url );
        const ret = site.items[0]||false;
        res.json( {"result":ret,"title":site.title} );
    } catch (error) {
        console.log( error );
        res.json( {"result":false} );
    }
    
    
});

app.get('/logs', checkApiKey, (req, res) => {
    res.json({ result: logBuffer });
});

app.get('*', function (request, response) {
    const indexPath = path.resolve(__dirname, 'build', 'index.html');
    if (fs.existsSync(indexPath)) {
        response.sendFile(indexPath);
    } else {
        response.status(404).send('Backend is running, but frontend build not found. Please run frontend separately in dev mode.');
    }
});

app.use(function (err, req, res, next) {
    console.error(err);
    res.status(500).send('Internal Serverless Error');
  });
  
  const pollIntervalMs = (parseInt(process.env.POLL_INTERVAL_MS, 10) > 0 ? parseInt(process.env.POLL_INTERVAL_MS, 10) : 60) * 1000;

  app.listen(6002, () => {
    console.log(`Server start on http://localhost:6002`);
    console.log(`[poll] scheduler started, interval=${Math.floor(pollIntervalMs / 1000)}s`);

    runAllTasks()
      .then((ret) => console.log('[poll] initial run done', ret.summary))
      .catch((err) => console.error('[poll] initial run error', err));

    setInterval(() => {
      runAllTasks()
        .then((ret) => console.log('[poll] tick done', ret.summary))
        .catch((err) => console.error('[poll] tick error', err));
    }, pollIntervalMs);
  });
