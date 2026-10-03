FROM rust:1.93.1-slim AS core
WORKDIR /workspace
RUN rustup target add wasm32-unknown-unknown
COPY base ./base
RUN cargo build --manifest-path base/Cargo.toml -p shufang-bindings --target wasm32-unknown-unknown --release --locked

FROM node:22-slim AS build
WORKDIR /workspace/app
COPY app/package.json app/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY app .
COPY --from=core /workspace/base/target/wasm32-unknown-unknown/release/shufang_bindings.wasm /workspace/core.wasm
ENV SHUFANG_CORE_WASM=/workspace/core.wasm
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV AUTO_START_MANAGED=false
COPY --from=build /workspace/app/package.json /workspace/app/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /workspace/app/dist ./dist
COPY --from=build /workspace/app/db/migrations ./db/migrations
COPY --from=build /workspace/app/db/migration-history ./db/migration-history
EXPOSE 3000
CMD ["npm", "run", "start"]
