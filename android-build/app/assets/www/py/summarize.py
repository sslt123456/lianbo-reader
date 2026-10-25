"""把《新闻联播》原文与 B 站双 UP 公开视频信息融合成每日简报。

默认使用可复现的抽取式摘要（不依赖外部大模型）：
  - 从央视网原文中挑选首句、含数据句、标题关键词句组成摘要；
  - 从 UP 主视频标题/简介中截取与单条新闻最相关的原话；
  - 自动生成概览、联动解读、每条语音播报稿。

所有观点性内容均以“原话摘录”标注；概览与联播事实来自央视网页面。
"""

from __future__ import annotations

import html as html_mod
import logging
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

import jieba

jieba.setLogLevel(logging.ERROR)

CST = timezone(timedelta(hours=8))
WEEKDAYS = "一二三四五六日"

# ---------------------------------------------------------------- 词表
STOPWORDS = {
    "的", "了", "在", "和", "与", "及", "为", "是", "等", "我", "你", "他", "她", "它",
    "我们", "他们", "你们", "我国", "中国", "一个", "一种", "以及", "进行", "表示", "指出",
    "强调", "介绍", "报道", "记者", "今天", "昨天", "明天", "今年", "明年", "去年", "这一",
    "这些", "其中", "同时", "另外", "此外", "目前", "已经", "将会", "可以", "能够", "不断",
    "持续", "进一步", "全面", "相关", "有关", "方面", "问题", "情况", "工作", "会议", "活动",
    "发展", "建设", "推进", "推动", "加强", "实现", "举行", "召开", "发布", "启动", "完成",
    "首个", "首次", "第一", "第二", "第三", "新", "更", "最", "多", "个", "条", "次", "项",
    "日", "月", "年", "时", "分", "秒", "人", "元", "万", "亿", "上", "下", "中", "内", "外",
    "将", "会", "要", "从", "到", "对", "于", "也", "都", "就", "而", "被", "把", "让", "给",
    "很", "再", "又", "还", "没", "有", "不是", "这个", "那个", "什么", "怎么", "如何", "为何",
    "今天", "今日", "本期", "节目", "新闻", "联播", "新闻联播", "央视", "央视网", "视频", "消息",
    "内容", "简介", "来源", "编辑", "责任编辑", "当地时间", "下午", "上午", "晚间", "近日",
    "指出", "表示", "认为", "称", "说", "并且", "以及", "其中", "包括", " etc", "etc",
}

GENERIC_TERMS = {
    "新闻联播", "新闻", "联播", "央视", "视频", "解读", "极速版", "周复盘", "复盘", "本期",
    "今日", "今天", "昨天", "明天", "中国", "我国", "国家", "政策", "发展", "建设", "工作",
    "会议", "报道", "记者", "关注", "方面", "内容", "问题", "情况", "时间", "今年", "明年",
    "持续", "推进", "推动", "进一步", "重要", "相关", "举行", "召开", "发布", "启动", "完成",
    "实现", "加强", "一个", "我们", "他们", "可以", "已经", "目前", "同时", "其中", "另外",
    "国内方面", "国际方面", "本期资讯", "下期", "上期", "一周", "月份", "视频内容",
}

# 用于展示标签过滤：人名、职务和过于宽泛的词不进入头条标签
DISPLAY_TAG_BLOCK = {
    "李强", "习近平", "总理", "总统", "主席", "国务院", "中央", "总书记", "政治局",
    "外交", "访问", "会谈", "会见", "国常会", "改革", "民生", "文化", "经济", "时政",
    "国际", "科技", "体育", "夕阳红", "长征", "红色", "温暖工程", "空间站", "论坛",
    "赛事", "日本", "住房", "车次",
}

HEADLINE_TAG_BLOCK = DISPLAY_TAG_BLOCK | {
    "总书记", "论坛", "赛事", "日本", "欧洲", "传统节日", "健康", "丰收",
}

# 跨信源匹配时，过于宽泛的政策词不能单独作为关联依据
BROAD_MATCH_TERMS = {
    "民生", "改革", "发展", "政策", "文化", "经济", "科技", "国际", "合作", "工作",
    "建设", "保障", "服务", "会议", "论坛", "时政", "体育", "项目", "方面", "领域",
    "群众", "问题", "需求", "市场", "产业", "企业", "国家", "社会",
}

