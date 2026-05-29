FROM node:20-bullseye-slim

# Install git and other necessary tools including curl, python3
RUN apt-get update && apt-get install -y \
    git curl python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Google Cloud SDK so the MyAI tool can use gcloud commands
RUN curl -sSL https://sdk.cloud.google.com | bash -s -- --install-dir=/opt --disable-prompts
ENV PATH=$PATH:/opt/google-cloud-sdk/bin

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Copy and setup entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create workspace directory
RUN mkdir -p /workspace

# Set environment variables for the application
ENV PORT=8787
ENV WORKSPACE_DIR=/workspace

EXPOSE 8787

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
