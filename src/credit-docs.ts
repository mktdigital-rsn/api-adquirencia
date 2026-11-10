export function renderCreditDocs() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>G8 · Integração de leads de crédito</title>
<style>
:root{font-family:system-ui,sans-serif;color:#152738;background:#f4f7fa;line-height:1.65}body{margin:0}main{max-width:980px;margin:auto;padding:48px 24px 80px}header{margin-bottom:38px}.tag{color:#176850;font-weight:700;letter-spacing:.08em;font-size:13px}h1{font-size:clamp(28px,5vw,44px);line-height:1.2;margin:12px 0}h2{margin-top:0;font-size:23px}h3{font-size:18px}section{background:#fff;border:1px solid #dce4eb;border-radius:16px;padding:26px;margin:22px 0}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.step{padding:18px;background:#eaf5f0;border-radius:12px}.step b{display:block;color:#176850}pre{background:#102d3d;color:#e6f2f7;padding:20px;border-radius:10px;overflow-x:auto;line-height:1.5}code{font-family:ui-monospace,monospace;font-size:13px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #e2e9ee;vertical-align:top}.table{overflow-x:auto}.note{border-left:4px solid #188564;padding:12px 16px;background:#eff8f4}a{color:#176850}footer{font-size:14px;color:#536a79}@media(max-width:700px){main{padding:26px 16px}.flow{grid-template-columns:1fr 1fr}section{padding:20px}}
</style></head><body><main>
<header><span class="tag">G8 · GUIA DE INTEGRAÇÃO</span><h1>Leads de crédito disponíveis para sua integração</h1><p>Entenda como uma solicitação chega à API e como seu backend consulta os registros com acesso autorizado.</p></header>
<div class="flow" aria-label="Fluxo de integração">
<div class="step"><b>1 · Solicitação</b>A pessoa solicita uma carta de crédito no sistema de origem.</div>
<div class="step"><b>2 · Webhook</b>O sistema de origem envia o evento para a G8, de forma assíncrona.</div>
<div class="step"><b>3 · Persistência</b>A G8 valida e grava o evento e o lead antes de confirmar.</div>
<div class="step"><b>4 · Consulta</b>Seu backend consulta a API com uma credencial de leitura.</div>
</div>
<p class="note">Esta API recebe o webhook do sistema de origem. O cliente consulta os leads por GET; não há notificação automática desta API para um webhook do cliente. O snapshot representa a criação, sem atualização posterior de aprovação.</p>
<section><h2>Prefere visualizar no navegador?</h2><p>Abra o <a href="/leads/credit">painel de leads de crédito</a>, informe sua credencial de leitura e acompanhe os cinco dados de contato em uma tela com atualização automática a cada cinco segundos, enquanto a aba está visível. A chave não é salva no navegador. A busca considera a página atual; as permissões são as mesmas da API.</p></section>
<section><h2>Conectar seu backend</h2><p>Base de produção, após publicação: <code>https://api-adquirencia.bancog8.com.br</code>. Para desenvolvimento local: <code>http://localhost:8000</code>.</p><p>A equipe G8 entrega um <code>client_id</code> e uma API key por canal seguro, com escopo <code>read</code> e as origens autorizadas. Envie ambos os headers em todas as consultas:</p>
<pre><code>X-Client-Id: &lt;client_id fornecido pela G8&gt;
X-API-Key: &lt;segredo fornecido pela G8&gt;</code></pre>
<p>Guarde a chave somente no backend. Não há login, token Bearer ou emissão pública de credenciais. A chave do emissor, com escopo <code>ingest</code>, não permite leitura.</p></section>
<section><h2>Listar solicitações</h2><h3><code>GET /api/credit-leads</code></h3>
<pre><code>curl --get 'https://api-adquirencia.bancog8.com.br/api/credit-leads' \\
  -H "X-Client-Id: $READER_CLIENT_ID" \\
  -H "X-API-Key: $READER_KEY" \\
  --data-urlencode 'origem=PUBLICA' \\
  --data-urlencode 'page=1' \\
  --data-urlencode 'page_size=50'</code></pre>
<p><code>READER_CLIENT_ID</code> e <code>READER_KEY</code> são variáveis do terminal com as credenciais fornecidas pela G8.</p>
<pre><code>{
  "items": [{
    "name": "Pessoa de exemplo",
    "taxNumber": "00000000000",
    "email": "pessoa@example.com",
    "phoneNumber": "71999999999",
    "birthDate": "1990-05-20"
  }],
  "page": 1,
  "pageSize": 50,
  "total": 1
}</code></pre>
<p>HTTP 200. Sem resultados: <code>items: []</code> e <code>total: 0</code>. A lista e a contagem respeitam as origens autorizadas para a credencial.</p>
<div class="table"><table><thead><tr><th>Filtro opcional</th><th>Valores / regra</th></tr></thead><tbody>
<tr><td><code>page</code></td><td>1 a 1000000; padrão 1.</td></tr><tr><td><code>page_size</code></td><td>1 a 100; padrão 50.</td></tr>
<tr><td><code>origem</code></td><td>PUBLICA, AGENTE ou IB.</td></tr><tr><td><code>status</code></td><td>PENDENTE.</td></tr>
<tr><td><code>producer</code></td><td>Até 100 caracteres; produtor atual bankwhitelabel-server.</td></tr><tr><td><code>lead_id</code></td><td>Até 128 caracteres; string.</td></tr>
<tr><td><code>created_from</code> / <code>created_to</code></td><td>Datas de criação com timezone, limites inclusivos. Ex.: 2026-11-09T12:00:00-03:00. Aceitam até nove casas decimais.</td></tr>
</tbody></table></div><p>Filtros combinam com AND. O intervalo não pode ser invertido. Use <code>--data-urlencode</code> para codificar offsets. Ordenação por criação decrescente com desempate interno; novas inserções podem deslocar páginas.</p></section>
<section><h2>Consultar uma solicitação</h2><h3><code>GET /api/credit-leads/{leadId}</code></h3>
<pre><code>curl 'https://api-adquirencia.bancog8.com.br/api/credit-leads/123' \\
  -H "X-Client-Id: $READER_CLIENT_ID" \\
  -H "X-API-Key: $READER_KEY"</code></pre>
<p>Retorna diretamente o objeto do lead mostrado na listagem. O parâmetro opcional <code>producer</code> assume <code>bankwhitelabel-server</code>. Retorna 404 se o registro não existir ou estiver fora das permissões.</p>
<p>A rota individual exige um <code>leadId</code> já conhecido no sistema de origem; esse identificador não aparece na listagem.</p>
<p>Os objetos retornados contêm exatamente <code>name</code>, <code>email</code>, <code>phoneNumber</code>, <code>birthDate</code> e <code>taxNumber</code>. Nome, e-mail, telefone e CPF/documento são strings ou null. A data de nascimento usa <code>YYYY-MM-DD</code> ou null. Nenhum outro campo do snapshot é exposto. A listagem mantém os metadados de paginação fora de <code>items</code>.</p>
<p>Eventos antigos sem data de nascimento retornam <code>birthDate: null</code>. O emissor precisa incluir <code>data.birthDate</code> nos novos eventos para que a data real seja disponibilizada.</p></section>
<section><h2>Buscar novos leads</h2><p>Consulte periodicamente em intervalo acordado com a G8. Fixe o fim do intervalo e percorra todas as páginas. Os itens não expõem uma chave de solicitação; CPF, e-mail e telefone não garantem a identidade única de um lead.</p><p>Sobreponha janelas e reconcilie períodos anteriores: os filtros de data usam a criação no emissor, não o recebimento. Entregas atrasadas podem trazer leads antigos. Não há cursor, filtro por recebimento ou marcação de leitura por cliente. Esta listagem não é uma fila de consumo com confirmação por registro.</p></section>
<section><h2>Webhook de entrada</h2><h3><code>POST /webhooks/credit-leads</code> · exclusivo do produtor</h3><p>Usa credencial <code>ingest</code>. O cliente leitor não precisa chamar esta rota. O envelope contém <code>eventId</code> UUID, <code>eventType=credit.lead.created</code>, <code>schemaVersion=1</code> inteiro, <code>occurredAt</code> com timezone, <code>producer=bankwhitelabel-server</code> e <code>data</code> com o snapshot do lead sem producer e <code>birthDate</code> opcional em <code>YYYY-MM-DD</code> ou null.</p><p>Limite de 64 KiB. Campos adicionais são rejeitados; opcionais omitidos viram null. O sucesso confirma a gravação de evento e lead na mesma transação.</p>
<pre><code>201 · {"eventId":"&lt;UUID&gt;","duplicate":false}
200 · {"eventId":"&lt;UUID&gt;","duplicate":true}</code></pre><p>Um reenvio idêntico não duplica o lead. Mesmo evento com conteúdo diferente, ou outro evento para o mesmo lead, retorna 409.</p></section>
<section><h2>Respostas e suporte</h2><div class="table"><table><thead><tr><th>HTTP</th><th>Significado</th></tr></thead><tbody>
<tr><td>401</td><td>Credencial ausente ou inválida: confira os dois headers.</td></tr><tr><td>403</td><td>Sem escopo; na ingestão, também produtor/origem sem autorização.</td></tr><tr><td>404</td><td>Lead inexistente ou fora das permissões.</td></tr><tr><td>409</td><td>Conflito de identidade na ingestão.</td></tr><tr><td>413</td><td>Ingestão acima de 64 KiB.</td></tr><tr><td>422</td><td>Contrato, JSON ou parâmetros inválidos.</td></tr><tr><td>503</td><td>Armazenamento/configuração indisponível. Respeite Retry-After: 10.</td></tr>
</tbody></table></div><p>Erros usam <code>{"detail":"mensagem"}</code>. Respostas não devem ser armazenadas em cache.</p><p><code>GET /health/live</code> confirma processo vivo; <code>GET /health/ready</code> verifica prontidão. São públicos e não retornam leads.</p><p>Para suporte, informe rota, horário com timezone, código HTTP e identificador da solicitação quando disponível. Não envie chaves nem payloads pessoais em logs.</p></section>
<footer>Documentação exclusiva da integração de leads de crédito · G8</footer>
</main></body></html>`
}
