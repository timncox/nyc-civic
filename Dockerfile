FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci
RUN INPUT=mcp-app.html npx vite build --emptyOutDir && cat dist/mcp-app.html | head -c 200
RUN npm run build:server && ls -la dist/server.js dist/mcp-app.html
RUN npm prune --omit=dev
RUN mkdir -p data
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/server.js"]
