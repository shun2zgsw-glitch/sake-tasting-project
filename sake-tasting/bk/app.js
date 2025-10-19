// ============================
// 要素参照
// ============================
const nicknameEl = document.getElementById('nickname'); // 上部プルダウン
const nicknameConfirmEl = document.getElementById('nicknameConfirm'); // 下部（確認）プルダウン
const selectedNameEl = document.getElementById('selectedName'); // 確認テキスト
const listEl = document.getElementById('sake-list'); // 銘柄カード
const sendBtn = document.getElementById('sendBtn'); // 投票ボタン
const clearBtn = document.getElementById('clearBtn'); // 全リセット
const refreshBtn = document.getElementById('refreshBtn'); // ランキング更新
const rankingEl = document.getElementById('ranking'); // ランキング
const metaEl = document.getElementById('meta'); // 更新時刻
const msgEl = document.getElementById('msg'); // メッセージ

// ============================
// 状態
// ============================
let SAKE_DATA = []; // 銘柄マスタ
const currentScores = {}; // { s0: number, s1: number, ... }
let eventsBound = false;
const FETCH_TIMEOUT = 12000;

// 双方向同期のループ抑止フラグ
let syncingNickname = false;

// ============================
// ユーティリティ
// ============================
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function withTimeout(exec, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([
    exec(ctrl.signal),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), ms + 10)
    ),
  ]).finally(() => clearTimeout(timer));
}

