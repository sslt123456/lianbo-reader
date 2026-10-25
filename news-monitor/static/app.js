/* ============================================================
   联播夜读 · 前端交互
   文字板块 / 央视原片原声 / B站原视频联动
   ============================================================ */
(() => {
  "use strict";

  const state = {
    config: null,
    episode: null,
    dates: [],
    date: "",
    voice: "",
    current: -1,
    playing: false,
    videoHls: false,
    syncOffset: 0,
    learnMode: false,
    activeCues: [],
    audioCueCache: new Map(),
    vadProgress: null,
    vad: null,
    alignedCues: null,
    parts: [],
    partIndex: 0,
    manifest: {},
    monitor: null,
    latestKnown: "",
    refreshDate: "",
    pollingStatus: null,
    pollingAudio: null,
    lastStatusAt: 0,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
  const safeColor = (value) => (/^#[0-9a-f]{3,8}$/i.test(value || "") ? value : "#b31722");
  const fmtTime = (seconds) => {
    const sec = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  const clampText = (text, max = 260) => {
    const value = String(text || "");
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };
  const episodeDateLabel = (ep) => `${ep.month}月${ep.day}日`;

  // ------------------------------------------------ 原片 / B站原声定位
  function highQualityHls(url) {
    const value = String(url || "");
    if (!value) return "";
    if (value.indexOf("/hls/main/") >= 0) {
      return value.replace("/hls/main/", "/hls/1200/")
        .replace(/\/main\.m3u8(\?|$)/, "/1200.m3u8$1");
    }
    return value;
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

  function spokenChunks(segment) {
    let text = String(segment?.transcript || "");
    if (!text && Array.isArray(segment?.paragraphs)) text = segment.paragraphs.join(" ");
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

  function characterCues(segment) {
    const chunks = spokenChunks(segment);
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
        Vosk.createModel("/static/vendor/vosk/model.tar.gz")
          .then((model) => { voskModel = model; resolve(model); })
          .catch(reject);
      };
      if (window.Vosk) { finish(); return; }
      if (!voskScriptPromise) {
        voskScriptPromise = new Promise((res, rej) => {
          const script = document.createElement("script");
          script.src = "/static/vendor/vosk/vosk.js";
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

  function alignWordsToCues(segment, words, duration) {
    const chunks = spokenChunks(segment);
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
    const dp = new Float32Array((n + 1) * (m + 1));
    const ptr = new Uint8Array((n + 1) * (m + 1));
    const width = m + 1;
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
      if (dir === 0) {
        mapped[i - 1] = recTimes[j - 1];
        i--; j--;
      } else if (dir === 1) i--;
      else j--;
    }
    // 补齐未对齐字符：用左右最近的时间插值
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

  function audioParts(segment) {
    const parts = (segment?.video?.parts || []).filter(Boolean);
    if (parts.length) return parts;
    return [segment?.video?.mp4 || ""].filter(Boolean);
  }

  async function remoteAlignCues(segment) {
    const text = String(segment?.transcript || "").trim();
    const parts = audioParts(segment);
    if (!text || !parts.length) return null;
    try {
      const form = new FormData();
      for (let i = 0; i < parts.length; i++) {
        const media = await fetch(parts[i], { mode: "cors" });
        if (!media.ok) return null;
        form.append("files", await media.blob(), `part-${i}.mp4`);
      }
      form.append("text", text);
      const response = await fetch("/api/forced-align/upload", {
        method: "POST",
        body: form,
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
      const duration = parseDurationSeconds(segment.duration);
      const cues = alignWordsToCues(segment, words, duration);
      return cues && cues.length ? cues : null;
    } catch (err) {
      return null;
    }
  }

  async function recognizeSegmentWords(segment) {
    const parts = audioParts(segment);
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
      try { recognizer.remove(); } catch (err) { /* noop */ }
      try { ac.close(); } catch (err) { /* noop */ }
    }
    return allWords;
  }

  function alignedCacheKey(segment) {
    const source = (segment?.video?.parts || [])[0] || segment?.video?.mp4 || segment?.url || "";
    return "lianbo.aligned.v5." + String(segment?.id || "") + "." + String(source).slice(-80);
  }

  function loadAlignedCache(segment) {
    try {
      const raw = localStorage.getItem(alignedCacheKey(segment));
      const cues = raw ? JSON.parse(raw) : null;
      return Array.isArray(cues) && cues.length ? cues : null;
    } catch (_) { return null; }
  }

  function ensureAlignedCues(segment) {
    if (!segment || segment._alignPromise || segment._alignedCues) return;
    const alignStatus = $("#alignStatus");
    const cached = loadAlignedCache(segment);
    if (cached) {
      segment._alignedCues = cached;
      if (alignStatus) alignStatus.textContent = "已校准";
      if (state.current >= 0 && state.episode?.segments?.[state.current] === segment) {
        state.alignedCues = cached;
        state.activeCues = applyLearningToCues(cached, segment);
        state.vadProgress = null;
        updateTranscriptHighlight();
        updateVideoCaption();
      }
      return;
    }
    if (alignStatus) alignStatus.textContent = "语音校准中…";
    segment._alignPromise = (async () => {
      const remote = await remoteAlignCues(segment);
      let cues = remote;
      if (!cues || !cues.length) {
        const words = await recognizeSegmentWords(segment);
        const duration = parseDurationSeconds(segment.duration);
        cues = alignWordsToCues(segment, words, duration);
      }
      if (!cues || !cues.length) return;
      segment._alignedCues = cues;
      try { localStorage.setItem(alignedCacheKey(segment), JSON.stringify(cues)); } catch (err) { /* noop */ }
      if (alignStatus) alignStatus.textContent = "已校准";
      if (state.current >= 0 && state.episode?.segments?.[state.current] === segment) {
        state.alignedCues = cues;
        state.activeCues = applyLearningToCues(cues, segment);
        state.vadProgress = null;
        updateTranscriptHighlight();
        updateVideoCaption();
      }
    })().catch(() => {}).finally(() => { segment._alignPromise = null; });
  }

  function buildTranscriptCues(segment) {
    const chunks = spokenChunks(segment);
    if (!chunks.length) return [];
    const weighted = chunks.map((item) => ({
      text: item.text,
      weight: item.chars + syncPauseSeconds(item.text) * SYNC_PAUSE_FACTOR,
    }));
    const total = weighted.reduce((n, item) => n + item.weight, 0) || 1;
    let acc = 0;
    return weighted.map((item) => {
      const start = acc / total;
      acc += item.weight;
      return { text: item.text, start, end: acc / total };
    });
  }

  function parseDurationSeconds(text) {
    const parts = String(text || "").trim().split(":").map((x) => Number(x));
    if (!parts.length || parts.some((x) => Number.isNaN(x))) return 0;
    return parts.reduce((total, item) => total * 60 + item, 0);
  }

  let analysisAudioContext = null;

  async function analyzeAudioCues(segment) {
    const sourceUrl = segment?.video?.mp4 || (segment?.video?.parts || [])[0] || "";
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
    const merged = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last && interval[0] - last[1] <= 0.22) last[1] = interval[1];
      else merged.push(interval.slice());
    }
    const totalSpeech = merged.reduce((n, item) => n + (item[1] - item[0]), 0);
    if (totalSpeech < 2) return null;
    const duration = parseDurationSeconds(segment.duration) || audio.duration || 0;
    if (!duration) return null;
    const chunks = spokenChunks(segment);
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

  function getSegmentCues(segment) {
    if (!segment) return [];
    if (Array.isArray(segment._audioCues) && segment._audioCues.length) return segment._audioCues;
    return buildTranscriptCues(segment);
  }

  function ensureAudioCues(segment) {
    if (!segment || segment._audioCuesPromise) return;
    const sourceUrl = segment?.video?.mp4 || (segment?.video?.parts || [])[0];
    if (!sourceUrl) return;
    if (state.audioCueCache.has(sourceUrl)) {
      segment._audioCues = state.audioCueCache.get(sourceUrl);
      return;
    }
    segment._audioCuesPromise = analyzeAudioCues(segment).then((cues) => {
      if (!cues || !cues.length) return;
      segment._audioCues = cues;
      state.audioCueCache.set(sourceUrl, cues);
      if (state.current >= 0 && state.episode?.segments?.[state.current] === segment) {
        state.activeCues = cues;
        updateTranscriptHighlight();
        updateVideoCaption();
      }
    }).catch(() => {}).finally(() => { segment._audioCuesPromise = null; });
  }

  function transcriptCueHtml(segment) {
    const cues = characterCues(segment);
    if (!cues.length) return "";
    return `<p class="transcript-cue-line">${cues.map((cue, index) =>
      `<span class="transcript-cue" data-index="${index}" data-start="${cue.start.toFixed(6)}" data-end="${cue.end.toFixed(6)}">${esc(cue.text)}</span>`
    ).join(" ")}</p>`;
  }

  const SYNC_OFFSET_KEY = "lianbo.desktop.sync.offset.v2";

  function loadSyncOffset() {
    try {
      const value = Number(localStorage.getItem(SYNC_OFFSET_KEY));
      if (Number.isFinite(value)) state.syncOffset = Math.max(-2, Math.min(2, value));
    } catch (err) { /* noop */ }
  }

  function formatSyncOffset(value) {
    if (Math.abs(value) < 0.05) return "0.0s";
    return `${value > 0 ? "延后 " : "提前 "}${Math.abs(value).toFixed(1)}s`;
  }

  function applySyncUI() {
    const value = $("#syncValue");
    if (value) value.textContent = formatSyncOffset(state.syncOffset);
  }

  function setSyncOffset(value) {
    state.syncOffset = Math.max(-2, Math.min(2, Math.round(value * 10) / 10));
    try {
      localStorage.removeItem("lianbo.desktop.sync.offset.v1");
      localStorage.setItem(SYNC_OFFSET_KEY, String(state.syncOffset));
    } catch (err) { /* noop */ }
    applySyncUI();
    updateTranscriptHighlight();
    updateVideoCaption();
  }

  function syncFraction(fraction, duration) {
    return Math.max(0, Math.min(0.9999, fraction - state.syncOffset / Math.max(1, duration || 1)));
  }

  const LEARNING_KEY = "lianbo.learning.v1.";

  function learningKey(segment) {
    const source = (segment?.video?.parts || [])[0] || segment?.video?.mp4 || segment?.url || "";
    return LEARNING_KEY + String(segment?.id || "") + "." + String(source).slice(-80);
  }

  function readLearning(segment) {
    try {
      const raw = localStorage.getItem(learningKey(segment));
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.anchors)) return data;
    } catch (err) { /* noop */ }
    return { anchors: [] };
  }

  function writeLearning(segment, data) {
    try { localStorage.setItem(learningKey(segment), JSON.stringify(data)); } catch (err) { /* noop */ }
  }

  function applyLearningToCues(baseCues, segment) {
    const anchors = readLearning(segment).anchors
      .filter((a) => Number.isFinite(Number(a.cueIndex)) && Number.isFinite(Number(a.timeSec)))
      .map((a) => ({ cueIndex: Math.max(0, Math.round(Number(a.cueIndex))), timeSec: Number(a.timeSec), count: Number(a.count) || 1 }))
      .filter((a) => a.cueIndex < baseCues.length);
    if (!anchors.length) return baseCues;
    const duration = parseDurationSeconds(segment?.duration) || Number($("#clipVideo")?.duration) || 0;
    if (!duration) return baseCues;
    const points = [];
    for (const anchor of anchors) {
      const baseStart = (Number(baseCues[anchor.cueIndex].start) || 0) * duration;
      const point = { index: anchor.cueIndex, delta: anchor.timeSec - baseStart };
      const existing = points.find((p) => p.index === point.index);
      if (existing) { existing.delta = (existing.delta + point.delta) / 2; }
      else points.push(point);
    }
    points.sort((a, b) => a.index - b.index);
    const deltaAt = (index) => {
      if (points.length === 1) return points[0].delta;
      if (index <= points[0].index) return points[0].delta;
      if (index >= points[points.length - 1].index) return points[points.length - 1].delta;
      for (let i = 1; i < points.length; i++) {
        if (index <= points[i].index) {
          const left = points[i - 1], right = points[i];
          const span = Math.max(1, right.index - left.index);
          return left.delta + (right.delta - left.delta) * ((index - left.index) / span);
        }
      }
      return 0;
    };
    const starts = baseCues.map((cue, index) => {
      let value = (Number(cue.start) || 0) * duration + deltaAt(index);
      return Math.max(0, Math.min(duration - 0.001, value));
    });
    for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 0.001);
    for (let i = starts.length - 1; i >= 0; i--) starts[i] = Math.min(starts[i], duration - 0.001 * (starts.length - i));
    return baseCues.map((cue, index) => ({
      ...cue,
      start: starts[index] / duration,
      end: (index + 1 < starts.length ? starts[index + 1] : duration) / duration,
    }));
  }

  function updateLearnUI(segment) {
    const seg = segment || (state.episode && state.current >= 0 ? state.episode.segments[state.current] : null);
    const anchors = seg ? readLearning(seg).anchors : [];
    const status = $("#learnStatus");
    if (status) status.textContent = anchors.length ? `已学习 ${anchors.length} 处` : "";
    const btn = $("#learnBtn");
    if (btn) {
      btn.classList.toggle("is-on", state.learnMode);
      btn.textContent = state.learnMode ? "取消点句" : "点句校准";
    }
    document.body.classList.toggle("learning-mode", state.learnMode);
  }

  function exitLearnMode() {
    state.learnMode = false;
    updateLearnUI();
  }

  function toggleLearnMode() {
    if (state.current < 0) { toast("先播放一条原片，再点句校准", "error"); return; }
    state.learnMode = !state.learnMode;
    updateLearnUI();
    if (state.learnMode) toast("点一下音频正在读的文字稿句子（最好在句子刚开头时点）");
  }

  function applyLearningNow(segment) {
    if (!segment) return;
    const base = segment._alignedCues || characterCues(segment);
    state.activeCues = applyLearningToCues(base, segment);
    if (segment._alignedCues) state.alignedCues = segment._alignedCues;
    updateTranscriptHighlight();
    updateVideoCaption();
    updateLearnUI(segment);
  }

  function learnCueAt(segment, cueIndex, timeSec) {
    if (!segment) return;
    const data = readLearning(segment);
    const existing = data.anchors.find((a) => Math.round(Number(a.cueIndex)) === cueIndex);
    if (existing) {
      const count = Math.max(1, Number(existing.count) || 1);
      existing.timeSec = (Number(existing.timeSec) * count + timeSec) / (count + 1);
      existing.count = count + 1;
    } else {
      data.anchors.push({ cueIndex, timeSec, count: 1 });
    }
    data.anchorCount = data.anchors.length;
    data.updatedAt = Date.now();
    writeLearning(segment, data);
    applyLearningNow(segment);
    exitLearnMode();
    const mm = Math.floor(timeSec / 60), ss = Math.round(timeSec % 60).toString().padStart(2, "0");
    toast(`已学习：第 ${cueIndex + 1} 句对应 ${mm}:${ss}`);
  }

  function resetLearning(segment) {
    if (!segment) return;
    try { localStorage.removeItem(learningKey(segment)); } catch (err) { /* noop */ }
    applyLearningNow(segment);
    toast("已清除本段的点句校准");
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

  function ensureVad() {
    if (state.vad) return state.vad;
    const video = $("#clipVideo");
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!video || !Ctor) return null;
    try {
      const ac = new Ctor();
      const source = ac.createMediaElementSource(video);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      const gain = ac.createGain();
      gain.gain.value = 1;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ac.destination);
      state.vad = {
        ac, analyser, gain, data: new Float32Array(analyser.fftSize),
        threshold: 0.012, calibration: [], speechTime: 0,
        lastAt: performance.now(), hangUntil: 0, lastVideoTime: 0,
        totalSpeech: 0, ratio: 0.8, speaking: false, speechStart: null,
        intervals: [], segmentId: null
      };
      ac.resume().catch(() => {});
      setInterval(vadTick, 80);
      return state.vad;
    } catch (err) {
      console.warn("VAD unavailable", err);
      return null;
    }
  }

  function resetVad(segment, index) {
    state.vadProgress = null;
    if (!state.vad) return;
    const duration = parseDurationSeconds(segment?.duration) || Number($("#clipVideo")?.duration) || 0;
    state.vad.segmentId = segment?.id || String(index);
    state.vad.ratio = 0.8;
    state.vad.totalSpeech = Math.max(1, duration * state.vad.ratio);
    state.vad.speechTime = 0;
    state.vad.calibration = [];
    state.vad.threshold = 0.012;
    state.vad.lastAt = performance.now();
    state.vad.hangUntil = 0;
    state.vad.lastVideoTime = 0;
    state.vad.speaking = false;
    state.vad.speechStart = null;
    state.vad.intervals = [];
    state.vadProgress = 0;
  }

  function speechTimeAt(vad, target) {
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

  function vadTick() {
    const vad = state.vad;
    const video = $("#clipVideo");
    if (!vad || !video) return;
    const now = performance.now();
    const dt = Math.min(0.2, Math.max(0, (now - vad.lastAt) / 1000));
    vad.lastAt = now;
    if (video.paused || video.ended) return;
    const duration = Number(video.duration) || 0;
    if (!duration) return;

    // 跳转：已经听过的区域用 VAD 记录精确回算；没听过的区域按已测得的语音占比估算。
    if (Math.abs(video.currentTime - vad.lastVideoTime - dt) > 0.45) {
      if (vad.speaking) {
        if (vad.speechStart != null) vad.intervals.push([vad.speechStart, vad.lastVideoTime]);
      }
      vad.speaking = false;
      vad.speechStart = null;
      const target = video.currentTime;
      const recordedEnd = vad.intervals.length ? vad.intervals[vad.intervals.length - 1][1] : 0;
      vad.speechTime = target <= recordedEnd + 0.15
        ? speechTimeAt(vad, target)
        : target * vad.ratio;
      vad.totalSpeech = Math.max(1, duration * vad.ratio);
      vad.calibration = [];
      vad.hangUntil = 0;
    }
    vad.lastVideoTime = video.currentTime;
    if (vad.gain) vad.gain.gain.value = video.muted ? 0 : Math.max(0.001, video.volume || 1);
    if (video.muted || video.volume === 0) {
      state.vadProgress = Math.max(0, Math.min(1, syncFraction(video.currentTime / duration, duration)));
      updateTranscriptHighlight();
      updateVideoCaption();
      return;
    }
    vad.analyser.getFloatTimeDomainData(vad.data);
    let sum = 0;
    for (let i = 0; i < vad.data.length; i++) {
      const value = vad.data[i];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / vad.data.length);
    vad.calibration.push(rms);
    if (vad.calibration.length > 120) vad.calibration.shift();
    if (vad.calibration.length >= 15) {
      const sorted = vad.calibration.slice().sort((a, b) => a - b);
      const p20 = sorted[Math.floor(sorted.length * 0.2)] || 0;
      vad.threshold = Math.max(0.012, Math.min(0.04, p20 * 1.7));
    }
    // 双阈值 + 短暂保持：起音用高阈值，连续说话时用低阈值，避免气口/轻音导致速度忽快忽慢。
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
    // 实时学习本片的“有声占比”，跳转锚点和总时长都用它，避免固定 0.8 造成时快时慢。
    if (video.currentTime > 6) {
      const observed = vad.speechTime / Math.max(1, video.currentTime);
      if (observed > 0.55 && observed < 0.98) {
        vad.ratio = Math.max(0.55, Math.min(0.95, vad.ratio * 0.97 + observed * 0.03));
        vad.totalSpeech = Math.max(1, duration * vad.ratio);
      }
    }
    const progress = Math.max(0, Math.min(1, (vad.speechTime - state.syncOffset) / vad.totalSpeech));
    state.vadProgress = progress;
    updateTranscriptHighlight();
    updateVideoCaption();
  }

  function updateTranscriptHighlight() {
    const video = $("#clipVideo");
    if (video?.seeking) return;
    const duration = Number(video?.duration) || 0;
    if (!duration || state.current < 0) return;
    const card = $(`.segment-card[data-segment-index="${state.current}"]`);
    if (!card) return;
    const cueEls = card.querySelectorAll(".transcript-cue");
    if (!cueEls.length) return;
    const cues = state.activeCues && state.activeCues.length
      ? state.activeCues
      : characterCues(state.episode.segments[state.current]);
    const fraction = syncFraction((Number(video.currentTime) || 0) / duration, duration);
    let activeIndex = cueIndexAt(cues, fraction);
    let active = null;
    cueEls.forEach((el) => {
      const on = Number(el.dataset.index) === activeIndex;
      el.classList.toggle("active", on);
      if (on) active = el;
    });
    if (active && active !== card._activeCue) {
      card._activeCue = active;
      const box = card.querySelector(".segment-transcript");
      if (box && card.classList.contains("expanded")) {
        const top = active.offsetTop - box.clientHeight * 0.42;
        box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    }
  }

  function parseDurationText(text) {
    const value = String(text || "").trim();
    if (!value) return 0;
    const parts = value.split(":").map((x) => Number(x));
    if (parts.some((x) => Number.isNaN(x))) return 0;
    return parts.reduce((total, item) => total * 60 + item, 0);
  }

  function bvidFromUrl(url) {
    const m = String(url || "").match(/(BV[0-9A-Za-z]{8,})/);
    return m ? m[1] : "";
  }

  function biliPageUrl(url, start) {
    const bvid = bvidFromUrl(url);
    const base = bvid ? `https://www.bilibili.com/video/${bvid}` : String(url || "https://www.bilibili.com/");
    const t = Math.max(0, Math.round(Number(start) || 0));
    return `${base}${base.includes("?") ? "&" : "?"}t=${t}`;
  }

  function biliEmbedUrl(bvid, start) {
    const t = Math.max(0, Math.round(Number(start) || 0));
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}`
      + `&autoplay=1&danmaku=0&high_quality=1&t=${t}`;
  }

  function videoTopicList(video) {
    const title = String(video?.title || "");
    const tail = title.includes("：") ? title.split("：").slice(1).join("：") : title;
    let topics = tail.split(/[、,，;；|/\s]+/)
      .map((x) => x.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+|[^\u4e00-\u9fa5A-Za-z0-9]+$/g, ""))
      .filter((x) => x.length >= 2);
    if (topics.length < 2) {
      topics = String(video?.desc || "").split(/[\n。；;]+/).map((x) => x.trim()).filter((x) => x.length >= 4);
    }
    return topics;
  }

  // B站没有公开字幕/章节时间码；按标题/简介中的话题顺序估算原视频中的位置。
  function estimateBiliStart(video, terms) {
    if (!video) return 0;
    const total = parseDurationText(video.duration);
    if (!total) return 0;
    const topics = videoTopicList(video);
    const clean = (terms || []).map((x) => String(x || "").trim()).filter((x) => x.length >= 2);
    let found = -1;
    for (const term of clean) {
      for (let i = 0; i < topics.length; i += 1) {
        if (topics[i].includes(term) || term.includes(topics[i])) { found = i; break; }
      }
      if (found >= 0) break;
    }
    if (found < 0) {
      const haystack = `${video.title || ""}\n${video.desc || ""}`;
      for (const term of clean) {
        const pos = haystack.indexOf(term);
        if (pos >= 0) {
          found = (pos / Math.max(1, haystack.length)) * Math.max(1, topics.length);
          break;
        }
      }
    }
    if (found < 0) return 0;
    const ratio = (Math.max(0, found) + 0.5) / Math.max(1, topics.length);
    return Math.max(0, Math.round(total * Math.min(0.9, ratio * 0.86)));
  }

  function findUpVideoForBvid(bvid) {
    for (const up of state.episode?.ups || []) {
      for (const video of up.selected || []) {
        if (video.bvid === bvid) return video;
      }
    }
    return null;
  }

  function takeBiliInfo(take) {
    const bvid = take.bvid || bvidFromUrl(take.url);
    if (!bvid) return { bvid: "", start: 0, label: "0:00", url: take.url || "" };
    const video = findUpVideoForBvid(bvid) || { title: take.video_title || "", duration: "", desc: "" };
    const terms = (take.matched_terms || []).concat([take.quote || ""]).filter(Boolean);
    const start = estimateBiliStart(video, terms);
    return {
      bvid,
      start,
      label: fmtTime(start),
      url: take.url || video.url || "",
    };
  }

  function biliButtonAttrs(info, title) {
    return `data-bili-play="1" data-bvid="${esc(info.bvid)}" data-start="${info.start}" data-title="${esc(title || "")}" data-url="${esc(info.url || "")}"`;
  }

  function openBiliModal(bvid, start, title, url) {
    if (!bvid) { toast("这条没有可用的 B 站视频", "error"); return; }
    pauseVideo();
    $("#biliTitle").textContent = title || "UP 主原视频";
    $("#biliMeta").textContent = `原视频原声 · 从 ${fmtTime(start)} 开始（按话题顺序估算）`;
    $("#biliOpenLink").href = biliPageUrl(url, start);
    $("#biliFrame").src = biliEmbedUrl(bvid, start);
    $("#biliModal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeBiliModal() {
    if ($("#biliModal").hidden) return;
    $("#biliModal").hidden = true;
    $("#biliFrame").src = "about:blank";
    document.body.style.overflow = "";
  }

  async function api(path, options = {}) {
    const opts = { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } };
    const response = await fetch(path, opts);
    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, type = "info", duration = 3600) {
    const stack = $("#toastStack");
    if (!stack) return;
    const node = document.createElement("div");
    node.className = `toast ${type === "error" ? "error" : type === "success" ? "success" : ""}`;
    node.textContent = message;
    stack.appendChild(node);
    window.setTimeout(() => {
      node.classList.add("out");
      window.setTimeout(() => node.remove(), 280);
    }, duration);
  }

  // ------------------------------------------------------------ boot
  async function init() {
    bindStaticEvents();
    initWaveform();
    try {
      const [config, datesPayload] = await Promise.all([api("/api/config"), api("/api/dates")]);
      state.config = config;
      state.voice = config.default_voice;
      state.monitor = datesPayload.monitor;
      state.dates = datesPayload.dates || [];
      state.latestKnown = datesPayload.latest_known || "";
      fillConfig(config);
      updateMonitor(datesPayload.monitor || {});
      const initialDate = state.dates[0]?.date || datesPayload.latest_known || config.today;
      if (initialDate) {
        $("#dateInput").value = initialDate;
        await loadEpisode(initialDate, { initial: true });
      } else {
        showLoading("首次启动，正在从央视网抓取最新一期…");
      }
      await pollStatus();
      window.setInterval(pollStatus, 30000);
    } catch (err) {
      console.error(err);
      showEmpty(err.message || "服务暂时无法连接");
    }
  }

  function fillConfig(config) {
    $("#monitorTimeInline").textContent = config.monitor_time || "19:35";
  }

  function bindStaticEvents() {
    $("#prevDateBtn").addEventListener("click", () => stepDate(1));
    $("#nextDateBtn").addEventListener("click", () => stepDate(-1));
    $("#loadDateBtn").addEventListener("click", () => loadDateFromInput());
    $("#dateInput").addEventListener("change", () => loadDateFromInput());
    $("#refreshBtn").addEventListener("click", refreshCurrent);
    $("#emptyRefreshBtn").addEventListener("click", refreshCurrent);
    $("#emptyReloadBtn").addEventListener("click", () => {
      const date = $("#emptyReloadBtn").dataset.date || $("#dateInput").value || state.date;
      if (date) loadEpisode(date);
    });
    $("#heroPlayBtn").addEventListener("click", () => playSegment(0));
    $("#jumpHighlights").addEventListener("click", () => {
      $("#highlights").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#mainPlayBtn").addEventListener("click", togglePlay);
    $("#prevBtn").addEventListener("click", () => playSegment(Math.max(0, state.current - 1)));
    $("#nextBtn").addEventListener("click", () => playSegment(Math.min((state.episode?.segments.length || 1) - 1, state.current + 1)));
    $("#audioSeek").addEventListener("input", seekVideo);
    $("#unmuteBtn").addEventListener("click", toggleMute);
    $("#fullscreenBtn").addEventListener("click", () => {
      const stage = $(".video-stage");
      if (!stage) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (stage.requestFullscreen) {
        stage.requestFullscreen().catch(() => {});
      }
    });
    $("#autoNext").addEventListener("change", () => {});
    $("#syncMinusBtn").addEventListener("click", () => setSyncOffset(state.syncOffset - 0.2));
    $("#syncPlusBtn").addEventListener("click", () => setSyncOffset(state.syncOffset + 0.2));
    $("#syncResetBtn").addEventListener("click", () => setSyncOffset(0));
    $("#learnBtn").addEventListener("click", toggleLearnMode);
    $("#learnResetBtn").addEventListener("click", () => resetLearning(state.episode && state.current >= 0 ? state.episode.segments[state.current] : null));
    document.addEventListener("click", (event) => {
      if (!state.learnMode) return;
      const span = event.target.closest(".transcript-cue");
      if (!span) return;
      event.preventDefault();
      event.stopPropagation();
      const segment = state.episode && state.current >= 0 ? state.episode.segments[state.current] : null;
      const video = $("#clipVideo");
      if (!segment || !video || !Number(video.duration)) return;
      learnCueAt(segment, Number(span.dataset.index), Number(video.currentTime) || 0);
    });
    loadSyncOffset();
    applySyncUI();

    const video = $("#clipVideo");
    video.addEventListener("ended", onVideoPartEnded);
    video.addEventListener("timeupdate", () => {
      updateAudioProgress();
      updateTranscriptHighlight();
      updateVideoCaption();
    });
    video.addEventListener("loadedmetadata", () => { updateTranscriptHighlight(); updateVideoCaption(); });
    video.addEventListener("loadedmetadata", updateAudioProgress);
    video.addEventListener("play", () => {
      setPlayingUI(true);
      setAudioStatus("ready", "原片原声播放中");
      $("#videoBadge").classList.add("live");
      updateVideoCaption();
    });
    video.addEventListener("pause", () => {
      if (!video.ended) {
        setPlayingUI(false);
        setAudioStatus("", "已暂停");
      }
      $("#videoBadge").classList.remove("live");
      updateVideoCaption();
    });
    video.addEventListener("waiting", () => setAudioStatus("busy", "原片加载中…"));
    video.addEventListener("playing", () => setAudioStatus("ready", "原片原声播放中"));
    video.addEventListener("error", onVideoError);

    $("#closeBiliBtn").addEventListener("click", closeBiliModal);
    $("#biliModal").addEventListener("click", (event) => {
      if (event.target === $("#biliModal")) closeBiliModal();
    });
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-bili-play]");
      if (!target) return;
      openBiliModal(target.dataset.bvid, Number(target.dataset.start) || 0, target.dataset.title, target.dataset.url);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeBiliModal();
    });
  }

  function initWaveform() {
    const box = $("#waveform");
    if (!box) return;
    const heights = [8, 13, 19, 12, 24, 16, 9, 21, 28, 15, 10, 18, 25, 13, 20, 9, 16, 23, 12, 18, 27, 14, 10, 22];
    box.innerHTML = heights.map((h, i) => `<i style="--h:${h}px;--d:${(i * 0.035).toFixed(2)}s"></i>`).join("");
  }

  // ------------------------------------------------------------ data load
  async function loadEpisode(date, options = {}) {
    if (!date) return;
    const targetDate = String(date);
    $("#dateInput").value = targetDate;
    state.date = targetDate;
    stopPlayback();
    showLoading(`正在载入 ${targetDate} 的联播简报…`);
    try {
      const payload = await api(`/api/episode?date=${encodeURIComponent(targetDate)}`);
      state.episode = payload;
      state.manifest = {};
      if (payload.cached_dates) state.dates = payload.cached_dates.map((d) => ({ date: d }));
      renderEpisode(payload);
      showContent();
      updateDateButtons();
      if (options.initial) {
        $("#page").dataset.ready = "1";
      }
    } catch (err) {
      if (err.status === 404) {
        showEmpty(err.message || "这一天还没有简报", { date: targetDate, refreshable: true });
        maybeAutoFetch(targetDate);
      } else {
        showEmpty(err.message || "载入失败，请检查本地服务");
      }
    }
  }

  async function maybeAutoFetch(date) {
    try {
      await api("/api/refresh", { method: "POST", body: JSON.stringify({ date }) });
      state.refreshDate = date;
      showLoading(`正在抓取 ${date} 的内容，首次大约需要 20–60 秒…`);
      pollRefreshUntilDone(date);
    } catch (err) {
      if (err.status === 404) showEmpty(err.message);
    }
  }

  async function loadDateFromInput() {
    const date = $("#dateInput").value;
    if (!date) return;
    if (date === state.date && state.episode) return;
    await loadEpisode(date);
  }

  function stepDate(direction) {
    if (!state.dates.length) return;
    const sorted = [...state.dates].sort((a, b) => (a.date < b.date ? 1 : -1));
    const currentIndex = sorted.findIndex((item) => item.date === (state.date || $("#dateInput").value));
    let nextIndex;
    if (currentIndex < 0) nextIndex = 0;
    else nextIndex = Math.min(sorted.length - 1, Math.max(0, currentIndex + direction));
    const next = sorted[nextIndex];
    if (next && next.date !== state.date) loadEpisode(next.date);
  }

  function updateDateButtons() {
    const sorted = [...state.dates].sort((a, b) => (a.date < b.date ? 1 : -1));
    const index = sorted.findIndex((item) => item.date === state.date);
    $("#prevDateBtn").disabled = index < 0 || index >= sorted.length - 1;
    $("#nextDateBtn").disabled = index <= 0;
    $("#prevDateBtn").title = index >= 0 && index < sorted.length - 1 ? `更早：${sorted[index + 1].date}` : "没有更早缓存";
    $("#nextDateBtn").title = index > 0 ? `更新：${sorted[index - 1].date}` : "没有更新缓存";
  }

  async function pollStatus() {
    try {
      const payload = await api("/api/status");
      state.monitor = payload.monitor || state.monitor;
      state.latestKnown = payload.latest_known || state.latestKnown;
      updateMonitor(state.monitor);
      const cached = payload.cached_dates || [];
      if (cached.length) {
        state.dates = cached.map((d) => ({ date: d.date }));
        updateDateButtons();
      }
      if (!state.episode && cached.length) {
        await loadEpisode(cached[0].date, { initial: true });
      } else if (!state.episode && !cached.length) {
        const jobs = Object.values(payload.refresh_jobs || {});
        const active = jobs.find((job) => job.status === "running");
        if (active && active.step) {
          $("#loadingText").textContent = active.step;
        } else if (!state.refreshDate) {
          const last = jobs.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))[0];
          if (last && (last.status === "waiting" || last.status === "error")) {
            showEmpty(last.error || "暂时还没有可展示的简报", { date: last.date, refreshable: true });
          }
        }
      }
      const runningRefresh = Object.values(payload.refresh_jobs || {}).filter((job) => job.status === "running");
      updateRefreshButton(runningRefresh);
    } catch (err) {
      // 静默失败，下一轮重试
    }
  }

  function updateMonitor(monitor) {
    const pill = $("#monitorPill");
    const text = $("#monitorText");
    if (!monitor) return;
    const message = monitor.message || "监控运行中";
    text.textContent = `${monitor.time || state.config?.monitor_time || "19:35"} 监控 · ${message}`;
    pill.classList.remove("warn", "error");
    if (monitor.last_error) {
      pill.classList.add(/失败|异常/.test(monitor.last_error) ? "error" : "warn");
    }
  }

  function updateRefreshButton(runningJobs) {
    const btn = $("#refreshBtn");
    const running = (runningJobs || []).find((job) => job.status === "running" && job.date === (state.date || state.refreshDate));
    if (running) {
      btn.disabled = true;
      btn.classList.add("loading");
      btn.querySelector("span").textContent = running.step || "抓取中…";
    } else {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.querySelector("span").textContent = "立即抓取";
    }
  }

  async function refreshCurrent() {
    const target = state.date || $("#dateInput").value || state.config?.today;
    if (!target) return;
    if (state.refreshDate) {
      toast("已有抓取任务进行中，请稍候", "info", 2200);
      return;
    }
    const btn = $("#refreshBtn");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.querySelector("span").textContent = "开始抓取…";
    try {
      const payload = await api("/api/refresh", { method: "POST", body: JSON.stringify({ date: target }) });
      state.refreshDate = payload.refresh?.date || target;
      toast(`开始抓取 ${state.refreshDate} 的新闻联播…`, "info", 2600);
      pollRefreshUntilDone(state.refreshDate);
    } catch (err) {
      toast(err.message || "抓取启动失败", "error");
      resetRefreshButton();
    }
  }

  async function pollRefreshUntilDone(date) {
    if (state.pollingStatus) window.clearInterval(state.pollingStatus);
    const started = Date.now();
    let lastStep = "";

    const finish = (kind) => {
      if (state.pollingStatus) window.clearInterval(state.pollingStatus);
      state.pollingStatus = null;
      state.refreshDate = "";
      resetRefreshButton();
      return kind;
    };

    const tick = async () => {
      if (Date.now() - started > 190000) {
        finish();
        toast("抓取超时，请稍后重试", "error", 4200);
        return;
      }
      try {
        const payload = await api("/api/status");
        const job = (payload.refresh_jobs || {})[date];
        if (job?.step && job.step !== lastStep) {
          lastStep = job.step;
          $("#loadingText").textContent = job.step;
        }
        const cached = (payload.cached_dates || []).some((item) => item.date === date);
        const status = job?.status;
        if (status === "running") return;
        if (status === "done" || (!status && cached)) {
          finish();
          await loadEpisode(date);
          toast("简报已更新", "success");
          return;
        }
        if (status === "waiting") {
          finish();
          if (state.episode && state.episode.date === date) {
            toast(job.error || "节目尚未发布，稍后会自动重试", "info", 4200);
          } else {
            showEmpty(job.error || "今日新闻联播尚未发布，稍后自动重试", { date, refreshable: true });
            toast(job.error || "节目尚未发布，稍后自动重试", "info", 4200);
          }
          return;
        }
        if (status === "error") {
          finish();
          toast(job.error || "抓取失败", "error", 5200);
          if (state.episode && state.episode.date === date) return;
          showEmpty(job.error || "抓取失败");
          return;
        }
        // 服务刚重启、任务记录丢失时，如果已有缓存则直接载入
        if (!status && cached) {
          finish();
          await loadEpisode(date);
          return;
        }
      } catch (err) {
        // 下一轮重试
      }
    };
    await tick();
    if (!state.pollingStatus && (state.refreshDate || !state.episode)) {
      state.pollingStatus = window.setInterval(tick, 2200);
    } else if (state.pollingStatus === undefined) {
      state.pollingStatus = window.setInterval(tick, 2200);
    }
  }

  function resetRefreshButton() {
    const btn = $("#refreshBtn");
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.querySelector("span").textContent = "立即抓取";
  }

  // ------------------------------------------------------------ render
  function showLoading(text) {
    hideContent();
    $("#emptyState").hidden = true;
    $("#loadingState").hidden = false;
    if (text) $("#loadingText").textContent = text;
  }

  function showEmpty(message, options = {}) {
    hideContent();
    $("#loadingState").hidden = true;
    const empty = $("#emptyState");
    empty.hidden = false;
    $("#emptyText").textContent = message || "暂时没有可展示的简报。";
    const btn = $("#emptyReloadBtn");
    btn.dataset.date = options.date || "";
    $("#emptyRefreshBtn").disabled = Boolean(state.refreshDate);
  }

  function hideContent() {
    ["#hero", "#highlights", "#layout", "#sourcesSection"].forEach((selector) => {
      const node = $(selector);
      if (node) node.hidden = true;
    });
  }

  function showContent() {
    $("#emptyState").hidden = true;
    $("#loadingState").hidden = true;
    ["#hero", "#highlights", "#layout", "#sourcesSection"].forEach((selector) => {
      const node = $(selector);
      if (node) node.hidden = false;
    });
  }

  function renderEpisode(ep) {
    document.title = `${ep.date} ${ep.headline || "联播夜读"}`;
    $("#heroDate").textContent = episodeDateLabel(ep);
    $("#heroWeekday").textContent = ep.weekday || "";
    $("#heroHeadline").textContent = ep.headline || "";
    $("#heroOverview").textContent = ep.overview || "";
    $("#heroEpisodeTitle").textContent = ep.episode?.title || "《新闻联播》";
    $("#footerTime").textContent = `本期生成于 ${ep.generated_at?.replace("T", " ") || ""}`;

    renderThemes(ep);
    renderStats(ep);
    renderHighlights(ep);
    renderLinkage(ep);
    renderUpContext(ep);
    renderSegments(ep);
    renderPlaylist(ep);
    renderSources(ep);
    bindKeywordClicks();
    $("#editorNote").textContent = ep.editor_note || "";
    $("#monitorTimeInline").textContent = state.config?.monitor_time || "19:35";
    $("#allSegmentsCount").textContent = `${(ep.segments || []).length} 条`;
    $("#voiceCount").textContent = `${(ep.segments || []).length} 段`;
  }

  function renderThemes(ep) {
    const themes = (ep.themes || []).slice(0, 4).map((theme) =>
      `<span class="chip theme">${esc(theme.name)}<em>${theme.count}</em></span>`).join("");
    const tags = (ep.tags || []).slice(0, 3).map((tag) => `<span class="chip">${esc(tag)}</span>`).join("");
    $("#themeRow").innerHTML = themes + tags;
  }

  function renderStats(ep) {
    const stats = ep.stats || {};
    $("#heroStats").innerHTML = [
      `<span class="meta-item"><b>${stats.segment_count ?? 0}</b>条分条</span>`,
      `<span class="meta-item"><b>${esc(stats.duration || "--:--")}</b>全程</span>`,
      `<span class="meta-item"><b>${stats.up_count ?? 0}</b>位UP联动</span>`,
      `<span class="meta-item"><b>${stats.source_video_count ?? 0}</b>段原片</span>`,
    ].join("");
  }

  function renderHighlights(ep) {
    const segments = ep.segments || [];
    const ranked = segments.map((segment, index) => {
      const summary = String(segment.summary || "");
      const transcript = String(segment.transcript || "");
      const isQuick = /联播快讯/.test(segment.title || "");
      const category = segment.category || "综合";
      const score = summary.length + transcript.length * 0.18
        + (["民生", "经济", "科技"].includes(category) ? 18 : 0)
        - (category === "国际" ? 36 : 0)
        - (category === "时政" ? 22 : 0)
        - (isQuick ? 260 : 0);
      return { segment, index, category, score };
    }).filter((item) => !/联播快讯/.test(item.segment.title || ""))
      .sort((a, b) => b.score - a.score);

    // 优先让“今日重点”和页面顶部的主题标签对应，再按得分补齐
    const picked = [];
    const used = new Set();
    for (const tag of (ep.tags || []).slice(0, 5)) {
      const match = ranked.find((item) => {
        if (used.has(item.index)) return false;
        return `${item.segment.title} ${item.segment.summary}`.includes(tag);
      });
      if (match) {
        picked.push(match);
        used.add(match.index);
      }
      if (picked.length >= 3) break;
    }
    for (const item of ranked) {
      if (picked.length >= 3) break;
      if (!used.has(item.index)) {
        picked.push(item);
        used.add(item.index);
      }
    }
    picked.sort((a, b) => a.index - b.index);

    $("#highlightList").innerHTML = picked.map(({ segment, index, category }, order) => `
      <article class="highlight-item" data-index="${index}">
        <div class="highlight-kicker">
          <span>重点 0${order + 1}</span>
          <em>${esc(category)}</em>
          <em>${esc(segment.duration || "")}</em>
        </div>
        <h4 class="highlight-title">${esc(segmentShortTitle(segment))}</h4>
        <p class="highlight-summary">${esc(segment.summary || "")}</p>
        <div class="highlight-foot">
          <span>第 ${segment.id} 条</span>
          <button type="button" class="highlight-play" data-index="${index}">▶ 看原片</button>
        </div>
      </article>`).join("");

    $$(".highlight-item").forEach((node) => {
      node.addEventListener("click", () => focusSegment(Number(node.dataset.index)));
    });
    $$(".highlight-play").forEach((node) => {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        playSegment(Number(node.dataset.index));
      });
    });
  }

  function renderLinkage(ep) {
    const items = ep.linkage?.items || [];
    $("#linkageGrid").innerHTML = items.map((item) => `
      <div class="linkage-row" style="--accent:${safeColor(item.accent)}">
        <div class="linkage-speaker">
          <span class="linkage-name">${esc(item.speaker)}</span>
          <span class="linkage-role">${esc(item.role)}</span>
        </div>
        <p>${esc(clampText(item.text, 190))}</p>
        ${item.source_url ? `<a class="linkage-source" href="${esc(item.source_url)}" target="_blank" rel="noopener">${esc(item.source_label || "来源")} ↗</a>` : "<span></span>"}
      </div>`).join("");
    if (ep.linkage?.synthesis) {
      $("#linkageGrid").insertAdjacentHTML(
        "beforeend",
        `<p class="linkage-note">${esc(ep.linkage.synthesis)}</p>`,
      );
    }
  }

  function renderUpContext(ep) {
    const contexts = ep.up_context || [];
    if (!contexts.length) {
      $("#upContext").innerHTML = "";
      return;
    }
    const rows = contexts.map((ctx) => {
      const accent = safeColor(ctx.accent);
      const video = ctx.kind === "daily" ? (ctx.video || {}) : ((ctx.videos || [])[0] || {});
      const bvid = video.bvid || bvidFromUrl(video.url);
      const terms = (ctx.keywords || []).concat((ctx.points || []).map((p) => p.text || ""));
      const start = estimateBiliStart(video, terms);
      const play = bvid
        ? `<button type="button" class="up-play" ${biliButtonAttrs({ bvid, start, url: video.url || "" }, video.title || "")}>▶ 原视频原声 ${fmtTime(start)}</button>`
        : "";
      if (ctx.kind === "daily") {
        const keywords = (ctx.keywords || []).slice(0, 6).map((word) =>
          `<button type="button" class="keyword" data-keyword="${esc(word)}">${esc(word)}</button>`).join("");
        return `
          <div class="up-row" style="--accent:${accent}">
            <span class="up-name">小谢速览</span>
            <span class="up-desc">同日视频主题：</span>
            <span class="keyword-cloud">${keywords}</span>
            ${play}
            <a class="up-link" href="${esc(biliPageUrl(video.url || "#", start))}" target="_blank" rel="noopener">原视频 ↗</a>
          </div>`;
      }
      const points = (ctx.points || []).map((point) => `
        <li>
          <span class="pt-date">${esc(point.date || "复盘")}</span>
          <span class="pt-text">${esc(point.text || "")}</span>
        </li>`).join("");
      const topics = (ctx.points || []).slice(0, 3).map((point) => point.text.replace(/。$/, "")).join(" · ");
      return `
        <div class="up-row" style="--accent:${accent}">
          <span class="up-name">原点复盘</span>
          <span class="up-desc">${esc(clampText(topics, 100))}</span>
          ${play}
          <a class="up-link" href="${esc(biliPageUrl(video.url || "#", start))}" target="_blank" rel="noopener">周复盘 ↗</a>
          <details class="up-more">
            <summary>展开 ${Math.max((ctx.points || []).length, 1)} 条周度政策追问</summary>
            <ul class="weekly-points">${points}</ul>
          </details>
        </div>`;
    }).join("");
    $("#upContext").innerHTML = `
      <div class="block-head">
        <h3>UP素材 · 原视频原声</h3>
        <span>小谢同日速览 / 原点周度复盘 · 时间点为按话题顺序估算</span>
      </div>${rows}`;
  }
  function bindKeywordClicks() {
    $$(".keyword[data-keyword]").forEach((node) => {
      node.addEventListener("click", () => {
        const keyword = node.dataset.keyword || "";
        const segments = state.episode?.segments || [];
        const index = segments.findIndex((segment) => {
          if ((segment.title + segment.summary).includes(keyword)) return true;
          return (segment.takes || []).some((take) => String(take.quote || "").includes(keyword) || (take.matched_terms || []).includes(keyword));
        });
        if (index >= 0) {
          playSegment(index);
        } else {
          toast(`本期没有找到与「${keyword}」直接对应的单条，可查看原片清单`, "info", 2600);
        }
      });
    });
  }

  function segmentMeta(segment) {
    const offset = segment.offset || {};
    const parts = [
      `<span class="seg-cat">${esc(segment.category || "综合")}</span>`,
      `<span class="seg-time">${esc(segment.duration || "")}</span>`,
    ];
    if (offset.start) parts.push(`<span class="seg-time">${esc(offset.start)}–${esc(offset.end)}</span>`);
    return parts.join('<span class="seg-dot">·</span>');
  }

  function renderSegments(ep) {
    const list = $("#segmentList");
    list.innerHTML = "";
    (ep.segments || []).forEach((segment, index) => {
      const node = $("#segmentTemplate").content.firstElementChild.cloneNode(true);
      node.dataset.segmentIndex = String(index);
      node.dataset.segmentId = String(segment.id);
      node.querySelector(".segment-index").textContent = String(segment.id).padStart(2, "0");
      node.querySelector(".segment-meta").innerHTML = segmentMeta(segment);
      node.querySelector(".segment-title").textContent = segment.title;
      node.querySelector(".segment-summary").textContent = segment.summary;

      const take = (segment.takes || [])[0];
      const takeInline = node.querySelector(".segment-take-inline");
      if (take) {
        takeInline.innerHTML = `<span class="seg-up-name" style="--accent:${safeColor(take.accent)}">${esc(take.up_name)}</span>${esc(take.relation)} · ${esc(take.quote_is_keyword ? `「${take.quote}」` : take.quote)}`;
      } else {
        takeInline.remove();
      }

      const extra = node.querySelector(".segment-extra");
      if (segment.brief_items && segment.brief_items.length) {
        extra.innerHTML = `<div class="brief-grid">${segment.brief_items.map((item) => `<span class="brief-item">${esc(item)}</span>`).join("")}</div>`;
      }

      const takesBox = node.querySelector(".segment-takes");
      if (segment.takes && segment.takes.length) {
        takesBox.innerHTML = `<div class="takes-list">${segment.takes.map(renderTake).join("")}</div>`;
      }

      const transcript = node.querySelector(".segment-transcript");
      const transcriptHtml = transcriptCueHtml(segment);
      if (transcriptHtml) transcript.innerHTML = transcriptHtml;
      else transcript.remove();

      const offset = segment.offset || {};
      node.querySelector(".segment-timecode").textContent = offset.start
        ? `第 ${segment.id} 条 · 全片 ${offset.start}–${offset.end}`
        : `第 ${segment.id} 条`;
      node.querySelector(".segment-source").href = segment.url || "#";

      const play = () => playSegment(index);
      node.querySelector(".play-segment-btn").addEventListener("click", play);

      const expandBtn = node.querySelector(".expand-segment-btn");
      expandBtn.addEventListener("click", () => {
        node.classList.toggle("expanded");
        expandBtn.textContent = node.classList.contains("expanded") ? "收起详情" : "展开详情";
      });

      list.appendChild(node);
    });
  }

  function focusSegment(index) {
    const card = $(`.segment-card[data-segment-index="${index}"]`);
    if (!card) return;
    card.classList.add("expanded");
    const expand = card.querySelector(".expand-segment-btn");
    if (expand) expand.textContent = "收起详情";
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderTake(take) {
    const accent = safeColor(take.accent);
    const isKeyword = Boolean(take.quote_is_keyword);
    const prefix = take.relation === "快讯关联" ? "同日快讯速览提到" : "同日速览把";
    const quote = isKeyword
      ? `${prefix} <strong>「${esc(take.quote)}」</strong> 列入本期要点。`
      : `<span class="qmark">“</span>${esc(take.quote)}<span class="qmark">”</span>`;
    const clip = takeBiliInfo(take);
    const play = clip.bvid
      ? `<button type="button" class="take-play" ${biliButtonAttrs(clip, take.video_title || "")}>▶ 原声片段 ${clip.label}</button>`
      : "";
    const link = clip.bvid
      ? `<a class="take-link" href="${esc(biliPageUrl(clip.url, clip.start))}" target="_blank" rel="noopener">${esc(take.quote_source || "原视频")} ↗</a>`
      : "";
    return `
      <div class="take-card" style="--accent:${accent}">
        <div class="take-head">
          <span class="take-avatar">${esc((take.up_name || "U").slice(0, 1))}</span>
          <span class="take-name">${esc(take.up_name)}</span>
          <span class="take-badge">${esc(take.relation)}</span>
          ${play}
          ${link}
        </div>
        <p class="take-quote">${quote}</p>
      </div>`;
  }
  function segmentShortTitle(segment) {
    const title = String(segment.title || "");
    const bracketStripped = title.replace(/^【[^】]{2,24}】/, "").trim();
    return bracketStripped.length > 34 ? `${bracketStripped.slice(0, 33)}…` : bracketStripped;
  }

  function renderPlaylist(ep) {
    const list = $("#playlist");
    list.innerHTML = "";
    (ep.segments || []).forEach((segment, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "track";
      button.dataset.index = String(index);
      button.innerHTML = `
        <span class="track-no">${String(segment.id).padStart(2, "0")}</span>
        <span class="track-main">
          <span class="track-title">${esc(segmentShortTitle(segment))}</span>
          <span class="track-meta"><span class="ready-dot"></span><span>央视原片 · 原声画面</span><span>·</span><span>${esc(segment.duration || "")}</span></span>
        </span>
        <span class="track-play">▶</span>`;
      button.addEventListener("click", () => playSegment(index));
      list.appendChild(button);
    });
    $("#playlistSub").textContent = `共 ${(ep.segments || []).length} 段 · 点击播放央视原片原声`;
  }

  function renderSources(ep) {
    const grid = $("#sourcesGrid");
    const cards = [];
    for (const up of ep.ups || []) {
      const videos = up.selected || [];
      if (!videos.length) continue;
      const video = videos[0];
      const extra = videos.slice(1).map((item) =>
        `<a href="${esc(item.url || "#")}" target="_blank" rel="noopener">${esc(clampText(item.title, 30))}</a>`).join(" · ");
      cards.push(`
        <article class="source-card">
          ${video.cover ? `<img class="source-cover" src="${esc(video.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="source-cover"></span>`}
          <div class="source-body">
            <div class="source-head">
              ${up.avatar ? `<img class="source-avatar" src="${esc(up.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
              <strong>${esc(up.name)}</strong>
              <span class="source-role">${esc(up.role || "")}</span>
            </div>
            <a class="source-title" href="${esc(video.url || up.url || "#")}" target="_blank" rel="noopener">${esc(video.title || "")}</a>
            <p class="source-desc">${esc(video.desc || "")}</p>
            <div class="source-meta">
              <span>${esc(video.pubdate_text || "")}</span>
              <span>${esc(video.duration || "")}</span>
              <span>关联 ${up.matched_segments ?? 0} 条联播</span>
            </div>
            ${extra ? `<div class="source-meta">${extra}</div>` : ""}
            <div class="source-actions"><button type="button" class="up-play" ${(() => {
              const bvid = video.bvid || bvidFromUrl(video.url);
              if (!bvid) return "";
              const start = estimateBiliStart(video, [video.title || ""]);
              return biliButtonAttrs({ bvid, start, url: video.url || "" }, video.title || "");
            })()}>▶ 原视频原声</button></div>
          </div>
        </article>`);
    }
    grid.innerHTML = cards.join("") || "<p class=\"editor-note\">本期没有拿到可用的 B站视频信息。</p>";
  }

  // ------------------------------------------------------------ 原片播放器
  function setAudioStatus(kind, message) {
    const status = $("#audioStatus");
    status.className = `audio-status ${kind || ""}`;
    status.innerHTML = `<span class="status-dot"></span><span>${esc(message)}</span>`;
  }

  function updateAudioProgress() {
    const video = $("#clipVideo");
    const duration = Number(video.duration) || 0;
    const current = Number(video.currentTime) || 0;
    $("#timeNow").textContent = fmtTime(current);
    $("#timeTotal").textContent = fmtTime(duration);
    const percent = duration ? Math.min(100, (current / duration) * 100) : 0;
    $("#audioSeek").value = String(Math.round(percent * 10));
    $("#audioSeek").style.setProperty("--p", `${percent}%`);
  }

  function seekVideo() {
    const video = $("#clipVideo");
    const value = Number($("#audioSeek").value) || 0;
    if (video.duration) video.currentTime = (value / 1000) * video.duration;
    updateAudioProgress();
  }

  function setPlayingUI(playing) {
    state.playing = playing;
    const btn = $("#mainPlayBtn");
    btn.classList.toggle("playing", playing);
    btn.querySelector(".play-glyph").textContent = playing ? "❚❚" : "▶";
    $("#waveform").classList.toggle("playing", playing);
    $$(".track").forEach((track) => {
      track.classList.toggle("playing", track.classList.contains("active") && playing);
    });
  }

  function setNowPlaying(segment) {
    $("#nowTitle").textContent = segment ? segment.title : "尚未开始";
    const offset = segment?.offset || {};
    const timecode = offset.start ? ` · 全片 ${offset.start}–${offset.end}` : "";
    $("#nowMeta").textContent = segment
      ? `第 ${segment.id} 条 · ${segment.duration || ""} · 央视原片原声${timecode}`
      : "点击下方原片清单，播放对应《新闻联播》原片";
  }

  function updateActive(index) {
    $$(".segment-card").forEach((card) => {
      card.classList.toggle("active", Number(card.dataset.segmentIndex) === index);
    });
    $$(".track").forEach((track) => {
      const active = Number(track.dataset.index) === index;
      track.classList.toggle("active", active);
      track.classList.toggle("playing", active && state.playing);
    });
  }

  async function playSegment(index) {
    if (!state.episode) return;
    const segments = state.episode.segments || [];
    if (index < 0 || index >= segments.length) return;
    const segment = segments[index];
    state.current = index;
    state.activeCues = applyLearningToCues(segment._alignedCues || characterCues(segment), segment);
    state.alignedCues = segment._alignedCues || null;
    updateLearnUI(segment);
    ensureAlignedCues(segment);
    setNowPlaying(segment);
    updateActive(index);
    scrollToSegment(index);
    prepareVideo(segment);
    state.vadProgress = null;
    setAudioStatus("busy", "原片加载中…");
    try {
      await playVideo();
      setPlayingUI(true);
      setAudioStatus("ready", "原片原声播放中");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      setAudioStatus("", "原片播放失败");
      toast("原片播放失败，可能是网络或视频源暂不可用", "error");
      setPlayingUI(false);
    }
  }

  function togglePlay() {
    if (!state.episode) return;
    const video = $("#clipVideo");
    if (state.current < 0) {
      playSegment(0);
      return;
    }
    if (video.paused || video.ended) {
      if (video.ended || !video.src) {
        playSegment(state.current);
      } else {
        playVideo().then(() => setPlayingUI(true)).catch(() => {});
      }
    } else {
      pauseVideo();
      setPlayingUI(false);
      setAudioStatus("", "已暂停");
    }
  }

  function stopPlayback() {
    destroyHls();
    const video = $("#clipVideo");
    try { video.pause(); } catch (err) { /* noop */ }
    video.removeAttribute("src");
    video.load();
    state.current = -1;
    state.playing = false;
    state.parts = [];
    state.partIndex = 0;
    $("#nowTitle").textContent = "尚未开始";
    $("#nowMeta").textContent = "点击下方原片清单，播放对应《新闻联播》原片";
    $("#timeNow").textContent = "0:00";
    $("#timeTotal").textContent = "0:00";
    $("#audioSeek").value = "0";
    $("#audioSeek").style.setProperty("--p", "0%");
    setPlayingUI(false);
    setAudioStatus("", "央视原片原声");
    updateActive(-1);
    resetVideoStage();
  }

  // ------------------------------------------------------------ video
  let hlsInstance = null;

  function destroyHls() {
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (err) { /* noop */ }
      hlsInstance = null;
    }
    state.videoHls = false;
  }

  function resetVideoStage() {
    destroyHls();
    const video = $("#clipVideo");
    video.pause();
    video.removeAttribute("src");
    video.load();
    $("#videoEmpty").hidden = false;
    $("#videoBadge").textContent = "原片待命";
    $("#videoBadge").classList.remove("live");
    $("#videoQuality").textContent = "";
    $("#videoEmpty").querySelector("p").innerHTML = "选择一条原片<br>播放该条《新闻联播》的原声画面";
    $("#clipSourceLink").href = "#";
    $("#unmuteBtn").querySelector("span").textContent = "静音";
    video.muted = false;
  }

  function updateVideoCaption() {
    const el = $("#videoCaption");
    if (!el) return;
    const video = $("#clipVideo");
    const segment = state.episode && state.current >= 0 ? (state.episode.segments || [])[state.current] : null;
    if (!video || video.seeking || !segment || video.paused || !Number(video.duration)) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const cues = state.activeCues && state.activeCues.length ? state.activeCues : characterCues(segment);
    if (!cues.length) { el.hidden = true; el.textContent = ""; return; }
    const fraction = syncFraction((Number(video.currentTime) || 0) / (Number(video.duration) || 1), Number(video.duration) || 1);
    let activeIndex = cueIndexAt(cues, fraction);
    let active = activeIndex >= 0 ? cues[activeIndex] : null;
    if (!active && fraction >= cues[cues.length - 1].start) active = cues[cues.length - 1];
    if (!active) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = active.text;
  }

  function prepareVideo(segment) {
    destroyHls();
    const video = $("#clipVideo");
    const videoInfo = segment.video || {};
    state.parts = Array.isArray(videoInfo.parts) && videoInfo.parts.length
      ? videoInfo.parts.slice()
      : (videoInfo.mp4 ? [videoInfo.mp4] : []);
    state.partIndex = 0;
    state.videoHls = false;
    video.muted = false;
    video.volume = 1;
    $("#unmuteBtn").querySelector("span").textContent = "静音";
    $("#videoQuality").textContent = videoInfo.quality || "";
    $("#clipSourceLink").href = segment.url || "#";
    $("#videoBadge").textContent = `第 ${segment.id} 条 · 央视原片`;
    $("#videoBadge").classList.add("live");
    const hlsUrl = highQualityHls(videoInfo.hls || "");
    const useHls = hlsUrl && window.Hls && window.Hls.isSupported();
    if (useHls) {
      try {
        hlsInstance = new window.Hls({ startLevel: -1 });
        hlsInstance.loadSource(hlsUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (hlsInstance && hlsInstance.levels && hlsInstance.levels.length) {
            hlsInstance.currentLevel = hlsInstance.levels.length - 1;
            $("#videoQuality").textContent = "高清原片";
          }
        });
        hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
          if (!data || !data.fatal) return;
          console.warn("HLS error, fallback to mp4", data.type, data.details);
          destroyHls();
          const fallback = state.parts[0] || videoInfo.mp4 || "";
          if (fallback) {
            video.src = fallback;
            video.load();
          }
        });
        state.videoHls = true;
        $("#videoEmpty").hidden = true;
        $("#videoQuality").textContent = "HLS 原片";
        return;
      } catch (err) {
        destroyHls();
      }
    }
    const src = (hlsUrl && video.canPlayType("application/vnd.apple.mpegurl")) ? hlsUrl : (state.parts[0] || "");
    if (!src) {
      video.removeAttribute("src");
      video.load();
      $("#videoEmpty").hidden = false;
      $("#videoEmpty").querySelector("p").innerHTML = "这一条原片暂不可用<br>可点击右下角打开央视原页面";
      return;
    }
    $("#videoEmpty").hidden = true;
    video.poster = segment.image || "";
    video.src = src;
    video.load();
  }

  function playVideo() {
    const video = $("#clipVideo");
    if (!video.src && !state.videoHls) return Promise.reject(new Error("no video source"));
    const attempt = video.play();
    return attempt && attempt.catch ? attempt : Promise.resolve();
  }

  function pauseVideo() {
    const video = $("#clipVideo");
    try { video.pause(); } catch (err) { /* noop */ }
  }

  function onVideoPartEnded() {
    if (!state.videoHls && state.partIndex + 1 < state.parts.length) {
      state.partIndex += 1;
      const video = $("#clipVideo");
      video.src = state.parts[state.partIndex];
      video.load();
      playVideo().catch(() => {});
      return;
    }
    setPlayingUI(false);
    if (!$("#autoNext").checked) return;
    const next = state.current + 1;
    if (next < (state.episode?.segments || []).length) {
      window.setTimeout(() => playSegment(next), 420);
    }
  }

  function onVideoError() {
    const video = $("#clipVideo");
    if (!video) return;
    if (!state.videoHls && state.partIndex + 1 < state.parts.length) {
      state.partIndex += 1;
      video.src = state.parts[state.partIndex];
      video.load();
      if (state.playing) playVideo().catch(() => {});
      return;
    }
    if (state.videoHls) {
      destroyHls();
      const fallback = state.parts[0] || "";
      if (fallback) {
        video.src = fallback;
        video.load();
        if (state.playing) playVideo().catch(() => {});
        return;
      }
    }
    $("#videoEmpty").hidden = false;
    $("#videoEmpty").querySelector("p").innerHTML = "原片加载失败<br>点击右下角可打开央视原网页";
    $("#videoBadge").textContent = "原片暂不可用";
    setAudioStatus("", "原片暂不可用");
  }

  function toggleMute() {
    const video = $("#clipVideo");
    if (!video.src && !state.videoHls) {
      toast("当前没有可播放的原片", "info", 2000);
      return;
    }
    video.muted = !video.muted;
    $("#unmuteBtn").querySelector("span").textContent = video.muted ? "原声" : "静音";
    toast(video.muted ? "已静音，画面仍为央视原片" : "已开启央视原片原声", "info", 1800);
  }

  function scrollToSegment(index) {
    if (window.innerWidth <= 1240) {
      const panel = $("#voicePanel");
      if (panel) {
        const rect = panel.getBoundingClientRect();
        if (rect.top < 70 || rect.bottom > window.innerHeight) {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      return;
    }
    const card = $(`.segment-card[data-segment-index="${index}"]`);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const margin = 110;
    if (rect.top < margin || rect.bottom > window.innerHeight - 40) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 桌面端改为开发/本地直连：主动注销旧 Service Worker，避免旧页面壳导致改了 CSS 却看不到。
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    }).catch(() => {});
  }
})();
