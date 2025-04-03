// Google Cloud Secret Manager クライアントライブラリをインポート
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
// date-fns から必要な関数をインポート
const { addDays, getDay, getDate, format, differenceInCalendarDays, parse } = require('date-fns');
// 注意: タイムゾーンを正確に扱う場合は date-fns-tz の導入も検討
// const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');
// const japanTimeZone = 'Asia/Tokyo';
const axios = require('axios');     // axios をインポート
const cheerio = require('cheerio'); // cheerio をインポート

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

// --- ここから図書館スクレイピングロジック ---

/**
 * 河内長野市立図書館サイトにログインし、貸出中の書籍情報を取得する
 * @param {string} libraryId 利用者番号
 * @param {string} libraryPassword パスワード
 * @returns {Promise<Array<{title: string, returnDate: Date}>>} 書籍情報の配列
 */
async function getLibraryBooks(libraryId, libraryPassword) {
  const loginUrl = 'https://www1.city.kawachinagano.lg.jp/WebOpac/webopac/login.do';
  const targetUrl = 'https://www1.city.kawachinagano.lg.jp/WebOpac/webopac/userlist.do?type=2&page=1';

  // axios で使う共通ヘッダー (GASのものを参考に)
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
  };

  try {
    // 1. ログイン実行 (POST)
    console.log('Attempting library login...');
    // URLエンコードされたフォームデータを準備
    const loginPayload = new URLSearchParams({
      userno: libraryId,
      passwd: libraryPassword,
    }).toString();

    const loginResponse = await axios.post(loginUrl, loginPayload, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      maxRedirects: 5, // リダイレクトを追跡 (GAS の followRedirects: true 相当)
      // Cookie を手動で管理するため、axios のデフォルト Cookie 管理は使わない場合がある
      // (レスポンスから Set-Cookie を取得するため)
      // または axios-cookiejar-support のようなライブラリを使う
    });

    console.log(`Login response status: ${loginResponse.status}`);
    // ログイン成功したかどうかの判定が必要（ステータスコードだけでは不十分な場合あり）
    // 例：レスポンスのHTMLに「ログインできませんでした」等の文言がないか確認

    // レスポンスヘッダーから Cookie を取得
    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies || cookies.length === 0) {
      // ログイン失敗の可能性が高い（Cookieが設定されない）
      // サイトによってはリダイレクト後のレスポンスにCookieが含まれる場合もある
      console.error('Login failed: No Set-Cookie header found in response.');
      // ここでHTMLの内容を確認して失敗かどうか判定するロジックを追加するとより堅牢
      // console.error('Login Response Body:', loginResponse.data.substring(0, 500));
      throw new Error('図書館へのログインに失敗しました (Cookieが取得できませんでした)。ID/パスワードを確認してください。');
    }
    // 配列の各要素から `key=value` の部分だけを取り出す (例: 'JSESSIONID=xxxxx; Path=/; HttpOnly' -> 'JSESSIONID=xxxxx')
    const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
    console.log('Cookies obtained.');


    // 2. 貸出一覧ページを取得 (GET)
    console.log('Fetching borrowing list...');
    const bookListResponse = await axios.get(targetUrl, {
      headers: {
        ...headers,
        'Cookie': cookieString, // 取得した Cookie を設定
      },
      maxRedirects: 5,
    });

    console.log(`Book list page status: ${bookListResponse.status}`);
    const html = bookListResponse.data;


    // 3. HTML をパースして書籍情報を抽出 (Cheerio)
    console.log('Parsing HTML...');
    const $ = cheerio.load(html);
    const books = [];

    // 注意: 以下のセレクタは図書館サイトのHTML構造に依存します。
    // 実際のHTMLを確認し、必要に応じて調整してください。
    // GASの正規表現を参考に、構造を推測しています。
    // 例: <table class="list"><tbody><tr><td>...<strong>タイトル</strong>...</td><td class="nwrap">YYYY/MM/DD</td></tr>...</tbody></table> のような構造を想定

    $('table.list_table tbody tr').each((index, element) => { // テーブルや行を特定するセレクタ (要調整)
      try {
          // タイトルを取得 (例: <tr>内の<td>の中の<strong>タグ)
          const titleElement = $(element).find('td').eq(1).find('strong'); // 例: 2番目の<td>内の<strong> (要調整)
          const title = titleElement.text().trim();

          // 返却日を取得 (例: "nwrap" クラスを持つ <td>)
          const dateElement = $(element).find('td.nwrap'); // 例: nwrapクラスの<td> (要調整)
          const returnDateStr = dateElement.text().trim(); // "YYYY/MM/DD" 形式

          if (title && returnDateStr) {
            // 日付文字列を Date オブジェクトに変換
            // 'YYYY/MM/DD' 形式をパースし、JSTとして扱う（0時0分0秒）
            // 注意: parse関数は環境のタイムゾーンに影響される可能性があるため、UTCやオフセットを考慮するとより安全
            const returnDate = parse(returnDateStr, 'yyyy/MM/dd', new Date());
            // タイムゾーンの問題を避けるため、日付のみで比較するのが安全な場合もある
            // JSTの0時を基準にする
            returnDate.setHours(0, 0, 0, 0);

            if (!isNaN(returnDate.getTime())) { // 正しい日付か確認
                books.push({ title, returnDate });
            } else {
                console.warn(`Failed to parse date: ${returnDateStr} for title: ${title}`);
            }
          }
      } catch(parseError) {
          console.warn(`Error parsing row ${index}:`, parseError.message);
      }
    });

    console.log(`Found ${books.length} books.`);
    return books;

  } catch (error) {
    console.error('Error fetching library books:', error.message);
    // エラーレスポンスの詳細をログ出力（デバッグ用）
    if (error.response) {
      console.error('Error Response Status:', error.response.status);
      // console.error('Error Response Headers:', error.response.headers);
      // console.error('Error Response Data:', error.response.data.substring(0, 500));
    }
    throw new Error('図書館の貸出情報の取得中にエラーが発生しました。');
  }
}

