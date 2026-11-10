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
- consulta a API de agentes e persiste webhooks no Turso
- persiste assinaturas e entregas de webhook no Turso
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
2. a API salva a assinatura no Turso e gera um `webhookToken` em formato UUID
3. um cron do Cloudflare Workers verifica periodicamente a `agentes-api`
4. quando um novo E.C. aprovado é identificado, a adquirência envia `POST` para a URL cadastrada
5. o cliente valida o token e a assinatura da requisição

### O que o cliente recebe

Cada webhook enviado leva estes headers:

- `Authorization: Bearer <webhookToken>`
- `X-G8-Webhook-Id`
- `X-G8-Webhook-Event`
- `X-G8-Webhook-Subscription-Id`
- `X-G8-Webhook-Signature`
- `X-G8-Webhook-Timestamp`

O body traz o evento completo do estabelecimento aprovado.

### Observação importante

- o webhook de aprovação é disparado automaticamente pelo cron do Worker
- a assinatura e o histórico das entregas ficam no Turso
- `INTERNAL_WEBHOOK_SECRET` é opcional e serve só para o endpoint interno de teste
- se `INTERNAL_WEBHOOK_SECRET` ficar vazio em produção, o webhook externo continua funcionando normalmente

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
  "source": "cron",
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
WEBHOOK_POLL_ENABLED=true
WEBHOOK_PUBLIC_BASE_URL=https://api-adquirencia.bancog8.com.br
INTERNAL_WEBHOOK_SECRET=
TURSO_DATABASE_URL=libsql://adquirencia-api-mktdigital-rsn.aws-us-east-1.turso.io
# TURSO_AUTH_TOKEN=coloque_o_token_do_turso_aqui
API_KEY_HASHES=coloque_aqui_o_sha256_da_chave
```

Fluxo recomendado:

1. gere a chave secreta com `node scripts/generate-api-key.js`
2. entregue a chave ao cliente por canal seguro
3. salve apenas o hash em `API_KEY_HASHES`
4. configure a URL pública da sua API em `https://api-adquirencia.bancog8.com.br`
5. configure `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` no ambiente do Worker
6. se a API de agentes for chamar o endpoint interno, configure `INTERNAL_WEBHOOK_SECRET`

Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars`. O Wrangler carrega esse arquivo como bindings do Worker. Em produção, configure as mesmas variáveis no Cloudflare; `API_KEY_HASHES` deve ser cadastrado como secret (`wrangler secret put API_KEY_HASHES`).

### Deploy automático via GitHub Actions

Ao fazer push na branch `main`, o workflow `.github/workflows/deploy.yml` publica a API automaticamente.

Para isso, configure no repositório estes secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Também garanta que as variáveis e secrets do Worker estejam criadas no Cloudflare, incluindo `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN`.

## Variáveis de ambiente

Crie um arquivo `.env` com base em `.env.example`.

- `API_KEY_HASHES`: lista de hashes SHA-256 separados por vírgula
- `AGENTS_API_BASE_URL`: URL base da API de agentes
- `AGENTS_API_TIMEOUT_MS`: tempo limite da chamada ao upstream
- `AGENTS_API_MAX_PAGES`: limite de páginas ao buscar a lista completa
- `WEBHOOK_POLL_ENABLED`: habilita ou desabilita o monitoramento automático
- `WEBHOOK_PUBLIC_BASE_URL`: URL pública usada nos links do Swagger
- `TURSO_DATABASE_URL`: URL do banco libSQL/Turso
- `TURSO_AUTH_TOKEN`: token de acesso ao banco Turso
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

O comando local aceita `--port` explícito, com prioridade sobre `PORT`. O Worker usa `PORT` somente para o servidor local. Por padrão, `npm run dev` inicia na porta `3000`.

## Deploy

```bash
npm run deploy
```

Antes do primeiro deploy, configure as variáveis no Cloudflare. O endpoint `API_KEY_HASHES` é obrigatório e deve ser definido como secret.

## Receptor de solicitações de carta de crédito

O Worker Hono recebe `credit.lead.created` do `bankwhitelabel-server`. Não há alteração no emissor ou nos webhooks de estabelecimentos. Não existe processamento posterior: o sucesso confirma o commit do evento e do snapshot na mesma transação.

Rotas sem prefixo adicional:

- `POST /webhooks/credit-leads`: escopo `ingest`, resposta 201 para criação, 200 para reenvio idêntico, 409 para identidade conflitante.
- `GET /api/credit-leads`: escopo `read`, listagem e total limitados aos produtores e origens da credencial.
- `GET /api/credit-leads/:leadId`: escopo `read`, 404 também para origens sem acesso.
- `GET /health/live`: processo vivo.
- `GET /health/ready`: valida configuração e consulta `credit_events`; 503 se indisponível.

URL de produção, considerando o domínio configurado neste projeto: **https://api-adquirencia.bancog8.com.br/webhooks/credit-leads**. É necessário publicar esta versão e configurar o banco e as credenciais antes de usá-la.

### Banco e configuração

Reutiliza `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` existentes. Não usa PostgreSQL nem `DATABASE_URL`. A migração aditiva `migrations/0001_credit_leads.sql` cria somente `credit_events`, `credit_leads` e índices. JSON é armazenado em TEXT validado por `json_valid`, timestamps em UTC com nove casas decimais permitem filtros e ordenação por instante. As constraints únicas protegem `(producer,event_id)`, `(producer,lead_id)` e a FK única do snapshot. A migração `0002_credit_timestamp_precision.sql` ajusta datas já armazenadas com seis casas para nove, preservando os instantes e os snapshots. A aplicação não executa DDL em requisições.

Os comandos locais exigem Node.js 20.12 ou superior e carregam `.dev.vars`, quando existe, ou `.env`, sem sobrescrever variáveis já exportadas. A geração de chave apenas exibe o segredo/hash: ela não cadastra a credencial automaticamente. Adicione `API_CREDENTIALS_JSON` ao arquivo local, conforme o exemplo abaixo.

Execute a migração antes de iniciar/publicar o receptor:

```bash
# Configure as variáveis em .dev.vars (preferido) ou .env antes de executar.
npm run credit:validate-config
npm run credit:migrate
npm run dev -- --port 8000
```

`credit:migrate` usa transação e é reaplicável. Não existe downgrade destrutivo automático: apagar essas tabelas remove snapshots e deduplicação histórica. Não há importação do receptor Python nem expiração de eventos. Restrinja o acesso ao banco e aos backups, que contêm dados pessoais.

O runtime Workers recebe bindings somente quando é invocado. Por isso a configuração é validada antes de qualquer operação do receptor, e o comando `credit:validate-config` deve integrar a preparação de inicialização/deploy para impedir publicação com configuração inválida. Os endpoints antigos continuam independentes. `/health/live` não exige configuração. Não foi adicionado Docker: este projeto usa Wrangler e Turso; localmente exponha a porta 8000 e não a 8080 usada pelo emissor.

### Emissão, rotação e revogação

```bash
npm run credit:issue-key -- credit-producer
npm run credit:issue-key -- credit-reader
```

O comando offline gera 48 bytes aleatórios em base64url e exibe o segredo uma vez junto de seu SHA-256. Entregue o segredo por canal seguro; cadastre somente o hash. Não existe endpoint de emissão.

`API_CREDENTIALS_JSON` está cadastrado em `vars` do `wrangler.jsonc` com os client IDs, permissões e hashes SHA-256 corretos, sem as chaves em texto. Em desenvolvimento, mantenha o cadastro sincronizado no `.env` ou `.dev.vars` (que pode sobrescrever os bindings). Não cadastre simultaneamente um secret Cloudflare com esse mesmo nome. As chaves originais ficam apenas nos sistemas que fazem as chamadas. Formato para novas credenciais (substitua os placeholders):

```json
[
  {"client_id":"credit-producer","key_sha256":["<hash de 64 caracteres hex minúsculos>"],"scopes":["ingest"],"producers":["bankwhitelabel-server"],"origins":["PUBLICA","AGENTE","IB"]},
  {"client_id":"credit-reader","key_sha256":["<outro hash>"],"scopes":["read"],"producers":["bankwhitelabel-server"],"origins":["PUBLICA"]}
]
```

Ambos os headers `X-Client-Id` e `X-API-Key` são obrigatórios. Não há fallback para `API_KEY_HASHES`, Bearer ou variáveis `CREDIT_LEAD_WEBHOOK_API_KEY`. Credenciais de ingestão não recebem leitura automaticamente. Permissões são por produtor/origem, sem isolamento por agente.

Para rotação, adicione o novo hash à mesma lista `key_sha256`, publique/recrie as instâncias, troque a chave no emissor e remova o hash antigo após a transição. Para revogar, remova o hash ou toda a credencial e atualize as instâncias. Não registre o cadastro nem os headers. Headers duplicados combinados com vírgula são rejeitados; o proxy de entrada deve preservar ou rejeitar duplicatas, nunca escolher silenciosamente um valor.

### Contrato e consultas

As respostas de listagem e consulta individual expõem exclusivamente `name`, `email`, `phoneNumber`, `birthDate` e `taxNumber`, com uma allowlist explícita. Os metadados da paginação permanecem fora dos itens. O evento completo continua armazenado internamente para auditoria e deduplicação; os demais campos não são retornados aos leitores.

O evento aceita `data.birthDate` opcional em `YYYY-MM-DD` ou null, sem timezone (data civil). Eventos antigos sem esse campo continuam válidos e retornam null. A data precisa ser enviada pelo emissor; não é derivada pelo receptor. A inclusão no snapshot JSON não exige migração SQL nem nova variável de ambiente. A consulta individual continua exigindo um leadId conhecido externamente; a listagem não o expõe.

O evento completo está em `examples/credit-lead.json`. Campos adicionais são rejeitados e opcionais omitidos viram null. `amount` permanece string decimal positiva sem perda de precisão. `userId` exige inteiro seguro de JavaScript (`±9007199254740991`); o emissor deve respeitar esse intervalo. UUIDs são normalizados para minúsculas e timestamps para UTC. Datas exigem timezone e aceitam até nove casas decimais de segundo; precisão maior é rejeitada. Valores monetários textualmente diferentes, como `5000` e `5000.00`, são snapshots diferentes.

A listagem aceita `page` (1–1000000), `page_size` (1–100, padrão 50), `origem`, `status=PENDENTE`, `producer`, `lead_id`, `created_from` e `created_to`. Filtros combinam com AND; datas são inclusivas e filtram a criação no emissor. Ordenação por criação e id interno decrescentes. O total recebe as mesmas permissões. Paginação por offset: inserções novas podem deslocar páginas. A consulta individual aceita `producer`, padrão `bankwhitelabel-server`.

```bash
curl -i http://localhost:8000/webhooks/credit-leads \
  -H 'Content-Type: application/json' \
  -H "X-Client-Id: $CREDIT_LEAD_WEBHOOK_CLIENT_ID" \
  -H "X-API-Key: $CREDIT_LEAD_WEBHOOK_API_KEY" \
  --data-binary @examples/credit-lead.json

