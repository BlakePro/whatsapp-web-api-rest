# --------------------- Base stage ---------------------
FROM node:24.13-alpine3.23 AS base

# --------------------- Build stage ---------------------
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN apk add libc6-compat && \ 
npm install -g pnpm && pnpm install --frozen-lockfile;
COPY . .
RUN pnpm build

# --------------------- Production stage ----------------
FROM base AS production
WORKDIR /app
RUN apk add libc6-compat && \
addgroup --system --gid 1001 nodejs && \
adduser --system --uid 1001 nestjs

ARG APP_PORT

COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/public ./public

RUN mkdir /app/auth_info \
&& chown nestjs:nodejs /app/auth_info \
&& chmod 775 /app/auth_info 

USER nestjs

EXPOSE $APP_PORT
CMD [ "node", "dist/main.js" ]