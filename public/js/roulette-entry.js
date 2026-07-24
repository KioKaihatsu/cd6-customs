// ============================================================
//  抽選ルーレット 参加者エントリーページ (最大3人まとめて応募)
// ============================================================
(async function () {
  const params = new URLSearchParams(location.search);
  const rid = params.get("rid");
  const storeKey = "rentry:" + rid;
  const MAX = 3;

  if (!rid) {
    $("#hero").innerHTML = "<h1>抽選IDがありません</h1><p class='muted'>主催者のQRコードから開いてください。</p>";
    return;
  }

  let pub;
  try {
    pub = await api("GET", "/api/roulette/" + rid + "/public");
  } catch (e) {
    $("#hero").innerHTML = "<h1>抽選が見つかりません</h1><p class='muted'>" + escapeHtml(e.message) + "</p>";
    return;
  }

  $("#title").textContent = pub.title;
  $("#count").textContent = pub.count;
  if (!pub.open) { $("#closedBox").classList.remove("hidden"); return; }

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

  function addBlock(data) {
    if (blocks.length >= MAX) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node._id = (data && data.id) || null;
    if (data) {
      node.querySelector(".p-name").value = data.name || "";
      node.querySelector(".p-food").value = data.food || "";
    }
    node.querySelector(".person-remove").addEventListener("click", () => {
      blocks = blocks.filter(b => b !== node);
      node.remove(); renumber(); updateAdd();
    });
    box.append(node);
    blocks.push(node);
    renumber(); updateAdd();
  }

  const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
  if (saved && saved.length) {
    saved.forEach(m => addBlock(m));
    showDone(saved);
  } else {
    addBlock();
    $("#form").classList.remove("hidden");
  }

  $("#addPerson").addEventListener("click", () => addBlock());

  $("#form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const members = [];
    for (const node of blocks) {
      const name = node.querySelector(".p-name").value.trim();
      const food = node.querySelector(".p-food").value.trim();
      if (!name && !food) continue;                    // 空の枠はスキップ
      if (!name) return toast("お名前を入力してください", "err");
      if (!food) return toast("「" + name + "」さんの好物を入力してください", "err");
      members.push({ id: node._id || undefined, name, food });
    }
    if (!members.length) return toast("お名前を入力してください", "err");

    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "送信中...";
    try {
      const res = await api("POST", "/api/roulette/" + rid + "/entry", { members });
      const recs = res.entries.map(e => ({ id: e.id, name: e.name, food: e.food }));
      localStorage.setItem(storeKey, JSON.stringify(recs));
      // ブロックにIDを反映（再編集時の更新用）
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

  function showDone(recs) {
    $("#form").classList.add("hidden");
    const s = $("#summary");
    s.className = "done-people";
    s.innerHTML = "";
    recs.forEach((rec, i) => {
      const card = el("div", { class: "done-person panel" },
        el("div", { class: "dp-name" }, (recs.length > 1 ? (i + 1) + "人目： " : "") + rec.name),
        el("div", { class: "ln", style: "display:flex;justify-content:space-between" },
          el("span", { class: "muted" }, "好物"), el("span", { style: "font-weight:700" }, rec.food)),
      );
      s.append(card);
    });
    $("#doneCount") && ($("#doneCount").textContent = recs.length);
    $("#done").classList.remove("hidden");
  }
})();