curl -s 'http://localhost:8000/api/credit-leads?origem=PUBLICA&page_size=10' \
  -H "X-Client-Id: $READER_CLIENT_ID" -H "X-API-Key: $READER_KEY"

curl -s http://localhost:8000/api/credit-leads/123 \
  -H "X-Client-Id: $READER_CLIENT_ID" -H "X-API-Key: $READER_KEY"
```

Primeiro POST: 201, `duplicate=false`; segundo: 200, `duplicate=true`. O client_id e hash cadastrados devem corresponder aos headers. Emissor em Docker Desktop no Mac: `http://host.docker.internal:8000/webhooks/credit-leads`; a permissão de HTTP local deve ser configurada no emissor. Produção usa HTTPS.

Para validar ponta a ponta, configure destino e credencial no emissor, crie uma solicitação na porta 8080, aguarde o worker de entrega e consulte o lead neste receptor. A criação no emissor pode retornar antes da entrega. Reenvie o mesmo evento para verificar a deduplicação.

### Falhas, limites e operação

Respostas: 401 credencial inválida; 403 permissão insuficiente; 404 lead ausente/sem acesso; 409 conflito; 413 corpo acima de 65536 bytes inclusive streaming; 422 JSON/contrato/filtros inválidos; 503 armazenamento indisponível com `Retry-After: 10`. Respostas de validação não incluem valores recebidos. Todas essas rotas aplicam `Cache-Control: no-store` e `X-Content-Type-Options: nosniff`.

