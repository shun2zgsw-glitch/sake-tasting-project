// ============================
// 定数・要素参照
// ============================
const nicknameEl = document.getElementById('nickname');
const sakeListEl = document.getElementById('sake-list');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const refreshBtn = document.getElementById('refreshBtn');
const rankingEl = document.getElementById('ranking');
const msgEl = document.getElementById('msg');
const mainEl = document.querySelector('#main');

// 画像や静的資材の基準（index.html が project-root/ 配下にある前提）
const ASSET_BASE_FROM_INDEX = '../';

// ============================
// 状態
// ============================
let members = [];
let sakes = [];
let selectedMember = null;
let settings = {};
let isSubmitting = false; // 二重送信ガード
let adminPanelEl = null; // 管理者UIルート
let visualContainer; // ビジュアル投票エリア
let selectedVisual = null;

// ★ 星クリックイベント多重登録防止
let starsListenerBound = false;

// ============================
// JSONPユーティリティ（GET専用 / CORS回避）
// ============================
function jsonp(url, params = {}) {
  return new Promise((resolve, reject) => {
    const cb = 'cb_' + Math.random().toString(36).slice(2);
    const qs = new URLSearchParams({ ...params, callback: cb });
    const s = document.createElement('script');
    const sep = url.includes('?') ? '&' : '?';
    s.src = url + sep + qs.toString();
    s.onerror = () => {
      delete window[cb];
      s.remove();
      reject(new Error('JSONP load error'));
    };
    window[cb] = (res) => {
      delete window[cb];
      s.remove();
      resolve(res);
    };
    document.body.appendChild(s);
  });
}

// ============================
// 読み取り（GET）共通：typeに依らず“取れたものを返す”
// ============================
async function fetchJson(type) {
  const res = await jsonp(window.GAS_API_URL, { type });

  // 1) 返り値が配列なら（いまの googleusercontent echo の想定）：そのまま返す
  if (Array.isArray(res)) return res;

  // 2) /exec 形式にも対応（将来の切替に備えた互換）
  if (res && res.error) throw new Error(res.error);
  if (res && res[type] !== undefined) return res[type];
  if (type === 'members' && res && res.members) return res.members;
  if (type === 'settings' && res && res.settings) return res.settings;
  if (type === 'stats' && res && res.ranking) return res;
  if (type === 'visual_stats' && res && res.votes) return res;

  // 3) 何も当てはまらなければ丸ごと返す（初期化を止めない）
  return res;
}

// ============================
// 書き込み（POST）：プロキシ経由のみ許可
// ============================
async function postJson(data) {
  if (!window.PROXY_URL) {
    throw new Error(
      '送信できません（PROXY_URL 未設定）。GETは動作しますが、POSTはCORS回避のためプロキシが必要です。'
    );
  }
  const res = await fetch(window.PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // プロキシ側で { gasUrl, payload } を受け取り GAS に転送する想定
    body: JSON.stringify({ gasUrl: window.GAS_API_URL, payload: data }),
  });
  if (!res.ok) throw new Error('送信失敗');
  return res.json();
}

// ============================
// 初期化
// ============================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    msg('データ読み込み中…');

    // —— 最低限「酒」は表示させる。個別に try/catch して途中失敗でも続行
    try {
      sakes = await fetchJson('sakes');
    } catch (e) {
      console.error('sakes取得失敗:', e);
      sakes = [];
    }

    // 先に描画（ここで“出ない”状態を解消）
    try {
      renderSakeList(sakes);
      renderVisualVoting(sakes);
    } catch (e) {
      console.error('初期描画失敗:', e);
    }

    // members（未提供でも続行）
    try {
      members = await fetchJson('members');
      if (!Array.isArray(members)) members = [];
    } catch (e) {
      console.warn('members取得失敗（想定内）:', e);
      members = [];
    }
    renderMemberSelect(members);

    // settings（未提供ならデフォルトON）
    try {
      settings = await fetchJson('settings');
      if (!settings || typeof settings !== 'object') {
        settings = {
          isVotingOpen: true,
          isVisualVotingOpen: true,
          lastUpdated: '',
        };
      }
    } catch (e) {
      console.warn('settings取得失敗（デフォルト適用）:', e);
      settings = {
        isVotingOpen: true,
        isVisualVotingOpen: true,
        lastUpdated: '',
      };
    }

    updateVotingAvailability();
    applyOwnerRestrictions();
    renderAdminPanel();

    // ランキング（未提供でも続行）
    try {
      await renderRanking();
    } catch (e) {
      console.warn('ランキング取得失敗（想定内）:', e);
    }

    // ハンドラ
    nicknameEl.addEventListener('change', onMemberSelect);
    sendBtn.addEventListener('click', onSend);
    clearBtn.addEventListener('click', clearScores);
    refreshBtn.addEventListener('click', renderRanking);
  } catch (err) {
    console.error(err);
    msg('初期化エラー: ' + (err.message || err), true);
  } finally {
    msg('');
  }
}

