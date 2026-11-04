// ============================================================
// 每5天稽核：下載有機溶劑／粉塵兩張檢點表記錄存入備份 repo，
// 比對歷史紀錄，挑出「疑似漏填」與「異常」，產出報告並開 Issue 通知。
// 由 GitHub Actions 排程執行（見 .github/workflows/audit-report.yml）。
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BACKUP_REPO = process.env.BACKUP_REPO;         // "owner/repo"（私有備份 repo）
const BACKUP_TOKEN = process.env.BACKUP_REPO_TOKEN;  // 需 Contents 寫入（Issues 寫入為選配）
const START_DATE = process.env.AUDIT_START_DATE || '2026-11-10'; // 第一次執行日（台灣日期）
const INTERVAL_DAYS = Number(process.env.AUDIT_INTERVAL_DAYS || 5);
const FORCE = process.env.FORCE === 'true';           // 手動觸發時可略過日期防護

if (!SUPABASE_URL || !SERVICE_KEY || !BACKUP_REPO || !BACKUP_TOKEN) {
  console.error('缺少必要環境變數：SUPABASE_URL / SUPABASE_SERVICE_KEY / BACKUP_REPO / BACKUP_REPO_TOKEN');
  process.exit(1);
}
const [OWNER, REPO] = BACKUP_REPO.split('/');
const GH = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
const ghHeaders = {
  Authorization: 'Bearer ' + BACKUP_TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json'
};

// ---------- 日期工具（以台灣時間為準）----------
function twToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) { // a - b
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}
function isWeekday(ymd) {
  const w = new Date(ymd + 'T00:00:00Z').getUTCDay();
  return w >= 1 && w <= 5;
}
const compact = ymd => ymd.replace(/-/g, '');

// ---------- Supabase ----------
async function sbAll(path) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, Range: from + '-' + (from + 999) }
    });
    if (!res.ok) throw new Error('Supabase 錯誤 ' + res.status + '：' + (await res.text().catch(() => '')));
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

// ---------- GitHub ----------
async function ghList(dir) {
  const res = await fetch(GH + '/contents/' + dir, { headers: ghHeaders });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('GitHub 列表失敗 ' + res.status);
  return res.json();
}
async function ghGetText(path) {
  const res = await fetch(GH + '/contents/' + encodeURI(path), {
    headers: { ...ghHeaders, Accept: 'application/vnd.github.raw+json' }
  });
  if (!res.ok) throw new Error('GitHub 讀取失敗 ' + path + ' ' + res.status);
  return res.text();
}
async function ghPut(path, text, message) {
  const res = await fetch(GH + '/contents/' + encodeURI(path), {
    method: 'PUT',
    headers: ghHeaders,
    body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64') })
  });
  if (!res.ok) throw new Error('GitHub 寫入失敗 ' + path + ' ' + res.status + ' ' + (await res.text().catch(() => '')));
}