Logs estruturados contêm resultados `event_stored`, `event_duplicate`, `database_unavailable`, status HTTP e latência, sem payload, query string ou dados pessoais. O único identificador registrado é o UUID validado. Monitore 401, 403, 409, 422, 503 e latência a partir de `credit_request`; configure também o provedor/proxy para não registrar headers nem filtros de consulta. Indicadores SQL estão em `examples/credit-indicators.sql`; eventos sem lead devem ser zero.

`npm test` usa bancos libSQL reais em arquivos temporários exclusivos, sem tocar no Turso configurado. Inclui conexões independentes concorrentes, constraints, rollback, falha simulada de commit, persistência entre instâncias, permissões, rotação e validação. O teste de commit injeta a falha antes do commit; falhas de rede com resultado indeterminado são recuperadas por reenvio idempotente. Não foi executado teste contra um Turso remoto ou o emissor real.


### Documentação para o cliente leitor

A tela pública `/docs/credit-leads` explica somente o fluxo e as rotas de leads de crédito, com autenticação, filtros e exemplos. O guia compartilhável está em `docs/credit-leads.md`. Não contém credenciais reais nem rotas de outros produtos.

O webhook de entrada alimenta a API; o cliente consulta por GET. Não há entrega automática para webhook do cliente neste escopo. A chave do emissor continua exclusiva de ingestão.

