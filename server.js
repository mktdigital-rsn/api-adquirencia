const http = require("node:http");
const crypto = require("node:crypto");

const {
  createRouter,
  jsonResponse,
  createApiError,
  parseAllowedApiKeyHashes,
  requireApiKey,
} = require("./lib/server-utils");
const { fetchEstablishments, fetchEstablishmentById } = require("./lib/agents-api");
const { normalizeEstablishment, isApprovedEstablishment } = require("./lib/normalize");

const config = {
  port: Number(process.env.PORT || 3000),
  agentsBaseUrl: process.env.AGENTS_API_BASE_URL || "https://agentes-api.bancog8dev.workers.dev",
  apiKeyHashes: parseAllowedApiKeyHashes(process.env.API_KEY_HASHES),
  agentsTimeoutMs: Number(process.env.AGENTS_API_TIMEOUT_MS || 10000),
  maxListPages: Number(process.env.AGENTS_API_MAX_PAGES || 20),
};

function buildApp() {
  const router = createRouter();

  router.get("/health", async () =>
    jsonResponse(200, {
      ok: true,
      service: "api-adquirencia",
      timestamp: new Date().toISOString(),
    })
  );

  router.get("/api/establishments", requireApiKey(config.apiKeyHashes, async () => {
    const result = await fetchEstablishments({
      baseUrl: config.agentsBaseUrl,
      timeoutMs: config.agentsTimeoutMs,
      maxPages: config.maxListPages,
    });

    const items = result.items
      .map(normalizeEstablishment)
      .filter(isApprovedEstablishment);

    return jsonResponse(200, {
      data: items,
      meta: {
        total: items.length,
        source: "agents-api",
        filtered: "approved-only",
      },
    });
  }));

  router.get("/api/establishments/:id", requireApiKey(config.apiKeyHashes, async ({ params }) => {
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
  }));

  return router;
}

const router = buildApp();

const server = http.createServer(async (req, res) => {
  try {
    const result = await router.handle(req);
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch (error) {
    const apiError = error && error.statusCode ? error : createApiError(500, "Erro interno ao processar a requisicao.");
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
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`API de adquirencia rodando na porta ${config.port}`);
  });
}

module.exports = { buildApp, server, config };
