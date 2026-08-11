const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  createRouter,
  jsonResponse,
  createApiError,
  parseAllowedApiKeyHashes,
  requireApiKey,
  readJsonBody,
} = require("./lib/server-utils");
const {
  fetchEstablishments,
  fetchEstablishmentById,
  listApprovedEstablishments,
} = require("./lib/agents-api");
const { normalizeEstablishment, isApprovedEstablishment } = require("./lib/normalize");
const { createWebhookManager } = require("./lib/webhooks");
const { buildOpenApiSpec, renderDocsHtml } = require("./lib/openapi");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));
loadEnvFile(path.join(process.cwd(), ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  agentsBaseUrl: process.env.AGENTS_API_BASE_URL || "https://agentes-api.bancog8dev.workers.dev",
  apiKeyHashes: parseAllowedApiKeyHashes(process.env.API_KEY_HASHES),
  agentsTimeoutMs: Number(process.env.AGENTS_API_TIMEOUT_MS || 10000),
  maxListPages: Number(process.env.AGENTS_API_MAX_PAGES || 20),
  webhookStorePath:
    process.env.WEBHOOK_STORE_PATH || path.join(__dirname, ".data", "webhooks.json"),
  webhookPollIntervalMs: Number(process.env.WEBHOOK_POLL_INTERVAL_MS || 60000),
  webhookPollEnabled: process.env.WEBHOOK_POLL_ENABLED !== "false",
  webhookPublicBaseUrl:
    process.env.WEBHOOK_PUBLIC_BASE_URL || "https://api-adquirencia.bancog8.com.br",
  internalWebhookSecret: process.env.INTERNAL_WEBHOOK_SECRET || null,
};

function presentSubscription(subscription, { includeToken = false } = {}) {
  const payload = {
    id: subscription.id,
    name: subscription.name,
    description: subscription.description,
    callbackUrl: subscription.callbackUrl,
    enabled: subscription.enabled,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    lastDeliveryAt: subscription.lastDeliveryAt,
    lastStatus: subscription.lastStatus,
    webhookTokenPreview: subscription.token
      ? `${subscription.token.slice(0, 8)}...${subscription.token.slice(-6)}`
      : null,
  };

  if (includeToken) {
    payload.webhookToken = subscription.token;
    payload.webhookTokenType = "Bearer";
  }

  return payload;
}

function createWebhookPayload(body) {
  if (!body || typeof body !== "object") {
    throw createApiError(400, "JSON invalido para webhook.");
  }

  if (typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) {
    throw createApiError(400, "callbackUrl e obrigatorio.");
  }

  return {
    callbackUrl: body.callbackUrl,
    name: typeof body.name === "string" ? body.name : null,
    description: typeof body.description === "string" ? body.description : null,
  };
}

const webhookManager = createWebhookManager({
  storePath: config.webhookStorePath,
  pollIntervalMs: config.webhookPollIntervalMs,
  pollEnabled: config.webhookPollEnabled,
  publicBaseUrl: config.webhookPublicBaseUrl,
  internalWebhookSecret: config.internalWebhookSecret,
  agentsClient: {
    listApprovedEstablishments: () =>
      listApprovedEstablishments({
        baseUrl: config.agentsBaseUrl,
        timeoutMs: config.agentsTimeoutMs,
        maxPages: config.maxListPages,
      }),
  },
});

function buildApp() {
  const router = createRouter();

  router.get("/health", async () =>
    jsonResponse(200, {
      ok: true,
      service: "api-adquirencia",
      timestamp: new Date().toISOString(),
    })
  );

  router.get("/openapi.json", async () =>
    jsonResponse(200, buildOpenApiSpec({ baseUrl: config.webhookPublicBaseUrl }))
  );

  router.get("/docs", async () => ({
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body: renderDocsHtml({ specUrl: "/openapi.json" }),
  }));

  router.get(
    "/api/establishments",
    requireApiKey(config.apiKeyHashes, async () => {
      const result = await fetchEstablishments({
        baseUrl: config.agentsBaseUrl,
        timeoutMs: config.agentsTimeoutMs,
        maxPages: config.maxListPages,
      });

      const items = result.items.map(normalizeEstablishment).filter(isApprovedEstablishment);

      return jsonResponse(200, {
        data: items,
        meta: {
          total: items.length,
          source: "agents-api",
          filtered: "approved-only",
        },
      });
    })
  );

  router.get(
    "/api/establishments/:id",
    requireApiKey(config.apiKeyHashes, async ({ params }) => {
      const establishment = await fetchEstablishmentById({
        baseUrl: config.agentsBaseUrl,
        id: params.id,
        timeoutMs: config.agentsTimeoutMs,
      });

      const normalized = normalizeEstablishment(establishment);

      if (!isApprovedEstablishment(normalized)) {
        throw createApiError(404, "Estabelecimento nao encontrado.");
      }

      return jsonResponse(200, {
        data: normalized,
        meta: {
          source: "agents-api",
        },
      });
    })
  );

  router.get(
    "/api/webhooks/subscriptions",
    requireApiKey(config.apiKeyHashes, async () =>
      (() => {
        const subscriptions = webhookManager.listSubscriptions();
        return jsonResponse(200, {
          data: subscriptions.map((subscription) => presentSubscription(subscription)),
          meta: {
            total: subscriptions.length,
          },
        });
      })()
    )
  );

  router.post(
    "/api/webhooks/subscriptions",
    requireApiKey(config.apiKeyHashes, async ({ req }) => {
      const body = await readJsonBody(req);
      const payload = createWebhookPayload(body);
      const subscription = webhookManager.createSubscription(payload);

      return jsonResponse(
        201,
        {
          data: presentSubscription(subscription, { includeToken: true }),
          meta: {
            note: "Guarde o webhookToken com seguranca. Ele e exibido apenas nesta criacao.",
          },
        },
        {
          location: `/api/webhooks/subscriptions/${subscription.id}`,
        }
      );
    })
  );

  router.get(
    "/api/webhooks/subscriptions/:id",
    requireApiKey(config.apiKeyHashes, async ({ params }) => {
      const subscription = webhookManager.getSubscription(params.id);

      if (!subscription) {
        throw createApiError(404, "Assinatura nao encontrada.");
      }

      return jsonResponse(200, {
        data: presentSubscription(subscription),
      });
    })
  );

  router.delete(
    "/api/webhooks/subscriptions/:id",
    requireApiKey(config.apiKeyHashes, async ({ params }) => {
      const subscription = webhookManager.disableSubscription(params.id);

      return jsonResponse(200, {
        data: presentSubscription(subscription),
      });
    })
  );

  router.get(
    "/api/webhooks/deliveries",
    requireApiKey(config.apiKeyHashes, async () =>
      (() => {
        const deliveries = webhookManager.listDeliveries();
        return jsonResponse(200, {
          data: deliveries,
          meta: {
            total: deliveries.length,
          },
        });
      })()
    )
  );

  router.get(
    "/api/webhooks/deliveries/:id",
    requireApiKey(config.apiKeyHashes, async ({ params }) => {
      const delivery = webhookManager.getDelivery(params.id);

      if (!delivery) {
        throw createApiError(404, "Entrega nao encontrada.");
      }

      return jsonResponse(200, {
        data: delivery,
      });
    })
  );

  router.post("/api/webhooks/events/establishment-approved", async ({ req }) => {
    const body = await readJsonBody(req);
    await webhookManager.handleInternalApprovedEvent(req, body);
    return jsonResponse(200, {
      ok: true,
      message: "Evento processado com sucesso.",
    });
  });

  return router;
}

const router = buildApp();

const server = http.createServer(async (req, res) => {
  try {
    const result = await router.handle(req);
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch (error) {
    const apiError =
      error && error.statusCode ? error : createApiError(500, "Erro interno ao processar a requisicao.");
    const payload = {
      error: {
        message: apiError.message,
        statusCode: apiError.statusCode,
        requestId: crypto.randomUUID(),
      },
    };

    res.writeHead(apiError.statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  }
});

if (require.main === module) {
  webhookManager.startPolling();

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`API de adquirencia rodando na porta ${config.port}`);
  });

  const shutdown = () => {
    webhookManager.stopPolling();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { buildApp, server, config, webhookManager, presentSubscription };