# 新闻联播高频主题词，用于标签、分类与跨信源匹配
LEXICON = [
    "养老", "老龄", "夕阳红", "民生", "社保", "社会保险", "跨省通办", "供热", "供暖", "温暖工程",
    "铁路", "列车", "车次", "调图", "客运", "旅客", "物流", "交通", "公路", "港口", "机场",
    "水稻", "太空", "航天", "空间站", "育种", "农业", "秋粮", "粮食", "丰收", "乡村振兴",
    "亚残运会", "残运会", "运动会", "体育", "赛事", "运动员", "冠军", "全民健身",
    "超长期", "特别国债", "国债", "财政", "专项债", "地方债", "金融", "货币", "人民币", "汇率",
    "央行", "信贷", "银行", "保险", "资本市场", "外资", "外贸", "进出口", "贸易", "关税",
    "APEC", "上合", "金砖", "一带一路", "进博会", "广交会", "服贸会", "投资", "消费", "物价",
    "就业", "招聘", "用工", "技能", "教育", "高校", "职教", "医疗", "医保", "健康", "药品",
    "住房", "房地产", "城市更新", "老旧小区", "乡村", "县域", "城镇化", "人口", "生育", "托育",
    "人工智能", "AI", "算力", "芯片", "半导体", "数字经济", "工业互联网", "机器人", "新能源",
    "氢能", "光伏", "风电", "储能", "核电", "绿色", "低碳", "碳达峰", "碳中和", "生态", "环保",
    "督察", "污染", "长江", "黄河", "国家公园", "生物多样性", "放流", "增殖放流",
    "科技", "研发", "创新", "专利", "成果", "实验室", "卫星", "火箭", "朱雀", "商业航天",
    "文化", "文旅", "旅游", "电影", "艺术节", "电影节", "论坛", "良渚", "非遗", "博物馆", "考古",
    "重阳", "传统节日", "节日", "长征", "红色", "党史", "抗战", "英烈", "爱国主义",
    "改革", "开放", "营商", "民营", "企业", "制造业", "产业链", "供应链", "新质生产力", "高质量发展",
    "安全", "应急", "防汛", "抗旱", "救灾", "地震", "火灾", "林火", "森林",
    "外交", "会谈", "会见", "访问", "峰会", "总统", "总理", "主席", "外长", "大使",
    "乌克兰", "俄罗斯", "俄乌", "美国", "欧洲", "欧盟", "中东", "以色列", "伊朗", "沙特",
    "也门", "胡塞", "加沙", "联合国", "北约", "亚太", "东盟", "非洲", "肯尼亚", "加拿大",
    "日本", "韩国", "印度", "英国", "法国", "德国", "澳大利亚", "APEC经济体",
    "埃博拉", "疫情", "公共卫生", "疫苗", "粮食安全", "能源安全", "供应链安全",
    "十五五", "规划", "国常会", "国务院", "中央", "总书记", "习近平", "李强", "政治局",
]

_CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("国际", ["国际", "也门", "胡塞", "沙特", "俄乌", "俄罗斯", "乌克兰", "美国", "欧洲", "欧盟",
              "联合国", "北约", "中东", "以色列", "伊朗", "加沙", "日本", "韩国", "印度", "加拿大",
              "加州", "肯尼亚", "非洲", "英国", "法国", "德国", "澳大利亚", "埃博拉", "海外"]),
    ("体育", ["亚残运会", "残运会", "运动会", "赛事", "冠军", "运动员", "体育", "世界杯", "奥运"]),
    ("科技", ["太空", "航天", "卫星", "火箭", "水稻", "育种", "人工智能", "AI", "算力", "芯片",
              "半导体", "机器人", "氢能", "新能源", "科技", "研发", "创新", "实验室", "专利"]),
    ("文化", ["文化", "文旅", "旅游", "电影", "艺术", "论坛", "良渚", "非遗", "博物馆", "考古",
              "重阳", "传统节日", "长征", "红色"]),
    ("民生", ["养老", "社保", "供热", "供暖", "就业", "医疗", "医保", "教育", "住房", "物价",
              "铁路", "列车", "车次", "旅客", "民生", "托育", "老旧小区", "消费"]),
    ("经济", ["经济", "金融", "国债", "财政", "货币", "人民币", "汇率", "央行", "信贷", "外贸",
              "进出口", "贸易", "投资", "产业", "企业", "制造业", "APEC", "上合", "进博会",
              "广交会", "一带一路", "改革", "开放", "新质生产力"]),
    ("时政", ["习近平", "李强", "总理", "总统", "主席", "会谈", "会见", "访问", "外交", "峰会",
              "国务院", "中央", "国常会", "上合", "十五五", "规划"]),
]

CATEGORY_ORDER = ["时政", "民生", "经济", "科技", "文化", "体育", "国际", "综合"]


# ---------------------------------------------------------------- 基础工具
def clean_text(text: str) -> str:
    text = html_mod.unescape(text or "")
    text = text.replace("\u3000", " ").replace("\u200b", "").replace("\xa0", " ")
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clean_paragraph(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"^央视网消息\s*[（(]新闻联播[)）]\s*[：:]\s*", "", text)
    text = re.sub(r"^[（(]新闻联播[)）]\s*[：:]\s*", "", text)
    text = re.sub(r"^\[视频\]", "", text).strip()
    return text


def split_sentences(text: str) -> list[str]:
    text = clean_text(text)
    pieces = re.split(r"(?<=[。！？!?])\s*", text)
    out: list[str] = []
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        # 过短的残句并入上一句
        if out and len(piece) < 8:
            out[-1] += piece
        else:
            out.append(piece)
    return out


def tokenize(text: str) -> list[str]:
    text = clean_text(text)
    words: list[str] = []
    for word in jieba.cut(text):
        word = word.strip()
        if len(word) < 2:
            continue
        if word in STOPWORDS or word in GENERIC_TERMS:
            continue
        if re.fullmatch(r"[\d.%]+", word):
            continue
        words.append(word)
    return words


