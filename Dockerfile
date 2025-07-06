FROM node:22-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install dependencies before switching user
# This ensures we don't have permission issues during installation
RUN npm install --only=production

# Create user after npm install
RUN addgroup -g 1001 nodejs && \
    adduser -S -u 1001 -G nodejs nodeuser && \
    chown -R nodeuser:nodejs /usr/src/app

# Switch to non-root user
USER nodeuser

# Copy the rest of the application
COPY --chown=nodeuser:nodejs . .

# Create a directory for Firebase setup if it doesn't exist
RUN mkdir -p ./firebase_setup

# Set environment variable for production
ENV NODE_ENV=production
ENV PORT=8080

# Expose port that Cloud Run will use
EXPOSE 8080

# Start the application
CMD ["node", "index.js"]