// ---------- CSV ----------
const csvField = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const toCsv = rows => '﻿' + rows.map(r => r.map(csvField).join(',')).join('\n');
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) { if (c === '"' && n === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

async function main() {
  const today = twToday();

  // ----- 日期防護 -----
  const existing = await ghList('backups/audit');
  const reports = existing.map(f => f.name).filter(n => /^audit-report-\d{8}\.md$/.test(n)).sort();
  const lastDate = reports.length ? reports[reports.length - 1].match(/(\d{4})(\d{2})(\d{2})/).slice(1).join('-') : null;
  if (!FORCE) {
    if (today < START_DATE) { console.log('今天 ' + today + ' 早於首次執行日 ' + START_DATE + '，略過。'); return; }
    if (lastDate && diffDays(today, lastDate) < INTERVAL_DAYS) {
      console.log('距上次稽核（' + lastDate + '）未滿 ' + INTERVAL_DAYS + ' 天，略過。'); return;
    }
  }

  const winStart = addDays(today, -(INTERVAL_DAYS - 1));
  const winEnd = today;
  const winDays = []; for (let d = winStart; d <= winEnd; d = addDays(d, 1)) winDays.push(d);
  const inWin = d => d >= winStart && d <= winEnd;

  // ----- 讀取資料 -----
  const [inspectors, units, sInsp, sItems, dInsp, dItems] = await Promise.all([
    sbAll('inspectors?order=employee_code.asc'),
    sbAll('work_units?order=unit_name.asc'),
    sbAll('inspections?order=id.asc'),
    sbAll('inspection_items?order=inspection_id.asc,seq.asc'),
    sbAll('dust_inspections?order=id.asc'),
    sbAll('dust_inspection_items?order=inspection_id.asc,seq.asc')
  ]);
  const group = (items) => { const m = {}; items.forEach(i => (m[i.inspection_id] ||= []).push(i)); return m; };
  const sBy = group(sItems), dBy = group(dItems);

  // ----- 下載存檔（完整 CSV 快照，格式同後台匯出）-----
  const sRows = [['單位', '作業名稱', '日期', '員工代號', '檢點人員', '品項順序', '品項內容', '結果', '異常時採取之措施', '送出時間']];
  sInsp.forEach(r => (sBy[r.id] || [{}]).forEach(d => sRows.push([r.unit_name, r.operation_name, r.inspection_date, r.inspector_employee_code, r.inspector_name,
    d.seq ?? '', d.item_content ?? '', d.result ? (d.result === 'yes' ? '是' : '否') : '', r.abnormal_measures || '', r.submitted_at])));
  const dRows = [['場域', '日期', '員工代號', '檢點人員', '分類', '品項順序', '品項內容', '結果', '異常說明', '送出時間']];
  const dText = x => (x === 'good' ? '是' : x === 'bad' ? '否' : '無此項目');
  dInsp.forEach(r => (dBy[r.id] || [{}]).forEach(d => dRows.push([r.site_name, r.inspection_date, r.inspector_employee_code, r.inspector_name,
    d.category ?? '', d.seq ?? '', d.item_content ?? '', d.result ? dText(d.result) : '', r.abnormal_measures || '', r.submitted_at])));
  const ymd = compact(today);
  await ghPut('backups/audit/audit-solvent-' + ymd + '.csv', toCsv(sRows), '稽核快照：有機溶劑 ' + today);
  await ghPut('backups/audit/audit-dust-' + ymd + '.csv', toCsv(dRows), '稽核快照：粉塵 ' + today);

  // ----- 歷史：資料庫現有 + 備份 repo 內自動匯出的舊 CSV -----
  const hist = { solvent: new Set(sInsp.map(r => r.inspector_employee_code)), dust: new Set(dInsp.map(r => r.inspector_employee_code)) };
  const backups = await ghList('backups');
  for (const f of backups) {
    const kind = /^solvent-backup-/.test(f.name) ? 'solvent' : /^dust-backup-/.test(f.name) ? 'dust' : null;
    if (!kind) continue;
    const rows = parseCsv(await ghGetText('backups/' + f.name));
    const idx = rows[0].indexOf('員工代號');
    if (idx >= 0) rows.slice(1).forEach(r => r[idx] && hist[kind].add(r[idx]));
  }

  // ----- 稽核期間資料 -----
  const sWin = sInsp.filter(r => inWin(r.inspection_date));
  const dWin = dInsp.filter(r => inWin(r.inspection_date));
  const active = inspectors.filter(p => p.is_active);
  const nameOf = c => (inspectors.find(p => p.employee_code === c) || {}).name || '';

  const missing = {}, never = {};
  [['solvent', '有機溶劑', sWin], ['dust', '粉塵', dWin]].forEach(([k, label, win]) => {
    const filled = new Set(win.map(r => r.inspector_employee_code));
    missing[label] = active.filter(p => hist[k].has(p.employee_code) && !filled.has(p.employee_code));
    never[label] = active.filter(p => !hist[k].has(p.employee_code));
  });

  // 異常項目
  const abn = [];
  sWin.forEach(r => (sBy[r.id] || []).filter(d => d.result === 'no').forEach(d => abn.push({
    form: '有機溶劑', unit: r.unit_name + '／' + r.operation_name, date: r.inspection_date, name: r.inspector_name, code: r.inspector_employee_code,
    item: d.item_content, note: r.abnormal_measures || '（未填）' })));
  dWin.forEach(r => (dBy[r.id] || []).filter(d => d.result === 'bad').forEach(d => abn.push({
    form: '粉塵', unit: r.site_name, date: r.inspection_date, name: r.inspector_name, code: r.inspector_employee_code,
    item: d.category + ' ' + d.item_content, note: r.abnormal_measures || '（未填）' })));
  const noNote = abn.filter(a => a.note === '（未填）');

  // 各單位工作日無記錄日期、張數統計
  const unitNames = [...new Set([...units.filter(u => u.is_active).map(u => u.unit_name), ...sWin.map(r => r.unit_name), ...dWin.map(r => r.site_name)])];
  const countBy = (win, key) => { const m = {}; win.forEach(r => m[r[key]] = (m[r[key]] || 0) + 1); return m; };
  const sCnt = countBy(sWin, 'unit_name'), dCnt = countBy(dWin, 'site_name');
  const gaps = unitNames.map(u => {
    const sd = new Set(sWin.filter(r => r.unit_name === u).map(r => r.inspection_date));
    const dd = new Set(dWin.filter(r => r.site_name === u).map(r => r.inspection_date));
    return { u, s: winDays.filter(d => isWeekday(d) && !sd.has(d)), d: winDays.filter(d => isWeekday(d) && !dd.has(d)) };
  });

  // ----- 報告 -----
  const L = [];
  L.push('# 有機溶劑／粉塵檢點表 稽核報告');
  L.push('');
  L.push('- 稽核期間：' + winStart + ' ～ ' + winEnd + '（共 ' + winDays.length + ' 天）');
  L.push('- 產生日期：' + today + '（台灣時間）');
  L.push('- 記錄張數：有機溶劑 ' + sWin.length + ' 張、粉塵 ' + dWin.length + ' 張');
  L.push('');
  L.push('## 摘要');
  L.push('- 異常項目：' + abn.length + ' 筆（其中未填措施／說明 ' + noNote.length + ' 筆）');
  L.push('- 疑似漏填：有機溶劑 ' + missing['有機溶劑'].length + ' 人、粉塵 ' + missing['粉塵'].length + ' 人');
  L.push('');
  L.push('## 一、異常清單');
  if (!abn.length) L.push('本期間無異常項目。');
  else { L.push('| 表單 | 單位／作業 | 日期 | 檢點人員 | 異常項目 | 措施／說明 |'); L.push('|---|---|---|---|---|---|');
    abn.forEach(a => L.push('| ' + a.form + ' | ' + a.unit + ' | ' + a.date + ' | ' + a.name + '（' + a.code + '） | ' + a.item + ' | ' + a.note.replace(/\|/g, '／').replace(/\n/g, ' ') + ' |')); }
  L.push('');
  L.push('## 二、疑似漏填人員（歷史上填過該表，但本期間一筆都沒填）');
  ['有機溶劑', '粉塵'].forEach(label => {
    L.push('**' + label + '**：' + (missing[label].length ? missing[label].map(p => p.name + '（' + p.employee_code + '）').join('、') : '無'));
  });
  L.push('');
  L.push('從未填寫過的啟用人員（不列入漏填，請自行確認是否本來就不需填寫）：');
  ['有機溶劑', '粉塵'].forEach(label => {
    L.push('- ' + label + '：' + (never[label].length ? never[label].map(p => p.name + '（' + p.employee_code + '）').join('、') : '無'));
  });
  L.push('');
  L.push('## 三、各單位工作日（週一至週五）無記錄日期');
  L.push('國定假日無法自動判斷，若為假日請忽略。');
  L.push('| 單位／場域 | 有機溶劑無記錄日 | 粉塵無記錄日 |'); L.push('|---|---|---|');
  gaps.forEach(g => L.push('| ' + g.u + ' | ' + (g.s.join('、') || '—') + ' | ' + (g.d.join('、') || '—') + ' |'));
  L.push('');
  L.push('## 四、各單位填寫張數');
  L.push('| 單位／場域 | 有機溶劑 | 粉塵 |'); L.push('|---|---|---|');
  unitNames.forEach(u => L.push('| ' + u + ' | ' + (sCnt[u] || 0) + ' | ' + (dCnt[u] || 0) + ' |'));
  L.push('');
  const report = L.join('\n');

  await ghPut('backups/audit/audit-report-' + ymd + '.md', report, '稽核報告 ' + today);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

  // ----- 開 Issue 通知（需 Issues 寫入權限；失敗不影響稽核結果）-----
  try {
    const res = await fetch(GH + '/issues', {
      method: 'POST', headers: ghHeaders,
      body: JSON.stringify({
        title: '檢點表稽核 ' + winStart + '～' + winEnd + '：異常 ' + abn.length + ' 筆、疑似漏填 ' + (missing['有機溶劑'].length + missing['粉塵'].length) + ' 人次',
        body: report
      })
    });
    if (!res.ok) console.warn('建立 Issue 失敗（' + res.status + '），報告仍已存入 backups/audit/。');
  } catch (e) { console.warn('建立 Issue 失敗：' + e.message); }
}

main().catch(e => { console.error(e); process.exit(1); });
