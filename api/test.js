const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;
const CRON_SECRET = process.env.CRON_SECRET;

function authorized(req) {
  if (!CRON_SECRET) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${CRON_SECRET}`;
}

export default async function handler(req, res) {
  try {
    if (!authorized(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (!WECOM_WEBHOOK_URL) return res.status(500).json({ ok: false, error: "Missing WECOM_WEBHOOK_URL" });

    const content = `# ✅ 交通Q1论文日报机器人测试成功

> Vercel → 企业微信 Webhook 已连接。

下一步即可启用每日 08:00（马来西亚时间）的自动论文日报。`;

    const r = await fetch(WECOM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.errcode !== 0) {
      throw new Error(`WeCom send failed: HTTP ${r.status} ${JSON.stringify(body)}`);
    }

    return res.status(200).json({ ok: true, wecom: body });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
