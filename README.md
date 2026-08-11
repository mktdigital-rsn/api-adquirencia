# API de Adquirência G8

Esta API tem como objetivo disponibilizar, de forma segura e padronizada, os dados dos estabelecimentos comerciais cadastrados no sistema G8 para integrações com parceiros e aplicações internas.

## Objetivo

Permitir a consulta de informações cadastrais e operacionais dos estabelecimentos, como:

- razão social
- nome fantasia
- CNPJ
- endereço
- cidade/estado
- status cadastral
- dados de contato

## Visão Geral

A API de adquirência do G8 fornece endpoints para:

- listar estabelecimentos cadastrados
- consultar detalhes de um estabelecimento específico
- filtrar resultados por critérios básicos

## O que esta versão faz

- autentica por chave de acesso via header
- consulta a API de agentes sem banco de dados local
- retorna apenas E.C. aprovados para a adquirência
- envia webhooks quando identifica novos E.C. aprovados
- expõe `GET /health`, `GET /api/establishments` e `GET /api/establishments/:id`
- expõe `GET /docs` e `GET /openapi.json` com Swagger

## Autenticação

A implementação usa uma chave de acesso simples e stateless:

- o cliente envia `x-api-key: SUA_CHAVE`
- o servidor compara o `sha256` da chave com os hashes permitidos em `API_KEY_HASHES`

Isso evita banco de dados e permite rotação fácil da credencial.

### Como isso funciona na prática

Não existe login de usuário nem senha tradicional.
O acesso é liberado somente para quem tiver a chave de acesso correta.

- você gera uma chave privada para o cliente
- você guarda apenas o hash dessa chave no servidor
- o cliente envia a chave em cada requisição
- se a chave bater, a API responde
- se não bater, a API bloqueia

### Quais são as credenciais

As credenciais são:

- `x-api-key`: chave secreta que você entrega para o cliente
- `API_KEY_HASHES`: hash SHA-256 dessa chave, configurado no servidor

Exemplo:

- chave entregue ao cliente: `g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d`
- hash salvo no servidor: `7a6a80f60613f5df771a25de3fa1a02828786903af529bddb35941c7b470b583`

Você nunca precisa colocar a chave secreta dentro do código ou no Git.
Só o hash fica configurado no servidor.

### Bloco pronto para copiar

Se você for repassar para o cliente, pode usar este texto:

```text
Credenciais de acesso da API de Adquirência G8

Endpoint base:
https://api-adquirencia.bancog8.com.br

Credencial:
- Header obrigatório: x-api-key
- Valor: g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d

Endpoints disponíveis:
- GET /health
- GET /api/establishments
- GET /api/establishments/:id

Exemplo de chamada:
curl -X GET "https://api-adquirencia.bancog8.com.br/api/establishments" \
  -H "x-api-key: g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d"

Observações:
- Sem a chave correta, os endpoints de negócio retornam 401 ou 403.
- A chave deve ser enviada em todas as requisições.
- O endpoint /health é público e serve apenas para checagem de status.
```

### Como chamar os endpoints

O cliente precisa enviar a chave em todas as requisições.

Exemplo com `curl`:

```bash
curl -X GET "https://api-adquirencia.bancog8.com.br/api/establishments" \
  -H "x-api-key: g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d"
```

Exemplo para um E.C. específico:

```bash
curl -X GET "https://api-adquirencia.bancog8.com.br/api/establishments/ec_123" \
  -H "x-api-key: g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d"
```

Você também pode usar:

```bash
Authorization: Bearer SUA_CHAVE
```

Mas o padrão recomendado é `x-api-key`.

### O que acontece se a chave estiver errada

- sem chave: resposta `401 Unauthorized`
- chave inválida: resposta `403 Forbidden`
- chave ausente no servidor: resposta `500`, porque a API não foi configurada corretamente

### Então vai funcionar só se tiver credencial?

Sim.

Os endpoints de negócio:

- `GET /api/establishments`
- `GET /api/establishments/:id`

só funcionam com uma chave válida.

O único endpoint público é:

- `GET /health`

Esse serve só para checagem de status da aplicação.

## Webhooks

Além das consultas, a API pode avisar automaticamente quando um novo E.C. for aprovado.

### Fluxo

1. o cliente cadastra a URL do webhook
2. a API gera um `webhookToken` em formato UUID
3. quando um novo E.C. aprovado é identificado, a adquirência envia `POST` para a URL cadastrada
4. o cliente valida o token e a assinatura da requisição

### O que o cliente recebe

Cada webhook enviado leva estes headers:

- `Authorization: Bearer <webhookToken>`
- `X-G8-Webhook-Id`
- `X-G8-Webhook-Event`
- `X-G8-Webhook-Subscription-Id`
- `X-G8-Webhook-Signature`
- `X-G8-Webhook-Timestamp`

O body traz o evento completo do estabelecimento aprovado.

### Criar uma assinatura de webhook

```bash
curl -X POST "https://api-adquirencia.bancog8.com.br/api/webhooks/subscriptions" \
  -H "x-api-key: g8_adquirencia_671ba4b7a4062bf1252155a7d6c8ea56325e0356648433e1ad263ec986cba98d" \
  -H "Content-Type: application/json" \
  -d '{
    "callbackUrl": "https://cliente.com/webhooks/g8",
    "name": "Cliente Exemplo",
    "description": "Webhook de aprovacao de E.C."
  }'
```

### Resposta da criação

Na criação, a API devolve o `webhookToken` apenas uma vez.

```json
{
  "data": {
    "id": "uuid-da-assinatura",
    "callbackUrl": "https://cliente.com/webhooks/g8",
    "name": "Cliente Exemplo",
    "description": "Webhook de aprovacao de E.C.",
    "enabled": true,
    "webhookToken": "uuid-do-cliente",
    "webhookTokenType": "Bearer"
  }
}
```

