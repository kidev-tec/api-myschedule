# SPEC — Finanças F5: checkout com Asaas (subcontas)

Data: 2026-11-27 · Autor: Ezequias + Claude · Estado: **APROVADA (Ezequias, 2026-11-27)** — C1–C6 aprovadas; **F5-01 BLOQUEADA** (conta sandbox é PF — ver §8)
Branch: `feat/financas-checkout` (api e apk), sobre a F4.
Prestador escolhido: **Asaas, subcontas** (Ezequias, 2026-11-27).

## 0. Objetivo

O profissional gera, pelo app, uma **cobrança** (link com Pix, cartão ou boleto) para o cliente de um agendamento. O cliente paga e o pagamento **entra sozinho** no livro-caixa como recebimento (sinal ou quitação), sem lançamento manual. O dinheiro cai **na conta Asaas do próprio profissional** (subconta), não na conta do Agenva.

## 1. O que a documentação do Asaas diz (pesquisa de 2026-11-27)

| Ponto | Fato | Fonte |
|---|---|---|
| Quem cria subconta | Só conta **PJ (CNPJ)**. A conta do Agenva/KidevTec precisa ser PJ. | docs/criacao-de-subcontas |
| Criar | `POST /v3/accounts` (name, email, cpfCnpj, incomeValue (obrigatório), companyType, phone/mobilePhone, endereço; birthDate p/ PF). Aceita `webhooks` na criação. | docs/criacao-de-subcontas |
| Resposta | `apiKey` da subconta + `walletId`. **A apiKey só aparece na criação e não pode ser recuperada** (dá para gerar outra por `/v3/accounts/{id}/accessTokens`, com IP em whitelist). | docs/gerenciamento-de-chaves-de-api-de-subcontas |
| Aprovação (KYC) | Titular recebe e-mail, cria senha e envia documentos/selfie pela interface do Asaas (não-BaaS). Status: `GET /v3/myAccount/status` (`general = APPROVED`); evento `ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED`. | docs/detalhamento-do-fluxo-de-aprovacao-de-subcontas |
| Período de avaliação | Até 10 subcontas, até R$ 2.000 em cobranças por subconta, 60 dias; depois bloqueia até a avaliação do Asaas terminar. | docs/criacao-de-subcontas |
| Cobrança | Feita **com a apiKey da subconta**; "clientes e cobranças pertencem à própria subconta". Payload traz `invoiceUrl` (link de pagamento). | docs/criacao-de-subcontas, docs/webhook-para-cobrancas |
| Webhooks | Header `asaas-access-token`; eventos `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED`, `PAYMENT_REFUNDED`…; entrega "at least once" (exige idempotência). | docs/sobre-os-webhooks, docs/webhook-para-cobrancas |
| Taxas | Pode haver taxa de criação de subconta (valor no painel: Configurações › Taxas); taxas por transação não documentadas nas páginas lidas. | docs/criacao-de-subcontas |
| Sandbox | Até 20 subcontas/dia; e-mails das subcontas vão para a conta raiz. | docs/criacao-de-subcontas |

**Não verificado (páginas de referência não carregaram) — confirmar no sandbox antes de codar:** lista completa de campos obrigatórios de `POST /v3/accounts`; campos de `POST /v3/payments` (`billingType: UNDEFINED` para o cliente escolher), endpoint do QR Pix; se a subconta cobra antes de aprovada; como registrar webhook depois da criação.

## 2. Arquitetura proposta

**Cobrança com a apiKey da subconta** (não split pela conta-mãe):
- o dinheiro e as taxas ficam na conta do profissional; o Agenva não intermedia valores (sem risco fiscal/regulatório de "facilitador");
- o cliente vê o profissional como recebedor;
- o split exigiria cobrar na conta do Agenva e repassar — descartado.

Fluxo:
1. **Ativar recebimento online** (app → API): profissional informa CPF/CNPJ, data de nascimento (PF), renda/faturamento mensal, celular e endereço → API cria a subconta com webhook apontando para `/webhooks/asaas/subaccounts` → guarda `asaas_account_id`, `wallet_id` e a **apiKey criptografada** (AES-256-GCM, mesmo padrão de `domain/token-crypto.ts`, chave própria `ASAAS_SUBACCOUNT_ENC_KEY`).
2. **Aprovação:** status `pending` até o webhook `ACCOUNT_STATUS_GENERAL_APPROVAL_*` (ou consulta a `GET /v3/myAccount/status` com a chave da subconta). O app mostra "Complete seu cadastro no Asaas (e-mail enviado)".
3. **Cobrar** (agendamento com saldo): API cria/acha o cliente na subconta e a cobrança do valor (padrão = saldo), vencimento, `externalReference = appointment_id` → devolve `invoiceUrl`; app compartilha o link (WhatsApp).
4. **Pagou:** webhook `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` → lança recebimento (`payment_method` conforme o `billingType`, `kind` sinal/pagamento pela regra da F1) **uma única vez** (idempotência por `asaas_payment_id` único). Estorno no Asaas (`PAYMENT_REFUNDED`) → estorna o lançamento. Cancelada/vencida → atualiza a cobrança.

