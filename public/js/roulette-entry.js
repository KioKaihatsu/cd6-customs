// ============================================================
//  抽選ルーレット 参加者エントリーページ
// ============================================================
(async function () {
  const params = new URLSearchParams(location.search);
  const rid = params.get("rid");
  const storeKey = "rentry:" + rid;

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

  if (!pub.open) {
    $("#closedBox").classList.remove("hidden");
    return;
  }

  const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
  if (saved) {
    $("#name").value = saved.name || "";
    $("#food").value = saved.food || "";
    showDone(saved);
  } else {
    $("#form").classList.remove("hidden");
  }

  $("#form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#name").value.trim();
    const food = $("#food").value.trim();
    if (!name) return toast("お名前を入力してください", "err");
    if (!food) return toast("好物を入力してください", "err");

    const payload = { entryId: saved ? saved.id : undefined, name, food };
    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "送信中...";
    try {
      const res = await api("POST", "/api/roulette/" + rid + "/entry", payload);
      const rec = { id: res.entry.id, name, food };
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

  function showDone(rec) {
    $("#form").classList.add("hidden");
    const s = $("#summary");
    s.className = "summary-card panel";
    s.innerHTML = "";
    const add = (k, v) => s.append(el("div", { class: "ln" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v)));
    add("お名前", rec.name);
    add("好物", rec.food);
    $("#done").classList.remove("hidden");
  }
})();
