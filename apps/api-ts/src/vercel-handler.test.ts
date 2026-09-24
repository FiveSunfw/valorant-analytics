import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fastifyUrl, handleVercelRequest } from "./vercel-handler.js";

describe("Vercel API adapter", () => {
  it("restores the public API path and keeps user query parameters", () => {
    const request = new Request("https://api.example.test/api/index?__path=/matches&limit=6");
    expect(fastifyUrl(request)).toBe("/matches?limit=6");
  });

  it("forwards method, body and response headers through Fastify", async () => {
    const app = Fastify();
    app.post("/echo", async (request, reply) => {
      reply.header("x-adapter", "fastify");
      return { body: request.body, authorization: request.headers.authorization };
    });
    await app.ready();

    const response = await handleVercelRequest(new Request(
      "https://api.example.test/api/index?__path=/echo&source=desktop",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer opaque" },
        body: JSON.stringify({ ok: true })
      }
    ), async () => app);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-adapter")).toBe("fastify");
    expect(await response.json()).toEqual({ body: { ok: true }, authorization: "Bearer opaque" });
    await app.close();
  });
});
