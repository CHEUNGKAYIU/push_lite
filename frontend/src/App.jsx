import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  Plus, 
  Trash2, 
  Edit3, 
  Play, 
  Settings, 
  RefreshCw, 
  ExternalLink,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  X
} from 'lucide-react';
import dayjs from 'dayjs';

const API_BASE = window.location.origin === 'http://localhost:6001' ? 'http://localhost:6002' : '';

const App = () => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminKey, setAdminKey] = useState('');
  const [authInput, setAuthInput] = useState(() => localStorage.getItem('admin_key') || '');
  const [authed, setAuthed] = useState(false);
  const [authChecking, setAuthChecking] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [currentTask, setCurrentTask] = useState(null);
  const [pushKeys, setPushKeys] = useState([]);
  const [globalWebhookKeys, setGlobalWebhookKeys] = useState([]);
  const [keyInput, setKeyInput] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [rssBase, setRssBase] = useState('https://rsshub.app');
  const [togglingTaskId, setTogglingTaskId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const res = await axios.post(`${API_BASE}/task/list`, { key: adminKey });
      setTasks(res.data.result || []);
    } catch (err) {
      console.error('Failed to fetch tasks', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchRssBase = async () => {
    try {
      const res = await axios.get(`${API_BASE}/rss/base`);
      setRssBase(res.data.rss_base);
    } catch (err) {}
  };

  const fetchWebhookKeys = async (currentAdminKey) => {
    const authKey = String(currentAdminKey || adminKey || '').trim();
    if (!authKey) return [];
    try {
      const res = await axios.get(`${API_BASE}/webhook/list`, { params: { key: authKey } });
      const list = Array.isArray(res.data?.result) ? res.data.result : [];
      setGlobalWebhookKeys(list);
      return list;
    } catch (err) {
      console.error('Failed to fetch webhook keys', err);
      return [];
    }
  };

  const verifyKey = async (key) => {
    const inputKey = String(key || '').trim();
    if (!inputKey) {
      setAuthError('请输入 ADMIN KEY');
      return;
    }

    try {
      setAuthChecking(true);
      setAuthError('');
      const res = await axios.post(`${API_BASE}/check`, { key: inputKey });
      if (res?.data?.info !== 'ok') {
        throw new Error(res?.data?.message || '验证失败');
      }

      setAdminKey(inputKey);
      setAuthInput(inputKey);
      setAuthed(true);
      localStorage.setItem('admin_key', inputKey);
      await fetchRssBase();
      await fetchWebhookKeys(inputKey);
      await fetchTasks();
    } catch (err) {
      setAuthed(false);
      setTasks([]);
      setLoading(false);
      setAuthError(err.response?.data?.message || err.message || 'ADMIN KEY 错误');
    } finally {
      setAuthChecking(false);
    }
  };

  useEffect(() => {
    setLoading(false);
    fetchRssBase();

    const savedKey = String(localStorage.getItem('admin_key') || '').trim();
    if (savedKey) {
      verifyKey(savedKey);
    }
  }, []);

  const handleLogout = () => {
    setAdminKey('');
    setAuthInput('');
    localStorage.removeItem('admin_key');
    setAuthed(false);
    setTasks([]);
    setGlobalWebhookKeys([]);
    setShowModal(false);
    setCurrentTask(null);
    setTestResult(null);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除这个任务吗？')) return;
    try {
      await axios.post(`${API_BASE}/task/remove`, { id, key: adminKey });
      fetchTasks();
    } catch (err) {
      alert('删除失败');
    }
  };

  const handleTest = async (task) => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await axios.post(`${API_BASE}/task/test`, {
        ...task,
        key: adminKey,
      });
      setTestResult(res.data.result);
    } catch (err) {
      setTestResult({ success: false, error: '测试请求失败' });
    } finally {
      setTesting(false);
    }
  };

  const isTaskEnabled = (task) => {
    const enabled = parseInt(task?.enabled, 10);
    return Number.isNaN(enabled) ? true : enabled > 0;
  };

  const handleToggle = async (task) => {
    const nextEnabled = isTaskEnabled(task) ? 0 : 1;
    try {
      setTogglingTaskId(task.id);
      await axios.post(`${API_BASE}/task/toggle`, { id: task.id, enabled: nextEnabled, key: adminKey });
      await fetchTasks();
    } catch (err) {
      alert('切换失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setTogglingTaskId(null);
    }
  };

  const fetchLogs = async ({ silent = false } = {}) => {
    if (!adminKey) return;
    if (!silent) setLogsLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/logs`, { params: { key: adminKey } });
      setLogs(Array.isArray(res.data?.result) ? res.data.result : []);
    } catch (err) {
      if (!silent) {
        console.error('Failed to fetch logs', err);
      }
    } finally {
      if (!silent) setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (!authed || !showLogs) return;

    fetchLogs();
    const timer = setInterval(() => {
      fetchLogs({ silent: true });
    }, 2000);

    return () => clearInterval(timer);
  }, [authed, showLogs, adminKey]);

  useEffect(() => {
    if (!testResult) return;
    const timer = setTimeout(() => {
      setTestResult(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [testResult]);

  useEffect(() => {
    if (!showModal) {
      setPushKeys([]);
      setKeyInput('');
      return;
    }

    const nextKeys = String(currentTask?.keys || '')
      .split('\n')
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean);

    setPushKeys(nextKeys);
    setKeyInput('');
  }, [showModal, currentTask]);

  const handleAddGlobalWebhookKey = async () => {
    const nextKey = keyInput.trim();
    if (!nextKey) return;
    if (globalWebhookKeys.includes(nextKey)) {
      setKeyInput('');
      return;
    }

    try {
      const res = await axios.post(`${API_BASE}/webhook/add`, { webhook: nextKey, key: adminKey });
      setGlobalWebhookKeys(Array.isArray(res.data?.list) ? res.data.list : []);
      setKeyInput('');
    } catch (err) {
      alert('添加全局 Webhook Key 失败: ' + (err.response?.data?.message || err.message));
    }
  };

  const handleRemoveGlobalWebhookKey = async (targetKey) => {
    if (!window.confirm('确定要删除这个全局 Webhook Key 吗？')) return;

    try {
      const res = await axios.post(`${API_BASE}/webhook/remove`, { webhook: targetKey, key: adminKey });
      const nextGlobalKeys = Array.isArray(res.data?.list) ? res.data.list : [];
      setGlobalWebhookKeys(nextGlobalKeys);
      setPushKeys((prev) => prev.filter((item) => item !== targetKey));
    } catch (err) {
      alert('删除全局 Webhook Key 失败: ' + (err.response?.data?.message || err.message));
    }
  };

  const handleTogglePushKey = (targetKey) => {
    setPushKeys((prev) => (prev.includes(targetKey) ? prev.filter((item) => item !== targetKey) : [...prev, targetKey]));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const normalizedKeys = pushKeys.map((item) => item.trim()).filter(Boolean);
    if (normalizedKeys.length === 0) {
      alert('请至少添加一个 Webhook Key');
      return;
    }
    data.key = adminKey;
    data.keys = normalizedKeys.join('\n');
    data.hide_title = data.hide_title ? 1 : 0;

    const endpoint = currentTask ? '/task/modify' : '/task/add';
    if (currentTask) data.id = currentTask.id;

    try {
      const res = await axios.post(`${API_BASE}${endpoint}`, data);
      setShowModal(false);
      await fetchTasks();
      if (res?.data?.enabled === 0) {
        alert(res?.data?.warning || 'RSS 检查失败，已自动设置为关闭状态');
      }
    } catch (err) {
      alert('保存失败: ' + (err.response?.data?.message || err.message));
    }
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6">
          <h1 className="text-xl font-bold text-slate-800 mb-2">RSS Push</h1>
          <p className="text-sm text-slate-500 mb-6">请输入 ADMIN KEY 后访问管理页面</p>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await verifyKey(authInput);
            }}
            className="space-y-4"
          >
            <input
              type="password"
              placeholder="ADMIN KEY"
              value={authInput}
              onChange={(e) => setAuthInput(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
            />

            {authError ? (
              <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{authError}</div>
            ) : null}

            <button
              type="submit"
              disabled={authChecking}
              className={`w-full py-3 px-4 rounded-xl font-bold text-white transition-colors ${authChecking ? 'bg-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}
            >
              {authChecking ? '验证中...' : '进入管理页'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
              <RefreshCw size={20} />
            </div>
            <h1 className="text-xl font-bold text-slate-800">RSS Push</h1>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
              <Settings size={14} />
              <span>ADMIN KEY 已验证</span>
            </div>
            <button
              onClick={handleLogout}
              className="text-slate-600 hover:text-slate-800 px-3 py-2 rounded-full text-sm font-medium border border-slate-200 hover:bg-slate-50"
            >
              退出
            </button>
            <button
              onClick={() => { setCurrentTask(null); setShowModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full flex items-center gap-2 text-sm font-medium transition-colors shadow-lg shadow-indigo-200"
            >
              <Plus size={18} />
              <span className="hidden md:inline">新建任务</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 mt-8">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <RefreshCw className="animate-spin text-indigo-600" size={40} />
            <p className="text-slate-500 font-medium">加载中...</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-2xl border-2 border-dashed border-slate-200">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Plus className="text-slate-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-slate-800">还没有任务</h3>
            <p className="text-slate-500 mt-1">点击右上方按钮开始创建一个 RSS 推送任务</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tasks.map(task => (
              <div key={task.id} className={`bg-white rounded-2xl border overflow-hidden transition-all group ${isTaskEnabled(task) ? 'border-slate-200 hover:shadow-xl hover:shadow-slate-200' : 'border-slate-300 opacity-80'}`}>
                <div className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="font-bold text-slate-800 line-clamp-1 flex-1 pr-2" title={task.title}>{task.title}</h3>
                    <div className="flex items-center gap-1 mr-2">
                      <button
                        onClick={() => handleToggle(task)}
                        disabled={togglingTaskId === task.id}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isTaskEnabled(task) ? 'bg-emerald-500' : 'bg-slate-300'} ${togglingTaskId === task.id ? 'opacity-60 cursor-not-allowed' : ''}`}
                        title={isTaskEnabled(task) ? '点击关闭' : '点击开启'}
                      >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${isTaskEnabled(task) ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                    
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 p-2 rounded-lg truncate">
                      <ExternalLink size={14} className="shrink-0" />
                      <span className="truncate">{task.feed}</span>
                    </div>
                    
                    <div className="flex items-center justify-between text-xs text-slate-400 font-medium px-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${isTaskEnabled(task) ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
                        {isTaskEnabled(task) ? `每 ${task.minutes} 分钟检查` : '已关闭，不参与后端轮询'}
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => { setCurrentTask(task); setShowModal(true); }} className="p-2 hover:bg-indigo-50 text-indigo-600 rounded-lg transition-colors"><Edit3 size={16} /></button>
                      <button onClick={() => handleDelete(task.id)} className="p-2 hover:bg-rose-50 text-rose-600 rounded-lg transition-colors"><Trash2 size={16} /></button>
                    </div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-100 p-4 bg-slate-50/50 flex justify-between items-center">
                  <div className="flex gap-2">
                    {task.keyword && <span className="text-[10px] px-2 py-1 bg-blue-100 text-blue-700 rounded-md font-bold">白名单</span>}
                    {task.bad_keyword && <span className="text-[10px] px-2 py-1 bg-slate-200 text-slate-600 rounded-md font-bold">黑名单</span>}
                    {task.hide_title > 0 && <span className="text-[10px] px-2 py-1 bg-rose-100 text-rose-700 rounded-md font-bold">隐藏标题</span>}
                    {task.remove_content && <span className="text-[10px] px-2 py-1 bg-violet-100 text-violet-700 rounded-md font-bold">内容去除</span>}
                  </div>
                  <button 
                    onClick={() => handleTest(task)}
                    className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800"
                  >
                    <Play size={14} fill="currentColor" />
                    立即测试
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Backend Logs */}
        <section className="mt-8 bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowLogs((prev) => !prev)}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
          >
            <div className="text-left">
              <h3 className="text-sm font-bold text-slate-800">后端实时日志</h3>
              <p className="text-xs text-slate-500 mt-0.5">每 2 秒自动刷新，最多显示最近 500 行</p>
            </div>
            <div className="flex items-center gap-3">
              {showLogs && logsLoading ? <RefreshCw className="animate-spin text-indigo-500" size={16} /> : null}
              <ChevronRight
                size={18}
                className={`text-slate-500 transition-transform ${showLogs ? 'rotate-90' : ''}`}
              />
            </div>
          </button>

          {showLogs ? (
            <div className="border-t border-slate-100 p-4 bg-slate-950 text-slate-100">
              <div className="h-72 overflow-y-auto rounded-lg border border-slate-800 p-3 bg-slate-900">
                {logs.length === 0 ? (
                  <p className="text-xs text-slate-400">暂无日志</p>
                ) : (
                  <pre className="text-xs leading-5 whitespace-pre-wrap break-words font-mono">
                    {logs.join('\n')}
                  </pre>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </main>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl w-full max-w-xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-800">{currentTask ? '编辑任务' : '新建任务'}</h2>
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><X size={20} /></button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">RSS 地址</label>
                <input required name="feed" defaultValue={currentTask?.feed} placeholder="https://..." className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">检查间隔 (分钟)</label>
                  <input required type="number" name="minutes" defaultValue={currentTask?.minutes || 30} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none" />
                </div>
                <div className="space-y-2 flex flex-col justify-end">
                   <label className="flex items-center gap-2 cursor-pointer py-1.5 group">
                      <input type="checkbox" name="hide_title" defaultChecked={currentTask?.hide_title > 0} className="w-5 h-5 rounded-md border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                      <span className="text-sm font-bold text-slate-700 group-hover:text-indigo-600">隐藏推送标题</span>
                   </label>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-bold text-slate-700">全局 Webhook Key 列表</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddGlobalWebhookKey();
                      }
                    }}
                    placeholder="https://example.com/webhook"
                    className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleAddGlobalWebhookKey}
                    className="px-4 py-3 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-colors"
                  >
                    添加到全局列表
                  </button>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2 min-h-[84px]">
                  {globalWebhookKeys.length === 0 ? (
                    <p className="text-xs text-slate-400">暂无全局 Webhook Key，请先添加</p>
                  ) : (
                    globalWebhookKeys.map((item, index) => {
                      const checked = pushKeys.includes(item);
                      return (
                        <label key={`${item}-${index}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 cursor-pointer hover:border-indigo-200 transition-colors">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleTogglePushKey(item)}
                            className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="flex-1 break-all font-mono text-xs text-slate-700">{item}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleRemoveGlobalWebhookKey(item);
                            }}
                            className="shrink-0 rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                            title="从全局列表删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="text-xs text-slate-500">先维护全局 Webhook Key 列表，再为当前任务勾选一个或多个推送目标。</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">关键词白名单 (英文逗号分隔，命中则推送，未命中则保存到本地，为空全推)</label>
                  <input name="keyword" defaultValue={currentTask?.keyword} placeholder="a,b,c" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">关键词黑名单 (英文逗号分隔，命中则不推送并保存到本地)</label>
                  <input name="bad_keyword" defaultValue={currentTask?.bad_keyword} placeholder="x,y,z" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">内容去除 (一行一个/逗号分隔，支持原始 HTML 片段或文本；正则用 re: 开头)</label>
                <textarea name="remove_content" rows="3" defaultValue={currentTask?.remove_content} placeholder="<p><strong>@buyticketshk</strong>:</p>" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none font-mono text-xs" />
              </div>

              <div className="pt-4 flex gap-3">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 px-4 border border-slate-200 rounded-xl text-slate-600 font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button type="submit" className="flex-[2] py-3 px-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-colors">保存任务</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Test Result Toast */}
      {(testing || testResult) && (
        <div className="fixed bottom-8 right-8 z-50 w-full max-w-sm">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-bottom-4">
            <div className="p-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/50">
              <h4 className="font-bold text-sm text-slate-700 flex items-center gap-2">
                {testing ? <RefreshCw className="animate-spin text-indigo-500" size={16} /> : <Play size={16} className="text-indigo-500" />}
                测试运行中
              </h4>
              {!testing && <button onClick={() => setTestResult(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>}
            </div>
            <div className="p-5 max-h-60 overflow-y-auto">
              {testing ? (
                <div className="space-y-3">
                  <div className="h-3 w-3/4 bg-slate-100 rounded-full animate-pulse"></div>
                  <div className="h-3 w-1/2 bg-slate-100 rounded-full animate-pulse"></div>
                </div>
              ) : testResult ? (
                <div className="space-y-4">
                  {testResult.success ? (
                    <div className="flex gap-3">
                      <CheckCircle2 className="text-emerald-500 shrink-0" size={20} />
                      <div>
                        <p className="text-sm font-bold text-emerald-800">成功获取内容</p>
                        <div className="mt-2 space-y-2">
                          {testResult.sendResults?.map((r, i) => (
                            <div key={i} className="text-xs bg-slate-50 p-2 rounded border border-slate-100">
                              <span className="font-mono text-[10px] text-slate-400 block mb-1">KEY: {r.skey.substring(0, 10)}...</span>
                              <span className={r.result?.code === 0 || r.result?.success ? 'text-emerald-600' : 'text-rose-600'}>
                                {r.result?.message || (r.result?.success ? '推送成功' : '推送失败')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <AlertCircle className="text-rose-500 shrink-0" size={20} />
                      <div>
                        <p className="text-sm font-bold text-rose-800">测试失败</p>
                        <p className="text-xs text-rose-600 mt-1">{testResult.error || testResult.message}</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-white/80 backdrop-blur border border-slate-200 rounded-full text-[10px] text-slate-400 font-medium flex gap-4">
        <span>RSS Base: {rssBase}</span>
        <span>Version: 3.0 Card Style</span>
      </div>
    </div>
  );
};

export default App;
