const test = require("node:test");
const assert = require("node:assert/strict");

const { createRouter, jsonResponse, requireApiKey, parseAllowedApiKeyHashes, sha256Hex } = require("../lib/server-utils");
const { normalizeEstablishment, isApprovedEstablishment } = require("../lib/normalize");

test("sha256 helper builds stable hashes", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parses api key hashes", () => {
  assert.deepEqual(parseAllowedApiKeyHashes("a, b , ,c"), ["a", "b", "c"]);
});

test("normalize establishment and approval detection", () => {
  const source = {
    id: 10,
    agentId: "ag_1",
    tipoEstabelecimento: "loja",
    cnpjCpf: "12.345.678/0001-99",
    razaoSocial: "Mercado Central LTDA",
    tipoEmpresa: "LTDA",
    nomeFantasia: "Mercado Central",
    contatoPrincipal: "Joao",
    dataFundacao: "2024-01-01",
    horarioFuncionamento: "08:00 as 18:00",
    shopping: "Nao",
    mcc: "5411",
    cnae: "4711301",
    faturamentoMensal: "100000",
    ticketMedio: "80",
    antecipacaoRecebiveis: "sim",
    cep: "40000000",
    rua: "Rua A",
    numero: "100",
    bairro: "Centro",
    cidade: "Salvador",
    state: "BA",
    quantidade: "1",
    contactsJson: '{"email":"contato@exemplo.com"}',
    bankAccountsJson: '[{"bank":"Banco X"}]',
    status: "aprovado",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-02 10:00:00",
  };

  const normalized = normalizeEstablishment(source);
  assert.equal(normalized.approved, true);
  assert.equal(normalized.nomeFantasia, "Mercado Central");
  assert.deepEqual(normalized.contacts, { email: "contato@exemplo.com" });
  assert.deepEqual(normalized.bankAccounts, [{ bank: "Banco X" }]);
  assert.equal(isApprovedEstablishment(source), true);
});

test("router matches dynamic routes", async () => {
  const router = createRouter();
  router.get("/api/establishments/:id", async ({ params }) =>
    jsonResponse(200, { id: params.id })
  );

  const result = await router.handle({
    method: "GET",
    url: "/api/establishments/123",
    headers: {},
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { id: "123" });
});

test("api key middleware rejects missing keys", async () => {
  const handler = requireApiKey([sha256Hex("secret")], async () => jsonResponse(200, { ok: true }));

  await assert.rejects(
    () =>
      handler({
        req: { headers: {} },
      }),
    (error) => error.statusCode === 401
  );
});
