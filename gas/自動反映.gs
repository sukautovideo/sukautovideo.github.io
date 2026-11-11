/**
 * 自動反映：GitHub の gas/ フォルダの内容を、このGASに自動で反映してデプロイする
 *
 * しくみ：
 *  - 5分おきに GitHub（main ブランチ）の gas/ 内のファイルを読み込む
 *  - 前回反映した内容と違っていれば、このプロジェクトのコードを置き換え
 *    → 新しいバージョンを作成 → 公開中のURLのまま更新
 *
 * 初回だけ：エディタで setupAutoDeploy を選んで「実行」→ 許可
 * 止めたいとき：エディタで stopAutoDeploy を「実行」
 */

const AD_BASE = 'https://raw.githubusercontent.com/sukautovideo/sukautovideo.github.io/main/gas/';
/** 反映するファイル（ファイルを増やしたらここにも追加する） */
const AD_FILES = [
  ['appsscript', 'JSON', 'appsscript.json'],
  ['コード', 'SERVER_JS', 'コード.gs'],
  ['自動反映', 'SERVER_JS', '自動反映.gs'],
  ['index', 'HTML', 'index.html']
];
/** 公開中URL（…/macros/s/<ここ>/exec）のデプロイID。URLを変えずに更新するために使う */
const AD_DEPLOYMENT_ID = 'AKfycbxcl1zOTzivqYcqqz8NORCLHwgH9ZaupsVAmqQ4M43C6HtcpLrcRrHecgSYKXcDPEhu';
const AD_PROPS = PropertiesService.getScriptProperties();

/** 初回設定：5分おきの自動確認をオンにして、すぐ1回確認する */
function setupAutoDeploy() {
  stopAutoDeploy();
  ScriptApp.newTrigger('autoDeploy').timeBased().everyMinutes(5).create();
  autoDeploy();
  Logger.log('自動反映をオンにしました。状態: ' + AD_PROPS.getProperty('AD_STATUS'));
}

/** 自動反映を止める */
function stopAutoDeploy() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'autoDeploy')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** GitHubの内容が変わっていれば反映する（5分おきに自動実行） */
function autoDeploy() {
  try {
    const t = Date.now();
    const files = AD_FILES.map(([name, type, path]) => {
      const res = UrlFetchApp.fetch(AD_BASE + encodeURIComponent(path) + '?t=' + t, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('GitHubから ' + path + ' を読めません（' + res.getResponseCode() + '）');
      return { name: name, type: type, source: res.getContentText('UTF-8') };
    });

    const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(files), Utilities.Charset.UTF_8));
    if (hash === AD_PROPS.getProperty('AD_HASH')) return;

    const id = ScriptApp.getScriptId();
    const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    adScript_('put', id + '/content', { files: files });
    const ver = adScript_('post', id + '/versions', { description: 'GitHubから自動反映 ' + stamp });
    adScript_('put', id + '/deployments/' + AD_DEPLOYMENT_ID, {
      deploymentConfig: {
        versionNumber: ver.versionNumber,
        manifestFileName: 'appsscript',
        description: 'GitHubから自動反映 ' + stamp
      }
    });

    AD_PROPS.setProperties({
      AD_HASH: hash,
      AD_STATUS: JSON.stringify({ ok: true, version: ver.versionNumber, at: stamp })
    });
  } catch (e) {
    AD_PROPS.setProperty('AD_STATUS', JSON.stringify({ ok: false, error: String(e && e.message || e),
      at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') }));
    throw e;
  }
}

/** 反映状態（…/exec?deploy=status で確認できる。秘密の情報は含まない） */
function deployStatus_() {
  return ContentService.createTextOutput(AD_PROPS.getProperty('AD_STATUS') || '{"ok":false,"error":"まだ一度も反映していません"}')
    .setMimeType(ContentService.MimeType.JSON);
}

function adScript_(method, path, body) {
  const res = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + path, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Apps Script API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}
