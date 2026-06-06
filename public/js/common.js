// ============================================================
//  共通ユーティリティ
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || ("エラー (" + res.status + ")"));
  return data;
}

function toast(msg, kind = "ok") {
  const wrap = $("#toasts");
  if (!wrap) return;
  const t = el("div", { class: "toast " + kind }, msg);
  wrap.append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateY(10px)"; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 設定キャッシュ
let CONFIG = null;
async function getConfig() {
  if (!CONFIG) CONFIG = await api("GET", "/api/config");
  return CONFIG;
}
