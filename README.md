これはゴミ出しと図書館の返却日を前日にdiscordに通知するものです。
gcloud runでデプロイされて18時にスケジューラーが図書館のスクローラーが動き、必要な通知をします。

## 通知時刻の変更

通知時刻はコードではなく Cloud Scheduler のジョブ側で決まっています（プロジェクト: `learngcp-455101`）。
時刻を変えるときは以下を実行します。

```bash
# ジョブ名と現在のスケジュールを確認
gcloud scheduler jobs list --project=learngcp-455101

# 18:00 JST に変更（JOB_NAME と LOCATION は上の結果に合わせる）
gcloud scheduler jobs update pubsub JOB_NAME \
  --project=learngcp-455101 \
  --location=LOCATION \
  --schedule="0 18 * * *" \
  --time-zone="Asia/Tokyo"
```
