# Build stage — espelha piano-api (StackVue), adaptado para Agenva
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build
# Prune devDependencies — evita npm ci --omit=dev no runtime
# (prepare: husky not found / husky não roda em production)
RUN npm prune --omit=dev

# Runtime stage
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=builder /app/dist ./dist
# SQL versionado na imagem (migrations rodam no host: npm run db:migrate)
COPY drizzle/ ./drizzle/
# Updater: version.json + APKs (pode ser sobrescrito por volume no compose)
COPY public/ ./public/
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3200/health').then(r=>{if(!r.ok)throw new Error('unhealthy')}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