Para habilitar um cliente leitor:

1. Execute `npm run credit:issue-key -- <identificador-exclusivo-do-cliente>`.
2. Adicione uma entrada ao array JSON de `vars.API_CREDENTIALS_JSON` no `wrangler.jsonc`, preservando as entradas existentes: `client_id` emitido, `key_sha256` com somente o hash, `scopes: ["read"]`, `producers: ["bankwhitelabel-server"]` e `origins` com as origens autorizadas para esse cliente. Não conceda origens sem definir o acesso do parceiro.
3. Sincronize o array no arquivo local usado (`.env` ou `.dev.vars`). Reinicie o Worker local; em produção publique a atualização. Não remova a credencial do produtor.
4. Entregue somente client ID, segredo e origens autorizadas ao cliente por canal seguro, junto da URL `/docs/credit-leads`.
5. Teste uma listagem e uma consulta individual com a credencial do cliente. Confirme que POST retorna 403 para essa credencial e que origens não autorizadas não aparecem.

A única variável nova introduzida pelo receptor é `API_CREDENTIALS_JSON`; banco e token Turso já existiam. Variáveis `CREDIT_LEAD_WEBHOOK_*` de destino, retry, lease e timezone são exclusivas do emissor e não são necessárias neste Worker. O cadastro atual ainda não emite nem habilita uma credencial real de cliente leitor automaticamente.

### Painel visual de leads

`GET /leads/credit` serve a tela de acompanhamento no mesmo Worker. Abra `http://localhost:8000/leads/credit` no desenvolvimento ou `https://api-adquirencia.bancog8.com.br/leads/credit` após publicar. A página pede client ID e API key com escopo `read` e utiliza a mesma API autenticada; o HTML público não contém leads nem credenciais.

A chave é mantida somente em memória na aba, enviada nos dois headers das chamadas à mesma origem e descartada ao sair/recarregar. Não usa localStorage, sessionStorage, cookies ou credenciais embutidas. A tela só mostra nome, e-mail, telefone, nascimento e CPF/documento. Dados ausentes aparecem como “Não informado”. As permissões do cadastro continuam sendo aplicadas pelo backend.

A listagem é consultada a cada cinco segundos enquanto a aba está visível, sem requisições sobrepostas. Um aumento no total gera um aviso; os contatos que entram na página recebem destaque temporário. Como a API não expõe IDs nem uma sequência de recebimento, o destaque compara os cinco campos com suas multiplicidades e não representa uma identidade garantida de evento. Os dados seguem a ordenação por criação da API: um evento atrasado pode aparecer em uma página anterior, não necessariamente no topo. Em páginas posteriores há um atalho para voltar ao início quando o total aumenta.

A busca considera somente os contatos da página carregada; a paginação consulta o banco normalmente. A tela pausa as consultas quando a aba fica oculta, retoma ao voltar, informa quando os dados estão desatualizados e respeita `Retry-After` em 503/429. Credenciais inválidas ou sem leitura encerram o acesso, sem expor dados anteriores. O botão Sair remove os contatos da tela e encerra a atualização.

Não é necessário cadastrar outro webhook, configurar nova variável ou executar migração para usar o painel. O fluxo é: emissor envia → receptor persiste → próxima consulta da tela exibe os dados autorizados. Não há conexão direta do navegador com o emissor nem alterações na entrega dos eventos.
