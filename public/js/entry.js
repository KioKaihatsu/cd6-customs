// ============================================================
//  参加者エントリーページ (最大3人まとめてエントリー)
// ============================================================
(async function () {
  const params = new URLSearchParams(location.search);
  const eventId = params.get("ev");
  const storeKey = "entry:" + eventId;
  const MAX = 3;

  if (!eventId) {
    $("#hero").innerHTML = "<h1>イベントIDがありません</h1><p class='muted'>主催者のQRコードから開いてください。</p>";
    return;
  }

  let pub, cfg, gameCfg;
  try {
    pub = await api("GET", "/api/event/" + eventId + "/public");
    cfg = await getConfig();
  } catch (e) {
    $("#hero").innerHTML = "<h1>イベントが見つかりません</h1><p class='muted'>" + escapeHtml(e.message) + "</p>";
    return;
  }
  gameCfg = cfg[pub.game];

  document.body.classList.add(pub.game);
  $("#gameLabel").textContent = gameCfg.label;
  $("#gameLabel").style.color = pub.game === "lol" ? "var(--lol)" : "var(--valo)";
  $("#title").textContent = pub.title;
  $("#count").textContent = pub.count;
  if (!pub.open) { $("#closedBox").classList.remove("hidden"); return; }

  const labelMap = pub.game === "lol" ? { "4": "IV", "3": "III", "2": "II", "1": "I" } : null;
  const divLabel = (d) => (labelMap ? labelMap[d] : d);
  const tierObj = (key) => gameCfg.tiers.find(x => x.key === key);

  const box = $("#people");
  const tpl = $("#personTpl");
  let blocks = [];

  function renumber() {
    blocks.forEach((b, i) => {
      b.querySelector(".person-title").textContent = (i + 1) + "人目";
      b.querySelector(".person-remove").classList.toggle("hidden", blocks.length <= 1);
    });
  }
  function updateAdd() { $("#addPerson").classList.toggle("hidden", blocks.length >= MAX); }

  function buildPos(node, container, mode) {
    container.innerHTML = "";
    gameCfg.positions.forEach(p => {
      const pill = el("div", { class: "pos", "data-k": p.key }, p.label);
      pill.addEventListener("click", () => {
        if (mode === "prim") {
          node._prim = (node._prim === p.key) ? null : p.key;
          if (node._sec === node._prim) node._sec = null;
        } else {
          node._sec = (node._sec === p.key) ? null : p.key;
          if (node._prim === node._sec) node._prim = null;
        }
        renderPos(node);
      });
      container.append(pill);
    });
  }
  function renderPos(node) {
    node.querySelectorAll(".p-primary .pos").forEach(n => n.classList.toggle("sel", n.dataset.k === node._prim));
    node.querySelectorAll(".p-secondary .pos").forEach(n => {
      n.classList.toggle("sel2", n.dataset.k === node._sec);
      n.style.opacity = (n.dataset.k === node._prim) ? ".35" : "1";
    });
  }

  function makeBlock(data) {
    if (blocks.length >= MAX) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node._id = (data && data.id) || null;
    node._prim = (data && data.primaryPos) || null;
    node._sec = (data && data.secondaryPos) || null;

    node.querySelector(".p-riotLab").textContent = pub.game === "lol" ? "Riot ID (サモナー名#タグ)" : "Riot ID (例: Name#TAG)";

    const tierSel = node.querySelector(".p-tier");
    tierSel.append(new Option("ティアを選択", ""));
    [...gameCfg.tiers].reverse().forEach(t => tierSel.append(new Option(t.label, t.key)));
    const divSel = node.querySelector(".p-division");
    function refreshDiv() {
      const t = tierObj(tierSel.value);
      divSel.innerHTML = "";
      if (!tierSel.value || (t && t.apex)) { divSel.append(new Option("—", "")); divSel.disabled = true; return; }
      divSel.disabled = false;
      gameCfg.divisions.forEach(d => divSel.append(new Option(divLabel(d), d)));
    }
    tierSel.addEventListener("change", refreshDiv);
    refreshDiv();

    buildPos(node, node.querySelector(".p-primary"), "prim");
    buildPos(node, node.querySelector(".p-secondary"), "sec");

    node.querySelector(".person-remove").addEventListener("click", () => {
      blocks = blocks.filter(b => b !== node);
      node.remove(); renumber(); updateAdd();
    });

    if (data) {
      node.querySelector(".p-nickname").value = data.nickname || "";
      node.querySelector(".p-riotId").value = data.riotId || "";
      tierSel.value = data.tier || ""; refreshDiv(); divSel.value = data.division || "";
    }

    box.append(node);
    blocks.push(node);
    renderPos(node);
    renumber(); updateAdd();
    return node;
  }

  const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
  if (saved && saved.length) {
    saved.forEach(m => makeBlock(m));
    showDone(saved);
  } else {
    makeBlock();
    $("#form").classList.remove("hidden");
  }

  $("#addPerson").addEventListener("click", () => makeBlock());

  $("#form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const members = [];
    for (const node of blocks) {
      const nickname = node.querySelector(".p-nickname").value.trim();
      const tierSel = node.querySelector(".p-tier");
      const divSel = node.querySelector(".p-division");
      const anyFilled = nickname || tierSel.value || node._prim;
      if (!anyFilled) continue;               // 空の枠はスキップ
      if (!nickname) return toast("表示名を入力してください", "err");
      if (!tierSel.value) return toast("「" + nickname + "」さんのランクを選択してください", "err");
      const t = tierObj(tierSel.value);
      if (!t.apex && !divSel.value) return toast("「" + nickname + "」さんのディビジョンを選択してください", "err");
      if (!node._prim) return toast("「" + nickname + "」さんの第一希望ポジションを選んでください", "err");
      members.push({
        id: node._id || undefined,
        nickname, riotId: node.querySelector(".p-riotId").value.trim(),
        tier: tierSel.value, division: t.apex ? "" : divSel.value,
        primaryPos: node._prim, secondaryPos: node._sec,
      });
    }
    if (!members.length) return toast("表示名を入力してください", "err");

    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "送信中...";
    try {
      const res = await api("POST", "/api/event/" + eventId + "/entry", { members });
      const recs = res.entries.map(e => ({
        id: e.id, nickname: e.nickname, riotId: e.riotId,
        tier: e.tier, division: e.division, primaryPos: e.primaryPos, secondaryPos: e.secondaryPos,
      }));
      localStorage.setItem(storeKey, JSON.stringify(recs));
      blocks.forEach((node, i) => { if (recs[i]) node._id = recs[i].id; });
      showDone(recs);
      toast(recs.length + "人のエントリーが完了しました！", "ok");
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

  function labelOf(list, key) { const x = list.find(i => i.key === key); return x ? x.label : "—"; }
  function line(k, v) {
    return el("div", { class: "ln", style: "display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)" },
      el("span", { class: "muted" }, k), el("span", { style: "font-weight:700" }, v));
  }
  function showDone(recs) {
    $("#form").classList.add("hidden");
    const s = $("#summary"); s.className = "done-people"; s.innerHTML = "";
    recs.forEach((rec, i) => {
      const t = tierObj(rec.tier);
      let dl = ""; if (t && !t.apex && rec.division) dl = " " + divLabel(rec.division);
      s.append(el("div", { class: "done-person panel" },
        el("div", { class: "dp-name" }, (recs.length > 1 ? (i + 1) + "人目： " : "") + rec.nickname),
        line("ランク", labelOf(gameCfg.tiers, rec.tier) + dl),
        line("第一希望", labelOf(gameCfg.positions, rec.primaryPos)),
        rec.secondaryPos ? line("第二希望", labelOf(gameCfg.positions, rec.secondaryPos)) : null,
      ));
    });
    $("#done").classList.remove("hidden");
  }
})();
