# Test/verification image for hello-cc on its declared target platform
# (Node >= 24, Linux). Runs the full regression suite. Not shipped in the npm
# package (this file is outside the package.json `files` list).
FROM node:24

# tmux is required by the regression suite (browser-controllable terminals).
# build-essential ensures node-pty's native addon can compile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the source.
COPY . .

# The regression suite runs `git ls-files` against the project tree; create a
# fresh throwaway git snapshot (the host's .git is excluded by .dockerignore).
RUN git init \
 && git config user.email hcc-test@example.invalid \
 && git config user.name "hcc test" \
 && git add -A \
 && git commit -q -m "test snapshot" || true

# Smoke that the CLI loads, then run the full test suite: unit tests
# (node --test test/*.test.mjs) plus the 13-stage end-to-end regression.
CMD ["sh", "-c", "node --version && tmux -V && node ./bin/hcc.mjs --help >/dev/null && npm test"]
