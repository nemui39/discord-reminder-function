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
  const indexUrl = `${baseUrl}/index.do`;  // トップページ
  const userMenuUrl = `${baseUrl}/usermenu.do`; // 正しいログインフォームページ
  const homeUrl = `${baseUrl}/home.do`;    // ホームページ
  const myPageUrl = `${baseUrl}/user.do`;  // マイページ
  const targetUrl = `${baseUrl}/userlist.do?type=2&page=1`; // 貸出一覧

  // 利用者番号が8桁の半角数字かチェック
  if (!/^\d{8}$/.test(libraryId)) {
    console.error('Library ID must be 8 digits number');
    throw new Error('図書館IDは8桁の半角数字である必要があります。');
  }

  // GASスクリプトと同じようにパスワードチェックを緩和
  // ハイフン（-）などの記号を含むパスワードも許可する
  console.log(`Using password with length: ${libraryPassword.length}`);
  
  // 長さのみのチェックに変更（GASスクリプトでは特に形式チェックをしていなかった）
  if (libraryPassword.length < 4 || libraryPassword.length > 20) {
    console.error('Library password length should be between 4 and 20 characters');
    throw new Error('図書館パスワードの長さが不適切です。');
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

  // ログイン試行回数を制限
  const MAX_LOGIN_ATTEMPTS = 2;
  let loginAttempts = 0;
  
  try {
    // 最初のアクセスで一回クッキーを得ておく
    console.log('Accessing index page to initialize session...');
    const indexResponse = await axios.get(`${baseUrl}/index.do`, {
      headers,
      timeout: 10000,
    });
    
    // 初期クッキーがあれば保存
    let initialCookies = '';
    if (indexResponse.headers['set-cookie']) {
      initialCookies = indexResponse.headers['set-cookie']
        .map(cookie => cookie.split(';')[0])
        .join('; ');
      console.log('Initial cookies obtained');
    }
    
    // ユーザーがログイン前に操作する典型的なページ遷移を模倣
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒待機

    // 重要な変更: 正しいログインフォームページ(usermenu.do)にアクセス
    console.log('Fetching user menu page with login form...');
    const userMenuResponse = await axios.get(userMenuUrl, { 
      headers: {
        ...headers,
        'Cookie': initialCookies,
      },
      timeout: 10000,
    });
    console.log(`User menu page status: ${userMenuResponse.status}`);
      
    // ログインページのHTML内容の一部を出力（フォーム部分を確認するため）
    const userMenuHtml = userMenuResponse.data;
    
    // 隠しフィールドの値を抽出
    const $loginPage = cheerio.load(userMenuHtml);
    // フォームのaction属性を取得（実際のフォーム送信先を確認）
    const loginFormAction = $loginPage('form').attr('action');
    console.log(`Login form action: ${loginFormAction}`);
    
    // FormのHiddenフィールドを取得
    const formInputs = {};
    $loginPage('form input[type="hidden"]').each((i, el) => {
      const name = $loginPage(el).attr('name');
      const value = $loginPage(el).attr('value');
      if (name) {
        formInputs[name] = value || '';
      }
    });
    console.log('Form hidden fields:', formInputs);
    
    // histnumとforwardのデフォルト値を設定
    const histnum = formInputs['histnum'] || '1';
    const forward = formInputs['forward'] || '';
    
    // Cookie再取得
    let loginPageCookies = initialCookies;
    if (userMenuResponse.headers['set-cookie']) {
      loginPageCookies = userMenuResponse.headers['set-cookie']
        .map(cookie => cookie.split(';')[0])
        .join('; ');
      console.log('User menu page cookies obtained');
    }
    
    // 通常ユーザーの動作を模倣: フォーム入力と送信の間に少し待機
    await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒待機
    
    // ユーザーがログインフォームを送信
    let cookieString = '';
    let loginSuccess = false;
    let actualLoginUrl = loginUrl; // 変数スコープを修正：ここで宣言して初期値を設定
    
    while (loginAttempts < MAX_LOGIN_ATTEMPTS) {
      loginAttempts++;
      console.log(`Login attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS}`);
      
      try {
        // フォームのaction属性に基づいてログインURLを決定
        // 相対パスの場合は絶対パスに変換
        if (loginFormAction) {
          if (loginFormAction.startsWith('http')) {
            actualLoginUrl = loginFormAction;
          } else if (loginFormAction.startsWith('/')) {
            actualLoginUrl = `https://www1.city.kawachinagano.lg.jp${loginFormAction}`;
          } else {
            actualLoginUrl = `${baseUrl}/${loginFormAction}`;
          }
        }
        console.log(`Using login URL: ${actualLoginUrl}`);
        
        // URLエンコードされたフォームデータを準備
        const loginPayload = new URLSearchParams({
          userno: libraryId,
          passwd: libraryPassword,
          ...formInputs // 隠しフィールドも含める
        }).toString();
        
        console.log(`Login payload keys: ${Object.keys(new URLSearchParams(loginPayload)).join(', ')}`);
        console.log(`Login payload: userno=${libraryId.substring(0, 2)}******&passwd=***&${Object.entries(formInputs).map(([k, v]) => `${k}=${v}`).join('&')}`);
        
        const loginResponse = await axios.post(actualLoginUrl, loginPayload, {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://www1.city.kawachinagano.lg.jp',
            'Referer': userMenuUrl, // 正しいリファラー
            'Cookie': loginPageCookies,
          },
          maxRedirects: 5,
          validateStatus: null,
          timeout: 15000,
        });
        
        console.log(`Login response status: ${loginResponse.status}`);
        
        // レスポンスの一部をログ出力
        if (loginResponse.data) {
          const snippet = loginResponse.data.substring(0, 200);
          console.log(`Login response preview: ${snippet}`);
          
          // ログイン成功かどうかを判定
          if (loginResponse.data.includes('ログアウト') || 
              !loginResponse.data.includes('ログイン') || 
              loginResponse.data.includes('利用照会')) {
            console.log('Login successful based on page content!');
            loginSuccess = true;
          } else {
            console.log('Login page still shows login form');
          }
        }
        
        // レスポンスヘッダーから Cookie を取得
        const cookies = loginResponse.headers['set-cookie'];
        if (!cookies || cookies.length === 0) {
          console.error('Login failed: No Set-Cookie header found in response.');
          
          if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
            console.log(`Retrying login due to missing cookies (attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS})`);
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機
            continue;
          }
          
          throw new Error('図書館へのログインに失敗しました (Cookieが取得できませんでした)');
        }
        
        cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
        console.log('Cookies obtained:', cookieString);

        // 成功したらループを抜ける
        if (loginSuccess) break;
        
        // Cookieはあるがログイン成功の判定ができない場合
        if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
          console.log(`Login status unclear, retrying (attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS})`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機
          continue;
        }

      } catch (error) {
        console.error(`Login attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS} failed:`, error.message);
        
        if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
          console.log(`Retrying login after exception (attempt ${loginAttempts}/${MAX_LOGIN_ATTEMPTS})`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機
          continue;
        }
        
        throw new Error(`図書館へのログインが ${MAX_LOGIN_ATTEMPTS} 回失敗しました: ${error.message}`);
      }
    }
    
    if (!loginSuccess) {
      throw new Error(`図書館へのログインに失敗しました (${MAX_LOGIN_ATTEMPTS}回試行後)`);
    }
    
    // ログイン成功後、ユーザーの操作を模倣して少し待機
    console.log('Login successful, waiting a moment before next step...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒待機

    // 重要: usermenu.doにアクセスして利用者メニューを取得
    console.log('Accessing user menu page after login...');
    const userMenuAfterLoginResponse = await axios.get(userMenuUrl, {
      headers: {
        ...headers,
        'Cookie': cookieString,
        'Referer': actualLoginUrl || loginUrl,
      },
      maxRedirects: 5,
      timeout: 15000,
      validateStatus: null,
    });
    
    console.log(`User menu after login status: ${userMenuAfterLoginResponse.status}`);
    
    // ユーザーメニューのHTMLを解析
    const userMenuAfterLoginHtml = userMenuAfterLoginResponse.data;
    console.log('User menu after login HTML preview:');
    console.log(userMenuAfterLoginHtml.substring(0, 500));
    
    // ログイン成功の確認（ログイン後のページにはユーザー名や特定のメニューが表示されるはず）
    if (userMenuAfterLoginHtml.includes('ログアウト') || 
        userMenuAfterLoginHtml.includes('利用照会') || 
        userMenuAfterLoginHtml.includes('貸出中') ||
        userMenuAfterLoginHtml.includes('予約中')) {
      console.log('Confirmed login success based on user menu content');
    } else {
      console.log('Warning: User menu does not show expected content after login');
    }
    
    // 利用者メニューから「貸出一覧」へのリンクを探す
    const $userMenu = cheerio.load(userMenuAfterLoginHtml);
    
    // ページ内のすべてのリンクを表示してデバッグ
    console.log('All links in user menu page:');
    $userMenu('a').each((i, el) => {
      const linkText = $userMenu(el).text().trim();
      const href = $userMenu(el).attr('href') || '';
      if (linkText && href) {
        console.log(`Link ${i+1}: "${linkText}" -> ${href}`);
      }
    });
    
    let borrowingListUrl = '';
    
    // 「貸出一覧」などのリンクテキストを持つaタグを探す
    $userMenu('a').each((i, el) => {
      const linkText = $userMenu(el).text().trim();
      const href = $userMenu(el).attr('href') || '';
      if (linkText.includes('貸出一覧') || linkText.includes('利用照会') || 
          (href && href.includes('userlist.do'))) {
        borrowingListUrl = href;
        console.log(`Found borrowing list link: ${linkText} -> ${href}`);
        return false; // eachループを抜ける
      }
    });
    
    // 貸出一覧へのリンクが見つからなかった場合はデフォルトURLを使用
    if (!borrowingListUrl) {
      console.log('No borrowing list link found, using default URL');
      borrowingListUrl = 'userlist.do?type=2&page=1';
    }
    
    // 相対URLの場合は絶対URLに変換
    if (!borrowingListUrl.startsWith('http')) {
      if (borrowingListUrl.startsWith('/')) {
        borrowingListUrl = `https://www1.city.kawachinagano.lg.jp${borrowingListUrl}`;
      } else {
        borrowingListUrl = `${baseUrl}/${borrowingListUrl}`;
      }
    }
    
    // ユーザーメニューからの新しいクッキーがあれば更新
    if (userMenuAfterLoginResponse.headers['set-cookie']) {
      cookieString = userMenuAfterLoginResponse.headers['set-cookie']
        .map(cookie => cookie.split(';')[0])
        .join('; ');
      console.log('Updated cookies from user menu after login');
    }
    
    // ブラウザの操作を模倣して少し待機
    await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒待機
    
    // 貸出一覧ページを取得
    console.log(`Fetching borrowing list from: ${borrowingListUrl}`);
    const bookListResponse = await axios.get(borrowingListUrl, {
      headers: {
        ...headers,
        'Cookie': cookieString,
        'Referer': userMenuUrl,
      },
      maxRedirects: 10,
      timeout: 25000,
      validateStatus: null,
    });
    
    console.log(`Book list page status: ${bookListResponse.status}`);
    // タイトルを取得してページ種類を確認
    const bookListHtml = bookListResponse.data;
    const $bookList = cheerio.load(bookListHtml);
    const bookListTitle = $bookList('title').text().trim();
    console.log(`Book list page title: ${bookListTitle}`);
    
    // タイムアウトエラーが発生していないか確認
    if (bookListTitle.includes('タイムアウト')) {
      console.error('Timeout error detected in book list page!');
      // 情報を収集してエラーの原因を調査
      const errorMsg = $bookList('.error-msg, .msg, .message').text().trim() || 
                       "タイムアウトエラーが発生しました。";
      console.error(`Error message: ${errorMsg}`);
      
      // より詳細に分析
      console.log('Analyzing page structure to identify error reason...');
      const bodyContent = $bookList('body').text().trim().substring(0, 500);
      console.log(`Body content: ${bodyContent}`);
      
      throw new Error(`図書館の貸出一覧ページでタイムアウトが発生しました: ${errorMsg}`);
    }
    
    const html = bookListHtml;
        
    // HTMLの一部をログ出力して構造を確認
    console.log('Book list page HTML preview:');
    console.log(html.substring(0, 2000)); // 最初の2000文字を表示
        
    // GASスクリプトで使用されていた正規表現パターンを採用
    console.log('Using regex pattern extraction (like GAS script)...');
    const books = [];
    
    // 元のGASスクリプトと完全に同じ正規表現パターンに変更
    const bookTitleRegex = /<strong>(.+?)<\/strong><\/a><br>/g;
    const dateRegex = /<td class="nwrap">(\d{4}\/\d{2}\/\d{2})<\/td>/g;
    
    const titles = [];
    const dates = [];
    
    let titleMatch;
    while ((titleMatch = bookTitleRegex.exec(html)) !== null) {
      titles.push(titleMatch[1]);
    }
    
    let dateMatch;
    while ((dateMatch = dateRegex.exec(html)) !== null) {
      dates.push(dateMatch[1]);
    }
    
    console.log(`Found ${titles.length} titles and ${dates.length} dates using regex`);
    
    // タイトルと日付の数が一致している場合は、それらをペアにして処理
    if (titles.length > 0 && titles.length === dates.length) {
      for (let i = 0; i < titles.length; i++) {
        const title = titles[i];
        const dateText = dates[i];
        const returnDate = parse(dateText, 'yyyy/MM/dd', new Date());
        books.push({ title, returnDate });
        console.log(`Found book via regex: "${title}" due on ${format(returnDate, 'yyyy/MM/dd')}`);
      }
      console.log('Successfully extracted books using GAS script regex patterns.');
    } else {
      console.log('Regular expression extraction failed or mismatch in counts. Falling back to Cheerio parsing...');
      
      // Cheerioパース処理
      // ここでCheerioを使って書籍情報を抽出
      const $bookList = cheerio.load(html);
      
      // 使用可能なテーブルクラスをすべて表示
      const tableClasses = [];
      $bookList('table').each((i, el) => {
        const cls = $bookList(el).attr('class');
        if (cls) tableClasses.push(cls);
      });
      console.log('Available table classes:', tableClasses);
      
      // すべてのテーブルを調査
      console.log(`Found ${$bookList('table').length} tables on the page`);
      
      // より柔軟なテーブル検出
      // クラス名に「list」を含むテーブルを優先的に調査
      let bookTable = $bookList('table[class*="list"]');
      
      // クラスで見つからなかった場合は、他の方法でテーブルを特定
      if (bookTable.length === 0) {
        console.log('No table with class containing "list" found, trying alternative detection methods...');
        
        // 1. thに「貸出期限」を含むテーブルを探す
        $bookList('th:contains("貸出期限"), th:contains("返却期限")').each((i, el) => {
          const parentTable = $bookList(el).closest('table');
          if (parentTable.length > 0) {
            console.log('Found table with return date header');
            bookTable = parentTable;
            return false; // eachループを抜ける
          }
        });
        
        // 2. まだ見つからない場合は日付っぽい形式(YYYY/MM/DD)を含む行を持つテーブルを探す
        if (bookTable.length === 0) {
          $bookList('td').each((i, el) => {
            const text = $bookList(el).text().trim();
            if (/\d{4}\/\d{2}\/\d{2}/.test(text)) { // YYYY/MM/DD形式を検索
              console.log('Found table with date format text');
              bookTable = $bookList(el).closest('table');
              return false; // eachループを抜ける
            }
          });
        }
        
        // 3. それでも見つからない場合は、大きめのテーブルでtdを持つものを使用
        if (bookTable.length === 0 && $bookList('table').length > 0) {
          $bookList('table').each((i, el) => {
            if ($bookList(el).find('td').length > 5) { // ある程度の列数があるテーブル
              console.log(`Using table #${i+1} with ${$bookList(el).find('td').length} cells as fallback`);
              bookTable = $bookList(el);
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
            const cells = $bookList(row).find('td');
            if (cells.length < 2) return; // 最低でも2つのセルが必要
            
            // テーブルヘッダーを取得して列の順序を確認
            if (rowIndex === 1) { // 最初の行でのみ実行
              const headers = [];
              bookTable.find('th').each((i, th) => {
                headers.push($bookList(th).text().trim());
              });
              console.log('Table headers:', headers);
            }
            
            // タイトルを探す - 強調表示（<strong>）やリンク（<a>）を含むセルを優先
            let titleElement = null;
            let titleCell = null;
            
            // 強調表示されたテキストを探す
            cells.each((i, cell) => {
              const strong = $bookList(cell).find('strong');
              if (strong.length > 0) {
                titleElement = strong;
                titleCell = cell;
                return false; // eachループを抜ける
              }
            });
            
            // 強調表示がなければリンクを探す
            if (!titleElement) {
              cells.each((i, cell) => {
                const link = $bookList(cell).find('a');
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
                const text = $bookList(cell).text().trim();
                if (text.length > maxLength) {
                  maxLength = text.length;
                  titleCell = cell;
                }
              });
              titleElement = $bookList(titleCell);
            }
            
            const title = titleElement ? titleElement.text().trim() : $bookList(titleCell).text().trim();
            
            // 日付を探す - 重要: 正しい返却期限日を取得（4番目のセルが返却期限日）
            let dateText = null;
            let returnDateIdx = -1;
            
            // テーブルヘッダーを確認して返却期限日の列インデックスを特定
            bookTable.find('th').each((i, th) => {
              const headerText = $bookList(th).text().trim();
              if (headerText.includes('返却期限日')) {
                returnDateIdx = i;
                return false; // eachループを抜ける
              }
            });
            
            // 返却期限日のインデックスが見つかった場合、その列から日付を取得
            if (returnDateIdx >= 0 && returnDateIdx < cells.length) {
              const dueDateCell = cells.eq(returnDateIdx);
              const dueDateText = dueDateCell.text().trim();
              if (/\d{4}\/\d{2}\/\d{2}/.test(dueDateText)) {
                dateText = dueDateText.match(/\d{4}\/\d{2}\/\d{2}/)[0];
                console.log(`Found return date in column ${returnDateIdx}: ${dateText}`);
              }
            } else {
              // インデックスが見つからない場合は、日付形式を含む全セルをチェック
              cells.each((i, cell) => {
                const text = $bookList(cell).text().trim();
                if (/\d{4}\/\d{2}\/\d{2}/.test(text)) {
                  // 最初の日付は貸出日、2番目は返却期限日と仮定
                  if (i >= 3) { // 3番目以降のセルに返却期限日があると仮定
                    dateText = text.match(/\d{4}\/\d{2}\/\d{2}/)[0];
                    console.log(`Found return date in cell ${i}: ${dateText}`);
                    return false; // eachループを抜ける
                  }
                }
              });
            }
            
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
    } else if (daysUntilDue <= 1 && daysUntilDue >= 0) {
      // 当日(0日)も含める
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
    message += `【図書館】今日/明日が返却期限の本が ${reminders['1day'].length}冊 あります:\n`;
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


