let campaigns = [];
let selectedCampaignId = null;
let products = [];
let orders = [];
let reports = null;

const config = window.PADARIA_CONFIG || {};
const db = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
const el = (id) => document.getElementById(id);
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function parseMoney(value) {
  return Number(String(value || "0").replace(/\./g, "").replace(",", "."));
}

function statusLabel(status) {
  return {
    rascunho: "Rascunho",
    aberta: "Aberta",
    encerrada_automaticamente: "Encerrada automaticamente",
    encerrada_manualmente: "Encerrada manualmente",
    finalizada: "Finalizada",
    aguardando_retirada: "Aguardando retirada",
    retirado_pago: "Retirado e pago",
    cancelado: "Cancelado"
  }[status] || status;
}

function pill(status) {
  const cls = status === "aberta" || status === "retirado_pago"
    ? "good"
    : status === "cancelado" || String(status).startsWith("encerrada")
      ? "bad"
      : "warn";
  return `<span class="pill ${cls}">${statusLabel(status)}</span>`;
}

function dateTime(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function dateOnly(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(value + "T12:00:00"));
}

async function ensureSession() {
  const { data } = await db.auth.getSession();
  if (data.session) showAdmin();
  else showLogin();
}

function showLogin() {
  el("loginView").classList.remove("hidden");
  el("adminView").classList.add("hidden");
}

function showAdmin() {
  el("loginView").classList.add("hidden");
  el("adminView").classList.remove("hidden");
  loadCampaigns();
}

async function login() {
  el("loginMessage").innerHTML = "";
  const { error } = await db.auth.signInWithPassword({
    email: el("email").value,
    password: el("password").value
  });
  if (error) {
    el("loginMessage").innerHTML = `<div class="error">${error.message}</div>`;
    return;
  }
  showAdmin();
}

async function logout() {
  await db.auth.signOut();
  showLogin();
}

async function loadCampaigns() {
  await db.rpc("atualizar_campanhas_encerradas");
  const { data, error } = await db.from("campanhas").select("*").order("id", { ascending: false });
  if (error) return alert(error.message);
  campaigns = data || [];
  if (!selectedCampaignId && campaigns.length) selectedCampaignId = campaigns[0].id;
  renderCampaignList();
  await loadSelectedCampaign();
}

function renderCampaignList() {
  const list = el("campaignList");
  list.innerHTML = "";
  campaigns.forEach((campaign) => {
    const button = document.createElement("button");
    button.className = campaign.id === selectedCampaignId ? "" : "secondary";
    button.innerHTML = `${campaign.titulo}<br><span style="font-weight:600">${dateOnly(campaign.data_retirada)} • ${statusLabel(campaign.status)}</span>`;
    button.addEventListener("click", async () => {
      selectedCampaignId = campaign.id;
      renderCampaignList();
      await loadSelectedCampaign();
    });
    list.appendChild(button);
  });
}

function selectedCampaign() {
  return campaigns.find((item) => item.id === selectedCampaignId);
}

function canDeleteCampaign(campaign) {
  return campaign && (
    campaign.status === "encerrada_automaticamente" ||
    campaign.status === "encerrada_manualmente" ||
    campaign.status === "finalizada"
  );
}

function clearSelectedCampaignDetails(message = "Selecione uma campanha") {
  products = [];
  orders = [];
  reports = buildReports();
  el("selectedCampaignTitle").textContent = message;
  el("selectedCampaignMeta").textContent = "";
  el("deleteCampaignBtn").disabled = true;
  renderMetrics();
  renderProducts();
  renderOrders();
  renderProduction();
}

