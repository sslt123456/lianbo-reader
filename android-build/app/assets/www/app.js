(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const CACHE_KEY = "lianbo.mobile.episode.v1";
  const PY_FILES = ["requests.py", "mobile_backend.py", "cctv.py", "bili.py", "summarize.py", "pipeline.py", "config.json"];

  const state = {
    data: null,
    pyodide: null,
    pyReady: false,
    fetching: false,
    playing: false,
    current: -1,
    autoNext: true,
    rate: 1.0,
    parts: [],
    partIndex: 0,
    cachedAt: 0,
    hlsTried: false,
    currentHls: false,
    fullscreen: false,
    reading: false,
    subtitlesOn: true,
    subtitleCues: [],
    syncOffset: 0,
    activeCues: [],
    audioCueCache: new Map(),
    nativeVadProgress: null,
    alignedCues: null,
    learnMode: false,
    nativePosition: 0,
    nativeDuration: 0,
  };

  const els = {
    splash: $("#splash"),
    splashNote: $("#splashNote"),
    splashBar: $("#splashBar"),
    splashHint: $("#splashHint"),
    app: $("#app"),
    topDate: $("#topDate"),
    refreshBtn: $("#refreshBtn"),
    updateStrip: $("#updateStrip"),
    heroDate: $("#heroDate"),
    heroSource: $("#heroSource"),
    heroHeadline: $("#heroHeadline"),
    heroOverview: $("#heroOverview"),
    heroStats: $("#heroStats"),
    heroTags: $("#heroTags"),
    listenAllBtn: $("#listenAllBtn"),
    jumpHighlightsBtn: $("#jumpHighlightsBtn"),
    highlights: $("#highlights"),
    segmentList: $("#segmentList"),
    segmentCountNote: $("#segmentCountNote"),
    upCards: $("#upCards"),
    linkageCards: $("#linkageCards"),
    linkageSynthesis: $("#linkageSynthesis"),
    editorNote: $("#editorNote"),
    sourceMeta: $("#sourceMeta"),
    voicePanel: $("#voicePanel"),
    voiceStatus: $("#voiceStatus"),
    nowTitle: $("#nowTitle"),
    nowSub: $("#nowSub"),
    progressBar: $("#progressBar"),
    progressNow: $("#progressNow"),
    progressTotal: $("#progressTotal"),
    playBtn: $("#playBtn"),
    playIcon: $("#playIcon"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    autoNextBtn: $("#autoNextBtn"),
    rateBtn: $("#rateBtn"),
    originalNote: $("#ttsNote"),
    playlist: $("#playlist"),
    playlistMeta: $("#playlistMeta"),
    livePlayer: $("#livePlayer"),
    liveEmpty: $("#liveEmpty"),
    liveSubtitle: $("#liveSubtitle"),
    stageFsBtn: $("#stageFsBtn"),
    liveFsBtn: $("#liveFsBtn"),
    syncBtn: $("#syncBtn"),
    vadVideo: $("#vadVideo"),
    syncModal: $("#syncModal"),
    syncSlider: $("#syncSlider"),
    syncValue: $("#syncValue"),
    syncMinusBtn: $("#syncMinusBtn"),
    syncPlusBtn: $("#syncPlusBtn"),
    syncResetBtn: $("#syncResetBtn"),
    closeSyncBtn: $("#closeSyncBtn"),
    learnModeBtn: $("#learnModeBtn"),
    clearLearnBtn: $("#clearLearnBtn"),
    learnStatus: $("#learnStatus"),
    alignServerInput: $("#alignServerInput"),
    alignServerSave: $("#alignServerSave"),
    floatingCloseBtn: $("#floatingCloseBtn"),
    videoModal: $("#videoModal"),
    modalTitle: $("#modalTitle"),
    modalVideo: $("#modalVideo"),
    modalSourceLink: $("#modalSourceLink"),
    modalParts: $("#modalParts"),
    closeVideoBtn: $("#closeVideoBtn"),
    biliModal: $("#biliModal"),
    biliFrame: $("#biliFrame"),
    biliTitle: $("#biliTitle"),
    biliOpenLink: $("#biliOpenLink"),
    biliMeta: $("#biliMeta"),
    closeBiliBtn: $("#closeBiliBtn"),
    toast: $("#toast"),
  };

  let toastTimer = null;
  let nextTimer = null;

  // ------------------------------------------------------------------ utils
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return value || "—";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtClock(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function parseDuration(text) {
    const value = String(text || "").trim();
    if (!value) return 0;
    const parts = value.split(":").map((x) => Number(x));
    if (parts.some((x) => Number.isNaN(x))) return 0;
    return parts.reduce((total, item) => total * 60 + item, 0);
  }
  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3400);
  }
  function setSplash(note, percent) {
    els.splash.hidden = false;
    els.splashNote.textContent = note || "正在加载…";
    if (typeof percent === "number") els.splashBar.style.width = Math.max(0, Math.min(100, percent)) + "%";
  }
  function hideSplash() { els.splash.hidden = true; }
  function showApp() { els.app.hidden = false; hideSplash(); }
  function setUpdateStrip(text, isError) {
    if (!text) { els.updateStrip.hidden = true; return; }
    els.updateStrip.hidden = false;
    els.updateStrip.textContent = text;
    els.updateStrip.classList.toggle("is-error", !!isError);
  }
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.data || !obj.data.segments) return null;
      state.cachedAt = Number(obj.savedAt) || 0;
      return obj;
    } catch (_) { return null; }
  }
  function saveCache(data) {
    try {
      const savedAt = Date.now();
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt, data }));
      state.cachedAt = savedAt;
    } catch (_) { /* ignore quota */ }
  }

  // ------------------------------------------------------------- native bridge
  const hasAndroid = () => !!(window.AndroidBridge && typeof window.AndroidBridge.httpRequest === "function");

  window.nativeHttp = function nativeHttp(method, url, headersJson, body) {
    if (hasAndroid()) {
      return window.AndroidBridge.httpRequest(method, url, headersJson || "{}", body || "");
    }
    // 浏览器开发模式：使用本地 dev_server 的同源代理
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/proxy", false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({ method, url, headers: JSON.parse(headersJson || "{}"), body: body || "" }));
      return xhr.responseText;
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }
  };

  window.updateProgress = function updateProgress(message) {
    window.__pyProgress = String(message || "");
    if (!els.splash.hidden) els.splashNote.textContent = String(message || "");
    document.title = "联播夜读 · " + String(message || "");
  };

  // ------------------------------------------------------------- B站原声定位
  // B 站没有提供公开字幕/章节时间码；按视频标题、简介中的话题顺序估算话题在原视频中的位置。
  // 这是“原视频原声切片”的起点，不是 TTS，也不声称是精确字幕时间轴。
  function bvidFrom(url) {
    const m = String(url || "").match(/(BV[0-9A-Za-z]{8,})/);
    return m ? m[1] : "";
  }
  function biliPageUrl(url, start) {
    const bvid = bvidFrom(url);
    const base = bvid ? `https://www.bilibili.com/video/${bvid}` : String(url || "https://www.bilibili.com/");
    const t = Math.max(0, Math.round(Number(start) || 0));
    return `${base}${base.includes("?") ? "&" : "?"}t=${t}`;
  }
  function biliEmbedUrl(bvid, start) {
    const t = Math.max(0, Math.round(Number(start) || 0));
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}`
      + `&autoplay=1&danmaku=0&high_quality=1&t=${t}`;
  }
  function videoTopics(video) {
    const title = String(video && video.title || "");
    const tail = title.includes("：") ? title.split("：").slice(1).join("：") : title;
    let topics = tail.split(/[、,，;；|/\s]+/).map((x) => x.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+|[^\u4e00-\u9fa5A-Za-z0-9]+$/g, "")).filter((x) => x.length >= 2);
    if (topics.length < 2) {
      topics = String(video && video.desc || "")
        .split(/[\n。；;]+/).map((x) => x.trim()).filter((x) => x.length >= 4);
    }
    return topics;
  }
  function estimateClipStart(video, terms) {
    if (!video) return 0;
    const total = parseDuration(video.duration);
    if (!total) return 0;
    const topics = videoTopics(video);
    const cleanTerms = (terms || []).map((x) => String(x || "").trim()).filter((x) => x.length >= 2);
    let found = -1;
    for (const term of cleanTerms) {
      for (let i = 0; i < topics.length; i += 1) {
        if (topics[i].includes(term) || term.includes(topics[i])) { found = i; break; }
      }
      if (found >= 0) break;
    }
    if (found < 0) {
      // 标题/简介里直接出现的词，按字符位置做粗略比例
      const haystack = `${video.title || ""}\n${video.desc || ""}`;
      for (const term of cleanTerms) {
        const pos = haystack.indexOf(term);
        if (pos >= 0) {
          found = (pos / Math.max(1, haystack.length)) * Math.max(1, topics.length);
          break;
        }
      }
    }
    if (found < 0) return 0;
    const ratio = (Math.max(0, found) + 0.5) / Math.max(1, topics.length);
    // 留出片头和片尾，估算只用于“从相关话题开始播放”
    return Math.max(0, Math.round(total * Math.min(0.9, ratio * 0.86)));
  }
  function findUpVideo(data, bvid) {
    for (const up of data.ups || []) {
      for (const video of up.selected || []) {
        if (video.bvid === bvid) return { up, video };
      }
    }
    return null;
  }
  function takeClip(data, take) {
    const bvid = take.bvid || bvidFrom(take.url);
    if (!bvid) return { bvid: "", start: 0, label: "0:00", url: take.url || "" };
    const found = findUpVideo(data, bvid);
    const video = found ? found.video : { title: take.video_title || "", desc: "", duration: take.duration || "" };
    const terms = (take.matched_terms || []).concat([take.quote || ""]).filter(Boolean);
    const start = estimateClipStart(video, terms);
    return { bvid, start, label: fmtClock(start), url: take.url || video.url || "" };
  }
  function upClip(data, up, video) {
    let terms = [];
    let takeUrl = video.url || up.url || "";
    for (const seg of data.segments || []) {
      for (const take of seg.takes || []) {
        if ((take.bvid || bvidFrom(take.url)) === video.bvid) {
          terms = (take.matched_terms || []).concat([take.quote || ""]);
          takeUrl = take.url || takeUrl;
          break;
        }
      }
      if (terms.length) break;
    }
    const start = estimateClipStart(video, terms);
    return { start, label: fmtClock(start), url: takeUrl };
  }

  // ------------------------------------------------------------------ engine
  function boot() {
    bindEvents();
    const cached = loadCache();
    if (cached) {
      state.data = cached.data;
      render(cached.data);
      showApp();
      setUpdateStrip(`当前显示本地缓存 · ${fmtDate(state.cachedAt)} · 点右上角更新今日简报`);
      if (!state.data.segments || !state.data.segments.length) {
        setUpdateStrip("缓存内容不完整，请点击右上角更新", true);
      }
    } else {
      setSplash("正在启动本地新闻引擎…", 4);
      refresh({ firstRun: true });
    }
  }

  async function ensureEngine() {
    if (state.pyReady && state.pyodide) return;
    if (typeof loadPyodide !== "function") throw new Error("Pyodide 未加载，请重新打开应用");
    setSplash("正在加载本地新闻引擎（约 20–40 秒）…", 8);
    await new Promise((r) => setTimeout(r, 40));
    const py = await loadPyodide({ indexURL: new URL("/pyodide/", location.href).href });
    state.pyodide = py;
    setSplash("正在写入新闻处理模块…", 22);
    const appDir = "/home/pyodide/app";
    py.FS.mkdirTree(appDir);
    for (const name of PY_FILES) {
      const res = await fetch("/py/" + name, { cache: "no-cache" });
      if (!res.ok) throw new Error("缺少模块：" + name);
      const text = await res.text();
      py.FS.writeFile(appDir + "/" + name, text);
    }
    setSplash("正在解压中文分词与网页解析组件…", 34);
    const zipRes = await fetch("/vendor.zip", { cache: "no-cache" });
    if (!zipRes.ok) throw new Error("缺少依赖组件 vendor.zip");
    const zipBuf = await zipRes.arrayBuffer();
    py.FS.writeFile(appDir + "/vendor.zip", new Uint8Array(zipBuf));
    setSplash("正在校验新闻引擎…", 46);
    py.runPython(`