## 3. Dados (migration 0031)
- `businesses`: `asaas_sub_account_id`, `asaas_sub_wallet_id`, `asaas_sub_api_key_enc`, `asaas_sub_status` (`none|pending|approved|rejected`), `asaas_sub_updated_at`.
- `charges`: `id`, `business_id`, `appointment_id`, `asaas_payment_id` (único), `amount_cents`, `status` (`pending|paid|overdue|canceled|refunded`), `invoice_url`, `due_date`, `transaction_id` (lançamento gerado), timestamps. RLS ENABLE+FORCE.
- `transactions.asaas_payment_id` único (idempotência do webhook).

## 4. Fases de entrega
| # | Task | Repo |
|---|---|---|
| F5-01 | Validar no **sandbox** os pontos "não verificados" (script manual, sem código de produção) e registrar nesta SPEC | api |
| F5-02 | Migration 0031 + criptografia da chave + `POST/GET /v1/finance/online-payments/account` (ativar e ver status) | api |
| F5-03 | Webhook das subcontas (status da conta + pagamentos, idempotente) | api |
| F5-04 | `POST /v1/finance/charges` (gerar cobrança), `GET` (listar), `DELETE` (cancelar) | api |
| F5-11 | App: ativar recebimento online (formulário + status) | apk |
| F5-12 | App: "Cobrar pelo link" no bloco Pagamento + compartilhar + situação da cobrança | apk |

## 5. Segurança
- apiKey da subconta **só criptografada**, nunca em log/resposta; chave de cifra em env nova (`ASAAS_SUBACCOUNT_ENC_KEY`, obrigatória quando o recurso estiver ligado).
- Webhook valida `asaas-access-token` (constant-time) com token próprio das subcontas; sempre 200 em evento desconhecido (sem loop de retry), como o webhook atual.
- Dados pessoais do profissional (CPF, renda, endereço) só repassados ao Asaas; não guardar renda.
- Recurso atrás de flag (`ASAAS_SUBACCOUNTS_ENABLED`) até a homologação.

## 6. Riscos
- **KYC e período de avaliação** do Asaas (limites de 10 subcontas / R$ 2.000 / 60 dias) — limita o piloto.
- **Taxa de criação de subconta** — custo por profissional que ativar.
- Mudança de contrato com o Asaas é externa a nós: tudo isolado em `services/asaas-subaccounts.ts`.

## 7. Decisões (aprovadas em 2026-11-27)
| # | Pergunta | Decisão |
|---|---|---|
| C1 | A conta Asaas do Agenva/KidevTec é **PJ** e pode criar subcontas (e é a mesma `ASAAS_API_KEY` da assinatura)? | Confirmar no painel; usar a mesma conta. |
| C2 | Quem paga a **taxa de criação** da subconta? | Agenva absorve no piloto. |
| C3 | Formas oferecidas no link | Cliente escolhe (Pix, cartão, boleto) — `billingType: UNDEFINED`, se confirmado no sandbox. |
| C4 | Recurso liberado para todos ou piloto? | Piloto com flag, poucas contas, dentro do período de avaliação. |
| C5 | Cobrança só de agendamento ou também avulsa? | Só de agendamento na F5 (avulsa depois). |
| C6 | Valor da cobrança | Padrão = saldo; profissional pode cobrar só o sinal (valor menor). |

## 8. Resultado da validação no sandbox (F5-01, 2026-11-27)

Script em scratchpad (fora do repo), chaves nunca impressas; `ASAAS_BASE_URL` = `api-sandbox.asaas.com`.

| Verificação | Resultado |
|---|---|
| Conta raiz do sandbox (`GET /v3/myAccount/commercialInfo`) | `personType: FISICA` (CPF), `general: APPROVED`; 0 subcontas. |
| `POST /v3/accounts` com corpo vazio | 400 — obrigatórios informados: **CPF/CNPJ, nome, data de nascimento** (os demais não aparecem como obrigatórios nesta validação). |
| `POST /v3/accounts` com dados fictícios | **403 — "Contas de pessoa física (CPF) não podem criar subcontas no Asaas. Apenas contas de pessoa jurídica (CNPJ) podem acessar essa funcionalidade."** |

