# ---- VortexDown Docker Image ----
# Node.js + ffmpeg + N_m3u8DL-RE
# Zero npm dependencies (pure ESM Node.js)

FROM node:20-slim

# Install ffmpeg and required system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    wget \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set timezone
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# Copy application code
COPY app/ ./app/

# Copy N_m3u8DL-RE binary and make executable
COPY bin/ ./bin/
RUN chmod +x ./bin/N_m3u8DL-RE

# Create directories for data and downloads
RUN mkdir -p /app/data /downloads

# Environment defaults
ENV NODE_ENV=production
ENV PORT=19634
ENV VORTEXDOWN_ROOT=/app
ENV DATA_DIR=/app/data
ENV DOWNLOAD_DIR=/downloads

EXPOSE 19634

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:19634/health || exit 1

CMD ["node", "app/server/index.js"]
