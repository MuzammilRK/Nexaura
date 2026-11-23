# syntax=docker/dockerfile:1
FROM node:22-slim

WORKDIR /app

# Install dependencies cleanly
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy application source and build the Vite production bundle
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    CLIENT_PORT=3001 \
    SAAS_PORT=3002

# Primary Hub (:3000), Client Portal (:3001), SaaS Portal (:3002), plus dynamic website/node ports (:3003-3010)
EXPOSE 3000 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
