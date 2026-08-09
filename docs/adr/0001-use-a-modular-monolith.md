# Use a modular monolith for the MVP

The MVP will use a React and Vite frontend with a Fastify API, organized as separate source modules but deployed together as one long-running Node.js 24 container. This keeps browser and server responsibilities explicit for Pi Agent and streaming requests while avoiding separate deployment, CORS, and serverless timeout complexity.
