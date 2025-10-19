// ============================
// 管理画面スクリプト admin.js
// ============================

const adminNameEl = document.getElementById('adminName');
const loginBtn = document.getElementById('loginBtn');
const loginMsg = document.getElementById('loginMsg');
const adminPanel = document.getElementById('adminPanel');

const toggleSakeVote = document.getElementById('toggleSakeVote');
const toggleVisualVote = document.getElementById('toggleVisualVote');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const saveMsg = document.getElementById('saveMsg');

const visualRankingEl = document.getElementById('visualRanking');
const refreshRankingBtn = document.getElementById('refreshRankingBtn');

let admins = [];
let settings = {};
let currentAdmin = null;
let saving = false;

// ----------------------------
// 初期ロード：管理者リスト取得
// ----------------------------
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch(`${window.GAS_API_URL}?action=getMembers`);
    if (!res.ok) throw new Error('network');
    const data = await res.json();

    admins = (data.members || []).filter((m) => m.role === 'admin');
    adminNameEl.innerHTML = `
      <option value="" disabled selected>選択してください</option>
      ${admins
        .map((a) => `<option value="${a.name}">${a.name}</option>`)
        .join('')}
    `;
  } catch (e) {
    loginMsg.textContent = '管理者リストの取得に失敗しました。';
  }
});

// ----------------------------
// ログイン処理
// ----------------------------
loginBtn.addEventListener('click', async () => {
  const name = adminNameEl.value;
  if (!name) {
    loginMsg.textContent = '管理者を選択してください。';
    return;
  }
  if (!admins.some((a) => a.name === name)) {
    loginMsg.textContent = '権限がありません。';
    return;
  }

  currentAdmin = name;
  document.getElementById('loginSection').classList.add('hidden');
  adminPanel.classList.remove('hidden');

  await loadSettings();
  await loadVisualRanking();
});

// ----------------------------
// 設定読み込み
// ----------------------------
async function loadSettings() {
  try {
    const res = await fetch(`${window.GAS_API_URL}?action=getSettings`);
    if (!res.ok) throw new Error('network');
    const data = await res.json();
    settings = data.settings || {};
    toggleSakeVote.checked = truthy(
      settings.isVotingOpen ?? settings.allowSakeVote
    );
    toggleVisualVote.checked = truthy(
      settings.isVisualVotingOpen ?? settings.allowVisualVote
    );
    saveMsg.textContent = '';
  } catch (e) {
    saveMsg.textContent = '設定の読み込みに失敗しました。';
  }
}

function truthy(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
}

// ----------------------------
// 設定保存
// ----------------------------
saveSettingsBtn.addEventListener('click', onSaveSettings);

async function onSaveSettings() {
  if (saving) return;
  if (!currentAdmin) {
    saveMsg.textContent = '管理者としてログインしてください。';
    return;
  }
  saving = true;
  saveSettingsBtn.disabled = true;
  saveMsg.textContent = '保存中…';

  try {
    const payload = {
      action: 'updateSettings',
      member: currentAdmin, // ★ 必須：管理者名
      allowSakeVote: !!toggleSakeVote.checked,
      allowVisualVote: !!toggleVisualVote.checked,
    };
    const res = await fetch(window.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    // バックエンドは { status:'success', settings: {...} } を返す実装
    if (data.status === 'success' || data.success === true) {
      settings = data.settings || settings;
      saveMsg.textContent = '設定を保存しました。';
      // 念のため再取得して整合性を合わせる
      await loadSettings();
      await loadVisualRanking();
    } else {
      throw new Error(data.error || '保存エラー');
    }
  } catch (e) {
    saveMsg.textContent = '保存に失敗しました。';
  } finally {
    saving = false;
    saveSettingsBtn.disabled = false;
  }
}

// ----------------------------
// ランキング更新
// ----------------------------
refreshRankingBtn.addEventListener('click', loadVisualRanking);

async function loadVisualRanking() {
  visualRankingEl.innerHTML = '<li>読み込み中...</li>';
  try {
    const res = await fetch(`${window.GAS_API_URL}?action=getVisualRanking`);
    if (!res.ok) throw new Error('network');
    const data = await res.json();
    const list = data.ranking || [];

    visualRankingEl.innerHTML = list
      .map((item, i) => {
        const src = imageSrcSafe(item.img);
        return `
        <li>
          <span class="rank">${i + 1}位</span>
          <img src="${src}" alt="${escapeHtml(item.name)}" class="thumb" />
          <span class="label">${escapeHtml(item.name)}</span>
          <span class="count">(${item.votes}票)</span>
        </li>`;
      })
      .join('');
  } catch (e) {
    visualRankingEl.innerHTML = '<li>ランキングの取得に失敗しました。</li>';
  }
}

// ----------------------------
// 画像SRCのフォールバック
// ----------------------------
function imageSrcSafe(val) {
  if (!val) return '/images/no-image.png';
  if (/^https?:\/\//i.test(val)) return val; // 既に完全URL（Drive直リンク想定）
  return `images/${val}`; // ローカル移行期のフォールバック
}

// ----------------------------
// ちょいユーティリティ
// ----------------------------
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
