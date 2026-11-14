# The monitor worker: reviews async run transcripts and settles pending submissions.
# Production and preview workers on Fly run this image; the web app deploys to Vercel.
FROM node:24-slim

WORKDIR /app
ENV HUSKY=0 NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
# The worker runs TypeScript through tsx, a dev dependency.
RUN npm ci --include=dev && npm cache clean --force

COPY . .
ENV NODE_ENV=production
USER node

CMD ["node", "--import", "tsx", "scripts/monitor-worker.ts"]
