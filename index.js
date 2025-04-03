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
  // HTTPSを使用するように修正
  const baseUrl = 'https://www1.city.kawachinagano.lg.jp/WebOpac/webopac';
  const loginUrl = `${baseUrl}/login.do`;
  const targetUrl = `${baseUrl}/userlist.do?type=2&page=1`;

  // 利用者番号が8桁の半角数字かチェック
  if (!/^\d{8}$/.test(libraryId)) {
    console.error('Library ID must be 8 digits number');
    throw new Error('図書館IDは8桁の半角数字である必要があります。');
  }

  // パスワードが6～15桁の半角英数字かチェック
  if (!/^[A-Za-z0-9-]{6,15}$/.test(libraryPassword)) {
    console.error('Library password must be 6-15 alphanumeric characters');
    throw new Error('図書館パスワードは6～15桁の半角英数字である必要があります。');
  }

  // axios で使う共通ヘッダー (より実際のブラウザに近いものに変更)
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": "\"Google Chrome\";v=\"122\", \"Not(A:Brand\";v=\"24\", \"Chromium\";v=\"122\"",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"Windows\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1"
  };

  // より詳細なデバッグ情報
  console.log(`Using Library ID: ${libraryId.substring(0, 2)}******`); // セキュリティのため一部のみ表示
  console.log(`Using baseUrl: ${baseUrl}`);

  try {
    // デバッグのためにまずログインページを取得して確認
    console.log('Fetching login page first to analyze form...');
    const loginPageResponse = await axios.get(loginUrl, { 
      headers,
      timeout: 10000, // タイムアウト10秒
    });
    console.log(`Login page status: ${loginPageResponse.status}`);
    
    // ログインページのHTML内容の一部を出力（フォーム部分を確認するため）
    const loginPageHtml = loginPageResponse.data;
    console.log('Login page form snippet:');
    // フォーム部分のみ抽出してログ出力
    const formMatch = loginPageHtml.match(/<form[^>]*action="[^"]*login\.do"[^>]*>[\s\S]*?<\/form>/i);
    if (formMatch) {
      console.log(formMatch[0]);
    } else {
      console.log('No login form found on the page!');
    }
    
    // JavaScript関数があれば抽出して分析
    const scriptMatch = loginPageHtml.match(/<script[^>]*>[\s\S]*?function login\(\)[\s\S]*?<\/script>/i);
    if (scriptMatch) {
      console.log('Found login() JavaScript function:');
      console.log(scriptMatch[0]);
    } else {
      console.log('No login() JavaScript function found. Looking for any script with form validation:');
      const allScripts = loginPageHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi);
      if (allScripts) {
        // フォーム検証に関連するキーワードを含むスクリプトを探す
        const validationScripts = allScripts.filter(script => 
          script.includes('form') || 
          script.includes('valid') || 
          script.includes('submit') ||
          script.includes('login')
        );
        if (validationScripts.length > 0) {
          console.log(`Found ${validationScripts.length} potentially relevant scripts.`);
          console.log(validationScripts[0]); // 最初の関連スクリプトを表示
        }
      }
    }

    // 隠しフィールドの値を抽出
    const $login = cheerio.load(loginPageHtml);
    const histnum = $login('form[action="login.do"] input[name="histnum"]').val() || '1';
    const forward = $login('form[action="login.do"] input[name="forward"]').val() || '';

    // 1. ログイン実行 (POST)
    console.log('Attempting library login...');
    // URLエンコードされたフォームデータを準備（隠しフィールドを含める）
    const loginPayload = new URLSearchParams({
      userno: libraryId,
      passwd: libraryPassword,
      histnum: histnum,
      forward: forward
    }).toString();
    
    console.log(`Login payload: ${loginPayload}`);

    const loginResponse = await axios.post(loginUrl, loginPayload, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www1.city.kawachinagano.lg.jp',
        'Referer': loginUrl,
      },
      maxRedirects: 5,
      validateStatus: null,
      timeout: 15000, // タイムアウト15秒
    });

    console.log(`Login response status: ${loginResponse.status}`);
    
    // レスポンスボディの一部をログ出力
    if (loginResponse.data) {
      const responseBodyPreview = loginResponse.data.substring(0, 1000);
      console.log('Login response body preview:');
      console.log(responseBodyPreview);
      
      // エラーメッセージを含んでいるか確認
      if (responseBodyPreview.includes('エラー') || 
          responseBodyPreview.includes('失敗') || 
          responseBodyPreview.includes('error') || 
          responseBodyPreview.includes('fail') ||
          responseBodyPreview.includes('タイムアウト')) {
        console.log('Error message found in response!');
        
        // エラーメッセージを抽出
        const errorMatch = loginResponse.data.match(/<div[^>]*class="[^"]*msg_plate[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (errorMatch) {
          console.log('Error message content:');
          const errorMsg = errorMatch[1].replace(/<[^>]*>/g, '').trim();
          console.log(errorMsg);
          throw new Error(`図書館へのログイン失敗: ${errorMsg}`);
        } else if (loginResponse.data.includes('タイムアウト')) {
          throw new Error('図書館へのログインがタイムアウトしました。');
        }
      }
      
      // ログイン後にリダイレクトする JavaScript があるか確認
      if (responseBodyPreview.includes('location.href') || responseBodyPreview.includes('window.location')) {
        console.log('Found JavaScript redirect in response.');
        const redirectMatch = loginResponse.data.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) || 
                             loginResponse.data.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i);
        if (redirectMatch) {
          const redirectUrl = redirectMatch[1];
          console.log(`JavaScript redirect to: ${redirectUrl}`);
          
          // リダイレクト先を手動で取得
          console.log('Following JavaScript redirect manually...');
          const redirectResponse = await axios.get(new URL(redirectUrl, baseUrl).href, {
            headers: {
              ...headers,
              'Cookie': cookieString,
              'Referer': loginUrl,
            },
            maxRedirects: 5,
          });
          console.log(`Redirect response status: ${redirectResponse.status}`);
        }
      }
    }
    
    // ヘッダー情報をログ出力
    console.log('Response headers:', JSON.stringify(loginResponse.headers, null, 2));

    // レスポンスヘッダーから Cookie を取得
    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies || cookies.length === 0) {
      // ログイン失敗の可能性が高い（Cookieが設定されない）
      // サイトによってはリダイレクト後のレスポンスにCookieが含まれる場合もある
      console.error('Login failed: No Set-Cookie header found in response.');
      throw new Error('図書館へのログインに失敗しました (Cookieが取得できませんでした)。ID/パスワードを確認してください。');
    }
    // 配列の各要素から `key=value` の部分だけを取り出す (例: 'JSESSIONID=xxxxx; Path=/; HttpOnly' -> 'JSESSIONID=xxxxx')
    const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
    console.log('Cookies obtained:', cookieString);

    // 2. 貸出一覧ページを取得 (GET)
    console.log('Fetching borrowing list...');
    const bookListResponse = await axios.get(targetUrl, {
      headers: {
        ...headers,
        'Cookie': cookieString,
        'Referer': loginUrl,
      },
      maxRedirects: 5,
      timeout: 10000, // タイムアウト10秒
    });

    console.log(`Book list page status: ${bookListResponse.status}`);
    const html = bookListResponse.data;
    
    // HTMLの一部をログ出力して構造を確認
    console.log('Book list page HTML preview:');
    console.log(html.substring(0, 3000)); // 最初の3000文字を表示
    
    // 特に書籍テーブルを探す
    const tableMatch = html.match(/<table[^>]*class="[^"]*list[^"]*"[^>]*>[\s\S]*?<\/table>/i);
    if (tableMatch) {
      console.log('Found book list table:');
      console.log(tableMatch[0]);
    } else {
      console.log('No book list table found with class containing "list"!');
      
      // 他のテーブルをすべて探してみる
      const allTables = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi);
      if (allTables && allTables.length > 0) {
        console.log(`Found ${allTables.length} tables on the page. First table:`);
        console.log(allTables[0]);
      } else {
        console.log('No tables found at all!');
      }
    }

    // 3. HTML をパースして書籍情報を抽出 (Cheerio)
    console.log('Parsing HTML with Cheerio...');
    const $ = cheerio.load(html);
    
    // 使用可能なテーブルクラスをすべて表示
    const tableClasses = [];
    $('table').each((i, el) => {
      const cls = $(el).attr('class');
      if (cls) tableClasses.push(cls);
    });
    console.log('Available table classes:', tableClasses);
    
    // すべてのテーブルを調査
    console.log(`Found ${$('table').length} tables on the page`);
    
    const books = [];
    
    // より柔軟なテーブル検出
    // クラス名に「list」を含むテーブルを優先的に調査
    let bookTable = $('table[class*="list"]');
    
    // クラスで見つからなかった場合は、他の方法でテーブルを特定
    if (bookTable.length === 0) {
      console.log('No table with class containing "list" found, trying alternative detection methods...');
      
      // 1. thに「貸出期限」を含むテーブルを探す
      $('th:contains("貸出期限"), th:contains("返却期限")').each((i, el) => {
        const parentTable = $(el).closest('table');
        if (parentTable.length > 0) {
          console.log('Found table with return date header');
          bookTable = parentTable;
          return false; // eachループを抜ける
        }
      });
      
      // 2. まだ見つからない場合は日付っぽい形式(YYYY/MM/DD)を含む行を持つテーブルを探す
      if (bookTable.length === 0) {
        $('td').each((i, el) => {
          const text = $(el).text().trim();
          if (/\d{4}\/\d{2}\/\d{2}/.test(text)) { // YYYY/MM/DD形式を検索
            console.log('Found table with date format text');
            bookTable = $(el).closest('table');
            return false; // eachループを抜ける
          }
        });
      }
      
      // 3. それでも見つからない場合は、大きめのテーブルでtdを持つものを使用
      if (bookTable.length === 0 && $('table').length > 0) {
        $('table').each((i, el) => {
          if ($(el).find('td').length > 5) { // ある程度の列数があるテーブル
            console.log(`Using table #${i+1} with ${$(el).find('td').length} cells as fallback`);
            bookTable = $(el);
            return false; // eachループを抜ける
          }
        });
      }
    }
    
    // 見つかったテーブルから書籍情報を抽出
    if (bookTable.length > 0) {
      console.log('Processing book table, HTML:');
      console.log(bookTable.html().substring(0, 500)); // テーブルのHTML一部を表示
      
      // テーブルの構造を解析
      const hasHeaders = bookTable.find('th').length > 0;
      console.log(`Table has headers: ${hasHeaders}`);
      
      // 行を処理
      bookTable.find('tr').each((rowIndex, row) => {
        // ヘッダー行はスキップ
        if (rowIndex === 0 && hasHeaders) return;
        
        try {
          // 行内のセルを取得
          const cells = $(row).find('td');
          if (cells.length < 2) return; // 最低でも2つのセルが必要
          
          // タイトルを探す - 強調表示（<strong>）やリンク（<a>）を含むセルを優先
          let titleElement = null;
          let titleCell = null;
          
          // 強調表示されたテキストを探す
          cells.each((i, cell) => {
            const strong = $(cell).find('strong');
            if (strong.length > 0) {
              titleElement = strong;
              titleCell = cell;
              return false; // eachループを抜ける
            }
          });
          
          // 強調表示がなければリンクを探す
          if (!titleElement) {
            cells.each((i, cell) => {
              const link = $(cell).find('a');
              if (link.length > 0) {
                titleElement = link;
                titleCell = cell;
                return false;
              }
            });
          }
          
          // まだ見つからなければ、最も長いテキストを持つセルを使用
          if (!titleElement) {
            let maxLength = 0;
            cells.each((i, cell) => {
              const text = $(cell).text().trim();
              if (text.length > maxLength) {
                maxLength = text.length;
                titleCell = cell;
              }
            });
            titleElement = $(titleCell);
          }
          
          const title = titleElement ? titleElement.text().trim() : $(titleCell).text().trim();
          
          // 日付を探す - 日付形式(YYYY/MM/DD)を含むセルを探す
          let dateText = null;
          cells.each((i, cell) => {
            const text = $(cell).text().trim();
            if (/\d{4}\/\d{2}\/\d{2}/.test(text)) {
              dateText = text.match(/\d{4}\/\d{2}\/\d{2}/)[0]; // 日付部分を抽出
              return false;
            }
          });
          
          if (title && dateText) {
            // 日付形式をパース
            const returnDate = parse(dateText, 'yyyy/MM/dd', new Date());
            returnDate.setHours(0, 0, 0, 0);
            
            if (!isNaN(returnDate.getTime())) {
              books.push({ title, returnDate });
              console.log(`Found book: "${title}" due on ${format(returnDate, 'yyyy/MM/dd')}`);
            } else {
              console.warn(`Failed to parse date: ${dateText} for title: ${title}`);
            }
          }
        } catch (parseError) {
          console.warn(`Error parsing row ${rowIndex}:`, parseError.message);
        }
      });
    } else {
      console.log('No suitable book table found!');
    }

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


