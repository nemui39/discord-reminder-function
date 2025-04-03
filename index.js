// Google Cloud Secret Manager クライアントライブラリをインポート
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Secret Manager クライアントを初期化
const client = new SecretManagerServiceClient();

/**
 * Secret Manager から最新バージョンのシークレットの値を取得する関数
 * @param {string} secretName シークレット名 (例: 'library-id')
 * @returns {Promise<string>} シークレットの値
 */
async function accessSecretVersion(secretName) {
  // Google Cloud プロジェクト ID を自動で取得するか、環境変数などから設定
  // 注意: 'YOUR_PROJECT_ID' は実際のプロジェクト ID に置き換えるか、
  // Cloud Functions 環境では自動で設定されることが多いです。
  // ローカルテスト用に process.env.GOOGLE_CLOUD_PROJECT を設定することもできます。
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'learngcp-455101';
  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;

  try {
    // シークレットの値にアクセス
    const [version] = await client.accessSecretVersion({ name: name });

    // ペイロードは Base64 エンコードされているのでデコードする
    const payload = version.payload.data.toString('utf8');
    console.log(`Successfully accessed secret: ${secretName}`); // ログ出力（デバッグ用）
    return payload;
  } catch (error) {
    console.error(`Error accessing secret ${secretName}:`, error);
    throw new Error(`Failed to access secret ${secretName}`);
  }
}

/**
 * 必要な全てのシークレットを取得する関数（例）
 * @returns {Promise<object>} 取得したシークレットを含むオブジェクト
 */
async function getSecrets() {
  // 並行してシークレットを取得
  const [libraryId, libraryPassword, discordWebhookUrl] = await Promise.all([
    accessSecretVersion('library-id'),
    accessSecretVersion('library-password'),
    accessSecretVersion('discord-webhook-url'),
  ]);

  return {
    libraryId,
    libraryPassword,
    discordWebhookUrl,
  };
}

// --- Cloud Functions のエントリーポイント (Pub/Sub トリガーの場合) ---
// エクスポートする関数名はデプロイ時に指定します (例: discordReminder)
exports.discordReminder = async (pubSubEvent, context) => {
  console.log('Function started.');

  try {
    // まずはシークレットを取得してみる (動作確認)
    const secrets = await getSecrets();
    console.log('Secrets fetched successfully.');
    // 注意: 実際の運用ではパスワードなどをそのままログに出さない
    // console.log('Library ID:', secrets.libraryId); // デバッグ時のみ
    // console.log('Discord URL:', secrets.discordWebhookUrl); // デバッグ時のみ

    // TODO: ここにゴミ出し情報取得、図書館情報取得、メッセージ作成、Discord送信のロジックを追加

    console.log('Function finished successfully.');

  } catch (error) {
    console.error('Function execution failed:', error);
    // エラー発生時はリトライさせるためにエラーを再スローするのが一般的
    throw error;
  }
};

// --- ローカルテスト用 (オプション) ---
// ローカルで `node index.js` を実行したときに getSecrets を試す
/*
if (require.main === module) {
  (async () => {
    try {
      // ローカルテストには Application Default Credentials (ADC) の設定が必要です
      // gcloud auth application-default login
      console.log('Running local test...');
      const secrets = await getSecrets();
      console.log('Local test secrets fetched:');
      console.log('- Library ID:', secrets.libraryId ? 'Fetched' : 'Failed');
      console.log('- Library Password:', secrets.libraryPassword ? 'Fetched' : 'Failed');
      console.log('- Discord Webhook URL:', secrets.discordWebhookUrl ? 'Fetched' : 'Failed');
    } catch (error) {
      console.error('Local test failed:', error);
    }
  })();
}
*/