async function loadSelectedCampaign() {
  const campaign = selectedCampaign();
  if (!campaign) {
    clearSelectedCampaignDetails();
    return;
  }

  el("selectedCampaignTitle").textContent = campaign.titulo;
  el("selectedCampaignMeta").innerHTML = `Retirada: ${dateOnly(campaign.data_retirada)} • Prazo: ${dateTime(campaign.prazo_final_pedidos)} • ${pill(campaign.status)}`;
  el("deleteCampaignBtn").disabled = !canDeleteCampaign(campaign);

  const { data: productRows, error: productError } = await db
    .from("produtos_campanha_resumo")
    .select("*")
    .eq("campanha_id", campaign.id)
    .order("ordem_exibicao", { ascending: true });
  if (productError) {
    clearSelectedCampaignDetails("Erro ao carregar produtos");
    return alert(productError.message);
  }
  products = productRows || [];

  const { data: orderRows, error: orderError } = await db
    .from("pedidos")
    .select("*, itens_pedido(*)")
    .eq("campanha_id", campaign.id)
    .order("id", { ascending: false });
  if (orderError) {
    clearSelectedCampaignDetails("Erro ao carregar pedidos");
    return alert(orderError.message);
  }
  orders = orderRows || [];

  reports = buildReports();
  renderMetrics();
  renderProducts();
  renderOrders();
  renderProduction();
}

function buildReports() {
  const validOrders = orders.filter((order) => order.status !== "cancelado");
  const paidOrders = validOrders.filter((order) => order.status === "retirado_pago");
  const total = validOrders.reduce((sum, order) => sum + Number(order.valor_total || 0), 0);
  const paid = paidOrders.reduce((sum, order) => sum + Number(order.valor_total || 0), 0);

  return {
    finance: {
      totalOrders: validOrders.length,
      totalCustomers: new Set(validOrders.map((order) => order.telefone_normalizado)).size,
      totalItems: validOrders.flatMap((order) => order.itens_pedido || []).reduce((sum, item) => sum + item.quantidade, 0),
      total,
      paid,
      pending: total - paid,
      cancelledOrders: orders.length - validOrders.length,
      averageTicket: validOrders.length ? total / validOrders.length : 0
    },
    production: products
  };
}

function renderMetrics() {
  const finance = reports.finance;
  el("mOrders").textContent = finance.totalOrders;
  el("mCustomers").textContent = finance.totalCustomers;
  el("mItems").textContent = finance.totalItems;
  el("mTotal").textContent = money(finance.total);
  el("mPaid").textContent = money(finance.paid);
  el("mPending").textContent = money(finance.pending);
  el("mTicket").textContent = money(finance.averageTicket);
  el("mCancelled").textContent = finance.cancelledOrders;
}

function renderProducts() {
  const tbody = el("productsTable");
  tbody.innerHTML = "";
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="7">Nenhum produto cadastrado.</td></tr>`;
    return;
  }

  products.forEach((product) => {
    const situation = !product.ativo
      ? '<span class="pill warn">Indisponível</span>'
      : product.quantidade_disponivel <= 0
        ? '<span class="pill bad">Esgotado</span>'
        : '<span class="pill good">Disponível</span>';

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${product.nome}</strong><br><span class="muted">${product.descricao || ""}</span></td>
      <td>${money(product.preco_unitario)}</td>
      <td>${product.quantidade_maxima}</td>
      <td>${product.quantidade_vendida}</td>
      <td>${product.quantidade_disponivel}</td>
      <td>${situation}</td>
      <td><button class="secondary" data-toggle="${product.id}">${product.ativo ? "Desativar" : "Ativar"}</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const product = products.find((item) => item.id === Number(button.dataset.toggle));
      const { error } = await db.from("produtos_campanha").update({ ativo: !product.ativo }).eq("id", product.id);
      if (error) return alert(error.message);
      await loadSelectedCampaign();
    });
  });
}

function renderOrders() {
  const term = String(el("orderSearch").value || "").toLowerCase();
  const filter = el("orderFilter").value;
  const tbody = el("ordersTable");
  tbody.innerHTML = "";

  const visible = orders.filter((order) => {
    const text = `${order.nome_cliente} ${order.telefone_cliente}`.toLowerCase();
    return (!term || text.includes(term)) && (!filter || order.status === filter);
  });

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="6">Nenhum pedido encontrado.</td></tr>`;
    return;
  }

  visible.forEach((order) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${order.numero_pedido}</strong><br><span class="muted">${dateTime(order.created_at)}</span></td>
      <td>${order.nome_cliente}<br><span class="muted">${order.telefone_cliente}</span></td>
      <td>${(order.itens_pedido || []).map((item) => `${item.quantidade}x ${item.nome_produto_snapshot}`).join("<br>")}</td>
      <td>${money(order.valor_total)}</td>
      <td>${pill(order.status)}</td>
      <td>
        <div class="row">
          <button class="good" data-paid="${order.id}" ${order.status === "retirado_pago" ? "disabled" : ""}>Pago</button>
          <button class="secondary" data-pending="${order.id}" ${order.status === "aguardando_retirada" ? "disabled" : ""}>Aguardando</button>
          <button class="bad" data-cancel="${order.id}" ${order.status === "cancelado" ? "disabled" : ""}>Cancelar</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  bindOrderButtons(tbody);
}

