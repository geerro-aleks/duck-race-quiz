const http = require("node:http");
const os = require("node:os");

const PORT = Number(process.env.PORT || 3000);

async function start() {
  const { default: app } = await import("./app.mjs");
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const method = req.method || "GET";
      const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
        method,
        headers: req.headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) })
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("Local server request failed:", error);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error.");
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter(address => address && address.family === "IPv4" && !address.internal)
      .map(address => `http://${address.address}:${PORT}`);
    console.log(`Duck Race Quiz: http://localhost:${PORT}`);
    for (const address of addresses) console.log(`Local network: ${address}`);
    console.log("Set DATABASE_URL and HOST_KEY before using host controls.");
  });
}

start().catch(error => {
  console.error("Could not start Duck Race Quiz:", error);
  process.exitCode = 1;
});
