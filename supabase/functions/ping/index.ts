const SERVER_URL = "https://stickman-card-game-server.onrender.com";

Deno.serve(async () => {
  const res = await fetch(`${SERVER_URL}/ping`);
  const body = await res.json();
  return Response.json(
    { server: body, status: res.status },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
});