import sys
sys.path.insert(0, '/home/pyodide/app')
import mobile_backend
mobile_backend.build_and_check()
`);
    state.pyReady = true;
  }

  function fetchLatest() {
    if (!state.pyodide) throw new Error("新闻引擎尚未加载");
    const raw = state.pyodide.runPython("mobile_backend.fetch_episode('', True)");
    let payload;
    try { payload = JSON.parse(String(raw)); } catch (err) {
      throw new Error("解析简报数据失败：" + err.message);
    }
    if (!payload || payload.ok === false || payload.error) {
      throw new Error(payload && payload.error ? payload.error : "抓取简报失败");
    }
    return payload;
  }

  async function refresh(options) {
    if (state.fetching) return;
    const firstRun = !!(options && options.firstRun);
    state.fetching = true;
    els.refreshBtn.classList.add("is-loading");
    setUpdateStrip("正在更新今日简报…");
    try {
      await ensureEngine();
      setSplash("正在抓取《新闻联播》与 UP 主内容…", 58);
      await new Promise((r) => setTimeout(r, 30));
      const data = fetchLatest();
      setSplash("正在生成版面…", 94);
      state.data = data;
      saveCache(data);
      render(data);
      showApp();
      setUpdateStrip(`已更新 · ${fmtDate(Date.now())} · 本期 ${data.date || ""}`);
      if (!firstRun) showToast("今日简报已更新");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (firstRun || !state.data) {
        els.splash.hidden = false;
        els.splashNote.textContent = "加载失败：" + message;
        els.splashHint.innerHTML = '<button id="retrySplash" style="margin-top:6px;min-height:34px;padding:4px 12px;border:1px solid rgba(30,36,43,.2);border-radius:6px;background:#fffdf8;color:#b31722">重试</button>';
        const retry = $("#retrySplash");
        if (retry) retry.onclick = () => { els.splashHint.textContent = "首次启动需要加载本地新闻引擎，约 20–40 秒"; refresh({ firstRun: true }); };
      } else {
        hideSplash();
        setUpdateStrip("更新失败：" + message + "（继续显示本地缓存）", true);
        showToast("更新失败，已保留本地缓存");
      }
    } finally {
      state.fetching = false;
      els.refreshBtn.classList.remove("is-loading");
    }
  }

  // ------------------------------------------------------------------ render
  function render(data) {
    if (!data) return;
    els.topDate.textContent = data.date || "—";
    els.heroDate.textContent = data.display_date || data.date || "";
    els.heroSource.textContent = `CCTV-1 · 19:00 · 生成于 ${fmtDate(data.generated_at || Date.now())}`;
    els.heroHeadline.textContent = data.headline || "今晚的《新闻联播》简报";
    els.heroOverview.textContent = data.overview || "";
    const stats = data.stats || {};
    els.heroStats.innerHTML = [
      [stats.segment_count || (data.segments || []).length, "条分条"],
      [stats.duration || "", "全程"],
      [stats.up_count || (data.ups || []).length, "位UP联动"],
      [stats.source_video_count || (data.segments || []).length, "段原片"],
    ].map(([value, label]) => value ? `<span class="hero-stat"><b>${esc(value)}</b>${esc(label)}</span>` : "").join("");
    els.heroTags.innerHTML = (data.tags || []).slice(0, 9).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("");
    renderHighlights(data);
    renderLinkage(data);
    renderSegments(data);
    renderUps(data);
    renderPlaylist(data);
    els.editorNote.textContent = data.editor_note || "";
    const sources = data.sources || {};
    const cctv = sources.cctv || {};
    const fetched = cctv.fetched_at ? fmtDate(cctv.fetched_at) : fmtDate(data.generated_at || Date.now());
    els.sourceMeta.textContent = `央视网抓取 ${fetched} · 报告生成 ${fmtDate(data.generated_at || Date.now())}`;
    els.segmentCountNote.textContent = `共 ${(data.segments || []).length} 条 · 点击展开文字稿`;
    els.playlistMeta.textContent = `${(data.segments || []).length} 段`;
    updatePlayerUI();
  }

  function renderHighlights(data) {
    const list = (data.segments || []).slice(0, 3);
    els.highlights.innerHTML = list.map((seg, idx) => {
      const summary = seg.summary || seg.brief_text || "";
      return `<article class="highlight-card">
        <div class="highlight-top"><span class="highlight-no">重点 ${String(idx + 1).padStart(2, "0")}</span><span class="highlight-cat">${esc(seg.category || "综合")}</span><span>${esc(seg.duration || "")}</span></div>
        <h3>${esc(seg.title || "")}</h3>
        <p>${esc(summary)}</p>
        <div class="highlight-actions">
          <span class="highlight-link">第 ${idx + 1} 条</span>
          <button class="play-text-btn" type="button" data-action="play" data-index="${idx}">▶ 看原片</button>
        </div>
      </article>`;
    }).join("");
  }

  function renderSegments(data) {
    const segments = data.segments || [];
    els.segmentList.innerHTML = segments.map((seg, idx) => {
      const tags = (seg.tags || []).slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join("");
      const takes = (seg.takes || []).slice(0, 2).map((take) => {
        const clip = takeClip(data, take);
        const bvid = clip.bvid || bvidFrom(take.url);
        const title = take.video_title || "";
        if (!bvid) {
          return `<div class="segment-takes">UP 联动 · ${esc(take.up_name || "")}：「${esc(take.quote || "")}」</div>`;
        }
        return `<div class="segment-takes">
          <button class="take-play" type="button" data-action="bili" data-bvid="${esc(bvid)}" data-start="${clip.start}" data-title="${esc(title)}" data-url="${esc(take.url || "")}">▶ 原声片段 ${esc(clip.label)}</button>
          <a class="take-quote" href="${esc(biliPageUrl(take.url || "", clip.start))}" target="_blank" rel="noopener">UP · ${esc(take.up_name || "")}：「${esc(take.quote || "")}」↗</a>
        </div>`;
      }).join("");
      const transcript = (seg.paragraphs && seg.paragraphs.length ? seg.paragraphs : [seg.transcript || ""])
        .filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("");
      return `<article class="segment-card" id="seg-${idx}" data-index="${idx}">
        <div class="segment-head">
          <span class="segment-no">${String(idx + 1).padStart(2, "0")}</span>
          <div>
            <h3 class="segment-title">${esc(seg.title || "")}</h3>
            <div class="segment-meta"><span>${esc(seg.duration || "")}</span><span>${esc(seg.category || "")}</span>${tags ? `<span>${tags}</span>` : ""}</div>
          </div>
        </div>
        <div class="segment-body">
          <p class="segment-summary">${esc(seg.summary || seg.brief_text || "")}</p>
          ${takes}
        </div>
        <div class="segment-actions">
          <button class="segment-action is-primary" type="button" data-action="play" data-index="${idx}">▶ 播放原片</button>
          <button class="segment-action" type="button" data-action="fullscreen" data-index="${idx}">全屏原片</button>
          <button class="segment-action" type="button" data-action="expand" data-index="${idx}">文字稿</button>
          ${seg.url ? `<a class="segment-action" href="${esc(seg.url)}" target="_blank" rel="noopener">央视页 ↗</a>` : ""}
        </div>
        <div class="segment-transcript" id="transcript-${idx}" hidden>${transcript}</div>
      </article>`;
    }).join("");
  }

  function renderLinkage(data) {
    const items = (data.linkage && data.linkage.items) || [];
    els.linkageCards.innerHTML = items.map((item) => {
      const accent = /^#[0-9a-fA-F]{3,8}$/.test(item.accent || "") ? item.accent : "#b31722";
      return `<article class="linkage-card" style="--accent:${accent}">
        <div class="linkage-top"><span class="linkage-speaker">${esc(item.speaker || "")}</span><span class="linkage-role">${esc(item.role || "")}</span></div>
        <p>${esc(item.text || "")}</p>
        ${item.source_url ? `<a class="linkage-source" href="${esc(item.source_url)}" target="_blank" rel="noopener">${esc(item.source_label || "查看原文")} ↗</a>` : ""}
      </article>`;
    }).join("");
    const synthesis = (data.linkage && data.linkage.synthesis) || "";
    els.linkageSynthesis.hidden = !synthesis;
    els.linkageSynthesis.textContent = synthesis;
  }

  function renderUps(data) {
    const ups = data.ups || [];
    els.upCards.innerHTML = ups.map((up) => {
      const video = (up.selected || [])[0];
      if (!video) {
        return `<article class="up-card"><div class="up-body"><div class="up-name"><b>${esc(up.name || "")}</b><i></i><span>${esc(up.role || "")}</span></div><p class="up-title">暂时没有抓到该 UP 的最新视频。</p><div class="up-meta">${esc(up.error || "下次更新时会重试")}</div></div></article>`;
      }
      const clip = upClip(data, up, video);
      return `<article class="up-card">
        ${video.cover ? `<img class="up-cover" src="${esc(video.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="up-cover"></span>`}
        <div class="up-body">
          <div class="up-name"><b>${esc(up.name || "")}</b><i></i><span>${esc(up.role || "")}</span></div>
          <a class="up-title" href="${esc(biliPageUrl(video.url || up.url || "", clip.start))}" target="_blank" rel="noopener">${esc(video.title || "")}</a>
          <div class="up-meta">${esc(video.pubdate_text || "")} · ${esc(video.duration || "")} · 原声从 ${esc(clip.label)} 起</div>
          <div class="up-actions">
            <button class="up-action" type="button" data-action="bili" data-bvid="${esc(video.bvid || "")}" data-start="${clip.start}" data-title="${esc(video.title || "")}" data-url="${esc(video.url || up.url || "")}">▶ 原视频原声</button>
            <a class="up-action" href="${esc(biliPageUrl(video.url || up.url || "", clip.start))}" target="_blank" rel="noopener">B站打开 ↗</a>
          </div>
        </div>
      </article>`;
    }).join("") + `<p class="up-note">B 站没有公开的字幕/章节时间码，原视频原声的播放起点是按标题、简介中的话题顺序估算的参考位置；打开后可在 B 站播放器里拖动进度条精确定位。文字均已链接到对应原视频。</p>`;
  }

  function renderPlaylist(data) {
    const segments = data.segments || [];
    els.playlist.innerHTML = segments.map((seg, idx) => `<div class="track" data-index="${idx}">
      <span class="track-no">${String(idx + 1).padStart(2, "0")}</span>
      <div><div class="track-title">${esc(seg.title || "")}</div><div class="track-meta">${esc(seg.duration || "")} · 央视原片原声</div></div>
      <button class="track-play" type="button" aria-label="播放">▶</button>
    </div>`).join("");
  }

  // ------------------------------------------------------------------ player
  function segmentAt(index) {
    return state.data && state.data.segments ? state.data.segments[index] : null;
  }
  function highQualityHls(url) {
    const value = String(url || "");
    if (!value) return "";
    // CCTV 的 main.m3u8 是自适应清单，WebView/VideoView 可能选到 480/640。
    // 直接换成 1200 档（1280x720）清单，保证全屏清晰度。
    if (value.indexOf("/hls/main/") >= 0) {
      return value.replace("/hls/main/", "/hls/1200/")
        .replace(/\/main\.m3u8(\?|$)/, "/1200.m3u8$1");
    }
    return value;
  }
  function liveSource(seg) {
    const video = (seg && seg.video) || {};
    const parts = Array.isArray(video.parts) ? video.parts.filter(Boolean) : [];
    const hls = highQualityHls(video.hls || "");
    return {
      src: hls || parts[0] || video.mp4 || "",
      parts,
      hls,
    };
  }
  const SYNC_OFFSET_KEY = "lianbo.sync.offset.v2";

  function loadSyncOffset() {
    try {
      const value = Number(localStorage.getItem(SYNC_OFFSET_KEY));
      if (Number.isFinite(value)) state.syncOffset = Math.max(-2, Math.min(2, value));
    } catch (_) { /* noop */ }
  }

  function formatSyncOffset(value) {
    if (Math.abs(value) < 0.05) return "0.0s";
    return `${value > 0 ? "延后 " : "提前 "}${Math.abs(value).toFixed(1)}s`;
  }

  function applySyncUI() {
    if (els.syncSlider) els.syncSlider.value = String(Math.round(state.syncOffset * 10));
    if (els.syncValue) els.syncValue.textContent = formatSyncOffset(state.syncOffset);
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.setSubtitleOffset === "function") {
        window.AndroidBridge.setSubtitleOffset(state.syncOffset);
      }
    } catch (_) { /* noop */ }
  }

  function setSyncOffset(value) {
    state.syncOffset = Math.max(-2, Math.min(2, Math.round(value * 10) / 10));
    try {
      localStorage.removeItem("lianbo.sync.offset.v1");
      localStorage.setItem(SYNC_OFFSET_KEY, String(state.syncOffset));
    } catch (_) { /* noop */ }
    applySyncUI();
    renderLiveSubtitle();
    if (readingOverlay && typeof onNativeVideoTime === "function") {
      const video = els.livePlayer;
      if (state.fullscreen) renderSubtitle();
    }
  }

  function openSyncModal() {
    if (!els.syncModal) return;
    els.syncModal.hidden = false;
    applySyncUI();
  }

  function closeSyncModal() {
    if (els.syncModal) els.syncModal.hidden = true;
  }

  function syncAdjustedFraction(fraction) {
    const offsetFraction = state.syncOffset / Math.max(1, Number(els.livePlayer?.duration) || 1);
    return Math.max(0, Math.min(0.9999, fraction - offsetFraction));
  }

  const LEARNING_KEY = "lianbo.learning.v1.";

  function learningKey(seg) {
    const source = (seg?.video?.parts || [])[0] || seg?.video?.mp4 || seg?.url || "";
    return LEARNING_KEY + String(seg?.id || "") + "." + String(source).slice(-80);
  }

  function readLearning(seg) {
    try {
      const raw = localStorage.getItem(learningKey(seg));
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.anchors)) return data;
    } catch (_) { /* noop */ }
    return { anchors: [] };
  }

  function writeLearning(seg, data) {
    try { localStorage.setItem(learningKey(seg), JSON.stringify(data)); } catch (_) { /* noop */ }
  }

  function baseCuesFor(seg) {
    return seg && seg._alignedCues && seg._alignedCues.length ? seg._alignedCues : getSegmentCues(seg);
  }

  function applyLearningToCues(baseCues, seg) {
    const anchors = readLearning(seg).anchors
      .filter((a) => Number.isFinite(Number(a.cueIndex)) && Number.isFinite(Number(a.timeSec)))
      .map((a) => ({ cueIndex: Math.max(0, Math.round(Number(a.cueIndex))), timeSec: Number(a.timeSec) }))
      .filter((a) => a.cueIndex < baseCues.length);
    if (!anchors.length) return baseCues;
    const duration = parseDurationSeconds(seg?.duration) || 0;
    if (!duration) return baseCues;
    const points = [];
    for (const anchor of anchors) {
      const baseStart = (Number(baseCues[anchor.cueIndex].start) || 0) * duration;
      const index = anchor.cueIndex;
      const delta = anchor.timeSec - baseStart;
      const existing = points.find((p) => p.index === index);
      if (existing) existing.delta = (existing.delta + delta) / 2;
      else points.push({ index, delta });
    }
    points.sort((a, b) => a.index - b.index);
    const deltaAt = (index) => {
      if (points.length === 1) return points[0].delta;
      if (index <= points[0].index) return points[0].delta;
      if (index >= points[points.length - 1].index) return points[points.length - 1].delta;
      for (let i = 1; i < points.length; i++) {
        if (index <= points[i].index) {
          const left = points[i - 1], right = points[i];
          return left.delta + (right.delta - left.delta) * ((index - left.index) / Math.max(1, right.index - left.index));
        }
      }
      return 0;
    };
    const starts = baseCues.map((cue, index) => Math.max(0, Math.min(duration - 0.001, (Number(cue.start) || 0) * duration + deltaAt(index))));
    for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 0.001);
    for (let i = starts.length - 1; i >= 0; i--) starts[i] = Math.min(starts[i], duration - 0.001 * (starts.length - i));
    return baseCues.map((cue, index) => ({
      ...cue,
      start: starts[index] / duration,
      end: (index + 1 < starts.length ? starts[index + 1] : duration) / duration,
    }));
  }

  function currentAudioSeconds() {
    if (state.reading || state.fullscreen) return Number(state.nativePosition) || 0;
    return Number(els.livePlayer?.currentTime) || 0;
  }

  function updateLearnUI(seg) {
    const target = seg || segmentAt(state.current);
    const anchors = target ? readLearning(target).anchors : [];
    if (els.learnStatus) els.learnStatus.textContent = anchors.length ? `已学习 ${anchors.length} 处` : "";
    document.querySelectorAll("[data-learn-toggle]").forEach((btn) => btn.classList.toggle("is-on", state.learnMode));
    if (els.learnModeBtn) {
      els.learnModeBtn.classList.toggle("is-on", state.learnMode);
      els.learnModeBtn.textContent = state.learnMode ? "取消点句" : "点句校准";
    }
    document.body.classList.toggle("learning-mode", state.learnMode);
  }

  function closeLearnMode() {
    state.learnMode = false;
    updateLearnUI();
  }

  function toggleLearnMode() {
    const seg = segmentAt(state.current);
    if (!seg || (!state.reading && !state.fullscreen)) {
      showToast("先打开文字稿，再点句校准");
      return;
    }
    state.learnMode = !state.learnMode;
    closeSyncModal();
    updateLearnUI(seg);
    if (state.learnMode) showToast("在文字稿里点一下音频正在读的句子（最好在句子刚开头时点）");
  }

  function applyLearningNow(seg) {
    if (!seg) return;
    state.activeCues = applyLearningToCues(baseCuesFor(seg), seg);
    state.alignedCues = seg._alignedCues || null;
    state.nativeVadProgress = null;
    stopNativeVad();
    if (state.reading || state.fullscreen) sendNativeCueTimeline(state.activeCues);
    if (readingOverlay) window.onNativeVideoTime(state.nativePosition, state.nativeDuration, true, false);
    updateLearnUI(seg);
  }

  function learnCueAt(seg, cueIndex, timeSec) {
    const data = readLearning(seg);
    const existing = data.anchors.find((a) => Math.round(Number(a.cueIndex)) === cueIndex);
    if (existing) {
      const count = Math.max(1, Number(existing.count) || 1);
      existing.timeSec = (Number(existing.timeSec) * count + timeSec) / (count + 1);
      existing.count = count + 1;
    } else {
      data.anchors.push({ cueIndex, timeSec, count: 1 });
    }
    data.updatedAt = Date.now();
    writeLearning(seg, data);
    applyLearningNow(seg);
    closeLearnMode();
    showToast(`已学习：第 ${cueIndex + 1} 句`);
  }

  function resetLearning(seg) {
    if (!seg) return;
    try { localStorage.removeItem(learningKey(seg)); } catch (_) { /* noop */ }
    applyLearningNow(seg);
    showToast("已清除本段点句校准");
  }

  function cueIndexAt(cues, fraction) {
    if (!cues || !cues.length) return -1;
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fraction < cues[mid].start) hi = mid - 1;
      else if (fraction >= cues[mid].end) lo = mid + 1;
      else return mid;
    }
    return lo > 0 ? lo - 1 : 0;
  }

  function renderLiveSubtitle() {
    const el = els.liveSubtitle;
    const seg = segmentAt(state.current);
    if (!el || !seg || !els.livePlayer || els.livePlayer.paused) { if (el) el.textContent = ""; return; }
    const cues = state.activeCues && state.activeCues.length ? state.activeCues : getSegmentCues(seg);
    if (!cues.length) { el.textContent = ""; return; }
    const duration = Number(els.livePlayer.duration) || 0;
    if (!duration) { el.textContent = ""; return; }
    const fraction = syncAdjustedFraction((Number(els.livePlayer.currentTime) || 0) / duration);
    let active = cues.find((cue) => fraction >= cue.start && fraction < cue.end);
    if (!active && fraction >= cues[cues.length - 1].start) active = cues[cues.length - 1];
    el.textContent = active ? active.text : "";
  }

  function setProgress(current, total) {
    const pct = total ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
    els.progressBar.style.width = pct + "%";
    els.progressNow.textContent = fmtClock(current || 0);
    els.progressTotal.textContent = total ? fmtClock(total) : "—";
  }
  function updatePlayerUI() {
    const seg = segmentAt(state.current);
    const video = els.livePlayer;
    const playing = !!(video && !video.paused && !video.ended && state.current >= 0);
    state.playing = playing;
    if (seg) {
      els.nowTitle.textContent = seg.title || "";
      const offset = seg.offset && seg.offset.start ? ` · 全片 ${seg.offset.start}${seg.offset.end ? "–" + seg.offset.end : ""}` : "";
      els.nowSub.textContent = `央视原片原声 · ${seg.duration || ""}${offset}`;
    }
    els.playIcon.textContent = playing ? "❚❚" : "▶";
    els.voiceStatus.textContent = playing ? "播放中" : "待播放";
    els.voiceStatus.classList.toggle("is-playing", playing);
    els.playlist.querySelectorAll(".track").forEach((el) => {
      const idx = Number(el.dataset.index);
      el.classList.toggle("is-active", idx === state.current);
      const btn = el.querySelector(".track-play");
      if (btn) btn.textContent = playing && idx === state.current ? "❚❚" : "▶";
    });
    els.autoNextBtn.classList.toggle("is-on", state.autoNext);
    els.rateBtn.textContent = state.rate.toFixed(2).replace(/0$/, "") + "×";
    els.originalNote.textContent = "此处播放央视《新闻联播》原片视频与原声，不含任何 TTS 合成语音。";
    if (video) {
      const total = Number(video.duration) || 0;
      const current = Number(video.currentTime) || 0;
      if (total) setProgress(current, total);
    }
  }

  function loadLiveSource(src, poster) {
    const video = els.livePlayer;
    if (!src) {
      els.liveEmpty.hidden = false;
      return false;
    }
    els.liveEmpty.hidden = true;
    video.muted = false;
    video.volume = 1;
    video.poster = poster || "";
    video.src = src;
    video.load();
    return true;
  }

  function startSegment(index) {
    const seg = segmentAt(index);
    if (!seg) return;
    closeBili();
    closeVideo();
    clearTimeout(nextTimer);
    const source = liveSource(seg);
    state.current = index;
    state.parts = source.parts;
    state.partIndex = 0;
    state.hlsTried = false;
    state.currentHls = !!source.hls;
    const video = els.livePlayer;
    try { video.pause(); } catch (_) { /* noop */ }
    if (!source.src) {
      els.liveEmpty.hidden = false;
      showToast("这一条的原片地址暂不可用，可点央视页观看");
      if (state.fullscreen) exitFullscreen();
      updatePlayerUI();
      return;
    }
    state.alignedCues = seg._alignedCues || null;
    state.activeCues = applyLearningToCues(baseCuesFor(seg), seg);
    loadLiveSource(source.src, seg.image || "");
    video.playbackRate = state.rate;
    els.nowTitle.textContent = seg.title || "";
    const offset = seg.offset && seg.offset.start ? ` · 全片 ${seg.offset.start}${seg.offset.end ? "–" + seg.offset.end : ""}` : "";
    els.nowSub.textContent = `央视原片原声 · ${seg.duration || ""}${offset}`;
    setProgress(0, 0);
    video.play().catch(() => {
      showToast("点击播放键继续播放原片");
    });
    if (state.fullscreen) {
      updateFullscreenMeta();
      buildSubtitleCues();
      renderSubtitle();
    } else if (state.reading) {
      updateReadingContent();
    }
    updatePlayerUI();
  }

  function onLiveEnded() {
    // 无 HLS 时按 mp4 分段接力；有 HLS 时整条新闻已经播完
    if (!state.currentHls && state.partIndex + 1 < state.parts.length) {
      state.partIndex += 1;
      loadLiveSource(state.parts[state.partIndex], "");
      els.livePlayer.playbackRate = state.rate;
      els.livePlayer.play().catch(() => {});
      return;
    }
    updatePlayerUI();
    if (!state.autoNext) return;
    if (state.current + 1 < (state.data && state.data.segments ? state.data.segments.length : 0)) {
      nextTimer = setTimeout(() => startSegment(state.current + 1), 700);
    }
  }

  function onLiveError() {
    const video = els.livePlayer;
    if (!video) return;
    // 优先用 HLS；如果失败，回退到 mp4 分段地址
    const seg = segmentAt(state.current);
    if (seg && !state.hlsTried) {
      const source = liveSource(seg);
      if (source.hls && source.parts.length) {
        state.hlsTried = true;
        state.currentHls = false;
        loadLiveSource(source.parts[0], seg.image || "");
        video.playbackRate = state.rate;
        video.play().catch(() => {});
        return;
      }
    }
    if (!state.hlsTried && state.partIndex + 1 < state.parts.length) {
      state.partIndex += 1;
      loadLiveSource(state.parts[state.partIndex], "");
      els.livePlayer.play().catch(() => {});
      return;
    }
    showToast("原片加载失败，可点弹窗中的央视页面观看");
    updatePlayerUI();
  }

  function togglePlay() {
    if (!state.data) return;
    if (state.current < 0) { startSegment(0); return; }
    const video = els.livePlayer;
    if (video.paused || video.ended) {
      if (video.ended || !video.src) { startSegment(state.current); return; }
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function pauseLive() {
    try { els.livePlayer.pause(); } catch (_) { /* noop */ }

    updatePlayerUI();
  }

  // ------------------------------------------------------------------ reading / fullscreen
  // WebView 移动/固定主视频会黑屏；这里不移动 video，只改变页面布局与 video 尺寸。
  const phoneMedia = window.matchMedia ? window.matchMedia("(max-width: 760px)") : null;
  let readingOverlay = null;
  let fsUi = null;

  function isPhone() {
    return phoneMedia ? phoneMedia.matches : window.innerWidth <= 760;
  }
  function hasLiveSource() {
    const video = els.livePlayer;
    return !!(video && state.current >= 0 && (video.currentSrc || video.src || state.currentHls));
  }
  function resetPageScroll() {
    window.scrollTo(0, 0);
    try {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch (_) { /* noop */ }
  }

  function hasNativeVideo() {
    return !!(window.AndroidBridge && typeof window.AndroidBridge.openNativeVideo === "function");
  }
  function nativeTranscript(seg) {
    if (!seg) return "";
    if (Array.isArray(seg.paragraphs) && seg.paragraphs.length) return seg.paragraphs.join("");
    return String(seg.transcript || "");
  }
  function nativeUrl(seg) {
    const source = liveSource(seg);
    return source.src || "";
  }
  function reloadMainAt(time, shouldPlay) {
    const video = els.livePlayer;
    const seg = segmentAt(state.current);
    if (!video || !seg) return;
    const source = liveSource(seg);
    if (!source.src) return;
    try { video.pause(); } catch (_) { /* noop */ }
    video.src = source.src;
    video.load();
    const onMeta = () => {
      try {
        const duration = Number(video.duration) || 0;
        if (time > 0) video.currentTime = duration ? Math.min(time, Math.max(0, duration - 0.25)) : time;
      } catch (_) { /* noop */ }
      if (shouldPlay) video.play().catch(() => {});
      video.removeEventListener("loadedmetadata", onMeta);
    };
    video.addEventListener("loadedmetadata", onMeta);
  }
  let nativeVad = null;
  let nativeVadTimer = null;
  let nativeVadAudio = null;
  let nativeVadLastText = "";

  function ensureNativeVadAudio() {
    if (nativeVadAudio) return nativeVadAudio;
    const video = els.vadVideo;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!video || !Ctor) return null;
    try {
      const ac = new Ctor();
      const source = ac.createMediaElementSource(video);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      const gain = ac.createGain();
      gain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ac.destination);
      ac.resume().catch(() => {});
      nativeVadAudio = { ac, analyser, data: new Float32Array(analyser.fftSize), gain };
      return nativeVadAudio;
    } catch (err) {
      nativeVadAudio = null;
      return null;
    }
  }

  function stopNativeVad() {
    if (nativeVadTimer) { clearInterval(nativeVadTimer); nativeVadTimer = null; }
    nativeVad = null;
    state.nativeVadProgress = null;
    nativeVadLastText = "";
    const video = els.vadVideo;
    if (video) { try { video.pause(); } catch (_) { /* noop */ } }
  }

  function startNativeVad(seg, fromTime) {
    if (!seg || !els.vadVideo) return;
    const url = nativeUrl(seg);
    if (!url) return;
    stopNativeVad();
    const video = els.vadVideo;
    const duration = parseDurationSeconds(seg.duration) || ((seg.video && seg.video.duration_seconds) || 0);
    const startTime = Math.max(0, Number(fromTime) || 0);
    nativeVad = {
      seg, ratio: 0.8, speaking: false, speechStart: null, intervals: [],
      speechTime: startTime * 0.8,
      baseTime: startTime,
      totalSpeech: Math.max(1, duration * 0.8),
      threshold: 0.012,
      calibration: [],
      hangUntil: 0,
      lastAt: performance.now(),
      lastVideoTime: startTime,
      ready: false,
    };
    try {
      video.src = url;
      video.muted = false;
      video.volume = 1;
      video.load();
    } catch (_) { nativeVad = null; return; }
    const onMeta = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      try { video.currentTime = startTime; } catch (_) { /* noop */ }
      video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", onMeta);
    ensureNativeVadAudio();
    nativeVadTimer = setInterval(nativeVadTick, 80);
  }

  function nativeSpeechTimeAt(vad, target) {
    let total = 0;
    for (const interval of vad.intervals) {
      if (target <= interval[0]) break;
      total += Math.min(target, interval[1]) - interval[0];
    }
    if (vad.speaking && vad.speechStart != null && target > vad.speechStart) {
      total += Math.min(target, vad.lastVideoTime) - vad.speechStart;
    }
    return Math.max(0, total);
  }

  function nativeVadTick() {
    const vad = nativeVad;
    const video = els.vadVideo;
    if (!vad || !video) return;
    const now = performance.now();
    const dt = Math.min(0.2, Math.max(0, (now - vad.lastAt) / 1000));
    vad.lastAt = now;
    if (video.paused || video.ended) return;
    const duration = Number(video.duration) || 0;
    if (!duration) return;

    // 跳转：已经播过的区域用 VAD 时间线精确回算，没播过的区域按实时学到的有声占比估算。
    if (Math.abs(video.currentTime - vad.lastVideoTime - dt) > 0.45) {
      if (vad.speaking && vad.speechStart != null) vad.intervals.push([vad.speechStart, vad.lastVideoTime]);
      vad.speaking = false;
      vad.speechStart = null;
      const target = video.currentTime;
      const recordedEnd = vad.intervals.length ? vad.intervals[vad.intervals.length - 1][1] : 0;
      vad.speechTime = (target >= vad.baseTime && target <= recordedEnd + 0.15)
        ? nativeSpeechTimeAt(vad, target)
        : target * vad.ratio;
      vad.totalSpeech = Math.max(1, duration * vad.ratio);
      vad.calibration = [];
      vad.hangUntil = 0;
    }
    vad.lastVideoTime = video.currentTime;
    if (!nativeVadAudio) return;
    nativeVadAudio.analyser.getFloatTimeDomainData(nativeVadAudio.data);
    let sum = 0;
    for (let i = 0; i < nativeVadAudio.data.length; i++) {
      const value = nativeVadAudio.data[i];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / nativeVadAudio.data.length);
    vad.calibration.push(rms);
    if (vad.calibration.length > 120) vad.calibration.shift();
    if (vad.calibration.length >= 15) {
      const sorted = vad.calibration.slice().sort((a, b) => a - b);
      const p20 = sorted[Math.floor(sorted.length * 0.2)] || 0;
      vad.threshold = Math.max(0.012, Math.min(0.04, p20 * 1.7));
    }
    // 双阈值 + 气口保持，避免轻音/换气把语速判得忽快忽慢。
    const high = vad.threshold;
    const low = high * 0.66;
    const above = rms > (vad.speaking ? low : high);
    if (above) vad.hangUntil = now + 280;
    const active = above || now < vad.hangUntil;
    if (active) {
      if (!vad.speaking) { vad.speaking = true; vad.speechStart = video.currentTime; }
      vad.speechTime += dt;
    } else if (vad.speaking) {
      vad.speaking = false;
      if (vad.speechStart != null) vad.intervals.push([vad.speechStart, video.currentTime]);
      vad.speechStart = null;
    }
    if (video.currentTime > 6) {
      const observed = vad.speechTime / Math.max(1, video.currentTime);
      if (observed > 0.55 && observed < 0.98) {
        vad.ratio = Math.max(0.55, Math.min(0.95, vad.ratio * 0.97 + observed * 0.03));
        vad.totalSpeech = Math.max(1, duration * vad.ratio);
      }
    }
    const progress = Math.max(0, Math.min(1, (vad.speechTime - state.syncOffset) / vad.totalSpeech));
    state.nativeVadProgress = progress;
    if (!vad.ready) {
      vad.ready = true;
      state.activeCues = characterCues(vad.seg);
    }
    const cues = state.activeCues && state.activeCues.length ? state.activeCues : characterCues(vad.seg);
    let activeIndex = cues.findIndex((cue) => progress >= cue.start && progress < cue.end);
    if (activeIndex < 0 && cues.length && progress >= cues[cues.length - 1].start) activeIndex = cues.length - 1;
    const text = activeIndex >= 0 ? cues[activeIndex].text : "";
    if (text !== nativeVadLastText) {
      nativeVadLastText = text;
      try {
        if (window.AndroidBridge && typeof window.AndroidBridge.setNativeSubtitleText === "function") {
          window.AndroidBridge.setNativeSubtitleText(text);
        }
      } catch (_) { /* noop */ }
    }
  }

  function syncNativeVadVideo(position, playing) {
    const video = els.vadVideo;
    if (!nativeVad || !video) return;
    const time = Number(position) || 0;
    try {
      if (Math.abs(video.currentTime - time) > 0.7) video.currentTime = time;
      if (playing && video.paused) video.play().catch(() => {});
      if (!playing && !video.paused) video.pause();
    } catch (_) { /* noop */ }
  }

  function openNativeSideForCurrent(seg, fromTime) {
    if (!seg || !hasNativeVideo()) return false;
    const url = nativeUrl(seg);
    if (!url) return false;
    const time = Number.isFinite(fromTime) ? fromTime : (Number(els.livePlayer.currentTime) || 0);
    try { els.livePlayer.pause(); } catch (_) { /* noop */ }
    if (typeof window.AndroidBridge.openNativeVideoSide === "function") {
      window.AndroidBridge.openNativeVideoSide(url, nativeTranscript(seg), time);
      if (seg._alignedCues) applyAlignedCues(seg, seg._alignedCues);
      else ensureAlignedCues(seg);
    } else {
      return openNativeForCurrent(seg, false, time);
    }
    return true;
  }

  function openNativeForCurrent(seg, fullscreen, fromTime) {
    if (!seg || !hasNativeVideo()) return false;
    const url = nativeUrl(seg);
    if (!url) return false;
    const time = Number.isFinite(fromTime) ? fromTime : (Number(els.livePlayer.currentTime) || 0);
    try { els.livePlayer.pause(); } catch (_) { /* noop */ }
    window.AndroidBridge.openNativeVideo(url, nativeTranscript(seg), time, !!fullscreen);
    if (seg._alignedCues) applyAlignedCues(seg, seg._alignedCues);
    else ensureAlignedCues(seg);
    return true;
  }

  window.onNativeVideoTime = function onNativeVideoTime(position, duration, playing, muted) {
    state.nativePosition = Number(position) || 0;
    state.nativeDuration = Number(duration) || 0;
    syncNativeVadVideo(position, !!playing);
    if (!readingOverlay) return;
    updateReadingSideTime(position, duration, playing, muted);
    const total = Number(duration) || 0;
    if (total <= 0) return;
    const fraction = Math.max(0, Math.min(0.9999, (Number(position) || 0) / total - state.syncOffset / total));
    const cues = state.activeCues && state.activeCues.length ? state.activeCues : getSegmentCues(segmentAt(state.current));
    const activeIndex = cueIndexAt(cues, fraction);
    const cueEls = readingOverlay.querySelectorAll(".reading-cue");
    cueEls.forEach((el) => el.classList.toggle("active", Number(el.dataset.index) === activeIndex));
    const active = activeIndex >= 0 ? (cueEls[activeIndex] || null) : null;
    if (active && active !== readingOverlay._activeCue) {
      readingOverlay._activeCue = active;
      const body = readingOverlay.querySelector(".reading-body");
      if (body) {
        const top = active.offsetTop - body.clientHeight * 0.42;
        body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    }
  };

  window.onNativeVideoPrepared = function onNativeVideoPrepared() {
    const seg = segmentAt(state.current);
    if (!seg) return;
    if (seg._alignedCues) {
      state.alignedCues = seg._alignedCues;
      state.activeCues = applyLearningToCues(seg._alignedCues, seg);
      state.nativeVadProgress = null;
      sendNativeCueTimeline(state.activeCues);
    } else {
      applyLearningNow(seg);
      ensureAlignedCues(seg);
    }
  };

  window.onNativeVideoEnded = function onNativeVideoEnded() {
    if (!state.reading) return;
    if (state.autoNext && state.current + 1 < (state.data && state.data.segments ? state.data.segments.length : 0)) {
      selectReadingSegment(state.current + 1);
    } else if (readingSide) {
      const status = readingSide.querySelector(".rs-status");
      if (status) status.textContent = "已结束";
    }
  };

  window.onNativeVideoClosed = function onNativeVideoClosed(position, wasPlaying) {
    stopNativeVad();
    removeReadingSidePanel();
    const time = Number(position) || 0;
    const play = !!wasPlaying;
    if (readingOverlay) { readingOverlay.remove(); readingOverlay = null; }
    state.reading = false;
    if (fsUi) { fsUi.remove(); fsUi = null; }
    state.fullscreen = false;
    document.body.classList.remove("reading-mode");
    document.body.classList.remove("native-reading");
    document.body.classList.remove("tablet-reading");
    document.body.classList.remove("fs-open");
    document.body.style.overflow = "";
    setImmersive(false);
    reloadMainAt(time, play);
  };

  function setImmersive(on) {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.setImmersive === "function") {
        window.AndroidBridge.setImmersive(!!on);
      }
    } catch (_) { /* noop */ }
  }

  // fixed/normal 布局切换后，WebView 偶尔还停在旧画面；做一次极小的尺寸变化并继续播放。
  function settleMainVideo() {
    const video = els.livePlayer;
    if (!video) return;
    video.style.width = "calc(100% - 1px)";
    requestAnimationFrame(() => {
      video.style.width = "";
      video.play().catch(() => {});
    });
  }

  let reloadingVideo = false;

  // Android WebView 在 VIDEO 尺寸/布局变化后可能黑屏；用同一地址重新 load 一次，
  // 让解码 Surface 在“新布局尺寸”下重建，然后恢复到原播放位置。
  function reloadLiveVideo() {
    const video = els.livePlayer;
    const seg = segmentAt(state.current);
    if (!video || !seg || reloadingVideo) return;
    const source = liveSource(seg);
    const src = source.src || video.currentSrc || video.src;
    if (!src) return;
    const time = Number(video.currentTime) || 0;
    const wasPlaying = !video.paused && !video.ended;
    const rate = video.playbackRate || state.rate;
    reloadingVideo = true;
    try { video.pause(); } catch (_) { /* noop */ }
    video.src = src;
    video.load();
    const onMeta = () => {
      reloadingVideo = false;
      try {
        const duration = Number(video.duration) || 0;
        if (time > 0) video.currentTime = duration ? Math.min(time, Math.max(0, duration - 0.25)) : time;
      } catch (_) { /* noop */ }
      video.playbackRate = rate;
      if (wasPlaying) video.play().catch(() => {});
      video.removeEventListener("loadedmetadata", onMeta);
    };
    video.addEventListener("loadedmetadata", onMeta);
    window.setTimeout(() => { reloadingVideo = false; }, 2500);
  }

  const SYNC_PAUSE_SECONDS = {
    "。": 1.0, "！": 1.0, "？": 1.0, "!": 1.0, "?": 1.0,
    "；": 0.72, ";": 0.72, "：": 0.5, ":": 0.5,
    "，": 0.34, ",": 0.34, "、": 0.28, "…": 0.45, "—": 0.3
  };
  const SYNC_PAUSE_FACTOR = 5.0;

  function stripSpokenPrefix(text) {
    return String(text || "")
      .replace(/^\s*央视网消息\s*[（(]?\s*新闻联播\s*[）)]?\s*[：:]\s*/, "")
      .replace(/^\s*央视网消息\s*[：:]\s*/, "")
      .replace(/^\s*[（(]\s*新闻联播\s*[）)]\s*[：:]\s*/, "")
      .trim();
  }

  function spokenCharCount(text) {
    return String(text || "").replace(/[\s。！？!?；;，,、：:…—]/g, "").length;
  }

  function syncPauseSeconds(text) {
    let total = 0;
    for (const ch of String(text || "")) total += SYNC_PAUSE_SECONDS[ch] || 0;
    return total;
  }

  function spokenChunks(seg) {
    if (!seg) return [];
    let text = String(seg.transcript || "");
    if (!text && Array.isArray(seg.paragraphs)) text = seg.paragraphs.join(" ");
    text = stripSpokenPrefix(text).replace(/\s+/g, " ").trim();
    if (!text) return [];
    const raw = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [text];
    const chunks = [];
    for (const rawItem of raw) {
      const item = rawItem.trim();
      if (!item) continue;
      if (item.length <= 46) {
        chunks.push(item);
      } else {
        let sentence = "";
        for (const piece of item.split(/(?<=[，,：:、])/)) {
          if ((sentence + piece).length > 42 && sentence) { chunks.push(sentence); sentence = piece; }
          else sentence += piece;
        }
        if (sentence.trim()) chunks.push(sentence.trim());
      }
    }
    return chunks.map((text) => ({ text, chars: Math.max(1, spokenCharCount(text)) }));
  }

  function transcriptCues(seg) {
    const chunks = spokenChunks(seg);
    if (!chunks.length) return [];
    const weighted = chunks.map((item) => ({
      text: item.text,
      weight: item.chars + syncPauseSeconds(item.text) * SYNC_PAUSE_FACTOR,
    }));
    const total = weighted.reduce((n, item) => n + item.weight, 0) || 1;
    let acc = 0;
    return weighted.map((item, index) => {
      const start = acc / total;
      acc += item.weight;
      return { index, text: item.text, start, end: acc / total };
    });
  }

  function characterCues(seg) {
    const chunks = spokenChunks(seg);
    if (!chunks.length) return [];
    const total = chunks.reduce((n, item) => n + item.chars, 0) || 1;
    let acc = 0;
    return chunks.map((item, index) => {
      const start = acc / total;
      acc += item.chars;
      return { index, text: item.text, start, end: acc / total };
    });
  }

  let voskModel = null;
  let voskModelPromise = null;
  let voskScriptPromise = null;

  function loadVoskModel() {
    if (voskModel) return Promise.resolve(voskModel);
    if (voskModelPromise) return voskModelPromise;
    voskModelPromise = new Promise((resolve, reject) => {
      const finish = () => {
        Vosk.createModel("/vendor/vosk/model.tar.gz")
          .then((model) => { voskModel = model; resolve(model); })
          .catch(reject);
      };
      if (window.Vosk) { finish(); return; }
      if (!voskScriptPromise) {
        voskScriptPromise = new Promise((res, rej) => {
          const script = document.createElement("script");
          script.src = "/vendor/vosk/vosk.js";
          script.onload = res;
          script.onerror = rej;
          document.head.appendChild(script);
        });
      }
      voskScriptPromise.then(finish).catch(reject);
    });
    return voskModelPromise;
  }

  function isSpeechChar(ch) {
    return /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch);
  }

  function alignWordsToCues(seg, words, duration) {
    const chunks = spokenChunks(seg);
    if (!chunks.length || !words || !words.length || !duration) return null;
    const transcriptChars = [];
    const cueRanges = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chars = Array.from(chunks[ci].text).filter(isSpeechChar);
      const start = transcriptChars.length;
      for (const ch of chars) transcriptChars.push(ch);
      cueRanges.push([start, transcriptChars.length, ci]);
    }
    const recChars = [];
    const recTimes = [];
    for (const word of words) {
      const text = String(word.word || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
      if (!text) continue;
      const list = Array.from(text);
      for (let i = 0; i < list.length; i++) {
        recChars.push(list[i]);
        const start = Number(word.start) || 0;
        const end = Number(word.end) || start;
        recTimes.push(start + ((i + 1) / list.length) * Math.max(0, end - start));
      }
    }
    if (recChars.length < 2 || transcriptChars.length < 2) return null;
    const n = transcriptChars.length;
    const m = recChars.length;
    const width = m + 1;
    const dp = new Float32Array((n + 1) * width);
    const ptr = new Uint8Array((n + 1) * width);
    for (let i = 1; i <= n; i++) { dp[i * width] = i; ptr[i * width] = 1; }
    for (let j = 1; j <= m; j++) { dp[j] = j; ptr[j] = 2; }
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const idx = i * width + j;
        const expectedTime = (i / n) * duration;
        const timePenalty = Math.min(0.7, Math.abs((recTimes[j - 1] || 0) - expectedTime) * 0.012);
        const cost = (transcriptChars[i - 1] === recChars[j - 1] ? 0 : 1.2) + timePenalty;
        let best = dp[(i - 1) * width + j - 1] + cost;
        let dir = 0;
        const up = dp[(i - 1) * width + j] + 1;
        if (up < best) { best = up; dir = 1; }
        const left = dp[i * width + j - 1] + 1;
        if (left < best) { best = left; dir = 2; }
        dp[idx] = best;
        ptr[idx] = dir;
      }
    }
    const mapped = new Float32Array(n);
    mapped.fill(-1);
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const idx = i * width + j;
      const dir = ptr[idx];
      if (dir === 0) { mapped[i - 1] = recTimes[j - 1]; i--; j--; }
      else if (dir === 1) i--;
      else j--;
    }
    let prev = -1;
    for (let k = 0; k < n; k++) {
      if (mapped[k] >= 0) {
        if (prev >= 0) {
          const gap = k - prev;
          for (let g = prev + 1; g < k; g++) mapped[g] = mapped[prev] + (mapped[k] - mapped[prev]) * ((g - prev) / gap);
        }
        prev = k;
      }
    }
    if (prev >= 0) for (let k = prev + 1; k < n; k++) mapped[k] = mapped[prev];
    if (mapped[0] < 0) mapped[0] = 0;
    let last = 0;
    for (let k = 0; k < n; k++) { mapped[k] = Math.max(last, mapped[k]); last = mapped[k]; }
    // 语音识别得到的“词”才是真正的音频锚点。新闻片里经常夹杂采访、
    // 资料片和非文字稿内容，全局字符对齐会被这些额外语音带偏；这里改为
    // 只在“识别词能在文字稿里原样找到”的地方建立锚点，再用单调链把
    // 这些锚点串起来。额外语音找不到对应文字时不会强行推进文字稿。
    const transcriptText = transcriptChars.join("");
    const candidates = [];
    for (const word of words) {
      const text = String(word.word || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
      const conf = Number(word.conf);
      if (text.length < 2 || !Number.isFinite(conf) || conf < 0.42) continue;
      const ts = Number(word.start) || 0;
      const te = Number(word.end) || ts;
      let at = transcriptText.indexOf(text);
      let occurrence = 0;
      while (at >= 0 && occurrence < 6) {
        candidates.push({ cs: at, ce: at + text.length, ts, te, score: text.length * (0.6 + conf) });
        at = transcriptText.indexOf(text, at + 1);
        occurrence++;
      }
    }
    candidates.sort((a, b) => a.cs - b.cs || a.ts - b.ts);
    const anchorDp = new Float32Array(candidates.length);
    const anchorPrev = new Int32Array(candidates.length);
    anchorPrev.fill(-1);
    let bestAnchor = -1;
    let bestAnchorScore = 0;
    for (let k = 0; k < candidates.length; k++) {
      anchorDp[k] = candidates[k].score;
      for (let p = 0; p < k; p++) {
        if (candidates[p].ce <= candidates[k].cs && candidates[p].te <= candidates[k].ts + 0.2) {
          const value = anchorDp[p] + candidates[k].score;
          if (value > anchorDp[k]) {
            anchorDp[k] = value;
            anchorPrev[k] = p;
          }
        }
      }
      if (anchorDp[k] > bestAnchorScore) { bestAnchorScore = anchorDp[k]; bestAnchor = k; }
    }
    const anchors = [];
    for (let k = bestAnchor; k >= 0; k = anchorPrev[k]) anchors.push(candidates[k]);
    anchors.reverse();
    const anchorCoverage = anchors.reduce((sum, a) => sum + (a.ce - a.cs), 0);
    const anchorTimeAt = (position) => {
      if (anchors.length < 3 || anchorCoverage < Math.max(3, transcriptChars.length * 0.035)) return null;
      for (const a of anchors) {
        if (position >= a.cs && position <= a.ce) {
          return a.ts + ((position - a.cs) / Math.max(1, a.ce - a.cs)) * (a.te - a.ts);
        }
      }
      let before = null;
      let after = null;
      for (const a of anchors) {
        if (a.ce <= position) before = a;
        else if (a.cs >= position) { after = a; break; }
      }
      if (before && after && after.ts > before.te) {
        const spanChars = Math.max(1, after.cs - before.ce);
        return before.te + ((position - before.ce) / spanChars) * (after.ts - before.te);
      }
      if (before) {
        const rate = (before.te - before.ts) / Math.max(1, before.ce - before.cs);
        return before.te + Math.max(0, position - before.ce) * Math.max(0.02, rate);
      }
      if (after) {
        const rate = (after.te - after.ts) / Math.max(1, after.ce - after.cs);
        return after.ts - Math.max(0, after.cs - position) * Math.max(0.02, rate);
      }
      return null;
    };
    // 只使用每句的“起点”作为切换边界，后一句起点就是前一句终点。
    // 这样绝不会出现两条字幕时间区间重叠，原生字幕和网页高亮就不会在同一时刻
    // 各自选中不同的 cue，也不会因为某个 cue 的结束时间过长而突然跳句。
    const starts = cueRanges.map(([start]) => {
      const at = start < n ? start : n - 1;
      const anchored = anchorTimeAt(at);
      const first = anchored != null ? anchored : mapped[at];
      return Math.max(0, Math.min(1, first / duration));
    });
    starts[0] = 0;
    for (let k = 1; k < starts.length; k++) {
      starts[k] = Math.min(0.999, Math.max(starts[k], starts[k - 1] + 0.0005));
    }
    return cueRanges.map(([,], index) => ({
      index,
      text: chunks[index] ? chunks[index].text : "",
      start: starts[index],
      end: index + 1 < starts.length ? starts[index + 1] : 1,
    }));
  }

  function audioParts(seg) {
    const parts = (seg && seg.video && Array.isArray(seg.video.parts)) ? seg.video.parts.filter(Boolean) : [];
    if (parts.length) return parts;
    return [seg?.video?.mp4 || ""].filter(Boolean);
  }

  const ALIGN_SERVER_KEY = "lianbo.align.server.v1";

  function alignServerUrl() {
    try {
      const saved = (localStorage.getItem(ALIGN_SERVER_KEY) || "").trim();
      if (saved) return saved;
    } catch (_) { /* noop */ }
    return "";
  }

  async function remoteAlignCues(seg) {
    const server = alignServerUrl();
    if (!server) return null;
    const text = String(seg && seg.transcript ? seg.transcript : "").trim();
    const parts = audioParts(seg);
    if (!text || !parts.length) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20 * 60 * 1000);
    try {
      const form = new FormData();
      for (let i = 0; i < parts.length; i++) {
        const media = await fetch(parts[i], { mode: "cors" });
        if (!media.ok) return null;
        form.append("files", await media.blob(), `part-${i}.mp4`);
      }
      form.append("text", text);
      const response = await fetch(server.replace(/\/+$/, "") + "/api/forced-align/upload", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || !data.ok || !Array.isArray(data.items)) return null;
      const words = data.items
        .map((item) => ({
          word: String(item.text || ""),
          start: Number(item.start) || 0,
          end: Number(item.end) || 0,
          conf: 1,
        }))
        .filter((item) => item.word);
      if (words.length < 2) return null;
      const duration = parseDurationSeconds(seg.duration);
      const cues = alignWordsToCues(seg, words, duration);
      return cues && cues.length ? cues : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function recognizeSegmentWords(seg) {
    const parts = audioParts(seg);
    if (!parts.length) return null;
    const model = await loadVoskModel();
    const allWords = [];
    let offset = 0;
    for (const partUrl of parts) {
      const response = await fetch(partUrl, { mode: "cors" });
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audio = await ac.decodeAudioData(bytes.slice(0));
      const data = audio.getChannelData(0);
      const recognizer = new model.KaldiRecognizer(16000);
      recognizer.setWords(true);
      const partWords = [];
      recognizer.on("result", (message) => {
        if (message.result && Array.isArray(message.result.result)) partWords.push(...message.result.result);
      });
      const step = 8000;
      for (let at = 0; at < data.length; at += step) {
        recognizer.acceptWaveformFloat(data.subarray(at, Math.min(data.length, at + step)), 16000);
      }
      recognizer.retrieveFinalResult();
      const audioDuration = Number(audio.duration) || 0;
      let lastCount = -1, lastChange = Date.now();
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        let lastEnd = 0;
        for (const word of partWords) lastEnd = Math.max(lastEnd, Number(word.end) || 0);
        if (partWords.length !== lastCount) {
          lastCount = partWords.length;
          lastChange = Date.now();
        } else if (partWords.length > 0 && Date.now() - lastChange > 4000 &&
                   (lastEnd >= audioDuration * 0.9 || Date.now() - lastChange > 30000)) {
          break;
        }
      }
      for (const word of partWords) {
        allWords.push({ start: Number(word.start) + offset, end: Number(word.end) + offset, word: word.word, conf: Number(word.conf) || 0 });
      }
      offset += Number(audio.duration) || 0;
      try { recognizer.remove(); } catch (_) { /* noop */ }
      try { ac.close(); } catch (_) { /* noop */ }
    }
    return allWords;
  }

  function alignedCacheKey(seg) {
    const source = (seg?.video?.parts || [])[0] || seg?.video?.mp4 || seg?.url || "";
    return "lianbo.aligned.v5." + String(seg?.id || "") + "." + String(source).slice(-80);
  }

  function loadAlignedCache(seg) {
    try {
      const raw = localStorage.getItem(alignedCacheKey(seg));
      const cues = raw ? JSON.parse(raw) : null;
      return Array.isArray(cues) && cues.length ? cues : null;
    } catch (_) { return null; }
  }

  function applyAlignedCues(seg, cues) {
    if (!cues || !cues.length) return;
    seg._alignedCues = cues;
    try { localStorage.setItem(alignedCacheKey(seg), JSON.stringify(cues)); } catch (_) { /* noop */ }
    if (segmentAt(state.current) !== seg) return;
    state.alignedCues = cues;
    state.activeCues = applyLearningToCues(cues, seg);
    state.nativeVadProgress = null;
    stopNativeVad();
    sendNativeCueTimeline(state.activeCues);
    updateLearnUI(seg);
    if (readingOverlay) {
      const first = cues[0];
      if (first) {
        const status = readingSide?.querySelector(".rs-status");
        if (status) status.textContent = "字幕已校准";
      }
    }
  }

  function ensureAlignedCues(seg) {
    if (!seg || seg._alignPromise || seg._alignedCues) {
      if (seg && seg._alignedCues) applyAlignedCues(seg, seg._alignedCues);
      return;
    }
    const cached = loadAlignedCache(seg);
    if (cached) {
      applyAlignedCues(seg, cached);
      return;
    }
    showToast("正在做强制对齐/语音校准，首次会慢一些…");
    seg._alignPromise = (async () => {
      const remote = await remoteAlignCues(seg).catch(() => null);
      if (remote && remote.length) {
        applyAlignedCues(seg, remote);
        showToast("字幕已按强制对齐结果校准");
        return;
      }
      const words = await recognizeSegmentWords(seg);
      const duration = parseDurationSeconds(seg.duration);
      const cues = alignWordsToCues(seg, words, duration);
      if (!cues || !cues.length) return;
      applyAlignedCues(seg, cues);
      showToast("字幕已按原片语音校准");
    })().catch(() => {}).finally(() => { seg._alignPromise = null; });
  }

  function parseDurationSeconds(text) {
    const parts = String(text || "").split(":").map((x) => Number(x));
    if (parts.some((x) => Number.isNaN(x))) return 0;
    return parts.reduce((total, item) => total * 60 + item, 0);
  }

  let analysisAudioContext = null;

  async function analyzeAudioCues(seg) {
    const sourceUrl = seg?.video?.mp4 || (seg?.video?.parts || [])[0] || "";
    if (!sourceUrl || !window.fetch) return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    const response = await fetch(sourceUrl, { mode: "cors" });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (!analysisAudioContext) analysisAudioContext = new Ctor();
    const audio = await analysisAudioContext.decodeAudioData(bytes.slice(0));
    const data = audio.getChannelData(0);
    const sampleRate = audio.sampleRate || 48000;
    const windowSize = Math.max(1, Math.round(sampleRate * 0.03));
    const count = Math.floor(data.length / windowSize);
    if (count < 8) return null;
    const rms = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      const base = i * windowSize;
      for (let j = 0; j < windowSize; j++) {
        const value = data[base + j];
        sum += value * value;
      }
      rms[i] = Math.sqrt(sum / windowSize);
    }
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] || 0;
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const threshold = Math.max(p10 * 1.6, p50 * 0.3, 0.002);
    const mask = new Uint8Array(count);
    for (let i = 0; i < count; i++) mask[i] = rms[i] > threshold ? 1 : 0;
    // 合并短于 0.2s 的停顿，剔除短于 0.1s 的噪声“语音”
    const maxGapFrames = Math.round(0.2 / 0.03);
    const minSpeechFrames = Math.round(0.1 / 0.03);
    let i = 0;
    while (i < count) {
      if (!mask[i]) { i++; continue; }
      let j = i;
      while (j < count && mask[j]) j++;
      if (j - i < minSpeechFrames) for (let k = i; k < j; k++) mask[k] = 0;
      i = j;
    }
    const intervals = [];
    let startFrame = -1;
    for (let k = 0; k < count; k++) {
      if (mask[k] && startFrame < 0) startFrame = k;
      if (!mask[k] && startFrame >= 0) {
        intervals.push([startFrame * 0.03, k * 0.03]);
        startFrame = -1;
      }
    }
    if (startFrame >= 0) intervals.push([startFrame * 0.03, count * 0.03]);
    if (!intervals.length) return null;
    // 合并间隔很短的区间
    const merged = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last && interval[0] - last[1] <= 0.22) last[1] = interval[1];
      else merged.push(interval.slice());
    }
    const totalSpeech = merged.reduce((n, item) => n + (item[1] - item[0]), 0);
    if (totalSpeech < 2) return null;
    const duration = parseDurationSeconds(seg.duration) || audio.duration || 0;
    if (!duration) return null;
    const chunks = spokenChunks(seg);
    const totalChars = chunks.reduce((n, item) => n + item.chars, 0) || 1;
    const speechTimeToVideo = (speechTime) => {
      let acc = 0;
      for (const item of merged) {
        const length = item[1] - item[0];
        if (speechTime <= acc + length) return item[0] + (speechTime - acc);
        acc += length;
      }
      return merged[merged.length - 1][1];
    };
    let accChars = 0;
    return chunks.map((item, index) => {
      const startSpeech = (accChars / totalChars) * totalSpeech;
      accChars += item.chars;
      const endSpeech = (accChars / totalChars) * totalSpeech;
      const startVideo = speechTimeToVideo(startSpeech);
      const endVideo = Math.max(startVideo + 0.2, speechTimeToVideo(endSpeech));
      return {
        index,
        text: item.text,
        start: Math.max(0, Math.min(1, startVideo / duration)),
        end: Math.max(0, Math.min(1, endVideo / duration)),
      };
    });
  }

  function getSegmentCues(seg) {
    if (!seg) return [];
    if (Array.isArray(seg._audioCues) && seg._audioCues.length) return seg._audioCues;
    return transcriptCues(seg);
  }

  function sendNativeCueTimeline(cues) {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.setNativeSubtitleTimeline === "function") {
        window.AndroidBridge.setNativeSubtitleTimeline(JSON.stringify(
          cues.map((cue) => [Number(cue.start.toFixed(6)), Number(cue.end.toFixed(6)), cue.text])
        ));
      }
    } catch (_) { /* noop */ }
  }

  function ensureAudioCues(seg) {
    if (!seg || seg._audioCuesPromise) return;
    const sourceUrl = seg?.video?.mp4 || (seg?.video?.parts || [])[0];
    if (!sourceUrl) return;
    if (state.audioCueCache.has(sourceUrl)) {
      seg._audioCues = state.audioCueCache.get(sourceUrl);
      return;
    }
    seg._audioCuesPromise = analyzeAudioCues(seg).then((cues) => {
      if (!cues || !cues.length) return;
      seg._audioCues = cues;
      state.audioCueCache.set(sourceUrl, cues);
      if (segmentAt(state.current) === seg) {
        state.activeCues = cues;
        sendNativeCueTimeline(cues);
        renderLiveSubtitle();
      }
    }).catch(() => {}).finally(() => { seg._audioCuesPromise = null; });
  }

  function segmentTranscriptHtml(seg) {
    const cues = getSegmentCues(seg);
    if (!cues.length) return "";
    return `<p class="reading-cue-line">${cues.map((cue, index) =>
      `<span class="reading-cue" data-index="${index}" data-start="${cue.start.toFixed(6)}" data-end="${cue.end.toFixed(6)}">${esc(cue.text)}</span>`
    ).join(" ")}</p>`;
  }

  function updateReadingContent() {
    if (!readingOverlay) return;
    const seg = segmentAt(state.current);
    if (!seg) return;
    const title = readingOverlay.querySelector(".reading-head h3");
    const body = readingOverlay.querySelector(".reading-body");
    if (title) title.textContent = seg.title || "文字稿";
    if (body) body.innerHTML = segmentTranscriptHtml(seg);
  }

  function readingLandscape() {
    return window.innerWidth > window.innerHeight;
  }

  function syncReadingLayout() {
    if (!readingOverlay || state.fullscreen) return;
    const landscape = readingLandscape();
    document.body.classList.toggle("tablet-reading", landscape);
    readingOverlay.classList.toggle("tablet-reading-overlay", landscape);
    readingOverlay.style.top = landscape ? "0px" : Math.round(window.innerWidth * 9 / 16) + "px";
    if (landscape) ensureReadingSidePanel();
    else removeReadingSidePanel();
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.setNativeReadingLayout === "function") {
        window.AndroidBridge.setNativeReadingLayout(landscape);
      }
    } catch (_) { /* noop */ }
  }

  let readingSide = null;
  let readingSideDuration = 0;
  let readingMuted = false;

  function sideVideoHeight() {
    return Math.round(window.innerWidth * 0.46 * 9 / 16);
  }

  function removeReadingSidePanel() {
    if (readingSide) { readingSide.remove(); readingSide = null; }
  }

  function ensureReadingSidePanel() {
    if (!readingOverlay || !readingLandscape()) { removeReadingSidePanel(); return; }
    if (!readingSide) {
      const panel = document.createElement("div");
      panel.className = "reading-side-panel";
      panel.innerHTML = `
        <div class="rs-head">
          <span class="rs-kicker">原片视听 · 正在播放</span>
          <h3 class="rs-title"></h3>
          <span class="rs-status">播放中</span>
        </div>
        <div class="rs-progress">
          <input type="range" class="rs-seek" min="0" max="1000" value="0" step="1">
          <div class="rs-times"><span class="rs-now">0:00</span><span class="rs-total">—</span></div>
        </div>
        <div class="rs-controls">
          <button type="button" data-rs="prev">⏮</button>
          <button type="button" class="rs-play" data-rs="toggle">▶</button>
          <button type="button" data-rs="next">⏭</button>
          <button type="button" data-rs="mute">静音</button>
          <button type="button" class="is-on" data-rs="auto">连续播放</button>
          <button type="button" data-rs="sync">同步</button>
          <button type="button" data-rs="learn">点句校准</button>
        </div>
        <div class="rs-list-head"><span>原片清单</span><span class="rs-count"></span></div>
        <div class="rs-playlist"></div>`;
      panel.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-rs]");
        if (!btn) {
          const row = event.target.closest(".rs-track");
          if (row) selectReadingSegment(Number(row.dataset.index));
          return;
        }
        const action = btn.dataset.rs;
        if (action === "prev") selectReadingSegment(Math.max(0, state.current - 1));
        else if (action === "next") selectReadingSegment(Math.min((state.data.segments || []).length - 1, state.current + 1));
        else if (action === "toggle" && window.AndroidBridge && window.AndroidBridge.toggleNativeVideo) window.AndroidBridge.toggleNativeVideo();
        else if (action === "mute") {
          readingMuted = !readingMuted;
          if (window.AndroidBridge && window.AndroidBridge.setNativeMuted) window.AndroidBridge.setNativeMuted(readingMuted);
          btn.textContent = readingMuted ? "原声" : "静音";
        } else if (action === "auto") {
          state.autoNext = !state.autoNext;
          btn.classList.toggle("is-on", state.autoNext);
        } else if (action === "sync") {
          openSyncModal();
        } else if (action === "learn") {
          toggleLearnMode();
        }
      });
      const seek = panel.querySelector(".rs-seek");
      seek.addEventListener("input", () => {
        if (!readingSideDuration || !window.AndroidBridge || !window.AndroidBridge.seekNativeVideo) return;
        const value = Number(seek.value) || 0;
        window.AndroidBridge.seekNativeVideo((value / 1000) * readingSideDuration);
      });
      document.body.appendChild(panel);
      readingSide = panel;
    }
    readingSide.style.top = sideVideoHeight() + "px";
    readingSide.style.width = "46%";
    readingSide.querySelector('[data-rs="auto"]').classList.toggle("is-on", state.autoNext);
    renderReadingSideMeta();
    renderReadingPlaylist();
  }

  function renderReadingSideMeta() {
    if (!readingSide) return;
    const seg = segmentAt(state.current);
    const title = readingSide.querySelector(".rs-title");
    if (title) title.textContent = seg ? (seg.title || "原片") : "原片";
    const count = readingSide.querySelector(".rs-count");
    if (count) count.textContent = `${(state.data && state.data.segments ? state.data.segments.length : 0)} 段`;
  }

  function renderReadingPlaylist() {
    if (!readingSide) return;
    const list = readingSide.querySelector(".rs-playlist");
    if (!list) return;
    const segments = state.data && state.data.segments ? state.data.segments : [];
    list.innerHTML = segments.map((seg, idx) => `
      <button type="button" class="rs-track${idx === state.current ? " active" : ""}" data-index="${idx}">
        <span class="rs-no">${String(idx + 1).padStart(2, "0")}</span>
        <span class="rs-title-text">${esc(seg.title || "")}</span>
        <span class="rs-duration">${esc(seg.duration || "")}</span>
      </button>`).join("");
  }

  function updateReadingSideTime(position, duration, playing, muted) {
    if (!readingSide) return;
    const total = Number(duration) || 0;
    const current = Number(position) || 0;
    readingSideDuration = total;
    const seek = readingSide.querySelector(".rs-seek");
    if (seek && document.activeElement !== seek) seek.value = String(total ? Math.round((current / total) * 1000) : 0);
    const now = readingSide.querySelector(".rs-now");
    const totalEl = readingSide.querySelector(".rs-total");
    if (now) now.textContent = fmtClock(current);
    if (totalEl) totalEl.textContent = total ? fmtClock(total) : "—";
    const status = readingSide.querySelector(".rs-status");
    if (status) status.textContent = playing ? "播放中" : "已暂停";
    const playBtn = readingSide.querySelector(".rs-play");
    if (playBtn) playBtn.textContent = playing ? "❚❚" : "▶";
    if (typeof muted === "boolean") {
      readingMuted = muted;
      const muteBtn = readingSide.querySelector('[data-rs="mute"]');
      if (muteBtn) muteBtn.textContent = muted ? "原声" : "静音";
    }
    const tracks = readingSide.querySelectorAll(".rs-track");
    tracks.forEach((track) => track.classList.toggle("active", Number(track.dataset.index) === state.current));
  }

  function selectReadingSegment(index) {
    if (!readingOverlay || !state.data) return;
    const segments = state.data.segments || [];
    if (index < 0 || index >= segments.length) return;
    const seg = segments[index];
    state.current = index;
    state.alignedCues = seg._alignedCues || null;
    state.activeCues = applyLearningToCues(baseCuesFor(seg), seg);
    try { els.livePlayer.pause(); } catch (_) { /* noop */ }
    if (readingLandscape()) openNativeSideForCurrent(seg, 0);
    else openNativeForCurrent(seg, false, 0);
    if (seg._audioCues) sendNativeCueTimeline(seg._audioCues);
    updateReadingContent();
    if (readingOverlay) readingOverlay._activeCue = null;
    ensureReadingSidePanel();
    updatePlayerUI();
  }

  function openReading(index) {
    if (!state.data) return;
    const want = Number.isFinite(index) ? Math.trunc(index) : state.current;
    const seg = segmentAt(want);
    if (!seg) return;
    closeVideo();
    closeBili();
    if (state.fullscreen) exitFullscreen();
    closeReading(false);
    if (state.current !== want || !hasLiveSource()) startSegment(want);
    else if (els.livePlayer.paused) els.livePlayer.play().catch(() => {});

    state.activeCues = applyLearningToCues(baseCuesFor(seg), seg);
    updateLearnUI(seg);

    if (hasNativeVideo()) {
      const landscape = readingLandscape();
      const fromTime = state.current === want ? (Number(els.livePlayer.currentTime) || 0) : 0;
      if (landscape) openNativeSideForCurrent(seg, fromTime);
      else openNativeForCurrent(seg, false, fromTime);
      if (seg._audioCues) sendNativeCueTimeline(seg._audioCues);
      state.reading = true;
      document.body.classList.add("reading-mode", "native-reading");
      if (landscape) document.body.classList.add("tablet-reading");
      document.body.style.overflow = "hidden";
      const nativeOverlay = document.createElement("div");
      nativeOverlay.className = "reading-overlay native-reading-overlay" + (landscape ? " tablet-reading-overlay" : "");
      nativeOverlay.innerHTML = `
        <div class="reading-head">
          <div>
            <span class="reading-kicker">今日报道 · 原片文字稿</span>
            <h3>${esc(seg.title || "文字稿")}</h3>
          </div>
          <div class="reading-actions">
            <button type="button" class="sync-open-btn" data-learn-toggle>校准</button>
            <button type="button" class="sync-open-btn" data-sync-open>同步</button>
            <button type="button" class="reading-close" data-read="close" aria-label="收起文字稿">×</button>
          </div>
        </div>
        <div class="reading-body">${segmentTranscriptHtml(seg)}</div>`;
      nativeOverlay.style.top = landscape ? "0px" : Math.round(window.innerWidth * 9 / 16) + "px";
      nativeOverlay.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-read]");
        if (btn && btn.dataset.read === "close") {
          if (hasNativeVideo()) window.AndroidBridge.closeNativeVideo();
          else closeReading(true);
        }
      });
      document.body.appendChild(nativeOverlay);
      readingOverlay = nativeOverlay;
      ensureReadingSidePanel();
      updatePlayerUI();
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "reading-overlay";
    overlay.style.top = "0px";
    overlay.innerHTML = `
      <div class="reading-head">
        <div>
          <span class="reading-kicker">今日报道 · 原片文字稿</span>
          <h3>${esc(seg.title || "文字稿")}</h3>
        </div>
        <div class="reading-actions">
          <button type="button" data-read="fullscreen">全屏原片</button>
          <button type="button" class="reading-close" data-read="close" aria-label="收起文字稿">×</button>
        </div>
      </div>
      <div class="reading-body">${segmentTranscriptHtml(seg)}</div>`;
    overlay.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-read]");
      if (!btn) return;
      if (btn.dataset.read === "close") closeReading(true);
      else if (btn.dataset.read === "fullscreen") {
        closeReading(false);
        enterFullscreen(state.current >= 0 ? state.current : 0);
      }
    });
    document.body.appendChild(overlay);
    readingOverlay = overlay;
    state.reading = true;
    document.body.classList.add("reading-mode");
    resetPageScroll();
    requestAnimationFrame(() => {
      resetPageScroll();
      requestAnimationFrame(() => {
        resetPageScroll();
        const stage = $(".live-stage");
        if (stage && readingOverlay) {
          readingOverlay.style.top = Math.round(stage.getBoundingClientRect().bottom) + "px";
        }
      });
    });
    updatePlayerUI();
    window.setTimeout(reloadLiveVideo, 250);
  }

  function closeReading(restoreScroll) {
    if (readingOverlay) {
      readingOverlay.remove();
      readingOverlay = null;
    }
    state.reading = false;
    document.body.classList.remove("reading-mode");
    if (!state.fullscreen) window.setTimeout(reloadLiveVideo, 250);
    if (restoreScroll !== false) {
      const seg = segmentAt(state.current);
      if (seg) {
        const card = $("#seg-" + state.current);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  function updateSubtitleButton() {
    if (!fsUi) return;
    const btn = fsUi.querySelector('[data-fs="subtitle"]');
    if (!btn) return;
    btn.textContent = state.subtitlesOn ? "字幕 开" : "字幕 关";
    btn.classList.toggle("is-on", state.subtitlesOn);
  }

  function buildSubtitleCues() {
    const seg = segmentAt(state.current);
    let text = "";
    if (seg) {
      text = String(seg.transcript || "");
      if (!text && Array.isArray(seg.paragraphs)) text = seg.paragraphs.join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) { state.subtitleCues = []; return; }
    const raw = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [text];
    const chunks = [];
    for (const rawItem of raw) {
      const item = rawItem.trim();
      if (!item) continue;
      if (item.length <= 46) {
        chunks.push(item);
      } else {
        let sentence = "";
        for (const piece of item.split(/(?<=[，,：:、])/)) {
          if ((sentence + piece).length > 42 && sentence) { chunks.push(sentence); sentence = piece; }
          else sentence += piece;
        }
        if (sentence.trim()) chunks.push(sentence.trim());
      }
    }
    if (!chunks.length) { state.subtitleCues = []; return; }
    const total = chunks.reduce((n, item) => n + item.length, 0) || 1;
    let acc = 0;
    state.subtitleCues = chunks.map((item) => {
      const start = acc / total;
      acc += item.length;
      return { start, end: acc / total, text: item };
    });
  }

  function renderSubtitle() {
    if (!state.fullscreen || !fsUi) return;
    const subtitle = fsUi.querySelector(".fs-subtitle");
    if (!subtitle) return;
    if (!state.subtitlesOn) { subtitle.textContent = ""; return; }
    const cues = state.subtitleCues;
    if (!cues.length) { subtitle.textContent = ""; return; }
    const video = els.livePlayer;
    const duration = Number(video.duration) || 0;
    if (!duration) { subtitle.textContent = ""; return; }
    const fraction = Math.max(0, Math.min(0.9999, (Number(video.currentTime) || 0) / duration));
    let active = cues.find((cue) => fraction >= cue.start && fraction < cue.end);
    if (!active && fraction >= cues[cues.length - 1].start) active = cues[cues.length - 1];
    subtitle.textContent = active ? active.text : "";
  }

  function updateFullscreenMeta() {
    if (!fsUi) return;
    const title = fsUi.querySelector('[data-fs="title"]');
    const seg = segmentAt(state.current);
    if (title) title.textContent = seg ? (seg.title || "原片") : "原片";
  }

  function enterFullscreen(index) {
    if (!state.data) return;
    const want = Number.isFinite(index) && index >= 0
      ? Math.trunc(index)
      : (state.current >= 0 ? state.current : 0);
    if (!segmentAt(want)) return;
    closeBili();
    closeVideo();
    closeReading(false);
    if (state.current !== want || !hasLiveSource()) startSegment(want);
    else if (els.livePlayer.paused) els.livePlayer.play().catch(() => {});

    state.activeCues = applyLearningToCues(baseCuesFor(seg), seg);
    updateLearnUI(seg);

    if (hasNativeVideo()) {
      if (readingOverlay) { readingOverlay.remove(); readingOverlay = null; }
      state.reading = false;
      document.body.classList.remove("reading-mode", "native-reading");
      const fromTime = state.current === want ? (Number(els.livePlayer.currentTime) || 0) : 0;
      if (!openNativeForCurrent(segmentAt(want), true, fromTime)) return;
      state.fullscreen = true;
      document.body.classList.add("fs-open");
      document.body.style.overflow = "hidden";
      setImmersive(true);
      updatePlayerUI();
      return;
    }

    state.fullscreen = true;
    state.subtitlesOn = true;
    document.body.classList.add("fs-open");
    document.body.classList.remove("reading-mode");
    resetPageScroll();
    requestAnimationFrame(() => { resetPageScroll(); });
    const stage = $(".live-stage");
    if (fsUi) fsUi.remove();
    fsUi = document.createElement("div");
    fsUi.className = "fs-ui";
    fsUi.innerHTML = `
      <div class="fs-topline">
        <div class="fs-title-wrap">
          <span class="fs-kicker">央视《新闻联播》原片</span>
          <h3 data-fs="title"></h3>
        </div>
        <div class="fs-actions">
          <button type="button" class="fs-btn is-on" data-fs="subtitle">字幕 开</button>
          <button type="button" class="fs-btn" data-fs="close" aria-label="退出全屏">✕</button>
        </div>
      </div>
      <div class="fs-subtitle" aria-live="polite"></div>
      <div class="fs-footnote">全屏原片 · 自动字幕按该条央视原稿对齐</div>`;
    fsUi.querySelector('[data-fs="close"]').addEventListener("click", exitFullscreen);
    fsUi.querySelector('[data-fs="subtitle"]').addEventListener("click", toggleFullscreenSubtitles);
    if (stage) stage.appendChild(fsUi);
    updateSubtitleButton();
    updateFullscreenMeta();
    buildSubtitleCues();
    renderSubtitle();
    setImmersive(true);
    updatePlayerUI();
    window.setTimeout(reloadLiveVideo, 250);
  }

  function exitFullscreen() {
    if (!state.fullscreen) return;
    state.fullscreen = false;
    if (fsUi) { fsUi.remove(); fsUi = null; }
    document.body.classList.remove("fs-open");
    document.body.style.overflow = "";
    setImmersive(false);
    const seg = segmentAt(state.current);
    if (seg) {
      const card = $("#seg-" + state.current);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    window.setTimeout(reloadLiveVideo, 250);
    updatePlayerUI();
  }

  function toggleFullscreenSubtitles() {
    state.subtitlesOn = !state.subtitlesOn;
    updateSubtitleButton();
    if (state.subtitlesOn) renderSubtitle();
    else if (fsUi) {
      const subtitle = fsUi.querySelector(".fs-subtitle");
      if (subtitle) subtitle.textContent = "";
    }
  }

  window.handleAndroidBack = function handleAndroidBack() {
    if (state.fullscreen) { exitFullscreen(); return true; }
    if (state.reading) { closeReading(true); return true; }
    if (!els.biliModal.hidden) { closeBili(); return true; }
    if (!els.videoModal.hidden) { closeVideo(); return true; }
    return false;
  };

  // ------------------------------------------------------------------ modal video
  function openVideo(index) {
    const seg = segmentAt(index);
    if (!seg) return;
    pauseLive();
    const source = liveSource(seg);
    if (!source.src) { showToast("这一条的原片地址暂不可用"); return; }
    els.modalTitle.textContent = seg.title || "原片片段";
    els.modalVideo.src = source.src;
    els.modalVideo.play().catch(() => {});
    els.modalSourceLink.href = seg.url || "https://tv.cctv.com/lm/xwlb/";
    els.modalParts.textContent = source.hls ? "HLS 原片" : (source.parts.length > 1 ? `共 ${source.parts.length} 段` : ((seg.video || {}).quality || ""));
    els.videoModal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeVideo() {
    if (els.videoModal.hidden) return;
    els.videoModal.hidden = true;
    els.modalVideo.pause();
    els.modalVideo.removeAttribute("src");
    els.modalVideo.load();
    document.body.style.overflow = "";
  }

  // ------------------------------------------------------------------ bili modal
  function openBili(bvid, start, title, url) {
    if (!bvid) { showToast("没有找到这条 B 站视频"); return; }
    pauseLive();
    closeVideo();
    els.biliTitle.textContent = title || "UP 主原视频";
    els.biliMeta.textContent = `原视频原声 · 从 ${fmtClock(start)} 开始（按话题顺序估算）`;
    els.biliOpenLink.href = biliPageUrl(url, start);
    els.biliFrame.src = biliEmbedUrl(bvid, start);
    els.biliModal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeBili() {
    if (els.biliModal.hidden) return;
    els.biliModal.hidden = true;
    els.biliFrame.src = "about:blank";
    document.body.style.overflow = "";
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    els.refreshBtn.addEventListener("click", () => refresh({ firstRun: false }));
    els.listenAllBtn.addEventListener("click", () => startSegment(0));
    els.jumpHighlightsBtn.addEventListener("click", () => $("#highlightsSection").scrollIntoView({ behavior: "smooth", block: "start" }));
    els.playBtn.addEventListener("click", togglePlay);
    els.prevBtn.addEventListener("click", () => { if (state.data) startSegment(Math.max(0, state.current - 1)); });
    els.nextBtn.addEventListener("click", () => { if (state.data) startSegment(Math.min((state.data.segments || []).length - 1, state.current + 1)); });
    els.autoNextBtn.addEventListener("click", () => { state.autoNext = !state.autoNext; updatePlayerUI(); });
    els.liveFsBtn.addEventListener("click", () => enterFullscreen(state.current >= 0 ? state.current : 0));
    if (els.syncBtn) els.syncBtn.addEventListener("click", openSyncModal);
    if (els.closeSyncBtn) els.closeSyncBtn.addEventListener("click", closeSyncModal);
    if (els.syncModal) els.syncModal.addEventListener("click", (event) => { if (event.target === els.syncModal) closeSyncModal(); });
    if (els.syncMinusBtn) els.syncMinusBtn.addEventListener("click", () => setSyncOffset(state.syncOffset - 0.2));
    if (els.syncPlusBtn) els.syncPlusBtn.addEventListener("click", () => setSyncOffset(state.syncOffset + 0.2));
    if (els.syncResetBtn) els.syncResetBtn.addEventListener("click", () => setSyncOffset(0));
    if (els.syncSlider) els.syncSlider.addEventListener("input", () => setSyncOffset(Number(els.syncSlider.value) / 10));
    if (els.learnModeBtn) els.learnModeBtn.addEventListener("click", toggleLearnMode);
    if (els.clearLearnBtn) els.clearLearnBtn.addEventListener("click", () => resetLearning(segmentAt(state.current)));
    if (els.alignServerInput) {
      try { els.alignServerInput.value = localStorage.getItem(ALIGN_SERVER_KEY) || ""; } catch (_) { /* noop */ }
    }
    if (els.alignServerSave) els.alignServerSave.addEventListener("click", () => {
      try { localStorage.setItem(ALIGN_SERVER_KEY, (els.alignServerInput.value || "").trim()); } catch (_) { /* noop */ }
      showToast("已保存对齐服务器");
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-learn-toggle]")) { toggleLearnMode(); return; }
      if (!state.learnMode) return;
      const cue = event.target.closest(".reading-cue");
      if (!cue) return;
      event.preventDefault();
      event.stopPropagation();
      const seg = segmentAt(state.current);
      if (!seg) return;
      learnCueAt(seg, Number(cue.dataset.index), currentAudioSeconds());
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-sync-open]")) openSyncModal();
    });
    loadSyncOffset();
    applySyncUI();
    if (els.stageFsBtn) els.stageFsBtn.addEventListener("click", () => enterFullscreen(state.current >= 0 ? state.current : 0));
    els.rateBtn.addEventListener("click", () => {
      const rates = [1.0, 1.15, 0.9];
      state.rate = rates[(rates.indexOf(state.rate) + 1) % rates.length];
      els.livePlayer.playbackRate = state.rate;
      updatePlayerUI();
    });
    els.livePlayer.addEventListener("play", updatePlayerUI);
    els.livePlayer.addEventListener("pause", updatePlayerUI);
    els.livePlayer.addEventListener("ended", onLiveEnded);
    els.livePlayer.addEventListener("error", onLiveError);
    els.livePlayer.addEventListener("timeupdate", () => {
      const total = Number(els.livePlayer.duration) || 0;
      setProgress(Number(els.livePlayer.currentTime) || 0, total);
      renderSubtitle();
      renderLiveSubtitle();
    });
    els.livePlayer.addEventListener("loadedmetadata", () => {
      const total = Number(els.livePlayer.duration) || 0;
      setProgress(Number(els.livePlayer.currentTime) || 0, total);
      renderSubtitle();
      renderLiveSubtitle();
    });
    els.livePlayer.addEventListener("play", renderLiveSubtitle);
    els.livePlayer.addEventListener("pause", renderLiveSubtitle);
    els.closeVideoBtn.addEventListener("click", closeVideo);
    els.videoModal.addEventListener("click", (event) => { if (event.target === els.videoModal) closeVideo(); });
    els.closeBiliBtn.addEventListener("click", closeBili);
    els.biliModal.addEventListener("click", (event) => { if (event.target === els.biliModal) closeBili(); });
    els.playlist.addEventListener("click", (event) => {
      const track = event.target.closest(".track");
      if (!track) return;
      startSegment(Number(track.dataset.index));
    });
    document.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const index = Number(btn.dataset.index);
      if (action === "play") {
        if (state.playing && index === state.current) { pauseLive(); }
        else startSegment(index);
      } else if (action === "fullscreen" || action === "video") {
        enterFullscreen(index);
      } else if (action === "expand") {
        if (hasNativeVideo()) {
          openReading(index);
          return;
        }
        const box = $("#transcript-" + index);
        if (box) {
          box.hidden = !box.hidden;
          btn.textContent = box.hidden ? "文字稿" : "收起文字稿";
        }
      } else if (action === "bili") {
        openBili(btn.dataset.bvid, Number(btn.dataset.start) || 0, btn.dataset.title, btn.dataset.url);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (state.fullscreen) exitFullscreen();
      else if (state.reading) closeReading(true);
      else if (!els.videoModal.hidden) closeVideo();
      else if (!els.biliModal.hidden) closeBili();
    });
    window.addEventListener("resize", () => {
      if (state.reading && readingOverlay && !state.fullscreen) syncReadingLayout();
      if (readingSide) { readingSide.style.top = sideVideoHeight() + "px"; }
    });
    window.addEventListener("pagehide", () => {
      try { els.livePlayer.pause(); } catch (_) { /* noop */ }

      setImmersive(false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
