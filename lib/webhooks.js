const crypto = require("node:crypto");
const { FileStore, ensureDir } = require("./file-store");
const { createApiError } = require("./server-utils");

function defaultState() {
  return {
    subscriptions: [],
    deliveries: [],
    lastApprovedIds: [],
    initialized: false,
    lastPollAt: null,
  };
}

function normalizeCallbackUrl(callbackUrl) {
  if (typeof callbackUrl !== "string" || !callbackUrl.trim()) {
    throw createApiError(400, "callbackUrl e obrigatorio.");
  }

  let parsed;
  try {
    parsed = new URL(callbackUrl.trim());
  } catch (error) {
    throw createApiError(400, "callbackUrl invalida.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw createApiError(400, "callbackUrl deve usar http ou https.");
  }

  return parsed.toString();
}

function createWebhookManager({
  storePath,
  fetchImpl = fetch,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  publicBaseUrl = null,
  pollIntervalMs = 60000,
  pollEnabled = true,
  agentsClient,
  internalWebhookSecret = null,
} = {}) {
  ensureDir(require("node:path").dirname(storePath));
  const store = new FileStore(storePath, defaultState());
  let pollTimer = null;
  let runningPoll = false;

  function loadState() {
    const state = store.load();
    return {
      ...defaultState(),
      ...state,
      subscriptions: Array.isArray(state.subscriptions) ? state.subscriptions : [],
      deliveries: Array.isArray(state.deliveries) ? state.deliveries : [],
      lastApprovedIds: Array.isArray(state.lastApprovedIds) ? state.lastApprovedIds : [],
    };
  }

  function saveState(nextState) {
    store.save({
      ...defaultState(),
      ...nextState,
    });
  }

  function createSubscription({ callbackUrl, name = null, description = null }) {
    const state = loadState();
    const subscription = {
      id: uuid(),
      token: uuid(),
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      callbackUrl: normalizeCallbackUrl(callbackUrl),
      enabled: true,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      lastDeliveryAt: null,
      lastStatus: null,
    };

    state.subscriptions.push(subscription);
    saveState(state);

    return subscription;
  }

  function listSubscriptions() {
    return loadState().subscriptions;
  }

  function getSubscription(id) {
    return loadState().subscriptions.find((item) => item.id === id) || null;
  }

  function disableSubscription(id) {
    const state = loadState();
    const subscription = state.subscriptions.find((item) => item.id === id);
    if (!subscription) {
      throw createApiError(404, "Assinatura nao encontrada.");
    }

    subscription.enabled = false;
    subscription.updatedAt = now().toISOString();
    saveState(state);
    return subscription;
  }

  function listDeliveries() {
    return loadState().deliveries;
  }

  function getDelivery(id) {
    return loadState().deliveries.find((item) => item.id === id) || null;
  }

  function recordDelivery(delivery) {
    const state = loadState();
    state.deliveries.unshift(delivery);
    state.deliveries = state.deliveries.slice(0, 500);
    saveState(state);
    return delivery;
  }

  async function sendWebhook(subscription, establishment, eventName, source = "poller") {
    const deliveryId = uuid();
    const timestamp = now().toISOString();
    const payload = {
      id: deliveryId,
      event: eventName,
      source,
      timestamp,
      subscriptionId: subscription.id,
      establishment,
    };

    const body = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", subscription.token).update(body).digest("hex");
    const response = await fetchImpl(subscription.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${subscription.token}`,
        "x-g8-webhook-id": deliveryId,
        "x-g8-webhook-event": eventName,
        "x-g8-webhook-subscription-id": subscription.id,
        "x-g8-webhook-signature": `sha256=${signature}`,
        "x-g8-webhook-timestamp": timestamp,
      },
      body,
    });

    const responseText = await response.text();
    const delivery = {
      id: deliveryId,
      subscriptionId: subscription.id,
      callbackUrl: subscription.callbackUrl,
      event: eventName,
      source,
      statusCode: response.status,
      ok: response.ok,
      responseBody: responseText.slice(0, 2000),
      responseHeaders:
        response && response.headers && typeof response.headers.entries === "function"
          ? Object.fromEntries(response.headers.entries())
          : {},
      requestBody: payload,
      createdAt: timestamp,
    };

    recordDelivery(delivery);

    const state = loadState();
    const target = state.subscriptions.find((item) => item.id === subscription.id);
    if (target) {
      target.lastDeliveryAt = timestamp;
      target.lastStatus = response.ok ? "delivered" : "failed";
      target.updatedAt = timestamp;
      saveState(state);
    }

    return delivery;
  }

  async function dispatchApprovedEstablishment(establishment, source = "poller") {
    const state = loadState();
    const activeSubscriptions = state.subscriptions.filter((subscription) => subscription.enabled);
    const deliveries = [];

    for (const subscription of activeSubscriptions) {
      try {
        deliveries.push(await sendWebhook(subscription, establishment, "establishment.approved", source));
      } catch (error) {
        const timestamp = now().toISOString();
        recordDelivery({
          id: uuid(),
          subscriptionId: subscription.id,
          callbackUrl: subscription.callbackUrl,
          event: "establishment.approved",
          source,
          statusCode: 0,
          ok: false,
          responseBody: error.message,
          responseHeaders: {},
          requestBody: {
            establishment,
          },
          createdAt: timestamp,
        });

        const state = loadState();
        const target = state.subscriptions.find((item) => item.id === subscription.id);
        if (target) {
          target.lastDeliveryAt = timestamp;
          target.lastStatus = "failed";
          target.updatedAt = timestamp;
          saveState(state);
        }
      }
    }

    return deliveries;
  }

  async function syncApprovedEstablishments({ source = "poller" } = {}) {
    const state = loadState();
    const approved = await agentsClient.listApprovedEstablishments();
    const approvedById = new Map(approved.map((item) => [item.id, item]));

    if (!state.initialized) {
      state.initialized = true;
      state.lastApprovedIds = Array.from(approvedById.keys());
      state.lastPollAt = now().toISOString();
      saveState(state);
      return {
        newApprovals: [],
        totalApproved: approvedById.size,
      };
    }

    const previousIds = new Set(state.lastApprovedIds);
    const newApprovals = approved.filter((item) => item.id && !previousIds.has(item.id));

    for (const establishment of newApprovals) {
      await dispatchApprovedEstablishment(establishment, source);
    }

    const nextState = loadState();
    nextState.lastApprovedIds = Array.from(approvedById.keys());
    nextState.lastPollAt = now().toISOString();
    saveState(nextState);

    return {
      newApprovals,
      totalApproved: approvedById.size,
    };
  }

  async function processIncomingApprovalEvent(establishment, source = "incoming") {
    if (!establishment || typeof establishment !== "object") {
      throw createApiError(400, "Estabelecimento invalido.");
    }

    if (establishment.approved !== true && establishment.status !== "approved" && establishment.status !== "aprovado") {
      throw createApiError(400, "O evento precisa representar um estabelecimento aprovado.");
    }

    await dispatchApprovedEstablishment(establishment, source);

    const state = loadState();
    if (establishment.id && !state.lastApprovedIds.includes(establishment.id)) {
      state.lastApprovedIds.push(establishment.id);
      state.lastPollAt = now().toISOString();
      state.initialized = true;
      saveState(state);
    }

    return { ok: true };
  }

  function validateInternalSecret(req) {
    if (!internalWebhookSecret) {
      throw createApiError(503, "Webhook interno nao configurado.");
    }

    const provided = req.headers["x-internal-webhook-secret"];
    if (typeof provided !== "string" || provided !== internalWebhookSecret) {
      throw createApiError(401, "Webhook interno nao autorizado.");
    }
  }

  async function handleInternalApprovedEvent(req, body) {
    validateInternalSecret(req);
    const establishment = body && (body.establishment || body.data || body);
    return processIncomingApprovalEvent(establishment, "internal-webhook");
  }

  function startPolling() {
    if (!pollEnabled || pollTimer) {
      return;
    }

    const tick = async () => {
      if (runningPoll) {
        return;
      }

      runningPoll = true;
      try {
        await syncApprovedEstablishments({ source: "poller" });
      } catch (error) {
        // Intencionalmente silencioso: o servidor continua vivo e tenta no próximo ciclo.
      } finally {
        runningPoll = false;
      }
    };

    tick();
    pollTimer = setInterval(tick, pollIntervalMs);
    if (typeof pollTimer.unref === "function") {
      pollTimer.unref();
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    startPolling,
    stopPolling,
    listSubscriptions,
    getSubscription,
    createSubscription,
    disableSubscription,
    listDeliveries,
    getDelivery,
    syncApprovedEstablishments,
    processIncomingApprovalEvent,
    handleInternalApprovedEvent,
    dispatchApprovedEstablishment,
    sendWebhook,
  };
}

module.exports = {
  createWebhookManager,
  normalizeCallbackUrl,
};