// ============================
// ユーティリティ
// ============================
function msg(text, isError = false) {
  if (!msgEl) return;
  msgEl.textContent = text;
  msgEl.className = isError ? 'msg error' : 'msg';
}

function isAdminSelected() {
  return !!(selectedMember && selectedMember.role === 'admin');
}

function srcForSake(sake) {
  // Drive優先（httpで始まる）
  if (sake.image_url && /^https?:\/\//i.test(sake.image_url))
    return sake.image_url;
  // ローカル images/ フォルダ fallback（index.html から見て1階層上）
  if (sake.img && !/^https?:\/\//i.test(sake.img))
    return `${ASSET_BASE_FROM_INDEX}images/${sake.img}`;
  // 最終手当
  return `${ASSET_BASE_FROM_INDEX}images/no-image.png`;
}

function truthy(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
}

// ============================
// 参加者選択
// ============================
function renderMemberSelect(members) {
  nicknameEl.innerHTML = `<option value="" hidden>参加者を選択</option>`;
  members.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name + (m.role === 'admin' ? '（管理）' : '');
    nicknameEl.appendChild(opt);
  });
}

function onMemberSelect() {
  const name = nicknameEl.value;
  selectedMember = members.find((m) => m.name === name) || null;
  msg(name ? `${name} さんが選択されました` : '');
  updateVotingAvailability();
  applyOwnerRestrictions();
  renderAdminPanel(); // 管理者切替に追随
}

// ============================
// 投票可否表示
// ============================
function updateVotingAvailability() {
  const isScoreOpen = truthy(settings.isVotingOpen);
  const isVisualOpen = truthy(settings.isVisualVotingOpen);

  // 送信ボタンはどちらか開いていれば押下可能
  sendBtn.disabled = !(isScoreOpen || isVisualOpen);

  // 星の操作可否
  document.querySelectorAll('.sake-card .star').forEach((b) => {
    b.disabled = !isScoreOpen;
  });
  document.querySelectorAll('.sake-card').forEach((c) => {
    c.classList.toggle('disabled', !isScoreOpen);
  });

  // ビジュアルの操作可否
  visualContainer?.classList.toggle('disabled', !isVisualOpen);
}

// ============================
// 酒投票（星UI）
// ============================
function renderSakeList(sakes) {
  sakeListEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  sakes.forEach((sake) => {
    const div = document.createElement('div');
    div.className = 'sake-card';
    div.dataset.sake = sake.name;
    div.innerHTML = `
      <h3>${sake.name}</h3>
      <div class="stars" role="radiogroup" aria-label="${sake.name} の評価">
        ${Array.from({ length: 11 })
          .map(
            (_, i) =>
              `<button type="button" class="star" data-score="${i}" aria-label="${i}点">★</button>`
          )
          .join('')}
      </div>
    `;
    frag.appendChild(div);
  });
  sakeListEl.appendChild(frag);

  // 星クリックイベント（委譲・多重防止）
  if (!starsListenerBound) {
    sakeListEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('star')) return;
      if (e.target.disabled) return;
      const btn = e.target;
      const parent = btn.closest('.stars');
      parent
        .querySelectorAll('.star')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      btn.closest('.sake-card').dataset.score = btn.dataset.score;
    });
    starsListenerBound = true;
  }
}

// ============================
// ビジュアル投票（画像クリック）
// ============================
function renderVisualVoting(sakes) {
  visualContainer = document.createElement('section');
  visualContainer.className = 'card visual-vote';
  visualContainer.innerHTML = `
    <h2>ビジュアル投票（お気に入りのボトルを1つ選択）</h2>
    <div class="bottle-grid"></div>
  `;
  const grid = visualContainer.querySelector('.bottle-grid');

  sakes.forEach((sake) => {
    const card = document.createElement('div');
    card.className = 'bottle-card';
    card.dataset.sake = sake.name;
    card.innerHTML = `
      <img src="${srcForSake(sake)}" alt="${sake.name}" />
      <p>${sake.name}</p>
    `;
    card.addEventListener('click', () => selectVisual(card));
    grid.appendChild(card);
  });

  mainEl.appendChild(visualContainer);
}