### Como o cliente valida

O cliente deve verificar:

- se `Authorization` contém o UUID recebido
- se `X-G8-Webhook-Signature` confere com o body recebido

### Exemplo de payload enviado ao cliente

```json
{
  "id": "uuid-da-entrega",
  "event": "establishment.approved",
  "source": "poller",
  "timestamp": "2026-08-11T12:00:00.000Z",
  "subscriptionId": "uuid-da-assinatura",
  "establishment": {
    "id": "ec_123",
    "approved": true,
    "status": "approved"
  }
}
```

### Auditoria

Também é possível consultar:

- `GET /api/webhooks/subscriptions`
- `GET /api/webhooks/subscriptions/:id`
- `DELETE /api/webhooks/subscriptions/:id`
- `GET /api/webhooks/deliveries`
- `GET /api/webhooks/deliveries/:id`

## Exemplo de produção

Segue um exemplo de arquivo `.env` para produção.

```env
PORT=3000
AGENTS_API_BASE_URL=https://agentes-api.bancog8dev.workers.dev
AGENTS_API_TIMEOUT_MS=10000
AGENTS_API_MAX_PAGES=20
WEBHOOK_STORE_PATH=.data/webhooks.json
WEBHOOK_POLL_INTERVAL_MS=60000
WEBHOOK_POLL_ENABLED=true
WEBHOOK_PUBLIC_BASE_URL=https://api-adquirencia.bancog8.com.br
INTERNAL_WEBHOOK_SECRET=
API_KEY_HASHES=coloque_aqui_o_sha256_da_chave
```

Fluxo recomendado:

1. gere a chave secreta com `node scripts/generate-api-key.js`
2. entregue a chave ao cliente por canal seguro
3. salve apenas o hash em `API_KEY_HASHES`
4. configure a URL pública da sua API em `https://api-adquirencia.bancog8.com.br`
5. se a API de agentes for chamar o endpoint interno, configure `INTERNAL_WEBHOOK_SECRET`

Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars`. O Wrangler carrega esse arquivo como bindings do Worker. Em produção, configure as mesmas variáveis no Cloudflare; `API_KEY_HASHES` deve ser cadastrado como secret (`wrangler secret put API_KEY_HASHES`).

## Variáveis de ambiente

Crie um arquivo `.env` com base em `.env.example`.

- `API_KEY_HASHES`: lista de hashes SHA-256 separados por vírgula
- `AGENTS_API_BASE_URL`: URL base da API de agentes
- `AGENTS_API_TIMEOUT_MS`: tempo limite da chamada ao upstream
- `AGENTS_API_MAX_PAGES`: limite de páginas ao buscar a lista completa
- `WEBHOOK_STORE_PATH`: arquivo local que guarda assinaturas e entregas
- `WEBHOOK_POLL_INTERVAL_MS`: intervalo de varredura para detectar novos aprovados
- `WEBHOOK_POLL_ENABLED`: habilita ou desabilita o monitoramento automático
- `WEBHOOK_PUBLIC_BASE_URL`: URL pública usada nos links do Swagger
- `INTERNAL_WEBHOOK_SECRET`: segredo opcional para integrações internas com a API de agentes

## Gerar credenciais

Para gerar uma chave e o hash correspondente:

```bash
node scripts/generate-api-key.js
```

O cliente usa a chave em texto puro no header `x-api-key`.
O servidor guarda apenas o hash.

## Endpoints

### `GET /api/establishments`

Lista todos os estabelecimentos comerciais aprovados, independente do agente.

### `GET /api/establishments/:id`

Retorna um estabelecimento específico, desde que ele esteja aprovado.

Se o estabelecimento existir mas não estiver aprovado, a API responde com `404`.

## Swagger

A documentação interativa está em:

- `GET /docs`
- `GET /openapi.json`

O Swagger mostra:

- rotas de consulta
- rotas de webhook
- headers de autenticação
- modelos principais de request e response

## Formato de resposta

A API devolve os campos principais do `establishments` em formato direto, por exemplo:

```json
{
  "data": {
    "id": "ec_123",
    "agentId": "agent_001",
    "tipoEstabelecimento": "loja",
    "cnpjCpf": "12.345.678/0001-99",
    "razaoSocial": "Mercado Central LTDA",
    "tipoEmpresa": "LTDA",
    "nomeFantasia": "Mercado Central",
    "contatoPrincipal": "Joao",
    "dataFundacao": "2024-01-01",
    "horarioFuncionamento": "08:00 as 18:00",
    "site": null,
    "shopping": "Nao",
    "descricaoShopping": null,
    "mcc": "5411",
    "cnae": "4711301",
    "faturamentoMensal": "100000",
    "ticketMedio": "80",
    "antecipacaoRecebiveis": "sim",
    "cep": "40000000",
    "rua": "Rua A",
    "numero": "100",
    "complemento": null,
    "bairro": "Centro",
    "cidade": "Salvador",
    "state": "BA",
    "quantidade": "1",
    "contactsJson": { "email": "contato@exemplo.com" },
    "bankAccountsJson": [{ "bank": "Banco X" }],
    "status": "approved",
    "observations": null,
    "createdAt": "2026-08-01 10:00:00",
    "updatedAt": "2026-08-02 10:00:00",
    "approved": true
  }
}
```

## Rodando localmente

```bash
npm test
npm run typecheck
npm run dev
```

O Worker usa `PORT` somente para o servidor local. Por padrão, `npm run dev` inicia na porta `3000`.

## Deploy

```bash
npm run deploy
```

Antes do primeiro deploy, configure as variáveis no Cloudflare. O endpoint `API_KEY_HASHES` é obrigatório e deve ser definido como secret.
