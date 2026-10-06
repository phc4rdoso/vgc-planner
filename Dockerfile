# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# `npm ci` when a lockfile is committed (recommended), otherwise a normal install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# Run `npm run sprites` before building if you want icons served from this image (public/sprites).
RUN npm run build

# ---- runtime: static files behind nginx, running as a non-root user ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
