FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.js xray.js xray-config.json ./

# Persistent data: downloaded binaries, agent.toml, tunnels, links.txt
VOLUME ["/app/kariz", "/app/xray"]

# Domain of the container (leave empty for IP mode)
ENV XRAY_DOMAIN="" \
    XRAY_PORT=80 \
    XRAY_LINK_PORT=443 \
    XRAY_LINK_TLS=tls \
    NODE_ENV=production

EXPOSE 80

CMD ["node", "index.js"]
