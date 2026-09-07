import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp({ serveWeb: process.env.NODE_ENV === "production" });
const server = app.listen(port, () => {
  console.log(`Fairness study server listening on http://localhost:${port}`);
});

const shutdown = () => {
  server.close(() => {
    app.locals.db.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
