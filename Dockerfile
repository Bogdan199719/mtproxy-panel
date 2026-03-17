FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY backend/package.json ./

# Install production dependencies + babel for JSX precompilation
RUN npm install --production && \
    npm install --no-save @babel/core @babel/preset-react

# Copy source
COPY backend/src ./src
COPY public ./public

# Precompile JSX — removes babel-standalone from the served HTML
COPY build-jsx.js ./
RUN node build-jsx.js && rm build-jsx.js

EXPOSE 3000

CMD ["node", "src/app.js"]
