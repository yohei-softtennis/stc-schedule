'use strict';
/* 岩瀬STC予定表 — 予定表の共有 + コーチ出欠 + 参加者数 + 日程調整
   Node.js 標準機能のみ。データは JSON ファイルに保存する。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 7860;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ---------- データ ---------- */
function blankDB() {
  return { adminPassHash: null, coaches: [], players: [], events: [], attendance: {}, pattendance: {}, polls: [], sessions: {} };
}
let DB = blankDB();
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    DB = Object.assign(blankDB(), d);
    if (!Array.isArray(DB.coaches)) DB.coaches = [];
    if (!Array.isArray(DB.players)) DB.players = [];
    if (!Array.isArray(DB.events)) DB.events = [];
    if (!Array.isArray(DB.polls)) DB.polls = [];
    if (!DB.attendance || typeof DB.attendance !== 'object') DB.attendance = {};
    if (!DB.pattendance || typeof DB.pattendance !== 'object') DB.pattendance = {};
    if (!DB.sessions || typeof DB.sessions !== 'object') DB.sessions = {};
  } catch (e) { DB = blankDB(); }
}
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 1));
    } catch (e) { console.error('save failed', e); }
  }, 60);
}
loadDB();

/* ---------- ユーティリティ ---------- */
function uid(n) { return crypto.randomBytes(n || 6).toString('hex'); }
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const parts = String(stored).split(':');
  if (parts.length !== 2) return false;
  const h = crypto.scryptSync(String(pw), parts[0], 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts[1])); } catch (e) { return false; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function validTime(s) { return s === '' || s == null || /^\d{2}:\d{2}$/.test(String(s)); }

/* 日本の祝日（その年の分を計算する） */
function holidaysOf(year) {
  const set = new Set();
  const add = (m, d) => set.add(year + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
  const nthMon = (m, n) => { const dt = new Date(Date.UTC(year, m - 1, 1)); let c = 0; while (true) { if (dt.getUTCDay() === 1) { c++; if (c === n) return dt.getUTCDate(); } dt.setUTCDate(dt.getUTCDate() + 1); } };
  add(1, 1); add(1, nthMon(1, 2)); add(2, 11); add(2, 23);
  const sf = Math.floor(20.8431 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4); add(3, sf);
  add(4, 29); add(5, 3); add(5, 4); add(5, 5);
  add(7, nthMon(7, 3)); add(8, 11); add(9, nthMon(9, 3));
  const af = Math.floor(23.2488 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4); add(9, af);
  add(10, nthMon(10, 2)); add(11, 3); add(11, 23);
  /* 振替休日：祝日が日曜なら翌平日 */
  const base = Array.from(set);
  for (const ds of base) {
    const dt = new Date(ds + 'T00:00:00Z');
    if (dt.getUTCDay() === 0) {
      let cur = new Date(dt.getTime() + 86400000);
      while (set.has(cur.toISOString().slice(0, 10)) || cur.getUTCDay() === 0) cur = new Date(cur.getTime() + 86400000);
      set.add(cur.toISOString().slice(0, 10));
    }
  }
  return set;
}
const holidayCache = {};
function isHoliday(ds) {
  const y = Number(ds.slice(0, 4));
  if (!holidayCache[y]) holidayCache[y] = holidaysOf(y);
  return holidayCache[y].has(ds);
}

/* ---------- 認証 ---------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function isAdmin(req) {
  const t = parseCookies(req).stc_admin;
  return !!(t && DB.sessions[t] && DB.sessions[t].admin);
}
function coachByToken(k) {
  if (!k) return null;
  return DB.coaches.find(c => c.token === k) || null;
}
function playerByToken(k) {
  if (!k) return null;
  return DB.players.find(p => p.token === k) || null;
}

/* ---------- 公開用データ整形 ---------- */
function eventPublic(ev) {
  const att = DB.attendance[ev.id] || {};
  const yesNames = [], noNames = [], maybeNames = [];
  let answered = 0;
  for (const c of DB.coaches) {
    const st = att[c.id];
    if (st === 'yes') { yesNames.push(c.name); answered++; }
    else if (st === 'no') { noNames.push(c.name); answered++; }
    else if (st === 'maybe') { maybeNames.push(c.name); answered++; }
  }
  const patt = DB.pattendance[ev.id] || {};
  const pYesNames = [], pNoNames = [], pMaybeNames = [];
  let pAnswered = 0;
  for (const pl of DB.players) {
    const st = patt[pl.id];
    if (st === 'yes') { pYesNames.push(pl.name); pAnswered++; }
    else if (st === 'no') { pNoNames.push(pl.name); pAnswered++; }
    else if (st === 'maybe') { pMaybeNames.push(pl.name); pAnswered++; }
  }
  return {
    id: ev.id, date: ev.date, group: ev.group, title: ev.title,
    start: ev.start || '', end: ev.end || '', place: ev.place || '',
    note: ev.note || '', tentative: !!ev.tentative,
    stage: ev.stage === 'plan' ? 'plan' : 'fixed',
    participants: (ev.participants === null || ev.participants === undefined) ? null : ev.participants,
    yesNames, noNames, maybeNames, answeredCount: answered, coachCount: DB.coaches.length,
    pYesNames, pNoNames, pMaybeNames, pAnsweredCount: pAnswered, playerCount: DB.players.length
  };
}
function eventsInRange(from, to) {
  return DB.events.filter(e => e.date >= from && e.date <= to)
    .sort((a, b) => (a.date + (a.start || '')) < (b.date + (b.start || '')) ? -1 : 1)
    .map(eventPublic);
}
function pollPublic(p, coachId) {
  return {
    id: p.id, title: p.title, note: p.note || '', closed: !!p.closed,
    decidedCandId: p.decidedCandId || null,
    candidates: p.candidates.map(cd => {
      let o = 0, t = 0, x = 0;
      for (const cid of Object.keys(p.responses || {})) {
        const m = (p.responses[cid] || {})[cd.id];
        if (m === 'o') o++; else if (m === 't') t++; else if (m === 'x') x++;
      }
      return { id: cd.id, date: cd.date, start: cd.start || '', end: cd.end || '', label: cd.label || '', o, t, x, mine: coachId ? ((p.responses[coachId] || {})[cd.id] || '') : '' };
    })
  };
}

/* ---------- HTTP 基本 ---------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#f4f6f4;color:#223;font-size:15px}
header{background:#1d6b45;color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
header .ttl{font-weight:700;font-size:17px}
header nav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
header nav a{color:#fff;text-decoration:none;background:rgba(255,255,255,.18);padding:6px 10px;border-radius:999px;font-size:13px}
.wrap{max-width:980px;margin:0 auto;padding:12px}
.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h2{font-size:16px;margin:2px 0 10px}
h3{font-size:14px;margin:12px 0 6px}
button{cursor:pointer;border:0;border-radius:8px;padding:8px 14px;font-size:14px;background:#1d6b45;color:#fff}
button.sub{background:#e6ece8;color:#234}
button.danger{background:#c0392b}
button:disabled{opacity:.45;cursor:default}
input,select,textarea{font-size:15px;padding:8px;border:1px solid #c9d2cb;border-radius:8px;width:100%}
textarea{resize:vertical}
label{font-size:12px;color:#567;display:block;margin:8px 0 3px}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>*{flex:1;min-width:120px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #d5ddd6;padding:6px 7px;vertical-align:top;font-size:13px}
th{background:#eef3ef;font-weight:600;text-align:left}
.sun{color:#c0392b}.sat{color:#2456c8}
.ev{margin-bottom:7px}
.ev:last-child{margin-bottom:0}
.ev .t{font-weight:700}
.badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 7px;margin-right:4px;vertical-align:1px}
.b-stc{background:#dcefe2;color:#14532d}.b-jr{background:#fdeeda;color:#8a5a00}
.b-ques{background:#eee;color:#555}
.mut{color:#778;font-size:12px}
.big{font-size:17px;font-weight:700}
.attbtns{display:flex;gap:6px;margin-top:6px}
.attbtns button{flex:1;background:#e6ece8;color:#234;padding:10px 4px}
.attbtns button.on-yes{background:#1d6b45;color:#fff}
.attbtns button.on-no{background:#c0392b;color:#fff}
.attbtns button.on-maybe{background:#d9a514;color:#fff}
.notice{background:#fff7e0;border:1px solid #e8d48a;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px}
.err{background:#fdecec;border:1px solid #e5a3a3;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px}
a.btnlink{display:inline-block;background:#1d6b45;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:14px}
.scrollx{overflow-x:auto}
.st-yes{color:#1d6b45;font-weight:700}.st-no{color:#c0392b;font-weight:700}.st-maybe{color:#b8860b;font-weight:700}.st-none{color:#c0392b;background:#fdecec}
footer{color:#889;font-size:12px;text-align:center;padding:16px 8px}
`;

/* ---------- ページ：予定表（閲覧） ---------- */
function viewerPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>岩瀬STC予定表</title><style>${CSS}</style></head><body>
<header><div class="ttl">🗓 岩瀬STC予定表</div>
<nav><a href="/">予定表</a><a href="/admin">管理者</a></nav></header>
<div class="wrap">
<div class="card">
<div class="row" style="align-items:center">
<button class="sub" onclick="moveMonth(-1)">◀ 前月</button>
<div class="big" id="mtitle" style="text-align:center"></div>
<button class="sub" onclick="moveMonth(1)">翌月 ▶</button>
</div>
<div class="mut" style="margin-top:6px">この表はコートが確保できた「確定」の予定だけを表示しています。引率は、出欠で「出席」と回答したコーチです。未確定の予定には「？」が付きます。</div>
</div>
<div class="scrollx"><table id="tbl"></table></div>
<div class="mut" style="margin-top:8px">このページは自動で最新の状態に更新されます。</div>
</div>
<footer>岩瀬ジュニア・岩瀬STC 開発アプリ</footer>
<script>
var cur = new Date(); cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
var WD = ['日','月','火','水','木','金','土'];
function fmt(ds){ return ds.slice(0,4)+'-'+ds.slice(5,7); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function moveMonth(d){ cur = new Date(cur.getFullYear(), cur.getMonth()+d, 1); load(); }
function evHtml(e){
  var h = '<div class="ev">';
  h += '<span class="badge '+(e.group==='jr'?'b-jr':'b-stc')+'">'+(e.group==='jr'?'Jr':'STC')+'</span>';
  h += '<span class="t">'+esc(e.title)+(e.tentative?' ？':'')+'</span>';
  if(e.start) h += ' <span>'+esc(e.start)+(e.end?'〜'+esc(e.end):'')+'</span>';
  if(e.place) h += '<div>📍 '+esc(e.place)+'</div>';
  if(e.yesNames.length) h += '<div>引率：'+e.yesNames.map(esc).join('・')+'</div>';
  else h += '<div class="mut">引率：未定</div>';
  if(e.pYesNames && e.pYesNames.length) h += '<div>参加予定：'+e.pYesNames.length+'人</div>';
  if(e.participants!=null) h += '<div>参加者数：'+e.participants+'人</div>';
  if(e.note) h += '<div class="mut">'+esc(e.note)+'</div>';
  return h+'</div>';
}
function load(){
  var ym = cur.getFullYear() + '-' + String(cur.getMonth()+1).padStart(2, '0');
  document.getElementById('mtitle').textContent = cur.getFullYear()+'年'+(cur.getMonth()+1)+'月';
  fetch('/api/state?month='+ym).then(function(r){ return r.json(); }).then(function(d){
    var byDay = {};
    d.events.forEach(function(e){ (byDay[e.date]=byDay[e.date]||[]).push(e); });
    var y = cur.getFullYear(), m = cur.getMonth();
    var last = new Date(y, m+1, 0).getDate();
    var h = '<tr><th style="width:44px">曜日</th><th style="width:36px">日</th><th>予定</th></tr>';
    for(var day=1; day<=last; day++){
      var dt = new Date(y, m, day);
      var ds = y+'-'+String(m+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
      var cls = dt.getDay()===0?'sun':(dt.getDay()===6?'sat':'');
      var evs = byDay[ds]||[];
      h += '<tr><td class="'+cls+'">'+WD[dt.getDay()]+(d.holidays.indexOf(ds)>=0?' 🎌':'')+'</td><td class="'+cls+'">'+day+'</td><td>';
      if(!evs.length) h += '<span class="mut">—</span>';
      evs.forEach(function(e){ h += evHtml(e); });
      h += '</td></tr>';
    }
    document.getElementById('tbl').innerHTML = h;
  });
}
load();
setInterval(load, 60000);
</script></body></html>`;
}

/* ---------- ページ：コーチ専用 ---------- */
function coachPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>コーチ出欠ページ｜岩瀬STC</title><style>${CSS}</style></head><body>
<header><div class="ttl">🎾 コーチ出欠ページ</div>
<nav><a href="/">予定表</a></nav></header>
<div class="wrap">
<div id="who"></div>
<div id="list"></div>
<div id="polls"></div>
</div>
<footer>岩瀬ジュニア・岩瀬STC 開発アプリ</footer>
<script>
var K = new URLSearchParams(location.search).get('k') || '';
var WD = ['日','月','火','水','木','金','土'];
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function dl(ds){ var d=new Date(ds+'T00:00:00'); return (d.getMonth()+1)+'/'+d.getDate()+'（'+WD[d.getDay()]+'）'; }
function load(){
  fetch('/api/coach?k='+encodeURIComponent(K)).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ document.getElementById('who').innerHTML = '<div class="err">'+esc(d.error)+'</div>'; return; }
    document.getElementById('who').innerHTML = '<div class="notice"><b>'+esc(d.coach.name)+'</b> コーチのページです。予定ごとに出席・欠席・未定を押してください。過去の予定は参加実績として入力できます。回答はそのまま予定表の引率と出欠一覧に反映されます。</div>';
    function evCard(e){
      var h = '<div class="card"><div><span class="badge '+(e.group==='jr'?'b-jr':'b-stc')+'">'+(e.group==='jr'?'Jr':'STC')+'</span>';
      if(e.stage==='plan') h += '<span class="badge b-ques">計画（コート予約前）</span>';
      h += '<b>'+dl(e.date)+'</b> <span class="t" style="font-weight:700">'+esc(e.title)+(e.tentative?' ？':'')+'</span></div>';
      if(e.start) h += '<div>🕐 '+esc(e.start)+(e.end?'〜'+esc(e.end):'')+'</div>';
      if(e.place) h += '<div>📍 '+esc(e.place)+'</div>';
      if(e.note) h += '<div class="mut">'+esc(e.note)+'</div>';
      h += '<div class="mut">いまの引率：'+(e.yesNames.length?e.yesNames.map(esc).join('・'):'未定')+'／回答 '+e.answeredCount+'/'+e.coachCount+'人</div>';
      h += '<div class="attbtns">'
        + '<button class="'+(e.mine==='yes'?'on-yes':'')+'" onclick="attend(\\''+e.id+'\\',\\'yes\\')">出席</button>'
        + '<button class="'+(e.mine==='maybe'?'on-maybe':'')+'" onclick="attend(\\''+e.id+'\\',\\'maybe\\')">未定</button>'
        + '<button class="'+(e.mine==='no'?'on-no':'')+'" onclick="attend(\\''+e.id+'\\',\\'no\\')">欠席</button></div>';
      h += '<div class="row" style="margin-top:8px;align-items:end"><div><label>参加者数（ジュニア）</label><input type="number" min="0" id="pc-'+e.id+'" value="'+(e.participants==null?'':e.participants)+'" placeholder="未入力"></div>'
        + '<div style="flex:0"><button class="sub" onclick="savePc(\\''+e.id+'\\')">人数を保存</button></div></div>';
      return h + '</div>';
    }
    var up = d.events.filter(function(e){ return e.date >= d.today; });
    var past = d.events.filter(function(e){ return e.date < d.today; }).reverse();
    var h = '<h2 style="margin:4px 0 8px">今後の予定</h2>';
    if(!up.length) h += '<div class="card">今後の予定はまだ登録されていません。</div>';
    up.forEach(function(e){ h += evCard(e); });
    if(past.length){
      h += '<h2 style="margin:16px 0 8px">過去の予定（参加実績の入力）</h2>';
      h += '<div class="mut" style="margin-bottom:8px">終わった予定も、実際に参加したかどうかを入力できます。参加実績の確認に使われます。</div>';
      past.forEach(function(e){ h += evCard(e); });
    }
    document.getElementById('list').innerHTML = h;
    var ph = '';
    d.polls.forEach(function(p){
      ph += '<div class="card"><h2>📅 日程調整：'+esc(p.title)+'</h2>';
      if(p.note) ph += '<div class="mut">'+esc(p.note)+'</div>';
      if(p.closed) ph += '<div class="mut">この調整は締め切られました。</div>';
      p.candidates.forEach(function(cd){
        ph += '<div style="margin-top:8px"><b>'+dl(cd.date)+'</b> '+(cd.start?esc(cd.start)+(cd.end?'〜'+esc(cd.end):''):'')+' '+esc(cd.label)
          + ' <span class="mut">（○'+cd.o+' △'+cd.t+' ×'+cd.x+'）</span>'
          + '<div class="attbtns">'
          + '<button class="'+(cd.mine==='o'?'on-yes':'')+'" onclick="pollAns(\\''+p.id+'\\',\\''+cd.id+'\\',\\'o\\')">○ 行ける</button>'
          + '<button class="'+(cd.mine==='t'?'on-maybe':'')+'" onclick="pollAns(\\''+p.id+'\\',\\''+cd.id+'\\',\\'t\\')">△ 微妙</button>'
          + '<button class="'+(cd.mine==='x'?'on-no':'')+'" onclick="pollAns(\\''+p.id+'\\',\\''+cd.id+'\\',\\'x\\')">× 行けない</button></div></div>';
      });
      ph += '</div>';
    });
    document.getElementById('polls').innerHTML = ph;
  });
}
function post(url, body){ return fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(function(r){ return r.json(); }); }
function attend(id, st){ post('/api/coach/attend', {k:K, eventId:id, status:st}).then(load); }
function savePc(id){ var v = document.getElementById('pc-'+id).value; post('/api/coach/participants', {k:K, eventId:id, count: v===''?null:Number(v)}).then(load); }
function pollAns(pid, cid, m){ post('/api/coach/poll', {k:K, pollId:pid, candId:cid, mark:m}).then(load); }
load();
</script></body></html>`;
}

/* ---------- ページ：計画のみ（コート予約当番用） ---------- */
function planPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>練習計画（コート予約用）｜岩瀬STC</title><style>${CSS}
@media print { header, footer, .noprint { display:none !important; } body { background:#fff; } .wrap { max-width:none; } }
</style></head><body>
<header><div class="ttl">📝 練習計画（計画のみ）</div>
<nav><a href="/">予定表（確定）</a></nav></header>
<div class="wrap">
<div class="nav noprint"><button class="sub" onclick="move(-1)">◀ 前の月</button><span class="mtitle" id="mtitle"></span><button class="sub" onclick="move(1)">次の月 ▶</button><button class="sub" onclick="window.print()">🖨 印刷する</button></div>
<div class="mut" style="margin-bottom:8px">コーチが決めた練習計画（まだコート未確保の分）だけを月ごとに表示しています。コートの予約にご利用ください。予約が取れた日は、管理者が「確定」に切り替えると予定表に載ります。</div>
<div class="tblwrap"><table id="tbl"></table></div>
</div>
<footer>岩瀬ジュニア・岩瀬STC 開発アプリ</footer>
<script>
var cur = new Date(); cur.setDate(1); cur.setMonth(cur.getMonth() + 1);
var WD = ['日','月','火','水','木','金','土'];
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function move(n){ cur.setMonth(cur.getMonth() + n); load(); }
function load(){
  var ym = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
  document.getElementById('mtitle').textContent = cur.getFullYear() + '年' + (cur.getMonth() + 1) + '月';
  fetch('/api/plan?month=' + ym).then(function(r){ return r.json(); }).then(function(d){
    var HOL = {}; (d.holidays || []).forEach(function(ds){ HOL[ds] = 1; });
    var byDate = {};
    d.events.forEach(function(e){ (byDate[e.date] = byDate[e.date] || []).push(e); });
    var y = cur.getFullYear(), m = cur.getMonth();
    var last = new Date(y, m + 1, 0).getDate();
    var h = '<tr><th style="width:92px">日付</th><th>計画</th></tr>';
    for(var day = 1; day <= last; day++){
      var ds = ym + '-' + String(day).padStart(2, '0');
      var dt = new Date(y, m, day);
      var cls = (dt.getDay() === 0 || HOL[ds]) ? 'sun' : '';
      var evs = byDate[ds] || [];
      var cell = '';
      if(!evs.length) cell = '<span class="mut">—</span>';
      evs.forEach(function(e){
        cell += '<div class="ev"><span class="badge ' + (e.group === 'jr' ? 'b-jr' : 'b-stc') + '">' + (e.group === 'jr' ? 'Jr' : 'STC') + '</span><span class="badge b-ques">計画</span> <b>' + esc(e.title) + (e.tentative ? ' ？' : '') + '</b>'
          + (e.start ? ' ' + esc(e.start) + (e.end ? '〜' + esc(e.end) : '') : '')
          + (e.place ? ' 📍' + esc(e.place) : '')
          + (e.note ? '<div class="mut">' + esc(e.note) + '</div>' : '') + '</div>';
      });
      h += '<tr><td class="dayc ' + cls + '">' + day + '<span class="wd">（' + WD[dt.getDay()] + '）</span></td><td>' + cell + '</td></tr>';
    }
    document.getElementById('tbl').innerHTML = h;
  });
}
load();
</script></body></html>`;
}

/* ---------- ページ：選手・保護者専用（参加登録） ---------- */
function playerPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>参加登録ページ｜岩瀬STC</title><style>${CSS}</style></head><body>
<header><div class="ttl">🎾 参加登録ページ</div>
<nav><a href="/">予定表</a></nav></header>
<div class="wrap">
<div id="who"></div>
<div id="list"></div>
</div>
<footer>岩瀬ジュニア・岩瀬STC 開発アプリ</footer>
<script>
var K = new URLSearchParams(location.search).get('k') || '';
var WD = ['日','月','火','水','木','金','土'];
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function dl(ds){ var d=new Date(ds+'T00:00:00'); return (d.getMonth()+1)+'/'+d.getDate()+'（'+WD[d.getDay()]+'）'; }
function load(){
  fetch('/api/player?k='+encodeURIComponent(K)).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ document.getElementById('who').innerHTML = '<div class="err">'+esc(d.error)+'</div>'; return; }
    document.getElementById('who').innerHTML = '<div class="notice"><b>'+esc(d.player.name)+'</b> さんの参加登録ページです。練習・イベントごとに、参加する／参加しない／未定を押してください。終わった予定は、実際に参加したかどうかを入力してください。</div>';
    function evCard(e){
      var h = '<div class="card"><div><span class="badge '+(e.group==='jr'?'b-jr':'b-stc')+'">'+(e.group==='jr'?'Jr':'STC')+'</span>';
      h += '<b>'+dl(e.date)+'</b> <span style="font-weight:700">'+esc(e.title)+(e.tentative?' ？':'')+'</span></div>';
      if(e.start) h += '<div>🕐 '+esc(e.start)+(e.end?'〜'+esc(e.end):'')+'</div>';
      if(e.place) h += '<div>📍 '+esc(e.place)+'</div>';
      if(e.note) h += '<div class="mut">'+esc(e.note)+'</div>';
      h += '<div class="mut">参加予定：'+e.pYesNames.length+'人（回答 '+e.pAnsweredCount+'/'+e.playerCount+'人）</div>';
      h += '<div class="attbtns">'
        + '<button class="'+(e.mine==='yes'?'on-yes':'')+'" onclick="attend(\\''+e.id+'\\',\\'yes\\')">参加する</button>'
        + '<button class="'+(e.mine==='maybe'?'on-maybe':'')+'" onclick="attend(\\''+e.id+'\\',\\'maybe\\')">未定</button>'
        + '<button class="'+(e.mine==='no'?'on-no':'')+'" onclick="attend(\\''+e.id+'\\',\\'no\\')">参加しない</button></div>';
      return h + '</div>';
    }
    var up = d.events.filter(function(e){ return e.date >= d.today; });
    var past = d.events.filter(function(e){ return e.date < d.today; }).reverse();
    var h = '<h2 style="margin:4px 0 8px">今後の予定</h2>';
    if(!up.length) h += '<div class="card">今後の予定はまだ登録されていません。</div>';
    up.forEach(function(e){ h += evCard(e); });
    if(past.length){
      h += '<h2 style="margin:16px 0 8px">過去の予定（参加実績の入力）</h2>';
      past.forEach(function(e){ h += evCard(e); });
    }
    document.getElementById('list').innerHTML = h;
  });
}
function post(url, body){ return fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(function(r){ return r.json(); }); }
function attend(id, st){ post('/api/player/attend', {k:K, eventId:id, status:st}).then(load); }
load();
</script></body></html>`;
}

/* ---------- ページ：管理者 ---------- */
function adminPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理者｜岩瀬STC予定表</title><style>${CSS}</style></head><body>
<header><div class="ttl">🛠 管理者ページ</div>
<nav><a href="/">予定表</a></nav></header>
<div class="wrap">
<div id="auth"></div>
<div id="main" style="display:none">
<div class="card"><h2>📅 予定の追加・編集</h2>
<input type="hidden" id="ev-id">
<div class="row">
<div><label>日付</label><input type="date" id="ev-date"></div>
<div><label>区分</label><select id="ev-group"><option value="stc">STC</option><option value="jr">岩瀬Jr</option></select></div>
</div>
<label>内容</label><input id="ev-title" placeholder="例：練習、○○大会">
<div class="row">
<div><label>開始</label><input type="time" id="ev-start"></div>
<div><label>終了</label><input type="time" id="ev-end"></div>
<div><label>場所</label><input id="ev-place" placeholder="例：ラスカ12"></div>
</div>
<div class="row">
<div><label>参加者数（ジュニア・手入力）</label><input type="number" min="0" id="ev-pc" placeholder="未入力"></div>
<div><label>未確定</label><select id="ev-tent"><option value="">確定</option><option value="1">未確定（？を付ける）</option></select></div>
<div><label>段階</label><select id="ev-stage"><option value="fixed">確定（コート確保済み・予定表に公開）</option><option value="plan">計画（コーチ決定・まだ予約前）</option></select></div>
</div>
<div class="mut">「計画」の予定は予定表（公開ページ）には出ません。20日の予約でコートが取れたら「確定」に切り替えると、コーチ・保護者に共有されます。定例の一括登録は「計画」で入ります。</div>
<div class="mut" style="margin-top:6px">📝 計画だけのページ（コート予約当番の保護者用）：<span id="planurl" style="word-break:break-all"></span> <button class="sub" onclick="copyPlanLink()">リンクをコピー</button><br>このリンクを当番の保護者に送ると、その月の計画だけが見られます（印刷もできます）。</div>
<label>備考</label><input id="ev-note">
<div class="row" style="margin-top:10px">
<button onclick="saveEvent()">保存する</button>
<button class="sub" onclick="clearEventForm()">入力をクリア</button>
</div>
<h3>定例予定の一括登録</h3>
<div class="row">
<div><label>対象の月</label><input type="month" id="bulk-month"></div>
<div><label>曜日</label><select id="bulk-wd"><option value="1">月</option><option value="2">火</option><option value="3">水</option><option value="4">木</option><option value="5">金</option><option value="6">土</option><option value="0">日</option></select></div>
<div><label>区分</label><select id="bulk-group"><option value="stc">STC</option><option value="jr">岩瀬Jr</option></select></div>
</div>
<div class="row">
<div><label>内容</label><input id="bulk-title" placeholder="例：練習"></div>
<div><label>開始</label><input type="time" id="bulk-start"></div>
<div><label>終了</label><input type="time" id="bulk-end"></div>
<div><label>場所</label><input id="bulk-place"></div>
</div>
<div style="margin-top:8px"><button class="sub" onclick="bulkAdd()">その月の毎週分をまとめて登録</button></div>
<h3>この前後の予定</h3>
<div id="evlist"></div>
</div>

<div class="card"><h2>🎾 コーチ管理と出欠確認</h2>
<div class="row">
<div><label>コーチ名を追加</label><input id="coach-name" placeholder="例：山田"></div>
<div style="flex:0;align-self:end"><button onclick="addCoach()">追加</button></div>
</div>
<div id="coachlist" style="margin-top:10px"></div>
<h3>出欠確認表（今後の予定 × コーチ）</h3>
<div class="scrollx"><table id="atttbl"></table></div>
<div class="mut">空欄（赤）は未回答です。コーチ本人が自分のページで回答すると、ここに自動で入ります。</div>
</div>

<div class="card"><h2>🧒 選手（保護者）管理と参加登録</h2>
<div class="mut">選手を登録すると、その子専用の参加登録ページのリンクが発行されます。保護者にリンクを送ると、練習・イベントごとに「参加する／参加しない」を登録でき、参加予定者と人数が自動で集計されます（予定の編集欄と予定表に表示）。</div>
<div class="row">
<div><label>選手名を追加</label><input id="player-name" placeholder="例：山田太郎"></div>
<div style="flex:0;align-self:end"><button onclick="addPlayer()">追加</button></div>
</div>
<div id="playerlist" style="margin-top:10px"></div>
</div>

<div class="card"><h2>📅 日程調整（伝助の代わり）</h2>
<input type="hidden" id="poll-id">
<label>調整のタイトル</label><input id="poll-title" placeholder="例：1月の合同練習の日程調整">
<label>メモ</label><input id="poll-note" placeholder="例：ラスカが空いている日だけ入れています">
<label>候補日（1行に1つ：日付 開始 終了 メモ）</label>
<textarea id="poll-cands" rows="4" placeholder="2027-01-09 09:00 12:00 ラスカ&#10;2027-01-10 09:00 12:00 ラスカ"></textarea>
<div class="row" style="margin-top:10px">
<button onclick="savePoll()">調整を作成</button>
<button class="sub" onclick="clearPollForm()">入力をクリア</button>
</div>
<div id="polllist" style="margin-top:10px"></div>
</div>
</div>
</div>
<footer>岩瀬ジュニア・岩瀬STC 開発アプリ</footer>
<script>
var WD = ['日','月','火','水','木','金','土'];
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function dl(ds){ var d=new Date(ds+'T00:00:00'); return (d.getMonth()+1)+'/'+d.getDate()+'（'+WD[d.getDay()]+'）'; }
function post(url, body){ return fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}).then(function(r){ return r.json(); }); }
function authView(){
  fetch('/api/auth/status').then(function(r){ return r.json(); }).then(function(d){
    var h = '';
    if(d.authed){ document.getElementById('auth').innerHTML=''; document.getElementById('main').style.display=''; loadAll(); return; }
    if(!d.hasPassword){
      h = '<div class="card"><h2>管理者パスワードの初回設定</h2><div class="mut">最初にパスワードを決めてください。コーチの登録や予定の編集に使います。</div><label>パスワード（4文字以上）</label><input type="password" id="pw1"><div style="margin-top:10px"><button onclick="setupPw()">設定する</button></div></div>';
    } else {
      h = '<div class="card"><h2>管理者ログイン</h2><label>パスワード</label><input type="password" id="pw1"><div style="margin-top:10px"><button onclick="loginPw()">ログイン</button></div></div>';
    }
    document.getElementById('auth').innerHTML = h;
  });
}
function setupPw(){ post('/api/auth/setup', {password: document.getElementById('pw1').value}).then(function(d){ if(d.error) alert(d.error); else authView(); }); }
function loginPw(){ post('/api/auth/login', {password: document.getElementById('pw1').value}).then(function(d){ if(d.error) alert(d.error); else authView(); }); }

var STATE = null;
function loadAll(){
  fetch('/api/admin/state').then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ authView(); return; }
    STATE = d;
    renderEvents(); renderCoaches(); renderAtt(); renderPlayers(); renderPolls();
  });
}
function renderEvents(){
  var h = '<table><tr><th>日付</th><th>予定</th><th></th></tr>';
  STATE.events.forEach(function(e){
    h += '<tr><td style="white-space:nowrap">'+dl(e.date)+'</td><td><span class="badge '+(e.group==='jr'?'b-jr':'b-stc')+'">'+(e.group==='jr'?'Jr':'STC')+'</span>'
      + (e.stage==='plan'?'<span class="badge b-ques">計画</span>':'<span class="badge b-stc">確定</span>')
      + '<b>'+esc(e.title)+(e.tentative?' ？':'')+'</b>'
      + (e.start?' '+esc(e.start)+(e.end?'〜'+esc(e.end):''):'') + (e.place?' 📍'+esc(e.place):'')
      + '<div class="mut">引率：'+(e.yesNames.length?e.yesNames.map(esc).join('・'):'未定')+'／手入力人数：'+(e.participants==null?'—':e.participants)+'</div>'
      + '<div class="mut">参加予定：'+e.pYesNames.length+'人'+(e.pYesNames.length?'（'+e.pYesNames.map(esc).join('・')+'）':'')+'／回答 '+e.pAnsweredCount+'/'+e.playerCount+'人</div></td>'
      + '<td style="white-space:nowrap"><button class="sub" onclick="toggleStage(\\''+e.id+'\\',\\''+(e.stage==='plan'?'fixed':'plan')+'\\')">'+(e.stage==='plan'?'確定にする':'計画に戻す')+'</button> <button class="sub" onclick="editEvent(\\''+e.id+'\\')">編集</button> <button class="danger" onclick="delEvent(\\''+e.id+'\\')">削除</button></td></tr>';
  });
  if(!STATE.events.length) h += '<tr><td colspan="3" class="mut">予定はまだありません。</td></tr>';
  document.getElementById('evlist').innerHTML = h + '</table>';
}
function clearEventForm(){ ['ev-id','ev-title','ev-place','ev-note','ev-pc'].forEach(function(i){ document.getElementById(i).value=''; }); document.getElementById('ev-tent').value=''; document.getElementById('ev-stage').value='fixed'; }
function toggleStage(id, stage){ post('/api/admin/event/stage', {id:id, stage:stage}).then(function(d){ if(d.error) alert(d.error); else loadAll(); }); }
function copyPlanLink(){ var link = location.origin + '/plan'; if(navigator.clipboard) navigator.clipboard.writeText(link).then(function(){ alert('コピーしました。このリンクをコート予約当番の保護者にLINEで送ってください。'); }); else prompt('このリンクをコピーしてください', link); }
document.getElementById('planurl').textContent = location.origin + '/plan';
function renderPlayers(){
  var h = '';
  (STATE.players||[]).forEach(function(pl){
    var link = location.origin + '/player?k=' + pl.token;
    h += '<div style="border:1px solid #dde5dd;border-radius:10px;padding:10px;margin-bottom:8px"><b>'+esc(pl.name)+'</b> さん'
      + '<div class="mut" style="word-break:break-all">参加登録ページ：'+esc(link)+'</div>'
      + '<div class="row" style="margin-top:6px"><button class="sub" onclick="copyPlayerLink(\\''+pl.token+'\\')">リンクをコピー</button>'
      + '<button class="danger" onclick="delPlayer(\\''+pl.id+'\\')">削除</button></div></div>';
  });
  if(!(STATE.players||[]).length) h = '<div class="mut">選手がまだ登録されていません。名前を追加すると、その子専用の参加登録リンクが発行されます。</div>';
  document.getElementById('playerlist').innerHTML = h;
}
function copyPlayerLink(token){ var link = location.origin + '/player?k=' + token; if(navigator.clipboard) navigator.clipboard.writeText(link).then(function(){ alert('コピーしました。このリンクをその選手の保護者にLINEで送ってください。'); }); else prompt('このリンクをコピーしてください', link); }
function addPlayer(){ var n = document.getElementById('player-name').value.trim(); if(!n) return; post('/api/admin/player', {name:n}).then(function(d){ if(d.error) alert(d.error); else { document.getElementById('player-name').value=''; loadAll(); } }); }
function delPlayer(id){ if(!confirm('この選手を削除しますか？参加登録の回答も消えます。')) return; post('/api/admin/player/delete', {id:id}).then(loadAll); }
function editEvent(id){
  var e = STATE.events.filter(function(x){ return x.id===id; })[0]; if(!e) return;
  document.getElementById('ev-id').value = e.id;
  document.getElementById('ev-date').value = e.date;
  document.getElementById('ev-group').value = e.group;
  document.getElementById('ev-title').value = e.title;
  document.getElementById('ev-start').value = e.start||'';
  document.getElementById('ev-end').value = e.end||'';
  document.getElementById('ev-place').value = e.place||'';
  document.getElementById('ev-pc').value = e.participants==null?'':e.participants;
  document.getElementById('ev-stage').value = e.stage==='plan'?'plan':'fixed';
  document.getElementById('ev-tent').value = e.tentative?'1':'';
  document.getElementById('ev-note').value = e.note||'';
  window.scrollTo(0,0);
}
function saveEvent(){
  var body = { id: document.getElementById('ev-id').value || undefined,
    date: document.getElementById('ev-date').value, group: document.getElementById('ev-group').value,
    title: document.getElementById('ev-title').value, start: document.getElementById('ev-start').value,
    end: document.getElementById('ev-end').value, place: document.getElementById('ev-place').value,
    participants: document.getElementById('ev-pc').value===''?null:Number(document.getElementById('ev-pc').value),
    stage: document.getElementById('ev-stage').value,
    tentative: document.getElementById('ev-tent').value==='1', note: document.getElementById('ev-note').value };
  post('/api/admin/event', body).then(function(d){ if(d.error) alert(d.error); else { clearEventForm(); loadAll(); } });
}
function delEvent(id){ if(!confirm('この予定を削除しますか？出欠の回答も消えます。')) return; post('/api/admin/event/delete', {id:id}).then(loadAll); }
function bulkAdd(){
  var body = { month: document.getElementById('bulk-month').value, weekday: Number(document.getElementById('bulk-wd').value),
    group: document.getElementById('bulk-group').value, title: document.getElementById('bulk-title').value,
    start: document.getElementById('bulk-start').value, end: document.getElementById('bulk-end').value, place: document.getElementById('bulk-place').value };
  post('/api/admin/bulk', body).then(function(d){ if(d.error) alert(d.error); else { alert(d.created+'件登録しました'); loadAll(); } });
}
function renderCoaches(){
  var h = '';
  STATE.coaches.forEach(function(c){
    var link = location.origin + '/coach?k=' + c.token;
    h += '<div style="border:1px solid #dde5dd;border-radius:10px;padding:10px;margin-bottom:8px"><b>'+esc(c.name)+'</b> コーチ'
      + '<div class="mut" style="word-break:break-all">専用ページ：'+esc(link)+'</div>'
      + '<div class="row" style="margin-top:6px"><button class="sub" onclick="copyLink(\\''+c.token+'\\')">リンクをコピー</button>'
      + '<button class="danger" onclick="delCoach(\\''+c.id+'\\')">削除</button></div></div>';
  });
  if(!STATE.coaches.length) h = '<div class="mut">コーチがまだ登録されていません。名前を追加すると、その人専用の出欠ページのリンクが発行されます。</div>';
  document.getElementById('coachlist').innerHTML = h;
}
function copyLink(token){ var link = location.origin + '/coach?k=' + token; if(navigator.clipboard) navigator.clipboard.writeText(link).then(function(){ alert('コピーしました。このリンクをそのコーチにLINEで送ってください。'); }); else prompt('このリンクをコピーしてください', link); }
function addCoach(){ var n = document.getElementById('coach-name').value.trim(); if(!n) return; post('/api/admin/coach', {name:n}).then(function(d){ if(d.error) alert(d.error); else { document.getElementById('coach-name').value=''; loadAll(); } }); }
function delCoach(id){ if(!confirm('このコーチを削除しますか？出欠の回答も消えます。')) return; post('/api/admin/coach/delete', {id:id}).then(loadAll); }
function renderAtt(){
  var t = document.getElementById('atttbl');
  if(!STATE.coaches.length){ t.innerHTML = '<tr><td class="mut">コーチを登録すると出欠確認表が出ます。</td></tr>'; return; }
  var h = '<tr><th>予定</th>' + STATE.coaches.map(function(c){ return '<th>'+esc(c.name)+'</th>'; }).join('') + '</tr>';
  STATE.events.forEach(function(e){
    h += '<tr><td style="white-space:nowrap">'+dl(e.date)+' '+esc(e.title)+'</td>';
    STATE.coaches.forEach(function(c){
      var st = (STATE.attendance[e.id]||{})[c.id] || '';
      var cell = st==='yes'?'<span class="st-yes">○ 出席</span>':st==='no'?'<span class="st-no">× 欠席</span>':st==='maybe'?'<span class="st-maybe">△ 未定</span>':'<span class="st-none">未回答</span>';
      h += '<td>'+cell+'</td>';
    });
    h += '</tr>';
  });
  if(!STATE.events.length) h += '<tr><td colspan="'+(STATE.coaches.length+1)+'" class="mut">予定はまだありません。</td></tr>';
  t.innerHTML = h;
}
function clearPollForm(){ ['poll-id','poll-title','poll-note','poll-cands'].forEach(function(i){ document.getElementById(i).value=''; }); }
function savePoll(){
  var lines = document.getElementById('poll-cands').value.split('\\n').map(function(s){ return s.trim(); }).filter(Boolean);
  var cands = [];
  for(var i=0;i<lines.length;i++){
    var p = lines[i].split(/\\s+/);
    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(p[0])){ alert('候補日の形式が違います：'+lines[i]); return; }
    cands.push({ date: p[0], start: p[1]||'', end: p[2]||'', label: p.slice(3).join(' ') });
  }
  if(!cands.length){ alert('候補日を1つ以上入れてください'); return; }
  post('/api/admin/poll', { id: document.getElementById('poll-id').value || undefined, title: document.getElementById('poll-title').value, note: document.getElementById('poll-note').value, candidates: cands })
    .then(function(d){ if(d.error) alert(d.error); else { clearPollForm(); loadAll(); } });
}
function renderPolls(){
  var h = '';
  STATE.polls.forEach(function(p){
    h += '<div style="border:1px solid #dde5dd;border-radius:10px;padding:10px;margin-bottom:8px"><b>'+esc(p.title)+'</b>'+(p.closed?' <span class="badge b-ques">締切済み</span>':'');
    if(p.note) h += '<div class="mut">'+esc(p.note)+'</div>';
    h += '<table style="margin-top:6px"><tr><th>候補日</th><th>○</th><th>△</th><th>×</th><th>回答したコーチ</th><th></th></tr>';
    p.candidates.forEach(function(cd){
      var names = [];
      STATE.coaches.forEach(function(c){ var m = ((p.responses||{})[c.id]||{})[cd.id]; if(m) names.push(esc(c.name)+'：'+(m==='o'?'○':m==='t'?'△':'×')); });
      h += '<tr><td>'+dl(cd.date)+' '+(cd.start?esc(cd.start)+(cd.end?'〜'+esc(cd.end):''):'')+' '+esc(cd.label)+'</td><td>'+cd.o+'</td><td>'+cd.t+'</td><td>'+cd.x+'</td><td class="mut">'+names.join('、')+'</td>'
        + '<td>'+(p.decidedCandId===cd.id?'<b>決定済み</b>':'<button class="sub" onclick="decidePoll(\\''+p.id+'\\',\\''+cd.id+'\\')">この日に決定</button>')+'</td></tr>';
    });
    h += '</table><div class="row" style="margin-top:6px"><button class="sub" onclick="togglePoll(\\''+p.id+'\\')">'+(p.closed?'再開する':'締め切る')+'</button><button class="danger" onclick="delPoll(\\''+p.id+'\\')">調整を削除</button></div></div>';
  });
  if(!STATE.polls.length) h = '<div class="mut">日程調整はまだありません。</div>';
  document.getElementById('polllist').innerHTML = h;
}
function togglePoll(id){ post('/api/admin/poll/toggle', {id:id}).then(loadAll); }
function delPoll(id){ if(!confirm('この日程調整を削除しますか？')) return; post('/api/admin/poll/delete', {id:id}).then(loadAll); }
function decidePoll(pid, cid){
  var g = confirm('STCの予定として登録しますか？（キャンセルすると岩瀬Jrの予定になります）') ? 'stc' : 'jr';
  post('/api/admin/poll/decide', {id: pid, candId: cid, group: g}).then(function(d){ if(d.error) alert(d.error); else { alert('予定表に登録しました'); loadAll(); } });
}
authView();
</script></body></html>`;
}

/* ---------- ルーティング ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (p === '/') return sendHTML(res, viewerPage());
    if (p === '/coach') return sendHTML(res, coachPage());
    if (p === '/player') return sendHTML(res, playerPage());
    if (p === '/plan') return sendHTML(res, planPage());
    if (p === '/admin') return sendHTML(res, adminPage());

    if (p === '/api/state') {
      const month = u.searchParams.get('month') || todayJST().slice(0, 7);
      const from = month + '-01';
      const parts = month.split('-').map(Number);
      const toDate = new Date(Date.UTC(parts[0], parts[1], 0));
      const to = toDate.toISOString().slice(0, 10);
      const hol = [];
      for (let d = new Date(from + 'T00:00:00Z'); d <= toDate; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        if (isHoliday(ds)) hol.push(ds);
      }
      const fixedOnly = eventsInRange(from, to).filter(e => e.stage === 'fixed');
      return sendJSON(res, 200, { events: fixedOnly, holidays: hol });
    }

    if (p === '/api/coach') {
      const coach = coachByToken(u.searchParams.get('k'));
      if (!coach) return sendJSON(res, 404, { error: 'リンクが正しくありません。管理者から送られたリンクを開いてください。' });
      const fromD = new Date(Date.now() - 62 * 86400000 + 9 * 3600 * 1000);
      const from = fromD.toISOString().slice(0, 10);
      const toD = new Date(Date.now() + 62 * 86400000 + 9 * 3600 * 1000);
      const to = toD.toISOString().slice(0, 10);
      const events = eventsInRange(from, to).map(e => {
        const att = DB.attendance[e.id] || {};
        return Object.assign({}, e, { mine: att[coach.id] || '' });
      });
      const polls = DB.polls.filter(pl => !pl.closed || true).map(pl => pollPublic(pl, coach.id));
      return sendJSON(res, 200, { coach: { id: coach.id, name: coach.name }, today: todayJST(), events, polls });
    }

    if (p === '/api/coach/attend' && req.method === 'POST') {
      const b = await readBody(req);
      const coach = coachByToken(b.k);
      if (!coach) return sendJSON(res, 404, { error: 'リンクが正しくありません' });
      const ev = DB.events.find(e => e.id === b.eventId);
      if (!ev) return sendJSON(res, 404, { error: '予定が見つかりません' });
      if (!['yes', 'no', 'maybe'].includes(b.status)) return sendJSON(res, 400, { error: '回答が正しくありません' });
      if (!DB.attendance[ev.id]) DB.attendance[ev.id] = {};
      DB.attendance[ev.id][coach.id] = b.status;
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/coach/participants' && req.method === 'POST') {
      const b = await readBody(req);
      const coach = coachByToken(b.k);
      if (!coach) return sendJSON(res, 404, { error: 'リンクが正しくありません' });
      const ev = DB.events.find(e => e.id === b.eventId);
      if (!ev) return sendJSON(res, 404, { error: '予定が見つかりません' });
      if (b.count === null || b.count === undefined || b.count === '') ev.participants = null;
      else {
        const n = Number(b.count);
        if (!Number.isFinite(n) || n < 0 || n > 10000) return sendJSON(res, 400, { error: '人数が正しくありません' });
        ev.participants = Math.floor(n);
      }
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/coach/poll' && req.method === 'POST') {
      const b = await readBody(req);
      const coach = coachByToken(b.k);
      if (!coach) return sendJSON(res, 404, { error: 'リンクが正しくありません' });
      const poll = DB.polls.find(pl => pl.id === b.pollId);
      if (!poll) return sendJSON(res, 404, { error: '調整が見つかりません' });
      if (poll.closed) return sendJSON(res, 400, { error: 'この調整は締め切られています' });
      if (!poll.candidates.some(c => c.id === b.candId)) return sendJSON(res, 404, { error: '候補日が見つかりません' });
      if (!['o', 't', 'x'].includes(b.mark)) return sendJSON(res, 400, { error: '回答が正しくありません' });
      if (!poll.responses[coach.id]) poll.responses[coach.id] = {};
      poll.responses[coach.id][b.candId] = b.mark;
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/plan') {
      const ym = u.searchParams.get('month') || todayJST().slice(0, 7);
      const parts = ym.split('-').map(Number);
      const last = new Date(parts[0], parts[1], 0).getDate();
      const from = ym + '-01';
      const to = ym + '-' + String(last).padStart(2, '0');
      const hol = [];
      const toDate = new Date(to + 'T00:00:00Z');
      for (let d = new Date(from + 'T00:00:00Z'); d <= toDate; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        if (isHoliday(ds)) hol.push(ds);
      }
      const planOnly = eventsInRange(from, to).filter(e => e.stage === 'plan');
      return sendJSON(res, 200, { events: planOnly, holidays: hol });
    }

    if (p === '/api/player') {
      const player = playerByToken(u.searchParams.get('k'));
      if (!player) return sendJSON(res, 404, { error: 'リンクが正しくありません。管理者から送られたリンクを開いてください。' });
      const fromD = new Date(Date.now() - 62 * 86400000 + 9 * 3600 * 1000);
      const from = fromD.toISOString().slice(0, 10);
      const toD = new Date(Date.now() + 62 * 86400000 + 9 * 3600 * 1000);
      const to = toD.toISOString().slice(0, 10);
      const events = eventsInRange(from, to).filter(e => e.stage === 'fixed').map(e => {
        const att = DB.pattendance[e.id] || {};
        return Object.assign({}, e, { mine: att[player.id] || '' });
      });
      return sendJSON(res, 200, { player: { id: player.id, name: player.name }, today: todayJST(), events });
    }

    if (p === '/api/player/attend' && req.method === 'POST') {
      const b = await readBody(req);
      const player = playerByToken(b.k);
      if (!player) return sendJSON(res, 404, { error: 'リンクが正しくありません' });
      const ev = DB.events.find(e => e.id === b.eventId);
      if (!ev) return sendJSON(res, 404, { error: '予定が見つかりません' });
      if (!['yes', 'no', 'maybe'].includes(b.status)) return sendJSON(res, 400, { error: '回答が正しくありません' });
      if (!DB.pattendance[ev.id]) DB.pattendance[ev.id] = {};
      DB.pattendance[ev.id][player.id] = b.status;
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/auth/status') {
      return sendJSON(res, 200, { hasPassword: !!DB.adminPassHash, authed: isAdmin(req) });
    }
    if (p === '/api/auth/setup' && req.method === 'POST') {
      const b = await readBody(req);
      if (DB.adminPassHash) return sendJSON(res, 400, { error: 'パスワードは設定済みです' });
      if (!b.password || String(b.password).length < 4) return sendJSON(res, 400, { error: 'パスワードは4文字以上にしてください' });
      DB.adminPassHash = hashPw(b.password);
      const t = uid(24);
      DB.sessions[t] = { admin: true, at: Date.now() };
      saveDB();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'stc_admin=' + t + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!checkPw(b.password || '', DB.adminPassHash)) return sendJSON(res, 401, { error: 'パスワードが違います' });
      const t = uid(24);
      DB.sessions[t] = { admin: true, at: Date.now() };
      saveDB();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'stc_admin=' + t + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax' });
      return res.end(JSON.stringify({ ok: true }));
    }

    /* --- 管理者API --- */
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJSON(res, 401, { error: 'ログインが必要です' });
      const b = req.method === 'POST' ? await readBody(req) : {};

      if (p === '/api/admin/state') {
        const from = new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10);
        const toD = new Date(Date.now() + 92 * 86400000);
        const to = toD.toISOString().slice(0, 10);
        const events = eventsInRange(from, to);
        const polls = DB.polls.map(pl => Object.assign(pollPublic(pl, null), { responses: pl.responses || {} }));
        return sendJSON(res, 200, {
          coaches: DB.coaches.map(c => ({ id: c.id, name: c.name, token: c.token })),
          players: DB.players.map(pl => ({ id: pl.id, name: pl.name, token: pl.token })),
          events, attendance: DB.attendance, pattendance: DB.pattendance, pollsRaw: DB.polls, polls
        });
      }
      if (p === '/api/admin/event' && req.method === 'POST') {
        if (!validDate(b.date)) return sendJSON(res, 400, { error: '日付を選んでください' });
        if (!b.title || !String(b.title).trim()) return sendJSON(res, 400, { error: '内容を入れてください' });
        if (!validTime(b.start) || !validTime(b.end)) return sendJSON(res, 400, { error: '時刻の形式が違います' });
        if (!['stc', 'jr'].includes(b.group)) return sendJSON(res, 400, { error: '区分が違います' });
        let ev;
        if (b.id) {
          ev = DB.events.find(e => e.id === b.id);
          if (!ev) return sendJSON(res, 404, { error: '予定が見つかりません' });
        } else {
          ev = { id: uid(8) };
          DB.events.push(ev);
        }
        ev.date = b.date; ev.group = b.group; ev.title = String(b.title).trim();
        ev.start = b.start || ''; ev.end = b.end || ''; ev.place = String(b.place || '').trim();
        ev.note = String(b.note || '').trim(); ev.tentative = !!b.tentative;
        ev.stage = b.stage === 'plan' ? 'plan' : 'fixed';
        ev.participants = (b.participants === null || b.participants === undefined || b.participants === '') ? null : Math.max(0, Math.floor(Number(b.participants) || 0));
        saveDB();
        return sendJSON(res, 200, { ok: true, id: ev.id });
      }
      if (p === '/api/admin/event/delete' && req.method === 'POST') {
        DB.events = DB.events.filter(e => e.id !== b.id);
        delete DB.attendance[b.id];
        delete DB.pattendance[b.id];
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/event/stage' && req.method === 'POST') {
        const ev = DB.events.find(e => e.id === b.id);
        if (!ev) return sendJSON(res, 404, { error: '予定が見つかりません' });
        ev.stage = b.stage === 'plan' ? 'plan' : 'fixed';
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/player' && req.method === 'POST') {
        if (!b.name || !String(b.name).trim()) return sendJSON(res, 400, { error: '選手名を入れてください' });
        const pl = { id: uid(8), name: String(b.name).trim(), token: uid(18) };
        DB.players.push(pl);
        saveDB();
        return sendJSON(res, 200, { ok: true, player: pl });
      }
      if (p === '/api/admin/player/delete' && req.method === 'POST') {
        DB.players = DB.players.filter(pl => pl.id !== b.id);
        for (const eid of Object.keys(DB.pattendance)) { if (DB.pattendance[eid]) delete DB.pattendance[eid][b.id]; }
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/bulk' && req.method === 'POST') {
        if (!/^\d{4}-\d{2}$/.test(String(b.month || ''))) return sendJSON(res, 400, { error: '対象の月を選んでください' });
        if (!b.title || !String(b.title).trim()) return sendJSON(res, 400, { error: '内容を入れてください' });
        if (!['stc', 'jr'].includes(b.group)) return sendJSON(res, 400, { error: '区分が違います' });
        const yy = Number(b.month.slice(0, 4)), mm = Number(b.month.slice(5, 7));
        const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        let created = 0;
        for (let d = 1; d <= last; d++) {
          const dt = new Date(Date.UTC(yy, mm - 1, d));
          if (dt.getUTCDay() !== Number(b.weekday)) continue;
          const ds = b.month + '-' + String(d).padStart(2, '0');
          const dup = DB.events.some(e => e.date === ds && e.group === b.group && e.title === String(b.title).trim() && (e.start || '') === (b.start || ''));
          if (dup) continue;
          DB.events.push({ id: uid(8), date: ds, group: b.group, title: String(b.title).trim(), start: b.start || '', end: b.end || '', place: String(b.place || '').trim(), note: '', tentative: false, participants: null, stage: 'plan' });
          created++;
        }
        saveDB();
        return sendJSON(res, 200, { ok: true, created });
      }
      if (p === '/api/admin/coach' && req.method === 'POST') {
        if (!b.name || !String(b.name).trim()) return sendJSON(res, 400, { error: 'コーチ名を入れてください' });
        const c = { id: uid(8), name: String(b.name).trim(), token: uid(18) };
        DB.coaches.push(c);
        saveDB();
        return sendJSON(res, 200, { ok: true, coach: c });
      }
      if (p === '/api/admin/coach/delete' && req.method === 'POST') {
        DB.coaches = DB.coaches.filter(c => c.id !== b.id);
        for (const eid of Object.keys(DB.attendance)) { if (DB.attendance[eid]) delete DB.attendance[eid][b.id]; }
        for (const pl of DB.polls) { if (pl.responses) delete pl.responses[b.id]; }
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/poll' && req.method === 'POST') {
        if (!b.title || !String(b.title).trim()) return sendJSON(res, 400, { error: 'タイトルを入れてください' });
        if (!Array.isArray(b.candidates) || !b.candidates.length) return sendJSON(res, 400, { error: '候補日を入れてください' });
        for (const cd of b.candidates) { if (!validDate(cd.date)) return sendJSON(res, 400, { error: '候補日の日付が違います' }); }
        let poll;
        if (b.id) {
          poll = DB.polls.find(pl => pl.id === b.id);
          if (!poll) return sendJSON(res, 404, { error: '調整が見つかりません' });
        } else {
          poll = { id: uid(8), responses: {}, closed: false, decidedCandId: null };
          DB.polls.push(poll);
        }
        poll.title = String(b.title).trim();
        poll.note = String(b.note || '').trim();
        poll.candidates = b.candidates.map(cd => ({ id: uid(6), date: cd.date, start: cd.start || '', end: cd.end || '', label: String(cd.label || '').trim() }));
        saveDB();
        return sendJSON(res, 200, { ok: true, id: poll.id });
      }
      if (p === '/api/admin/poll/toggle' && req.method === 'POST') {
        const poll = DB.polls.find(pl => pl.id === b.id);
        if (!poll) return sendJSON(res, 404, { error: '調整が見つかりません' });
        poll.closed = !poll.closed;
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/poll/delete' && req.method === 'POST') {
        DB.polls = DB.polls.filter(pl => pl.id !== b.id);
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/poll/decide' && req.method === 'POST') {
        const poll = DB.polls.find(pl => pl.id === b.id);
        if (!poll) return sendJSON(res, 404, { error: '調整が見つかりません' });
        const cd = poll.candidates.find(c => c.id === b.candId);
        if (!cd) return sendJSON(res, 404, { error: '候補日が見つかりません' });
        const group = b.group === 'jr' ? 'jr' : 'stc';
        const ev = { id: uid(8), date: cd.date, group, title: poll.title, start: cd.start || '', end: cd.end || '', place: cd.label || '', note: '日程調整で決定', tentative: false, participants: null, stage: 'plan' };
        DB.events.push(ev);
        poll.decidedCandId = cd.id;
        poll.closed = true;
        saveDB();
        return sendJSON(res, 200, { ok: true, eventId: ev.id });
      }
      return sendJSON(res, 404, { error: 'not found' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    console.error(e);
    try { sendJSON(res, 500, { error: 'サーバーエラー' }); } catch (e2) {}
  }
});

server.listen(PORT, () => { console.log('stc-schedule listening on ' + PORT + ' data=' + DATA_FILE); });
