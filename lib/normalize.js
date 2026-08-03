function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return value;
  }
}

function normalizeStatus(raw) {
  const value = String(firstDefined(raw) || "").trim().toLowerCase();
  return value || null;
}

function isApprovedStatus(value) {
  const status = normalizeStatus(value);

  return status === "approved" || status === "aprovado";
}

function isApprovedEstablishment(establishment) {
  if (!establishment || typeof establishment !== "object") {
    return false;
  }

  if (establishment.approved === true || establishment.isApproved === true) {
    return true;
  }

  return isApprovedStatus(firstDefined(establishment.status, establishment.approvalStatus));
}

function normalizeEstablishment(source) {
  if (!source || typeof source !== "object") {
    return {
      id: null,
      approved: false,
      raw: source ?? null,
    };
  }

  const status = normalizeStatus(source.status);
  const contactsJson = parseMaybeJson(source.contactsJson);
  const bankAccountsJson = parseMaybeJson(source.bankAccountsJson);

  return {
    id: firstDefined(source.id),
    agentId: firstDefined(source.agentId, source.agent_id),
    tipoEstabelecimento: firstDefined(source.tipoEstabelecimento, source.tipo_estabelecimento),
    cnpjCpf: firstDefined(source.cnpjCpf, source.cnpj_cpf),
    razaoSocial: firstDefined(source.razaoSocial, source.razao_social),
    tipoEmpresa: firstDefined(source.tipoEmpresa, source.tipo_empresa),
    nomeFantasia: firstDefined(source.nomeFantasia, source.nome_fantasia),
    contatoPrincipal: firstDefined(source.contatoPrincipal, source.contato_principal),
    dataFundacao: firstDefined(source.dataFundacao, source.data_fundacao),
    horarioFuncionamento: firstDefined(source.horarioFuncionamento, source.horario_funcionamento),
    site: firstDefined(source.site),
    shopping: firstDefined(source.shopping),
    descricaoShopping: firstDefined(source.descricaoShopping, source.descricao_shopping),
    mcc: firstDefined(source.mcc),
    cnae: firstDefined(source.cnae),
    faturamentoMensal: firstDefined(source.faturamentoMensal, source.faturamento_mensal),
    ticketMedio: firstDefined(source.ticketMedio, source.ticket_medio),
    antecipacaoRecebiveis: firstDefined(source.antecipacaoRecebiveis, source.antecipacao_recebiveis),
    cep: firstDefined(source.cep),
    rua: firstDefined(source.rua),
    numero: firstDefined(source.numero),
    complemento: firstDefined(source.complemento),
    bairro: firstDefined(source.bairro),
    cidade: firstDefined(source.cidade),
    state: firstDefined(source.state),
    quantidade: firstDefined(source.quantidade),
    contactsJson,
    bankAccountsJson,
    contacts: contactsJson,
    bankAccounts: bankAccountsJson,
    status,
    observations: firstDefined(source.observations),
    createdAt: firstDefined(source.createdAt, source.created_at),
    updatedAt: firstDefined(source.updatedAt, source.updated_at),
    approved: isApprovedEstablishment(source),
    source,
    raw: source,
  };
}

module.exports = {
  normalizeEstablishment,
  isApprovedEstablishment,
};
