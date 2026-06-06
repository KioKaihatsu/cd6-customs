// ============================================================
//  参加者エントリーページ
// ============================================================
(async function () {
  const params = new URLSearchParams(location.search);
  const eventId = params.get("ev");
  const storeKey = "entry:" + eventId;

  if (!eventId) {
    $("#hero").innerHTML = "<h1>イベントIDがありません</h1><p class='muted'>主催者のQRコードから開いてください。</p>";
    return;
  }

  let pub, cfg, gameCfg;
  try {
    pub = (await api("GET", "/api/event/" + eventId + "/public"));
    cfg = await getConfig();
  } catch (e) {
    $("#hero").innerHTML = "<h1>イベントが見つかりません</h1><p class='muted'>" + escapeHtml(e.message) + "</p>";
    return;
  }
  gameCfg = cfg[pub.game];

  // ヘッダー
  document.body.classList.add(pub.game);
  $("#gameLabel").textContent = gameCfg.label;
  $("#gameLabel").style.color = pub.game === "lol" ? "var(--lol)" : "var(--valo)";
  $("#title").textContent = pub.title;
  $("#count").textContent = pub.count;
  $("#riotLab").textContent = pub.game === "lol" ? "Riot ID (サモナー名#タグ)" : "Riot ID (例: Name#TAG)";

  if (!pub.open) {
    $("#closedBox").classList.remove("hidden");
    return;
  }

  // ティア & ディビジョン
  const tierSel = $("#tier");
  tierSel.append(el("option", { value: "" }, "ティアを選択"));
  // 高い順に表示
  [...gameCfg.tiers].reverse().forEach(t => tierSel.append(el("option", { value: t.key }, t.label)));
  const divSel = $("#division");

  function refreshDivisions() {
    const tk = tierSel.value;
    const t = gameCfg.tiers.find(x => x.key === tk);
    divSel.innerHTML = "";
    if (!tk || (t && t.apex)) {
      divSel.append(el("option", { value: "" }, "—"));
      divSel.disabled = true;
      return;
    }
    divSel.disabled = false;
    // LoL は IV..I, VALO は 1..3 表示
    const divs = gameCfg.divisions;
    const labelMap = pub.game === "lol" ? { "4": "IV", "3": "III", "2": "II", "1": "I" } : null;
    divs.forEach(d => divSel.append(el("option", { value: d }, labelMap ? labelMap[d] : d)));
  }
  tierSel.addEventListener("change", refreshDivisions);
  refreshDivisions();

  // ポジション選択
  let prim = null, sec = null;
  function buildPos(container, mode) {
    container.innerHTML = "";
    gameCfg.positions.forEach(p => {
      const node = el("div", { class: "pos", "data-k": p.key }, p.label);
      node.addEventListener("click", () => {
        if (mode === "prim") {
          prim = (prim === p.key) ? null : p.key;
          if (sec === prim) sec = null;
        } else {
          sec = (sec === p.key) ? null : p.key;
          if (prim === sec) prim = null;
        }
        renderPos();
      });
      container.append(node);
    });
  }
  function renderPos() {
    $$("#primaryPos .pos").forEach(n => n.classList.toggle("sel", n.dataset.k === prim));
    $$("#secondaryPos .pos").forEach(n => {
      n.classList.toggle("sel2", n.dataset.k === sec);
      n.style.opacity = (n.dataset.k === prim) ? ".35" : "1";
    });
  }
  buildPos($("#primaryPos"), "prim");
  buildPos($("#secondaryPos"), "sec");
  renderPos();

  // 既存エントリーの復元
  const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
  if (saved) {
    $("#nickname").value = saved.nickname || "";
    $("#riotId").value = saved.riotId || "";
    tierSel.value = saved.tier || ""; refreshDivisions();
    divSel.value = saved.division || "";
    prim = saved.primaryPos || null; sec = saved.secondaryPos || null;
    renderPos();
    showDone(saved);
  } else {
    $("#form").classList.remove("hidden");
  }

  // 送信
  $("#form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nickname = $("#nickname").value.trim();
    if (!nickname) return toast("表示名を入力してください", "err");
    if (!tierSel.value) return toast("ランクを選択してください", "err");
    const t = gameCfg.tiers.find(x => x.key === tierSel.value);
    if (!t.apex && !divSel.value) return toast("ディビジョンを選択してください", "err");
    if (!prim) return toast("第一希望ポジションを選んでください", "err");

    const payload = {
      entryId: saved ? saved.id : undefined,
      nickname, riotId: $("#riotId").value.trim(),
      tier: tierSel.value, division: t.apex ? "" : divSel.value,
      primaryPos: prim, secondaryPos: sec,
    };
    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "送信中...";
    try {
      const res = await api("POST", "/api/event/" + eventId + "/entry", payload);
      const rec = { id: res.entry.id, ...payload };
      localStorage.setItem(storeKey, JSON.stringify(rec));
      showDone(rec);
      toast("エントリーが完了しました！", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false; btn.textContent = "エントリーする";
    }
  });

  $("#editBtn").addEventListener("click", () => {
    $("#done").classList.add("hidden");
    $("#form").classList.remove("hidden");
    $("#submitBtn").textContent = "更新する";
  });

  function labelOf(list, key) {
    const x = list.find(i => i.key === key);
    return x ? x.label : "—";
  }
  function showDone(rec) {
    $("#form").classList.add("hidden");
    const tierLabel = labelOf(gameCfg.tiers, rec.tier);
    const t = gameCfg.tiers.find(x => x.key === rec.tier);
    let divLabel = "";
    if (t && !t.apex && rec.division) {
      divLabel = pub.game === "lol" ? ({ "4": " IV", "3": " III", "2": " II", "1": " I" }[rec.division] || "") : (" " + rec.division);
    }
    const s = $("#summary");
    s.className = "summary-card panel";
    s.innerHTML = "";
    const add = (k, v) => s.append(el("div", { class: "ln" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v)));
    add("表示名", rec.nickname);
    if (rec.riotId) add("Riot ID", rec.riotId);
    add("ランク", tierLabel + divLabel);
    add("第一希望", labelOf(gameCfg.positions, rec.primaryPos));
    if (rec.secondaryPos) add("第二希望", labelOf(gameCfg.positions, rec.secondaryPos));
    $("#done").classList.remove("hidden");
  }
})();
