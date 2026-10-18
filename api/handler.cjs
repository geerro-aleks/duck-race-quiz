let appPromise;

async function readRequestBody(request) {
  if (request.body !== undefined) {
    if (Buffer.isBuffer(request.body) || typeof request.body === "string") {
      return request.body;
    }
    return JSON.stringify(request.body);
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async function handler(request, response) {
  try {
    appPromise ||= import("../app.mjs");
    const { default: app } = await appPromise;
    const method = request.method || "GET";
    const protocol = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers.host || "localhost";
    const init = {
      method,
      headers: request.headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: await readRequestBody(request) })
    };
    const fetchRequest = new Request(new URL(request.url || "/", `${protocol}://${host}`), init);
    const fetchResponse = await app.fetch(fetchRequest);

    response.statusCode = fetchResponse.status;
    fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await fetchResponse.arrayBuffer()));
  } catch (error) {
    console.error("Vercel API handler failed:", error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "The server could not complete the request. Check its configuration and logs." }));
  }
};