def extract_terms(text: str, topk: int = 12) -> list[str]:
    """抽取用于匹配 / 标签的主题词（词表命中优先）。"""
    text = clean_text(text)
    counts: Counter[str] = Counter()
    for word in tokenize(text):
        if len(word) >= 2:
            counts[word] += 1
    for term in LEXICON:
        if term in text and len(term) >= 2:
            counts[term] += 2
    # 去掉被更长命中词包含的短词，减少重复计分
    ranked = [w for w, _ in counts.most_common(topk * 3)]
    kept: list[str] = []
    for word in ranked:
        if word in GENERIC_TERMS:
            continue
        if any(word != other and word in other and counts[other] >= counts[word] for other in ranked):
            continue
        kept.append(word)
        if len(kept) >= topk:
            break
    return kept


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def classify(title: str, summary: str = "") -> str:
    title = clean_text(title)
    text = title + " " + summary
    if "国际联播快讯" in title or title.startswith("国际"):
        return "国际"
    if "国内联播快讯" in title:
        return "综合"
    for label, words in _CATEGORY_RULES:
        for word in words:
            if word in title:
                return label
    for label, words in _CATEGORY_RULES:
        for word in words:
            if word in text:
                return label
    return "综合"


def weekday_cn(day: date) -> str:
    return "星期" + WEEKDAYS[day.weekday()]


def display_date(day: date) -> str:
    return f"{day.year}年{day.month}月{day.day}日 {weekday_cn(day)}"


def short_topic(title: str, limit: int = 30) -> str:
    text = re.sub(r"^\[(视频|完整版)\]", "", clean_text(title))
    text = re.sub(r"^【[^】]{2,24}】", "", text).strip()
    text = re.sub(r"^\[[^\]]{2,24}\]", "", text).strip()
    if len(text) > limit:
        # 优先在“并 / 顿号 / 括号 / 逗号”处收束，避免出现半截括号
        cut = -1
        for sep in ("，", "；", "。", "并", "、", "（", "(", "·", " "):
            idx = text.rfind(sep, 0, limit)
            if idx >= int(limit * 0.42):
                cut = max(cut, idx)
        if cut < 0:
            cut = limit
        text = text[:cut].rstrip("，、；：并 （(· ") + "…"
    return text


# ---------------------------------------------------------------- 摘要
def _score_sentences(title: str, paragraphs: list[str]) -> list[tuple[str, float]]:
    sentences: list[tuple[int, str]] = []
    for pi, paragraph in enumerate(paragraphs):
        for sentence in split_sentences(clean_paragraph(paragraph)):
            if len(sentence) < 8:
                continue
            sentences.append((pi, sentence))
    if not sentences:
        return []
    title_terms = set(extract_terms(title, 10))
    counts: Counter[str] = Counter()
    tokens_per: list[set[str]] = []
    for _, sentence in sentences:
        toks = set(tokenize(sentence)) | {t for t in LEXICON if t in sentence}
        tokens_per.append(toks)
        for tok in toks:
            counts[tok] += 1
    n = len(sentences)
    idf = {tok: math.log(1 + n / (1 + df)) for tok, df in counts.items()}
    scored: list[tuple[str, float]] = []
    for idx, (pi, sentence) in enumerate(sentences):
        toks = tokens_per[idx]
        if not toks:
            base = 0.2
        else:
            base = sum(idf.get(tok, 0.7) for tok in toks) / math.sqrt(len(toks))
        title_bonus = sum(2.6 * idf.get(tok, 1.0) for tok in (toks & title_terms))
        num_bonus = 1.3 if re.search(r"\d", sentence) else 0.0
        lead_bonus = 1.8 if idx == 0 else 0.0
        para_bonus = 0.8 if pi == 0 else 0.0
        length = len(sentence)
        length_penalty = 0.0 if 18 <= length <= 105 else (0.9 if length > 105 else 0.5)
        scored.append((sentence, base + title_bonus + num_bonus + lead_bonus + para_bonus - length_penalty))
    return scored


def summarize_text(title: str, paragraphs: list[str], max_chars: int = 215,
                   max_sentences: int = 3) -> str:
    scored = _score_sentences(title, paragraphs)
    if not scored:
        return ""
    tokens_per = [set(tokenize(s)) for s, _ in scored]
    picked: list[int] = []
    total = 0
    # 新闻导语优先保留
    if scored and 8 <= len(scored[0][0]) <= 120:
        picked.append(0)
        total += len(scored[0][0])
    for idx in sorted(range(len(scored)), key=lambda i: scored[i][1], reverse=True):
        if idx in picked:
            continue
        sentence = scored[idx][0]
        if picked:
            overlap = max(jaccard(tokens_per[idx], tokens_per[j]) for j in picked)
            if overlap > 0.6:
                continue
            if len(sentence) > 78:
                continue
        if total + len(sentence) > max_chars and picked:
            continue
        picked.append(idx)
        total += len(sentence)
        if len(picked) >= max_sentences:
            break
    if not picked:
        picked = [0]
    picked.sort()
    summary = "".join(scored[i][0] for i in picked)
    summary = re.sub(r"\s+", "", summary)
    if len(summary) > max_chars + 30:
        summary = summary[:max_chars + 30].rstrip("，、；：") + "。"
    return summary


def summarize_quick_news(brief_items: list[str], max_items: int = 6) -> str:
    items = [clean_text(x).rstrip("；;。.") for x in brief_items if clean_text(x)]
    if not items:
        return ""
    shown = items[:max_items]
    text = "；".join(shown)
    if len(items) > max_items:
        text += f"等{len(items)}条"
    return text + "。"


