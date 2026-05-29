FROM node:20-bullseye-slim

# Install git, curl, gnupg, and apt-transport-https
RUN apt-get update && apt-get install -y \
    git curl python3 apt-transport-https ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Add Google Cloud SDK repository and install
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list \
    && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key --keyring /usr/share/keyrings/cloud.google.gpg add - \
    && apt-get update && apt-get install -y google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

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
