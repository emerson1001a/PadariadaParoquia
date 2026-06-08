let campaign = null;
let duplicateOrder = null;

const state = { quantities: {} };
const config = window.PADARIA_CONFIG || {};
const db = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

const el = (id) => document.getElementById(id);
const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function dateTime(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function dateOnly(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(value + "T12:00:00"));
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskPhone(value) {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 10) {
    return digits.replace(/^(\d{0,2})(\d{0,4})(\d{0,4}).*/, (_, a, b, c) =>
      [a && `(${a}`, a.length === 2 && ") ", b, c && `-${c}`].filter(Boolean).join("")
    );
  }
  return digits.replace(/^(\d{2})(\d{5})(\d{0,4}).*/, "($1) $2-$3");
}

async function updateClosedCampaigns() {
  await db.rpc("atualizar_campanhas_encerradas");
}

async function loadCampaign() {
  if (!config.supabaseUrl || config.supabaseUrl.includes("COLE_AQUI")) {
    el("loading").classList.add("hidden");
    el("empty").classList.remove("hidden");
    el("empty").innerHTML = "<h2>Configuração pendente</h2><p class='muted'>Informe a URL e a chave pública do Supabase em public/config.js.</p>";
    return;
  }

  await updateClosedCampaigns();

  const { data: campaigns, error } = await db
    .from("campanhas")
    .select("*")
    .in("status", ["aberta", "encerrada_automaticamente"])
    .order("id", { ascending: false })
    .limit(1);

  el("loading").classList.add("hidden");

  if (error || !campaigns || !campaigns.length) {
    el("empty").classList.remove("hidden");
    return;
  }

  const selected = campaigns[0];
  const { data: products, error: productError } = await db
    .from("produtos_campanha_resumo")
    .select("*")
    .eq("campanha_id", selected.id)
    .eq("ativo", true)
    .order("ordem_exibicao", { ascending: true });

  if (productError) {
    el("empty").classList.remove("hidden");
    el("empty").innerHTML = `<h2>Erro ao carregar produtos</h2><p class="muted">${productError.message}</p>`;
    return;
  }

  campaign = {
    id: selected.id,
    title: selected.titulo,
    pickupDate: selected.data_retirada,
    orderDeadline: selected.prazo_final_pedidos,
    customerMessage: selected.mensagem_cliente,
    status: selected.status,
    products: products.map((product) => ({
      id: product.id,
      name: product.nome,
      description: product.descricao,
      unitPrice: Number(product.preco_unitario),
      maxQuantity: product.quantidade_maxima,
      active: product.ativo,
      soldQuantity: product.quantidade_vendida,
      availableQuantity: product.quantidade_disponivel
    }))
  };

  el("app").classList.remove("hidden");
  renderCampaign();
}

function renderCampaign() {
  el("campaignTitle").textContent = campaign.title;
  el("campaignDates").textContent = `Retirada: ${dateOnly(campaign.pickupDate)} • Pedidos até ${dateTime(campaign.orderDeadline)}`;
  el("customerMessage").textContent = campaign.customerMessage || "Pagamento no momento da retirada.";
  el("productCount").textContent = `${campaign.products.length} produtos`;

  if (campaign.status !== "aberta") el("closedMessage").classList.remove("hidden");

  const products = el("products");
  products.innerHTML = "";

  campaign.products.forEach((product) => {
    const soldOut = product.availableQuantity <= 0 || campaign.status !== "aberta";
    const div = document.createElement("div");
    div.className = "product";
    div.innerHTML = `
      <div>
        <div class="row between">
          <strong>${product.name}</strong>
          <span class="pill ${soldOut ? "bad" : product.availableQuantity <= 3 ? "warn" : "good"}">
            ${soldOut ? "Esgotado" : `Restam ${product.availableQuantity}`}
          </span>
        </div>
        <div class="muted">${product.description || "Sem descrição"}</div>
        <div><strong>${money(product.unitPrice)}</strong></div>
        <div class="muted" id="subtotal-${product.id}">Subtotal: R$ 0,00</div>
      </div>
      <div class="qty">
        <label for="qty-${product.id}">Quantidade</label>
        <input id="qty-${product.id}" type="number" min="0" max="${product.availableQuantity}" value="0" ${soldOut ? "disabled" : ""}>
      </div>
    `;
    products.appendChild(div);

    const input = el(`qty-${product.id}`);
    if (input) {
      input.addEventListener("input", () => {
        const value = Math.max(0, Math.min(Number(input.value || 0), product.availableQuantity));
        input.value = value;
        state.quantities[product.id] = value;
        renderSummary();
      });
    }
  });

  renderSummary();
}