def parse_program_brief(brief: str) -> list[dict]:
    groups: list[dict] = []
    current: dict | None = None
    for raw_line in (brief or "").splitlines():
        line = clean_text(raw_line)
        if not line or line.startswith("本期节目"):
            continue
        m = re.match(r"^(\d{1,2})[.、]\s*(.*)$", line)
        if m and not line.startswith("（"):
            current = {"num": int(m.group(1)), "text": m.group(2).strip("；; "), "items": []}
            groups.append(current)
            continue
        sub = re.match(r"^[（(](\d{1,2})[)）]\s*(.*)$", line)
        if sub and current is not None:
            current["items"].append(sub.group(2).strip("；; "))
            continue
        if current is not None:
            current["items"].append(line.strip("；; "))
    return groups


def assign_brief(segments: list[dict], groups: list[dict]) -> None:
    if not groups:
        return
    if len(groups) == len(segments):
        for seg, group in zip(segments, groups):
            seg["brief_text"] = group["text"]
            seg["brief_items"] = group["items"][:]
        return
    for group in groups:
        g_terms = set(extract_terms(group["text"], 8))
        best_seg = None
        best_score = 0.0
        for seg in segments:
            s_terms = set(extract_terms(seg["title"], 8))
            score = len(g_terms & s_terms)
            if score > best_score:
                best_score = score
                best_seg = seg
        if best_seg is not None and best_score >= 1:
            best_seg.setdefault("brief_text", group["text"])
            best_seg.setdefault("brief_items", group["items"][:])


# ---------------------------------------------------------------- UP 匹配
def _dedupe_terms(terms: list[str]) -> list[str]:
    ordered = sorted(set(terms), key=len, reverse=True)
    kept: list[str] = []
    for term in ordered:
        if term in GENERIC_TERMS or len(term) < 2:
            continue
        if any(term in other for other in kept):
            continue
        kept.append(term)
    return kept


def _split_clauses(sentence: str) -> list[str]:
    return re.findall(r"[^，。；：、！？]+[，。；：、！？]?", sentence)


def narration_topic(title: str, limit: int = 44) -> str:
    """语音标题：优先在“并”处断开，避免把长头衔读得支离破碎。"""
    text = clean_text(title)
    text = re.sub(r"^\[(视频|完整版)\]", "", text)
    text = re.sub(r"^【[^】]{2,24}】", "", text).strip()
    idx = text.find("并")
    if 6 < idx <= limit:
        return text[:idx].rstrip("，、；： ")
    return short_topic(text, limit).rstrip("…")


def clip_quote(text: str, terms: list[str], max_len: int = 92) -> str | None:
    """从长文本中截出包含匹配词的一段原话。"""
    text = clean_text(text)
    if not text:
        return None
    sentences = split_sentences(text)
    best_sentence = ""
    best_terms: list[str] = []
    for sentence in sentences:
        matched = [t for t in terms if t in sentence]
        if len(matched) > len(best_terms):
            best_terms = matched
            best_sentence = sentence
    if not best_sentence:
        matched = [t for t in terms if t in text]
        if not matched:
            return None
        best_sentence = text
        best_terms = matched
    if len(best_sentence) <= max_len:
        return best_sentence.rstrip("，、；： ")
    clauses = _split_clauses(best_sentence)
    hit_indexes = [i for i, clause in enumerate(clauses) if any(t in clause for t in best_terms)]
    if not hit_indexes:
        return best_sentence[:max_len].rstrip("，、；： ") + "…"
    start = max(0, hit_indexes[0] - 1)
    out = ""
    for clause in clauses[start:]:
        if len(out) + len(clause) > max_len and out:
            break
        out += clause
    out = out.rstrip("，、；： ")
    if not out:
        out = clauses[hit_indexes[0]][:max_len].rstrip("，、；： ")
    if len(out) < len(best_sentence):
        out += "…"
    return out


def extract_key_phrase(text: str, terms: list[str], max_len: int = 30) -> str:
    """从标题 / 简介里截出围绕命中词的一个短语。"""
    text = clean_text(text)
    if not text:
        return ""
    separators = "、，；。：\n等与"
    for term in sorted(terms, key=len, reverse=True):
        idx = text.find(term)
        if idx < 0:
            continue
        starts = [text.rfind(sep, 0, idx) for sep in separators]
        start = max(starts) + 1 if starts else 0
        ends = [text.find(sep, idx) for sep in separators]
        ends = [pos for pos in ends if pos >= 0]
        end = min(ends) if ends else len(text)
        phrase = text[start:end].strip(" ：:，、；。")
        if phrase and len(phrase) <= max_len:
            return phrase
        return term
    return ""


