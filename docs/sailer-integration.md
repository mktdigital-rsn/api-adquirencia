# Entrega de leads para a Sailer

## Fluxo

```text
Emissor → POST /webhooks/credit-leads → evento + lead + entrega pendente
                                            ↓ commit
                                  confirmação para o emissor
                                            ↓
                              POST autenticado para a Sailer
                                            ↓
                               entregue / retry / bloqueada
```

O emissor continua usando o mesmo webhook, sem alteração. O receptor mantém GET e painel e passa a enviar os novos leads para a Sailer. A entrega é ao menos uma vez: um timeout ou queda depois de a Sailer aceitar pode causar reenvio do mesmo eventId. Não existe garantia de entrega única na rede.

## Destino e contrato

- URL configurada: `https://api.chatsailer.com/automations/hooks/Cmu7qJTGl-CjsXQ1NF1RnbNwz75828M0`.
- Método: POST, Content-Type: application/json.
- Autenticação: `X-API-Key: <token combinado por canal seguro>`.
- Sem redirecionamentos: o token nunca é encaminhado para uma URL de redirect.
- Somente HTTPS para o host `api.chatsailer.com`, no caminho `/automations/hooks/…`.

Corpo enviado:

```json
{
  "eventId": "dd128744-f7db-4706-bd27-6cae96de3c42",
  "eventType": "credit.lead.created",
  "occurredAt": "2026-11-16T18:00:00.000000000Z",
  "data": {
    "name": "Pessoa de exemplo",
    "taxNumber": "00000000000",
    "email": "pessoa@example.com",
    "phoneNumber": "71999999999"
  }
}
```

Não envia birthDate, leadId, origem, amount, status, userId, agentId, producer ou schemaVersion. O eventId e occurredAt são os do evento original normalizado; não são recriados a cada tentativa. A mesma solicitação não gera outra entrega em um reenvio idêntico do emissor. As origens PUBLICA, IB e AGENTE são encaminhadas quando a integração está habilitada; isso é independente das permissões das credenciais read.

A instrução mais recente do cliente exige telefone com DDD, sem exigir acrescentar DDI. A normalização remove espaços, parênteses e hífens, aceita números brasileiros de 10/11 dígitos e preserva DDI 55 quando fornecido (12/13 dígitos). Não deduz país ou DDD. Ausente/incompleto/inválido: o lead é armazenado normalmente, mas a entrega fica `blocked`, com `invalid_phone`, sem fazer POST. Nome, documento e e-mail seguem os valores recebidos, inclusive null quando ausentes, pois o cliente só declarou telefone obrigatório.

O snapshot de saída é persistido uma vez. Dados pessoais e corpo da resposta do parceiro não são colocados em logs. A restrição de 64 KiB no evento de entrada e os limites dos quatro campos mantêm o corpo de saída abaixo dos 256 KB aceitos pela Sailer.

## Configuração e ativação

Novas variáveis:

```dotenv
SAILER_WEBHOOK_ENABLED=false
SAILER_WEBHOOK_URL=https://api.chatsailer.com/automations/hooks/Cmu7qJTGl-CjsXQ1NF1RnbNwz75828M0
SAILER_WEBHOOK_TOKEN=<token recebido por canal seguro>
```

`SAILER_WEBHOOK_TOKEN` deve estar apenas no `.env`/`.dev.vars` local ignorado pelo Git e como secret do Worker em produção. Não é o token do produtor nem a credencial do reader. O token fornecido já foi colocado no `.env` local, sem habilitar envio.

A integração fica desabilitada no rollout para que migração e secret sejam configurados antes de encaminhar dados reais. Os passos são:

1. Aplicar a migração: `npm run credit:migrate`. Usa TURSO_DATABASE_URL e TURSO_AUTH_TOKEN exportados ou do arquivo local. Em produção, execute contra o banco usado pelo Worker. A migração 0003 cria somente a fila e o controle de ritmo, sem importar leads antigos.
2. Cadastrar o token no secret **SAILER_WEBHOOK_TOKEN** do Worker, pela interface Cloudflare ou `npx wrangler secret put SAILER_WEBHOOK_TOKEN`. Digite o token quando solicitado, sem passá-lo como argumento do shell.
3. Ajustar SAILER_WEBHOOK_ENABLED para true em vars do wrangler.jsonc e no ambiente local que será usado; conferir URL e publicar/reiniciar. `npm run credit:validate-config` valida a configuração local antes de iniciar.
4. Criar um novo lead de teste autorizado e conferir os logs `sailer_delivered` e o recebimento no cliente. Não usar leads antigos para um teste sem acordo explícito.