**Bloqueio (C1):** a conta do `.env` é PF. Para seguir é preciso uma **conta sandbox PJ (CNPJ)** — criada pelo Ezequias no Asaas (cadastro e documentos são do titular) — e a chave dela no `.env` (ex.: `ASAAS_SUBACCOUNTS_API_KEY`, separada da chave da assinatura, ou trocando a conta do `.env`). Em produção vale o mesmo: a conta do Agenva precisa ser a conta **empresarial (CNPJ)**.

Pendentes para quando houver a conta PJ: cobrança `UNDEFINED` com a chave da subconta, `invoiceUrl`, `pixQrCode`, webhook registrado pela chave da subconta, cobrança antes da aprovação.

## 9. Detalhe das tasks (implementação com Asaas simulado nos testes; validar no sandbox PJ depois)

**Configuração (env, recurso desligado sem elas):**
`ASAAS_SUBACCOUNTS_ENABLED=1` · `ASAAS_SUBACCOUNTS_API_KEY` (conta PJ raiz) · `ASAAS_SUBACCOUNT_ENC_KEY` (cifra das chaves) · `ASAAS_SUBACCOUNT_WEBHOOK_TOKEN` (header `asaas-access-token`) · `ASAAS_SUBACCOUNT_WEBHOOK_URL` (URL pública da API, ex. `https://api-agenva.kidev.tec.br`). Sem qualquer uma → rotas respondem 503 "Recebimento online ainda não está disponível".

**F5-02 — conta (migration 0031, cifra, serviço, ativação)**
- `businesses`: `asaas_sub_account_id`, `asaas_sub_wallet_id`, `asaas_sub_api_key_enc`, `asaas_sub_status` (`none|pending|approved|rejected`, padrão `none`), `asaas_sub_updated_at`.
- `charges` (RLS) e `transactions.asaas_payment_id` (único parcial) — ver §3.
- `domain/token-crypto.ts`: cifra genérica por segredo (`encryptWith`/`decryptWith`), sem fallback em texto puro para as chaves das subcontas.
- `services/asaas-subaccounts.ts`: única porta para o Asaas (criar subconta com `webhooks` apontando para `/webhooks/asaas/subaccounts/<business_id>`, status, cliente, cobrança `UNDEFINED`, cancelar).
- `GET /v1/finance/online/account` → `{ available, status }` (se `pending`, consulta `GET /v3/myAccount/status` da subconta e atualiza).
- `POST /v1/finance/online/account` → cria a subconta (uma por negócio; já existe → 409). Body: `cpf_cnpj`, `birth_date` (CPF), `company_type` (CNPJ), `mobile_phone`, `income_cents`, `postal_code`, `address`, `address_number`, `complement?`, `province`. Renda não é guardada.

**F5-03 — webhook `/webhooks/asaas/subaccounts/:businessId`** (público, token constant-time, sempre 200):
- `ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED|REJECTED|PENDING` → `asaas_sub_status`.
- `PAYMENT_CONFIRMED|PAYMENT_RECEIVED` → lança o recebimento **uma vez** (`asaas_payment_id` único), forma pelo `billingType` (PIX→pix, CREDIT_CARD→credit com parcelas, BOLETO/outros→other), sinal/pagamento pela regra da F1, cobrança `paid`.
- `PAYMENT_OVERDUE` → `overdue`; `PAYMENT_DELETED` → `canceled`; `PAYMENT_REFUNDED` → `refunded` + estorno do lançamento.

**F5-04 — cobranças**
- `POST /v1/finance/charges` `{ appointment_id, amount_cents?, due_date? }`: subconta `approved` (senão 409); valor padrão = saldo − cobranças pendentes; nunca acima disso (422); cliente sem CPF → 422 "Cadastre o CPF do cliente para cobrar online"; vencimento padrão = dia do atendimento (mín. hoje). Resposta com `invoice_url`.
- `GET /v1/finance/charges?appointment_id=` · `DELETE /v1/finance/charges/:id` (cancela no Asaas; só `pending`).

**F5-11/12 — app:** card "Recebimento online" em Finanças (ativar: formulário; status pendente/aprovado/recusado) e botão "Cobrar pelo link" no bloco Pagamento (valor, compartilhar link, situação da cobrança, cancelar).
