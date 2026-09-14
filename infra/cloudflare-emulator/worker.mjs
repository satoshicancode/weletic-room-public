import { Container, getContainer } from "@cloudflare/containers";

export class LoyaltyProbe extends Container {
  defaultPort = 3000;
  sleepAfter = "30s";
  enableInternet = false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/probe") {
      return new Response("Local compatibility probe only", { status: 404 });
    }
    // Never forward caller cookies, signed URLs, auth headers or request bodies.
    return getContainer(env.PROBE, "local-synthetic-probe").fetch(
      new Request("http://container/__local_container_probe__"),
    );
  },
};
