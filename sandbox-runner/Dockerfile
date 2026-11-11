# Reference sandbox runner for Xiero Nexus AI.
# The CONTAINER provides isolation; run it with the hardening flags in README.
FROM node:22-alpine

# Non-root user.
RUN addgroup -g 10001 runner && adduser -u 10001 -G runner -D -h /home/runner runner

WORKDIR /app
COPY server.mjs /app/server.mjs

# Python is handy for Python task execution; drop if you only run Node.
RUN apk add --no-cache python3 py3-pip

USER 10001:10001
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
