FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY server.ts ./
COPY src/ src/
COPY ui/ ui/
COPY mcp-app.html ./
RUN npm run build:server && ls -la dist/server.js
RUN INPUT=mcp-app.html npx vite build && ls -la dist/mcp-app.html
COPY public/ public/
RUN npm prune --omit=dev
RUN mkdir -p data
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/server.js"]