def match_up_takes(segment: dict, ups: list[dict], max_takes: int = 2) -> list[dict]:
    seg_text = segment["title"] + " " + segment["summary"]
    seg_terms = _dedupe_terms([t for t in LEXICON if t in seg_text])
    title_terms = set(_dedupe_terms([t for t in LEXICON if t in segment["title"]]))
    candidates: list[dict] = []
    for up in ups:
        is_xiaoxie = up["name"].startswith("你好小谢")
        same_day = "同日" in up.get("relation_hint", "")
        for video in up.get("selected") or []:
            if not video:
                continue
            vtext = " ".join([video.get("title", ""), video.get("desc", ""), video.get("tag", "")])
            video_terms = set(_dedupe_terms([t for t in LEXICON if t in vtext]))
            common = [t for t in seg_terms if t in video_terms]
            specific = [t for t in common if t not in BROAD_MATCH_TERMS]
            if not specific:
                continue
            score = 0.0
            basis = specific
            for term in basis:
                if term in title_terms:
                    score += 2.0
                elif term in segment["title"]:
                    score += 1.7
                else:
                    score += 1.0
            threshold = 2.0
            if is_xiaoxie and same_day:
                threshold = 1.0
            if not is_xiaoxie:
                threshold = 1.0 if "联播快讯" in segment["title"] else 2.0
            if score < threshold:
                continue

            quote_is_keyword = bool(is_xiaoxie and same_day)
            if quote_is_keyword:
                title_matches = [t for t in basis if t in video.get("title", "")]
                if title_matches:
                    quote = extract_key_phrase(video.get("title", ""), title_matches, 32)
                    quote_source = "标题要点"
                else:
                    quote = extract_key_phrase(video.get("desc", ""), basis, 32)
                    quote_source = "简介要点"
            else:
                quote = clip_quote(video.get("desc", ""), basis, max_len=88)
                quote_source = "简介"
                if not quote:
                    quote = clip_quote(video.get("title", ""), basis, max_len=64)
                    quote_source = "标题"
            if not quote:
                continue

            if quote_is_keyword and same_day:
                relation = "同日速览"
            elif "一周复盘" in video.get("title", "") or "周复盘" in video.get("title", ""):
                relation = "周度复盘"
            else:
                relation = "主题相关"
            if "联播快讯" in segment["title"]:
                relation = "快讯关联"
            candidates.append({
                "up_name": up["name"],
                "uid": up.get("uid"),
                "role": up.get("role", ""),
                "accent": up.get("accent", "#b8121b"),
                "bvid": video.get("bvid"),
                "url": video.get("url"),
                "video_title": video.get("title"),
                "video_pubdate": video.get("pubdate_text", ""),
                "quote": quote,
                "quote_source": quote_source,
                "quote_is_keyword": quote_is_keyword,
                "relation": relation,
                "score": round(score, 1),
                "matched_terms": common[:6],
            })
    # 每个 UP 只保留分数最高的一条
    best_by_up: dict[str, dict] = {}
    for item in sorted(candidates, key=lambda x: x["score"], reverse=True):
        best_by_up.setdefault(item["up_name"], item)
    takes = sorted(best_by_up.values(), key=lambda x: x["score"], reverse=True)[:max_takes]
    return takes