Não publique uma ativação sem a migração e o secret: configuração inválida ou falha ao persistir a entrega impedem confirmação parcial. Com enabled=false, nenhuma entrega é criada ou disparada; o receptor anterior continua operando. Eventos recebidos enquanto desabilitado não são reenviados retroativamente, nem um retry idêntico desses eventos cria entrega.

## Processamento e tentativas

- A entrega pendente é gravada na mesma transação de evento e lead.
- Depois do commit, o Worker tenta uma entrega em waitUntil, sem prender a resposta ao emissor ao resultado da Sailer. A durabilidade vem da fila no banco, não de waitUntil.
- O cron existente, a cada minuto, busca até 20 entregas pendentes por execução e recupera tentativas interrompidas. Continua funcionando mesmo com WEBHOOK_POLL_ENABLED=false, que controla somente os webhooks de estabelecimentos.
- Claims com token e lease de 120 segundos impedem duas instâncias de processarem normalmente o mesmo registro ao mesmo tempo. Uma tentativa que perde o lease não sobrescreve o resultado de uma tentativa nova. Reenvios ainda podem acontecer após falha/timeout, por isso eventId é preservado.
- Timeout HTTP de 10 segundos; até 10 tentativas. Backoff de 10 segundos até uma hora, respeitando Retry-After em segundos ou data HTTP. O cron pode acrescentar até aproximadamente um minuto à próxima tentativa elegível.
- Um gate persistido compartilhado espaça as reservas de envio em 400 ms (até 150 por minuto), abaixo do limite de 200 por minuto. Respostas 429 pausam também o gate global; 503 com Retry-After faz o mesmo.
- HTTP 2xx confirma entrega. 408, 429, 5xx, timeout e falha de rede são reenviados. 401/403/422, redirects e outros erros não transitórios bloqueiam a entrega para intervenção. 401/403 interrompem o lote atual, preservando os demais pendentes.
- A Sailer deduplica por sete dias. Por segurança, retries automáticos e o comando operacional de reenvio ficam limitados a seis dias desde a primeira tentativa. Depois disso o registro fica failed; reenviar fora dessa janela exige reconciliação com o cliente para evitar disparar outra conversa.

## Acompanhamento e reprocessamento

```bash
npm run sailer:status
```

Mostra contagens por status e os últimos 20 registros com eventId, tentativas, último HTTP e código de erro. Não mostra payloads, nomes, documentos, contatos, URL ou token. Também é possível consultar:

```sql
SELECT status, count(*) AS total FROM sailer_deliveries GROUP BY status;
SELECT last_error_code, count(*) AS total
FROM sailer_deliveries WHERE status IN ('blocked','failed') GROUP BY last_error_code;
```

Depois de corrigir um token inválido ou uma indisponibilidade, uma entrega específica pode ser recolocada na fila:

```bash
npm run sailer:retry -- <eventId-UUID>
```

Esse comando faz somente a alteração no banco. O cron entrega depois. Preserva payload, ID e início da janela de deduplicação; zera o contador operacional de tentativas, não reenvia registros delivered e recusa payload ausente ou janela expirada. A fila não deve ser limpa automaticamente.

`invalid_phone` precisa de correção dos dados na origem e de um procedimento de reconciliação específico; não invente um número nem crie outro eventId para contornar a deduplicação. Não há editor público de payloads ou endpoint de reprocessamento.

## Limites da primeira versão

Sem backfill automático de leads já existentes, sem envio de teste real automático, sem alterações no emissor e sem mudança nos cinco campos disponíveis no GET/painel. A entrega externa tem quatro campos e não inclui nascimento. Apenas um destino Sailer é configurado; mudar a URL passa a valer para todas as entregas pendentes, portanto não use essa variável para alternar clientes diferentes sem reconciliar a fila.
