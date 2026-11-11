/**
 * スカウト動画庫（Google版・パスワード方式）サーバー側
 *
 * しくみ：
 *  - Googleドライブの「スカウト動画」フォルダ = アプリの入れ物（あなたのドライブに保存）
 *  - その中のフォルダ1つ = 選手1人（フォルダ名 = 選手名）
 *  - 「スカウト動画」直下に入れた動画 = 未分類（アプリで選手に振り分け）
 *  - 評価やメモは「scout-data.json」に自動保存
 *  - 見る人はGoogleアカウント不要。リンク＋パスワードで入る
 *      編集用パスワード：動画アップ・評価入力ができる
 *      閲覧用パスワード：見るだけ
 *  - 名前が「_」で始まるフォルダはアプリに表示しない（_削除済み など）
 *
 * デプロイ設定：「次のユーザーとして実行：自分」「アクセスできるユーザー：全員」
 */

const PROPS = PropertiesService.getScriptProperties();
const TRASH_NAME = '_削除済み';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/* ========== 初回設定（オーナーが1回だけ実行） ========== */
function setup() {
  const old = PROPS.getProperty('ROOT_ID');
  if (old) {
    try {
      const f = DriveApp.getFolderById(old);
      Logger.log('設定済みです。フォルダ: ' + f.getUrl());
      return;
    } catch (e) { /* 消されていたら作り直す */ }
  }
  const root = DriveApp.createFolder('スカウト動画');
  const data = root.createFile('scout-data.json', JSON.stringify({ players: {}, videos: {}, shared: {} }), 'application/json');
  root.createFolder(TRASH_NAME);
  PROPS.setProperties({ ROOT_ID: root.getId(), DATA_ID: data.getId() });
  Logger.log('完了しました。フォルダ: ' + root.getUrl());
}

/* ========== 画面 ========== */
function doGet(e) {
  if (e && e.parameter && e.parameter.deploy === 'status') return deployStatus_();
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('スカウト動画庫')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ========== パスワード ========== */
function hash_(pw, salt) {
  return Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + '|' + String(pw), Utilities.Charset.UTF_8));
}

/** パスワードを確認して役割（'edit' or 'view'）を返す */
function auth_(pw, needEdit) {
  const p = PROPS.getProperties();
  if (!p.EDIT_HASH) throw new Error('NEEDS_SETUP');
  const cache = CacheService.getScriptCache();
  const fails = +(cache.get('fails') || 0);
  if (fails >= 20) throw new Error('パスワードの間違いが続いたため、15分間ロックしています。時間をおいてください。');
  const h = hash_(pw, p.SALT);
  const role = h === p.EDIT_HASH ? 'edit' : (h === p.VIEW_HASH ? 'view' : null);
  if (!role) {
    cache.put('fails', String(fails + 1), 900);
    throw new Error('BAD_PASSWORD');
  }
  if (needEdit && role !== 'edit') throw new Error('この操作は編集用パスワードで入ったときだけできます。');
  return role;
}

/** パスワードが設定済みか */
function api_status() {
  return { needsSetup: !PROPS.getProperty('EDIT_HASH') };
}

/** パスワードを設定・変更（変更時は今の編集用パスワードが必要） */
function api_setPasswords(currentEditPw, editPw, viewPw) {
  if (PROPS.getProperty('EDIT_HASH')) auth_(currentEditPw, true);
  editPw = String(editPw || ''); viewPw = String(viewPw || '');
  if (editPw.length < 8 || viewPw.length < 8) throw new Error('パスワードは8文字以上にしてください。');
  if (editPw === viewPw) throw new Error('編集用と閲覧用は別のパスワードにしてください。');
  const salt = Utilities.getUuid();
  PROPS.setProperties({ SALT: salt, EDIT_HASH: hash_(editPw, salt), VIEW_HASH: hash_(viewPw, salt) });
  CacheService.getScriptCache().remove('fails');
  return true;
}

/* ========== 内部ヘルパー ========== */
function rootId_() {
  const id = PROPS.getProperty('ROOT_ID');
  if (!id) throw new Error('初回設定（setup）がまだです。');
  return id;
}

function driveGet_(path, params) {
  const qs = Object.keys(params || {}).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/' + path + (qs ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('ドライブにアクセスできません（' + res.getResponseCode() + '）');
  return JSON.parse(res.getContentText());
}