function bindOrderButtons(root) {
  root.querySelectorAll("[data-paid]").forEach((button) => button.addEventListener("click", () => updateOrderStatus(button.dataset.paid, "retirado_pago")));
  root.querySelectorAll("[data-pending]").forEach((button) => button.addEventListener("click", () => updateOrderStatus(button.dataset.pending, "aguardando_retirada")));
  root.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      if (confirm("Cancelar este pedido? As unidades voltam para o saldo.")) updateOrderStatus(button.dataset.cancel, "cancelado");
    });
  });
}

async function updateOrderStatus(orderId, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === "cancelado") patch.cancelado_em = new Date().toISOString();
  const { error } = await db.from("pedidos").update(patch).eq("id", orderId);
  if (error) return alert(error.message);
  await loadSelectedCampaign();
}

function renderProduction() {
  const tbody = el("productionTable");
  tbody.innerHTML = "";
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="4">Nenhum produto cadastrado.</td></tr>`;
    return;
  }
  products.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${item.nome}</td><td><strong>${item.quantidade_vendida}</strong></td><td>${item.quantidade_maxima}</td><td>${item.quantidade_disponivel}</td>`;
    tbody.appendChild(tr);
  });
}

async function createCampaign() {
  el("campaignMessage").innerHTML = "";
  const deadline = new Date(`${el("deadlineDate").value}T${el("deadlineTime").value}:00-03:00`).toISOString();
  const { data, error } = await db.from("campanhas").insert({
    titulo: el("campaignTitleInput").value,
    data_retirada: el("pickupDate").value,
    prazo_final_pedidos: deadline,
    mensagem_cliente: el("customerMessageInput").value,
    status: "rascunho"
  }).select().single();
  if (error) {
    el("campaignMessage").innerHTML = `<div class="error">${error.message}</div>`;
    return;
  }
  selectedCampaignId = data.id;
  el("campaignMessage").innerHTML = `<div class="success">Campanha criada.</div>`;
  await loadCampaigns();
}

async function setCampaignStatus(status) {
  const campaign = selectedCampaign();
  if (!campaign) return;
  const patch = { status, updated_at: new Date().toISOString() };
  if (String(status).startsWith("encerrada")) patch.encerrada_em = new Date().toISOString();
  const { error } = await db.from("campanhas").update(patch).eq("id", campaign.id);
  if (error) return alert(error.message);
  await loadCampaigns();
}

