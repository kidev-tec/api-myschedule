# SPEC — Remanejamento de agenda + Confirmação do cliente

**Status:** `[ ] Draft — aguardando aprovação do Ezequias`
**Autor:** Rafael + Hermes (16/09/2026)
**Execution Mode global:** Pre-flight — este documento é a spec; implementação só após aprovação.

---

## Contexto (o que JÁ existe — não reimplementar)

| Capacidade | Estado | Onde |
|---|---|---|
| Remarcar agendamento (PATCH com startsAt/endsAt + conflito) | ✅ backend pronto | api `PATCH /appointments/:id` |
| Remarcar na UI (wizard com cliente+serviço pré-preenchidos) | ✅ pronto | app menu "Remarcar" |
| Cancelar com aviso WhatsApp (wa.me, msg pronta) | ✅ pronto | app `_notifyCancelOnWhatsapp` |
| .ics + Google Calendar na confirmação do cliente | ✅ pronto | api `GET /p/:slug/ics/:id` + gcalUrl |
| Push FCM pro prestador em novo agendamento | ✅ pronto (16/09) | PR #3 |
| Bloqueio de horário pontual | ❌ não existe | — |
| Confirmação de presença do cliente | ⚠️ parcial (status pending→confirmed é manual pelo prestador) | — |
| Mensagens automáticas de remanejamento | ❌ não existe | — |

## Problema

1. Prestador não consegue **bloquear um horário** (compromisso externo) sem criar um agendamento fake.
2. Ao **remanejar**, o prestador não tem apoio pra avisar o cliente — o WhatsApp só aparece no cancelamento.
3. **Confirmação de presença** é manual: prestador liga/pergunta um a um.

## Solução (4 features, 3 fases)

### FASE A — Bloqueio de horário (RF-A01..A03) · app + API · ~2h
### FASE B — Confirmação do cliente via WhatsApp (RF-B01..B04) · app · ~2h
### FASE C — Acompanhamento de remanejamento (RF-C01..C02) · app · ~1h

> Fase D (automação de mensagens de remanejamento em massa) fica FORA desta spec —
> depende de WhatsApp Business API (custo + aprovação Meta). Decisão separada.

---

## RF-IDs — Critérios de aceite

### FASE A — Bloqueio de horário

- [ ] **RF-A01** Prestador cria bloqueio: no agenda do dia, ação "Bloquear horário" escolhe data+hora início/fim → cria registro tipo bloqueio que OCUPA o slot (clientes não veem mais ele no link público).
      Teste: POST cria bloqueio; GET /p/:slug/busy reflete o intervalo; wizard não oferece o slot.
- [ ] **RF-A02** Bloqueio tem motivo opcional (ex: "dentista") visível só pro prestador.
      Teste: POST com/sem motivo; GET /appointments retorna motivo pro dono.
- [ ] **RF-A03** Prestador remove bloqueio a qualquer momento → slot volta a ficar disponível.
      Teste: DELETE/remove → slot volta pro /busy ausente e wizard oferece de novo.

**Decisão de implementação (proposta):** bloqueio = appointment com `source='block'`
NOVO valor no enum `appointment_source` + `status='confirmed'`. Reusa toda a
infraestrutura de conflito (exclusion constraint), lista e cancelamento — sem tabela nova.
Alternativa descartada: tabela `time_blocks` separada (duplicaria a lógica de conflito).

### FASE B — Confirmação do cliente via WhatsApp

- [ ] **RF-B01** Status `pending` ganha dois caminhos de confirmação no app:
      (a) prestador confirma manualmente (JÁ EXISTE — botão Confirmar);
      (b) prestador dispara "Pedir confirmação no WhatsApp" → abre wa.me do cliente
      com mensagem pronta contendo data/hora + link de confirmação.
      Teste: widget test do menu (novo item aparece só para status=pending).
- [ ] **RF-B02** Link de confirmação: `GET /p/:slug/confirm/:appointmentId?token=...`
      — página pública leve (mesmo estilo do booking público) com botões
      "**Vou comparecer**" / "**Não posso mais**". Token = hash HMAC do
      appointmentId+startsAt com INTERNAL_KEY (sem auth, sem PII na URL além do slug).
      Teste: integração — token válido → 200 e status muda; token inválido → 403.
- [ ] **RF-B03** "Vou comparecer" → status `pending`→`confirmed` + push pro prestador
      ("Cliente X confirmou presença"). "Não posso mais" → status `canceled`
      (canceled_reason='cliente cancelou via link') + push ("Cliente X cancelou — horário vagou").
      Teste: integração dos 2 fluxos + mock FCM.
- [ ] **RF-B04** Confirmação idempotente: clicar 2x no link não duplica nem quebra
      (status já confirmed → página mostra "Já confirmado, te esperamos!").
      Teste: 2 chamadas seguidas, segunda retorna 200 sem mudança.

### FASE C — Apoio ao remanejamento

- [ ] **RF-C01** Ao remarcar (wizard com `reschedule`), tela final oferece
      "Avisar o cliente no WhatsApp" com mensagem pronta contendo a NOVA data/hora
      (reusa o padrão do wa.me do cancelamento).
      Teste: widget test — diálogo aparece com msg contendo nova data formatada.
- [ ] **RF-C02** Ao remarcar, se o agendamento tinha gcal_event_id, o espelho do
      Calendar é atualizado (JÁ EXISTE no PATCH — validar que o fluxo do wizard cai
      nesse PATCH; sem código novo esperado, só teste).

---

## Fora de escopo (desta spec)

- Envio AUTOMÁTICO de WhatsApp (sem interação do prestador) — exige WhatsApp
  Business API (custo por conversa + aprovação Meta). Proposta futura separada.
- Mensagens em massa de remanejamento ("abriu vago às X, quer mudar?") —
  dependem do canal automático acima. Backlog.
- Notificação push pro CLIENTE (ele não tem app — canal dele é WhatsApp/link).

## Non-goals técnicos

- Nova tabela para bloqueios (reusa appointments com source='block')
- Página de confirmação com login (link com token HMAC é suficiente e não-expira;
  vencido o horário, o próprio fluxo de confirmação mostra "horário já passou")

## Estimativa

| Fase | Trabalho | Sequência |
|---|---|---|
| A — Bloqueio | API (enum + filtro busy + rota) ~1h; app (ação + sheet) ~1h | 1ª |
| B — Confirmação WhatsApp | API (rota confirm + token HMAC) ~1h; app (menu + msg) ~1h | 2ª |
| C — Apoio remanejamento | app only ~1h (reusa padrão existente) | 3ª |

Total: ~6h de implementação + testes (TDD, coverage 100% nos módulos novos).

## Impacto em CI/testes

- Novo valor no enum `appointment_source` → migration 0007 (idempotente)
- Novos testes: bloqueio (3), confirmação (4), remarcar-aviso (1) — ~8 testes
- Nenhum teste existente quebra (mudanças são aditivas)

---

## Decisões que preciso do Ezequias (aprovar/vetar)

1. **Bloqueio como appointment source='block'** (proposto) vs tabela separada?
2. **Link de confirmação com token HMAC** sem login — ok o cliente confirmar sem conta?
3. **Fase D (WhatsApp automático) fora** — concorda em decidir depois, com custo da API?
4. Prazo/alvo: embarca no PR #3/#6 atual ou PR novo separado após merge?
