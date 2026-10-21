# Playwright's official image ships Chromium + all OS libraries it needs, at the
# version matching the `playwright` npm package. Keep this tag in sync with the
# playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
ENV NODE_ENV=production
# Browsers are already in the image at /ms-playwright; let Playwright use them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install production dependencies first (better layer caching). Browsers are
# already present, so skip the playwright postinstall download.
COPY package*.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

COPY . .

# The app reads PORT from the environment (platforms like Render inject it).
ENV PORT=3000
EXPOSE 3000

# Starts the HTTP API, the scan worker, and the cron scheduler; runs the schema
# migration on boot.
CMD ["node", "src/index.js"]
