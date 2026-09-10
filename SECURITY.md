# Política de Segurança

## Reportando vulnerabilidade
NÃO abra issue pública. Contate diretamente: Rafael Zendron (@rdz2211 no Telegram).

Responderemos em até 72h. Vulnerabilidades confirmadas recebem fix prioritário.

## Escopo
- API (auth, dados de clientes finais dos profissionais — PII)
- App (tokens, cache local, offline data)
- Infra (postgres, migrações, variáveis de ambiente)

## Regras de código
- Nunca commitar segredos (.env é gitignore, env validada com Zod no boot)
- Passwords: argon2, nunca hashes legados
- Multi-tenant: toda query filtrada por profissional/proposta no nível do repositório
