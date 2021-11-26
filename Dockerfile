FROM --platform=linux/amd64 vbarta/xrpl-hooks-compiler:1.0
ARG TARGETPLATFORM
ARG BUILDPLATFORM
# FROM node:16-alpine
# RUN apk add --no-cache libc6-compat clang-8llvm lld
# RUN apk add --no-cache libc6-compat bash
WORKDIR /app
COPY package.json .
COPY dist ./dist
COPY --chmod=0755 clang ./clang
RUN npm install
EXPOSE $PORT
CMD ["node", "dist/index.js"]