function driveList_(q, fields) {
  let out = [], token = '';
  do {
    const p = { q: q, fields: 'nextPageToken,files(' + fields + ')', pageSize: 1000 };
    if (token) p.pageToken = token;
    const r = driveGet_('files', p);
    out = out.concat(r.files || []);
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

function readMeta_() {
  try {
    const m = JSON.parse(DriveApp.getFileById(PROPS.getProperty('DATA_ID')).getBlob().getDataAsString());
    m.players = m.players || {}; m.videos = m.videos || {}; m.shared = m.shared || {};
    return m;
  } catch (e) {
    return { players: {}, videos: {}, shared: {} };
  }
}

function writeMeta_(m) {
  DriveApp.getFileById(PROPS.getProperty('DATA_ID')).setContent(JSON.stringify(m));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function trashFolder_() {
  const root = DriveApp.getFolderById(rootId_());
  const it = root.getFoldersByName(TRASH_NAME);
  return it.hasNext() ? it.next() : root.createFolder(TRASH_NAME);
}

/** 動画をGoogleアカウントなしでも再生できるようにする（リンクを知っている人のみ閲覧可） */
function shareVideo_(id) {
  DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
}

function publicMeta_(m) {
  return { players: m.players, videos: m.videos };
}

/* ========== 画面から呼ぶ関数 ========== */

/** 全データ読み込み */
function api_load(pw) {
  const role = auth_(pw, false);
  const root = rootId_();

  const folders = driveList_(
    "'" + root + "' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false",
    'id,name,createdTime'
  ).filter(f => f.name.charAt(0) !== '_');

  const parentIds = [root].concat(folders.map(f => f.id));
  let videos = [];
  for (let i = 0; i < parentIds.length; i += 25) {
    const chunk = parentIds.slice(i, i + 25);
    const q = '(' + chunk.map(id => "'" + id + "' in parents").join(' or ') + ") and mimeType contains 'video/' and trashed=false";
    videos = videos.concat(driveList_(q, 'id,name,parents,createdTime,thumbnailLink,videoMediaMetadata(durationMillis)'));
  }

  // ドライブに直接入れた動画も再生できるように共有設定する
  let meta = readMeta_();
  const unshared = videos.filter(v => !meta.shared[v.id]);
  if (unshared.length) {
    meta = withLock_(() => {
      const m = readMeta_();
      unshared.forEach(v => { try { shareVideo_(v.id); m.shared[v.id] = 1; } catch (e) {} });
      writeMeta_(m);
      return m;
    });
  }

  return {
    role: role,
    canEdit: role === 'edit',
    rootId: root,
    rootUrl: role === 'edit' ? DriveApp.getFolderById(root).getUrl() : '',
    folders: folders,
    videos: videos.map(v => ({
      id: v.id, name: v.name, parents: v.parents, createdTime: v.createdTime,
      thumbnailLink: v.thumbnailLink || '',
      durationMillis: v.videoMediaMetadata ? v.videoMediaMetadata.durationMillis : 0
    })),
    meta: publicMeta_(meta)
  };
}

/** 選手・動画の情報を保存（kind: 'players' | 'videos'） */
function api_saveMeta(pw, kind, id, obj) {
  auth_(pw, true);
  if (kind !== 'players' && kind !== 'videos') throw new Error('bad kind');
  return withLock_(() => {
    const m = readMeta_();
    if (obj) { obj.updatedAt = Date.now(); m[kind][id] = obj; } else delete m[kind][id];
    writeMeta_(m);
    return publicMeta_(m);
  });
}

/** 選手を追加（フォルダを作る） */
function api_createPlayer(pw, name, obj) {
  auth_(pw, true);
  const f = DriveApp.getFolderById(rootId_()).createFolder(String(name).trim());
  if (obj) api_saveMeta(pw, 'players', f.getId(), obj);
  return f.getId();
}

/** 選手名を変更（フォルダ名を変える） */
function api_renamePlayer(pw, id, name) {
  auth_(pw, true);
  DriveApp.getFolderById(id).setName(String(name).trim());
  return true;
}

/** 選手を削除（フォルダごと「_削除済み」へ移動。ドライブからは消えません） */
function api_removePlayer(pw, id) {
  auth_(pw, true);
  DriveApp.getFolderById(id).moveTo(trashFolder_());
  api_saveMeta(pw, 'players', id, null);
  return true;
}

/** 動画を別の選手（または未分類）へ移動 */
function api_moveVideo(pw, fileId, folderId) {
  auth_(pw, true);
  DriveApp.getFileById(fileId).moveTo(DriveApp.getFolderById(folderId || rootId_()));
  return true;
}

/** 動画を削除（「_削除済み」へ移動し、リンク共有も止める） */
function api_removeVideo(pw, fileId) {
  auth_(pw, true);
  const f = DriveApp.getFileById(fileId);
  f.moveTo(trashFolder_());
  try { f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) {}
  api_saveMeta(pw, 'videos', fileId, null);
  return true;
}

/** アップロード枠を作る（この1ファイル専用。ドライブの鍵は画面に渡さない） */
function api_startUpload(pw, info) {
  auth_(pw, true);
  const type = info.type || 'video/quicktime';
  const headers = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    'X-Upload-Content-Type': type,
    'X-Upload-Content-Length': String(info.size)
  };
  if (info.origin) headers.Origin = info.origin;
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: headers,
    payload: JSON.stringify({ name: info.name, parents: [info.folderId || rootId_()], mimeType: type }),
    muteHttpExceptions: true,
    followRedirects: false
  });
  if (res.getResponseCode() >= 300) throw new Error('アップロードを開始できません（' + res.getResponseCode() + '）');
  const h = res.getAllHeaders();
  const loc = h.Location || h.location;
  if (!loc) throw new Error('アップロード先を取得できませんでした');
  return loc;
}

/** アップ完了後：再生できるように共有設定 */
function api_afterUpload(pw, fileId) {
  auth_(pw, true);
  return withLock_(() => {
    shareVideo_(fileId);
    const m = readMeta_(); m.shared[fileId] = 1; writeMeta_(m);
    return true;
  });
}
