これはゴミ出しと図書館の返却日を前日にdiscordに通知するものです。
gcloud runでデプロイされて18時にスケジューラーが図書館のスクローラーが動き、必要な通知をします。

## 通知時刻の変更

通知時刻はコードではなく Cloud Scheduler のジョブ側で決まっています。

- プロジェクト: `learngcp-455101`
- ジョブ名: `trigger-discord-reminder`（ロケーション `asia-northeast1`、有効）
- 同名のジョブが `asia-northeast2` にもあるが、こちらは一時停止中
- Pub/Sub トピック: `discord-reminder-topic` → Cloud Functions `discordReminder`（第2世代）

時刻を変えるときは以下を実行します。

```bash
# 現在のスケジュールを確認
gcloud scheduler jobs list --project=learngcp-455101 --location=asia-northeast1

# 18:00 JST に変更
gcloud scheduler jobs update pubsub trigger-discord-reminder \
  --project=learngcp-455101 \
  --location=asia-northeast1 \
  --schedule="0 18 * * *" \
  --time-zone="Asia/Tokyo"
```