function setBusy(el, busy) {
  if (!el) return;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function hasAnyScore() {
  return Object.values(currentScores).some((v) => v > 0);
}

// どちらかに入っている値を採用（送信＆活性判定用）
function getNickname() {
  const a = (nicknameEl?.value || '').trim();
  const b = (nicknameConfirmEl?.value || '').trim();
  return a || b;
}

// 片方を変更しても両方に即反映（唯一の真実の値として統一）
function setNicknameValue(val) {
  syncingNickname = true;
  if (nicknameEl) nicknameEl.value = val || '';
  if (nicknameConfirmEl) nicknameConfirmEl.value = val || '';
  syncingNickname = false;
  updateParticipantPreview();
  updateSendButtonState();
}

// 目視確認テキスト更新
function updateParticipantPreview() {
  const name = getNickname();
  if (selectedNameEl) selectedNameEl.textContent = name || '未選択';
}

// 送信ボタン活性/非活性
function updateSendButtonState() {
  if (!sendBtn) return;
  const nickname = getNickname();
  const hasScore = hasAnyScore();

  const reasons = [];
  if (!nickname) reasons.push('参加者が未選択です');
  if (!hasScore) reasons.push('いずれかの銘柄に★を入れてください');

  const canSend = Boolean(nickname) && hasScore;
  sendBtn.disabled = !canSend;

  if (msgEl) msgEl.textContent = canSend ? '' : reasons.join(' ／ ');
}

function safeOn(el, type, handler) {
  if (!el) return;
  el.addEventListener(type, handler);
}

// 上側→変更
function onNicknameChangeFromTop() {
  if (syncingNickname) return;
  setNicknameValue(nicknameEl?.value || '');
}
// 下側→変更
function onNicknameChangeFromBottom() {
  if (syncingNickname) return;
  setNicknameValue(nicknameConfirmEl?.value || '');
}

// ============================
// データ取得（GAS）
// ============================
async function fetchSakeMaster() {
  return withTimeout(async (signal) => {
    const url = `${window.GAS_API_URL}?type=sakes`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // { ok, items }
    if (!data || data.ok !== true) {
      console.error('sakes API error:', data);
      throw new Error(data?.error || 'failed to load sakes');
    }
    SAKE_DATA = Array.isArray(data.items) ? data.items : [];
    if (!SAKE_DATA.length) throw new Error('sake items empty');
  });
}

async function populateMembers() {
  const selA = nicknameEl;
  const selB = nicknameConfirmEl;
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=members`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // { ok, members }

    // 現在の選択を保持（復元用）
    const prev = getNickname();

    if (selA) {
      selA.innerHTML = '';
      selA.appendChild(new Option('選択してください', '', true, false));
    }
    if (selB) {
      selB.innerHTML = '';
      selB.appendChild(new Option('選択してください', '', true, false));
    }

    if (data && data.ok && Array.isArray(data.members)) {
      data.members.forEach((name) => {
        if (selA) selA.appendChild(new Option(name, name));
        if (selB) selB.appendChild(new Option(name, name));
      });
    } else {
      if (selA)
        selA.appendChild(new Option('メンバー取得に失敗', '', true, false));
      if (selB)
        selB.appendChild(new Option('メンバー取得に失敗', '', true, false));
    }

    // 以前の選択があれば復元して両方に反映、なければ未選択へ統一
    setNicknameValue(prev || '');
  });
}

async function fetchStats() {
  setBusy(rankingEl, true);
  try {
    const data = await withTimeout(async (signal) => {
      const res = await fetch(`${window.GAS_API_URL}?type=stats`, {
        method: 'GET',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json(); // { items, updatedAt }
    });
    renderRanking(data);
  } catch (e) {
    console.error(e);
    if (metaEl)
      metaEl.textContent =
        '集計の取得に失敗しました。時間をおいて再試行してください。';
  } finally {
    setBusy(rankingEl, false);
  }
}

// ============================
// 描画
// ============================
function currentScoresReset() {
  (SAKE_DATA || []).forEach((_, idx) => (currentScores[`s${idx}`] = 0));
  updateAllStarsUI();
  updateSendButtonState();
}

function renderInputs() {
  if (!listEl) return;
  listEl.innerHTML = '';
  setBusy(listEl, true);

  const frag = document.createDocumentFragment();

  (SAKE_DATA || []).forEach((it, idx) => {
    const key = `s${idx}`;

    const wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.innerHTML = `
      <img class="thumb"
           src="${esc(it.img || '')}"
           alt="${esc(it.name || '')}"
           loading="lazy"
           decoding="async">
      <div class="body">
        <h3>${idx + 1}. ${esc(it.name || '')}</h3>

        <div class="meta-row">
          ${it.type ? `<span class="pill">【${esc(it.type)}】</span>` : ''}
          ${
            it.brewery
              ? it.breweryUrl
                ? `<a href="${esc(
                    it.breweryUrl
                  )}" class="pill link" target="_blank" rel="noopener noreferrer">${esc(
                    it.brewery
                  )}</a>`
                : `<span class="pill">${esc(it.brewery)}</span>`
              : ''
          }
          ${
            it.exhibitor
              ? `<span class="pill">出品者：${esc(it.exhibitor)}</span>`
              : ''
          }
        </div>

        <p class="desc clamp" data-desc="${key}">${esc(it.desc || '')}</p>
        <button class="more-btn" type="button" data-more="${key}">続きを読む</button>

        <!-- ⭐ 星の行（上段：星 / 右に目盛り） -->
        <div class="star-row" data-row="${key}">
          <div class="stars" role="radiogroup" aria-label="${esc(
            it.name || ''
          )} の評価（0〜10）"></div>
          <div class="scale-labels" aria-hidden="true">
            <span class="label-min">1</span>
            <span class="label-mid">5</span>
            <span class="label-max">10</span>
          </div>
        </div>

        <!-- クリアは星の下・左寄せ -->
        <div class="clear-wrap">
          <button class="clear-mini" type="button" data-clear="${key}" aria-label="この銘柄の評価をクリア">クリア</button>
        </div>
      </div>
    `;

    // 星10個
    const starsBox = wrap.querySelector('.stars');
    for (let v = 1; v <= 10; v++) {
      const span = document.createElement('span');
      span.className = 'star';
      span.setAttribute('role', 'radio');
      span.setAttribute('tabindex', '0');
      span.dataset.key = key;
      span.dataset.value = String(v);
      span.setAttribute('aria-label', `${v} 点`);
      span.textContent = '★';
      starsBox.appendChild(span);
    }

    frag.appendChild(wrap);
  });

  listEl.appendChild(frag);
  currentScoresReset();
  setBusy(listEl, false);

  if (!eventsBound) {
    // 一括デリゲーション
    listEl.addEventListener('click', onStarsClick);
    listEl.addEventListener('keydown', onStarsKeydown);
    listEl.addEventListener('click', onClearMini);
    listEl.addEventListener('click', onMoreToggle);
    eventsBound = true;
  }
}

function renderRanking({ items = [], updatedAt = '' } = {}) {
  if (!rankingEl) return;
  rankingEl.innerHTML = '';

  if (!items.length) {
    rankingEl.innerHTML = `<li>まだ集計データがありません</li>`;
  } else {
    const top3 = items.filter((it) => Number(it.count) > 0).slice(0, 3);
    if (!top3.length) {
      rankingEl.innerHTML = `<li>まだ投票がありません</li>`;
    } else {
      const frag = document.createDocumentFragment();
      top3.forEach((it, i) => {
        const li = document.createElement('li');
        const medal = ['🥇', '🥈', '🥉'][i] || '';
        li.innerHTML = `
          ${medal} <strong>${esc(it.name)}</strong>
          — 平均 <strong>${Number(it.avg).toFixed(2)}</strong> 点（${
          it.count
        }票）
        `;
        frag.appendChild(li);
      });
      rankingEl.appendChild(frag);
    }
  }

  if (metaEl) {
    metaEl.textContent = updatedAt
      ? `最終更新: ${new Date(updatedAt).toLocaleString()}`
      : '';
  }
}

// ============================
// イベントハンドラ
// ============================
function onMoreToggle(e) {
  const btn = e.target.closest('[data-more]');
  if (!btn) return;
  const key = btn.dataset.more;
  const p = listEl.querySelector(`[data-desc="${key}"]`);
  if (!p) return;

  const isClamped = p.classList.contains('clamp');
  p.classList.toggle('clamp', !isClamped);
  btn.textContent = isClamped ? '閉じる' : '続きを読む';
}

function onClearMini(e) {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  const key = btn.dataset.clear;
  currentScores[key] = 0;
  updateStarsUI(key);
  updateSendButtonState();
  if (msgEl) msgEl.textContent = '入力をリセットしました。';
}

function onStarsClick(e) {
  const star = e.target.closest('.star');
  if (!star) return;
  const key = star.dataset.key;
  const value = Number(star.dataset.value);
  currentScores[key] = currentScores[key] === value ? 0 : value;
  updateStarsUI(key);
  updateSendButtonState();
}

function onStarsKeydown(e) {
  const star = e.target.closest('.star');
  if (!star) return;
  const key = star.dataset.key;
  let v = currentScores[key] || 0;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    v = Math.min(10, v + 1);
    e.preventDefault();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    v = Math.max(0, v - 1);
    e.preventDefault();
  }
  currentScores[key] = v;
  updateStarsUI(key);
  updateSendButtonState();
}

function updateAllStarsUI() {
  (SAKE_DATA || []).forEach((_, idx) => updateStarsUI(`s${idx}`));
}

function updateStarsUI(key) {
  const v = currentScores[key] || 0;
  const row = listEl.querySelector(`[data-row="${key}"]`);
  if (!row) return;
  row.querySelectorAll('.star').forEach((el) => {
    const val = Number(el.dataset.value);
    const checked = val === v && v > 0;
    el.classList.toggle('active', val <= v && v > 0);
    el.setAttribute('aria-checked', String(checked));
  });
}

// ============================
// 送信
// ============================
async function handleSend() {
  // 送信直前にも“真実の値”を確定してUIに反映
  const nickname = getNickname();
  setNicknameValue(nickname);

  if (!nickname) {
    if (msgEl) msgEl.textContent = '参加者を選択してください。';
    (nicknameEl || nicknameConfirmEl)?.focus();
    return;
  }
  if (!hasAnyScore()) {
    if (msgEl) msgEl.textContent = '1つ以上の銘柄に採点してください。';
    return;
  }

  const scores = {};
  for (const [k, v] of Object.entries(currentScores)) {
    if (v > 0) scores[k] = v;
  }
  const payload = { nickname, scores };

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.setAttribute('aria-busy', 'true');
  }
  if (msgEl) msgEl.textContent = '送信中...';

  try {
    const form = new URLSearchParams();
    form.append('payload', JSON.stringify(payload));

    const { ok, status, json, text } = await withTimeout(async (signal) => {
      const res = await fetch(window.GAS_API_URL, {
        method: 'POST',
        body: form,
        signal,
      });
      const raw = await res.text();
      let j;
      try {
        j = JSON.parse(raw);
      } catch {}
      return { ok: res.ok, status: res.status, json: j, text: raw };
    });

    if (ok && json?.ok) {
      if (msgEl) msgEl.textContent = '送信しました。最新の集計を反映します。';
      await fetchStats();
    } else {
      if (msgEl)
        msgEl.textContent = `送信に失敗しました（${status}）：${
          json?.error ?? text ?? ''
        }`;
    }
  } catch (err) {
    console.error(err);
    if (msgEl)
      msgEl.textContent =
        '通信エラーが発生しました。ネットワークをご確認ください。';
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.setAttribute('aria-busy', 'false');
    }
  }
}

// ============================
// 起動
// ============================
function bindTopLevelEvents() {
  // 双方向同期（change と input の両方で反映）
  ['change', 'input'].forEach((evt) => {
    safeOn(nicknameEl, evt, onNicknameChangeFromTop);
    safeOn(nicknameConfirmEl, evt, onNicknameChangeFromBottom);
  });

  safeOn(sendBtn, 'click', handleSend);
  safeOn(clearBtn, 'click', () => {
    currentScoresReset();
    if (msgEl) msgEl.textContent = '全ての評価をリセットしました。';
  });
  safeOn(refreshBtn, 'click', fetchStats);

  // 初回の活性/プレビュー
  updateParticipantPreview();
  updateSendButtonState();
}

async function init() {
  // 先にイベントだけ結ぶ（取得順の影響を受けないよう早期に）
  if (!eventsBound) {
    bindTopLevelEvents();
    eventsBound = true;
  }

  setBusy(listEl, true);
  setBusy(rankingEl, true);

  // ひな形
  renderInputs();

  try {
    await fetchSakeMaster();
    renderInputs();
    if (msgEl) msgEl.textContent = '';
  } catch (e) {
    console.error('[sakes] load failed:', e);
    if (msgEl) msgEl.textContent = '銘柄データの読み込みに失敗しました。';
  }

  try {
    await fetchStats();
  } catch (e) {
    console.error('[stats] load failed:', e);
    if (metaEl)
      metaEl.textContent =
        '集計の取得に失敗しました。時間をおいて再試行してください。';
  }

  try {
    await populateMembers();
  } catch (e) {
    console.error('[members] load failed:', e);
    if (nicknameEl) {
      nicknameEl.innerHTML = '';
      nicknameEl.appendChild(new Option('メンバー取得に失敗', '', true, false));
    }
    if (nicknameConfirmEl) {
      nicknameConfirmEl.innerHTML = '';
      nicknameConfirmEl.appendChild(
        new Option('メンバー取得に失敗', '', true, false)
      );
    }
    setNicknameValue(''); // 未選択に統一
  }

  setBusy(listEl, false);
  setBusy(rankingEl, false);
}

// DOM 準備後に安全起動
function startApp() {
  try {
    init();
  } catch (e) {
    console.error('[init] fatal:', e);
    if (msgEl) msgEl.textContent = '初期化でエラーが発生しました: ' + e.message;
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp, { once: true });
} else {
  startApp();
}
