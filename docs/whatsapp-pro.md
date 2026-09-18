# WhatsApp Pro — Add-on (B15)

> **Status: PREPARAÇÃO.** Flag OFF por default. O MVP não depende disto.

## O que já existe (base grátis, não mexer)
- **wa.me deep link**: cancelar/remarcar/pedir confirmação abrem o WhatsApp do
  cliente com mensagem pronta (`agenda_page.dart`, `public-confirm`). Custo zero.
- **Logo no preview**: og:image na página pública (P8) — o link compartilhado
  mostra a logo no WhatsApp/Telegram.

## Estrutura pronta (migration 0010)
- `businesses.whatsapp_pro_enabled` (boolean, default `false`)
- `businesses.whatsapp_phone_number_id` (varchar 64 — ID do número na Meta)

## Como ativar (futuro)
1. Criar conta Meta Business + app WhatsApp Cloud API.
2. Criar o número comercial → guardar o `phone_number_id`.
3. Ativar por business: `UPDATE businesses SET whatsapp_pro_enabled = true,
   whatsapp_phone_number_id = '<id>' WHERE id = '<business_id>';`
4. Configurar webhook `POST /webhook/whatsapp` (a implementar) com o verify
   token da Meta em `WHATSAPP_VERIFY_TOKEN`.
5. Submeter templates de lembrete/confirmacao pra aprovação da Meta
   (categorie: UTILITY; aprovação típica em minutos/horas).

## Custos (definição de preço FORA do código)
- Meta cobra por conversa (janela de 24h), tarifas por país — ver
  developers.facebook.com → WhatsApp → Pricing.
- **Regra comercial (decisão Rafael): o custo da Cloud API entra no preço do
  add-on com margem.** O add-on é vendido à parte da assinatura base.

## Fluxo planejado (quando implementar)
- Lembrete automático (template aprovado) X horas antes do horário.
- Cliente responde "CONFIRMA" → appointment → `confirmed`.
- Cliente responde "CANCELA" → appointment → `canceled` (+ push pro prestador).
