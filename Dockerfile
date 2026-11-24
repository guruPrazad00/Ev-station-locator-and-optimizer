FROM node:20-alpine

WORKDIR /app

# Install Python + NumPy for the ML scorer
RUN apk add --no-cache python3 py3-numpy

# Copy dependency files first for better layer caching
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "backend/server.js"]