function selectVisual(card) {
  if (visualContainer.classList.contains('disabled')) return;
  const sake = card.dataset.sake;

  // 出品者制限
  if (selectedMember && selectedMember.sake === sake) {
    msg('自身の出品酒は選択できません。', true);
    return;
  }

  visualContainer
    .querySelectorAll('.bottle-card')
    .forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  selectedVisual = sake;
  msg(`${sake} に投票候補を選びました`);
}

// ============================
// 出品者制限（酒投票・ビジュアル投票共通）
// ============================
function applyOwnerRestrictions() {
  if (!selectedMember) return;
  const ownSake = selectedMember.sake;

  // 酒投票 → 星ボタンをグレーアウト
  document.querySelectorAll('.sake-card').forEach((card) => {
    const sake = card.dataset.sake;
    const stars = card.querySelectorAll('.star');
    if (sake === ownSake) {
      stars.forEach((b) => (b.disabled = true));
      card.classList.add('disabled');
      // 選択済みならクリア
      delete card.dataset.score;
      card
        .querySelectorAll('.star.active')
        .forEach((b) => b.classList.remove('active'));
    } else {
      // 投票受付に従う
      stars.forEach((b) => (b.disabled = !truthy(settings.isVotingOpen)));
      card.classList.toggle('disabled', !truthy(settings.isVotingOpen));
    }
  });

  // ビジュアル投票 → 自身のボトル非選択化
  visualContainer?.querySelectorAll('.bottle-card').forEach((card) => {
    const sake = card.dataset.sake;
    const isOwn = sake === ownSake;
    card.classList.toggle(
      'disabled',
      isOwn || !truthy(settings.isVisualVotingOpen)
    );
    if (isOwn && selectedVisual === sake) {
      card.classList.remove('selected');
      selectedVisual = null;
    }
  });
}

// ============================
// 投票送信
// ============================
async function onSend() {
  if (!selectedMember) return msg('参加者を選択してください', true);
  if (isSubmitting) return;
  isSubmitting = true;

  try {
    msg('送信中…');

    // 最新設定で判定（管理者が同時に切替える可能性に備え、送信直前で取得）
    try {
      const latest = await fetchJson('settings');
      if (latest && typeof latest === 'object') settings = latest;
    } catch (_) {
      // settings 未提供の場合は現行のまま
    }

    // 酒投票データ（受付中のみ送信）
    if (truthy(settings.isVotingOpen)) {
      const scoreData = Array.from(document.querySelectorAll('.sake-card'))
        .filter((c) => c.dataset.score)
        .map((c) => ({ sake: c.dataset.sake, score: Number(c.dataset.score) }));

      // 自己銘柄はUIで弾いているが、念のため送信側でも弾く
      const own = selectedMember.sake;
      const filtered = scoreData.filter((d) => d.sake !== own);

      for (const d of filtered) {
        await postJson({
          type: 'score',
          member: selectedMember.name,
          sake: d.sake,
          score: d.score,
        });
      }
    }

    // ビジュアル投票（受付中のみ送信）
    if (truthy(settings.isVisualVotingOpen) && selectedVisual) {
      if (selectedMember.sake === selectedVisual) {
        msg('自身の出品酒は選択できません。', true);
      } else {
        await postJson({
          type: 'visual_vote',
          member: selectedMember.name,
          sake: selectedVisual,
        });
      }
    }

    msg('投票を送信しました！');
    await renderRanking(); // 送信後に最新反映
  } catch (err) {
    console.error(err);
    msg('送信失敗: ' + (err.message || err), true);
  } finally {
    isSubmitting = false;
  }
}