# ---------------------------------------------------------------- 语音稿
def voice_clean(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[《》「」“”‘’\"]", "", text)
    text = re.sub(r"[【】\[\]]", " ", text)
    text = re.sub(r"[（(]\s*[)）]", "", text)
    text = re.sub(r"[（(]\s*(新闻联播|视频)\s*[)）]", "", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[，、；：。]+", "", text)
    return text.strip()


def trim_for_voice(text: str, limit: int = 320) -> str:
    text = voice_clean(text)
    if len(text) <= limit:
        return text
    cut = max(text.rfind("。", 0, limit), text.rfind("；", 0, limit), text.rfind("，", 0, limit))
    if cut < limit * 0.5:
        cut = limit
    return text[:cut].rstrip("，、；：") + "。"


def build_narration(index: int, segment: dict, takes: list[dict]) -> str:
    topic = narration_topic(segment["title"], 44)
    body = segment.get("summary") or segment.get("brief_text") or topic
    parts = [f"第{index}条，{topic}。", body]
    if takes:
        take = takes[0]
        prefix = "同日" if take["relation"] == "同日速览" else ""
        if take.get("quote_is_keyword"):
            parts.append(f"B站UP主{take['up_name']}{prefix}速览也把“{take['quote']}”列入要点。")
        else:
            quote = trim_for_voice(take["quote"], 58).rstrip("。")
            if quote:
                parts.append(f"B站UP主{take['up_name']}{prefix}提到：{quote}。")
    return trim_for_voice("".join(parts), 330)


# ---------------------------------------------------------------- 主流程
def _representative_segments(segments: list[dict], limit: int = 3) -> list[dict]:
    """每类挑一个非快讯代表，用于概览与联动解读。"""
    chosen: list[dict] = []
    seen: set[str] = set()
    for segment in segments:
        if "联播快讯" in segment["title"]:
            continue
        category = segment.get("category", "综合")
        if category in seen:
            continue
        seen.add(category)
        chosen.append(segment)
        if len(chosen) >= limit:
            break
    if len(chosen) < limit:
        for segment in segments:
            if segment in chosen or "联播快讯" in segment["title"]:
                continue
            chosen.append(segment)
            if len(chosen) >= limit:
                break
    return chosen


def _build_overview(day: date, segments: list[dict], episode: dict, themes: list[dict],
                    tags: list[str]) -> str:
    n = len(segments)
    duration = episode.get("duration") or ""
    theme_names = [t["name"] for t in themes[:3]]
    reps = _representative_segments(segments, 4)
    domestic = [short_topic(s["title"], 24) for s in reps if s["category"] != "国际"][:3]
    international = [short_topic(s["title"], 24) for s in reps if s["category"] == "国际"][:2]
    if not international:
        international = [short_topic(s["title"], 24) for s in segments if s["category"] == "国际"][:2]
    theme_text = "、".join(theme_names) if theme_names else "时政与民生"
    text = f"{display_date(day)}，《新闻联播》共播出{n}条分条报道，全程{duration}。本期主线落在{theme_text}，"
    if domestic:
        text += "国内聚焦" + "、".join(domestic) + "；"
    if international:
        text += "国际部分关注" + "、".join(international) + "；"
    elif tags:
        text += "关键词包括" + "、".join(tags[:3]) + "；"
    text = text.rstrip("；") + "。"
    if segments and ("重阳" in segments[-1]["title"] or "传统节日" in segments[-1]["title"]):
        text += "节目最后以传统节日报道收束。"
    return text


def _video_synopsis(desc: str, max_len: int = 120) -> str:
    text = clean_text(desc)
    if not text:
        return ""
    sentences = split_sentences(text)
    out = ""
    for sentence in sentences:
        if len(out) + len(sentence) > max_len and out:
            break
        out += sentence
    if not out:
        out = text[:max_len] + "…"
    return out


def _build_linkage(day: date, segments: list[dict], ups: list[dict], tags: list[str],
                   up_context: list[dict] | None = None) -> dict:
    n = len(segments)
    categories = Counter(s["category"] for s in segments)
    theme_names = [label for label, _ in categories.most_common(3)]
    reps = _representative_segments(segments, 3)
    rep_text = "；".join(f"《{short_topic(s['title'], 28)}》" for s in reps)
    cctv_text = (
        f"本期{n}条报道覆盖{'、'.join(theme_names)}等板块。"
        + (f"{rep_text}构成当日信息主干。" if rep_text else "")
    )
    items = [{
        "speaker": "新闻联播",
        "role": "官方信息主干",
        "accent": "#b8121b",
        "text": cctv_text,
        "source_url": "https://tv.cctv.com/lm/xwlb/",
        "source_label": "央视网 · 新闻联播",
    }]
    for up in ups:
        selected = up.get("selected") or []
        if not selected:
            continue
        video = selected[0]
        synopsis = _video_synopsis(video.get("desc", ""), 115)
        role = up.get("role", "关联解读")
        title = video.get("title", "")
        if up["name"].startswith("你好小谢"):
            lead = f"{video.get('pubdate_text', '')}，UP主“{up['name']}”发布“{title}”，以逐条速览的方式跟进本期联播。"
        elif "一周复盘" in title or "周复盘" in title:
            lead = f"UP主“{up['name']}”最新周复盘“{title}”发布于{video.get('pubdate_text', '')}，把镜头拉回更长周期的政策脉络。"
        else:
            lead = f"UP主“{up['name']}”近期视频“{title}”提供了另一条观察线索。"
        if synopsis:
            lead += f"视频简介写道：{synopsis}"
        items.append({
            "speaker": up["name"],
            "role": role,
            "accent": up.get("accent", "#5b8c85"),
            "text": lead,
            "source_url": video.get("url", ""),
            "source_label": f"B站 · {up['name']}",
        })
    # 三方交集
    synth_block = BROAD_MATCH_TERMS | {
        "红色", "长征", "夕阳红", "温暖工程", "传统节日", "总书记", "成果", "技术",
        "水平", "能力", "质量", "效率", "基础", "体系", "机制", "模式", "方向",
        "空间", "环境", "服务", "数据", "同比", "增长", "超过", "达到", "技术",
        "进一步", "积极", "有关", "重点", "重大", "主要", "持续", "不断", "已经",
        "访问", "会见", "会谈", "国务院", "总理", "总统", "主席", "李强", "习近平",
        "规划", "目标", "任务", "情况", "实现", "推进", "推动", "加强", "全面",
        "我国", "中国", "世界", "国家", "地区", "内容", "时间", "今年", "明年",
        "今日", "报道", "记者", "视频", "新闻", "联播", "工作", "建设", "发展",
        "政策", "保障", "项目", "产业", "市场", "社会", "问题", "需求", "领域",
    }
    seg_terms: Counter[str] = Counter()
    for seg in segments:
        text = seg.get("title", "") + " " + seg.get("summary", "")
        for term in LEXICON:
            if term in text and term not in synth_block:
                seg_terms[term] += 1
    common_x: list[str] = []
    common_y: list[str] = []
    for up in ups:
        selected = up.get("selected") or []
        vtext = " ".join([v.get("title", "") + v.get("desc", "") + v.get("tag", "") for v in selected])
        for tag in [t for t, _ in seg_terms.most_common(24)]:
            if tag in vtext:
                if up["name"].startswith("你好小谢"):
                    common_x.append(tag)
                else:
                    common_y.append(tag)
    xiaoxie_topics = ""
    if common_x:
        unique_x = list(dict.fromkeys(common_x))
        xiaoxie_topics = "、".join(unique_x[:4])
    origin_topics: list[str] = []
    for context in up_context or []:
        if context.get("kind") != "weekly":
            continue
        for point in context.get("points") or []:
            text = point.get("text", "").strip("。")
            if text:
                origin_topics.append(text)
            if len(origin_topics) >= 4:
                break
        if origin_topics:
            break
    if xiaoxie_topics or origin_topics:
        parts = []
        if xiaoxie_topics:
            parts.append(f"小谢的同日速览覆盖{xiaoxie_topics}等今日话题")
        if origin_topics:
            parts.append(f"原点公社的周复盘则围绕“{origin_topics[0]}”等政策线索展开")
        synthesis = "；".join(parts) + "。"
        if common_y:
            synthesis += f"其中{'、'.join(common_y[:2])}与今日联播形成直接呼应。"
        synthesis += "文字板块保留联播原稿与UP原话，语音板块按联播原片顺序播放，便于交叉核对。"
    else:
        synthesis = (
            "把三个信源并置：联播给出事实框架，小谢补上逐条速览，原点公社提供更长周期的政策坐标。"
            "文字板块保留原稿与UP原话，语音板块按联播原片顺序播放，便于交叉核对。"
        )
    return {"items": items, "synthesis": synthesis}


def _video_meta(video: dict, desc_len: int = 220) -> dict:
    return {
        "bvid": video.get("bvid"),
        "title": video.get("title"),
        "url": video.get("url"),
        "pubdate_text": video.get("pubdate_text"),
        "duration": video.get("duration"),
        "play": video.get("play"),
        "like": video.get("like"),
        "tag": video.get("tag"),
        "cover": video.get("cover"),
        "desc": _video_synopsis(video.get("desc", ""), desc_len),
    }


def _build_up_context(ups: list[dict]) -> list[dict]:
    """给 UI 的双 UP 对照卡：小谢的主题清单 + 原点公社的周复盘要点。"""
    contexts: list[dict] = []
    for up in ups:
        selected = up.get("selected") or []
        if not selected:
            continue
        if up["name"].startswith("你好小谢"):
            video = selected[0]
            title = video.get("title", "")
            tail = title.split("：", 1)[1] if "：" in title else title
            keywords = [x.strip() for x in re.split(r"[、，]", tail) if x.strip()][:12]
            contexts.append({
                "kind": "daily",
                "name": up["name"],
                "role": up.get("role", "每日逐条速览"),
                "accent": up.get("accent", "#e46a76"),
                "note": "同日速览覆盖的主题关键词",
                "video": _video_meta(video),
                "keywords": keywords,
            })
        else:
            videos: list[dict] = []
            points: list[dict] = []
            for video in selected:
                title = video.get("title", "")
                if "一周复盘" not in title and "周复盘" not in title:
                    continue
                videos.append(_video_meta(video))
                for line in (video.get("desc") or "").splitlines():
                    line = clean_text(line)
                    if not line:
                        continue
                    m = re.match(r"^(\d{1,2}月\d{1,2}日)[，,]\s*(.*)$", line)
                    date_label = m.group(1) if m else ""
                    text = m.group(2) if m else line
                    sentences = split_sentences(text)
                    if not sentences:
                        continue
                    points.append({
                        "date": date_label,
                        "text": sentences[0][:100],
                        "question": "".join(sentences[1:])[:100],
                        "source_url": video.get("url", ""),
                        "source_title": title,
                    })
                    if len(points) >= 8:
                        break
                if len(points) >= 8:
                    break
            if not videos:
                videos = [_video_meta(v) for v in selected[:1]]
            if not points:
                for video in videos[:1]:
                    for sentence in split_sentences(video.get("desc", ""))[:4]:
                        points.append({
                            "date": "",
                            "text": sentence[:100],
                            "question": "",
                            "source_url": video.get("url", ""),
                            "source_title": video.get("title", ""),
                        })
            contexts.append({
                "kind": "weekly",
                "name": up["name"],
                "role": up.get("role", "周度政策复盘"),
                "accent": up.get("accent", "#5b8c85"),
                "note": "周度复盘：把单日新闻放回政策周期",
                "videos": videos,
                "points": points[:8],
            })
    return contexts


def build_digest(raw: dict, up_data: list[dict]) -> dict:
    day = date.fromisoformat(raw["date"])
    episode = raw["episode"]
    segments_raw = raw["segments"]
    brief_groups = parse_program_brief(episode.get("brief", ""))

    # UP 主：标记是否同日视频、筛选候选视频
    ups: list[dict] = []
    for up in up_data:
        selected = up.get("selected") or []
        relation_hint = ""
        for video in selected:
            title = video.get("title", "")
            if f"{day.year}年{day.month}月{day.day}日" in title or f"{day.month}月{day.day}日" in title:
                relation_hint = "同日"
                break
        ups.append({**up, "relation_hint": relation_hint})
    all_selected = [v for up in ups for v in (up.get("selected") or [])]

    segments: list[dict] = []
    for index, row in enumerate(segments_raw, start=1):
        title = clean_text(row.get("title") or row.get("raw_title") or f"第{index}条")
        paragraphs = [clean_paragraph(p) for p in (row.get("paragraphs") or []) if clean_paragraph(p)]
        transcript = clean_text(row.get("transcript", "")) or "\n".join(paragraphs)
        summary = summarize_text(title, paragraphs)
        segment = {
            "id": index,
            "title": title,
            "raw_title": row.get("raw_title", title),
            "duration": row.get("duration", ""),
            "url": row.get("url", ""),
            "image": row.get("image", ""),
            "published": row.get("published", ""),
            "transcript": transcript,
            "paragraphs": paragraphs,
            "summary": summary,
            "brief_text": "",
            "brief_items": [],
            "tags": [],
            "category": "",
            "offset": row.get("offset") or {},
            "video": row.get("video") or {},
            "error": row.get("error", ""),
        }
        segments.append(segment)

    assign_brief(segments, brief_groups)

    for segment in segments:
        if not segment["summary"]:
            segment["summary"] = segment["brief_text"] or segment["title"]
        # 快讯类用节目单条目重组摘要，避免原文流水账
        if "联播快讯" in segment["title"] and segment["brief_items"]:
            quick = summarize_quick_news(segment["brief_items"], max_items=6)
            if quick:
                segment["summary"] = quick
        segment["category"] = classify(segment["title"], segment["summary"])
        terms = extract_terms(segment["title"] + " " + segment["summary"], 10)
        segment["tags"] = [t for t in terms if t in LEXICON][:4] or terms[:3]
        segment["takes"] = match_up_takes(segment, ups, max_takes=2)

    # 同一段 UP 原话不在多条新闻中重复使用；优先留给匹配度更高的新闻
    allocated: list[tuple[float, int, dict]] = []
    for segment in segments:
        for take in segment["takes"]:
            allocated.append((float(take.get("score") or 0), segment["id"], take))
    allocated.sort(key=lambda item: item[0], reverse=True)
    seen_quotes: set[tuple[str, str]] = set()
    allowed: dict[int, list[dict]] = defaultdict(list)
    for _, seg_id, take in allocated:
        key = (str(take.get("bvid")), str(take.get("quote")))
        if key in seen_quotes:
            continue
        seen_quotes.add(key)
        allowed[seg_id].append(take)
    for segment in segments:
        segment["takes"] = sorted(allowed[segment["id"]], key=lambda t: t.get("score", 0), reverse=True)[:2]
        segment["narration"] = build_narration(segment["id"], segment, segment["takes"])

    # 主题统计
    category_counts = Counter(s["category"] for s in segments)
    themes = [{"name": name, "count": count} for name, count in category_counts.most_common() if name != "综合"]
    if not themes:
        themes = [{"name": "综合", "count": len(segments)}]
    tag_counts = Counter()
    for seg in segments:
        for tag in seg["tags"]:
            tag_counts[tag] += 1
    tags = [
        tag for tag, _ in tag_counts.most_common(40)
        if tag not in GENERIC_TERMS and tag not in DISPLAY_TAG_BLOCK
    ][:6]
    headline_tags = [tag for tag in tags if tag not in HEADLINE_TAG_BLOCK][:3]

    domestic = sum(1 for s in segments if s["category"] != "国际")
    international = len(segments) - domestic
    transcript_chars = sum(len(s["transcript"]) for s in segments)
    narration_chars = sum(len(s["narration"]) for s in segments)

    overview = _build_overview(day, segments, episode, themes, tags)
    n = len(segments)
    headline = ""
    if headline_tags:
        headline = "、".join(headline_tags) + f"：今晚联播的{n}个观察点"
    elif tags:
        headline = "、".join(tags[:3]) + f"：今晚联播的{n}个观察点"
    else:
        headline = f"今晚联播的{n}个观察点"
    up_context = _build_up_context(ups)
    linkage = _build_linkage(day, segments, ups, tags, up_context)

    # UP 使用统计
    up_counts = Counter()
    for seg in segments:
        for take in seg["takes"]:
            up_counts[take["up_name"]] += 1
    ups_out: list[dict] = []
    for up in ups:
        selected = [_video_meta(video, 260) for video in (up.get("selected") or [])[:3]]
        ups_out.append({
            "name": up.get("name"),
            "uid": up.get("uid"),
            "role": up.get("role"),
            "accent": up.get("accent", "#5b8c85"),
            "avatar": (up.get("selected") or [{}])[0].get("avatar") or "",
            "url": f"https://space.bilibili.com/{up.get('uid')}" if up.get("uid") else "",
            "selected": selected,
            "video_count": len(up.get("videos") or []),
            "matched_segments": up_counts.get(up.get("name"), 0),
            "from_cache": up.get("from_cache", False),
            "error": up.get("error", ""),
        })

    video_count = sum(1 for s in segments if (s.get("video") or {}).get("mp4"))
    stats = {
        "segment_count": len(segments),
        "duration": episode.get("duration", ""),
        "domestic_count": domestic,
        "international_count": international,
        "up_count": len([u for u in ups_out if u["selected"]]),
        "source_video_count": video_count,
        "transcript_chars": transcript_chars,
        "narration_chars": narration_chars,
        "estimated_voice_minutes": round(narration_chars / 235, 1),
    }

    digest = {
        "date": day.isoformat(),
        "display_date": display_date(day),
        "weekday": weekday_cn(day),
        "year": day.year,
        "month": day.month,
        "day": day.day,
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "headline": headline,
        "overview": overview,
        "themes": themes[:4],
        "tags": tags[:6],
        "episode": {
            "title": episode.get("title", ""),
            "url": episode.get("url", ""),
            "day_url": episode.get("day_url", ""),
            "duration": episode.get("duration", ""),
            "image": episode.get("image", ""),
            "published": episode.get("published", ""),
            "brief": episode.get("brief", ""),
        },
        "stats": stats,
        "linkage": linkage,
        "up_context": up_context,
        "segments": segments,
        "ups": ups_out,
        "editor_note": (
            "文字摘要由规则算法从央视网原文中抽取，UP 观点均为 B 站公开视频标题/简介的原话节录，"
            "不代表本程序立场；完整信息请以央视网与 B 站原视频为准。"
        ),
        "data_warnings": [s["error"] for s in segments if s.get("error")],
    }
    return digest
