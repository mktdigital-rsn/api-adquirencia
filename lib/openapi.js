function buildOpenApiSpec({ baseUrl }) {
  return {
    openapi: "3.0.3",
    info: {
      title: "API de Adquirencia G8",
      version: "1.1.0",
      description:
        "API para consulta de estabelecimentos aprovados e recebimento de webhooks de aprovacao.",
    },
    servers: [
      {
        url: baseUrl,
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
        WebhookBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "UUID",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                statusCode: { type: "integer" },
                requestId: { type: "string" },
              },
            },
          },
        },
        Establishment: {
          type: "object",
          properties: {
            id: { type: "string" },
            agentId: { type: "string", nullable: true },
            tipoEstabelecimento: { type: "string", nullable: true },
            cnpjCpf: { type: "string", nullable: true },
            razaoSocial: { type: "string", nullable: true },
            tipoEmpresa: { type: "string", nullable: true },
            nomeFantasia: { type: "string", nullable: true },
            contatoPrincipal: { type: "string", nullable: true },
            dataFundacao: { type: "string", nullable: true },
            horarioFuncionamento: { type: "string", nullable: true },
            site: { type: "string", nullable: true },
            shopping: { type: "string", nullable: true },
            descricaoShopping: { type: "string", nullable: true },
            mcc: { type: "string", nullable: true },
            cnae: { type: "string", nullable: true },
            faturamentoMensal: { type: "string", nullable: true },
            ticketMedio: { type: "string", nullable: true },
            antecipacaoRecebiveis: { type: "string", nullable: true },
            cep: { type: "string", nullable: true },
            rua: { type: "string", nullable: true },
            numero: { type: "string", nullable: true },
            complemento: { type: "string", nullable: true },
            bairro: { type: "string", nullable: true },
            cidade: { type: "string", nullable: true },
            state: { type: "string", nullable: true },
            quantidade: { type: "string", nullable: true },
            contactsJson: { nullable: true },
            bankAccountsJson: { nullable: true },
            status: { type: "string", nullable: true },
            observations: { type: "string", nullable: true },
            createdAt: { type: "string", nullable: true },
            updatedAt: { type: "string", nullable: true },
            approved: { type: "boolean" },
          },
        },
        SubscriptionCreateRequest: {
          type: "object",
          required: ["callbackUrl"],
          properties: {
            callbackUrl: { type: "string", example: "https://cliente.com/webhooks/g8" },
            name: { type: "string", nullable: true },
            description: { type: "string", nullable: true },
          },
        },
        Subscription: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string", nullable: true },
            description: { type: "string", nullable: true },
            callbackUrl: { type: "string" },
            enabled: { type: "boolean" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            lastDeliveryAt: { type: "string", nullable: true },
            lastStatus: { type: "string", nullable: true },
          },
        },
        Delivery: {
          type: "object",
          properties: {
            id: { type: "string" },
            subscriptionId: { type: "string" },
            callbackUrl: { type: "string" },
            event: { type: "string" },
            source: { type: "string" },
            statusCode: { type: "integer" },
            ok: { type: "boolean" },
            responseBody: { type: "string" },
            createdAt: { type: "string" },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: {
            200: {
              description: "Service healthy",
            },
          },
        },
      },
      "/api/establishments": {
        get: {
          summary: "Lista estabelecimentos aprovados",
          security: [{ ApiKeyAuth: [] }],
          responses: {
            200: {
              description: "Lista de estabelecimentos aprovados",
            },
            401: { description: "Chave ausente" },
            403: { description: "Chave invalida" },
          },
        },
      },
      "/api/establishments/{id}": {
        get: {
          summary: "Busca um estabelecimento especifico",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Estabelecimento encontrado" },
            404: { description: "Nao encontrado ou nao aprovado" },
          },
        },
      },
      "/api/webhooks/subscriptions": {
        get: {
          summary: "Lista assinaturas de webhook",
          security: [{ ApiKeyAuth: [] }],
          responses: {
            200: { description: "Assinaturas cadastradas" },
          },
        },
        post: {
          summary: "Cria uma assinatura de webhook",
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SubscriptionCreateRequest" },
              },
            },
          },
          responses: {
            201: {
              description: "Assinatura criada",
            },
          },
        },
      },
      "/api/webhooks/subscriptions/{id}": {
        get: {
          summary: "Detalha uma assinatura de webhook",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Assinatura encontrada" },
            404: { description: "Nao encontrada" },
          },
        },
        delete: {
          summary: "Desativa uma assinatura de webhook",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Assinatura desativada" },
            404: { description: "Nao encontrada" },
          },
        },
      },
      "/api/webhooks/deliveries": {
        get: {
          summary: "Lista entregas de webhook",
          security: [{ ApiKeyAuth: [] }],
          responses: {
            200: { description: "Entregas registradas" },
          },
        },
      },
      "/api/webhooks/deliveries/{id}": {
        get: {
          summary: "Detalha uma entrega de webhook",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Entrega encontrada" },
            404: { description: "Nao encontrada" },
          },
        },
      },
      "/api/webhooks/events/establishment-approved": {
        post: {
          summary: "Recebe evento interno de aprovacao",
          description: "Endpoint reservado para integrações internas da API de agentes.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Establishment" },
              },
            },
          },
          responses: {
            200: { description: "Evento processado" },
            401: { description: "Nao autorizado" },
            503: { description: "Webhook interno nao configurado" },
          },
        },
      },
    },
  };
}