/**
 * 取得した書籍リストからリマインドメッセージを作成する
 * @param {Array<{title: string, returnDate: Date}>} books 貸出中の書籍リスト
 * @param {Date} baseDate リマインドの基準日 (JST)
 * @returns {string | null} リマインドメッセージ、対象がない場合は null
 */
function createLibraryReminderMessage(books, baseDate) {
  const reminders = { '3days': [], '1day': [] };

  books.forEach(book => {
    // baseDate (JSTの今日) と returnDate (JSTの返却日) の差を計算
    const daysUntilDue = differenceInCalendarDays(book.returnDate, baseDate);

    if (daysUntilDue === 3) {
      reminders['3days'].push(book.title);
    } else if (daysUntilDue === 1) {
      reminders['1day'].push(book.title);
    }
  });

  let message = '';
  if (reminders['3days'].length > 0) {
    message += `【図書館】3日後に返却期限の本が ${reminders['3days'].length}冊 あります:\n`;
    reminders['3days'].forEach(title => {
      message += `・ ${title}\n`;
    });
    message += '\n';
  }
  if (reminders['1day'].length > 0) {
    message += `【図書館】明日の返却期限の本が ${reminders['1day'].length}冊 あります:\n`;
    reminders['1day'].forEach(title => {
      message += `・ ${title}\n`;
    });
  }

  return message.trim() || null; // メッセージが空なら null を返す
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
    let garbageMessage = `【ゴミ出し】明日の収集 (${targetDateStr}): ${garbageInfo || 'ありません'}`;
    console.log(garbageMessage);

    // 図書館情報取得
    let libraryMessage = null;
    try {
        const books = await getLibraryBooks(secrets.libraryId, secrets.libraryPassword);
        libraryMessage = createLibraryReminderMessage(books, nowInJST); // 今日の日付を基準にリマインドを計算
        if (libraryMessage) {
            console.log('Library reminders generated.');
        } else {
            console.log('No library books due soon.');
        }
    } catch (libraryError) {
        console.error('Failed to get library info:', libraryError);
        libraryMessage = "【図書館】貸出情報の取得に失敗しました。"; // エラーメッセージを設定
    }

    // --- TODO: メッセージ統合、Discord送信 ---
    let finalMessage = garbageMessage;
    if (libraryMessage) {
        finalMessage += "\n\n" + libraryMessage;
    }
    console.log("--- Final Message ---");
    console.log(finalMessage);
    console.log("---------------------");
    // await sendDiscordMessage(secrets.discordWebhookUrl, finalMessage); // 次のステップで実装

    console.log('Function finished successfully.');

  } catch (error) {
    console.error('Function execution failed:', error);
    // エラー発生時はリトライさせるためにエラーを再スローするのが一般的
    throw error;
  }
};

// --- ローカルテスト用 (オプション) ---
// ローカルで `node index.js` を実行したときに getSecrets を試す
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
      
      // 図書館情報取得テストを追加 (ID/PWが必要)
      if (secrets.libraryId && secrets.libraryPassword) {
          console.log('Testing library scrape...');
          const books = await getLibraryBooks(secrets.libraryId, secrets.libraryPassword);
          const libReminder = createLibraryReminderMessage(books, today);
          console.log('Library Reminder Message:');
          console.log(libReminder || 'None');
      } else {
          console.warn('Skipping library scrape test: ID or Password secret not found.');
      }
    } catch (error) {
      console.error('Local test failed:', error);
    }
  })();
}


