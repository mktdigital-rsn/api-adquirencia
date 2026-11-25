# Prompt para implementar no bankwhitelabel-server

Implemente os eventos abaixo no emissor Java, preservando rotas, frontends, criação de leads e a outbox existente. Leia as instruções do repositório. Não altere o receptor Hono; seu contrato está definido aqui. Não publique nem envie mensagens reais em testes.

## Negócio e cadências

- `credit.lead.created` permanece como está. Não recriar eventos históricos.
- `credit.lead.approved`: emitir uma vez quando o crédito for efetivamente habilitado/aprovado para avançar, no ponto de negócio que a interface chama de aprovação da CCB. Inspecione o fluxo real: o enum atual NÃO tem CCB_APROVADA. Não invente esse status, não confunda score consultado com decisão positiva, nem APROVADA após COMPLETED/DISBURSED do provedor com aprovação inicial. Identifique e documente o método/transição real; teste decisão positiva, negativa e repetição. A Sailer move a oportunidade para Aguardando documentos e envia nova_abertura. O emissor só informa o evento.
- Documentos: o marco é o envio bem-sucedido do e-mail pelo admin com o link para o lead enviar documentos. Segundo esclarecimento do negócio, o primeiro `credit.lead.documents.overdue` representa esse aviso inicial; o segundo é elegível 48h após a persistência do primeiro aviso, caso a pendência permaneça. Não contar a partir da criação do lead nem de um retry HTTP. `requestedAt` é o instante do primeiro aviso desse ciclo; `dueAt` é requestedAt + thresholdHours: 0 para lembrete 1, 48 para lembrete 2.
- Assinatura: considerar a transição efetiva para CCB_ENVIADA e o envio da CCB por e-mail para assinatura. NÃO disparar lembrete imediatamente; o último esclarecimento foi 24h sem assinatura. Lembrete 1 é elegível 24h após esse marco. O intervalo até o segundo NÃO foi confirmado: implementar configuração explícita, propondo 24h adicionais (total 48h), documentando essa hipótese e a possibilidade de ajustar sem alterar código. Só dois lembretes por ciclo. `requestedAt` é o instante de CCB enviada; `thresholdHours` e `dueAt` refletem o vencimento de cada lembrete.
- Não modificar o formato dos telefones. Incluir o telefone atual, preenchido, em todos os eventos novos. Não inventar dados ausentes.
- Documento recebido significa documento enviado via fluxo de e-mail definido pelo negócio, não obrigatoriamente aprovação de KYC/prova de vida. Identificar o registro durável que comprova o recebimento; se o projeto só registra upload de link, não alegar que detecta e-mail sem integração. Documentar a origem real de confirmação. Parar lembretes quando confirmado recebimento.
- Assinatura recebida: parar quando houver confirmação durável de assinatura, pelos caminhos administrativos/provedor existentes. Não usar somente uma comparação de status que permita reabrir cobrança após avanço do fluxo.
- Novo link/CCB cria novo ciclo somente quando houver nova solicitação real; retries de e-mail ou webhook não criam ciclos acidentalmente. Cancelar ciclo antigo ao substituí-lo. Não enviar lembretes de cancelados, rejeitados, revogados, expirados ou resolvidos.

## HTTP, envelope e autenticação

Mesma URL configurada em CREDIT_LEAD_WEBHOOK_URL, mesmo X-Client-Id e X-API-Key. Envelope atual preservado:

```json
{"eventId":"UUID","eventType":"credit.lead.approved","schemaVersion":1,"occurredAt":"ISO-8601 com timezone","producer":"bankwhitelabel-server","data":{}}
```

Data de aprovação (somente estes campos):

```json
{"leadId":"123","origem":"PUBLICA","status":"STATUS_REAL_DO_EMISSOR","name":"Pessoa","taxNumber":"00000000000","email":"teste@example.com","phoneNumber":"71999999999"}
```

Documentos, novos eventos (campos antigos preservados, com telefone, origem e ordinal):

```json
{"leadId":"123","origem":"PUBLICA","collectionLinkId":"7","name":"Pessoa","email":"teste@example.com","taxNumber":"00000000000","phoneNumber":"71999999999","status":"STATUS_REAL","requestedAt":"2026-11-25T12:00:00Z","dueAt":"2026-11-25T12:00:00Z","expiresAt":"2026-12-05T12:00:00Z","thresholdHours":0,"reminderNumber":1,"message":"Coleta de documentos solicitada pelo banco."}
```

Segundo documentos: mesmo collectionLinkId e requestedAt, outro eventId, reminderNumber=2, thresholdHours=48 e dueAt=requestedAt+48h. occurredAt é o instante em que esse segundo evento foi gerado. Se o scheduler acordar atrasado, não redefinir a origem temporal do ciclo.

Assinatura, `credit.lead.signature.overdue`:

```json
{"leadId":"123","origem":"PUBLICA","ccbId":"identificador-estavel-da-ccb","name":"Pessoa","email":"teste@example.com","taxNumber":"00000000000","phoneNumber":"71999999999","status":"CCB_ENVIADA","requestedAt":"2026-11-25T12:00:00Z","dueAt":"2026-11-26T12:00:00Z","thresholdHours":24,"reminderNumber":1,"message":"CCB enviada e ainda não assinada."}
```

