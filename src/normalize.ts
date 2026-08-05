type RecordValue = Record<string, unknown>

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  try { return value.trim() ? JSON.parse(value) : null } catch { return value }
}

function normalizeStatus(value: unknown): string | null {
  const status = String(value ?? '').trim().toLowerCase()
  return status || null
}

export function isApprovedEstablishment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const source = value as RecordValue
  return source.approved === true || source.isApproved === true || ['approved', 'aprovado'].includes(normalizeStatus(firstDefined(source.status, source.approvalStatus)) ?? '')
}

export function normalizeEstablishment(value: unknown): RecordValue {
  if (!value || typeof value !== 'object') return { id: null, approved: false, raw: value ?? null }
  const source = value as RecordValue
  const contactsJson = parseMaybeJson(source.contactsJson)
  const bankAccountsJson = parseMaybeJson(source.bankAccountsJson)
  const fields: Record<string, string[]> = {
    id: ['id'], agentId: ['agentId', 'agent_id'], tipoEstabelecimento: ['tipoEstabelecimento', 'tipo_estabelecimento'], cnpjCpf: ['cnpjCpf', 'cnpj_cpf'], razaoSocial: ['razaoSocial', 'razao_social'], tipoEmpresa: ['tipoEmpresa', 'tipo_empresa'], nomeFantasia: ['nomeFantasia', 'nome_fantasia'], contatoPrincipal: ['contatoPrincipal', 'contato_principal'], dataFundacao: ['dataFundacao', 'data_fundacao'], horarioFuncionamento: ['horarioFuncionamento', 'horario_funcionamento'], site: ['site'], shopping: ['shopping'], descricaoShopping: ['descricaoShopping', 'descricao_shopping'], mcc: ['mcc'], cnae: ['cnae'], faturamentoMensal: ['faturamentoMensal', 'faturamento_mensal'], ticketMedio: ['ticketMedio', 'ticket_medio'], antecipacaoRecebiveis: ['antecipacaoRecebiveis', 'antecipacao_recebiveis'], cep: ['cep'], rua: ['rua'], numero: ['numero'], complemento: ['complemento'], bairro: ['bairro'], cidade: ['cidade'], state: ['state'], quantidade: ['quantidade'], observations: ['observations'], createdAt: ['createdAt', 'created_at'], updatedAt: ['updatedAt', 'updated_at'],
  }
  const normalized: RecordValue = Object.fromEntries(Object.entries(fields).map(([key, names]) => [key, firstDefined(...names.map((name) => source[name]))]))
  return { ...normalized, contactsJson, bankAccountsJson, contacts: contactsJson, bankAccounts: bankAccountsJson, status: normalizeStatus(source.status), approved: isApprovedEstablishment(source), source, raw: source }
}
