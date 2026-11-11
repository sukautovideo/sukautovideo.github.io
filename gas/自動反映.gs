/**
 * 自動反映：GitHub の gas/ フォルダの内容を、このGASに自動で反映してデプロイする
 *
 * しくみ：
 *  - 5分おきに GitHub（main ブランチ）の最新コミットを確認
 *  - 新しいコミットがあれば gas/ 内のファイルを取り込み、
 *    このプロジェクトのコードを置き換え → 新しいバージョンを作成 → 公開中のURLのまま更新
 *
 * 初回だけ：エディタで setupAutoDeploy を選んで「実行」→ 許可
 * 止めたいとき：エディタで stopAutoDeploy を「実行」
 */

const AD_REPO = 'sukautovideo/sukautovideo.github.io';
const AD_BRANCH = 'main';
const AD_DIR = 'gas';
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

/** GitHubに新しいコミットがあれば反映する（5分おきに自動実行） */
function autoDeploy() {
  try {
    const sha = adGithub_('commits/' + AD_BRANCH).sha;
    if (!sha || sha === AD_PROPS.getProperty('AD_SHA')) return;

    const list = adGithub_('contents/' + AD_DIR + '?ref=' + sha);
    const files = list.filter(f => f.type === 'file').map(f => {
      const m = f.name.match(/^(.+)\.(gs|js|html|json)$/);
      if (!m) return null;
      const type = m[2] === 'html' ? 'HTML' : (m[2] === 'json' ? 'JSON' : 'SERVER_JS');
      if (type === 'JSON' && m[1] !== 'appsscript') return null;
      const src = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + AD_REPO + '/' + sha + '/' +
        AD_DIR + '/' + encodeURIComponent(f.name)).getContentText('UTF-8');
      return { name: m[1], type: type, source: src };
    }).filter(Boolean);

    if (!files.some(f => f.name === 'appsscript')) throw new Error('appsscript.json がありません');
    if (!files.some(f => f.name === '自動反映')) throw new Error('自動反映.gs がありません（反映すると自動反映が止まるため中止）');

    // 中身が前回と同じなら（README の変更など）デプロイしない
    const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(files), Utilities.Charset.UTF_8));
    if (hash === AD_PROPS.getProperty('AD_HASH')) {
      AD_PROPS.setProperty('AD_SHA', sha);
      return;
    }

    const id = ScriptApp.getScriptId();
    adScript_('put', id + '/content', { files: files });
    const ver = adScript_('post', id + '/versions', { description: 'GitHub ' + sha.slice(0, 7) });
    adScript_('put', id + '/deployments/' + AD_DEPLOYMENT_ID, {
      deploymentConfig: {
        versionNumber: ver.versionNumber,
        manifestFileName: 'appsscript',
        description: 'GitHub ' + sha.slice(0, 7)
      }
    });

    AD_PROPS.setProperties({
      AD_SHA: sha, AD_HASH: hash,
      AD_STATUS: JSON.stringify({ ok: true, commit: sha.slice(0, 7), version: ver.versionNumber, at: new Date().toISOString() })
    });
  } catch (e) {
    AD_PROPS.setProperty('AD_STATUS', JSON.stringify({ ok: false, error: String(e && e.message || e), at: new Date().toISOString() }));
    throw e;
  }
}

/** 反映状態（…/exec?deploy=status で確認できる。秘密の情報は含まない） */
function deployStatus_() {
  return ContentService.createTextOutput(AD_PROPS.getProperty('AD_STATUS') || '{"ok":false,"error":"まだ一度も反映していません"}')
    .setMimeType(ContentService.MimeType.JSON);
}

function adGithub_(path) {
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + AD_REPO + '/' + path, {
    headers: { Accept: 'application/vnd.github+json' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('GitHub ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
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