Segundo assinatura: mesmo ccbId/requestedAt; eventId novo; reminderNumber=2; thresholdHours=24+intervalo configurado; dueAt coerente. Não enviar URL de assinatura, tokens, documentos, respostas de provedor, selfies ou metadata arbitrária.

Campos comuns: leadId/string <=128, origem PUBLICA|AGENTE|IB, status/string <=50, name/string|null <=500, taxNumber/string|null <=100, email/string|null <=320, phoneNumber/string não vazia <=100. Datas com timezone real; IDs de ciclo string <=128; reminderNumber inteiro 1|2; thresholdHours inteiro; message string <=2000. O receptor aceita o status real, não exige PENDENTE nos novos eventos.

## Cancelamento da fila intermediária

Existe uma segunda fila durável no receptor Hono, entre G8 e Sailer. Parar apenas a outbox Java não cancela um lembrete já recebido pelo Hono mas aguardando retry externo.

Enviar também o evento INTERNO `credit.lead.reminders.resolved`, mesma URL/autenticação, quando o ciclo terminar ou for substituído/cancelado:

```json
{"leadId":"123","origem":"PUBLICA","kind":"documents","referenceId":"7","resolvedAt":"2026-11-25T13:00:00Z","reason":"received","name":"Pessoa","taxNumber":"00000000000","email":"teste@example.com","phoneNumber":"71999999999"}
```

kind=documents|signature; referenceId=collectionLinkId|ccbId; reason=received|signed|cancelled|superseded|expired|rejected. O receptor persiste essa resolução e bloqueia somente as entregas ainda não concluídas do mesmo produtor/lead/tipo/ciclo, inclusive eventos atrasados que cheguem depois da resolução. Esse evento NÃO é enviado para Sailer nem dispara mensagens.

Confirmação de documentos/assinatura e evento de resolução devem compartilhar a transação de estado. Não gerar cancelamento retroativo na inicialização para todos os registros antigos.

Não prometer cancelar HTTP já em andamento ou mensagem que a Sailer já aceitou: essa corrida distribuída depende de cooperação da Sailer. Impedir novos claims/retries após resolução. Documentar o limite.

## Persistência, concorrência e entrega

- Reaproveitar CreditLeadWebhookOutbox, CreditLeadWebhookEvent, CreditLeadWebhookRepository, CreditLeadWebhookWorker, CreditLeadWebhookDeliveryStore, CreditLeadWebhookProperties e scheduler dedicado.
- ColetaDocumentosOverdueWebhook hoje usa 24h, apenas um evento por collectionLinkId e não cancela enfileirados após conclusão: substituir essa regra, não apenas mudar o texto para 48h.
- Outbox possui event_key única; usar chaves lógicas: aprovação por lead; documentos por lead/link/ordinal; assinatura por lead/CCB/ordinal; resolução por lead/kind/ciclo. Cada evento lógico ganha UUID estável.
- Salvar transição/agendamento/outbox na mesma transação. Rollback não deixa evento entregável. Falha ao salvar outbox impede commit parcial.
- Persistir marcos dos ciclos e lembretes. Não depender de updatedAt genérico, memória, @Async ou timer em processo.
- Claim/lock para múltiplas instâncias. Revalidar ciclo imediatamente antes da entrega e cancelar tentativas pendentes/recuperáveis quando resolvido, inclusive depois de restart/lease expirado. Preservar histórico, não apagar entregues.
- Não alterar payload/eventId num retry. Novo lembrete tem novo eventId; retransmissão do mesmo mantém UUID.
- Manter timeout, não seguir redirects, 2xx=aceito; retry rede/408/429/5xx com backoff/Retry-After; erros permanentes para correção operacional.
- Eventos internos de resolução também usam entrega confiável. Falha de telefone não pode ser ocultada; registrar indicador sem telefone/payload em logs e permitir reconciliação operacional.
- Não habilitar emissão retroativa indiscriminada. Agendar apenas ciclos novos ou reconciliados explicitamente.

## Testes e entrega

Testes com relógio controlado: aprovação uma vez e só na transição correta; documentos aviso1 T0 e aviso2 T0+48h (não +24); assinatura T0+24h e segundo no intervalo configurado; nenhuma terceira mensagem; confirmação por e-mail/assinatura antes do vencimento cancela; resolução depois de enfileirar cancela retry; resolução/ciclo substituído cancela lease recuperado; concorrência; restart; rollback; telefone; retries com UUID/payload estáveis; origem PUBLICA/AGENTE/IB; caminhos legados; timestamps convertidos corretamente; evento de resolução consistente.

Entregar código, migrações compatíveis com MariaDB existente, testes executados, documentação de cadência/configuração e curls com dados sintéticos. Não fazer chamadas reais à Sailer em testes. Informar a correspondência entre rótulo de aprovação da interface e transição/método real usado. A migração anterior de event_key tem marcador e lock; seguir a estratégia existente sem alterar migração já aplicada destrutivamente.