function selectedItems() {
  return campaign.products
    .map((product) => ({ product, quantity: Number(state.quantities[product.id] || 0) }))
    .filter((item) => item.quantity > 0);
}

function renderSummary() {
  const items = selectedItems();
  const total = items.reduce((sum, item) => sum + item.quantity * item.product.unitPrice, 0);

  campaign.products.forEach((product) => {
    const subtotal = Number(state.quantities[product.id] || 0) * product.unitPrice;
    const node = el(`subtotal-${product.id}`);
    if (node) node.textContent = `Subtotal: ${money(subtotal)}`;
  });

  el("summary").innerHTML = items.length
    ? items.map((item) => `${item.quantity}x ${item.product.name} - ${money(item.quantity * item.product.unitPrice)}`).join("<br>")
    : "Escolha pelo menos um produto.";
  el("total").textContent = money(total);

  const valid = campaign.status === "aberta" &&
    el("customerName").value.trim() &&
    onlyDigits(el("customerPhone").value).length >= 10 &&
    items.length;

  el("submitOrder").disabled = !valid;
}

function orderRpcPayload(replaceId = null) {
  return {
    p_campanha_id: campaign.id,
    p_nome_cliente: el("customerName").value.trim(),
    p_telefone_cliente: el("customerPhone").value.trim(),
    p_itens: selectedItems().map((item) => ({
      produto_id: item.product.id,
      quantidade: item.quantity
    })),
    p_substituir_pedido_id: replaceId
  };
}

async function getExistingOrder(orderId) {
  const { data } = await db
    .from("pedidos")
    .select("id, numero_pedido, nome_cliente, telefone_cliente, status, valor_total, itens_pedido(nome_produto_snapshot, quantidade, preco_unitario_snapshot, subtotal)")
    .eq("id", orderId)
    .single();
  return data;
}

async function submitOrder(replaceId = null) {
  el("message").innerHTML = "";
  el("duplicateBox").classList.add("hidden");

  const { data, error } = await db.rpc("criar_pedido", orderRpcPayload(replaceId));
  const result = data || {};

  if (error) {
    el("message").innerHTML = `<div class="error">${error.message}</div>`;
    return;
  }

  if (!result.ok && result.code === "pedido_duplicado") {
    duplicateOrder = await getExistingOrder(result.pedido_id);
    renderDuplicate(duplicateOrder);
    return;
  }

  if (!result.ok) {
    el("message").innerHTML = `<div class="error">${result.message || "Não foi possível registrar o pedido."}</div>`;
    await loadCampaignFresh();
    return;
  }

  renderConfirmation(result);
  await loadCampaignFresh(false);
}

function renderDuplicate(order) {
  el("duplicateBox").classList.remove("hidden");
  el("duplicateDetails").innerHTML = `
    <p><strong>Pedido ${order.numero_pedido}</strong><br>
    ${order.itens_pedido.map((item) => `${item.quantidade}x ${item.nome_produto_snapshot}`).join("<br>")}<br>
    Total: ${money(order.valor_total)}</p>
  `;
}

function renderConfirmation(order) {
  const items = selectedItems();
  const text = [
    "Pedido registrado com sucesso.",
    `Número: ${order.numero_pedido}`,
    `Nome: ${el("customerName").value.trim()}`,
    `Telefone: ${el("customerPhone").value.trim()}`,
    `Itens: ${items.map((item) => `${item.quantity}x ${item.product.name}`).join(", ")}`,
    `Total a pagar na retirada: ${money(order.valor_total)}`
  ].join("\n");

  el("confirmation").classList.remove("hidden");
  el("confirmationText").textContent = text;
  el("copyConfirmation").dataset.text = text;
  el("message").innerHTML = "";
}

async function loadCampaignFresh(resetQuantities = true) {
  if (resetQuantities) {
    Object.keys(state.quantities).forEach((key) => delete state.quantities[key]);
  }
  await loadCampaign();
}

el("customerPhone").addEventListener("input", (event) => {
  event.target.value = maskPhone(event.target.value);
  renderSummary();
});
el("customerName").addEventListener("input", renderSummary);
el("submitOrder").addEventListener("click", () => submitOrder());
el("replaceOrder").addEventListener("click", () => {
  if (duplicateOrder) submitOrder(duplicateOrder.id);
});
el("keepOrder").addEventListener("click", () => el("duplicateBox").classList.add("hidden"));
el("copyConfirmation").addEventListener("click", async () => {
  await navigator.clipboard.writeText(el("copyConfirmation").dataset.text || "");
  el("copyConfirmation").textContent = "Copiado";
});
el("newOrder").addEventListener("click", () => window.location.reload());

loadCampaign();
