# Reproducible local development image. This is not a production image.
FROM node:22.23.4-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    clamav \
    curl \
    git \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libegl1 \
    libenchant-2-2 \
    libevent-2.1-7 \
    libflite1 \
    libgbm1 \
    libgl1 \
    libglib2.0-0 \
    libgles2 \
    libgtk-3-0 \
    libharfbuzz-icu0 \
    libjpeg62-turbo \
    libnss3 \
    libnotify4 \
    libopus0 \
    libpango-1.0-0 \
    libsecret-1-0 \
    libvpx7 \
    libwebp7 \
    libwebpdemux2 \
    libwebpmux3 \
    libwoff1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libx264-164 \
    libavif15 \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-unifont \
    postgresql-client \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# The ClamAV client talks to the optional Compose clamd service over the dev network.
RUN printf 'TCPSocket 3310\nTCPAddr clamav\n' > /etc/clamav/clamd.conf
WORKDIR /workspace
USER node
