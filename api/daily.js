const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;
const CRON_SECRET = process.env.CRON_SECRET;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6";

function todayMalaysia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function authorized(req) {
  if (!CRON_SECRET) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${CRON_SECRET}`;
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if ((part.type === "output_text" || part.type === "text") && part.text) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function utf8Bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

function splitWeComMarkdown(text, maxBytes = 3600) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const paras = normalized.split(/\n{2,}/);
  const out = [];
  let cur = "";

  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };

  for (const para of paras) {
    const candidate = cur ? `${cur}\n\n${para}` : para;
    if (utf8Bytes(candidate) <= maxBytes) {
      cur = candidate;
      continue;
    }
    flush();

    if (utf8Bytes(para) <= maxBytes) {
      cur = para;
      continue;
    }

    // Hard split by characters while respecting UTF-8 byte limit.
    let piece = "";
    for (const ch of para) {
      const next = piece + ch;
      if (utf8Bytes(next) > maxBytes) {
        if (piece) out.push(piece);
        piece = ch;
      } else {
        piece = next;
      }
    }
    if (piece) cur = piece;
  }
  flush();
  return out;
}

async function sendWeComMarkdown(content) {
  const r = await fetch(WECOM_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content }
    })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errcode !== 0) {
    throw new Error(`WeCom send failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const DAILY_PROMPT = `
你是一名严谨的交通运输与智能交通科研文献分析助手。今天日期为：{date}（Asia/Kuala_Lumpur）。

请生成《交通运输与智能交通 Q1 论文日报》，必须使用 web search 检索和核验最新资料。

研究范围：
- intelligent transportation systems
- traffic forecasting
- traffic prediction models
- urban traffic management
- floating-car data / FCD
- multi-source traffic sensing
- traffic reliability
- multimodal traffic prediction
- cross-border / CIQ congestion
- road-network resilience
- 时空预测、多时间尺度预测、多步预测
- 速度/流量/旅行时间预测
- GNN / ST-GNN / Transformer / 时空深度学习
- 机器学习、统计模型、混合模型
- 概率预测、不确定性量化、可靠性预测
- 可解释模型、迁移学习、跨区域泛化、轻量化模型
- 交通控制、信号优化、拥堵管理、事件检测、交通诱导
- 动态交通分配、交通需求管理、数字孪生
- 智慧城市交通管理、多源数据驱动决策、交通系统韧性

筛选规则：
1. 优先过去12个月正式发表或 Online First / Early Access 的论文；不足10篇时放宽至24个月。
2. 精选10篇。优先 SCI 收录、JCR Q1 或领域公认顶级期刊。
3. 优先但不限于：
   Transportation Research Part C;
   IEEE Transactions on Intelligent Transportation Systems;
   Transportation Research Part A/B/D/E;
   Transportmetrica A/B;
   Journal of Transport Geography;
   Reliability Engineering & System Safety;
   Nature Portfolio / Scientific Reports 中真正相关的高质量交通研究。
4. 不要为了凑数固定期刊。
5. 对“JCR Q1/分区”必须尽量核验。若无法从可靠来源确认具体 JCR 年份、学科类别或 quartile，明确写“需人工核验”，禁止猜测。
6. OA 状态优先以出版社/期刊官方页面核验，并区分 Gold OA、Hybrid、Subscription。Hybrid 要明确说明通常存在传统非OA发表路径，但不要把具体 APC 写死，除非当天官方页面可核验。
7. 必须给 DOI 或出版社官方论文链接。禁止虚构 DOI、作者、卷期、页码、数据集、结果数值。
8. 论文与研究主题匹配度不足时宁缺毋滥。
9. 尽量避免推荐近7天内常见的重复论文；如果无法访问历史日报记录，要明确在日报末尾说明“本自动化版本尚未启用跨日去重数据库，因此7日去重为尽力而为”。

每篇论文必须包含：
1）论文题目
2）作者与年份
3）期刊名称
4）SCI/JCR分区（注明可核验的 JCR 年份和学科类别；不确定则写需人工核验）
5）OA状态
6）DOI或官方论文链接
7）研究问题
8）核心数据与方法
9）1–3个主要创新点
10）主要结论
11）最值得学习/迁移的方法、实验设计、图表、论文结构或研究问题
12）与“JB–Singapore CIQ双向跨境交通、多源FCD/公交/天气、6/12/24 h预测、可靠性/泛化、城市交通管理与路网韧性”博士研究的相关性：高/中/低

最后增加：
- 今日最值得精读的3篇：逐篇说明原因
- 可直接转化为博士研究的3个想法：必须与证据边界一致，不夸大论文未证明内容
- 今日检索说明：12个月/24个月窗口、核验限制、是否存在需人工核验项

输出要求：
- 全文中文；论文标题和期刊名称保留英文。
- 使用适合企业微信 Markdown 阅读的简洁结构。
- 总长度控制在约 7000–10000 个中文字以内，信息密度高，不写空泛套话。
- 链接必须直接显示为可复制的 DOI URL 或出版社官方 URL。
`;

export default async function handler(req, res) {
  try {
    if (!authorized(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });
    }
    if (!WECOM_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Missing WECOM_WEBHOOK_URL" });
    }

    const date = todayMalaysia();
    const input = DAILY_PROMPT.replace("{date}", date);

    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        reasoning: { effort: "high" },
        tools: [{
          type: "web_search",
          search_context_size: "high"
        }],
        input
      })
    });

    const data = await openaiResp.json();
    if (!openaiResp.ok) {
      throw new Error(`OpenAI error: HTTP ${openaiResp.status} ${JSON.stringify(data)}`);
    }

    const report = extractOutputText(data);
    if (!report) throw new Error("OpenAI returned no readable output text.");

    const header = `# 交通运输与智能交通 Q1 论文日报\n> ${date} · 自动检索与生成`;
    const chunks = splitWeComMarkdown(`${header}\n\n${report}`);

    if (chunks.length > 18) {
      throw new Error(`Report split into ${chunks.length} WeCom messages; refusing to exceed safe burst size.`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `> 第 ${i + 1}/${chunks.length} 条\n\n` : "";
      await sendWeComMarkdown(prefix + chunks[i]);
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    return res.status(200).json({
      ok: true,
      date,
      messages_sent: chunks.length,
      chars: report.length,
      model: OPENAI_MODEL
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
