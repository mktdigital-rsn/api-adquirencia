const crypto = require("node:crypto");

function jsonResponse(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  };
}

function createApiError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function readRequestBody(req, { limitBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(createApiError(413, "Corpo da requisicao muito grande."));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      reject(createApiError(400, "Nao foi possivel ler o corpo da requisicao.", { cause: error.message }));
    });
  });
}

async function readJsonBody(req, options) {
  const raw = await readRequestBody(req, options);
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw createApiError(400, "JSON invalido no corpo da requisicao.");
  }
}

function parseAllowedApiKeyHashes(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function timingSafeHexEqual(a, b) {
  const aBuffer = Buffer.from(a, "hex");
  const bBuffer = Buffer.from(b, "hex");

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function readApiKeyFromRequest(req) {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token || null;
  }

  return null;
}

function requireApiKey(allowedHashes, handler) {
  return async (context) => {
    const apiKey = readApiKeyFromRequest(context.req);

    if (!apiKey) {
      throw createApiError(401, "Chave de acesso ausente.");
    }

    if (!allowedHashes.length) {
      throw createApiError(500, "Chaves de acesso nao configuradas no servidor.");
    }

    const providedHash = sha256Hex(apiKey);
    const isAllowed = allowedHashes.some((hash) => timingSafeHexEqual(providedHash, hash));

    if (!isAllowed) {
      throw createApiError(403, "Chave de acesso invalida.");
    }

    return handler(context);
  };
}

function createRouter() {
  const routes = [];

  function register(method, path, handler) {
    routes.push({ method, path, handler });
  }

  function matchRoute(method, pathname) {
    for (const route of routes) {
      if (route.method !== "*" && route.method !== method) {
        continue;
      }

      if (route.path === "*") {
        return { handler: route.handler, params: {} };
      }

      if (route.path === pathname) {
        return { handler: route.handler, params: {} };
      }

      const routeParts = route.path.split("/").filter(Boolean);
      const pathParts = pathname.split("/").filter(Boolean);

      if (routeParts.length !== pathParts.length) {
        continue;
      }

      const params = {};
      let matched = true;

      for (let i = 0; i < routeParts.length; i += 1) {
        const routePart = routeParts[i];
        const pathPart = pathParts[i];

        if (routePart.startsWith(":")) {
          params[routePart.slice(1)] = decodeURIComponent(pathPart);
          continue;
        }

        if (routePart !== pathPart) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return { handler: route.handler, params };
      }
    }

    return null;
  }

  async function handle(req) {
    const url = new URL(req.url, "http://localhost");
    const method = (req.method || "GET").toUpperCase();
    const route = matchRoute(method, url.pathname);

    if (!route) {
      throw createApiError(404, "Rota nao encontrada.");
    }

    const result = await route.handler({
      req,
      url,
      params: route.params,
    });

    if (!result || typeof result.statusCode !== "number" || typeof result.body !== "string") {
      throw createApiError(500, "Resposta invalida do handler.");
    }

    return result;
  }

  return {
    get(path, handler) {
      register("GET", path, handler);
    },
    post(path, handler) {
      register("POST", path, handler);
    },
    delete(path, handler) {
      register("DELETE", path, handler);
    },
    patch(path, handler) {
      register("PATCH", path, handler);
    },
    all(path, handler) {
      register("*", path, handler);
    },
    handle,
  };
}

module.exports = {
  createRouter,
  jsonResponse,
  createApiError,
  readRequestBody,
  readJsonBody,
  parseAllowedApiKeyHashes,
  requireApiKey,
  readApiKeyFromRequest,
  sha256Hex,
};
