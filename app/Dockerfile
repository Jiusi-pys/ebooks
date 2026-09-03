FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["npm", "run", "start"]