// ============================
// ランキング表示（酒投票＋ビジュアル投票）
// ============================
async function renderRanking() {
  try {
    rankingEl.innerHTML = '';
    const [stats, visualStats] = await Promise.allSettled([
      fetchJson('stats'),
      fetchJson('visual_stats'),
    ]);

    const votes =
      (visualStats.status === 'fulfilled' &&
        visualStats.value &&
        visualStats.value.votes) ||
      {};
    const list =
      (stats.status === 'fulfilled' && stats.value && stats.value.ranking) ||
      [];

    const frag = document.createDocumentFragment();
    list.forEach((r, i) => {
      const li = document.createElement('li');
      const visualCount = votes[r.sake] || 0;
      li.innerHTML = `<strong>${i + 1}位：</strong> ${r.sake}
        <span>平均 ${Number(r.avg || 0).toFixed(2)}点</span>
        <span>(${r.count || 0}票)　🍶ビジュアル投票 ${visualCount}票</span>`;
      frag.appendChild(li);
    });
    rankingEl.appendChild(frag);
  } catch (err) {
    console.error(err);
    msg('ランキング取得に失敗しました: ' + (err.message || err), true);
  }
}

// ============================
// 全リセット
// ============================
function clearScores() {
  document
    .querySelectorAll('.star.active')
    .forEach((b) => b.classList.remove('active'));
  document
    .querySelectorAll('.sake-card')
    .forEach((c) => delete c.dataset.score);
  selectedVisual = null;
  visualContainer
    ?.querySelectorAll('.bottle-card')
    .forEach((c) => c.classList.remove('selected'));
  msg('入力内容をリセットしました');
}

// ============================
// 管理者パネル
// ============================
function renderAdminPanel() {
  // 既存を消す
  if (adminPanelEl && adminPanelEl.parentNode)
    adminPanelEl.parentNode.removeChild(adminPanelEl);
  adminPanelEl = null;

  if (!isAdminSelected()) return; // 管理者以外は表示しない

  adminPanelEl = document.createElement('section');
  adminPanelEl.className = 'card admin-panel';
  adminPanelEl.innerHTML = `
    <h2>管理パネル</h2>
    <div class="toggles">
      <label>
        <input type="checkbox" id="toggle-score" ${
          truthy(settings.isVotingOpen) ? 'checked' : ''
        }>
        酒投票（星評価）受付
      </label>
      <label style="margin-left:1.5rem">
        <input type="checkbox" id="toggle-visual" ${
          truthy(settings.isVisualVotingOpen) ? 'checked' : ''
        }>
        ビジュアル投票受付
      </label>
    </div>
    <div class="admin-actions" style="margin-top:0.75rem">
      <button id="admin-apply" class="btn small">反映する</button>
      <button id="admin-refresh" class="btn ghost small">最新データ読込</button>
    </div>
    <p class="muted" style="margin-top:0.5rem">最終更新：${
      settings.lastUpdated || '-'
    }</p>
  `;
  mainEl.insertBefore(adminPanelEl, mainEl.firstChild);

  adminPanelEl
    .querySelector('#admin-apply')
    .addEventListener('click', onAdminApply);
  adminPanelEl
    .querySelector('#admin-refresh')
    .addEventListener('click', refreshAll);
}

async function onAdminApply() {
  try {
    const scoreOn = adminPanelEl.querySelector('#toggle-score').checked;
    const visualOn = adminPanelEl.querySelector('#toggle-visual').checked;

    msg('設定を反映中…');
    await postJson({
      action: 'updateSettings', // ★ バックエンドの管理互換API
      member: selectedMember.name, // 管理者名
      allowSakeVote: scoreOn,
      allowVisualVote: visualOn,
    });

    settings = await fetchJson('settings');
    if (!settings || typeof settings !== 'object') {
      settings = {
        isVotingOpen: scoreOn,
        isVisualVotingOpen: visualOn,
        lastUpdated: '',
      };
    }
    updateVotingAvailability();
    applyOwnerRestrictions();
    renderAdminPanel(); // 表示更新
    await renderRanking(); // ついでに最新化
    msg('設定を反映しました');
  } catch (err) {
    console.error(err);
    msg('設定反映に失敗しました: ' + (err.message || err), true);
  }
}

async function refreshAll() {
  try {
    msg('最新データ読込中…');
    // 取得できるものだけ更新
    try {
      sakes = await fetchJson('sakes');
    } catch (_) {
      /* noop */
    }
    renderSakeList(sakes);

    if (visualContainer && visualContainer.parentNode)
      visualContainer.parentNode.removeChild(visualContainer);
    renderVisualVoting(sakes);

    try {
      const st = await fetchJson('settings');
      if (st && typeof st === 'object') settings = st;
    } catch (_) {
      /* noop */
    }

    updateVotingAvailability();
    applyOwnerRestrictions();
    await renderRanking();
    msg('最新データに更新しました');
  } catch (err) {
    console.error(err);
    msg('更新に失敗しました: ' + (err.message || err), true);
  }
}