async function deleteSelectedCampaign() {
  const campaign = selectedCampaign();
  if (!campaign) return;

  if (!canDeleteCampaign(campaign)) {
    alert("Só é possível apagar campanhas encerradas ou finalizadas.");
    return;
  }

  const confirmed = confirm(`Apagar a campanha "${campaign.titulo}"?\n\nIsso também apaga os produtos e pedidos dessa campanha.`);
  if (!confirmed) return;

  const { error } = await db.from("campanhas").delete().eq("id", campaign.id);
  if (error) return alert(error.message);

  selectedCampaignId = null;
  await loadCampaigns();
}

async function addProduct() {
  el("productMessage").innerHTML = "";
  const campaign = selectedCampaign();
  if (!campaign) return;

  const { error } = await db.from("produtos_campanha").insert({
    campanha_id: campaign.id,
    nome: el("productName").value,
    descricao: el("productDescription").value,
    preco_unitario: parseMoney(el("productPrice").value),
    quantidade_maxima: Number(el("productMax").value),
    ordem_exibicao: products.length + 1
  });
  if (error) {
    el("productMessage").innerHTML = `<div class="error">${error.message}</div>`;
    return;
  }
  ["productName", "productDescription", "productPrice", "productMax"].forEach((id) => el(id).value = "");
  el("productMessage").innerHTML = `<div class="success">Produto adicionado.</div>`;
  await loadSelectedCampaign();
}

function setupDefaultDates() {
  const today = new Date();
  const pickup = new Date(today);
  pickup.setDate(today.getDate() + 7);
  const deadline = new Date(pickup);
  deadline.setDate(pickup.getDate() - 1);
  el("pickupDate").value = pickup.toISOString().slice(0, 10);
  el("deadlineDate").value = deadline.toISOString().slice(0, 10);
}

function exportCsv(type) {
  const rows = [];
  if (type === "orders") {
    rows.push(["Pedido", "Cliente", "Telefone", "Data", "Produtos", "Total", "Situacao"]);
    orders.forEach((order) => rows.push([
      order.numero_pedido,
      order.nome_cliente,
      order.telefone_cliente,
      dateTime(order.created_at),
      (order.itens_pedido || []).map((item) => `${item.quantidade}x ${item.nome_produto_snapshot}`).join(", "),
      Number(order.valor_total).toFixed(2),
      order.status
    ]));
  }
  if (type === "production") {
    rows.push(["Produto", "Maximo", "Vendido", "Disponivel"]);
    products.forEach((item) => rows.push([item.nome, item.quantidade_maxima, item.quantidade_vendida, item.quantidade_disponivel]));
  }
  if (type === "finance") {
    const f = reports.finance;
    rows.push(["Total previsto", f.total.toFixed(2)], ["Total retirado e pago", f.paid.toFixed(2)], ["Total pendente", f.pending.toFixed(2)], ["Clientes", f.totalCustomers], ["Pedidos", f.totalOrders], ["Ticket medio", f.averageTicket.toFixed(2)], ["Pedidos cancelados", f.cancelledOrders]);
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${type}-campanha-${selectedCampaignId}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((item) => item.classList.add("hidden"));
    button.classList.add("active");
    el(button.dataset.tab).classList.remove("hidden");
  });
});

document.querySelectorAll("[data-csv]").forEach((button) => button.addEventListener("click", () => exportCsv(button.dataset.csv)));

el("loginBtn").addEventListener("click", login);
el("logoutBtn").addEventListener("click", logout);
el("createCampaignBtn").addEventListener("click", createCampaign);
el("openCampaignBtn").addEventListener("click", () => setCampaignStatus("aberta"));
el("closeCampaignBtn").addEventListener("click", () => setCampaignStatus("encerrada_manualmente"));
el("finishCampaignBtn").addEventListener("click", () => setCampaignStatus("finalizada"));
el("deleteCampaignBtn").addEventListener("click", deleteSelectedCampaign);
el("addProductBtn").addEventListener("click", addProduct);
el("orderSearch").addEventListener("input", renderOrders);
el("orderFilter").addEventListener("change", renderOrders);

setupDefaultDates();
ensureSession();
