const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWebhookManager } = require("../lib/webhooks");

test("webhook manager dispatches newly approved establishments", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "g8-webhooks-"));
  const storePath = path.join(tmpDir, "webhooks.json");
  let approved = [
    {
      id: "ec_1",
      status: "approved",
      approved: true,
    },
  ];
  const requests = [];
  const uuidFactory = () => {
    let counter = 0;
    return () => `uuid-${++counter}`;
  };

  const manager = createWebhookManager({
    storePath,
    pollEnabled: false,
    uuid: uuidFactory(),
    agentsClient: {
      listApprovedEstablishments: async () => approved,
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => "ok",
      };
    },
  });

  const subscription = manager.createSubscription({
    callbackUrl: "https://cliente.example/webhooks/g8",
    name: "Cliente Teste",
  });

  await manager.syncApprovedEstablishments();
  assert.equal(requests.length, 0);

  approved = [
    ...approved,
    {
      id: "ec_2",
      status: "approved",
      approved: true,
    },
  ];

  await manager.syncApprovedEstablishments();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://cliente.example/webhooks/g8");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.authorization, `Bearer ${subscription.token}`);

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.event, "establishment.approved");
  assert.equal(body.establishment.id, "ec_2");

  const deliveries = manager.listDeliveries();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ok, true);
});
