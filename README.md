# Traffic Q1 Daily → WeCom

每天自动生成交通运输 / 智能交通 Q1 论文日报，并推送到企业微信群机器人。

## Schedule

Vercel Cron 使用 UTC。项目配置为：

```text
0 0 * * *
```

即每天 UTC 00:00，对应 Malaysia / Singapore (UTC+8) 的 08:00。

## Security first

如果企业微信 Webhook 曾被粘贴到聊天、邮件、公开仓库或其他不受控位置，请先在企业微信中重置 / 重新创建机器人 Webhook。

**不要把真实 Webhook 或 OpenAI API Key 写进代码。**

## Vercel Environment Variables

在 Vercel Project → Settings → Environment Variables 中添加：

- `OPENAI_API_KEY`：OpenAI API Key
- `WECOM_WEBHOOK_URL`：新生成的企业微信机器人 Webhook
- `CRON_SECRET`：自己生成的一段长随机字符串
- `OPENAI_MODEL`：可选，默认 `gpt-5.6`

建议前三项设置为 Sensitive / Encrypted，并至少应用到 Production。

## Deploy

把整个目录上传到 GitHub，然后在 Vercel 中 Import Project；或者使用 Vercel CLI：

```bash
vercel
vercel --prod
```

部署成功后 Vercel 会根据 `vercel.json` 注册 Cron。

## Test WeCom only

部署后，先测试企业微信链路：

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://YOUR_PROJECT.vercel.app/api/test
```

企业微信群应收到：

`交通Q1论文日报机器人测试成功`

## Test full daily report

确认 WeCom 测试成功后：

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://YOUR_PROJECT.vercel.app/api/daily
```

这个调用会产生 OpenAI API 与 Web Search 成本。

## Notes

- 企业微信 Markdown 单条消息有长度限制，所以代码按 UTF-8 字节自动切分。
- 为避免群机器人频率限制，分段消息之间会留出短间隔。
- 当前版本**尚未配置跨日持久化数据库**，因此“最近7天不重复”只能由模型尽力避免，不能数学上保证。
- 如果需要严格 7 日去重，下一版建议增加 Upstash Redis / Vercel KV，保存最近 7 日 DOI。
- 对 JCR Quartile 无法可靠核验的条目，Prompt 强制标记“需人工核验”，禁止猜测。
