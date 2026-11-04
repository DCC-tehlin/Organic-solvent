// ============================================================
// 自動匯出並清除舊資料
// 由 GitHub Actions 排程執行：分別檢查「有機溶劑作業」與「粉塵作業」
// 兩套檢查記錄的總筆數，超過門檻的那一套會把全部現有記錄匯出成 CSV，
// 寫入私有備份 repo，確認寫入成功後，才刪除已匯出的記錄，
// 避免 Supabase 資料庫無限增長。兩套資料各自獨立判斷、互不影響。
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const THRESHOLD = Number(process.env.EXPORT_THRESHOLD || 100);
const BACKUP_REPO = process.env.BACKUP_REPO;         // 格式："owner/repo"
const BACKUP_TOKEN = process.env.BACKUP_REPO_TOKEN;   // 有 Contents 寫入權限的 PAT

if (!SUPABASE_URL || !SERVICE_KEY || !BACKUP_REPO || !BACKUP_TOKEN) {
  console.error('缺少必要環境變數，請確認 SUPABASE_URL / SUPABASE_SERVICE_KEY / BACKUP_REPO / BACKUP_REPO_TOKEN 皆已設定。');
  process.exit(1);
}

async function sbFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Supabase 錯誤 ' + res.status + '：' + t);
  }
  return { data: await res.json().catch(() => null), headers: res.headers };
}

function csvField(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

async function getTotalCount(table) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?select=id', {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'count=exact',
      Range: '0-0'
    }
  });
  if (!res.ok) throw new Error('查詢筆數失敗 ' + res.status);
  const range = res.headers.get('content-range'); // 例如 "0-0/123"
  return range ? Number(range.split('/')[1] || 0) : 0;
}

async function pushBackupFile(filename, csv, commitMessage) {
  const [owner, repo] = BACKUP_REPO.split('/');
  const putRes = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + filename, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + BACKUP_TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(csv, 'utf8').toString('base64')
    })
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '');
    throw new Error('備份寫入失敗，中止刪除以避免資料遺失：' + putRes.status + ' ' + t);
  }
}

function timestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
}

// ---------------- 有機溶劑作業檢點表 ----------------
async function processSolvent() {
  const total = await getTotalCount('inspections');
  console.log('[有機溶劑] 目前 inspections 總筆數：' + total + '（門檻：' + THRESHOLD + '）');

  if (total <= THRESHOLD) {
    console.log('[有機溶劑] 未超過門檻，本次不執行匯出與清除。');
    return;
  }

  const { data: inspections } = await sbFetch('inspections?order=id.asc');
  if (!inspections || inspections.length === 0) { console.log('[有機溶劑] 查無記錄，結束。'); return; }
  const maxId = Math.max(...inspections.map(r => r.id));

  const { data: items } = await sbFetch('inspection_items?order=inspection_id.asc,seq.asc');
  const itemsByInspection = {};
  (items || []).forEach(it => {
    if (!itemsByInspection[it.inspection_id]) itemsByInspection[it.inspection_id] = [];
    itemsByInspection[it.inspection_id].push(it);
  });

  const rows = [['編號', '單位', '作業名稱', '日期', '員工代號', '檢點人員', '品項順序', '品項內容', '結果', '異常時採取之措施', '送出時間']];
  inspections.forEach(insp => {
    const details = itemsByInspection[insp.id] || [];
    if (details.length === 0) {
      rows.push([insp.id, insp.unit_name, insp.operation_name, insp.inspection_date, insp.inspector_employee_code, insp.inspector_name, '', '', '', insp.abnormal_measures || '', insp.submitted_at]);
    } else {
      details.forEach(d => {
        rows.push([insp.id, insp.unit_name, insp.operation_name, insp.inspection_date, insp.inspector_employee_code, insp.inspector_name, d.seq, d.item_content, d.result === 'yes' ? '是' : '否', insp.abnormal_measures || '', insp.submitted_at]);
      });
    }
  });
  const csv = '﻿' + rows.map(r => r.map(csvField).join(',')).join('\n');
  const filename = 'backups/solvent-backup-' + timestamp() + '-' + inspections.length + 'rows.csv';

  await pushBackupFile(filename, csv, '有機溶劑作業自動備份 ' + inspections.length + ' 筆記錄（id <= ' + maxId + '，' + new Date().toISOString() + '）');
  console.log('[有機溶劑] 已寫入備份檔案：' + BACKUP_REPO + '/' + filename);

  // 只刪除本次已成功匯出的記錄（id <= maxId），避免刪到匯出快照之後才送出的新記錄
  await sbFetch('inspection_items?inspection_id=lte.' + maxId, { method: 'DELETE', prefer: 'return=minimal' });
  await sbFetch('inspections?id=lte.' + maxId, { method: 'DELETE', prefer: 'return=minimal' });
  console.log('[有機溶劑] 已刪除 ' + inspections.length + ' 筆已備份完成的記錄（id <= ' + maxId + '）。');
}

