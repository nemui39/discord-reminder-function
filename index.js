// Google Cloud Secret Manager クライアントライブラリをインポート
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
// date-fns から必要な関数をインポート
const { addDays, getDay, getDate, format } = require('date-fns');
// 注意: タイムゾーンを正確に扱う場合は date-fns-tz の導入も検討
// const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');
// const japanTimeZone = 'Asia/Tokyo';

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

// --- ここからゴミ出し情報判定ロジック ---

/**
 * 指定された日付（JST基準と仮定）の河内長野市小塩町のゴミ収集情報を取得する
 * @param {Date} targetDate ゴミ収集情報を知りたい日付
 * @returns {string | null} ゴミの種類（複数ある場合は「、」で連結）、収集がない場合は null
 */
function getGarbageInfo(targetDate) {
  const garbageTypes = []; // その日のゴミ種類を格納する配列

  // date-fns を使って日付情報を取得
  const dayOfWeek = getDay(targetDate);     // 曜日 (0 = 日曜, 1 = 月曜, ..., 6 = 土曜)
  const dateOfMonth = getDate(targetDate);   // 日にち (1から31)

  // 月の第何週かを正確に計算
  const firstDayOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1).getDay();  // 月初日の曜日
  const weekOfMonth = Math.ceil((dateOfMonth + firstDayOfMonth) / 7);

  // デバッグ用ログ（必要に応じてコメントアウト）
  // console.log(`Checking garbage for: ${format(targetDate, 'yyyy-MM-dd')}, DayOfWeek: ${dayOfWeek}, WeekOfMonth: ${weekOfMonth}`);

  // 燃えるゴミ: 水曜(3) または 土曜(6)
  if (dayOfWeek === 3 || dayOfWeek === 6) {
    garbageTypes.push('燃えるゴミ');
  }

  // 火曜日(2)の特別収集チェック
  if (dayOfWeek === 2) {
    if (weekOfMonth === 1) {
      // 第1火曜
      garbageTypes.push('ペットボトル');
      garbageTypes.push('プラスチック製容器包装');
    }
    if (weekOfMonth === 2) {
      // 第2火曜
      garbageTypes.push('燃えないゴミ');
    }
    if (weekOfMonth === 3) {
      // 第3火曜
      garbageTypes.push('プラスチック製容器包装');
    }
    if (weekOfMonth === 4) {
      // 第4火曜
      garbageTypes.push('カン・ビン・小型金属・古紙・古布');
    }
  }

  // 収集があるかチェック
  if (garbageTypes.length > 0) {
    return garbageTypes.join('、'); // 配列を「、」で連結して返す (例: "ペットボトル、プラスチック製容器包装")
  } else {
    return null; // 収集日ではない場合は null を返す
  }
}

// --- Cloud Functions のエントリーポイント (Pub/Sub トリガーの場合) ---
// エクスポートする関数名はデプロイ時に指定します (例: discordReminder)
exports.discordReminder = async (pubSubEvent, context) => {
  // 関数が実行されたときのタイムスタンプ (通常はUTC)
  const executionTime = new Date();
  console.log(`Function started at ${executionTime.toISOString()} (UTC)`);

  // --- JSTでの「明日」を計算 ---
  // 注意: Cloud Functions のデフォルトタイムゾーンはUTCの場合が多いです。
  // Cloud Scheduler で実行時間を JST で指定しても、Date() はUTC基準で動くことがあります。
  // ここでは簡易的にUTCから9時間進めてJST相当とし、その日付で「明日」を計算します。
  // より正確な方法は date-fns-tz を使うか、関数のタイムゾーン設定(第2世代)を利用します。
  const JST_OFFSET = 9 * 60 * 60 * 1000; // 9時間 (ミリ秒)
  const nowInJST = new Date(executionTime.getTime() + JST_OFFSET);
  const tomorrowInJST = addDays(nowInJST, 1); // JST基準での明日

  // デバッグ用に日付を出力
  console.log(`Calculated current JST (approx): ${format(nowInJST, 'yyyy-MM-dd HH:mm:ss')}`);
  const targetDateStr = format(tomorrowInJST, 'yyyy-MM-dd');
  console.log(`Target date for reminders: ${targetDateStr} (Tomorrow in JST)`);

  try {
    // シークレットを取得
    const secrets = await getSecrets();
    console.log('Secrets fetched successfully.');

    // --- ゴミ出し情報取得 ---
    const garbageInfo = getGarbageInfo(tomorrowInJST);
    let garbageMessage = `明日のゴミ出し (${targetDateStr}): `;
    if (garbageInfo) {
      garbageMessage += garbageInfo;
      console.log(garbageMessage);
    } else {
      garbageMessage += '収集はありません。';
      console.log(garbageMessage);
    }

    // --- TODO: ここから図書館情報取得、メッセージ統合、Discord送信 ---
    // let libraryMessage = await getLibraryReminderMessage(); // 次のステップで実装
    // let finalMessage = garbageMessage + "\n\n" + libraryMessage;
    // await sendDiscordMessage(secrets.discordWebhookUrl, finalMessage); // さらに次のステップで実装

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
      
      // ローカルでゴミ出し情報テストも追加
      const today = new Date();
      const tomorrow = addDays(today, 1);
      const testGarbage = getGarbageInfo(tomorrow);
      console.log(`Garbage info for ${format(tomorrow, 'yyyy-MM-dd')}: ${testGarbage || 'None'}`);
    } catch (error) {
      console.error('Local test failed:', error);
    }
  })();
}
*/

