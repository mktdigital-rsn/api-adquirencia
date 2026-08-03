const crypto = require("node:crypto");

const input = process.argv.slice(2);
const providedKeyIndex = input.indexOf("--key");
const providedKey = providedKeyIndex >= 0 ? input[providedKeyIndex + 1] : null;

const apiKey = providedKey || crypto.randomBytes(32).toString("hex");
const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

// eslint-disable-next-line no-console
console.log(`API key: ${apiKey}`);
// eslint-disable-next-line no-console
console.log(`API key hash: ${apiKeyHash}`);
