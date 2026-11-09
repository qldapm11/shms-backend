#!/bin/sh
set -e

# Initialize database if not exists
if [ ! -f /data/dev.db ] || [ ! -s /data/dev.db ]; then
  echo "Initializing database..."

  # Copy from image if exists
  if [ -f /app/prisma/dev.db ]; then
    cp /app/prisma/dev.db /data/dev.db
    echo "Database copied from image"
  else
    # Run migrations
    npx prisma migrate deploy || npx prisma db push --accept-data-loss
    echo "Database migrations applied"

    # Run seed
    npm run db:seed || echo "Seed skipped"
    echo "Database seeded"
  fi
fi

# Start the application
exec node dist/server.js