// ---------------- 粉塵作業檢點表 ----------------
async function processDust() {
  const total = await getTotalCount('dust_inspections');
  console.log('[粉塵] 目前 dust_inspections 總筆數：' + total + '（門檻：' + THRESHOLD + '）');

  if (total <= THRESHOLD) {
    console.log('[粉塵] 未超過門檻，本次不執行匯出與清除。');
    return;
  }

  const { data: inspections } = await sbFetch('dust_inspections?order=id.asc');
  if (!inspections || inspections.length === 0) { console.log('[粉塵] 查無記錄，結束。'); return; }
  const maxId = Math.max(...inspections.map(r => r.id));

  const { data: items } = await sbFetch('dust_inspection_items?order=inspection_id.asc,seq.asc');
  const itemsByInspection = {};
  (items || []).forEach(it => {
    if (!itemsByInspection[it.inspection_id]) itemsByInspection[it.inspection_id] = [];
    itemsByInspection[it.inspection_id].push(it);
  });

  const resultText = r => (r === 'good' ? '是' : (r === 'bad' ? '否' : '無此項目'));
  const rows = [['編號', '場域', '日期', '員工代號', '檢點人員', '分類', '品項順序', '品項內容', '結果', '異常說明', '送出時間']];
  inspections.forEach(insp => {
    const details = itemsByInspection[insp.id] || [];
    if (details.length === 0) {
      rows.push([insp.id, insp.site_name, insp.inspection_date, insp.inspector_employee_code, insp.inspector_name, '', '', '', '', insp.abnormal_measures || '', insp.submitted_at]);
    } else {
      details.forEach(d => {
        rows.push([insp.id, insp.site_name, insp.inspection_date, insp.inspector_employee_code, insp.inspector_name, d.category, d.seq, d.item_content, resultText(d.result), insp.abnormal_measures || '', insp.submitted_at]);
      });
    }
  });
  const csv = '﻿' + rows.map(r => r.map(csvField).join(',')).join('\n');
  const filename = 'backups/dust-backup-' + timestamp() + '-' + inspections.length + 'rows.csv';

  await pushBackupFile(filename, csv, '粉塵作業自動備份 ' + inspections.length + ' 筆記錄（id <= ' + maxId + '，' + new Date().toISOString() + '）');
  console.log('[粉塵] 已寫入備份檔案：' + BACKUP_REPO + '/' + filename);

  await sbFetch('dust_inspection_items?inspection_id=lte.' + maxId, { method: 'DELETE', prefer: 'return=minimal' });
  await sbFetch('dust_inspections?id=lte.' + maxId, { method: 'DELETE', prefer: 'return=minimal' });
  console.log('[粉塵] 已刪除 ' + inspections.length + ' 筆已備份完成的記錄（id <= ' + maxId + '）。');
}

async function main() {
  await processSolvent();
  await processDust();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
