FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN INPUT=mcp-app.html npx vite build --emptyOutDir
RUN npm run build:server
RUN ls -la dist/server.js dist/mcp-app.html && grep '<title>' dist/mcp-app.html

FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public/ public/
RUN mkdir -p data
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/server.js"]
