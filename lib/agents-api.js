const { createApiError } = require("./server-utils");

function buildUrl(baseUrl, path, searchParams) {
  const url = new URL(path, baseUrl);

  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    const raw = await response.text();
    let body = null;

    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (error) {
        throw createApiError(502, "A API de agentes retornou um payload invalido.", {
          upstreamStatus: response.status,
        });
      }
    }

    if (!response.ok) {
      const upstreamMessage =
        (body && body.message) ||
        (body && body.error && body.error.message) ||
        `Falha ao consultar a API de agentes.`;

      throw createApiError(response.status >= 500 ? 502 : response.status, upstreamMessage, {
        upstreamStatus: response.status,
      });
    }

    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw createApiError(504, "Tempo limite excedido ao consultar a API de agentes.");
    }

    if (error.statusCode) {
      throw error;
    }

    throw createApiError(502, "Nao foi possivel consultar a API de agentes.", {
      cause: error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractListPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      nextToken: null,
      nextTokenParamName: null,
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      items: [],
      nextToken: null,
    };
  }

  const items =
    payload.data ||
    payload.items ||
    payload.establishments ||
    payload.results ||
    payload.records ||
    [];

  const nextToken =
    payload.nextPageToken ||
    payload.nextCursor ||
    payload.cursor ||
    payload.pageToken ||
    null;

  const nextTokenParamName = payload.nextPageToken
    ? "pageToken"
    : payload.nextCursor || payload.cursor
      ? "cursor"
      : payload.pageToken
        ? "pageToken"
        : null;

  return {
    items: Array.isArray(items) ? items : [],
    nextToken,
    nextTokenParamName,
  };
}

async function fetchEstablishments({ baseUrl, timeoutMs, maxPages }) {
  const items = [];
  let pageToken = null;
  let pageTokenParamName = "pageToken";

  for (let page = 0; page < maxPages; page += 1) {
    const searchParams = pageToken ? new URLSearchParams({ [pageTokenParamName]: pageToken }) : null;
    const url = buildUrl(baseUrl, "/api/establishments", searchParams);
    const payload = await fetchJson(url, timeoutMs);
    const pageData = extractListPayload(payload);

    items.push(...pageData.items);

    if (!pageData.nextToken || pageData.nextToken === pageToken) {
      break;
    }

    pageToken = pageData.nextToken;
    pageTokenParamName = pageData.nextTokenParamName || pageTokenParamName;
  }

  return { items };
}

async function fetchEstablishmentById({ baseUrl, id, timeoutMs }) {
  if (!id) {
    throw createApiError(400, "Identificador do estabelecimento ausente.");
  }

  const url = buildUrl(baseUrl, `/api/establishments/${encodeURIComponent(id)}`);
  const payload = await fetchJson(url, timeoutMs);

  if (!payload || typeof payload !== "object") {
    throw createApiError(502, "Resposta invalida da API de agentes.");
  }

  return payload.data || payload.item || payload.establishment || payload;
}

module.exports = {
  fetchEstablishments,
  fetchEstablishmentById,
};