function renderDocsHtml({ specUrl }) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f6f8fc" />
    <title>API de Adquirencia G8 - Documentacao</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --panel: rgba(255, 255, 255, 0.92);
        --panel-border: rgba(148, 163, 184, 0.28);
        --text: #0f172a;
        --muted: #475569;
        --accent: #0f766e;
        --accent-soft: rgba(15, 118, 110, 0.12);
        --shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background:
        radial-gradient(circle at top left, rgba(14, 165, 233, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(20, 184, 166, 0.18), transparent 28%),
        linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body { padding: 32px 20px 48px; }
      .topbar { display: none !important; }
      .page {
        max-width: 1320px;
        margin: 0 auto;
      }
      .hero {
        position: relative;
        overflow: hidden;
        border: 1px solid var(--panel-border);
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(15, 118, 110, 0.9));
        color: #fff;
        border-radius: 24px;
        padding: 28px 28px 26px;
        box-shadow: var(--shadow);
        margin-bottom: 20px;
      }
      .hero::after {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top right, rgba(255, 255, 255, 0.24), transparent 30%),
          radial-gradient(circle at bottom left, rgba(34, 211, 238, 0.18), transparent 24%);
        pointer-events: none;
      }
      .hero > * { position: relative; z-index: 1; }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.72);
        margin-bottom: 10px;
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(30px, 4vw, 52px);
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      .hero p {
        max-width: 760px;
        margin: 14px 0 0;
        font-size: 16px;
        line-height: 1.65;
        color: rgba(255, 255, 255, 0.84);
      }
      .hero-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 20px;
      }
      .metric {
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.08);
        border-radius: 16px;
        padding: 14px 16px;
        backdrop-filter: blur(10px);
      }
      .metric .label {
        display: block;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.66);
        margin-bottom: 6px;
      }
      .metric .value {
        display: block;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.4;
      }
      .shell {
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        overflow: hidden;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .shell-header {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        padding: 18px 20px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        background: linear-gradient(180deg, rgba(248, 250, 252, 0.96), rgba(241, 245, 249, 0.85));
      }
      .chip {
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 16px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.85);
      }
      .chip .k {
        display: block;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        margin-bottom: 5px;
      }
      .chip .v {
        display: block;
        font-size: 14px;
        font-weight: 700;
        color: var(--text);
        word-break: break-word;
      }
      .swagger-ui {
        background: transparent !important;
      }
      .swagger-ui .scheme-container,
      .swagger-ui .opblock,
      .swagger-ui .models,
      .swagger-ui .responses-inner,
      .swagger-ui .tab,
      .swagger-ui .parameter__name,
      .swagger-ui .renderedMarkdown,
      .swagger-ui .info,
      .swagger-ui .info .title,
      .swagger-ui .opblock .opblock-summary,
      .swagger-ui .opblock .opblock-summary-description,
      .swagger-ui .opblock .opblock-summary-path,
      .swagger-ui .opblock .opblock-summary-method,
      .swagger-ui .parameter__type,
      .swagger-ui .model,
      .swagger-ui .model-box,
      .swagger-ui .model-box-control,
      .swagger-ui table thead tr th,
      .swagger-ui table tbody tr td,
      .swagger-ui .auth-container,
      .swagger-ui .dialog-ux .modal-ux,
      .swagger-ui textarea,
      .swagger-ui input[type=text],
      .swagger-ui input[type=password],
      .swagger-ui select {
        border-radius: 16px !important;
      }
      .swagger-ui .scheme-container {
        margin: 0 !important;
        padding: 22px 20px 6px !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .swagger-ui .info {
        margin: 0 !important;
        padding: 20px 20px 8px !important;
      }
      .swagger-ui .info .title {
        color: var(--text) !important;
        font-size: 34px !important;
        letter-spacing: -0.03em;
      }
      .swagger-ui .info .description,
      .swagger-ui .opblock-description-wrapper p,
      .swagger-ui .opblock-external-docs-wrapper,
      .swagger-ui .response-col_status,
      .swagger-ui .response-col_description,
      .swagger-ui .parameter__description,
      .swagger-ui .parameter__in,
      .swagger-ui .parameter__type,
      .swagger-ui .opblock-summary-description {
        color: var(--muted) !important;
      }
      .swagger-ui .opblock {
        border-width: 1px !important;
        box-shadow: none !important;
        margin: 12px 0 !important;
      }
      .swagger-ui .opblock.opblock-get {
        border-color: rgba(59, 130, 246, 0.32) !important;
        background: linear-gradient(180deg, #f8fbff 0%, #eef6ff 100%) !important;
      }
      .swagger-ui .opblock.opblock-post {
        border-color: rgba(16, 185, 129, 0.28) !important;
        background: linear-gradient(180deg, #f5fff9 0%, #ecfdf5 100%) !important;
      }
      .swagger-ui .opblock.opblock-delete {
        border-color: rgba(239, 68, 68, 0.28) !important;
        background: linear-gradient(180deg, #fff8f8 0%, #fff1f1 100%) !important;
      }
      .swagger-ui .opblock-summary {
        min-height: 64px !important;
      }
      .swagger-ui .opblock-summary-method {
        border-radius: 12px !important;
        min-width: 72px;
        text-align: center;
        font-weight: 800 !important;
        box-shadow: none !important;
      }
      .swagger-ui .btn.authorize {
        border-radius: 999px !important;
        background: linear-gradient(135deg, #0f766e, #14b8a6) !important;
        color: #fff !important;
        border: none !important;
        box-shadow: 0 10px 24px rgba(15, 118, 110, 0.28);
      }
      .swagger-ui .auth-wrapper {
        padding: 0 20px 8px;
      }
      .swagger-ui .scheme-container .schemes {
        background: transparent !important;
      }
      .swagger-ui .info .title small {
        background: rgba(15, 118, 110, 0.12) !important;
        color: var(--accent) !important;
        border-radius: 999px !important;
        padding: 4px 10px !important;
        font-size: 12px !important;
        vertical-align: middle;
      }
      @media (max-width: 900px) {
        body { padding: 18px 12px 28px; }
        .hero-grid, .shell-header { grid-template-columns: 1fr; }
        .swagger-ui .info .title { font-size: 28px !important; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="eyebrow">G8 Adquirência</div>
        <h1>Documentação da API</h1>
        <p>
          Consulta de estabelecimentos aprovados, gerenciamento de assinaturas de webhook e
          acompanhamento de entregas em tempo real.
        </p>
        <div class="hero-grid">
          <div class="metric">
            <span class="label">Base URL</span>
            <span class="value">https://api-adquirencia.bancog8.com.br</span>
          </div>
          <div class="metric">
            <span class="label">Autenticação</span>
            <span class="value">x-api-key + webhookToken UUID</span>
          </div>
          <div class="metric">
            <span class="label">Entregas</span>
            <span class="value">Webhook para novos E.C. aprovados</span>
          </div>
        </div>
      </section>
      <section class="shell">
        <div class="shell-header">
          <div class="chip">
            <span class="k">Consulta</span>
            <span class="v">/health, /api/establishments</span>
          </div>
          <div class="chip">
            <span class="k">Webhook</span>
            <span class="v">/api/webhooks/subscriptions</span>
          </div>
          <div class="chip">
            <span class="k">Auditoria</span>
            <span class="v">/api/webhooks/deliveries</span>
          </div>
          <div class="chip">
            <span class="k">Docs</span>
            <span class="v">Swagger interativo</span>
          </div>
        </div>
        <div id="swagger-ui"></div>
      </section>
    </main>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayOperationId: false,
        displayRequestDuration: true,
        docExpansion: 'list',
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        filter: true,
        persistAuthorization: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    </script>
  </body>
</html>`;
}

module.exports = {
  buildOpenApiSpec,
  renderDocsHtml,
};
